import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Navigate, useOutletContext } from 'react-router-dom';

let mockStudentsData = { data: null, isLoading: false };
let mockSummary = { data: {} };
let mockConfirmations = { data: [] };
let mockClientErrors = { data: [] };

vi.mock('../../hooks/useStudents', () => ({
  useStudents: () => mockStudentsData,
}));

vi.mock('../../hooks/useProgram', () => ({
  useCoachDashboardPrograms: () => mockSummary,
}));

vi.mock('../../hooks/useSessionConfirmation', () => ({
  useAllConfirmations: () => mockConfirmations,
}));

vi.mock('../../hooks/useClientErrors', () => ({
  useClientErrors: () => mockClientErrors,
}));

// Inline section stubs that read the outlet context the same way the real
// sections do — verifies the layout's <Outlet context> wiring without pulling
// in their data hooks.
function ProfileStub() {
  const { student } = useOutletContext();
  return <div data-testid="profile-section">profile:{student.id}</div>;
}
function ProgrammingStub() {
  const { student } = useOutletContext();
  return <div data-testid="programming-section">programming:{student.id}</div>;
}
function GoalsStub() {
  const { student } = useOutletContext();
  return <div data-testid="goals-section">goals:{student.id}</div>;
}
function StatsStub() {
  const { student } = useOutletContext();
  return <div data-testid="stats-section">stats:{student.id}</div>;
}

vi.mock('./StudentProfileSection', () => ({ default: ProfileStub }));
vi.mock('./StudentProgrammingSection', () => ({ default: ProgrammingStub }));
vi.mock('./StudentGoalsSection', () => ({ default: GoalsStub }));
vi.mock('./StudentStatsSection', () => ({ default: StatsStub }));

import CoachHome from './CoachHome';

function renderCoachHome(path = '/coach/students') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/coach/students" element={<CoachHome />} />
        <Route path="/coach/students/:studentId" element={<CoachHome />}>
          <Route index element={<Navigate to="programming" replace />} />
          <Route path="profile" element={<ProfileStub />} />
          <Route path="programming" element={<ProgrammingStub />} />
          <Route path="goals" element={<GoalsStub />} />
          <Route path="stats" element={<StatsStub />} />
          {/* Legacy /messaging deep links bounce to profile. */}
          <Route path="messaging" element={<Navigate to="../profile" replace />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

// weekDays that carry no missed/today/upcoming status regardless of the real
// clock (confirmed = completed, null = rest), so ordering assertions stay
// deterministic on any day the suite runs.
const CALM_WEEK = [
  { dayNumber: 1, session: { id: 'a' }, confirmed: true },
  { dayNumber: 2, session: null, confirmed: false },
  { dayNumber: 3, session: null, confirmed: false },
  { dayNumber: 4, session: null, confirmed: false },
  { dayNumber: 5, session: null, confirmed: false },
  { dayNumber: 6, session: null, confirmed: false },
  { dayNumber: 7, session: null, confirmed: false },
];

describe('CoachHome', () => {
  beforeEach(() => {
    localStorage.clear();
    mockStudentsData = { data: null, isLoading: false };
    mockSummary = { data: {} };
    mockConfirmations = { data: [] };
    mockClientErrors = { data: [] };
  });

  it('renders loading spinner', () => {
    mockStudentsData = { data: undefined, isLoading: true };
    renderCoachHome();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('renders empty state when no students', () => {
    mockStudentsData = { data: [], isLoading: false };
    renderCoachHome();
    expect(screen.getByText(/no students yet/i)).toBeInTheDocument();
  });

  it('renders the page title', () => {
    mockStudentsData = { data: [], isLoading: false };
    renderCoachHome();
    expect(screen.getByRole('heading', { level: 1, name: 'Athletes.' })).toBeInTheDocument();
  });

  describe('roster landing', () => {
    beforeEach(() => {
      mockStudentsData = {
        data: [
          { id: 's1', profile: { full_name: 'Alice' } }, // calm
          { id: 's2', profile: { full_name: 'Bob' } }, // no program
          { id: 's3', profile: { full_name: 'Cara' } }, // 2 to review
        ],
        isLoading: false,
      };
      mockSummary = {
        data: {
          s1: { programName: 'Hyp', activeWeek: { week_number: 3, label: 'B1' }, weekDays: CALM_WEEK },
          s3: { programName: 'Str', activeWeek: { week_number: 1, label: null }, weekDays: CALM_WEEK },
          // s2 absent → no active program.
        },
      };
      mockConfirmations = {
        data: [
          { student_id: 's3', reviewed_at: null, archived_at: null },
          { student_id: 's3', reviewed_at: null, archived_at: null },
        ],
      };
    });

    it('renders a card link per athlete', () => {
      renderCoachHome();
      expect(screen.getByRole('link', { name: /open alice/i })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /open bob/i })).toHaveAttribute('href', '/coach/students/s2');
      expect(screen.getByRole('link', { name: /open cara/i })).toBeInTheDocument();
    });

    it('surfaces attention chips', () => {
      renderCoachHome();
      expect(screen.getByText(/no program/i)).toBeInTheDocument();
      expect(screen.getByText(/2 to review/i)).toBeInTheDocument();
    });

    it('orders attention-first (no-program, then to-review, then calm)', () => {
      renderCoachHome();
      const names = screen.getAllByRole('link', { name: /open /i }).map((el) => el.getAttribute('aria-label'));
      expect(names).toEqual(['Open Bob', 'Open Cara', 'Open Alice']);
    });

    it('filters the list by the search box', () => {
      renderCoachHome();
      fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'ali' } });
      expect(screen.getByRole('link', { name: /open alice/i })).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: /open bob/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: /open cara/i })).not.toBeInTheDocument();
    });

    it('shows the app-errors triage when there are errors', () => {
      mockClientErrors = { data: [{ id: 'e1', role: 'student', message: 'boom', url: '/x', created_at: '2026-01-01' }] };
      renderCoachHome();
      expect(screen.getByText(/app errors/i)).toBeInTheDocument();
      expect(screen.getByText('boom')).toBeInTheDocument();
    });
  });

  describe('with a selected student', () => {
    beforeEach(() => {
      mockStudentsData = {
        data: [{ id: 's-1', profile: { full_name: 'Alice' } }],
        isLoading: false,
      };
    });

    it('renders a back link to all athletes', () => {
      renderCoachHome('/coach/students/s-1/programming');
      expect(screen.getByRole('link', { name: /all athletes/i })).toHaveAttribute('href', '/coach/students');
    });

    it('renders the tab strip with four tabs (no Messaging)', () => {
      renderCoachHome('/coach/students/s-1/programming');
      expect(screen.getByRole('tablist')).toBeInTheDocument();
      expect(screen.getAllByRole('tab')).toHaveLength(4);
      expect(screen.queryByRole('tab', { name: /messaging/i })).not.toBeInTheDocument();
    });

    it('redirects bare /coach/students/:id to programming', () => {
      renderCoachHome('/coach/students/s-1');
      expect(screen.getByTestId('programming-section')).toBeInTheDocument();
      expect(screen.queryByTestId('profile-section')).not.toBeInTheDocument();
    });

    it('renders only the profile tab on /profile', () => {
      renderCoachHome('/coach/students/s-1/profile');
      expect(screen.getByTestId('profile-section')).toHaveTextContent('profile:s-1');
      expect(screen.queryByTestId('programming-section')).not.toBeInTheDocument();
    });

    it('renders only the stats tab on /stats', () => {
      renderCoachHome('/coach/students/s-1/stats');
      expect(screen.getByTestId('stats-section')).toHaveTextContent('stats:s-1');
    });

    it('redirects legacy /messaging to /profile', () => {
      renderCoachHome('/coach/students/s-1/messaging');
      expect(screen.getByTestId('profile-section')).toBeInTheDocument();
    });
  });
});
