import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// The athlete's Messages tab: one coach, so the thread with them straight
// away, under a title that names them. The thread and the header menu have
// tests of their own.
vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({ profile: { full_name: 'Alex Honnold' }, signOut: vi.fn() }),
}));

let mockCoach;
vi.mock('../../hooks/useStudents', () => ({
  useMyCoach: () => mockCoach,
}));
vi.mock('../ui/UserMenu', () => ({
  default: ({ profileHref }) => <div data-testid="user-menu" data-profile={profileHref} />,
}));
vi.mock('../messaging/MessageThread', () => ({
  default: ({ otherProfileId, otherFullName }) => (
    <div data-testid="thread" data-other={otherProfileId} data-name={otherFullName ?? ''} />
  ),
}));

import StudentMessages from './StudentMessages';

function renderPage() {
  render(
    <MemoryRouter>
      <StudentMessages />
    </MemoryRouter>,
  );
}

describe('StudentMessages', () => {
  beforeEach(() => {
    mockCoach = { data: { id: 'coach-1', full_name: 'Coach Carter' }, isLoading: false };
  });

  it('is titled "Messages", with the coach’s name under it, and opens the thread with them', () => {
    renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'Messages' })).toBeInTheDocument();
    expect(screen.getByText('Coach Carter')).toBeInTheDocument();
    const thread = screen.getByTestId('thread');
    expect(thread).toHaveAttribute('data-other', 'coach-1');
    expect(thread).toHaveAttribute('data-name', 'Coach Carter');
  });

  it('the header menu leads to the athlete’s profile', () => {
    renderPage();
    expect(screen.getByTestId('user-menu')).toHaveAttribute('data-profile', '/student/profile');
  });

  it('waits for the coach with a spinner', () => {
    mockCoach = { data: undefined, isLoading: true };
    renderPage();
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
    expect(screen.queryByTestId('thread')).not.toBeInTheDocument();
    expect(screen.queryByText('You aren’t linked to a coach yet.')).not.toBeInTheDocument();
  });

  it('an athlete without a coach is told so, and gets no thread', () => {
    mockCoach = { data: null, isLoading: false };
    renderPage();
    expect(screen.getByText('You aren’t linked to a coach yet.')).toBeInTheDocument();
    expect(screen.queryByTestId('thread')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Messages' })).toBeInTheDocument();
  });
});
