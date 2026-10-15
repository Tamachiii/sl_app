import { useState } from 'react';
import { useRestTimer } from '../../hooks/useRestTimer';
import { useRestTimerEffects } from '../../hooks/useRestTimerEffects';
import { useRestTimerPush } from '../../hooks/useRestTimerPush';
import { useI18n } from '../../hooks/useI18n';
import { HIDE_AFTER_EXPIRY_MS, formatMMSS } from './RestTimerBanner';

// The whole seconds a rest has left, read once when it begins.
function secondsLeft(endsAt) {
  if (endsAt == null) return 0;
  return Math.max(0, Math.ceil((endsAt - Date.now()) / 1000));
}

// What the status region says: the length of a rest when it begins (or is
// given more time), "Rest done" when it ends, and nothing otherwise. The
// length is read once per rest — keyed on the set and the end time — so the
// text stays the same for the whole rest: a status region announces each
// change of its text, and a countdown in it is read aloud every second.
function useRestAnnouncement() {
  const { logId, endsAt } = useRestTimer();
  const { t } = useI18n();
  const key = endsAt == null ? null : `${logId}:${endsAt}`;
  const [rest, setRest] = useState(() => ({ key, seconds: secondsLeft(endsAt) }));
  const seconds = rest.key === key ? rest.seconds : secondsLeft(endsAt);
  if (rest.key !== key) setRest({ key, seconds });

  if (key == null) return '';
  // Read again on every tick of the store, like the banner's countdown.
  // eslint-disable-next-line react-hooks/purity -- the clock is what this says
  const remainingMs = endsAt - Date.now();
  if (remainingMs > 0) return t('sessionRestControls.restStarted', { time: formatMMSS(seconds) });
  if (remainingMs > -HIDE_AFTER_EXPIRY_MS) return t('student.session.restDone');
  return '';
}

/**
 * RestTimerHost — what a rest does outside the page that shows it.
 *
 * Mounted once, by AppShell, for a student: the wake lock, the beep and the
 * vibration at the end (useRestTimerEffects) and the "Rest done" push
 * (useRestTimerPush) run for as long as the athlete is in the app, on any
 * tab. They used to be mounted by SessionView, and a look at Stats or at the
 * messages in the middle of a rest unmounted them: the push was cancelled,
 * the beep never came, the screen was free to lock — while the countdown,
 * kept by the singleton, was still running when the athlete came back.
 *
 * What ends a rest's effects now is the timer itself (a new set, Undo, Skip,
 * +30 s, the end) or the shell going away (sign-out).
 *
 * It also renders what a screen reader hears of the rest: a status region,
 * visually hidden and always in the page — a region added together with its
 * text is not announced — that holds the start of a rest and its end. The
 * banner on the session page, whose countdown changes every second, is not a
 * live region.
 */
export default function RestTimerHost() {
  useRestTimerEffects();
  useRestTimerPush();
  const announcement = useRestAnnouncement();
  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {announcement}
    </div>
  );
}
