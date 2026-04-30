import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

let mockList = { data: [], isLoading: false };
let mockCount = { data: 0 };
const mockMarkRead = { mutate: vi.fn(), isPending: false };
const mockMarkAll = { mutate: vi.fn(), isPending: false };
const mockNavigate = vi.fn();

vi.mock('../../hooks/useNotifications', async () => {
  const actual = await vi.importActual('../../hooks/useNotifications');
  return {
    ...actual,
    useNotifications: () => mockList,
    useUnreadNotificationCount: () => mockCount,
    useMarkNotificationRead: () => mockMarkRead,
    useMarkAllNotificationsRead: () => mockMarkAll,
  };
});

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

import NotificationBell from './NotificationBell';

function renderBell() {
  return render(
    <MemoryRouter>
      <NotificationBell />
    </MemoryRouter>,
  );
}

describe('NotificationBell', () => {
  beforeEach(() => {
    mockList = { data: [], isLoading: false };
    mockCount = { data: 0 };
    mockMarkRead.mutate = vi.fn();
    mockMarkAll.mutate = vi.fn();
    mockNavigate.mockReset();
  });

  it('renders the bell button without a badge when nothing is unread', () => {
    renderBell();
    const btn = screen.getByRole('button', { name: /open notifications/i });
    expect(btn).toBeInTheDocument();
    // No badge digit visible.
    expect(screen.queryByText(/^\d+$/)).not.toBeInTheDocument();
  });

  it('shows an unread count on the badge', () => {
    mockCount = { data: 3 };
    renderBell();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /3 unread/i })).toBeInTheDocument();
  });

  it('caps the badge at 9+', () => {
    mockCount = { data: 42 };
    renderBell();
    expect(screen.getByText('9+')).toBeInTheDocument();
  });

  it('opens the popover and renders empty-state when there are no notifications', () => {
    renderBell();
    fireEvent.click(screen.getByRole('button', { name: /open notifications/i }));
    expect(screen.getByText(/no notifications yet/i)).toBeInTheDocument();
  });

  it('renders one row per notification and navigates + marks-read on click', () => {
    mockList = {
      data: [
        {
          id: 'n1',
          kind: 'session_completed',
          payload: {
            session_id: 'sess-1',
            session_title: 'Upper 1',
            student_row_id: 'srow-1',
            student_name: 'Alice',
          },
          read_at: null,
          created_at: new Date().toISOString(),
        },
      ],
      isLoading: false,
    };
    mockCount = { data: 1 };
    renderBell();
    fireEvent.click(screen.getByRole('button', { name: /1 unread/i }));
    const row = screen.getByText(/Alice completed Upper 1/i);
    expect(row).toBeInTheDocument();
    fireEvent.click(row);
    expect(mockMarkRead.mutate).toHaveBeenCalledWith('n1');
    expect(mockNavigate).toHaveBeenCalledWith('/coach/student/srow-1/session/sess-1/review');
  });

  it('does not call mark-read when the row is already read', () => {
    mockList = {
      data: [{
        id: 'n1',
        kind: 'session_completed',
        payload: { session_id: 'sess-1', session_title: 'Upper 1', student_row_id: 'srow-1', student_name: 'Alice' },
        read_at: new Date().toISOString(),
        created_at: new Date().toISOString(),
      }],
      isLoading: false,
    };
    renderBell();
    fireEvent.click(screen.getByRole('button', { name: /open notifications/i }));
    fireEvent.click(screen.getByText(/Alice completed Upper 1/i));
    expect(mockMarkRead.mutate).not.toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalled();
  });

  it('calls mark-all-read on the footer action', () => {
    mockList = {
      data: [{
        id: 'n1',
        kind: 'session_completed',
        payload: { session_id: 'sess-1', session_title: 'Upper 1', student_row_id: 'srow-1', student_name: 'Alice' },
        read_at: null,
        created_at: new Date().toISOString(),
      }],
      isLoading: false,
    };
    mockCount = { data: 1 };
    renderBell();
    fireEvent.click(screen.getByRole('button', { name: /1 unread/i }));
    fireEvent.click(screen.getByRole('button', { name: /mark all read/i }));
    expect(mockMarkAll.mutate).toHaveBeenCalledTimes(1);
  });
});
