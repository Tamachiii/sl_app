import { useMemo, useState } from 'react';
import { useSession } from '../../hooks/useSession';
import { useProgram } from '../../hooks/useProgram';
import { useI18n } from '../../hooks/useI18n';
import { formatSlotPrescription, getSlotTargetWeight } from '../../lib/volume';
import Spinner from '../ui/Spinner';

/**
 * Find the equivalent session one week earlier in the same program.
 *
 * "Equivalent" is the same weekday first — that is how a coach thinks about a
 * block ("last Monday's push day") — falling back to the same position in the
 * week when the previous week used different days. Archived sessions are
 * skipped: they are not what the athlete is following.
 */
export function findPreviousSession(program, currentSessionId) {
  const weeks = program?.weeks || [];
  let currentWeek = null;
  let current = null;
  for (const w of weeks) {
    const hit = (w.sessions || []).find((s) => s.id === currentSessionId);
    if (hit) {
      currentWeek = w;
      current = hit;
      break;
    }
  }
  if (!current) return null;

  const prevWeek = weeks.find((w) => w.week_number === currentWeek.week_number - 1);
  if (!prevWeek) return null;

  const candidates = (prevWeek.sessions || []).filter((s) => !s.archived_at);
  const byDay = candidates.find((s) => s.day_number === current.day_number);
  const byOrder = candidates.find((s) => (s.sort_order ?? 0) === (current.sort_order ?? 0));
  const match = byDay || byOrder;
  return match ? { week: prevWeek, session: match } : null;
}

function SlotLine({ slot, t }) {
  const compact = formatSlotPrescription(slot);
  const weight = getSlotTargetWeight(slot);
  const bits = [];
  if (compact) bits.push(compact);
  else bits.push(t('coach.prev.perSet'));
  if (weight != null) bits.push(`@ ${weight}kg`);

  return (
    <li className="flex items-baseline justify-between gap-3 py-1.5 border-t border-ink-100 first:border-t-0">
      <span className="sl-display text-[13px] text-ink-700 truncate min-w-0">
        {slot.exercise?.name || '—'}
      </span>
      <span className="sl-mono text-[11px] text-ink-400 shrink-0 tabular-nums">
        {bits.join(' ')}
      </span>
    </li>
  );
}

/**
 * A read-only look at the same session in the previous week, so the coach can
 * write this week's prescription against last week's without navigating away
 * and losing the editor. Collapsed by default — it is a reference, not the job.
 *
 * Renders nothing at all when there is no previous week (week 1) or no
 * equivalent session, rather than showing an empty box.
 */
export default function PreviousSessionPanel({ programId, sessionId }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const { data: program } = useProgram(programId);

  const previous = useMemo(
    () => findPreviousSession(program, sessionId),
    [program, sessionId],
  );

  // Only pay for the slot tree once the coach actually opens the panel.
  const { data: prevSession, isLoading } = useSession(open ? previous?.session?.id : undefined);

  if (!previous) return null;

  const title = previous.session.title
    || t('coach.week.sessionN', { n: previous.session.day_number });
  const slots = prevSession?.exercise_slots || [];

  return (
    <div className="sl-card p-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center gap-2 text-left"
      >
        <span className="sl-label text-ink-400">{t('coach.prev.label')}</span>
        <span className="sl-mono text-[11px] text-ink-400 truncate min-w-0">
          {t('coach.week.weekShort', { n: previous.week.week_number })} · {title}
        </span>
        <svg
          className={`w-3.5 h-3.5 text-ink-400 shrink-0 ml-auto transition-transform ${open ? 'rotate-90' : ''}`}
          fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </button>

      {open && (
        <div className="mt-2">
          {isLoading && <div className="flex justify-center py-3"><Spinner /></div>}
          {!isLoading && slots.length === 0 && (
            <p className="sl-mono text-[11px] text-ink-400 py-2">{t('coach.prev.empty')}</p>
          )}
          {!isLoading && slots.length > 0 && (
            <ul>
              {slots.map((slot) => <SlotLine key={slot.id} slot={slot} t={t} />)}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
