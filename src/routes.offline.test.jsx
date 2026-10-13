import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation, useRoutes } from 'react-router-dom';
import { AuthRetryableFetchError } from '@supabase/supabase-js';

// An installed app is opened where there is no network: at the manifest's
// start URL, "/", by someone who signed in days ago. This is the real provider
// and the real route table — the auth gate, the role gate, the index route —
// on what such a device holds. Only the pages, supabase and the cache client
// are stand-ins. (routes.test.jsx is the table itself, with auth stubbed;
// hooks/useAuth.offline.test.jsx is the provider alone.)

const STORAGE_KEY = 'sb-test-auth-token';

vi.mock('./lib/supabase', () => ({
  supabase: {
    auth: { storageKey: 'sb-test-auth-token', getSession: vi.fn(), onAuthStateChange: vi.fn() },
    from: vi.fn(),
  },
}));
vi.mock('./lib/queryClient', () => ({ replayQueuedWrites: vi.fn() }));

vi.mock('./components/layout/AppShell', async () => {
  const { Outlet } = await import('react-router-dom');
  return { default: () => <Outlet /> };
});
vi.mock('./components/auth/LoginPage', () => ({ default: () => <div data-testid="page">LoginPage</div> }));
vi.mock('./components/coach/CoachHome', () => ({ default: () => <div data-testid="page">CoachHome</div> }));
vi.mock('./components/student/StudentTraining', () => ({ default: () => <div data-testid="page">StudentTraining</div> }));

import { routes } from './routes';
import { AuthProvider } from './hooks/useAuth';
import { supabase } from './lib/supabase';
import { PROFILE_CACHE_KEY } from './lib/profileCache';

const ATHLETE = { id: 'u-athlete', email: 'athlete@example.test' };
const COACH = { id: 'u-coach', email: 'coach@example.test' };

function deviceIs(online) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
}

// Signed in on this device a while ago: the token of the stored session has
// run out since.
function signedInDaysAgo(user, profile) {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ access_token: 'jwt', refresh_token: 'r', expires_at: 1_700_000_000, user }),
  );
  if (profile) localStorage.setItem(PROFILE_CACHE_KEY, JSON.stringify(profile));
}

function AppRoutes() {
  return useRoutes(routes);
}

function Where() {
  const { pathname } = useLocation();
  return <output data-testid="where">{pathname}</output>;
}

// Every page that showed, in order: a login form that flashes before the app
// opens is the bug, also when the app opens in the end.
function coldStart() {
  const shown = [];
  const view = render(
    <AuthProvider>
      <MemoryRouter initialEntries={['/']}>
        <AppRoutes />
        <Where />
      </MemoryRouter>
    </AuthProvider>,
  );
  const observer = new MutationObserver(() => {
    const page = screen.queryByTestId('page')?.textContent;
    if (page && shown.at(-1) !== page) shown.push(page);
  });
  observer.observe(view.container, { childList: true, subtree: true, characterData: true });
  return { shown, where: () => screen.getByTestId('where').textContent };
}

let answerGetSession;
let profileRow;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  deviceIs(false);
  profileRow = null;
  supabase.auth.onAuthStateChange.mockImplementation(() => ({
    data: { subscription: { unsubscribe: vi.fn() } },
  }));
  // The refresh of the expired token is being attempted: no answer yet.
  supabase.auth.getSession.mockImplementation(
    () =>
      new Promise((resolve) => {
        answerGetSession = resolve;
      }),
  );
  supabase.from.mockImplementation(() => ({
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn(async () =>
      profileRow ? { data: profileRow, error: null } : { data: null, error: { message: 'Failed to fetch' } },
    ),
  }));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  deviceIs(true);
});

// What auth-js answers after half a minute of attempts.
const givesUp = () =>
  act(async () => {
    answerGetSession({ data: { session: null }, error: new AuthRetryableFetchError('Failed to fetch', 0) });
  });

describe('the installed app is opened without a network, on an expired token', () => {
  it('an athlete lands on the training list — while auth-js is still trying, and after it gave up', async () => {
    signedInDaysAgo(ATHLETE, { id: ATHLETE.id, role: 'student', full_name: 'Ada' });

    const app = coldStart();

    expect(await screen.findByTestId('page')).toHaveTextContent('StudentTraining');
    expect(app.where()).toBe('/student');

    await givesUp();

    expect(screen.getByTestId('page')).toHaveTextContent('StudentTraining');
    expect(app.where()).toBe('/student');
    expect(app.shown).toEqual(['StudentTraining']);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('a coach lands on the roster', async () => {
    signedInDaysAgo(COACH, { id: COACH.id, role: 'coach', full_name: 'Bea' });

    const app = coldStart();

    expect(await screen.findByTestId('page')).toHaveTextContent('CoachHome');
    expect(app.where()).toBe('/coach/students');
    await givesUp();
    expect(app.shown).toEqual(['CoachHome']);
  });

  it('an account whose role this device never read waits on "/" — no login form — and opens when the network is back', async () => {
    signedInDaysAgo(ATHLETE);

    const app = coldStart();

    expect(await screen.findByText(/your account will open as soon as this device is back online/i)).toBeInTheDocument();
    await givesUp();
    expect(app.where()).toBe('/');
    expect(app.shown).toEqual([]);

    profileRow = { id: ATHLETE.id, role: 'student', full_name: 'Ada' };
    await act(async () => {
      deviceIs(true);
      window.dispatchEvent(new Event('online'));
    });

    expect(await screen.findByTestId('page')).toHaveTextContent('StudentTraining');
    expect(app.where()).toBe('/student');
    expect(app.shown).toEqual(['StudentTraining']);
  });

  it('a device nobody is signed in on shows the login page once auth-js has said so', async () => {
    supabase.auth.getSession.mockResolvedValue({ data: { session: null }, error: null });

    const app = coldStart();

    expect(await screen.findByTestId('page')).toHaveTextContent('LoginPage');
    expect(app.where()).toBe('/login');
  });
});
