import { DAY_LABELS, DAY_FULL, todayDayNumber } from '../../lib/day';
import { useI18n } from '../../hooks/useI18n';

function statusOf(day, todayDN) {
  const s = day.session;
  if (!s || s.archived_at) return 'rest';
  if (day.confirmed) return 'completed';
  if (day.dayNumber === todayDN) return 'today';
  if (day.dayNumber < todayDN) return 'missed';
  return 'upcoming';
}

const STATUS_CLASS = {
  completed: 'bg-accent text-ink-900 border border-transparent',
  today: 'bg-white text-accent border border-accent',
  upcoming: 'bg-white text-ink-400 border border-ink-100',
  missed: 'bg-ink-50 text-ink-300 border border-transparent line-through',
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
        const status = statusOf(d, todayDN);
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
