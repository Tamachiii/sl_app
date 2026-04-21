import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

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

const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

export default function SessionCalendar({ sessions }) {
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

  const { cells, monthLabel } = useMemo(() => {
    const year = cursor.getFullYear();
    const month = cursor.getMonth();
    const first = new Date(year, month, 1);
    const daysInMonth = new Date(year, month + 1, 0).getDate();
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
    const monthLabel = cursor.toLocaleDateString(undefined, {
      month: 'long',
      year: 'numeric',
    });
    return { cells: arr, monthLabel };
  }, [cursor]);

  const todayKey = ymd(new Date());

  return (
    <div className="sl-card p-4">
      <div className="flex items-center justify-between mb-3">
        <button
          onClick={() => setCursor((c) => addMonths(c, -1))}
          aria-label="Previous month"
          className="w-8 h-8 rounded-lg bg-ink-100 text-ink-500 flex items-center justify-center hover:bg-ink-200 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <span className="sl-display text-[15px] text-gray-900 uppercase tracking-wide">{monthLabel}</span>
        <button
          onClick={() => setCursor((c) => addMonths(c, 1))}
          aria-label="Next month"
          className="w-8 h-8 rounded-lg bg-ink-100 text-ink-500 flex items-center justify-center hover:bg-ink-200 transition-colors"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>

      <div className="grid grid-cols-7 gap-1 text-center sl-mono text-[10px] text-ink-400 mb-1.5">
        {WEEKDAYS.map((d, i) => (
          <div key={i}>{d}</div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-1">
        {cells.map((cell, i) => {
          if (!cell) return <div key={i} className="aspect-square" />;
          const entries = byDate.get(cell.key) || [];
          const hasCompleted = entries.some((e) => e.completed);
          const hasUpcoming = entries.some((e) => !e.completed);
          const isToday = cell.key === todayKey;
          const first = entries[0];
          const content = (
            <div
              className={`aspect-square flex flex-col items-center justify-center rounded-lg sl-mono text-[12px] ${
                isToday
                  ? 'text-ink-900'
                  : 'text-gray-700'
              } ${entries.length && !isToday ? 'hover:bg-ink-50' : ''}`}
              style={isToday ? { background: 'var(--color-accent)' } : undefined}
            >
              <span className="tabular-nums font-semibold">{cell.dayNum}</span>
              <div className="flex gap-0.5 mt-0.5 h-1">
                {hasCompleted && (
                  <span
                    className="w-1 h-1 rounded-full"
                    style={{ background: 'var(--color-success)' }}
                  />
                )}
                {hasUpcoming && (
                  <span
                    className="w-1 h-1 rounded-full"
                    style={{ background: isToday ? 'var(--color-ink-900)' : 'var(--color-accent)' }}
                  />
                )}
              </div>
            </div>
          );
          return first ? (
            <Link
              key={i}
              to={`/student/session/${first.session_id}`}
              aria-label={`${first.title || 'Session'} on ${cell.key}`}
              className="block"
            >
              {content}
            </Link>
          ) : (
            <div key={i}>{content}</div>
          );
        })}
      </div>

      <div className="flex gap-3 justify-end sl-mono text-[10px] text-ink-400 mt-3">
        <span className="flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--color-success)' }} /> DONE
        </span>
        <span className="flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--color-accent)' }} /> UPCOMING
        </span>
      </div>
    </div>
  );
}
