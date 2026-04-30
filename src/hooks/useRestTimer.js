import { useSyncExternalStore } from 'react';

// Module-level singleton: only one rest timer is ever active across the
// whole app. Validating a new set replaces (not queues) the previous timer,
// so two concurrent SetRows can never display competing tickers.
//
// Remaining time is derived from a wall-clock `endsAt` timestamp on every
// render, so the displayed value stays correct even after the tab is
// backgrounded, the phone is locked, or the OS throttles setInterval. The
// 1s ticker exists only to drive re-renders; it never decrements anything.

const INITIAL_STATE = { logId: null, endsAt: null, version: 0 };
let state = INITIAL_STATE;
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
  state = { logId, endsAt: Date.now() + seconds * 1000, version: state.version + 1 };
  for (const l of listeners) l();
  startTicker();
}

// Only clears if the active timer belongs to logId. Undoing a stale set
// (whose timer already finished or was replaced) must not kill the rest
// currently running for a more recent set.
export function clearRestTimer(logId) {
  if (state.logId !== logId) return;
  state = { logId: null, endsAt: null, version: state.version + 1 };
  for (const l of listeners) l();
}

export function resetRestTimer() {
  state = { ...INITIAL_STATE, version: state.version + 1 };
  for (const l of listeners) l();
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

// Returns whole seconds remaining for `logId`, or null if a different log
// (or no log) currently owns the timer.
export function remainingSecondsFor(snapshot, logId) {
  if (!snapshot || snapshot.logId !== logId || snapshot.endsAt == null) return null;
  return Math.max(0, Math.ceil((snapshot.endsAt - Date.now()) / 1000));
}
