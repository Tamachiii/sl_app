import { useEffect } from 'react';
import { useRestTimer } from './useRestTimer';

// useRestTimerEffects — out-of-band side effects that ride on top of the
// app-wide rest-timer singleton (hooks/useRestTimer). Kept separate so the
// store stays a pure timestamp holder. Mount this hook exactly once:
// components/student/RestTimerHost does, in the student shell (AppShell), so
// that a rest keeps its beep and its wake lock while the athlete looks at
// another tab. Mounted in the session page, it was cleaned up on every change
// of tab while the timer ran on.
//
// What it does, while a timer is active:
//   1. Acquires `navigator.wakeLock('screen')` so the phone screen doesn't
//      dim/lock mid-rest. The browser releases the lock by itself when the
//      page is hidden: the sentinel's `release` event drops the handle, and
//      `visibilitychange → visible` asks for a new one.
//   2. Schedules a one-shot WebAudio beep + `navigator.vibrate` at endsAt.
//      The beep is synthesized (no asset to bundle); the AudioContext is
//      unlocked on the first user gesture via a module-level listener.
//      Where the browser has `navigator.audioSession` (iOS Safari), the
//      session is switched to 'playback' for the length of the beep, which
//      is what lets it through the ring/silent switch.
//   3. When the page is hidden, mirrors the remaining time into
//      `document.title` so an app-switcher / back-of-app glance still
//      shows the countdown. Restores the original title on expiry/cleanup.
//
// All effects clean up when endsAt/logId changes (a new set starts, the rest
// is skipped or given 30 s more) or when the shell unmounts (sign-out). The
// expiry timeout also releases the wake lock so the screen can lock again the
// moment rest is over.

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
//
// Armed by the first mount of the hook, not when this module is loaded: the
// module is in the bundle every signed-in user loads (the student shell's
// host is imported by AppShell), and the first tap of a coach would otherwise
// build an AudioContext nobody plays.
let unlockArmed = false;

function armAudioUnlock() {
  if (unlockArmed) return;
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  unlockArmed = true;
  const unlock = () => {
    const ac = getAudioContext();
    if (ac && ac.state === 'suspended') {
      ac.resume().catch(() => {});
    }
  };
  window.addEventListener('pointerdown', unlock, { once: true, passive: true });
  window.addEventListener('touchstart', unlock, { once: true, passive: true });
}

// The beep, from its first sample to its last.
const CUE_MS = 600;
// What the audio session is given to change category: the beep starts that
// much later when the category was changed for it, and the category is held
// that much longer than the beep.
const SESSION_SWITCH_MS = 250;

// On iOS, Web Audio plays in the "ambient" category: it mixes with whatever
// else is playing and is muted by the ring/silent switch, which most phones
// in a gym have on. The Audio Session API (`navigator.audioSession`, in iOS
// Safari; found by feature detection) lets a page ask for 'playback', the
// category of a music player, which the switch does not mute.
//
// 'playback' is an exclusive type: a page that holds it does not mix, it
// takes the audio of the phone from the app that was playing. So it is taken
// for the beep and given back right after — never on the first tap, never
// for the length of the session — and an athlete who restarts their music
// plays it next to a page that mixes again.
//
// The specification applies a new type in a task of its own, after the
// assignment returns, and the beep is at its loudest in its first tenth of a
// second: hence the wait. Returns true when the category was changed, i.e.
// when the beep has to wait for it.
//
// What the phone really does with all this — the switch, the music of
// another app — shows on an iPhone only. The tests show that the property is
// written for the beep, put back after it, and left alone everywhere else.
function takePlaybackSession() {
  if (typeof navigator === 'undefined') return false;
  try {
    const session = navigator.audioSession;
    if (!session) return false;
    const before = session.type;
    // Already 'playback': somebody else's choice, and theirs to undo.
    if (before === 'playback') return false;
    session.type = 'playback';
    // A browser that does not know the value ignores the assignment.
    if (session.type !== 'playback') return false;
    setTimeout(() => {
      try {
        if (session.type === 'playback') session.type = before;
      } catch {
        // Stays what it is.
      }
    }, SESSION_SWITCH_MS + CUE_MS + SESSION_SWITCH_MS);
    return true;
  } catch {
    // A session that refuses: the beep plays as it would have without it.
    return false;
  }
}

function playBeep() {
  const ac = getAudioContext();
  if (!ac) return;
  const lead = takePlaybackSession() ? SESSION_SWITCH_MS / 1000 : 0;
  try {
    if (ac.state === 'suspended') ac.resume().catch(() => {});
    const t0 = ac.currentTime + lead;
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
    o.stop(t0 + CUE_MS / 1000);
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
    armAudioUnlock();
  }, []);

  useEffect(() => {
    if (endsAt == null) return undefined;

    let cancelled = false;
    let wakeLock = null;
    let expiryTimeout = null;
    let titleInterval = null;
    const originalTitle = typeof document !== 'undefined' ? document.title : '';

    // A sentinel the browser has released is a dead object: it keeps nothing
    // awake and is never revived. Holding on to one is what used to stop the
    // lock from being taken again after a glance at another app.
    function holdsWakeLock() {
      return wakeLock != null && wakeLock.released !== true;
    }

    async function acquireWakeLock() {
      if (typeof navigator === 'undefined' || !navigator.wakeLock?.request) return;
      try {
        const wl = await navigator.wakeLock.request('screen');
        // No longer wanted, or a second request that resolved after the first
        // (the page was hidden and shown again while one was in flight): a
        // lock that is not stored would never be released.
        if (cancelled || Date.now() >= endsAt || holdsWakeLock()) {
          wl.release().catch(() => {});
          return;
        }
        wakeLock = wl;
        if (typeof wl.addEventListener === 'function') {
          wl.addEventListener('release', () => {
            if (wakeLock === wl) wakeLock = null;
          });
        }
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
        !holdsWakeLock()
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
