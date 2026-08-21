import { DAY_LABELS, DAY_FULL, todayDayNumber } from '../../lib/day';
import { useI18n } from '../../hooks/useI18n';

// The state comes pre-resolved from `buildDayStrip` (lib/sessionQueue), shared
// with the athlete's own Home strip so the two can never tell different
// stories about the same week.
//
// There is no "missed" state any more: a recommended day passing is not a
// failure, it just means the session is still next in the queue. What the
// coach needs instead — has this athlete gone quiet — is the roster's
// staleness chip, which measures real days since the last session.
const STATUS_CLASS = {
  performed: 'bg-accent text-ink-900 border border-transparent',
  today: 'bg-white text-accent border border-accent',
  planned: 'bg-white text-ink-400 border border-ink-100',
  suggested: 'bg-transparent text-ink-400 border border-dashed border-ink-200',
  archived: 'bg-ink-50 text-ink-300 border border-transparent line-through',
  rest: 'bg-ink-50 text-ink-300 border border-transparent opacity-60',
};

export default function StudentWeekStrip({ weekDays, className = '' }) {
  const { t } = useI18n();
  const todayDN = todayDayNumber();
  if (!Array.isArray(weekDays) || weekDays.length === 0) return null;

  return (
    <div
      className={`flex gap-1 ${className}`}
      role="list"
      aria-label={t('coach.dashboard.weekStripAria')}
    >
      {weekDays.map((d) => {
        // Today is a highlight on top of open work, not a state of its own —
        // an already-trained day keeps its trained styling.
        const status =
          d.dayNumber === todayDN && (d.state === 'planned' || d.state === 'suggested')
            ? 'today'
            : d.state || 'rest';
        const label = DAY_LABELS[d.dayNumber - 1];
        const dayFull = DAY_FULL[d.dayNumber - 1];
        const statusLabel = t(`coach.dashboard.dayStatus.${status}`);
        return (
          <div
            key={d.dayNumber}
            role="listitem"
            aria-label={`${dayFull}: ${statusLabel}`}
            title={`${dayFull} · ${statusLabel}`}
            className={`flex-1 min-w-0 h-6 rounded-md sl-mono text-[10px] font-semibold flex items-center justify-center ${STATUS_CLASS[status]}`}
          >
            {label}
          </div>
        );
      })}
    </div>
  );
}
