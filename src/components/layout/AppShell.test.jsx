import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Link } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { createTestQueryClient } from '../../test/utils';
import { startRestTimer, resetRestTimer } from '../../hooks/useRestTimer';
import AppShell from './AppShell';

vi.mock('./BottomNav', () => ({ default: () => <nav data-testid="bottom-nav" /> }));
vi.mock('./SideNav', () => ({ default: () => <nav data-testid="side-nav" /> }));
vi.mock('../ui/OfflineBanner', () => ({ default: () => null }));
vi.mock('../ui/ToastHost', () => ({ default: () => <div data-testid="toast-host" /> }));
vi.mock('../ui/UpdatePrompt', () => ({ default: () => <div data-testid="update-prompt" /> }));
vi.mock('../../hooks/useMessages', () => ({ useMessagesRealtime: vi.fn() }));
vi.mock('../../hooks/useNotifications', () => ({ useNotificationsRealtime: vi.fn() }));
vi.mock('../../lib/offlineMutations', () => ({ resumeMutationsAndReconcileDrafts: vi.fn() }));

// Who is signed in: the shell mounts the rest timer's host for a student only.
const auth = vi.hoisted(() => ({ current: { user: { id: 'u-1' }, role: 'student' } }));
vi.mock('../../hooks/useAuth', () => ({ useAuth: () => auth.current }));

// The push bridge reaches for Supabase; in its place, a hook keyed the same
// way (on the rest's end) that writes down what the real one would schedule
// and cancel. The wake lock and the beep run for real (useRestTimerEffects).
const pushLog = vi.hoisted(() => []);
vi.mock('../../hooks/useRestTimerPush', async () => {
  const { useEffect } = await import('react');
  const { useRestTimer } = await import('../../hooks/useRestTimer');
  return {
    useRestTimerPush: () => {
      const { endsAt } = useRestTimer();
      useEffect(() => {
        if (endsAt == null) return undefined;
        pushLog.push(`schedule ${endsAt}`);
        return () => pushLog.push(`cancel ${endsAt}`);
      }, [endsAt]);
    },
  };
});

beforeAll(() => {
  // jsdom has no element scrolling; the shell resets it on every route.
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {};
});

describe('<AppShell />', () => {
  it('mounts the update prompt on every signed-in page, under the toasts', () => {
    render(
      <QueryClientProvider client={createTestQueryClient()}>
        <MemoryRouter initialEntries={['/student']}>
          <AppShell />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const prompt = screen.getByTestId('update-prompt');
    const toasts = screen.getByTestId('toast-host');
    // Later in the document = drawn on top at the same z-index: an error toast
    // covers the offer for its six seconds, never the other way round.
    expect(prompt.compareDocumentPosition(toasts) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it.each([
    ['/student', true],
    ['/student/stats', true],
    ['/student/session/s-1', false],
    ['/coach/students', true],
    ['/coach/sessions', true],
    ['/coach/students/st-1/s/sess-1', true],
    ['/coach/student/st-1/session/sess-1/review', false],
    ['/coach/student/st-1/session/sess-1/review/', false],
    ['/coach/messages', true],
    ['/coach/messages/p-1', false],
    ['/student/messages', true],
  ])('on %s, shows the tab bar: %s (the session, the review and a conversation have their bar instead)', (path, shown) => {
    render(
      <QueryClientProvider client={createTestQueryClient()}>
        <MemoryRouter initialEntries={[path]}>
          <AppShell />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.queryByTestId('bottom-nav') !== null).toBe(shown);
  });
});

// B34. The beep, the wake lock and the push of a rest were mounted by the
// session page: a look at another tab in the middle of a rest cancelled the
// push and the beep, while the countdown ran on.
describe('<AppShell />: the rest timer outlives a change of tab', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetRestTimer();
    pushLog.length = 0;
    navigator.vibrate = vi.fn(() => true);
  });

  afterEach(() => {
    resetRestTimer();
    vi.useRealTimers();
    delete navigator.vibrate;
    auth.current = { user: { id: 'u-1' }, role: 'student' };
  });

  function renderShell() {
    return render(
      <QueryClientProvider client={createTestQueryClient()}>
        <MemoryRouter initialEntries={['/student/session/s-1']}>
          <Routes>
            <Route element={<AppShell />}>
              <Route path="/student/session/:sessionId" element={<Link to="/student/stats">Stats</Link>} />
              <Route path="/student/stats" element={<Link to="/student">Training</Link>} />
              <Route path="/student" element={<p>Training list</p>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it('keeps the push and the beep of a rest while the athlete goes from tab to tab', () => {
    renderShell();
    act(() => {
      startRestTimer('log-A', 60);
    });
    expect(pushLog).toHaveLength(1);
    const [scheduled] = pushLog;

    fireEvent.click(screen.getByRole('link', { name: 'Stats' }));
    fireEvent.click(screen.getByRole('link', { name: 'Training' }));
    expect(screen.getByText('Training list')).toBeInTheDocument();

    // Scheduled once, never cancelled by the two changes of page.
    expect(pushLog).toEqual([scheduled]);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(navigator.vibrate).toHaveBeenCalledTimes(1);
  });

  it('takes the push back when the athlete signs out (the shell goes away)', () => {
    const { unmount } = renderShell();
    act(() => {
      startRestTimer('log-A', 60);
    });
    const [scheduled] = pushLog;
    unmount();
    expect(pushLog).toEqual([scheduled, scheduled.replace('schedule', 'cancel')]);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(navigator.vibrate).not.toHaveBeenCalled();
  });

  it('runs nothing for a coach', () => {
    auth.current = { user: { id: 'c-1' }, role: 'coach' };
    renderShell();
    act(() => {
      startRestTimer('log-A', 60);
    });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(pushLog).toEqual([]);
    expect(navigator.vibrate).not.toHaveBeenCalled();
  });
});
