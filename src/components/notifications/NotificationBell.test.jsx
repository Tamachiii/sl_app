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

  it('is a 44px target', () => {
    renderBell();
    const btn = screen.getByRole('button', { name: /open notifications/i });
    expect(btn).toHaveClass('w-11', 'h-11');
    expect(btn).not.toHaveClass('w-10');
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

  it('leaves the popover to be positioned by UserMenu: its wrapper is not positioned', () => {
    renderBell();
    const btn = screen.getByRole('button', { name: /open notifications/i });
    fireEvent.click(btn);
    const menu = screen.getByRole('menu', { name: /notifications/i });
    expect(menu.parentElement).toBe(btn.parentElement);
    expect(btn.parentElement).not.toHaveClass('relative');
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
    const markAllBtn = screen.getByRole('button', { name: /mark all read/i });
    // A pill that is a button: 44px high (review N18 — it was 81x15).
    expect(markAllBtn).toHaveClass('sl-pill', 'sl-pill-btn');
    // "Alle als gelesen markieren" wraps inside the pill instead of
    // widening the header past the popover.
    expect(markAllBtn).not.toHaveClass('shrink-0');
    fireEvent.click(markAllBtn);
    expect(mockMarkAll.mutate).toHaveBeenCalledTimes(1);
  });
});
