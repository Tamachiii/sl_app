import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import Spinner from '../ui/Spinner';
import EmptyState from '../ui/EmptyState';
import { useAllConfirmations } from '../../hooks/useSessionConfirmation';

export default function SessionsFeed() {
  const { data: confirmations, isLoading } = useAllConfirmations();
  const [showArchived, setShowArchived] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const studentFilter = searchParams.get('student') || '';

  const studentOptions = useMemo(() => {
    const map = new Map();
    for (const c of confirmations || []) {
      if (c.student_id && !map.has(c.student_id)) {
        map.set(c.student_id, c.student_name || 'Student');
      }
    }
    return Array.from(map, ([id, name]) => ({ id, name })).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
  }, [confirmations]);

  const { active, archived } = useMemo(() => {
    const a = [];
    const b = [];
    for (const c of confirmations || []) {
      if (studentFilter && c.student_id !== studentFilter) continue;
      (c.archived_at ? b : a).push(c);
    }
    return { active: a, archived: b };
  }, [confirmations, studentFilter]);

  function handleFilterChange(e) {
    const value = e.target.value;
    const next = new URLSearchParams(searchParams);
    if (value) next.set('student', value);
    else next.delete('student');
    setSearchParams(next, { replace: true });
  }

  if (isLoading) {
    return <div className="flex justify-center py-12"><Spinner /></div>;
  }

  function renderCard(c) {
    const isArchived = !!c.archived_at;
    return (
      <Link
        key={c.id}
        to={`/coach/student/${c.student_id}/session/${c.session_id}/review`}
        className={`block sl-card p-4 space-y-1 hover:bg-ink-50 transition-colors ${
          isArchived ? 'opacity-75' : ''
        }`}
      >
        <div className="flex items-center justify-between gap-2">
          <span
            className="sl-mono text-[11px] truncate"
            style={{ color: 'var(--color-accent)' }}
          >
            {c.student_name}
          </span>
          <div className="flex items-center gap-1.5 shrink-0">
            {isArchived && (
              <span
                className="sl-pill"
                style={{
                  background: 'color-mix(in srgb, var(--color-warn) 18%, transparent)',
                  color: 'var(--color-ink-900)',
                }}
              >
                archived
              </span>
            )}
            <span
              className="sl-pill inline-flex items-center gap-1"
              style={{
                background: 'color-mix(in srgb, var(--color-success) 15%, transparent)',
                color: 'var(--color-success)',
              }}
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
              </svg>
              confirmed
            </span>
          </div>
        </div>
        <h3 className={`sl-display text-[16px] ${isArchived ? 'text-ink-600' : 'text-gray-900'}`}>
          {c.session_title || `Session ${c.day_number}`}
        </h3>
        <p className="sl-mono text-[11px] text-ink-400">
          W{c.week_number}
          {c.week_label ? ` · ${c.week_label}` : ''} · D{c.day_number}
        </p>
        <p className="sl-mono text-[11px] text-ink-400">
          {new Date(c.confirmed_at).toLocaleString()}
        </p>
        {c.notes && (
          <p className="mt-2 text-[13px] text-ink-700 whitespace-pre-wrap">{c.notes}</p>
        )}
      </Link>
    );
  }

  return (
    <div className="p-4 pb-6 space-y-5">
      <div>
        <div className="sl-label text-ink-400">Feed</div>
        <h1 className="sl-display text-[28px] text-gray-900 leading-none mt-1">
          Sessions.
        </h1>
      </div>

      {studentOptions.length > 0 && (
        <label className="flex items-center gap-2">
          <span className="sl-label text-ink-400">Student</span>
          <select
            value={studentFilter}
            onChange={handleFilterChange}
            className="flex-1 rounded-lg border border-ink-200 bg-white px-3 py-1.5 sl-mono text-[13px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
          >
            <option value="">All students</option>
            {studentOptions.map((o) => (
              <option key={o.id} value={o.id}>{o.name}</option>
            ))}
          </select>
        </label>
      )}

      {active.length === 0 && archived.length === 0 && (
        <EmptyState message={studentFilter ? 'No confirmed sessions for this student' : 'No confirmed sessions yet'} />
      )}
      {active.length === 0 && archived.length > 0 && !showArchived && (
        <EmptyState message="No sessions to review — all confirmed sessions are archived." />
      )}

      <div className="space-y-3">{active.map(renderCard)}</div>

      {archived.length > 0 && (
        <button
          onClick={() => setShowArchived((v) => !v)}
          className="w-full sl-mono text-[11px] text-ink-400 hover:text-ink-700 py-2 underline"
        >
          {showArchived
            ? `Hide ${archived.length} archived`
            : `Show ${archived.length} archived`}
        </button>
      )}

      {showArchived && <div className="space-y-3">{archived.map(renderCard)}</div>}
    </div>
  );
}
