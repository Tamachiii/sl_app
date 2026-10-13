import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRestTimerEffects } from './useRestTimerEffects';
import { startRestTimer, resetRestTimer } from './useRestTimer';

// Mocked browser APIs. jsdom has none of these.
let wakeLockRelease;
let wakeLockRequestCalls;
let vibrateCalls;
// Every oscillator the beep created in the current test. The module keeps
// the first AudioContext it built for the whole file, so the classes below
// report here rather than through the instance a test could reach.
let oscillators;

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
  oscillators = [];
  class FakeOscillator {
    constructor() {
      this.frequency = { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() };
      this.connect = vi.fn(() => this);
      // The category the phone is in at the moment the sound starts.
      this.start = vi.fn(() => {
        this.sessionTypeAtStart = navigator.audioSession?.type;
      });
      this.stop = vi.fn();
      oscillators.push(this);
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
  delete navigator.audioSession;
  delete window.AudioContext;
  // Restore the document title in case a test left a countdown there.
  document.title = '';
  // An own property set by a test shadows jsdom's getter ("visible") for
  // every test after it.
  delete document.visibilityState;
});

// The page as the browser reports it, and the event that goes with a change.
function setVisibility(value) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => value,
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

// A WakeLockSentinel as a browser hands it out: `released`, a `release`
// event, and `lost()` for what the browser does on its own when the page is
// hidden (it releases the lock and tells the listeners; nobody called
// `release()`).
function makeSentinel() {
  const listeners = new Set();
  const sentinel = {
    released: false,
    addEventListener: (type, fn) => {
      if (type === 'release') listeners.add(fn);
    },
    removeEventListener: (type, fn) => {
      if (type === 'release') listeners.delete(fn);
    },
    lost() {
      if (sentinel.released) return;
      sentinel.released = true;
      for (const fn of [...listeners]) fn();
    },
    release: vi.fn(() => {
      sentinel.lost();
      return Promise.resolve();
    }),
  };
  return sentinel;
}

// Every request answered with a sentinel of its own, kept in `sentinels`.
function wakeLockWithSentinels() {
  const sentinels = [];
  navigator.wakeLock = {
    request: vi.fn(() => {
      const sentinel = makeSentinel();
      sentinels.push(sentinel);
      return Promise.resolve(sentinel);
    }),
  };
  return sentinels;
}

// Requests that stay pending until the test settles them.
function wakeLockOnDemand() {
  const pending = [];
  navigator.wakeLock = {
    request: vi.fn(
      () =>
        new Promise((resolve, reject) => {
          pending.push({ resolve, reject });
        }),
    ),
  };
  return pending;
}

const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
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

describe('useRestTimerEffects: the wake lock after the app was in the background', () => {
  it('takes a new lock when the athlete comes back during the rest', async () => {
    const sentinels = wakeLockWithSentinels();
    renderHook(() => useRestTimerEffects());
    await act(async () => {
      startRestTimer('log-A', 120);
      await Promise.resolve();
    });
    expect(navigator.wakeLock.request).toHaveBeenCalledTimes(1);

    // A glance at the music app: the browser takes the lock away.
    await act(async () => {
      setVisibility('hidden');
      sentinels[0].lost();
    });
    expect(navigator.wakeLock.request).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(20_000);
      setVisibility('visible');
      await Promise.resolve();
    });
    expect(navigator.wakeLock.request).toHaveBeenCalledTimes(2);
    expect(sentinels[1].released).toBe(false);
  });

  it('takes a new lock each time, not only the first', async () => {
    const sentinels = wakeLockWithSentinels();
    renderHook(() => useRestTimerEffects());
    await act(async () => {
      startRestTimer('log-A', 300);
      await Promise.resolve();
    });
    for (let round = 0; round < 3; round += 1) {
      await act(async () => {
        setVisibility('hidden');
        sentinels[round].lost();
      });
      await act(async () => {
        setVisibility('visible');
        await Promise.resolve();
      });
    }
    expect(navigator.wakeLock.request).toHaveBeenCalledTimes(4);
    expect(sentinels.map((s) => s.released)).toEqual([true, true, true, false]);
  });

  it('goes by the sentinel that says it is released, where no event came', async () => {
    // The handle is all there is to go by when a browser releases without
    // firing `release`.
    const sentinel = { released: false, release: vi.fn(() => Promise.resolve()) };
    navigator.wakeLock = { request: vi.fn(() => Promise.resolve(sentinel)) };
    renderHook(() => useRestTimerEffects());
    await act(async () => {
      startRestTimer('log-A', 120);
      await Promise.resolve();
    });
    await act(async () => {
      setVisibility('hidden');
      sentinel.released = true;
    });
    await act(async () => {
      setVisibility('visible');
      await Promise.resolve();
    });
    expect(navigator.wakeLock.request).toHaveBeenCalledTimes(2);
  });

  it('asks for nothing while it still holds the lock', async () => {
    const sentinels = wakeLockWithSentinels();
    renderHook(() => useRestTimerEffects());
    await act(async () => {
      startRestTimer('log-A', 120);
      await Promise.resolve();
    });
    // A visibility event without a release (a browser that keeps the lock).
    await act(async () => {
      setVisibility('visible');
      await Promise.resolve();
    });
    expect(navigator.wakeLock.request).toHaveBeenCalledTimes(1);
    expect(sentinels[0].release).not.toHaveBeenCalled();
  });

  it('asks for nothing while the page is still hidden', async () => {
    const sentinels = wakeLockWithSentinels();
    renderHook(() => useRestTimerEffects());
    await act(async () => {
      startRestTimer('log-A', 120);
      await Promise.resolve();
    });
    await act(async () => {
      setVisibility('hidden');
      sentinels[0].lost();
      await Promise.resolve();
    });
    expect(navigator.wakeLock.request).toHaveBeenCalledTimes(1);
  });

  it('takes no lock when the athlete comes back after the rest is over', async () => {
    const sentinels = wakeLockWithSentinels();
    renderHook(() => useRestTimerEffects());
    await act(async () => {
      startRestTimer('log-A', 30);
      await Promise.resolve();
    });
    await act(async () => {
      setVisibility('hidden');
      sentinels[0].lost();
    });
    await act(async () => {
      vi.advanceTimersByTime(31_000);
      await Promise.resolve();
    });
    await act(async () => {
      setVisibility('visible');
      await Promise.resolve();
    });
    expect(navigator.wakeLock.request).toHaveBeenCalledTimes(1);
  });

  it('keeps one lock when the page is hidden and shown while a request is in flight', async () => {
    const pending = wakeLockOnDemand();
    const { unmount } = renderHook(() => useRestTimerEffects());
    await act(async () => {
      startRestTimer('log-A', 120);
    });
    expect(pending).toHaveLength(1);

    // Back before the first request is answered: nothing is held yet, so a
    // second one is sent.
    await act(async () => {
      setVisibility('hidden');
      setVisibility('visible');
    });
    expect(pending).toHaveLength(2);

    const first = makeSentinel();
    const second = makeSentinel();
    pending[0].resolve(first);
    await flush();
    pending[1].resolve(second);
    await flush();

    // The one that came second is given back at once; the first is the lock.
    expect(first.released).toBe(false);
    expect(second.released).toBe(true);

    // And the one that was kept is released with the timer, so nothing leaks.
    unmount();
    expect(first.released).toBe(true);
  });

  it('keeps the second lock when the first request was refused', async () => {
    const pending = wakeLockOnDemand();
    const { unmount } = renderHook(() => useRestTimerEffects());
    await act(async () => {
      startRestTimer('log-A', 120);
    });
    await act(async () => {
      setVisibility('hidden');
      setVisibility('visible');
    });
    // What a browser answers to a request made by a page that got hidden.
    pending[0].reject(new DOMException('The page is not visible', 'NotAllowedError'));
    await flush();
    const second = makeSentinel();
    pending[1].resolve(second);
    await flush();
    expect(second.released).toBe(false);
    unmount();
    expect(second.released).toBe(true);
  });

  it('releases the new lock when the rest ends', async () => {
    const sentinels = wakeLockWithSentinels();
    renderHook(() => useRestTimerEffects());
    await act(async () => {
      startRestTimer('log-A', 60);
      await Promise.resolve();
    });
    await act(async () => {
      setVisibility('hidden');
      sentinels[0].lost();
    });
    await act(async () => {
      vi.advanceTimersByTime(10_000);
      setVisibility('visible');
      await Promise.resolve();
    });
    expect(sentinels[1].released).toBe(false);
    await act(async () => {
      vi.advanceTimersByTime(50_000);
      await Promise.resolve();
    });
    expect(sentinels[1].released).toBe(true);
    expect(sentinels[1].release).toHaveBeenCalledTimes(1);
  });
});

describe('useRestTimerEffects: the beep and the ring/silent switch (navigator.audioSession)', () => {
  // The beep lasts 0.6 s and waits 0.25 s for a category it had changed; the
  // category is held 0.25 s longer than the beep.
  const HELD_MS = 1_100;

  // A session that counts what is written to it.
  function countingSession(initial) {
    let type = initial;
    const writes = [];
    return {
      writes,
      get type() {
        return type;
      },
      set type(value) {
        writes.push(value);
        type = value;
      },
    };
  }

  async function restOf(seconds) {
    const view = renderHook(() => useRestTimerEffects());
    await act(async () => {
      startRestTimer('log-A', seconds);
      await Promise.resolve();
    });
    return view;
  }

  const advance = (ms) =>
    act(async () => {
      vi.advanceTimersByTime(ms);
      await Promise.resolve();
    });

  it('plays the beep in the playback category, where the browser has one', async () => {
    navigator.audioSession = { type: 'auto' };
    await restOf(30);
    await advance(30_000);
    expect(oscillators).toHaveLength(1);
    expect(oscillators[0].start).toHaveBeenCalledTimes(1);
    expect(oscillators[0].sessionTypeAtStart).toBe('playback');
  });

  it('starts the beep a moment later, so the new category is in place', async () => {
    navigator.audioSession = { type: 'auto' };
    await restOf(30);
    await advance(30_000);
    // The fake context's clock stands at 0.
    expect(oscillators[0].start).toHaveBeenCalledWith(0.25);
    expect(oscillators[0].stop).toHaveBeenCalledWith(0.25 + 0.6);
  });

  it('gives the category back once the beep is over', async () => {
    navigator.audioSession = countingSession('auto');
    await restOf(30);
    await advance(30_000);
    expect(navigator.audioSession.type).toBe('playback');
    await advance(HELD_MS - 1);
    expect(navigator.audioSession.type).toBe('playback');
    await advance(1);
    expect(navigator.audioSession.type).toBe('auto');
    expect(navigator.audioSession.writes).toEqual(['playback', 'auto']);
  });

  it('gives back the category it found, whatever it was', async () => {
    navigator.audioSession = { type: 'ambient' };
    await restOf(30);
    await advance(30_000);
    expect(navigator.audioSession.type).toBe('playback');
    await advance(HELD_MS);
    expect(navigator.audioSession.type).toBe('ambient');
  });

  it('gives it back when the session screen was left right after the beep', async () => {
    const session = { type: 'auto' };
    navigator.audioSession = session;
    const { unmount } = await restOf(30);
    await advance(30_000);
    unmount();
    await advance(HELD_MS);
    expect(session.type).toBe('auto');
  });

  it('leaves the category alone until the rest ends', async () => {
    // 'playback' takes the phone's audio from the athlete's music: it is not
    // taken on a tap, at the start of a rest or during it.
    navigator.audioSession = countingSession('auto');
    await act(async () => {
      window.dispatchEvent(new Event('pointerdown'));
      window.dispatchEvent(new Event('touchstart'));
    });
    await restOf(30);
    await advance(29_999);
    expect(navigator.audioSession.writes).toEqual([]);
    await advance(1);
    expect(navigator.audioSession.writes).toEqual(['playback']);
  });

  it('takes it again for the next rest', async () => {
    navigator.audioSession = countingSession('auto');
    await restOf(30);
    await advance(30_000 + HELD_MS);
    await act(async () => {
      startRestTimer('log-B', 45);
      await Promise.resolve();
    });
    await advance(45_000);
    expect(oscillators).toHaveLength(2);
    expect(oscillators[1].sessionTypeAtStart).toBe('playback');
    await advance(HELD_MS);
    expect(navigator.audioSession.writes).toEqual(['playback', 'auto', 'playback', 'auto']);
  });

  it('writes nothing to a session that is already in playback', async () => {
    navigator.audioSession = countingSession('playback');
    await restOf(30);
    await advance(30_000);
    expect(oscillators[0].start).toHaveBeenCalledWith(0);
    await advance(HELD_MS);
    expect(navigator.audioSession.writes).toEqual([]);
    expect(navigator.audioSession.type).toBe('playback');
  });

  it('does not put back a category somebody else chose in the meantime', async () => {
    navigator.audioSession = { type: 'auto' };
    await restOf(30);
    await advance(30_000);
    navigator.audioSession.type = 'play-and-record';
    await advance(HELD_MS);
    expect(navigator.audioSession.type).toBe('play-and-record');
  });

  it('creates no audioSession where the browser has none', async () => {
    expect('audioSession' in navigator).toBe(false);
    await restOf(30);
    await advance(30_000);
    expect('audioSession' in navigator).toBe(false);
    // The beep and the buzz are what they were: at once.
    expect(oscillators).toHaveLength(1);
    expect(oscillators[0].start).toHaveBeenCalledWith(0);
    expect(oscillators[0].stop).toHaveBeenCalledWith(0.6);
    expect(vibrateCalls.length).toBe(1);
    await advance(HELD_MS);
    expect('audioSession' in navigator).toBe(false);
  });

  it('still beeps and buzzes when the session refuses the category', async () => {
    navigator.audioSession = {
      get type() {
        return 'auto';
      },
      set type(_value) {
        throw new DOMException('Not allowed', 'InvalidStateError');
      },
    };
    await restOf(30);
    await advance(30_000);
    expect(oscillators).toHaveLength(1);
    expect(oscillators[0].start).toHaveBeenCalledWith(0);
    expect(vibrateCalls.length).toBe(1);
    await advance(HELD_MS);
  });

  it('does not wait for a category the browser ignored', async () => {
    // An enum the browser does not know is dropped without an error.
    const session = {
      writes: [],
      get type() {
        return 'auto';
      },
      set type(value) {
        session.writes.push(value);
      },
    };
    navigator.audioSession = session;
    await restOf(30);
    await advance(30_000);
    expect(oscillators[0].start).toHaveBeenCalledWith(0);
    await advance(HELD_MS);
    expect(session.writes).toEqual(['playback']);
  });

  it('still beeps and buzzes when reading the session throws', async () => {
    Object.defineProperty(navigator, 'audioSession', {
      configurable: true,
      get() {
        throw new DOMException('The operation is insecure', 'SecurityError');
      },
    });
    await restOf(30);
    await advance(30_000);
    expect(oscillators).toHaveLength(1);
    expect(oscillators[0].start).toHaveBeenCalledWith(0);
    expect(vibrateCalls.length).toBe(1);
  });
});
