import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import Spinner from '../ui/Spinner';
import EmptyState from '../ui/EmptyState';
import UserMenu from '../ui/UserMenu';
import { useAllConfirmations } from '../../hooks/useSessionConfirmation';
import { useAuth } from '../../hooks/useAuth';
import { useI18n } from '../../hooks/useI18n';

export default function SessionsFeed() {
  const { t } = useI18n();
  const { profile, signOut } = useAuth();
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
                {t('common.archived')}
              </span>
            )}
            <span className="sl-mono text-[11px] text-ink-400">
              {new Date(c.confirmed_at).toLocaleDateString()}
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
        {c.notes && (
          <p className="mt-2 text-[13px] text-ink-700 whitespace-pre-wrap">{c.notes}</p>
        )}
      </Link>
    );
  }

  return (
    <div className="p-4 pb-6 md:p-8 space-y-5">
      <div className="pt-3 pb-1 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="sl-label text-ink-400">{t('coach.sessions.kicker')}</div>
          <h1 className="sl-display text-[28px] md:text-[40px] text-gray-900 leading-none mt-1">
            {t('coach.sessions.title')}
          </h1>
        </div>
        <UserMenu fullName={profile?.full_name} onSignOut={signOut} />
      </div>

      {studentOptions.length > 0 && (
        <label className="flex items-center gap-2">
          <span className="sl-label text-ink-400">{t('coach.sessions.student')}</span>
          <select
            value={studentFilter}
            onChange={handleFilterChange}
            className="flex-1 rounded-lg border border-ink-200 bg-white px-3 py-1.5 sl-mono text-[16px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
          >
            <option value="">{t('coach.sessions.allStudents')}</option>
            {studentOptions.map((o) => (
              <option key={o.id} value={o.id}>{o.name}</option>
            ))}
          </select>
        </label>
      )}

      {active.length === 0 && archived.length === 0 && (
        <EmptyState message={studentFilter ? t('coach.sessions.noneForStudent') : t('coach.sessions.noneYet')} />
      )}
      {active.length === 0 && archived.length > 0 && !showArchived && (
        <EmptyState message={t('coach.sessions.allArchived')} />
      )}

      <div className="space-y-3 md:grid md:grid-cols-2 md:gap-3 md:space-y-0">{active.map(renderCard)}</div>

      {archived.length > 0 && (
        <button
          onClick={() => setShowArchived((v) => !v)}
          className="w-full sl-mono text-[11px] text-ink-400 hover:text-ink-700 py-2 underline"
        >
          {showArchived
            ? t('coach.sessions.hideArchived', { n: archived.length })
            : t('coach.sessions.showArchived', { n: archived.length })}
        </button>
      )}

      {showArchived && (
        <div className="space-y-3 md:grid md:grid-cols-2 md:gap-3 md:space-y-0">{archived.map(renderCard)}</div>
      )}
    </div>
  );
}
