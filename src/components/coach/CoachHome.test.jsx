import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Navigate, Outlet, useOutletContext } from 'react-router-dom';

let mockStudentsData = { data: null, isLoading: false };

vi.mock('../../hooks/useStudents', () => ({
  useStudents: () => mockStudentsData,
}));

vi.mock('../../hooks/useProgram', () => ({
  useProgramsForStudent: () => ({ data: [], isSuccess: true }),
  useProgram: () => ({ data: null, isSuccess: true }),
  useCreateWeek: () => ({ mutate: vi.fn(), isPending: false }),
  useEnsureProgram: () => ({ mutate: vi.fn(), isPending: false }),
  useCreateProgram: () => ({ mutate: vi.fn(), isPending: false }),
  useRenameProgram: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteProgram: () => ({ mutate: vi.fn(), isPending: false }),
  useSetActiveProgram: () => ({ mutate: vi.fn(), isPending: false }),
  useReorderPrograms: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('../../hooks/useWeek', () => ({
  useReorderWeeks: () => ({ mutate: vi.fn(), isPending: false }),
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
function MessagingStub() {
  const { student } = useOutletContext();
  return <div data-testid="messaging-section">messaging:{student.id}</div>;
}

vi.mock('./StudentProfileSection', () => ({ default: ProfileStub }));
vi.mock('./StudentProgrammingSection', () => ({ default: ProgrammingStub }));
vi.mock('./StudentGoalsSection', () => ({ default: GoalsStub }));
vi.mock('./StudentStatsSection', () => ({ default: StatsStub }));
vi.mock('./StudentMessagingSection', () => ({ default: MessagingStub }));

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
          <Route path="messaging" element={<MessagingStub />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('CoachHome', () => {
  beforeEach(() => {
    localStorage.clear();
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

  it('renders selector with each student when no student is selected', () => {
    mockStudentsData = {
      data: [
        { id: 's-1', profile: { full_name: 'Alice' } },
        { id: 's-2', profile: { full_name: 'Bob' } },
      ],
      isLoading: false,
    };
    renderCoachHome();
    expect(screen.getByRole('option', { name: 'Alice' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Bob' })).toBeInTheDocument();
    expect(screen.getByText(/select a student to manage/i)).toBeInTheDocument();
  });

  it('renders the page title', () => {
    mockStudentsData = { data: [], isLoading: false };
    renderCoachHome();
    expect(screen.getByRole('heading', { level: 1, name: 'Students.' })).toBeInTheDocument();
  });

  describe('with a selected student', () => {
    beforeEach(() => {
      mockStudentsData = {
        data: [{ id: 's-1', profile: { full_name: 'Alice' } }],
        isLoading: false,
      };
    });

    it('renders the student header and tab strip', () => {
      renderCoachHome('/coach/students/s-1/programming');
      expect(screen.getByRole('heading', { level: 2, name: 'Alice' })).toBeInTheDocument();
      expect(screen.getByRole('tablist')).toBeInTheDocument();
      // Five tab links — one for each sub-section.
      expect(screen.getAllByRole('tab')).toHaveLength(5);
    });

    it('redirects bare /coach/students/:id to programming', () => {
      renderCoachHome('/coach/students/s-1');
      expect(screen.getByTestId('programming-section')).toBeInTheDocument();
      // Other tabs aren't mounted.
      expect(screen.queryByTestId('profile-section')).not.toBeInTheDocument();
      expect(screen.queryByTestId('goals-section')).not.toBeInTheDocument();
    });

    it('renders only the profile tab on /profile', () => {
      renderCoachHome('/coach/students/s-1/profile');
      expect(screen.getByTestId('profile-section')).toHaveTextContent('profile:s-1');
      expect(screen.queryByTestId('programming-section')).not.toBeInTheDocument();
    });

    it('renders only the goals tab on /goals', () => {
      renderCoachHome('/coach/students/s-1/goals');
      expect(screen.getByTestId('goals-section')).toHaveTextContent('goals:s-1');
      expect(screen.queryByTestId('stats-section')).not.toBeInTheDocument();
    });

    it('renders only the stats tab on /stats', () => {
      renderCoachHome('/coach/students/s-1/stats');
      expect(screen.getByTestId('stats-section')).toHaveTextContent('stats:s-1');
      expect(screen.queryByTestId('goals-section')).not.toBeInTheDocument();
    });

    it('renders the messaging placeholder on /messaging', () => {
      renderCoachHome('/coach/students/s-1/messaging');
      expect(screen.getByTestId('messaging-section')).toHaveTextContent('messaging:s-1');
    });
  });
});
