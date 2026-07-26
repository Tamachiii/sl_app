import { useMemo, useState } from 'react';
import { Link, Outlet, useParams } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { useI18n } from '../../hooks/useI18n';
import { useStudents } from '../../hooks/useStudents';
import { useCoachDashboardPrograms } from '../../hooks/useProgram';
import { useAllConfirmations } from '../../hooks/useSessionConfirmation';
import { useClientErrors } from '../../hooks/useClientErrors';
import { buildRoster } from '../../lib/coachRoster';
import { todayDayNumber, startOfWeekMonday, addDays } from '../../lib/day';
import Spinner from '../ui/Spinner';
import EmptyState from '../ui/EmptyState';
import UserMenu from '../ui/UserMenu';
import StudentWeekStrip from './StudentWeekStrip';
import StudentHeader from './StudentHeader';

function initialsOf(fullName) {
  return (fullName || '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}

// Localised short weekday name for a 1..7 day-number in the CURRENT calendar
// week (weekDays is always this Mon..Sun), so a "Missed Wed" chip reads in the
// coach's language instead of a hardcoded English abbreviation.
function weekdayLabel(dayNumber, lang) {
  const locale = lang === 'fr' ? 'fr-FR' : lang === 'de' ? 'de-DE' : 'en-US';
  const d = addDays(startOfWeekMonday(new Date()), dayNumber - 1);
  return d.toLocaleDateString(locale, { weekday: 'short' });
}

// Attention chips lean on semantic colours (accent / warn / danger), which are
// identical in both themes, so inline color-mix tints adapt without a dark rule.
const CHIP_STYLE = {
  toReview: {
    background: 'color-mix(in srgb, var(--color-accent) 16%, transparent)',
    color: 'var(--color-accent)',
  },
  missed: {
    background: 'color-mix(in srgb, var(--color-warn) 20%, transparent)',
    color: 'var(--color-warn)',
  },
  noProgram: {
    background: 'color-mix(in srgb, var(--color-danger) 16%, transparent)',
    color: 'var(--color-danger)',
  },
};

function chipLabel(chip, t, lang) {
  if (chip.kind === 'toReview') return t('coach.roster.chipReview', { n: chip.n });
  if (chip.kind === 'missed') return t('coach.roster.chipMissed', { day: weekdayLabel(chip.day, lang) });
  return t('coach.roster.chipNoProgram');
}

function RosterCard({ entry, t, lang }) {
  const { student, fullName, programName, activeWeek, weekDays, chips } = entry;
  const initials = initialsOf(fullName);

  const bits = [];
  if (activeWeek?.week_number) bits.push(`W${activeWeek.week_number}`);
  if (programName) bits.push(programName);
  const subtitle = bits.join(' · ').toUpperCase();

  return (
    <Link
      to={`/coach/students/${student.id}`}
      aria-label={t('coach.roster.openStudent', { name: fullName })}
      className="block sl-card p-3 hover:bg-ink-50 transition-colors"
    >
      <div className="flex items-center gap-3 min-w-0">
        <div
          className="w-10 h-10 rounded-full flex items-center justify-center sl-display text-[13px] shrink-0"
          style={{
            background: 'color-mix(in srgb, var(--color-accent) 15%, transparent)',
            color: 'var(--color-accent)',
            border: '1px solid color-mix(in srgb, var(--color-accent) 35%, transparent)',
          }}
          aria-hidden="true"
        >
          {initials || '—'}
        </div>
        <div className="min-w-0 flex-1">
          <p className="sl-display text-[16px] text-gray-900 truncate">{fullName}</p>
          {subtitle && (
            <p className="sl-mono text-[11px] text-ink-400 mt-1.5 truncate">{subtitle}</p>
          )}
        </div>
      </div>

      {weekDays && <StudentWeekStrip weekDays={weekDays} className="mt-3" />}

      {chips.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-3">
          {chips.map((chip) => (
            <span
              key={chip.kind}
              className="sl-pill"
              style={CHIP_STYLE[chip.kind]}
            >
              {chipLabel(chip, t, lang)}
            </span>
          ))}
        </div>
      )}
    </Link>
  );
}

function ErrorsTriage({ errors, t }) {
  return (
    <section aria-labelledby="errors-heading" className="space-y-2">
      <details>
        <summary className="sl-label text-ink-400 cursor-pointer">
          <span id="errors-heading">{t('coach.roster.appErrors', { n: errors.length })}</span>
        </summary>
        <ul className="mt-2 space-y-1.5">
          {errors.map((e) => (
            <li key={e.id} className="sl-card p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="sl-mono text-[10px] text-ink-400 uppercase">{e.role || '—'}</span>
                <span className="sl-mono text-[10px] text-ink-400 shrink-0">
                  {new Date(e.created_at).toLocaleString()}
                </span>
              </div>
              <p className="text-[12px] text-gray-900 mt-1 break-words">{e.message}</p>
              {e.url && (
                <p className="sl-mono text-[10px] text-ink-400 mt-0.5 truncate">{e.url}</p>
              )}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}

function RosterView({ students, t, lang }) {
  const { data: summary } = useCoachDashboardPrograms();
  const { data: confirmations } = useAllConfirmations();
  const { data: clientErrors } = useClientErrors();
  const [query, setQuery] = useState('');

  const roster = useMemo(
    () => buildRoster({ students, summary, confirmations, todayDN: todayDayNumber() }),
    [students, summary, confirmations],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return roster;
    return roster.filter(
      (e) =>
        e.fullName.toLowerCase().includes(q) ||
        (e.programName || '').toLowerCase().includes(q),
    );
  }, [roster, query]);

  return (
    <div className="space-y-4">
      <label className="block">
        <span className="sr-only">{t('coach.roster.searchLabel')}</span>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('coach.roster.searchPlaceholder')}
          className="w-full rounded-lg border border-ink-200 bg-white px-3 py-2 sl-mono text-[16px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
        />
      </label>

      {filtered.length === 0 && <EmptyState message={t('coach.roster.noMatches')} />}

      <div className="space-y-2 md:grid md:grid-cols-2 md:gap-2 md:space-y-0">
        {filtered.map((entry) => (
          <RosterCard key={entry.student.id} entry={entry} t={t} lang={lang} />
        ))}
      </div>

      {clientErrors && clientErrors.length > 0 && <ErrorsTriage errors={clientErrors} t={t} />}
    </div>
  );
}

// No tab strip: the athlete is ONE page (StudentOverview) with collapsible
// sections. Tabs made every area a separate destination that remounted and
// scroll-reset, which is what "I lose the page" was describing.
function SelectedStudentView({ student, t }) {
  return (
    <div className="space-y-4">
      <Link
        to="/coach/students"
        className="inline-flex items-center gap-1.5 sl-mono text-[11px] text-ink-400 hover:text-ink-700 transition-colors"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
        </svg>
        {t('coach.roster.backToAll')}
      </Link>
      <StudentHeader student={student} />
      <div>
        <Outlet context={{ student }} />
      </div>
    </div>
  );
}

export default function CoachHome() {
  const { t, lang } = useI18n();
  const { profile, signOut } = useAuth();
  const { studentId } = useParams();
  const { data: students, isLoading } = useStudents();

  const selected = (students || []).find((s) => s.id === studentId) || null;

  return (
    <div className="p-4 pb-6 md:p-8 space-y-5">
      <div className="pt-3 pb-1 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="sl-label text-ink-400">{t('coach.roster.kicker')}</div>
          <h1 className="sl-display text-[28px] md:text-[40px] text-gray-900 leading-none mt-1">
            {t('coach.roster.title')}
          </h1>
        </div>
        <UserMenu fullName={profile?.full_name} onSignOut={signOut} />
      </div>

      {isLoading && (
        <div className="flex justify-center py-12"><Spinner /></div>
      )}

      {!isLoading && (!students || students.length === 0) && (
        <EmptyState message={t('coach.home.noStudentsExt')} />
      )}

      {!isLoading && students && students.length > 0 && (
        studentId
          ? (selected
              ? <SelectedStudentView student={selected} t={t} />
              : <EmptyState message={t('coach.home.noStudentsExt')} />)
          : <RosterView students={students} t={t} lang={lang} />
      )}
    </div>
  );
}
