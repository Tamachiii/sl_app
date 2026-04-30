import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  useRestTimer,
  startRestTimer,
  clearRestTimer,
  resetRestTimer,
  remainingSecondsFor,
} from './useRestTimer';

beforeEach(() => {
  resetRestTimer();
  vi.useFakeTimers();
});

afterEach(() => {
  resetRestTimer();
  vi.useRealTimers();
});

describe('useRestTimer', () => {
  it('starts with no active timer', () => {
    const { result } = renderHook(() => useRestTimer());
    expect(result.current.logId).toBeNull();
    expect(result.current.endsAt).toBeNull();
  });

  it('startRestTimer activates a timer for the given log', () => {
    const { result } = renderHook(() => useRestTimer());
    act(() => {
      startRestTimer('log-A', 60);
    });
    expect(result.current.logId).toBe('log-A');
    expect(result.current.endsAt).toBeGreaterThan(Date.now());
  });

  it('starting a second timer replaces the first (no concurrent timers)', () => {
    const { result } = renderHook(() => useRestTimer());
    act(() => {
      startRestTimer('log-A', 60);
    });
    act(() => {
      startRestTimer('log-B', 90);
    });
    expect(result.current.logId).toBe('log-B');
    // log-A's snapshot view should report null remaining now.
    expect(remainingSecondsFor(result.current, 'log-A')).toBeNull();
    // log-B should report ~90 seconds remaining.
    expect(remainingSecondsFor(result.current, 'log-B')).toBeGreaterThan(85);
    expect(remainingSecondsFor(result.current, 'log-B')).toBeLessThanOrEqual(90);
  });

  it('remaining time is computed from wall-clock, not a tick counter', () => {
    const { result } = renderHook(() => useRestTimer());
    act(() => {
      startRestTimer('log-A', 60);
    });
    // Simulate the tab being backgrounded for 20 seconds during which no
    // setInterval ticks fire (mobile throttling). We advance the clock but
    // do NOT advance fake timers — the remaining read should still reflect
    // ~40s because it's a Date.now() diff, not a tick countdown.
    const before = remainingSecondsFor(result.current, 'log-A');
    act(() => {
      vi.setSystemTime(new Date(Date.now() + 20_000));
    });
    const after = remainingSecondsFor(result.current, 'log-A');
    expect(before).toBeGreaterThan(after);
    expect(after).toBeGreaterThan(35);
    expect(after).toBeLessThanOrEqual(40);
  });

  it('remaining clamps to 0 once endsAt is past', () => {
    const { result } = renderHook(() => useRestTimer());
    act(() => {
      startRestTimer('log-A', 30);
    });
    act(() => {
      vi.setSystemTime(new Date(Date.now() + 60_000));
    });
    expect(remainingSecondsFor(result.current, 'log-A')).toBe(0);
  });

  it('clearRestTimer only clears when the active timer matches', () => {
    const { result } = renderHook(() => useRestTimer());
    act(() => {
      startRestTimer('log-B', 60);
    });
    // Stale undo on a previous set must NOT kill the active rest.
    act(() => {
      clearRestTimer('log-A');
    });
    expect(result.current.logId).toBe('log-B');

    // Clearing the matching log empties state.
    act(() => {
      clearRestTimer('log-B');
    });
    expect(result.current.logId).toBeNull();
  });

  it('startRestTimer ignores zero or missing seconds', () => {
    const { result } = renderHook(() => useRestTimer());
    act(() => {
      startRestTimer('log-A', 0);
    });
    expect(result.current.logId).toBeNull();
    act(() => {
      startRestTimer('log-A', null);
    });
    expect(result.current.logId).toBeNull();
  });

  it('1s ticker emits to subscribers so the view re-renders', () => {
    const { result } = renderHook(() => useRestTimer());
    act(() => {
      startRestTimer('log-A', 60);
    });
    const v1 = result.current.version;
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(result.current.version).toBeGreaterThan(v1);
  });
});
