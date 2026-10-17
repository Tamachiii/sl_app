import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  useRestTimer,
  startRestTimer,
  clearRestTimer,
  extendRestTimer,
  resetRestTimer,
} from './useRestTimer';

// The consumers (RestTimerHost, useRestTimerEffects) each derive remaining
// time inline because they need the SIGNED remainder for their flash/expiry
// windows. This clamped, logId-guarded read is what the store's contract
// promises, so the tests keep their own copy rather than the source exporting
// one nobody calls.
function remainingSecondsFor(snapshot, logId) {
  if (!snapshot || snapshot.logId !== logId || snapshot.endsAt == null) return null;
  return Math.max(0, Math.ceil((snapshot.endsAt - Date.now()) / 1000));
}

// The key the store writes under. Spelled out here on purpose: a rename
// orphans the rest that is running on every phone at the time of the update.
const STORAGE_KEY = 'sl_rest_timer';
const stored = () => JSON.parse(localStorage.getItem(STORAGE_KEY));

// The app after a kill: a module registry with nothing in it, and whatever
// localStorage still holds. The copies are kept so that their tickers are
// stopped with the test.
const relaunched = [];
async function relaunch() {
  vi.resetModules();
  const mod = await import('./useRestTimer');
  relaunched.push(mod);
  return mod;
}

beforeEach(() => {
  resetRestTimer();
  vi.useFakeTimers();
});

afterEach(() => {
  resetRestTimer();
  for (const mod of relaunched.splice(0)) mod.resetRestTimer();
  vi.restoreAllMocks();
  localStorage.clear();
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

// "+30 s" on the rest that is running (L34).
describe('useRestTimer: extendRestTimer', () => {
  it('moves the end of the running rest, and stores the new end', () => {
    const { result } = renderHook(() => useRestTimer());
    act(() => {
      startRestTimer('log-A', 60);
    });
    const before = result.current.endsAt;
    act(() => {
      extendRestTimer('log-A', 30);
    });
    expect(result.current.logId).toBe('log-A');
    expect(result.current.endsAt).toBe(before + 30_000);
    expect(stored()).toEqual({ logId: 'log-A', endsAt: before + 30_000 });
  });

  it('leaves the rest of another set alone', () => {
    const { result } = renderHook(() => useRestTimer());
    act(() => {
      startRestTimer('log-B', 60);
    });
    const before = result.current.endsAt;
    act(() => {
      extendRestTimer('log-A', 30);
    });
    expect(result.current.endsAt).toBe(before);
    expect(stored().endsAt).toBe(before);
  });

  it('does not bring back a rest that has ended, or start one where there is none', () => {
    const { result } = renderHook(() => useRestTimer());
    act(() => {
      extendRestTimer('log-A', 30);
    });
    expect(result.current.endsAt).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();

    act(() => {
      startRestTimer('log-A', 30);
    });
    const ended = result.current.endsAt;
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    act(() => {
      extendRestTimer('log-A', 30);
    });
    expect(result.current.endsAt).toBe(ended);
  });

  it('ignores zero or missing seconds', () => {
    const { result } = renderHook(() => useRestTimer());
    act(() => {
      startRestTimer('log-A', 60);
    });
    const before = result.current.endsAt;
    act(() => {
      extendRestTimer('log-A', 0);
      extendRestTimer('log-A');
      extendRestTimer('log-A', -30);
    });
    expect(result.current.endsAt).toBe(before);
  });
});

describe('useRestTimer: the timer is kept in localStorage', () => {
  it('writes a started timer with its log and its end time', () => {
    vi.setSystemTime(new Date('2026-10-13T10:00:00Z'));
    startRestTimer('log-A', 90);
    expect(stored()).toEqual({ logId: 'log-A', endsAt: Date.now() + 90_000 });
  });

  it('writes what the hook returns', () => {
    const { result } = renderHook(() => useRestTimer());
    act(() => {
      startRestTimer('log-A', 90);
    });
    expect(stored()).toEqual({ logId: result.current.logId, endsAt: result.current.endsAt });
  });

  it('replaces the stored timer when a new set starts another rest', () => {
    vi.setSystemTime(new Date('2026-10-13T10:00:00Z'));
    startRestTimer('log-A', 90);
    vi.setSystemTime(new Date('2026-10-13T10:00:30Z'));
    startRestTimer('log-B', 120);
    expect(stored()).toEqual({ logId: 'log-B', endsAt: Date.now() + 120_000 });
  });

  it('removes it when the running timer is cleared', () => {
    startRestTimer('log-A', 90);
    clearRestTimer('log-A');
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('leaves it when the timer of another set is cleared', () => {
    startRestTimer('log-B', 90);
    const before = localStorage.getItem(STORAGE_KEY);
    clearRestTimer('log-A');
    expect(localStorage.getItem(STORAGE_KEY)).toBe(before);
  });

  it('removes it on reset', () => {
    startRestTimer('log-A', 90);
    resetRestTimer();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('stores nothing for a timer that is refused', () => {
    startRestTimer('log-A', 0);
    startRestTimer(null, 60);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('is not written by the ticker', () => {
    const { result } = renderHook(() => useRestTimer());
    act(() => {
      startRestTimer('log-A', 60);
    });
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem');
    const v1 = result.current.version;
    // Through the rest, its end, and the five seconds the ticker lives on.
    act(() => {
      vi.advanceTimersByTime(70_000);
    });
    expect(result.current.version).toBeGreaterThan(v1);
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
  });

  it('starts the timer when storage refuses the write', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('The quota has been exceeded', 'QuotaExceededError');
    });
    const { result } = renderHook(() => useRestTimer());
    expect(() => {
      act(() => {
        startRestTimer('log-A', 60);
      });
    }).not.toThrow();
    expect(result.current.logId).toBe('log-A');
    expect(result.current.endsAt).toBeGreaterThan(Date.now());
  });

  it('clears the timer when storage refuses the removal', () => {
    const { result } = renderHook(() => useRestTimer());
    act(() => {
      startRestTimer('log-A', 60);
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure', 'SecurityError');
    });
    expect(() => {
      act(() => {
        clearRestTimer('log-A');
      });
    }).not.toThrow();
    expect(result.current.logId).toBeNull();
    expect(result.current.endsAt).toBeNull();
  });
});

describe('useRestTimer: the app is killed and opened again', () => {
  const NOW = new Date('2026-10-13T10:00:00Z');

  beforeEach(() => {
    vi.setSystemTime(NOW);
  });

  it('finds the rest that was running, with the time it has left', async () => {
    startRestTimer('log-A', 180);
    const endsAt = Date.now() + 180_000;

    // Forty seconds in the Camera app, during which iOS drops the PWA.
    vi.setSystemTime(new Date(NOW.getTime() + 40_000));
    const app = await relaunch();

    const { result } = renderHook(() => app.useRestTimer());
    expect(result.current.logId).toBe('log-A');
    expect(result.current.endsAt).toBe(endsAt);
    expect(remainingSecondsFor(result.current, 'log-A')).toBe(140);
    // Still there for the launch after this one.
    expect(stored()).toEqual({ logId: 'log-A', endsAt });
  });

  it('counts the restored rest down without a new set being validated', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ logId: 'log-A', endsAt: Date.now() + 60_000 }));
    const app = await relaunch();
    const { result } = renderHook(() => app.useRestTimer());
    const v1 = result.current.version;
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(result.current.version).toBeGreaterThanOrEqual(v1 + 3);
    expect(remainingSecondsFor(result.current, 'log-A')).toBe(57);
  });

  it('lets the restored rest be cleared by its set and replaced by the next one', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ logId: 'log-A', endsAt: Date.now() + 60_000 }));
    const app = await relaunch();
    const { result } = renderHook(() => app.useRestTimer());

    act(() => {
      app.clearRestTimer('log-B');
    });
    expect(result.current.logId).toBe('log-A');

    act(() => {
      app.startRestTimer('log-B', 90);
    });
    expect(result.current.logId).toBe('log-B');
    expect(stored()).toEqual({ logId: 'log-B', endsAt: Date.now() + 90_000 });

    act(() => {
      app.clearRestTimer('log-B');
    });
    expect(result.current.logId).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('starts with no timer when nothing was running', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const app = await relaunch();
    const { result } = renderHook(() => app.useRestTimer());
    expect(result.current).toEqual({ logId: null, endsAt: null, version: 0 });
    expect(setItem).not.toHaveBeenCalled();
  });

  it.each([
    ['a rest that ended while the app was gone', () => JSON.stringify({ logId: 'log-A', endsAt: Date.now() - 1 })],
    ['a rest that ends this very millisecond', () => JSON.stringify({ logId: 'log-A', endsAt: Date.now() })],
    ['a rest that ended yesterday', () => JSON.stringify({ logId: 'log-A', endsAt: Date.now() - 86_400_000 })],
    ['text that is not JSON', () => '{"logId":"log-A","endsAt":'],
    ['an empty string', () => ''],
    ['no log', () => JSON.stringify({ endsAt: Date.now() + 60_000 })],
    ['an empty log id', () => JSON.stringify({ logId: '', endsAt: Date.now() + 60_000 })],
    ['a log id that is not a string', () => JSON.stringify({ logId: 42, endsAt: Date.now() + 60_000 })],
    ['no end time', () => JSON.stringify({ logId: 'log-A' })],
    ['an end time that is a string', () => JSON.stringify({ logId: 'log-A', endsAt: String(Date.now() + 60_000) })],
    ['an end time that is null', () => JSON.stringify({ logId: 'log-A', endsAt: null })],
    ['a null', () => 'null'],
    ['a number', () => String(Date.now() + 60_000)],
    ['a list', () => JSON.stringify(['log-A', Date.now() + 60_000])],
  ])('discards %s', async (_what, value) => {
    localStorage.setItem(STORAGE_KEY, value());
    const app = await relaunch();
    const { result } = renderHook(() => app.useRestTimer());
    expect(result.current).toEqual({ logId: null, endsAt: null, version: 0 });
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    // And nothing ticks for a timer that is not there.
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(result.current.version).toBe(0);
  });

  it('starts with no timer when storage cannot be read', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ logId: 'log-A', endsAt: Date.now() + 60_000 }));
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure', 'SecurityError');
    });
    const app = await relaunch();
    const { result } = renderHook(() => app.useRestTimer());
    expect(result.current.logId).toBeNull();
    // And the app still runs a timer from there.
    act(() => {
      app.startRestTimer('log-B', 30);
    });
    expect(result.current.logId).toBe('log-B');
  });

  it('starts with no timer when a stale one cannot be removed', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ logId: 'log-A', endsAt: Date.now() - 1 }));
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure', 'SecurityError');
    });
    const app = await relaunch();
    const { result } = renderHook(() => app.useRestTimer());
    expect(result.current.logId).toBeNull();
    expect(result.current.endsAt).toBeNull();
  });
});
