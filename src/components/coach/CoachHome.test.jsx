import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

let mockStudentsData = { data: null, isLoading: false };

vi.mock('../../hooks/useStudents', () => ({
  useStudents: () => mockStudentsData,
}));

vi.mock('../../hooks/useProgram', () => ({
  useProgram: () => ({ data: null, isSuccess: true }),
  useCreateWeek: () => ({ mutate: vi.fn(), isPending: false }),
  useEnsureProgram: () => ({ mutate: vi.fn(), isPending: false }),
}));

import CoachHome from './CoachHome';

function renderCoachHome() {
  return render(
    <MemoryRouter>
      <CoachHome />
    </MemoryRouter>
  );
}

describe('CoachHome', () => {
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

  it('renders student cards', () => {
    mockStudentsData = {
      data: [
        { id: 's-1', profile: { full_name: 'Alice' } },
        { id: 's-2', profile: { full_name: 'Bob' } },
      ],
      isLoading: false,
    };
    renderCoachHome();
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
  });

  it('renders the header title', () => {
    mockStudentsData = { data: [], isLoading: false };
    renderCoachHome();
    expect(screen.getByText('Students')).toBeInTheDocument();
  });
});
