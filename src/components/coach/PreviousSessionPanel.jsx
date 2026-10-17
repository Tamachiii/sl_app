import { useI18n } from '../../hooks/useI18n';
import { useLastPerformance } from '../../hooks/useLastPerformance';
import { lastTimeText } from '../student/sessionModel';
import Spinner from '../ui/Spinner';

/**
 * What the athlete ACTUALLY lifted, per exercise of the session being written.
 *
 * This replaced a panel that answered a different question badly. It used to
 * find "the same weekday one week earlier" and list that session's PRESCRIPTION
 * — the coach's own past numbers, not the athlete's performance — so the one
 * thing progressive overload needs was the one thing it could not show. It also
 * required `week_number === current - 1`, so it vanished entirely in a
 * single-week block, which the queue refactor made the normal shape. And its
 * matching broke twice over: on weekday (meaningless once day_number became an
 * optional hint) and on position (meaningless once positions are per-week).
 *
 * Keying on the EXERCISE instead removes all three problems at once — there is
 * no session to match and no week arithmetic left. It also shows the coach
 * exactly what the athlete sees in their own "Last time" hint while logging,
 * because both now read the same `useLastPerformance`.
 *
 * Always expanded: the numbers ARE the job when writing next week's loads, and
 * the old collapsed-by-default panel existed to avoid paying for a slot tree
 * this no longer fetches.
 */
// « Il y a 7 jours, 4 × 5 à 17,5 kg. » — the same words as the athlete's own
// « La dernière fois » under the set they are logging.
function ExerciseLine({ name, perf, ctx }) {
  const text = lastTimeText(perf, ctx);
  return (
    <li className="pk-row">
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="pk-headline truncate">{name}</span>
        <span className="pk-caption">
          <span className="sr-only">,</span> {text || ctx.t('parcEditor.notYet')}
        </span>
      </span>
    </li>
  );
}

export default function PreviousSessionPanel({ studentRowId, sessionId, slots }) {
  const ctx = useI18n();
  const { t } = ctx;
  const exercises = (slots || []).map((s) => s.exercise).filter(Boolean);

  const { data: byExercise, isLoading } = useLastPerformance(
    sessionId,
    slots,
    null,
    null,
    true,
    studentRowId,
  );

  if (exercises.length === 0) return null;

  return (
    <section aria-labelledby={`last-time-${sessionId}`} className="flex flex-col gap-2.5">
      <h2 id={`last-time-${sessionId}`} className="pk-headline">{t('parcEditor.lastTime')}</h2>
      {isLoading ? (
        <div className="flex justify-center py-3"><Spinner /></div>
      ) : (
        <ul className="pk-group">
          {exercises.map((ex, i) => (
            <ExerciseLine
              key={`${ex.id}-${i}`}
              name={ex.name}
              perf={byExercise?.[ex.id]}
              ctx={ctx}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
