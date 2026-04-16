import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

let mockStudents = { data: [], isLoading: false };
let mockConfirmations = { data: [], isLoading: false };

vi.mock('../../hooks/useStudents', () => ({
  useStudents: () => mockStudents,
}));

vi.mock('../../hooks/useSessionConfirmation', () => ({
  useAllConfirmations: () => mockConfirmations,
}));

import CoachDashboard from './CoachDashboard';

function renderDashboard() {
  return render(
    <MemoryRouter>
      <CoachDashboard />
    </MemoryRouter>
  );
}

describe('CoachDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStudents = { data: [], isLoading: false };
    mockConfirmations = { data: [], isLoading: false };
  });

  it('renders the Dashboard header', () => {
    renderDashboard();
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
  });

  it('renders student names in the students section', () => {
    mockStudents = {
      data: [
        { id: 's-1', profile: { full_name: 'Alice' } },
        { id: 's-2', profile: { full_name: 'Bob' } },
      ],
      isLoading: false,
    };
    renderDashboard();
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
  });

  it('shows empty state when no students', () => {
    renderDashboard();
    expect(screen.getByText(/no students yet/i)).toBeInTheDocument();
  });

  it('renders recent activity confirmations', () => {
    mockConfirmations = {
      data: [
        {
          id: 'c-1',
          session_id: 'sess-1',
          student_id: 's-1',
          student_name: 'Alice',
          session_title: 'Push Day',
          day_number: 1,
          week_number: 1,
          week_label: null,
          confirmed_at: '2026-04-16T10:00:00Z',
          archived_at: null,
        },
      ],
      isLoading: false,
    };
    renderDashboard();
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Push Day')).toBeInTheDocument();
  });

  it('shows empty state when no recent confirmations', () => {
    renderDashboard();
    expect(screen.getByText(/no recent confirmations/i)).toBeInTheDocument();
  });

  it('excludes archived sessions from recent activity', () => {
    mockConfirmations = {
      data: [
        {
          id: 'c-1',
          session_id: 'sess-1',
          student_id: 's-1',
          student_name: 'Alice',
          session_title: 'Pull Day',
          day_number: 1,
          week_number: 1,
          week_label: null,
          confirmed_at: '2026-04-15T10:00:00Z',
          archived_at: '2026-04-16T12:00:00Z',
        },
      ],
      isLoading: false,
    };
    renderDashboard();
    expect(screen.queryByText('Pull Day')).not.toBeInTheDocument();
    expect(screen.getByText(/no recent confirmations/i)).toBeInTheDocument();
  });
});
