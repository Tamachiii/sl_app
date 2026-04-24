import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

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

vi.mock('./StudentGoalsSection', () => ({
  default: () => <div data-testid="goals-section" />,
}));

vi.mock('./StudentStatsSection', () => ({
  default: () => <div data-testid="stats-section" />,
}));

import CoachHome from './CoachHome';

function renderCoachHome(path = '/coach/students') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/coach/students" element={<CoachHome />} />
        <Route path="/coach/students/:studentId" element={<CoachHome />} />
      </Routes>
    </MemoryRouter>
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

  it('renders selected student sections when a student is in the URL', () => {
    mockStudentsData = {
      data: [
        { id: 's-1', profile: { full_name: 'Alice' } },
      ],
      isLoading: false,
    };
    renderCoachHome('/coach/students/s-1');
    expect(screen.getByRole('heading', { level: 2, name: 'Alice' })).toBeInTheDocument();
    expect(screen.getByTestId('goals-section')).toBeInTheDocument();
    expect(screen.getByTestId('stats-section')).toBeInTheDocument();
  });

  it('renders the page title', () => {
    mockStudentsData = { data: [], isLoading: false };
    renderCoachHome();
    expect(screen.getByRole('heading', { level: 1, name: 'Students.' })).toBeInTheDocument();
  });
});
