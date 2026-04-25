import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '../../hooks/useTheme';

let mockStats = { data: null, isLoading: true };
let lastScope = null;
let mockPrograms = [];

vi.mock('../../hooks/useStudentProgressStats', () => ({
  useStudentProgressStats: (_studentId, scope) => {
    lastScope = scope;
    return mockStats;
  },
}));

vi.mock('../../hooks/useStudentHistoricalSessions', () => ({
  useStudentHistoricalSessions: () => ({ data: [] }),
}));

vi.mock('../../hooks/useStudents', () => ({
  useMyStudentId: () => ({ data: 'student-1' }),
}));

vi.mock('../../hooks/useProgram', () => ({
  useProgramsForStudent: () => ({ data: mockPrograms }),
}));

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({}),
}));

import StudentDashboard from './StudentDashboard';

function renderDashboard(initialPath = '/student/stats') {
  return render(
    <ThemeProvider>
      <MemoryRouter initialEntries={[initialPath]}>
        <StudentDashboard />
      </MemoryRouter>
    </ThemeProvider>
  );
}

const sampleData = {
  totalSessions: 12,
  totalSessionsConfirmed: 5,
  totalSets: 100,
  totalSetsDone: 42,
  weeksActive: 2,
  avgRpe: 7.3,
  weeklyVolume: [
    {
      week_id: 'w-1',
      week_number: 1,
      label: 'Intro',
      program_id: 'p-1',
      program_name: 'Block A',
      pull: 50,
      push: 30,
      sessions_confirmed: 3,
      sessions_total: 3,
    },
    {
      week_id: 'w-2',
      week_number: 2,
      label: null,
      program_id: 'p-1',
      program_name: 'Block A',
      pull: 60,
      push: 40,
      sessions_confirmed: 2,
      sessions_total: 3,
    },
  ],
  recentConfirmations: [],
  sessionCalendar: [],
  exerciseProgress: { exercises: [], byExercise: {} },
};

describe('StudentDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStats = { data: null, isLoading: true };
    lastScope = null;
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
