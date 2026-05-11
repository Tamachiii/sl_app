import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRestTimerEffects } from './useRestTimerEffects';
import { startRestTimer, resetRestTimer } from './useRestTimer';

// Mocked browser APIs. jsdom has none of these.
let wakeLockRelease;
let wakeLockRequestCalls;
let vibrateCalls;

beforeEach(() => {
  vi.useFakeTimers();
  resetRestTimer();

  wakeLockRelease = vi.fn(() => Promise.resolve());
  wakeLockRequestCalls = 0;
  navigator.wakeLock = {
    request: vi.fn(() => {
      wakeLockRequestCalls += 1;
      return Promise.resolve({ release: wakeLockRelease });
    }),
  };

  vibrateCalls = [];
  navigator.vibrate = vi.fn((pattern) => {
    vibrateCalls.push(pattern);
    return true;
  });

  // Minimal AudioContext mock so playBeep doesn't throw.
  class FakeOscillator {
    constructor() {
      this.frequency = { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() };
      this.connect = vi.fn(() => this);
      this.start = vi.fn();
      this.stop = vi.fn();
    }
  }
  class FakeGain {
    constructor() {
      this.gain = { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() };
      this.connect = vi.fn(() => this);
    }
  }
  window.AudioContext = class FakeAC {
    constructor() {
      this.state = 'running';
      this.currentTime = 0;
      this.destination = {};
    }
    createOscillator() { return new FakeOscillator(); }
    createGain() { return new FakeGain(); }
    resume() { this.state = 'running'; return Promise.resolve(); }
  };
});

afterEach(() => {
  resetRestTimer();
  vi.useRealTimers();
  delete navigator.wakeLock;
  delete navigator.vibrate;
  delete window.AudioContext;
  // Restore the document title in case a test left a countdown there.
  document.title = '';
});

describe('useRestTimerEffects', () => {
  it('requests a wake lock when a timer starts', async () => {
    renderHook(() => useRestTimerEffects());
    await act(async () => {
      startRestTimer('log-A', 60);
      // Let the wake-lock promise resolve.
      await Promise.resolve();
    });
    expect(wakeLockRequestCalls).toBe(1);
  });

  it('fires vibrate at endsAt', async () => {
    renderHook(() => useRestTimerEffects());
    await act(async () => {
      startRestTimer('log-A', 30);
      await Promise.resolve();
    });
    expect(vibrateCalls.length).toBe(0);
    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
    });
    expect(vibrateCalls.length).toBe(1);
  });

  it('releases the wake lock when the timer expires', async () => {
    renderHook(() => useRestTimerEffects());
    await act(async () => {
      startRestTimer('log-A', 30);
      // Let the request resolve so wakeLock is captured.
      await Promise.resolve();
    });
    expect(wakeLockRelease).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
    });
    expect(wakeLockRelease).toHaveBeenCalled();
  });

  it('cancels the pending cue when a new timer replaces the old one', async () => {
    renderHook(() => useRestTimerEffects());
    await act(async () => {
      startRestTimer('log-A', 30);
      await Promise.resolve();
    });
    await act(async () => {
      // Replace with a longer timer well before the first one would have fired.
      vi.advanceTimersByTime(5_000);
      startRestTimer('log-B', 120);
      await Promise.resolve();
    });
    // Advance to where the first timer would have fired had it not been replaced.
    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
    });
    // No vibrate yet — the first timer's cue was cancelled.
    expect(vibrateCalls.length).toBe(0);
    // Finish the new timer.
    await act(async () => {
      vi.advanceTimersByTime(120_000);
      await Promise.resolve();
    });
    expect(vibrateCalls.length).toBe(1);
  });

  it('mirrors remaining time into document.title while the page is hidden', async () => {
    document.title = 'SL Coach';
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    renderHook(() => useRestTimerEffects());
    await act(async () => {
      startRestTimer('log-A', 60);
      await Promise.resolve();
    });
    expect(document.title).toMatch(/^Rest \d+:\d{2} · SL Coach$/);
    await act(async () => {
      vi.advanceTimersByTime(60_000);
      await Promise.resolve();
    });
    expect(document.title).toBe('Rest done · SL Coach');
  });

  it('restores the original title on cleanup', async () => {
    document.title = 'SL Coach';
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    const { unmount } = renderHook(() => useRestTimerEffects());
    await act(async () => {
      startRestTimer('log-A', 60);
      await Promise.resolve();
    });
    expect(document.title).not.toBe('SL Coach');
    unmount();
    expect(document.title).toBe('SL Coach');
  });
});
