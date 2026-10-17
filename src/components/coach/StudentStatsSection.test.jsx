import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';

let mockStats = { data: null, isLoading: true };
let mockPrograms = [];
// What the section reads its programs list from. A test replaces it to render
// the section before the list is there, or without it.
let mockProgramsQuery = null;
// Every call of the stats hook, in order: whose stats, which scope, and
// whether the section let the read start.
let statsCalls = [];
let programsCalls = [];

vi.mock('../../hooks/useStudentProgressStats', () => ({
  useStudentProgressStats: (studentId, scope, options) => {
    statsCalls.push({ studentId, scope, enabled: options?.enabled });
    return mockStats;
  },
}));

vi.mock('../../hooks/useProgram', () => ({
  useProgramsForStudent: (studentId) => {
    programsCalls.push(studentId);
    return mockProgramsQuery || { data: mockPrograms };
  },
}));

import StudentStatsSection from './StudentStatsSection';

const prefsKey = (studentId) => `sl_stats_prefs:coach:${studentId}`;
const saveScope = (studentId, scope) =>
  localStorage.setItem(prefsKey(studentId), JSON.stringify({ scope }));
const savedScope = (studentId) =>
  JSON.parse(localStorage.getItem(prefsKey(studentId)) || '{}').scope;

// The section lives under the athlete route, which hands it the athlete
// through the outlet context.
function section(studentId, search) {
  return (
    <MemoryRouter initialEntries={[`/coach/students/${studentId}${search}`]}>
      <Routes>
        <Route element={<Outlet context={{ student: { id: studentId } }} />}>
          <Route path="/coach/students/:studentId" element={<StudentStatsSection />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

function renderSection({ studentId = 'st-1', search = '' } = {}) {
  const view = render(section(studentId, search));
  // Renders the same section again, after a test changed what a hook answers.
  return { ...view, again: () => view.rerender(section(studentId, search)) };
}

const sampleData = {
  totalSessions: 12,
  totalSessionsConfirmed: 5,
  totalSets: 100,
  totalSetsDone: 42,
  avgRpe: 7.3,
  weeklyVolume: [],
  exerciseProgress: { exercises: [], byExercise: {} },
};

// What a query answers while it is held back: not loading, and no data.
const heldBack = { data: undefined, isLoading: false };

const enabledScopes = () => [...new Set(statsCalls.filter((c) => c.enabled).map((c) => c.scope))];

// The scope is a group of chips named "Block" (ProgramScopeSelector): the
// chip that is pressed, and a tap on one.
const scopeGroup = () => screen.getByRole('group', { name: 'Block' });
const pressedScope = () =>
  within(scopeGroup())
    .getAllByRole('button')
    .filter((chip) => chip.getAttribute('aria-pressed') === 'true')
    .map((chip) => chip.textContent);
const pickScope = (name) => fireEvent.click(within(scopeGroup()).getByRole('button', { name }));

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mockStats = { data: sampleData, isLoading: false };
  mockProgramsQuery = null;
  statsCalls = [];
  programsCalls = [];
  mockPrograms = [
    { id: 'p-1', name: 'Block A', is_active: true, sort_order: 0 },
    { id: 'p-2', name: 'Block B', is_active: false, sort_order: 1 },
  ];
});

describe('StudentStatsSection', () => {
  it('shows the athlete\'s figures for every program by default', () => {
    renderSection();
    expect(statsCalls[0]).toEqual({ studentId: 'st-1', scope: 'all', enabled: true });
    expect(programsCalls[0]).toBe('st-1');
    expect(screen.getByText('5/12')).toBeInTheDocument();
    expect(screen.getByText(/42% complete/i)).toBeInTheDocument();
    expect(pressedScope()).toEqual(['All']);
  });

  // The same card as the athlete's page: prescribed sets done of prescribed,
  // and the sets the athlete added said apart.
  it('says the sets the athlete added apart from the prescribed ones, and only when there are some', () => {
    mockStats = { data: { ...sampleData, totalExtraSetsDone: 3 }, isLoading: false };
    const { again } = renderSection();
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('of 100 prescribed · +3 extra')).toBeInTheDocument();

    mockStats = { data: { ...sampleData, totalExtraSetsDone: 0 }, isLoading: false };
    again();
    expect(screen.getByText('of 100 prescribed')).toBeInTheDocument();
    expect(screen.queryByText(/extra/)).not.toBeInTheDocument();
  });

  it('shows a spinner, and no figures, while the stats load', () => {
    mockStats = { data: undefined, isLoading: true };
    renderSection();
    expect(screen.queryByText('5/12')).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Block' })).not.toBeInTheDocument();
    expect(screen.queryByText(/no training logged yet/i)).not.toBeInTheDocument();
  });

  it('says so, in the coach\'s voice, when nothing is logged in the scope', () => {
    mockStats = { data: { ...sampleData, totalSessions: 0, totalSessionsConfirmed: 0 }, isLoading: false };
    renderSection();
    expect(screen.getByText(/no training logged yet for this scope/i)).toBeInTheDocument();
    expect(scopeGroup()).toBeInTheDocument();
  });

  // B39: the same panel as the athlete's page, on the same weeks.
  it('runs the weekly panel to this week for the active block, and ends a past block at its own weeks', () => {
    const week = (bucket_start) => ({
      bucket_start, pull: 10, push: 10, pull_planned: 10, push_planned: 10,
      sets_done: 3, sets_prescribed: 3, extra_sets_done: 0, sessions_confirmed: 1,
    });
    mockStats = { data: { ...sampleData, weeklyVolume: [week('2026-07-06')] }, isLoading: false };
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 6, 22, 12, 0, 0));
    try {
      const weeks = (container) => [...container.querySelectorAll('[data-week]')].map((r) => r.dataset.week);
      const active = renderSection({ search: '?statsScope=p-1' });
      expect(weeks(active.container)).toEqual(['2026-07-06', '2026-07-13', '2026-07-20']);
      active.unmount();

      const past = renderSection({ search: '?statsScope=p-2' });
      expect(weeks(past.container)).toEqual(['2026-07-06']);
    } finally {
      vi.useRealTimers();
    }
  });

  // The section is not in Parc yet: its chart keeps its own choice of
  // exercise (a select), remembered for each athlete — where the athlete's
  // page opens the chart under a row of its Progression list instead.
  it('lets the coach pick the exercise of the chart, and remembers it for this athlete', () => {
    const point = (session_id, date, tonnage) => ({ session_id, key: session_id, date, tonnage });
    mockStats = {
      data: {
        ...sampleData,
        exerciseProgress: {
          exercises: [{ id: 'e-1', name: 'Bench' }, { id: 'e-2', name: 'Row' }],
          byExercise: {
            'e-1': [point('s-1', '2026-07-01', 1000), point('s-2', '2026-07-08', 1240)],
            'e-2': [point('s-1', '2026-07-01', 800)],
          },
        },
      },
      isLoading: false,
    };
    const first = renderSection();
    const select = screen.getByRole('combobox', { name: 'Exercise' });
    expect(select).toHaveValue('e-1');
    expect(screen.getByText(/Highest, 1,240 kg\./)).toBeInTheDocument();

    fireEvent.change(select, { target: { value: 'e-2' } });
    expect(screen.getByText(/Highest, 800 kg\./)).toBeInTheDocument();
    expect(localStorage.getItem('sl_stats_prefs:coach:st-1:exerciseId')).toBe('e-2');
    first.unmount();

    const again = renderSection();
    expect(screen.getByRole('combobox', { name: 'Exercise' })).toHaveValue('e-2');
    again.unmount();

    // Another athlete: their own choice, none yet.
    renderSection({ studentId: 'st-2' });
    expect(screen.getByRole('combobox', { name: 'Exercise' })).toHaveValue('e-1');
  });

  it('reads the scope from ?statsScope=, not from the editor\'s ?program=', () => {
    renderSection({ search: '?statsScope=p-2&program=p-1' });
    expect(enabledScopes()).toEqual(['p-2']);
  });

  it('falls back to "all" when ?statsScope= names a program the athlete does not have', () => {
    renderSection({ search: '?statsScope=p-ghost' });
    expect(enabledScopes()).toEqual(['all']);
  });

  it('saves the picked scope for this athlete, and forgets it when "all" is picked', () => {
    renderSection();
    pickScope('Block B');
    expect(statsCalls.at(-1)).toEqual({ studentId: 'st-1', scope: 'p-2', enabled: true });
    expect(savedScope('st-1')).toBe('p-2');
    expect(savedScope('st-2')).toBeUndefined();

    pickScope('All');
    expect(statsCalls.at(-1)).toEqual({ studentId: 'st-1', scope: 'all', enabled: true });
    expect(savedScope('st-1')).toBeUndefined();
    expect(pressedScope()).toEqual(['All']);
  });
});

// The section computes ONE scope per visit. It used to start with 'all',
// learn the saved scope from an effect, and compute that one next.
describe('StudentStatsSection — the scope is known before anything is computed', () => {
  it('computes the block saved for this athlete from the first render, never "all" on the way', () => {
    saveScope('st-1', 'p-2');
    renderSection();

    expect(statsCalls[0]).toEqual({ studentId: 'st-1', scope: 'p-2', enabled: true });
    expect(enabledScopes()).toEqual(['p-2']);
    expect(statsCalls.some((c) => c.scope === 'all')).toBe(false);
    expect(pressedScope()).toEqual(['Block B']);
  });

  it('does not apply the scope saved for another athlete', () => {
    saveScope('st-2', 'p-2');
    renderSection({ studentId: 'st-1' });
    expect(enabledScopes()).toEqual(['all']);
  });

  it('holds the stats back until the programs list says the saved block still exists', () => {
    saveScope('st-1', 'p-2');
    mockProgramsQuery = { data: undefined };
    mockStats = heldBack;
    const view = renderSection();

    expect(statsCalls.length).toBeGreaterThan(0);
    expect(statsCalls.every((c) => c.enabled === false && c.scope === 'p-2')).toBe(true);
    // Held back is not "nothing logged": no empty state, no figures.
    expect(screen.queryByText(/no training logged yet/i)).not.toBeInTheDocument();
    expect(screen.queryByText('5/12')).not.toBeInTheDocument();

    mockProgramsQuery = null;
    mockStats = { data: sampleData, isLoading: false };
    view.again();

    expect(statsCalls.at(-1)).toEqual({ studentId: 'st-1', scope: 'p-2', enabled: true });
    expect(enabledScopes()).toEqual(['p-2']);
    expect(screen.getByText('5/12')).toBeInTheDocument();
  });

  it('does not wait for the programs list to compute "all"', () => {
    mockProgramsQuery = { data: undefined };
    renderSection();
    expect(statsCalls[0]).toEqual({ studentId: 'st-1', scope: 'all', enabled: true });
    expect(screen.getByText('5/12')).toBeInTheDocument();
  });

  it('falls back to "all" for a saved block that is gone, without ever computing it', () => {
    saveScope('st-1', 'p-gone');
    mockProgramsQuery = { data: undefined };
    mockStats = heldBack;
    const view = renderSection();
    expect(enabledScopes()).toEqual([]);

    mockProgramsQuery = null;
    mockStats = { data: sampleData, isLoading: false };
    view.again();
    expect(enabledScopes()).toEqual(['all']);
  });

  it('lets the URL win over the saved scope', () => {
    saveScope('st-1', 'p-2');
    renderSection({ search: '?statsScope=p-1' });
    expect(enabledScopes()).toEqual(['p-1']);
  });

  // The section stays mounted when the coach goes from one athlete to the
  // next: the outlet hands it another athlete, nothing remounts it.
  it('follows the athlete: the next one gets their own saved scope, from their first render', () => {
    saveScope('st-2', 'p-2');
    const view = renderSection({ studentId: 'st-1' });
    expect(statsCalls.at(-1)).toEqual({ studentId: 'st-1', scope: 'all', enabled: true });

    statsCalls = [];
    view.rerender(section('st-2', ''));
    expect(statsCalls[0]).toEqual({ studentId: 'st-2', scope: 'p-2', enabled: true });
    expect(statsCalls.every((c) => c.studentId === 'st-2' && c.scope === 'p-2')).toBe(true);
    expect(programsCalls.at(-1)).toBe('st-2');
  });

  // A list that failed or is paused is not coming: waiting for it would leave
  // the section on its spinner for as long as it stays away.
  it.each([
    ['failed', { data: undefined, isError: true }],
    ['is paused', { data: undefined, isPaused: true }],
  ])('computes "all" for a saved block when the programs list %s', (_name, programsQuery) => {
    saveScope('st-1', 'p-2');
    mockProgramsQuery = programsQuery;
    renderSection();
    expect(statsCalls.at(-1)).toEqual({ studentId: 'st-1', scope: 'all', enabled: true });
    expect(screen.getByText('5/12')).toBeInTheDocument();
  });
});

// N4 of the live review: changing the scope replaced the section, selector
// included, with a spinner.
describe('StudentStatsSection — changing the scope keeps the section', () => {
  // What the hook answers between two scopes: the figures of the scope that
  // was on screen, flagged as a stand-in.
  const standIn = { data: sampleData, isLoading: false, isPlaceholderData: true };

  it('keeps the selector and the figures while the new scope loads', () => {
    mockStats = standIn;
    renderSection({ search: '?statsScope=p-2' });
    // The selector already shows the choice that was just made.
    expect(pressedScope()).toEqual(['Block B']);
    expect(screen.getByText('5/12')).toBeInTheDocument();
  });

  it('marks the outgoing figures as busy, and only them', () => {
    mockStats = standIn;
    const { container } = renderSection({ search: '?statsScope=p-2' });

    const busy = container.querySelectorAll('[aria-busy="true"]');
    expect(busy).toHaveLength(1);
    expect(busy[0]).toContainElement(screen.getByText('5/12'));
    expect(busy[0]).toHaveClass('opacity-50');
    expect(busy[0]).not.toContainElement(scopeGroup());
  });

  it('marks nothing as busy once the figures are the scope\'s own', () => {
    const { container } = renderSection({ search: '?statsScope=p-2' });
    expect(container.querySelector('[aria-busy]')).toBeNull();
    expect(container.querySelector('.opacity-50')).toBeNull();
    expect(screen.getByText('5/12')).toBeInTheDocument();
  });

  it('still opens on a spinner when there is nothing to keep', () => {
    mockStats = { data: undefined, isLoading: true, isPlaceholderData: false };
    const { container } = renderSection();
    expect(screen.queryByRole('group', { name: 'Block' })).not.toBeInTheDocument();
    expect(container.querySelector('[aria-busy]')).toBeNull();
  });
});

// B41, on the coach's side: a block picked for an athlete stayed picked after
// the coach made that athlete's next block active.
describe('StudentStatsSection — a saved block, and a new block made active since', () => {
  const later = [
    { id: 'p-1', name: 'Block A', is_active: false, sort_order: 0 },
    { id: 'p-2', name: 'Block B', is_active: false, sort_order: 1 },
    { id: 'p-3', name: 'Block C', is_active: true, sort_order: 2 },
  ];
  const save = (studentId, prefs) => localStorage.setItem(prefsKey(studentId), JSON.stringify(prefs));
  const saved = (studentId) => JSON.parse(localStorage.getItem(prefsKey(studentId)) || '{}');

  it('shows every program for this athlete, and forgets only this athlete\'s block', () => {
    mockPrograms = later;
    save('st-1', { scope: 'p-1', activeBlock: 'p-1' });
    save('st-2', { scope: 'p-1', activeBlock: 'p-1' });
    renderSection({ studentId: 'st-1' });
    expect(enabledScopes()).toEqual(['all']);
    expect(saved('st-1')).toEqual({});
    expect(saved('st-2')).toEqual({ scope: 'p-1', activeBlock: 'p-1' });
  });

  it('decides once the list is there, never on the block first', () => {
    mockPrograms = later;
    save('st-1', { scope: 'p-1', activeBlock: 'p-1' });
    mockProgramsQuery = { data: undefined };
    mockStats = heldBack;
    const view = renderSection();
    expect(enabledScopes()).toEqual([]);

    mockProgramsQuery = null;
    mockStats = { data: sampleData, isLoading: false };
    view.again();
    expect(enabledScopes()).toEqual(['all']);
  });

  it('keeps the block while the block active when it was picked is still the active one', () => {
    save('st-1', { scope: 'p-2', activeBlock: 'p-1' });
    renderSection();
    expect(enabledScopes()).toEqual(['p-2']);
    expect(saved('st-1')).toEqual({ scope: 'p-2', activeBlock: 'p-1' });
  });

  it('saves the athlete\'s active block with the block the coach picks', () => {
    renderSection();
    pickScope('Block B');
    expect(saved('st-1')).toEqual({ scope: 'p-2', activeBlock: 'p-1' });
  });

  it('follows the athlete: the next one is decided on their own block', () => {
    mockPrograms = later;
    save('st-2', { scope: 'p-1', activeBlock: 'p-1' });
    const view = renderSection({ studentId: 'st-1' });
    statsCalls = [];
    view.rerender(section('st-2', ''));
    expect(statsCalls.filter((c) => c.enabled).every((c) => c.studentId === 'st-2' && c.scope === 'all')).toBe(true);
    expect(saved('st-2')).toEqual({});
  });
});

