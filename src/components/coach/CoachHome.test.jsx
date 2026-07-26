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
function ProgrammingStub() {
  const { student } = useOutletContext();
  return <div data-testid="programming-section">programming:{student.id}</div>;
}
function ProgressStub() {
  const { student } = useOutletContext();
  return <div data-testid="progress-section">progress:{student.id}</div>;
}

vi.mock('./StudentProgrammingSection', () => ({ default: ProgrammingStub }));
vi.mock('./StudentProgressSection', () => ({ default: ProgressStub }));

import CoachHome from './CoachHome';

// Mirrors the real route tree: two destinations, with the surfaces that were
// absorbed (profile → header, goals/stats → progress) kept as redirects.
function renderCoachHome(path = '/coach/students') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/coach/students" element={<CoachHome />} />
        <Route path="/coach/students/:studentId" element={<CoachHome />}>
          <Route index element={<Navigate to="programming" replace />} />
          <Route path="programming" element={<ProgrammingStub />} />
          <Route path="progress" element={<ProgressStub />} />
          <Route path="profile" element={<Navigate to="../programming" replace />} />
          <Route path="goals" element={<Navigate to="../progress" replace />} />
          <Route path="stats" element={<Navigate to="../progress" replace />} />
          <Route path="messaging" element={<Navigate to="../programming" replace />} />
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
        data: [{
          id: 's-1',
          profile_id: 'p-1',
          created_at: '2025-03-04T00:00:00Z',
          profile: { full_name: 'Alice' },
        }],
        isLoading: false,
      };
    });

    it('renders a back link to all athletes', () => {
      renderCoachHome('/coach/students/s-1/programming');
      expect(screen.getByRole('link', { name: /all athletes/i })).toHaveAttribute('href', '/coach/students');
    });

    it('renders exactly two tabs — Programming and Progress', () => {
      renderCoachHome('/coach/students/s-1/programming');
      expect(screen.getByRole('tablist')).toBeInTheDocument();
      const tabs = screen.getAllByRole('tab');
      expect(tabs).toHaveLength(2);
      expect(tabs.map((el) => el.textContent)).toEqual(['Programming', 'Progress']);
      // Profile is a header now, not a destination.
      expect(screen.queryByRole('tab', { name: /profile/i })).not.toBeInTheDocument();
    });

    it('shows the athlete header on every tab, so identity is never hidden', () => {
      renderCoachHome('/coach/students/s-1/programming');
      expect(screen.getByRole('heading', { level: 2, name: 'Alice' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /view sessions/i })).toHaveAttribute(
        'href', '/coach/sessions?student=s-1',
      );

      renderCoachHome('/coach/students/s-1/progress');
      expect(screen.getAllByRole('heading', { level: 2, name: 'Alice' }).length).toBeGreaterThan(0);
    });

    it('links the header Message action to the thread by profile id', () => {
      renderCoachHome('/coach/students/s-1/programming');
      expect(screen.getByRole('link', { name: /message/i })).toHaveAttribute(
        'href', '/coach/messages/p-1',
      );
    });

    it('redirects bare /coach/students/:id to programming', () => {
      renderCoachHome('/coach/students/s-1');
      expect(screen.getByTestId('programming-section')).toBeInTheDocument();
      expect(screen.queryByTestId('progress-section')).not.toBeInTheDocument();
    });

    it('renders the merged Progress tab on /progress', () => {
      renderCoachHome('/coach/students/s-1/progress');
      expect(screen.getByTestId('progress-section')).toHaveTextContent('progress:s-1');
      expect(screen.queryByTestId('programming-section')).not.toBeInTheDocument();
    });

    it.each([
      ['/coach/students/s-1/goals', 'progress-section'],
      ['/coach/students/s-1/stats', 'progress-section'],
      ['/coach/students/s-1/profile', 'programming-section'],
      ['/coach/students/s-1/messaging', 'programming-section'],
    ])('absorbed deep link %s lands on the surface that took it over', (path, testId) => {
      renderCoachHome(path);
      expect(screen.getByTestId(testId)).toBeInTheDocument();
    });
  });
});
