import { useSyncExternalStore } from 'react';

// Module-level singleton: only one rest timer is ever active across the
// whole app. Validating a new set replaces (not queues) the previous timer,
// so two concurrent SetRows can never display competing tickers.
//
// Remaining time is derived from a wall-clock `endsAt` timestamp on every
// render, so the displayed value stays correct even after the tab is
// backgrounded, the phone is locked, or the OS throttles setInterval. The
// 1s ticker exists only to drive re-renders; it never decrements anything.
//
// The timer is also written to localStorage, because module memory does not
// outlive the app: iOS kills a PWA in the background at will (filming a set
// with the Camera app is enough), and the athlete came back to a session
// with no rest running. `{ logId, endsAt }` is all there is to keep — an end
// time needs no ticking while the app is gone — and it is read back once,
// when this module loads.

const STORAGE_KEY = 'sl_rest_timer';

const INITIAL_STATE = { logId: null, endsAt: null, version: 0 };
const NO_TIMER = { logId: null, endsAt: null };

// Storage is a convenience here, never a condition: private mode, a full
// quota or a browser that blocks it must leave the timer running in memory.
function store(timer) {
  try {
    if (timer.endsAt == null) {
      window.localStorage.removeItem(STORAGE_KEY);
    } else {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ logId: timer.logId, endsAt: timer.endsAt }),
      );
    }
  } catch {
    // Not stored: the timer is lost if the app is killed, as it was before.
  }
}

// The timer a previous launch left running, or null. Only a rest that is
// still running is taken back: one that ended while the app was gone has
// nothing left to show, and anything this module did not write (another
// shape, a broken value) is not a timer. Whatever is refused is removed, so
// it is refused once.
function readStored() {
  if (typeof window === 'undefined') return null;
  let raw;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (raw == null) return null;
  try {
    const stored = JSON.parse(raw);
    if (
      stored != null &&
      typeof stored.logId === 'string' &&
      stored.logId !== '' &&
      Number.isFinite(stored.endsAt) &&
      stored.endsAt > Date.now()
    ) {
      return { logId: stored.logId, endsAt: stored.endsAt };
    }
  } catch {
    // Not JSON: removed below like any other value that is not a timer.
  }
  store(NO_TIMER);
  return null;
}

const restored = readStored();
let state = restored ? { ...restored, version: 0 } : INITIAL_STATE;
const listeners = new Set();
let tickerId = null;
let visibilityWired = false;

function emit() {
  // Bump version so useSyncExternalStore detects a change every tick,
  // even when logId/endsAt are unchanged — that's what re-runs SetRow's
  // remaining-time calculation against the current Date.now().
  state = { ...state, version: state.version + 1 };
  for (const l of listeners) l();
}

// The one way the timer itself changes (emit only says that time passed).
// Whatever sets a timer, replaces it or removes it goes through here, which
// is what keeps the stored copy the same as the one in memory.
function commit(timer) {
  state = { logId: timer.logId, endsAt: timer.endsAt, version: state.version + 1 };
  store(timer);
  for (const l of listeners) l();
}

function tick() {
  emit();
  // Stop the ticker once the active timer is well past its endsAt — there's
  // nothing left to update. It auto-restarts on the next startRestTimer call.
  if (state.endsAt == null || Date.now() > state.endsAt + 5_000) {
    stopTicker();
  }
}

function startTicker() {
  if (tickerId == null && typeof window !== 'undefined') {
    tickerId = setInterval(tick, 1000);
  }
  if (!visibilityWired && typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', emit);
    window.addEventListener('focus', emit);
    visibilityWired = true;
  }
}

function stopTicker() {
  if (tickerId != null) {
    clearInterval(tickerId);
    tickerId = null;
  }
}

export function startRestTimer(logId, seconds) {
  if (!logId || !seconds || seconds <= 0) return;
  commit({ logId, endsAt: Date.now() + seconds * 1000 });
  startTicker();
}

// Only clears if the active timer belongs to logId. Undoing a stale set
// (whose timer already finished or was replaced) must not kill the rest
// currently running for a more recent set.
export function clearRestTimer(logId) {
  if (state.logId !== logId) return;
  commit(NO_TIMER);
}

export function resetRestTimer() {
  commit(NO_TIMER);
  stopTicker();
}

function subscribe(callback) {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

function getSnapshot() {
  return state;
}

export function useRestTimer() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// A rest taken back from storage counts down like one that was just started.
if (restored) startTicker();
