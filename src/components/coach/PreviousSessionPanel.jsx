import { useI18n } from '../../hooks/useI18n';
import { useLastPerformance } from '../../hooks/useLastPerformance';
import { formatLastPerformance, daysSince } from '../../lib/lastPerformance';
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
function ExerciseLine({ name, perf, lang, t }) {
  const summary = formatLastPerformance(perf);
  const days = perf ? daysSince(perf.performedAt) : null;
  let when = '';
  if (days != null) {
    try {
      when = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' }).format(-days, 'day');
    } catch {
      when = '';
    }
  }

  return (
    <li className="flex items-baseline gap-2 py-1.5 border-t border-ink-100 first:border-t-0">
      <span className="sl-display text-[13px] text-ink-700 truncate min-w-0 flex-1">{name}</span>
      {summary ? (
        <>
          <span className="sl-mono text-[11px] text-ink-400 shrink-0 tabular-nums">{summary}</span>
          {when && <span className="sl-mono text-[10px] text-ink-300 shrink-0">{when}</span>}
        </>
      ) : (
        // Never trained, or trained only as a swap with no logged actuals —
        // a prescription is not a performance, so there is nothing to beat.
        <span className="sl-mono text-[11px] text-ink-300 shrink-0">{t('coach.prev.never')}</span>
      )}
    </li>
  );
}

export default function PreviousSessionPanel({ studentRowId, sessionId, slots }) {
  const { t, lang } = useI18n();
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
    <div className="sl-card p-3">
      <div className="sl-label text-ink-400 mb-1.5">{t('coach.prev.label')}</div>
      {isLoading ? (
        <div className="flex justify-center py-3"><Spinner /></div>
      ) : (
        <ul>
          {exercises.map((ex, i) => (
            <ExerciseLine
              key={`${ex.id}-${i}`}
              name={ex.name}
              perf={byExercise?.[ex.id]}
              lang={lang}
              t={t}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
