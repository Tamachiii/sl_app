// What the Stats page SENDS. The other test file of this page stubs its hooks;
// this one mounts the page on the real ones, over a `supabase.from()` double
// that records every request, and counts.
//
// The page used to send, for an athlete who had picked a block: the row id
// three times, the whole history under 'all' (a tree and three lists), the
// history overlay (two more reads, drawn in one scope only) — and then the
// block that was asked for. On the gym's 4G that is the 3 s the page took.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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

// The page reads `programs` three ways and `session_confirmations` two ways.
function kindOf(request) {
  if (request.table === 'programs') {
    if (request.select.includes('weeks(id)')) return 'programs:list';
    if (!request.select.includes('exercise_slots')) return 'programs:history';
    return 'programs:tree';
  }
  if (request.table === 'session_confirmations' && request.order?.column === 'session_id') {
    return 'session_confirmations:history';
  }
  return request.table;
}

let db;
// Opens when a test wants the programs list to answer late.
let listGate;

function serve() {
  listGate = null;
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
  });
  supabase.from.mockImplementation((table) => {
    const builder = db.from(table);
    if (table !== 'programs') return builder;
    // The shallow list — and only it — waits for the gate when one is set.
    let isList = false;
    const { select, then: answer } = builder;
    builder.select = (columns, options) => {
      isList = columns.includes('weeks(id)');
      return select(columns, options);
    };
    builder.then = (resolve, reject) =>
      listGate && isList
        ? listGate.then(() => answer(resolve, reject))
        : answer(resolve, reject);
    return builder;
  });
}

function holdProgramsList() {
  let open;
  listGate = new Promise((resolve) => { open = resolve; });
  return open;
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

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  serve();
});

describe('Stats page — what it sends', () => {
  it('opens on "all" with six reads: the row id once, the list, the tree and the three lists', async () => {
    renderPage();
    expect(await screen.findByText('1/2')).toBeInTheDocument();
    await settle();

    expect(count('students')).toBe(1);
    expect(count('programs:list')).toBe(1);
    expect(count('programs:tree')).toBe(1);
    for (const list of LISTS) expect(count(list)).toBe(1);
    expect(db.requests).toHaveLength(6);

    // The row id comes first; the tree before the lists it decides about.
    expect(kinds()[0]).toBe('students');
    const treeAt = kinds().indexOf('programs:tree');
    for (const list of LISTS) expect(kinds().indexOf(list)).toBeGreaterThan(treeAt);
    // 'all': the tree is not narrowed to a block.
    const tree = db.requests[treeAt];
    expect(filterOf(tree, 'id')).toBeUndefined();
    expect(filterOf(tree, 'is_active')).toBeUndefined();
    expect(filterOf(tree, 'student_id')).toEqual(['eq', 'student_id', 'st-1']);
  });

  it('does not read the history overlay outside the active scope', async () => {
    renderPage();
    await screen.findByText('1/2');
    await settle();
    expect(count('programs:history')).toBe(0);
    expect(count('session_confirmations:history')).toBe(0);
  });

  it('reads a saved block and nothing else: no "all" on the way', async () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ scope: 'p-2' }));
    renderPage();
    expect(await screen.findByText('0/1')).toBeInTheDocument();
    await settle();

    // The id, the list that says the block still exists, then the block.
    expect(kinds().slice(0, 3)).toEqual(['students', 'programs:list', 'programs:tree']);
    expect([...kinds().slice(3)].sort()).toEqual(LISTS);
    expect(db.requests).toHaveLength(6);

    // Every read of the stats is narrowed to the block.
    const trees = db.requests.filter((r) => kindOf(r) === 'programs:tree');
    expect(trees).toHaveLength(1);
    expect(filterOf(trees[0], 'id')).toEqual(['eq', 'id', 'p-2']);
    expect(filterOf(db.requestsTo('session_confirmations')[0], 'sessions.weeks.programs.id'))
      .toEqual(['eq', 'sessions.weeks.programs.id', 'p-2']);
    for (const table of ['set_logs', 'slot_deviations']) {
      expect(filterOf(db.requestsTo(table)[0], 'exercise_slots.sessions.weeks.programs.id'))
        .toEqual(['eq', 'exercise_slots.sessions.weeks.programs.id', 'p-2']);
    }
    expect(screen.getByLabelText(/stats scope/i)).toHaveValue('p-2');
  });

  it('sends nothing of the stats while the list that knows the saved block is on its way', async () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ scope: 'p-2' }));
    const answerList = holdProgramsList();
    renderPage();
    await settle();

    // Asked for: the row id and the list. Not a tree, not a list of rows.
    expect(count('programs:tree')).toBe(0);
    for (const list of LISTS) expect(count(list)).toBe(0);
    // And the page says nothing it does not know yet.
    expect(screen.queryByText(/no program assigned yet/i)).not.toBeInTheDocument();

    answerList();
    expect(await screen.findByText('0/1')).toBeInTheDocument();
    await settle();
    expect(count('students')).toBe(1);
    expect(count('programs:tree')).toBe(1);
  });

  it('reads "all" once for a saved block that is gone', async () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ scope: 'p-gone' }));
    renderPage();
    expect(await screen.findByText('1/2')).toBeInTheDocument();
    await settle();

    expect(kinds().slice(0, 3)).toEqual(['students', 'programs:list', 'programs:tree']);
    expect(db.requests).toHaveLength(6);
    const tree = db.requests.find((r) => kindOf(r) === 'programs:tree');
    expect(filterOf(tree, 'id')).toBeUndefined();
    expect(screen.getByLabelText(/stats scope/i)).toHaveValue('all');
  });

  it('adds the two reads of the history overlay for the active block, and still one row id', async () => {
    renderPage('/student/stats?scope=active');
    expect(await screen.findByText('1/1')).toBeInTheDocument();
    await settle();

    expect(count('students')).toBe(1);
    expect(count('programs:list')).toBe(1);
    expect(count('programs:tree')).toBe(1);
    expect(count('programs:history')).toBe(1);
    expect(count('session_confirmations:history')).toBe(1);
    for (const list of LISTS) expect(count(list)).toBe(1);
    expect(db.requests).toHaveLength(8);

    const tree = db.requests.find((r) => kindOf(r) === 'programs:tree');
    expect(filterOf(tree, 'is_active')).toEqual(['eq', 'is_active', true]);
    const history = db.requests.find((r) => kindOf(r) === 'programs:history');
    expect(filterOf(history, 'is_active')).toEqual(['eq', 'is_active', false]);
    expect(filterOf(history, 'student_id')).toEqual(['eq', 'student_id', 'st-1']);
  });

  it('reads only the new block when the athlete changes the scope', async () => {
    renderPage();
    await screen.findByText('1/2');
    await settle();
    const before = db.requests.length;

    fireEvent.change(screen.getByLabelText(/stats scope/i), { target: { value: 'p-2' } });
    expect(await screen.findByText('0/1')).toBeInTheDocument();
    await settle();

    const sent = db.requests.slice(before).map(kindOf);
    expect(sent[0]).toBe('programs:tree');
    expect([...sent.slice(1)].sort()).toEqual(LISTS);
    expect(count('students')).toBe(1);
    expect(count('programs:list')).toBe(1);

    // Back to a scope that was read a moment ago: from the cache.
    const afterSwitch = db.requests.length;
    fireEvent.change(screen.getByLabelText(/stats scope/i), { target: { value: 'all' } });
    expect(await screen.findByText('1/2')).toBeInTheDocument();
    await settle();
    expect(db.requests).toHaveLength(afterSwitch);
  });
});
