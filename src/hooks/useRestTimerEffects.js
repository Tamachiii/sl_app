import { useEffect } from 'react';
import { useRestTimer } from './useRestTimer';

// useRestTimerEffects — out-of-band side effects that ride on top of the
// app-wide rest-timer singleton (hooks/useRestTimer). Kept separate so the
// store stays a pure timestamp holder and so SessionView is the only place
// these run. Mount this hook exactly once, inside the student SessionView,
// when a rest timer can be active.
//
// What it does, while a timer is active:
//   1. Acquires `navigator.wakeLock('screen')` so the phone screen doesn't
//      dim/lock mid-rest. Re-acquires on `visibilitychange → visible`
//      because the browser auto-releases when the tab is backgrounded.
//   2. Schedules a one-shot WebAudio beep + `navigator.vibrate` at endsAt.
//      The beep is synthesized (no asset to bundle); the AudioContext is
//      unlocked on the first user gesture via a module-level listener.
//   3. When the page is hidden, mirrors the remaining time into
//      `document.title` so an app-switcher / back-of-app glance still
//      shows the countdown. Restores the original title on expiry/cleanup.
//
// All effects clean up when endsAt/logId changes (new set starts) or when
// SessionView unmounts. The expiry timeout also releases the wake lock so
// the screen can lock again the moment rest is over.

let audioCtx = null;

function getAudioContext() {
  if (typeof window === 'undefined') return null;
  if (audioCtx) return audioCtx;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  try {
    audioCtx = new Ctor();
  } catch {
    audioCtx = null;
  }
  return audioCtx;
}

// iOS / Safari requires the AudioContext to be created or resumed inside
// a user gesture. We attach a one-shot pointerdown that does both, so by
// the time a rest timer expires the context is unlocked. Student always
// taps a set to start the timer in the first place, so this almost
// always fires well before expiry.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  const unlock = () => {
    const ac = getAudioContext();
    if (ac && ac.state === 'suspended') {
      ac.resume().catch(() => {});
    }
  };
  window.addEventListener('pointerdown', unlock, { once: true, passive: true });
  window.addEventListener('touchstart', unlock, { once: true, passive: true });
}

function playBeep() {
  const ac = getAudioContext();
  if (!ac) return;
  try {
    if (ac.state === 'suspended') ac.resume().catch(() => {});
    const t0 = ac.currentTime;
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(880, t0);
    o.frequency.exponentialRampToValueAtTime(440, t0 + 0.35);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.4, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.55);
    o.connect(g).connect(ac.destination);
    o.start(t0);
    o.stop(t0 + 0.6);
  } catch {
    // No-op — audio is a nice-to-have, never throw.
  }
}

function vibrate() {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
  try {
    navigator.vibrate([200, 100, 200]);
  } catch {
    // Some browsers throw if vibration is blocked by user-activation policy.
  }
}

function formatMMSS(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function useRestTimerEffects() {
  const { endsAt, logId } = useRestTimer();

  useEffect(() => {
    if (endsAt == null) return undefined;

    let cancelled = false;
    let wakeLock = null;
    let expiryTimeout = null;
    let titleInterval = null;
    const originalTitle = typeof document !== 'undefined' ? document.title : '';

    async function acquireWakeLock() {
      if (typeof navigator === 'undefined' || !navigator.wakeLock?.request) return;
      try {
        const wl = await navigator.wakeLock.request('screen');
        if (cancelled || Date.now() >= endsAt) {
          wl.release().catch(() => {});
          return;
        }
        wakeLock = wl;
      } catch {
        // User declined / unsupported / page not visible — silently skip.
      }
    }

    function releaseWakeLock() {
      if (wakeLock) {
        wakeLock.release().catch(() => {});
        wakeLock = null;
      }
    }

    function updateTitle() {
      if (typeof document === 'undefined') return;
      if (document.visibilityState !== 'hidden') {
        if (document.title !== originalTitle) document.title = originalTitle;
        return;
      }
      const remainingMs = endsAt - Date.now();
      if (remainingMs <= 0) {
        document.title = `Rest done · ${originalTitle}`;
      } else {
        const s = Math.ceil(remainingMs / 1000);
        document.title = `Rest ${formatMMSS(s)} · ${originalTitle}`;
      }
    }

    function handleVisibility() {
      // Re-acquire the wake lock when the tab returns to foreground — the
      // browser auto-releases it on hide. Skip if rest already expired.
      if (
        typeof document !== 'undefined' &&
        document.visibilityState === 'visible' &&
        !cancelled &&
        Date.now() < endsAt &&
        !wakeLock
      ) {
        acquireWakeLock();
      }
      updateTitle();
    }

    acquireWakeLock();

    const delay = Math.max(0, endsAt - Date.now());
    expiryTimeout = setTimeout(() => {
      playBeep();
      vibrate();
      // Let the screen lock again now that rest is over.
      releaseWakeLock();
      updateTitle();
    }, delay);

    updateTitle();
    titleInterval = setInterval(updateTitle, 1000);
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', handleVisibility);
    }

    return () => {
      cancelled = true;
      if (expiryTimeout) clearTimeout(expiryTimeout);
      if (titleInterval) clearInterval(titleInterval);
      if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
        document.removeEventListener('visibilitychange', handleVisibility);
        if (document.title !== originalTitle) document.title = originalTitle;
      }
      releaseWakeLock();
    };
  }, [endsAt, logId]);
}
