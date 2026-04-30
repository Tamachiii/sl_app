import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import RestTimerBanner from './RestTimerBanner';
import { startRestTimer, resetRestTimer } from '../../hooks/useRestTimer';

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
