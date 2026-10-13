import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '../../hooks/useTheme';

let mockStats = { data: null, isLoading: true };
let lastScope = null;
let mockPrograms = [];
// What the page reads its programs list and its row id from. A test replaces
// them to render the page before the list is there, or without it.
let mockProgramsQuery = null;
let mockStudentIdQuery = null;
// Every call of the two stats hooks, in order: what the page asked to be
// computed, and whether it let the read start.
let statsCalls = [];
let historyCalls = [];

vi.mock('../../hooks/useStudentProgressStats', () => ({
  useStudentProgressStats: (studentId, scope, options) => {
    lastScope = scope;
    statsCalls.push({ studentId, scope, enabled: options?.enabled });
    return mockStats;
  },
}));

vi.mock('../../hooks/useStudentHistoricalSessions', () => ({
  useStudentHistoricalSessions: (options) => {
    historyCalls.push(options);
    return { data: [] };
  },
}));

vi.mock('../../hooks/useStudents', () => ({
  useMyStudentId: () => mockStudentIdQuery || { data: 'student-1' },
}));

vi.mock('../../hooks/useProgram', () => ({
  useProgramsForStudent: () => mockProgramsQuery || { data: mockPrograms },
}));

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({}),
}));

import StudentDashboard from './StudentDashboard';

const PREFS_KEY = 'sl_stats_prefs:self';
const savedScope = () => JSON.parse(localStorage.getItem(PREFS_KEY) || '{}').scope;

function dashboard(initialPath) {
  return (
    <ThemeProvider>
      <MemoryRouter initialEntries={[initialPath]}>
        <StudentDashboard />
      </MemoryRouter>
    </ThemeProvider>
  );
}

function renderDashboard(initialPath = '/student/stats') {
  const view = render(dashboard(initialPath));
  // Renders the same page again, after a test changed what a hook answers.
  return { ...view, again: () => view.rerender(dashboard(initialPath)) };
}

const sampleData = {
  totalSessions: 12,
  totalSessionsConfirmed: 5,
  totalSets: 100,
  totalSetsDone: 42,
  weeksActive: 2,
  avgRpe: 7.3,
  // A volume row is a REAL Mon–Sun week the student trained in, identified by
  // its date range — not an ordinal "W1".
  weeklyVolume: [
    {
      bucket_start: '2026-07-06',
      bucket_end: '2026-07-12',
      pull: 50,
      push: 30,
      pull_planned: 60,
      push_planned: 40,
      sets_done: 9,
      sets_prescribed: 12,
      sessions_confirmed: 3,
    },
    {
      bucket_start: '2026-07-13',
      bucket_end: '2026-07-19',
      pull: 60,
      push: 40,
      pull_planned: 60,
      push_planned: 40,
      sets_done: 12,
      sets_prescribed: 12,
      sessions_confirmed: 2,
    },
  ],
  recentConfirmations: [],
  sessionCalendar: [],
  exerciseProgress: { exercises: [], byExercise: {} },
};

describe('StudentDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The scope is read from localStorage during render: what one test saved
    // would be the scope of the next.
    localStorage.clear();
    mockStats = { data: null, isLoading: true };
    lastScope = null;
    mockProgramsQuery = null;
    mockStudentIdQuery = null;
    statsCalls = [];
    historyCalls = [];
    mockPrograms = [
      { id: 'p-1', name: 'Block A', is_active: true, sort_order: 0 },
      { id: 'p-2', name: 'Block B', is_active: false, sort_order: 1 },
    ];
  });

  it('renders the Stats header', () => {
    renderDashboard();
    expect(screen.getByText('Stats')).toBeInTheDocument();
  });

  it('shows a spinner while loading', () => {
    renderDashboard();
    expect(screen.queryByText(/summary/i)).not.toBeInTheDocument();
  });

  it('shows empty state when no program', () => {
    mockStats = {
      data: {
        totalSessions: 0,
        totalSessionsConfirmed: 0,
        totalSets: 0,
        totalSetsDone: 0,
        weeksActive: 0,
        avgRpe: null,
        weeklyVolume: [],
        recentConfirmations: [],
        sessionCalendar: [],
        exerciseProgress: { exercises: [], byExercise: {} },
      },
      isLoading: false,
    };
    renderDashboard();
    expect(screen.getByText(/no program assigned yet/i)).toBeInTheDocument();
  });

  it('renders summary stats', () => {
    mockStats = { data: sampleData, isLoading: false };
    renderDashboard();
    expect(screen.getByText('5/12')).toBeInTheDocument();
    expect(screen.getByText(/42% complete/i)).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText(/of 100 prescribed/i)).toBeInTheDocument();
    expect(screen.getByText('7.3')).toBeInTheDocument();
  });

  // Volume rows are labelled by the real days they cover, so a block spread
  // over more time reads as more weeks instead of collapsing into "W1".
  it('labels each volume row with its calendar date range', () => {
    mockStats = { data: sampleData, isLoading: false };
    renderDashboard();
    expect(screen.getByText('Jul 6 – 12')).toBeInTheDocument();
    expect(screen.getByText('Jul 13 – 19')).toBeInTheDocument();
    expect(screen.queryByText(/^W1$/)).not.toBeInTheDocument();
  });

  it('does not render full-weeks stat or recent-activity section', () => {
    mockStats = { data: sampleData, isLoading: false };
    renderDashboard();
    expect(screen.queryByText('Full weeks')).not.toBeInTheDocument();
    expect(screen.queryByText('Recent activity')).not.toBeInTheDocument();
  });

  it('does not render lift progression or weekly progress sections', () => {
    mockStats = { data: sampleData, isLoading: false };
    renderDashboard();
    expect(screen.queryByText('Lift progression')).not.toBeInTheDocument();
    expect(screen.queryByText('Weekly progress')).not.toBeInTheDocument();
  });

  it('shows RPE dash when no samples', () => {
    mockStats = {
      data: { ...sampleData, avgRpe: null },
      isLoading: false,
    };
    renderDashboard();
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('defaults the program scope to "all" and renders the scope selector', () => {
    mockStats = { data: sampleData, isLoading: false };
    renderDashboard();
    expect(lastScope).toBe('all');
    const select = screen.getByLabelText(/stats scope/i);
    expect(select).toHaveValue('all');
    expect(screen.getByRole('option', { name: /all programs/i })).toBeInTheDocument();
    expect(
      screen.getByRole('option', { name: /Block A \(active\)/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Block B' })).toBeInTheDocument();
  });

  it('reads the scope from the ?scope= URL param', () => {
    mockStats = { data: sampleData, isLoading: false };
    renderDashboard('/student/stats?scope=p-2');
    expect(lastScope).toBe('p-2');
  });

  it('falls back to "all" when ?scope= references an unknown program', () => {
    mockStats = { data: sampleData, isLoading: false };
    renderDashboard('/student/stats?scope=ghost-program-id');
    expect(lastScope).toBe('all');
  });

  it('switches scope and rerenders when the user picks an option', () => {
    mockStats = { data: sampleData, isLoading: false };
    renderDashboard();
    fireEvent.change(screen.getByLabelText(/stats scope/i), {
      target: { value: 'p-2' },
    });
    expect(lastScope).toBe('p-2');
  });

  it('hides the scope selector when the student has no programs', () => {
    mockPrograms = [];
    mockStats = { data: sampleData, isLoading: false };
    renderDashboard();
    expect(screen.queryByLabelText(/stats scope/i)).not.toBeInTheDocument();
  });
});

// The page computes ONE scope per visit. It used to start with 'all', learn
// the saved scope from an effect, and compute that one next — two full reads,
// the first of them for nothing.
describe('StudentDashboard — the scope is known before anything is computed', () => {
  // What a query answers while it is held back: not loading, and no data.
  const heldBack = { data: undefined, isLoading: false };

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockStats = { data: sampleData, isLoading: false };
    lastScope = null;
    mockProgramsQuery = null;
    mockStudentIdQuery = null;
    statsCalls = [];
    historyCalls = [];
    mockPrograms = [
      { id: 'p-1', name: 'Block A', is_active: true, sort_order: 0 },
      { id: 'p-2', name: 'Block B', is_active: false, sort_order: 1 },
    ];
  });

  const enabledScopes = () => [...new Set(statsCalls.filter((c) => c.enabled).map((c) => c.scope))];

  it('computes the saved block from the first render, never "all" on the way', () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ scope: 'p-2' }));
    renderDashboard();

    expect(statsCalls[0]).toEqual({ studentId: undefined, scope: 'p-2', enabled: true });
    expect(enabledScopes()).toEqual(['p-2']);
    expect(statsCalls.some((c) => c.scope === 'all')).toBe(false);
    expect(screen.getByLabelText(/stats scope/i)).toHaveValue('p-2');
  });

  it('holds the stats back until the programs list says the saved block still exists', () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ scope: 'p-2' }));
    mockProgramsQuery = { data: undefined };
    mockStats = heldBack;
    const view = renderDashboard();

    expect(statsCalls.length).toBeGreaterThan(0);
    expect(statsCalls.every((c) => c.enabled === false && c.scope === 'p-2')).toBe(true);
    // Held back is not "nothing to show": no empty state, no figures.
    expect(screen.queryByText(/no program assigned yet/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/summary/i)).not.toBeInTheDocument();
    expect(screen.getByText('Stats')).toBeInTheDocument();

    mockProgramsQuery = null;
    mockStats = { data: sampleData, isLoading: false };
    view.again();

    expect(statsCalls.at(-1)).toEqual({ studentId: undefined, scope: 'p-2', enabled: true });
    expect(enabledScopes()).toEqual(['p-2']);
    expect(screen.getByText('5/12')).toBeInTheDocument();
  });

  it('holds a ?scope=<id> back the same way', () => {
    mockProgramsQuery = { data: undefined };
    mockStats = heldBack;
    renderDashboard('/student/stats?scope=p-2');
    expect(statsCalls.every((c) => c.enabled === false)).toBe(true);
  });

  it('does not wait for the programs list to compute "all"', () => {
    mockProgramsQuery = { data: undefined };
    renderDashboard();
    expect(statsCalls[0]).toEqual({ studentId: undefined, scope: 'all', enabled: true });
    expect(screen.getByText('5/12')).toBeInTheDocument();
  });

  it('does not wait for the programs list to compute the active block', () => {
    mockProgramsQuery = { data: undefined };
    renderDashboard('/student/stats?scope=active');
    expect(statsCalls[0]).toEqual({ studentId: undefined, scope: 'active', enabled: true });
  });

  it('falls back to "all" for a saved block that is gone, without ever computing it', () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ scope: 'p-gone' }));
    mockProgramsQuery = { data: undefined };
    mockStats = heldBack;
    const view = renderDashboard();
    expect(enabledScopes()).toEqual([]);

    mockProgramsQuery = null;
    mockStats = { data: sampleData, isLoading: false };
    view.again();
    expect(enabledScopes()).toEqual(['all']);
    expect(screen.getByLabelText(/stats scope/i)).toHaveValue('all');
  });

  it('lets the URL win over the saved scope', () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ scope: 'p-2' }));
    renderDashboard('/student/stats?scope=p-1');
    expect(enabledScopes()).toEqual(['p-1']);
  });

  it('goes back to "all" when the athlete picks it after a saved block', () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ scope: 'p-2' }));
    renderDashboard();
    expect(lastScope).toBe('p-2');

    fireEvent.change(screen.getByLabelText(/stats scope/i), { target: { value: 'all' } });
    expect(lastScope).toBe('all');
    expect(statsCalls.at(-1).enabled).toBe(true);
    expect(screen.getByLabelText(/stats scope/i)).toHaveValue('all');
    expect(savedScope()).toBeUndefined();
  });

  it('saves the block the athlete picks', () => {
    renderDashboard();
    fireEvent.change(screen.getByLabelText(/stats scope/i), { target: { value: 'p-2' } });
    expect(savedScope()).toBe('p-2');
    expect(statsCalls.at(-1)).toEqual({ studentId: undefined, scope: 'p-2', enabled: true });
  });

  // A list that failed or is paused is not coming: waiting for it would leave
  // the page on its spinner for as long as it stays away.
  it.each([
    ['the programs list failed', () => { mockProgramsQuery = { data: undefined, isError: true }; }],
    ['the programs list is paused', () => { mockProgramsQuery = { data: undefined, isPaused: true }; }],
    ['the athlete row failed', () => {
      mockStudentIdQuery = { data: undefined, isError: true };
      mockProgramsQuery = { data: undefined };
    }],
    ['the athlete row is paused', () => {
      mockStudentIdQuery = { data: undefined, isPaused: true };
      mockProgramsQuery = { data: undefined };
    }],
  ])('computes "all" for a saved block when %s', (_name, arrange) => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ scope: 'p-2' }));
    arrange();
    renderDashboard();
    expect(statsCalls.at(-1)).toEqual({ studentId: undefined, scope: 'all', enabled: true });
    expect(screen.getByText('5/12')).toBeInTheDocument();
  });

  describe('history overlay', () => {
    it('is not read for "all"', () => {
      renderDashboard();
      expect(historyCalls.length).toBeGreaterThan(0);
      expect(historyCalls.every((o) => o?.enabled === false)).toBe(true);
    });

    it('is not read for a single block, saved or in the URL', () => {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ scope: 'p-2' }));
      renderDashboard();
      expect(historyCalls.every((o) => o?.enabled === false)).toBe(true);
    });

    it('is not read while the scope is still unknown', () => {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ scope: 'p-2' }));
      mockProgramsQuery = { data: undefined };
      mockStats = heldBack;
      renderDashboard();
      expect(historyCalls.every((o) => o?.enabled === false)).toBe(true);
    });

    it('is read for the active block, the one scope that draws it', () => {
      renderDashboard('/student/stats?scope=active');
      expect(historyCalls.length).toBeGreaterThan(0);
      expect(historyCalls.every((o) => o?.enabled === true)).toBe(true);
    });
  });
});
