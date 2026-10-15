import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, fireEvent, renderHook } from '@testing-library/react';
import RestTimerBanner from './RestTimerBanner';
import { startRestTimer, resetRestTimer, useRestTimer } from '../../hooks/useRestTimer';

beforeEach(() => {
  resetRestTimer();
  vi.useFakeTimers();
});

afterEach(() => {
  resetRestTimer();
  vi.useRealTimers();
});

describe('RestTimerBanner', () => {
  it('renders nothing when no timer is active', () => {
    const { container } = render(<RestTimerBanner />);
    expect(container.firstChild).toBeNull();
  });

  // P44. Its text changes every second: as a live region it was read aloud
  // every second. RestTimerHost's status region says the start and the end.
  it('is not a live region, running or done', () => {
    const { container } = render(<RestTimerBanner />);
    act(() => {
      startRestTimer('log-A', 30);
    });
    const live = '[aria-live], [role="status"], [role="alert"], [role="timer"]';
    // No name that holds the time left either: the label of the old live
    // region ("Rest remaining 30 seconds") changed every second.
    const timedNames = () =>
      [...container.querySelectorAll('[aria-label]')]
        .map((el) => el.getAttribute('aria-label'))
        .filter((name) => /\d+ seconds|\d:\d\d|remaining/i.test(name) && !/^Add 30 seconds/.test(name));
    expect(container.querySelector(live)).toBeNull();
    expect(timedNames()).toEqual([]);
    act(() => {
      vi.setSystemTime(new Date(Date.now() + 30_000));
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText('Rest done')).toBeInTheDocument();
    expect(container.querySelector(live)).toBeNull();
    expect(timedNames()).toEqual([]);
  });

  it('renders the running timer mm:ss while active', () => {
    render(<RestTimerBanner />);
    act(() => {
      startRestTimer('log-A', 90);
    });
    expect(screen.getByText('Rest')).toBeInTheDocument();
    expect(screen.getByText(/^1:30$|^1:29$/)).toBeInTheDocument();
  });

  it('shows the "Rest done" flash once the timer expires', () => {
    render(<RestTimerBanner />);
    act(() => {
      startRestTimer('log-A', 30);
    });
    act(() => {
      vi.setSystemTime(new Date(Date.now() + 30_000));
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText('Rest done')).toBeInTheDocument();
  });

  it('auto-hides ~5s after expiry', () => {
    const { container } = render(<RestTimerBanner />);
    act(() => {
      startRestTimer('log-A', 30);
    });
    // Jump to 6s past expiry (well past the 5s grace window).
    act(() => {
      vi.setSystemTime(new Date(Date.now() + 36_000));
      vi.advanceTimersByTime(1000);
    });
    expect(container.firstChild).toBeNull();
  });

  it('uses wall-clock arithmetic so the displayed value tracks Date.now() (not a tick counter)', () => {
    render(<RestTimerBanner />);
    act(() => {
      startRestTimer('log-A', 60);
    });
    // Initial render shows ~1:00.
    expect(screen.getByText(/^1:00$|^0:59$/)).toBeInTheDocument();
    // Simulate the tab being backgrounded for 30s with no timer ticks firing,
    // then a single tick when foregrounded again. The banner should still
    // read ~30 seconds remaining because it's a Date.now() diff.
    act(() => {
      vi.setSystemTime(new Date(Date.now() + 30_000));
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText(/^0:29$|^0:30$/)).toBeInTheDocument();
  });
});

// L34. The rest could only be waited out: a rest that was too short or too
// long for the set just done had no control.
describe('RestTimerBanner: Skip and +30 s', () => {
  const STORAGE_KEY = 'sl_rest_timer';
  const stored = () => JSON.parse(localStorage.getItem(STORAGE_KEY));
  const skip = () => screen.queryByRole('button', { name: 'Skip rest' });
  const more = () => screen.queryByRole('button', { name: 'Add 30 seconds of rest' });

  afterEach(() => {
    localStorage.clear();
  });

  it('Skip ends the running rest, in memory and in storage', () => {
    const { container } = render(<RestTimerBanner />);
    const { result } = renderHook(() => useRestTimer());
    act(() => {
      startRestTimer('log-A', 90);
    });
    fireEvent.click(skip());
    expect(result.current.endsAt).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(container.firstChild).toBeNull();
  });

  it('+30 s moves the end of the rest 30 s later, in memory and in storage', () => {
    render(<RestTimerBanner />);
    const { result } = renderHook(() => useRestTimer());
    act(() => {
      startRestTimer('log-A', 90);
    });
    const before = result.current.endsAt;
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.getByText('1:20')).toBeInTheDocument();

    fireEvent.click(more());
    expect(result.current.logId).toBe('log-A');
    expect(result.current.endsAt).toBe(before + 30_000);
    expect(stored()).toEqual({ logId: 'log-A', endsAt: before + 30_000 });
    expect(screen.getByText('1:50')).toBeInTheDocument();

    fireEvent.click(more());
    expect(result.current.endsAt).toBe(before + 60_000);
  });

  it('draws both as 44 px pills', () => {
    render(<RestTimerBanner />);
    act(() => {
      startRestTimer('log-A', 90);
    });
    for (const button of [skip(), more()]) {
      expect(button).toHaveClass('sl-pill', 'sl-pill-btn');
    }
  });

  it('offers neither once the rest is done', () => {
    render(<RestTimerBanner />);
    act(() => {
      startRestTimer('log-A', 30);
    });
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(screen.getByText('Rest done')).toBeInTheDocument();
    expect(skip()).toBeNull();
    expect(more()).toBeNull();
  });
});
