import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '../../hooks/useTheme';

let mockStats = { data: null, isLoading: true };

vi.mock('../../hooks/useStudentProgressStats', () => ({
  useStudentProgressStats: () => mockStats,
}));

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({}),
}));

import StudentDashboard from './StudentDashboard';

function renderDashboard() {
  return render(
    <ThemeProvider>
      <MemoryRouter>
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
      pull: 50,
      push: 30,
      sessions_confirmed: 3,
      sessions_total: 3,
    },
    {
      week_id: 'w-2',
      week_number: 2,
      label: null,
      pull: 60,
      push: 40,
      sessions_confirmed: 2,
      sessions_total: 3,
    },
  ],
  recentConfirmations: [
    {
      id: 'c-1',
      session_id: 'sess-1',
      session_title: 'Push Day',
      day_number: 1,
      week_number: 1,
      week_label: 'Intro',
      confirmed_at: '2026-04-16T10:00:00Z',
    },
  ],
  weightHistory: [
    {
      exercise_id: 'ex-1',
      exercise_name: 'Muscle-up',
      exercise_type: 'pull',
      entries: [
        { weight_kg: 10, date: '2026-04-01T10:00:00Z', session_title: 'Pull A', week_number: 1 },
        { weight_kg: 12.5, date: '2026-04-08T10:00:00Z', session_title: 'Pull A', week_number: 2 },
        { weight_kg: 15, date: '2026-04-15T10:00:00Z', session_title: 'Pull A', week_number: 3 },
      ],
    },
  ],
};

describe('StudentDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStats = { data: null, isLoading: true };
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
        weightHistory: [],
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
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('7.3')).toBeInTheDocument();
  });

  it('renders weekly progress rows', () => {
    mockStats = { data: sampleData, isLoading: false };
    renderDashboard();
    expect(screen.getByText('3/3')).toBeInTheDocument();
    expect(screen.getByText('2/3')).toBeInTheDocument();
  });

  it('renders lift progression section with exercise name', () => {
    mockStats = { data: sampleData, isLoading: false };
    renderDashboard();
    expect(screen.getByText('Lift progression')).toBeInTheDocument();
    expect(screen.getByText('Muscle-up')).toBeInTheDocument();
    // latest weight (appears in both the header value and the footer label)
    expect(screen.getAllByText('15 kg').length).toBeGreaterThanOrEqual(1);
  });

  it('shows +50% change on the sparkline when weight grew from 10 to 15', () => {
    mockStats = { data: sampleData, isLoading: false };
    renderDashboard();
    expect(screen.getByText('+50%')).toBeInTheDocument();
  });

  it('shows empty lift progression hint when no weights logged', () => {
    mockStats = { data: { ...sampleData, weightHistory: [] }, isLoading: false };
    renderDashboard();
    expect(screen.getByText(/log weights during your sessions/i)).toBeInTheDocument();
  });

  it('renders recent activity entries', () => {
    mockStats = { data: sampleData, isLoading: false };
    renderDashboard();
    expect(screen.getByText('Push Day')).toBeInTheDocument();
  });

  it('shows empty recent activity state when none', () => {
    mockStats = {
      data: { ...sampleData, recentConfirmations: [] },
      isLoading: false,
    };
    renderDashboard();
    expect(screen.getByText(/no confirmed sessions yet/i)).toBeInTheDocument();
  });

  it('shows RPE dash when no samples', () => {
    mockStats = {
      data: { ...sampleData, avgRpe: null },
      isLoading: false,
    };
    renderDashboard();
    expect(screen.getByText('—')).toBeInTheDocument();
  });
});
