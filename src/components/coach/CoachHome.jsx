import { useEffect, useMemo, useState } from 'react';
import { Link, Outlet, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { useI18n } from '../../hooks/useI18n';
import { useStudents } from '../../hooks/useStudents';
import { useCoachDashboardPrograms } from '../../hooks/useProgram';
import { useAllConfirmations } from '../../hooks/useSessionConfirmation';
import { useClientErrors } from '../../hooks/useClientErrors';
import { buildRoster } from '../../lib/coachRoster';
import Spinner from '../ui/Spinner';
import EmptyState from '../ui/EmptyState';
import UserMenu from '../ui/UserMenu';
import StudentWeekStrip from './StudentWeekStrip';
import {
  useRememberCoachStudentsPath,
  getLastCoachStudentsPath,
  clearLastCoachStudentsPath,
  studentIdFromPath,
} from '../../hooks/useRememberCoachStudentsPath';

function initialsOf(fullName) {
  return (fullName || '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}

// Attention chips lean on semantic colours (accent / warn / danger), which are
// identical in both themes, so inline color-mix tints adapt without a dark rule.
const CHIP_STYLE = {
  toReview: {
    background: 'color-mix(in srgb, var(--color-accent) 16%, transparent)',
    color: 'var(--color-accent)',
  },
  stale: {
    background: 'color-mix(in srgb, var(--color-warn) 20%, transparent)',
    color: 'var(--color-warn)',
  },
  noProgram: {
    background: 'color-mix(in srgb, var(--color-danger) 16%, transparent)',
    color: 'var(--color-danger)',
  },
};

function chipLabel(chip, t) {
  if (chip.kind === 'toReview') return t('coach.roster.chipReview', { n: chip.n });
  if (chip.kind === 'stale') return t('coach.roster.chipStale', { n: chip.days });
  return t('coach.roster.chipNoProgram');
}

function RosterCard({ entry, t }) {
  const { student, fullName, programName, position, totalSessions, weekDays, chips } = entry;
  const initials = initialsOf(fullName);

  const bits = [];
  // Where the athlete is in the BLOCK. "W3" said nothing about how far along
  // they were once the block stopped being one-week-per-week.
  if (totalSessions > 0) bits.push(t('coach.roster.sessionOf', { n: position, total: totalSessions }));
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
              {chipLabel(chip, t)}
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

function RosterView({ students, t }) {
  const { data: summary } = useCoachDashboardPrograms();
  const { data: confirmations } = useAllConfirmations();
  const { data: clientErrors } = useClientErrors();
  const [query, setQuery] = useState('');

  const roster = useMemo(
    () => buildRoster({ students, summary, confirmations }),
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
          <RosterCard key={entry.student.id} entry={entry} t={t} />
        ))}
      </div>

      {clientErrors && clientErrors.length > 0 && <ErrorsTriage errors={clientErrors} t={t} />}
    </div>
  );
}

// The house title style is an editorial full stop ("Athletes.", "Dashboard.").
// A name that already ends in one — "Khang N.", "Sammy Jr." — must not become
// a double period.
function titleCase(fullName) {
  const name = (fullName || '').trim() || 'Student';
  return name.endsWith('.') ? name : `${name}.`;
}

export default function CoachHome() {
  const { t } = useI18n();
  const { profile, signOut } = useAuth();
  const { studentId } = useParams();
  const navigate = useNavigate();
  const { data: students, isLoading } = useStudents();

  const selected = (students || []).find((s) => s.id === studentId) || null;

  // Remember the athlete (and the session editor under them) so leaving for
  // another nav tab and tapping Athletes again comes back here instead of
  // dumping the coach on the roster. One call covers the editor too: it renders
  // in this component's Outlet, so useLocation() already sees its URL.
  useRememberCoachStudentsPath();

  // …and restore it when we land on the bare roster route. Skipped when the
  // remembered athlete is no longer on the roster, so we never navigate into a
  // dead URL.
  useEffect(() => {
    if (studentId || isLoading) return;
    const saved = getLastCoachStudentsPath();
    const savedStudentId = studentIdFromPath(saved);
    if (!savedStudentId) return;
    if (!(students || []).some((s) => s.id === savedStudentId)) return;
    navigate(saved, { replace: true });
  }, [studentId, isLoading, students, navigate]);

  // ONE header, not two. On an athlete the page header *is* the athlete: the
  // back link takes the kicker slot where "COACH" sits and the name takes the
  // h1 where "Athletes." sits. Stacking a roster title, a back link and a
  // separate identity row put the biggest type on the page you just left and
  // pushed the actual subject three rows down at half the size.
  return (
    <div className="p-4 pb-6 md:p-8 space-y-5">
      <div className="pt-3 pb-1 flex items-start justify-between gap-4">
        {/* The roster and the athlete share ONE header box — same block-level
            kicker, same h1 classes — so moving between them changes the words
            and nothing else. That's also why the back chevron is a mono glyph
            rather than an SVG: an inline-flex icon made the kicker's line box
            taller than the roster's and indented its label off the title's
            left edge, so the header visibly jumped on navigation. */}
        <div className="min-w-0">
          {selected ? (
            <Link
              to="/coach/students"
              // The coach's explicit "I want the roster" signal — forget the
              // remembered path, or the restore effect above would bounce them
              // straight back into the athlete they just left.
              onClick={clearLastCoachStudentsPath}
              className="sl-label text-ink-400 hover:text-ink-700 transition-colors block w-fit"
            >
              <span aria-hidden="true">‹ </span>
              {t('coach.roster.backToAll')}
            </Link>
          ) : (
            <div className="sl-label text-ink-400">{t('coach.roster.kicker')}</div>
          )}
          {/* truncate because a name is unbounded, and no leading-none:
              `truncate` clips at the padding edge and a name has descenders
              the word "Athletes." never did. */}
          <h1 className="sl-display text-[28px] md:text-[40px] text-gray-900 mt-1 truncate pb-0.5">
            {selected ? titleCase(selected.profile?.full_name) : t('coach.roster.title')}
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
              // No tab strip and no identity block: the athlete is ONE page
              // (StudentOverview) under a header that already names them.
              ? <Outlet context={{ student: selected }} />
              : <EmptyState message={t('coach.home.noStudentsExt')} />)
          : <RosterView students={students} t={t} />
      )}
    </div>
  );
}
