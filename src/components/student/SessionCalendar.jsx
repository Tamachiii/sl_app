import { useId, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useI18n } from '../../hooks/useI18n';
import { capitalize } from './sessionModel';
import { dayNames, formatDate } from '../../lib/i18n/format';
import { IconButton } from '../parc';

function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
function addMonths(d, n) {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}
function ymd(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// The marks of a day, by shape as much as by colour (design/parc/components/
// WeekDots): done a full blue disc, to come an ink ring, trained and not
// confirmed an `ink-3` ring, a session of an earlier block a full grey disc.
const MARK = {
  done: 'bg-blue',
  upcoming: 'border-2 border-ink',
  unconfirmed: 'border-2 border-ink-3',
  history: 'bg-ink-3',
};

function Mark({ kind }) {
  return <span data-dot={kind} className={`inline-block h-2 w-2 rounded-full ${MARK[kind]}`} />;
}

/**
 * The month of the athlete's sessions: one cell per day, a link to the
 * session of a day that has one, its marks under the date, and a legend that
 * says each mark in words. A past day with a session not confirmed is
 * UNCONFIRMED, not to come. `sessions` are `{ session_id, title, date,
 * completed, historical? }` (the stats hook's `sessionCalendar`, and the
 * sessions of earlier blocks on top of it).
 */
export default function SessionCalendar({ sessions }) {
  const { t, lang } = useI18n();
  const titleId = useId();
  const [cursor, setCursor] = useState(() => startOfMonth(new Date()));

  const byDate = useMemo(() => {
    const map = new Map();
    for (const s of sessions || []) {
      const list = map.get(s.date) || [];
      list.push(s);
      map.set(s.date, list);
    }
    return map;
  }, [sessions]);

  const cells = useMemo(() => {
    const year = cursor.getFullYear();
    const month = cursor.getMonth();
    const first = new Date(year, month, 1);
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    // Monday-first grid: getDay() 0=Sun..6=Sat → shift so Mon=0.
    const leading = (first.getDay() + 6) % 7;
    const totalCells = Math.ceil((leading + daysInMonth) / 7) * 7;
    const arr = [];
    for (let i = 0; i < totalCells; i++) {
      const dayNum = i - leading + 1;
      if (dayNum < 1 || dayNum > daysInMonth) {
        arr.push(null);
      } else {
        const date = new Date(year, month, dayNum);
        arr.push({ date, key: ymd(date), dayNum });
      }
    }
    return arr;
  }, [cursor]);

  const monthLabel = capitalize(formatDate(lang, cursor, { month: 'long', year: 'numeric' }));
  const weekdays = dayNames(lang, 'narrow');
  const todayKey = ymd(new Date());

  return (
    <section aria-labelledby={titleId} className="rounded-group bg-surface p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <IconButton
          icon="chevron-left"
          tone="fill"
          size={18}
          label={t('parcStats.calendarPrevious')}
          onClick={() => setCursor((c) => addMonths(c, -1))}
        />
        <h2 id={titleId} className="pk-headline" aria-live="polite">
          {monthLabel}
        </h2>
        <IconButton
          icon="chevron-right"
          tone="fill"
          size={18}
          label={t('parcStats.calendarNext')}
          onClick={() => setCursor((c) => addMonths(c, 1))}
        />
      </div>

      <div className="mb-1 grid grid-cols-7 gap-1 text-center" aria-hidden="true">
        {weekdays.map((d, i) => (
          <div key={i} className="pk-small">
            {d}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-1">
        {cells.map((cell, i) => {
          if (!cell) return <div key={i} className="aspect-square" />;
          const entries = byDate.get(cell.key) || [];
          const active = entries.filter((e) => !e.historical);
          const historical = entries.filter((e) => e.historical);
          const isPast = cell.key < todayKey;
          const marks = [];
          if (active.some((e) => e.completed)) marks.push('done');
          if (!isPast && active.some((e) => !e.completed)) marks.push('upcoming');
          if (isPast && active.some((e) => !e.completed)) marks.push('unconfirmed');
          if (active.length === 0 && historical.length > 0) marks.push('history');
          const isToday = cell.key === todayKey;
          const first = active[0] || historical[0];
          const content = (
            <div
              className={`flex aspect-square min-h-11 flex-col items-center justify-center gap-0.5 rounded-control text-[15px] pk-tnum ${
                isToday ? 'bg-blue-soft font-bold text-blue' : 'text-ink'
              }`}
            >
              <span>{cell.dayNum}</span>
              <span className="flex h-2 gap-0.5">
                {marks.map((kind) => (
                  <Mark key={kind} kind={kind} />
                ))}
              </span>
            </div>
          );
          return first ? (
            <Link
              key={i}
              to={`/student/session/${first.session_id}`}
              aria-label={t('parcStats.calendarDay', {
                title: first.title || t('parcStats.calendarSession'),
                date: formatDate(lang, cell.date, { weekday: 'long', day: 'numeric', month: 'long' }),
              })}
              className="block rounded-control focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue"
            >
              {content}
            </Link>
          ) : (
            <div key={i}>{content}</div>
          );
        })}
      </div>

      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
        {[
          ['done', 'parcStats.legendDone'],
          ['upcoming', 'parcStats.legendUpcoming'],
          ['unconfirmed', 'parcStats.legendUnconfirmed'],
          ['history', 'parcStats.legendHistory'],
        ].map(([kind, key]) => (
          <span key={kind} className="pk-small flex items-center gap-1.5" data-legend={kind}>
            <Mark kind={kind} />
            {t(key)}
          </span>
        ))}
      </div>
    </section>
  );
}
