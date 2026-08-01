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

// Inline stubs that read the outlet context the same way the real sections do
// — verifies the layout's <Outlet context> wiring without pulling in their
// data hooks.
function OverviewStub() {
  const { student } = useOutletContext();
  return <div data-testid="overview">overview:{student.id}</div>;
}
function SessionStub() {
  const { student } = useOutletContext();
  return <div data-testid="session-editor">session:{student.id}</div>;
}

import CoachHome from './CoachHome';

// Mirrors the real route tree: the athlete is ONE page, with every surface that
// used to be a tab redirecting back to it.
function renderCoachHome(path = '/coach/students') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/coach/students" element={<CoachHome />} />
        <Route path="/coach/students/:studentId" element={<CoachHome />}>
          <Route index element={<OverviewStub />} />
          <Route path="s/:sessionId" element={<SessionStub />} />
          <Route path="programming" element={<Navigate to=".." replace relative="path" />} />
          <Route path="progress" element={<Navigate to=".." replace relative="path" />} />
          <Route path="profile" element={<Navigate to=".." replace relative="path" />} />
          <Route path="goals" element={<Navigate to=".." replace relative="path" />} />
          <Route path="stats" element={<Navigate to=".." replace relative="path" />} />
          <Route path="messaging" element={<Navigate to=".." replace relative="path" />} />
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
      renderCoachHome('/coach/students/s-1');
      expect(screen.getByRole('link', { name: /all athletes/i })).toHaveAttribute('href', '/coach/students');
    });

    it('renders no tab strip — the athlete is one page', () => {
      renderCoachHome('/coach/students/s-1');
      expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
      expect(screen.queryAllByRole('tab')).toHaveLength(0);
    });

    it('makes the athlete the page title, and keeps it while a session is open', () => {
      renderCoachHome('/coach/students/s-1');
      expect(screen.getByRole('heading', { level: 1, name: 'Alice.' })).toBeInTheDocument();
      // The roster title is REPLACED, not stacked above the name.
      expect(screen.queryByRole('heading', { name: 'Athletes.' })).not.toBeInTheDocument();

      // The editor is a child route, so identity must survive the drill-down.
      renderCoachHome('/coach/students/s-1/s/sess-1');
      expect(screen.getAllByRole('heading', { level: 1, name: 'Alice.' }).length).toBeGreaterThan(0);
      expect(screen.getByTestId('session-editor')).toHaveTextContent('session:s-1');
    });

    it('carries nothing but the name — no second identity row under the title', () => {
      renderCoachHome('/coach/students/s-1');
      expect(screen.queryByRole('link', { name: /view sessions/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: /^message$/i })).not.toBeInTheDocument();
      // The fixture carries a created_at, so a date on screen means the meta
      // line came back rather than the student simply having no join date.
      expect(screen.queryByText(/coaching since/i)).not.toBeInTheDocument();
      expect(screen.queryByRole('heading', { level: 2, name: /alice/i })).not.toBeInTheDocument();
    });

    it("doesn't double the full stop on a name that already ends in one", () => {
      mockStudentsData = {
        data: [{
          id: 's-1',
          profile_id: 'p-1',
          created_at: '2025-03-04T00:00:00Z',
          profile: { full_name: 'Sammy Jr.' },
        }],
        isLoading: false,
      };
      renderCoachHome('/coach/students/s-1');
      expect(screen.getByRole('heading', { level: 1, name: 'Sammy Jr.' })).toBeInTheDocument();
    });

    it('renders the overview on the bare athlete URL', () => {
      renderCoachHome('/coach/students/s-1');
      expect(screen.getByTestId('overview')).toHaveTextContent('overview:s-1');
    });

    it.each([
      '/coach/students/s-1/programming',
      '/coach/students/s-1/progress',
      '/coach/students/s-1/profile',
      '/coach/students/s-1/goals',
      '/coach/students/s-1/stats',
      '/coach/students/s-1/messaging',
    ])('former tab URL %s falls back to the one page', (path) => {
      renderCoachHome(path);
      expect(screen.getByTestId('overview')).toBeInTheDocument();
    });
  });
});
