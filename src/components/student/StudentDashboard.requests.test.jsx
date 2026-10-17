// What the Stats page SENDS. The other test file of this page stubs its hooks;
// this one mounts the page on the real ones, over a `supabase.from()` double
// that records every request, and counts.
//
// The page used to send, for an athlete who had picked a block: the row id
// three times, the whole history under 'all' (a tree and three lists), the
// history overlay (two more reads, drawn in one scope only) — and then the
// block that was asked for. On the gym's 4G that is the 3 s the page took.
//
// Since the Parc redesign the page also holds the records and the bodyweight,
// which were on the Profile: four reads of their own (ALL_TIME below), the
// same whatever the scope.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../../lib/supabase', () => ({ supabase: { from: vi.fn() } }));
vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'u-1' }, profile: { full_name: 'Tony Me' }, signOut: () => {} }),
}));
vi.mock('../ui/UserMenu', () => ({ default: () => <div data-testid="user-menu" /> }));

import StudentDashboard from './StudentDashboard';
import { supabase } from '../../lib/supabase';
import { fakePostgrest } from '../../test/fakePostgrest';

const PREFS_KEY = 'sl_stats_prefs:self';

// Two blocks: the active one, trained and confirmed, and a past one, trained
// and never confirmed. So 'all' reads 1/2, the active block 1/1, the past 0/1.
const block = (id, name, isActive, sortOrder, sessionId, slotId) => ({
  id,
  name,
  sort_order: sortOrder,
  is_active: isActive,
  weeks: [{
    id: `w-${id}`,
    week_number: 1,
    label: null,
    sessions: [{
      id: sessionId,
      title: `Session of ${name}`,
      day_number: 1,
      sort_order: 0,
      scheduled_date: null,
      archived_at: null,
      performed_at: '2026-07-08T18:00:00Z',
      exercise_slots: [{
        id: slotId,
        sets: 1,
        reps: 5,
        duration_seconds: null,
        weight_kg: 100,
        exercise: { id: 'e-1', name: 'Bench', type: 'push', difficulty: 1, volume_weight: 1 },
        set_logs: [],
      }],
    }],
  }],
});
const BLOCKS = [
  block('p-1', 'Block A', true, 0, 's-1', 'sl-1'),
  block('p-2', 'Block B', false, 1, 's-2', 'sl-2'),
];

const filterOf = (request, column) =>
  request.filters.find(([op, col]) => op === 'eq' && col === column);

// The page reads `programs` three ways, `session_confirmations`, `set_logs`,
// `slot_deviations` and `bodyweight_logs` two ways each.
function kindOf(request) {
  if (request.table === 'programs') {
    if (request.select.includes('weeks(id)')) return 'programs:list';
    if (!request.select.includes('exercise_slots')) return 'programs:history';
    return 'programs:tree';
  }
  if (request.table === 'session_confirmations' && request.order?.column === 'session_id') {
    return 'session_confirmations:history';
  }
  // The records' history (lib/doneSetHistory) names the exercise's load mode,
  // which the stats' lists do not read.
  if ((request.table === 'set_logs' || request.table === 'slot_deviations') && request.select?.includes('load_mode')) {
    return `${request.table}:records`;
  }
  // The card's last weigh-ins carry their id; the records' series does not.
  if (request.table === 'bodyweight_logs') {
    return /\bid\b/.test(request.select ?? '') ? 'bodyweight_logs:card' : 'bodyweight_logs:series';
  }
  return request.table;
}

let db;
// Kind of request → a promise its answer waits for (see `hold`).
let gates;

function serve() {
  gates = {};
  db = fakePostgrest({
    students: [{ id: 'st-1' }],
    programs: (request) => {
      const kind = kindOf(request);
      if (kind === 'programs:list') {
        return BLOCKS.map(({ id, name, sort_order, is_active }) => ({ id, name, sort_order, is_active }));
      }
      const byId = filterOf(request, 'id');
      const byActive = filterOf(request, 'is_active');
      return BLOCKS.filter(
        (b) => (!byId || b.id === byId[2]) && (!byActive || b.is_active === byActive[2]),
      );
    },
    session_confirmations: [{ id: 'c-1', session_id: 's-1', confirmed_at: '2026-07-08T19:00:00Z' }],
    set_logs: [{ id: 'l-1', exercise_slot_id: 'sl-1', done: true, target_reps: 5, target_weight_kg: 100 }],
    slot_deviations: [],
    // numeric comes back as a string.
    bodyweight_logs: [{ id: 'bw-1', weight_kg: '72.4', logged_on: '2026-07-08' }],
  });
  supabase.from.mockImplementation((table) => {
    const builder = db.from(table);
    let kind = table;
    const { select, then: answer } = builder;
    builder.select = (columns, options) => {
      kind = kindOf({ table, select: columns });
      return select(columns, options);
    };
    builder.then = (resolve, reject) =>
      gates[kind]
        ? gates[kind].then(() => answer(resolve, reject))
        : answer(resolve, reject);
    return builder;
  });
}

// Makes the requests of one kind answer late: when the returned function is
// called.
function hold(kind) {
  let open;
  gates[kind] = new Promise((resolve) => { open = resolve; });
  return () => {
    delete gates[kind];
    open();
  };
}

function renderPage(path = '/student/stats') {
  const queryClient = new QueryClient({
    defaultOptions: {
      // `staleTime` as in lib/queryClient.js: what was just read is not read
      // again because a component rendered once more.
      queries: { retry: false, gcTime: Infinity, staleTime: 2 * 60 * 1000 },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <StudentDashboard />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const kinds = () => db.requests.map(kindOf);
const count = (kind) => kinds().filter((k) => k === kind).length;
// Long enough for a request that was going to follow to have been sent.
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

const LISTS = ['session_confirmations', 'set_logs', 'slot_deviations'];

// What the records and the bodyweight card send, whatever the scope — they
// are all-time:
//   - the records reduce the athlete's whole done-set history, the done sets
//     and the swaps that re-point some of them (lib/doneSetHistory, the list
//     "Last time" shares), and weigh each best set against the bodyweight
//     series of its week (the ×BW figure);
//   - the card reads its own last 60 weigh-ins.
// None of them needs the athlete's row id: the history is scoped by RLS, the
// two bodyweight reads by the signed-in user's profile id.
const ALL_TIME = ['bodyweight_logs:card', 'bodyweight_logs:series', 'set_logs:records', 'slot_deviations:records'];
// The reads of the stats themselves, in the order they were sent.
const statsKinds = () => kinds().filter((k) => !ALL_TIME.includes(k));

// The Summary's "Sessions done" row says "1 of 2": the sessions confirmed of
// the scope. "Sets done" can read the same, so the row is asked by its label.
const sessionsDone = () =>
  within(screen.getByText('Sessions done').closest('li')).getByText(/^\d+ of \d+$/).textContent;
const findSessionsDone = (text) => waitFor(() => expect(sessionsDone()).toBe(text));

// The scope is a group of chips named "Block" (ProgramScopeSelector).
const scopeGroup = () => screen.getByRole('group', { name: 'Block' });
const findScopeGroup = () => screen.findByRole('group', { name: 'Block' });
const pressedScope = () =>
  within(scopeGroup())
    .getAllByRole('button')
    .filter((chip) => chip.getAttribute('aria-pressed') === 'true')
    .map((chip) => chip.textContent);
const pickScope = (name) => fireEvent.click(within(scopeGroup()).getByRole('button', { name }));

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  serve();
});


describe('Stats page — what it sends', () => {
  it('opens on "all" with six reads of the stats: the row id once, the list, the tree and the three lists', async () => {
    renderPage();
    await findSessionsDone('1 of 2');
    await settle();

    expect(count('students')).toBe(1);
    expect(count('programs:list')).toBe(1);
    expect(count('programs:tree')).toBe(1);
    for (const list of LISTS) expect(count(list)).toBe(1);
    expect(statsKinds()).toHaveLength(6);

    // The row id comes first; the tree before the lists it decides about.
    expect(statsKinds()[0]).toBe('students');
    const treeAt = kinds().indexOf('programs:tree');
    for (const list of LISTS) expect(kinds().indexOf(list)).toBeGreaterThan(treeAt);
    // 'all': the tree is not narrowed to a block.
    const tree = db.requests[treeAt];
    expect(filterOf(tree, 'id')).toBeUndefined();
    expect(filterOf(tree, 'is_active')).toBeUndefined();
    expect(filterOf(tree, 'student_id')).toEqual(['eq', 'student_id', 'st-1']);
  });

  it('adds four reads for the records and the bodyweight, each once, none narrowed to the scope', async () => {
    renderPage();
    await findSessionsDone('1 of 2');
    await screen.findByText('72.4');
    await settle();

    for (const kind of ALL_TIME) expect(count(kind)).toBe(1);
    expect(db.requests).toHaveLength(10);

    const one = (kind) => db.requests.find((r) => kindOf(r) === kind);
    // The athlete's own history: RLS scopes it, no row id and no block in it.
    for (const kind of ['set_logs:records', 'slot_deviations:records']) {
      const read = one(kind);
      expect(filterOf(read, 'exercise_slots.sessions.weeks.programs.student_id')).toBeUndefined();
      expect(filterOf(read, 'exercise_slots.sessions.weeks.programs.id')).toBeUndefined();
      expect(filterOf(read, 'exercise_slots.sessions.weeks.programs.is_active')).toBeUndefined();
    }
    expect(filterOf(one('set_logs:records'), 'done')).toEqual(['eq', 'done', true]);
    expect(filterOf(one('slot_deviations:records'), 'kind')).toEqual(['eq', 'kind', 'swap']);
    // bodyweight_logs.student_id is a profile id: the signed-in user's.
    expect(filterOf(one('bodyweight_logs:series'), 'student_id')).toEqual(['eq', 'student_id', 'u-1']);
    expect(filterOf(one('bodyweight_logs:card'), 'student_id')).toEqual(['eq', 'student_id', 'u-1']);
    expect(one('bodyweight_logs:card').limit).toBe(60);
  });

  it('does not read the history overlay outside the active scope', async () => {
    renderPage();
    await findSessionsDone('1 of 2');
    await settle();
    expect(count('programs:history')).toBe(0);
    expect(count('session_confirmations:history')).toBe(0);
  });

  it('reads a saved block and nothing else: no "all" on the way', async () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ scope: 'p-2' }));
    renderPage();
    await findSessionsDone('0 of 1');
    await settle();

    // The id, the list that says the block still exists, then the block.
    expect(statsKinds().slice(0, 3)).toEqual(['students', 'programs:list', 'programs:tree']);
    expect([...statsKinds().slice(3)].sort()).toEqual(LISTS);
    for (const kind of ALL_TIME) expect(count(kind)).toBe(1);
    expect(db.requests).toHaveLength(10);

    // Every read of the stats is narrowed to the block.
    const trees = db.requests.filter((r) => kindOf(r) === 'programs:tree');
    expect(trees).toHaveLength(1);
    expect(filterOf(trees[0], 'id')).toEqual(['eq', 'id', 'p-2']);
    expect(filterOf(db.requestsTo('session_confirmations')[0], 'sessions.weeks.programs.id'))
      .toEqual(['eq', 'sessions.weeks.programs.id', 'p-2']);
    for (const kind of ['set_logs', 'slot_deviations']) {
      const read = db.requests.find((r) => kindOf(r) === kind);
      expect(filterOf(read, 'exercise_slots.sessions.weeks.programs.id'))
        .toEqual(['eq', 'exercise_slots.sessions.weeks.programs.id', 'p-2']);
    }
    expect(pressedScope()).toEqual(['Block B']);
  });

  it('sends nothing of the stats while the list that knows the saved block is on its way', async () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ scope: 'p-2' }));
    const answerList = hold('programs:list');
    renderPage();
    await settle();

    // Asked for: the row id and the list. Not a tree, not a list of rows.
    expect(count('programs:tree')).toBe(0);
    for (const list of LISTS) expect(count(list)).toBe(0);
    // And the page says nothing it does not know yet.
    expect(screen.queryByText(/no stats yet/i)).not.toBeInTheDocument();

    answerList();
    await findSessionsDone('0 of 1');
    await settle();
    expect(count('students')).toBe(1);
    expect(count('programs:tree')).toBe(1);
  });

  it('reads "all" once for a saved block that is gone', async () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ scope: 'p-gone' }));
    renderPage();
    await findSessionsDone('1 of 2');
    await settle();

    expect(statsKinds().slice(0, 3)).toEqual(['students', 'programs:list', 'programs:tree']);
    expect(statsKinds()).toHaveLength(6);
    const tree = db.requests.find((r) => kindOf(r) === 'programs:tree');
    expect(filterOf(tree, 'id')).toBeUndefined();
    expect(pressedScope()).toEqual(['All']);
  });

  // B41: Block B was picked while it was the active block; Block A is active
  // now. Letting go of it costs nothing: the block is never read.
  it('reads "all" once for a saved block that a new active block replaced', async () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ scope: 'p-2', activeBlock: 'p-2' }));
    renderPage();
    await findSessionsDone('1 of 2');
    await settle();

    expect(statsKinds().slice(0, 3)).toEqual(['students', 'programs:list', 'programs:tree']);
    expect(statsKinds()).toHaveLength(6);
    const tree = db.requests.find((r) => kindOf(r) === 'programs:tree');
    expect(filterOf(tree, 'id')).toBeUndefined();
    expect(pressedScope()).toEqual(['All']);
    expect(JSON.parse(localStorage.getItem(PREFS_KEY))).toEqual({});
  });

  it('adds the two reads of the history overlay for the active block, and still one row id', async () => {
    renderPage('/student/stats?scope=active');
    await findSessionsDone('1 of 1');
    await settle();

    expect(count('students')).toBe(1);
    expect(count('programs:list')).toBe(1);
    expect(count('programs:tree')).toBe(1);
    expect(count('programs:history')).toBe(1);
    expect(count('session_confirmations:history')).toBe(1);
    for (const list of LISTS) expect(count(list)).toBe(1);
    expect(statsKinds()).toHaveLength(8);
    for (const kind of ALL_TIME) expect(count(kind)).toBe(1);
    expect(db.requests).toHaveLength(12);

    const tree = db.requests.find((r) => kindOf(r) === 'programs:tree');
    expect(filterOf(tree, 'is_active')).toEqual(['eq', 'is_active', true]);
    const history = db.requests.find((r) => kindOf(r) === 'programs:history');
    expect(filterOf(history, 'is_active')).toEqual(['eq', 'is_active', false]);
    expect(filterOf(history, 'student_id')).toEqual(['eq', 'student_id', 'st-1']);
  });

  it('reads only the new block when the athlete changes the scope', async () => {
    renderPage();
    await findSessionsDone('1 of 2');
    await screen.findByText('72.4');
    await settle();
    const before = db.requests.length;

    pickScope('Block B');
    await findSessionsDone('0 of 1');
    await settle();

    // The tree and its three lists — and nothing of the records or the
    // bodyweight, which do not follow the scope.
    const sent = db.requests.slice(before).map(kindOf);
    expect(sent[0]).toBe('programs:tree');
    expect([...sent.slice(1)].sort()).toEqual(LISTS);
    expect(count('students')).toBe(1);
    expect(count('programs:list')).toBe(1);

    // Back to a scope that was read a moment ago: from the cache.
    const afterSwitch = db.requests.length;
    pickScope('All');
    await findSessionsDone('1 of 2');
    await settle();
    expect(db.requests).toHaveLength(afterSwitch);
  });
});

// N4 of the live review: on the gym's 4G, changing the scope left the athlete
// in front of a spinner — no figures, and no selector to change their mind.
describe('Stats page — changing the scope', () => {
  it('keeps the selector and the figures on screen until the new block is read', async () => {
    const { container } = renderPage();
    await findSessionsDone('1 of 2');
    await findScopeGroup();
    expect(container.querySelector('[aria-busy]')).toBeNull();

    const answerTree = hold('programs:tree');
    pickScope('Block B');
    await settle();

    // Still the page: its selector, on the new choice, and the old figures,
    // marked as on their way out.
    expect(pressedScope()).toEqual(['Block B']);
    expect(sessionsDone()).toBe('1 of 2');
    const outgoing = screen.getByText('Sessions done').closest('li');
    expect(outgoing.closest('[aria-busy="true"]')).not.toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Stats' })).not.toHaveClass('sr-only');

    answerTree();
    await findSessionsDone('0 of 1');
    expect(container.querySelector('[aria-busy]')).toBeNull();
    expect(pressedScope()).toEqual(['Block B']);
  });

  it('lets the athlete change their mind while a block loads', async () => {
    renderPage();
    await findSessionsDone('1 of 2');
    await findScopeGroup();

    const answerTree = hold('programs:tree');
    pickScope('Block B');
    await settle();
    // The selector is there to be used: back to what is already read.
    pickScope('All');

    expect(pressedScope()).toEqual(['All']);
    expect(sessionsDone()).toBe('1 of 2');
    answerTree();
    await settle();
    expect(sessionsDone()).toBe('1 of 2');
    expect(pressedScope()).toEqual(['All']);
  });
});
