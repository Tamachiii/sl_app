import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HashRouter, MemoryRouter, useLocation, useRoutes } from 'react-router-dom';

// Smoke test of the WHOLE route table against the installed react-router.
// The table leans on behaviour a router release can move under us without a
// single line changing here: `<Navigate to=".." relative="path">` on the
// retired athlete tabs, redirects that interpolate params, pathless layout
// routes carrying the auth and role gates, and the two catch-alls. Every page
// is stubbed, so this is about WHERE a URL lands, not what the page renders.

let mockAuth;

vi.mock('./hooks/useAuth', () => ({
  useAuth: () => mockAuth,
}));

vi.mock('./components/layout/AppShell', async () => {
  const { Outlet } = await import('react-router-dom');
  return { default: () => <Outlet /> };
});

// The athlete route nests its children inside CoachHome, so the stub keeps
// the outlet.
vi.mock('./components/coach/CoachHome', async () => {
  const { Outlet } = await import('react-router-dom');
  return { default: () => <div data-testid="page">CoachHome<Outlet /></div> };
});

vi.mock('./components/auth/LoginPage', () => ({ default: () => <div data-testid="page">LoginPage</div> }));
vi.mock('./components/coach/StudentOverview', () => ({ default: () => <div data-testid="child">StudentOverview</div> }));
vi.mock('./components/coach/SessionEditor', () => ({ default: () => <div data-testid="child">SessionEditor</div> }));
vi.mock('./components/coach/SessionsFeed', () => ({ default: () => <div data-testid="page">SessionsFeed</div> }));
vi.mock('./components/coach/ExerciseLibrary', () => ({ default: () => <div data-testid="page">ExerciseLibrary</div> }));
vi.mock('./components/coach/SessionReview', () => ({ default: () => <div data-testid="page">SessionReview</div> }));
vi.mock('./components/coach/CoachMessages', () => ({ default: () => <div data-testid="page">CoachMessages</div> }));
vi.mock('./components/student/StudentTraining', () => ({ default: () => <div data-testid="page">StudentTraining</div> }));
vi.mock('./components/student/StudentDashboard', () => ({ default: () => <div data-testid="page">StudentStats</div> }));
vi.mock('./components/student/SessionView', () => ({ default: () => <div data-testid="page">SessionView</div> }));
vi.mock('./components/student/MyGoals', () => ({ default: () => <div data-testid="page">MyGoals</div> }));
vi.mock('./components/student/StudentMessages', () => ({ default: () => <div data-testid="page">StudentMessages</div> }));
vi.mock('./components/student/StudentProfile', () => ({ default: () => <div data-testid="page">StudentProfile</div> }));
vi.mock('./components/student/StudentProgramAuthor', () => ({ default: () => <div data-testid="page">StudentProgramAuthor</div> }));
vi.mock('./components/ui/NotFound', () => ({ default: () => <div data-testid="page">NotFound</div> }));

import { routes } from './routes';

const SIGNED_OUT = { user: null, role: null, isLoading: false };
const COACH = { user: { id: 'coach-1' }, role: 'coach', isLoading: false };
const STUDENT = { user: { id: 'student-1' }, role: 'student', isLoading: false };

function AppRoutes() {
  return useRoutes(routes);
}

function Where() {
  const { pathname, state } = useLocation();
  return <output data-testid="where" data-from={state?.from ?? ''}>{pathname}</output>;
}

// Renders the table at `from` and waits for the lazy page — and, on the
// athlete route, the lazy child inside it — to resolve. Returns what the URL
// became and what rendered.
async function land(from, { nested = false } = {}) {
  render(
    <MemoryRouter initialEntries={[from]}>
      <AppRoutes />
      <Where />
    </MemoryRouter>,
  );
  const page = await screen.findByTestId('page');
  const child = nested ? await screen.findByTestId('child') : screen.queryByTestId('child');
  return {
    path: screen.getByTestId('where').textContent,
    page: page.firstChild.textContent,
    child: child?.textContent ?? null,
  };
}

describe('route table', () => {
  beforeEach(() => {
    mockAuth = SIGNED_OUT;
  });

  describe('signed out', () => {
    it.each([
      ['/login'],
      ['/'],
      ['/coach/students'],
      ['/student/session/s1'],
      ['/no/such/page'],
    ])('%s shows the login page', async (from) => {
      expect(await land(from)).toEqual({ path: '/login', page: 'LoginPage', child: null });
    });

    // Review item L11: the link asked for goes to the login page with the
    // redirect, which returns to it once signed in (LoginPage.test.jsx).
    it.each([
      ['/coach/students/a1/s/s1', '/coach/students/a1/s/s1'],
      ['/coach/students/a1?program=p2', '/coach/students/a1?program=p2'],
      ['/student/session/s1', '/student/session/s1'],
      ['/no/such/page', '/no/such/page'],
    ])('%s hands the login page the link it came from', async (from, kept) => {
      await land(from);
      expect(screen.getByTestId('where')).toHaveAttribute('data-from', kept);
    });
  });

  describe('coach', () => {
    beforeEach(() => {
      mockAuth = COACH;
    });

    it.each([
      // Role home, and the URLs that used to be pages of their own.
      ['/', '/coach/students', 'CoachHome', null],
      ['/coach', '/coach/students', 'CoachHome', null],
      ['/coach/dashboard', '/coach/students', 'CoachHome', null],
      ['/coach/students', '/coach/students', 'CoachHome', null],
      // The athlete page and its only child destination.
      ['/coach/students/a1', '/coach/students/a1', 'CoachHome', 'StudentOverview'],
      ['/coach/students/a1/s/s1', '/coach/students/a1/s/s1', 'CoachHome', 'SessionEditor'],
      // Retired tabs: `..` resolved against the PATH, one segment up.
      ['/coach/students/a1/programming', '/coach/students/a1', 'CoachHome', 'StudentOverview'],
      ['/coach/students/a1/progress', '/coach/students/a1', 'CoachHome', 'StudentOverview'],
      ['/coach/students/a1/profile', '/coach/students/a1', 'CoachHome', 'StudentOverview'],
      ['/coach/students/a1/goals', '/coach/students/a1', 'CoachHome', 'StudentOverview'],
      ['/coach/students/a1/stats', '/coach/students/a1', 'CoachHome', 'StudentOverview'],
      ['/coach/students/a1/messaging', '/coach/students/a1', 'CoachHome', 'StudentOverview'],
      // Legacy deep links that carry their params across the redirect.
      ['/coach/students/a1/programming/s/s1', '/coach/students/a1/s/s1', 'CoachHome', 'SessionEditor'],
      ['/coach/student/a1/goals', '/coach/students/a1', 'CoachHome', 'StudentOverview'],
      ['/coach/student/a1/week/w1', '/coach/students/a1', 'CoachHome', 'StudentOverview'],
      ['/coach/student/a1/week/w1/session/s1', '/coach/students/a1/s/s1', 'CoachHome', 'SessionEditor'],
      // The other coach pages.
      ['/coach/sessions', '/coach/sessions', 'SessionsFeed', null],
      ['/coach/student/a1/session/s1/review', '/coach/student/a1/session/s1/review', 'SessionReview', null],
      ['/coach/messages', '/coach/messages', 'CoachMessages', null],
      ['/coach/messages/p1', '/coach/messages/p1', 'CoachMessages', null],
      ['/coach/exercises', '/coach/exercises', 'ExerciseLibrary', null],
      // The other role's pages bounce home; an unknown URL is a real 404.
      ['/student', '/coach/students', 'CoachHome', null],
      ['/student/session/s1', '/coach/students', 'CoachHome', null],
      ['/no/such/page', '/no/such/page', 'NotFound', null],
    ])('%s lands on %s', async (from, path, page, child) => {
      expect(await land(from, { nested: child !== null })).toEqual({ path, page, child });
    });
  });

  describe('student', () => {
    beforeEach(() => {
      mockAuth = STUDENT;
    });

    it.each([
      ['/', '/student', 'StudentTraining'],
      ['/student', '/student', 'StudentTraining'],
      ['/student/sessions', '/student', 'StudentTraining'],
      ['/student/stats', '/student/stats', 'StudentStats'],
      ['/student/dashboard', '/student/stats', 'StudentStats'],
      ['/student/session/s1', '/student/session/s1', 'SessionView'],
      ['/student/goals', '/student/goals', 'MyGoals'],
      ['/student/author', '/student/author', 'StudentProgramAuthor'],
      ['/student/messages', '/student/messages', 'StudentMessages'],
      ['/student/profile', '/student/profile', 'StudentProfile'],
      ['/coach/students', '/student', 'StudentTraining'],
      ['/coach/students/a1/s/s1', '/student', 'StudentTraining'],
      ['/no/such/page', '/no/such/page', 'NotFound'],
    ])('%s lands on %s', async (from, path, page) => {
      expect(await land(from)).toEqual({ path, page, child: null });
    });
  });

  // Signed in — the session is on the device — but the profile has not been
  // read yet, and maybe cannot be: the first launch of a build on a device
  // without a network. "/" is where an installed app starts.
  describe('signed in, with a role this device has not read yet', () => {
    const NO_ROLE_YET = { user: { id: 'student-1' }, role: null, isLoading: false };

    function deviceIs(online) {
      Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
    }

    function open(from) {
      render(
        <MemoryRouter initialEntries={[from]}>
          <AppRoutes />
          <Where />
        </MemoryRouter>,
      );
    }

    beforeEach(() => {
      mockAuth = NO_ROLE_YET;
    });

    afterEach(() => {
      deviceIs(true);
    });

    it('/ waits for the role: it stays where it is, and does not show the login page', async () => {
      open('/');

      // (<output> is a status too: the spinner is found by its label.)
      expect(await screen.findByLabelText('Loading')).toBeInTheDocument();
      expect(screen.getByTestId('where')).toHaveTextContent('/');
      expect(screen.queryByTestId('page')).not.toBeInTheDocument();
      // With a network the role is a moment away: nothing to explain.
      expect(screen.queryByText(/offline/i)).not.toBeInTheDocument();
    });

    it('/ without a network says what it is waiting for', async () => {
      deviceIs(false);
      open('/');

      expect(await screen.findByText(/your account will open as soon as this device is back online/i)).toBeInTheDocument();
      expect(screen.getByTestId('where')).toHaveTextContent('/');
    });

    // (That "/" then opens the role home when the role arrives needs a
    // provider that changes: routes.offline.test.jsx, on the real one.)
    it('a link into the app opens its page: only "/" needs the role to know where to go', async () => {
      expect(await land('/student/session/s1')).toEqual({ path: '/student/session/s1', page: 'SessionView', child: null });
    });
  });

  // The app ships a HashRouter (GitHub Pages has no server-side rewrites), so
  // one case goes through the real history: a redirect must rewrite the hash.
  describe('through the hash history the app ships', () => {
    afterEach(() => {
      window.location.hash = '';
    });

    it('rewrites the hash when a legacy deep link redirects', async () => {
      mockAuth = COACH;
      window.location.hash = '#/coach/student/a1/week/w1/session/s1';
      render(
        <HashRouter>
          <AppRoutes />
        </HashRouter>,
      );
      expect(await screen.findByTestId('child')).toHaveTextContent('SessionEditor');
      expect(window.location.hash).toBe('#/coach/students/a1/s/s1');
    });

    it('opens the role home on a cold launch with no hash at all', async () => {
      mockAuth = STUDENT;
      render(
        <HashRouter>
          <AppRoutes />
        </HashRouter>,
      );
      expect(await screen.findByTestId('page')).toHaveTextContent('StudentTraining');
      expect(window.location.hash).toBe('#/student');
    });
  });
});
