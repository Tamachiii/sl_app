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

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

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
    // Monday-first: JS Sunday=0 → shift to 6, Monday=1 → 0.
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
    <div className="bg-white rounded-xl shadow-sm p-4">
      <div className="flex items-center justify-between mb-3">
        <button
          onClick={() => setCursor((c) => addMonths(c, -1))}
          aria-label="Previous month"
          className="text-gray-500 hover:text-primary p-1"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <span className="text-sm font-medium text-gray-900">{monthLabel}</span>
        <button
          onClick={() => setCursor((c) => addMonths(c, 1))}
          aria-label="Next month"
          className="text-gray-500 hover:text-primary p-1"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>

      <div className="grid grid-cols-7 gap-1 text-center text-[10px] font-medium uppercase tracking-wide text-gray-400 mb-1">
        {WEEKDAYS.map((d) => (
          <div key={d}>{d}</div>
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
              className={`aspect-square flex flex-col items-center justify-center rounded-lg text-xs ${
                isToday
                  ? 'bg-primary/10 text-primary font-semibold'
                  : 'text-gray-700'
              } ${entries.length ? 'hover:bg-gray-100' : ''}`}
            >
              <span>{cell.dayNum}</span>
              <div className="flex gap-0.5 mt-0.5 h-1">
                {hasCompleted && <span className="w-1 h-1 rounded-full bg-success" />}
                {hasUpcoming && <span className="w-1 h-1 rounded-full bg-primary" />}
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

      <div className="flex gap-3 justify-end text-[11px] text-gray-500 mt-3">
        <span className="flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-success" /> Completed
        </span>
        <span className="flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-primary" /> Upcoming
        </span>
      </div>
    </div>
  );
}
