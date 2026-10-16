import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
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
import SideNav from './SideNav';
import { reselectOnClick } from './navItems';

function LocationProbe() {
  const { pathname, search } = useLocation();
  return <div data-testid="location">{pathname + search}</div>;
}

function renderBottomNav(route = '/coach/students', Nav = BottomNav) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[route]}>
        <Nav />
        <LocationProbe />
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

  // Review item L13: tapping the tab that is open did nothing on an athlete
  // page — the roster route opened, and its restore sent the coach straight
  // back to the athlete. A tap on the open tab now forgets the tab's place.
  describe('a tap on the tab that is open', () => {
    const ATHLETE = 'sl_last_coach_students_path';
    const REVIEW = 'sl_last_coach_session';
    const FILTER = 'sl_last_coach_sessions_student';
    const REVIEW_PATH = '/coach/student/s-1/session/sess-1/review';

    beforeEach(() => {
      localStorage.clear();
      sessionStorage.clear();
      sessionStorage.setItem(ATHLETE, '/coach/students/s-1');
      sessionStorage.setItem(REVIEW, JSON.stringify({ studentId: 's-1', sessionId: 'sess-1' }));
      sessionStorage.setItem(FILTER, 's-1');
    });

    const tab = (name) => screen.getByRole('link', { name });

    it('Athletes, on an athlete page, forgets the athlete and opens the roster', () => {
      renderBottomNav('/coach/students/s-1');
      fireEvent.click(tab(/athletes/i));
      expect(sessionStorage.getItem(ATHLETE)).toBeNull();
      expect(screen.getByTestId('location')).toHaveTextContent(/^\/coach\/students$/);
      // The Sessions tab keeps its own place.
      expect(sessionStorage.getItem(REVIEW)).not.toBeNull();
      expect(sessionStorage.getItem(FILTER)).toBe('s-1');
    });

    it('Athletes, from another tab, keeps the athlete to come back to', () => {
      renderBottomNav('/coach/messages');
      fireEvent.click(tab(/athletes/i));
      expect(sessionStorage.getItem(ATHLETE)).toBe('/coach/students/s-1');
    });

    it('Sessions, on a review, forgets the review and the filter and opens the feed', () => {
      renderBottomNav(REVIEW_PATH);
      fireEvent.click(tab(/sessions/i));
      expect(sessionStorage.getItem(REVIEW)).toBeNull();
      expect(sessionStorage.getItem(FILTER)).toBeNull();
      expect(screen.getByTestId('location')).toHaveTextContent(/^\/coach\/sessions$/);
      expect(sessionStorage.getItem(ATHLETE)).toBe('/coach/students/s-1');
    });

    it('Sessions, from another tab, keeps the review to come back to', () => {
      renderBottomNav('/coach/students/s-1');
      fireEvent.click(tab(/sessions/i));
      expect(sessionStorage.getItem(REVIEW)).not.toBeNull();
      expect(sessionStorage.getItem(FILTER)).toBe('s-1');
    });

    // A modified click opens the tab elsewhere and leaves this window where
    // it is: nothing of this window's places is forgotten. (Asked of the
    // handler itself: jsdom cannot open the other window the link would.)
    it.each([
      ['a ctrl-click', { button: 0, ctrlKey: true }],
      ['a cmd-click', { button: 0, metaKey: true }],
      ['a shift-click', { button: 0, shiftKey: true }],
      ['an alt-click', { button: 0, altKey: true }],
      ['a middle click', { button: 1 }],
    ])('forgets nothing on %s', (_label, event) => {
      const onReselect = vi.fn();
      reselectOnClick(event, true, onReselect);
      expect(onReselect).not.toHaveBeenCalled();
      reselectOnClick({ button: 0 }, true, onReselect);
      expect(onReselect).toHaveBeenCalledTimes(1);
    });

    it('forgets nothing for a tab that is not open', () => {
      const onReselect = vi.fn();
      reselectOnClick({ button: 0 }, false, onReselect);
      reselectOnClick({ button: 0 }, null, onReselect);
      expect(onReselect).not.toHaveBeenCalled();
    });

    it('does the same in the side nav', () => {
      renderBottomNav('/coach/students/s-1/s/sess-1', SideNav);
      fireEvent.click(tab(/athletes/i));
      expect(sessionStorage.getItem(ATHLETE)).toBeNull();
      expect(screen.getByTestId('location')).toHaveTextContent(/^\/coach\/students$/);
    });

    it('does the same for Sessions in the side nav', () => {
      renderBottomNav('/coach/sessions?student=s-1', SideNav);
      fireEvent.click(tab(/sessions/i));
      expect(sessionStorage.getItem(REVIEW)).toBeNull();
      expect(sessionStorage.getItem(FILTER)).toBeNull();
      expect(screen.getByTestId('location')).toHaveTextContent(/^\/coach\/sessions$/);
    });
  });
});
