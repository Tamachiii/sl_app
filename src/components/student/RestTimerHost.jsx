import { useRestTimerEffects } from '../../hooks/useRestTimerEffects';
import { useRestTimerPush } from '../../hooks/useRestTimerPush';

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
 */
export default function RestTimerHost() {
  useRestTimerEffects();
  useRestTimerPush();
  return null;
}
