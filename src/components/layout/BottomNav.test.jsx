import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

let mockRole = 'coach';

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({ role: mockRole, user: { id: 'me' } }),
}));

// The Messages tab now reads an unread-count via React Query. Stub the hook
// so we don't need a fake supabase chain; most tests below leave it at 0.
let mockUnread = 0;
vi.mock('../../hooks/useMessages', () => ({
  useUnreadMessageCount: () => ({ data: mockUnread }),
}));

// The Sessions tab's badge reads the number of sessions to review. Stubbed at
// the one hook the navigation asks; the hook has its own tests.
let mockToReview;
const toReviewCalls = vi.fn();
vi.mock('../../hooks/useToReviewCount', () => ({
  useToReviewCount: () => {
    toReviewCalls();
    return mockToReview;
  },
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
    mockToReview = undefined;
    mockUnread = 0;
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

  // The open tab is the one the page says it is (`aria-current="page"`), which
  // is also what draws it in blue: one fact for the eye and for a screen
  // reader. Exactly one tab is open on a page of the nav.
  const openTabs = () =>
    within(screen.getByRole('navigation', { name: 'Main navigation' }))
      .getAllByRole('link')
      .filter((link) => link.getAttribute('aria-current') === 'page')
      .map((link) => link.textContent);

  it.each(['/coach/students', '/coach/students/s-1', '/coach/students/s-1/s/sess-1'])(
    'Athletes tab is active on %s',
    (route) => {
      renderBottomNav(route);
      expect(screen.getByRole('link', { name: /athletes/i })).toHaveAttribute('aria-current', 'page');
      expect(openTabs()).toEqual(['Athletes']);
    },
  );

  it('Athletes tab is active on legacy singular-prefix authoring routes (now redirects)', () => {
    renderBottomNav('/coach/student/s-1/week/w-1');
    const athletesLink = screen.getByRole('link', { name: /athletes/i });
    expect(athletesLink).toHaveAttribute('aria-current', 'page');
    expect(openTabs()).toEqual(['Athletes']);
  });

  it('Sessions tab is active on the review deep route', () => {
    renderBottomNav('/coach/student/s-1/session/sess-1/review');
    const sessionsLink = screen.getByRole('link', { name: /sessions/i });
    expect(sessionsLink).toHaveAttribute('aria-current', 'page');
  });

  it('Athletes tab is NOT active on the review deep route', () => {
    renderBottomNav('/coach/student/s-1/session/sess-1/review');
    const athletesLink = screen.getByRole('link', { name: /athletes/i });
    expect(athletesLink).not.toHaveAttribute('aria-current');
    expect(openTabs()).toEqual(['Sessions']);
  });

  it.each([
    ['/coach/exercises', 'Library'],
    ['/coach/messages/p-1', 'Messages'],
  ])('a tab without a rule of its own follows the router: on %s, %s', (route, open) => {
    renderBottomNav(route);
    expect(openTabs()).toEqual([open]);
  });

  it('Training tab is active on the training list', () => {
    mockRole = 'student';
    renderBottomNav('/student');
    expect(screen.getByRole('link', { name: /training/i })).toHaveAttribute('aria-current', 'page');
    expect(openTabs()).toEqual(['Training']);
  });

  it('Training tab is not active when student is on a sub-route like /student/session/1', () => {
    mockRole = 'student';
    renderBottomNav('/student/session/1');
    const trainingLink = screen.getByRole('link', { name: /training/i });
    expect(trainingLink).not.toHaveAttribute('aria-current');
    expect(openTabs()).toEqual([]);
  });

  it('marks the open tab in the side nav the same way', () => {
    renderBottomNav('/coach/student/s-1/session/sess-1/review', SideNav);
    expect(openTabs()).toEqual(['Sessions']);
  });

  // Under 1024px the tab bar, from 1024px the side nav: one of the two on any
  // screen, named the same. (Read off their classes: jsdom has no layout.)
  it('is the tab bar under 1024px, and the side nav from 1024px', () => {
    renderBottomNav('/coach/students');
    renderBottomNav('/coach/students', SideNav);
    const [tabBar, sideNav] = screen.getAllByRole('navigation', { name: 'Main navigation' });
    expect(tabBar).toHaveClass('lg:hidden');
    expect(tabBar).not.toHaveClass('hidden');
    expect(sideNav).toHaveClass('hidden', 'lg:flex');
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

  // Live finding N17 / review item L35: nothing outside the roster said how
  // many sessions wait for review. The Sessions tab says it now.
  describe('the number of sessions to review', () => {
    const sessionsTab = () => screen.getByRole('link', { name: /^sessions/i });
    // The tab's name: its label, then what the badge says. A browser lays the
    // two out as flex items and reads a space between them; jsdom has no
    // layout and joins them, hence the optional space.
    const named = (words) => new RegExp(`^Sessions ?${words}$`);

    it.each([
      ['not known yet', undefined],
      ['zero', 0],
    ])('draws nothing when it is %s', (_label, n) => {
      mockToReview = n;
      renderBottomNav();
      expect(sessionsTab()).toHaveAccessibleName('Sessions');
      expect(sessionsTab().textContent).toBe('Sessions');
    });

    it('draws the number on the tab, and says it in words', () => {
      mockToReview = 3;
      renderBottomNav();
      expect(within(sessionsTab()).getByText('3')).toHaveAttribute('aria-hidden', 'true');
      expect(sessionsTab()).toHaveAccessibleName(named('3 sessions to review'));
    });

    it('counts one session in the singular', () => {
      mockToReview = 1;
      renderBottomNav();
      expect(sessionsTab()).toHaveAccessibleName(named('1 session to review'));
    });

    // 147 on production when this was written: the badge stays two digits.
    it('caps the number it draws, not the one it says', () => {
      mockToReview = 147;
      renderBottomNav();
      expect(within(sessionsTab()).getByText('99+')).toBeInTheDocument();
      expect(within(sessionsTab()).queryByText('147')).toBeNull();
      expect(sessionsTab()).toHaveAccessibleName(named('147 sessions to review'));
    });

    it('is on the Sessions tab only', () => {
      mockToReview = 3;
      renderBottomNav();
      for (const name of [/athletes/i, /messages/i, /library/i]) {
        expect(within(screen.getByRole('link', { name })).queryByText('3')).toBeNull();
      }
    });

    it('is in the side nav too, as a count at the end of the row', () => {
      mockToReview = 12;
      renderBottomNav('/coach/students', SideNav);
      expect(within(sessionsTab()).getByText('12')).toBeInTheDocument();
      expect(sessionsTab()).toHaveAccessibleName(named('12 sessions to review'));
    });

    it('is never asked for in the athlete’s nav', () => {
      mockRole = 'student';
      mockToReview = 3;
      renderBottomNav('/student');
      renderBottomNav('/student', SideNav);
      expect(toReviewCalls).not.toHaveBeenCalled();
      expect(screen.queryByText('3')).toBeNull();
    });
  });

  // The Messages tab of both roles counts the unread messages the way the
  // Sessions tab counts its reviews: digits for the eye, words for the ear.
  describe('the number of unread messages', () => {
    const messagesTab = () => screen.getByRole('link', { name: /^messages/i });
    const named = (words) => new RegExp(`^Messages ?${words}$`);

    it('draws nothing when there is none', () => {
      renderBottomNav();
      expect(messagesTab()).toHaveAccessibleName('Messages');
    });

    it.each(['coach', 'student'])('draws the number on the %s’s tab, and says it in words', (role) => {
      mockRole = role;
      mockUnread = 4;
      renderBottomNav(role === 'coach' ? '/coach/students' : '/student');
      expect(within(messagesTab()).getByText('4')).toHaveAttribute('aria-hidden', 'true');
      expect(messagesTab()).toHaveAccessibleName(named('4 unread'));
    });

    it('caps the number it draws, not the one it says', () => {
      mockUnread = 120;
      renderBottomNav();
      expect(within(messagesTab()).getByText('99+')).toBeInTheDocument();
      expect(messagesTab()).toHaveAccessibleName(named('120 unread'));
    });

    it('is in the side nav too', () => {
      mockUnread = 2;
      renderBottomNav('/coach/students', SideNav);
      expect(messagesTab()).toHaveAccessibleName(named('2 unread'));
    });
  });
});
