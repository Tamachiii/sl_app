import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

let mockRole = 'coach';

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({ role: mockRole, user: { id: 'me' } }),
}));

// The Messages tab now reads an unread-count via React Query. Stub the hook
// so we don't need a fake supabase chain; tests below just care about layout.
vi.mock('../../hooks/useMessages', () => ({
  useUnreadMessageCount: () => ({ data: 0 }),
}));

import BottomNav from './BottomNav';

function renderBottomNav(route = '/coach/students') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[route]}>
        <BottomNav />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('BottomNav', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRole = 'coach';
  });

  it('renders all 4 coach nav tabs (incl. Messages)', () => {
    renderBottomNav();
    expect(screen.queryByText('Dashboard')).not.toBeInTheDocument();
    expect(screen.getByText('Athletes')).toBeInTheDocument();
    expect(screen.getByText('Sessions')).toBeInTheDocument();
    expect(screen.getByText('Messages')).toBeInTheDocument();
    expect(screen.getByText('Library')).toBeInTheDocument();
  });

  it('does not render a logout button in the nav', () => {
    renderBottomNav();
    expect(screen.queryByRole('button', { name: /sign out/i })).not.toBeInTheDocument();
  });

  // Three tabs since Home and Sessions merged: both listed sessions and both
  // started the next one, so they were two doors onto one question.
  it('renders student nav with Training, Stats and Messages links (Goals lives in Profile)', () => {
    mockRole = 'student';
    renderBottomNav('/student');
    expect(screen.getByText('Training')).toBeInTheDocument();
    expect(screen.getByText('Stats')).toBeInTheDocument();
    expect(screen.getByText('Messages')).toBeInTheDocument();
    expect(screen.queryByText('Home')).not.toBeInTheDocument();
    expect(screen.queryByText('Sessions')).not.toBeInTheDocument();
    // Goals was promoted out of the bottom nav — reachable via the Profile
    // page (avatar in header → Active goal card → View all).
    expect(screen.queryByText('Goals')).not.toBeInTheDocument();
    expect(screen.queryByText('Athletes')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sign out/i })).not.toBeInTheDocument();
  });

  it('Athletes tab is active on legacy singular-prefix authoring routes (now redirects)', () => {
    renderBottomNav('/coach/student/s-1/week/w-1');
    const athletesLink = screen.getByRole('link', { name: /athletes/i });
    expect(athletesLink).toHaveClass('text-[var(--color-accent)]');
  });

  it('Sessions tab is active on the review deep route', () => {
    renderBottomNav('/coach/student/s-1/session/sess-1/review');
    const sessionsLink = screen.getByRole('link', { name: /sessions/i });
    expect(sessionsLink).toHaveClass('text-[var(--color-accent)]');
  });

  it('Athletes tab is NOT active on the review deep route', () => {
    renderBottomNav('/coach/student/s-1/session/sess-1/review');
    const athletesLink = screen.getByRole('link', { name: /athletes/i });
    expect(athletesLink).not.toHaveClass('text-[var(--color-accent)]');
  });

  it('Training tab is not active when student is on a sub-route like /student/session/1', () => {
    mockRole = 'student';
    renderBottomNav('/student/session/1');
    const trainingLink = screen.getByRole('link', { name: /training/i });
    expect(trainingLink).not.toHaveClass('text-primary');
  });
});
