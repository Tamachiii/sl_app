import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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
    expect(screen.getByLabelText(/stats scope/i)).toHaveValue('all');
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
    expect(screen.queryByLabelText(/stats scope/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/no training logged yet/i)).not.toBeInTheDocument();
  });

  it('says so, in the coach\'s voice, when nothing is logged in the scope', () => {
    mockStats = { data: { ...sampleData, totalSessions: 0, totalSessionsConfirmed: 0 }, isLoading: false };
    renderSection();
    expect(screen.getByText(/no training logged yet for this scope/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/stats scope/i)).toBeInTheDocument();
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
    fireEvent.change(screen.getByLabelText(/stats scope/i), { target: { value: 'p-2' } });
    expect(statsCalls.at(-1)).toEqual({ studentId: 'st-1', scope: 'p-2', enabled: true });
    expect(savedScope('st-1')).toBe('p-2');
    expect(savedScope('st-2')).toBeUndefined();

    fireEvent.change(screen.getByLabelText(/stats scope/i), { target: { value: 'all' } });
    expect(statsCalls.at(-1)).toEqual({ studentId: 'st-1', scope: 'all', enabled: true });
    expect(savedScope('st-1')).toBeUndefined();
    expect(screen.getByLabelText(/stats scope/i)).toHaveValue('all');
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
    expect(screen.getByLabelText(/stats scope/i)).toHaveValue('p-2');
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
    expect(screen.getByLabelText(/stats scope/i)).toHaveValue('p-2');
    expect(screen.getByText('5/12')).toBeInTheDocument();
  });

  it('marks the outgoing figures as busy, and only them', () => {
    mockStats = standIn;
    const { container } = renderSection({ search: '?statsScope=p-2' });

    const busy = container.querySelectorAll('[aria-busy="true"]');
    expect(busy).toHaveLength(1);
    expect(busy[0]).toContainElement(screen.getByText('5/12'));
    expect(busy[0]).toHaveClass('opacity-50');
    expect(busy[0]).not.toContainElement(screen.getByLabelText(/stats scope/i));
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
    expect(screen.queryByLabelText(/stats scope/i)).not.toBeInTheDocument();
    expect(container.querySelector('[aria-busy]')).toBeNull();
  });
});
