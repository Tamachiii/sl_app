import { useEffect, useMemo, useState } from 'react';
import { Link, Outlet, useMatch, useNavigate, useParams } from 'react-router-dom';
import { useIsRestoring } from '@tanstack/react-query';
import { useAuth } from '../../hooks/useAuth';
import { useI18n } from '../../hooks/useI18n';
import { useStudents } from '../../hooks/useStudents';
import { useCoachDashboardPrograms } from '../../hooks/useProgram';
import { useReviewCounts } from '../../hooks/useSessionConfirmation';
import { useClientErrors } from '../../hooks/useClientErrors';
import { buildRoster } from '../../lib/coachRoster';
import { readState } from '../../lib/readState';
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import { CoachNotFound, CoachReadProblem } from './CoachPageState';
import Spinner from '../ui/Spinner';
import UserMenu from '../ui/UserMenu';
import { Avatar, Button, Icon, LargeTitle, ListGroup, SearchField, StatusText, WeekDots } from '../parc';
import { useToReviewCount } from '../../hooks/useToReviewCount';
import { todayDayNumber } from '../../lib/day';
import { dayName, formatDateTime, formatNumber, pluralKey } from '../../lib/i18n/format';
import { capitalize } from '../student/sessionModel';
import { weekFromStrip, weekSentence } from '../student/trainingModel';
import {
  useRememberCoachStudentsPath,
  useForgetCoachStudentsPath,
  getLastCoachStudentsPath,
  clearLastCoachStudentsPath,
  studentIdFromPath,
  athletePageOf,
} from '../../hooks/useRememberCoachStudentsPath';

// The most urgent of an athlete's statuses, said in a word and a colour at
// the end of their row (design/parc/components/StatusText): no program before
// sessions to review before silence — the order `buildRoster` ranks them in.
const URGENCY = { noProgram: 3, toReview: 2, stale: 1 };
const TONE = { noProgram: 'alert', toReview: 'review', stale: 'quiet' };

function statusText(chip, t, lang) {
  if (chip.kind === 'toReview') return t('parcRoster.toReview', { n: formatNumber(lang, chip.n) });
  if (chip.kind === 'stale') return t('parcRoster.quiet', { n: formatNumber(lang, chip.days) });
  return t('parcRoster.noProgram');
}

/**
 * One athlete of the roster (screens/RosterTelephone.dc.html): initials, the
 * name, the place in the block, the week in seven dots, and at the right the
 * most urgent status — or, for an athlete with nothing to see to, the day of
 * the next session. The row is ONE target for "open this athlete": a link
 * stretched over it. « n à revoir » is a link of its own, raised above it,
 * to that athlete's sessions in the feed — an anchor cannot sit in an anchor.
 */
function RosterRow({ entry }) {
  const { t, lang } = useI18n();
  const { student, fullName, programName, position, totalSessions, weekDays, chips } = entry;
  const todayDN = todayDayNumber();
  const week = weekDays ? weekFromStrip(weekDays, todayDN) : null;
  const facts = [
    totalSessions > 0
      ? t('parcRoster.sessionOf', { n: formatNumber(lang, position), total: formatNumber(lang, totalSessions) })
      : null,
    programName,
  ].filter(Boolean);
  const chip = chips.slice().sort((a, b) => URGENCY[b.kind] - URGENCY[a.kind])[0] ?? null;
  // A session today comes before any later one.
  const nextDay = week?.todayPlanned ? todayDN : (week?.nextDay ?? null);

  return (
    <li className="relative">
      <div className="pk-row">
        <Avatar name={fullName} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <Link
            to={`/coach/students/${student.id}`}
            className="pk-headline text-ink no-underline after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:after:rounded-control focus-visible:after:outline-2 focus-visible:after:outline-blue"
          >
            {fullName}
          </Link>
          {facts.length > 0 && <span className="pk-caption">{facts.join(', ')}</span>}
          {week && (
            <span className="mt-1">
              <WeekDots days={week.days} label={weekSentence(week, { t, lang })} />
            </span>
          )}
        </span>
        {chip?.kind === 'toReview' ? (
          <Link
            to={`/coach/sessions?student=${student.id}`}
            aria-label={t('parcRoster.toReviewAria', { n: formatNumber(lang, chip.n), name: fullName })}
            className="relative z-10 flex min-h-11 items-center"
          >
            <StatusText tone="review">{statusText(chip, t, lang)}</StatusText>
          </Link>
        ) : chip ? (
          <StatusText tone={TONE[chip.kind]}>{statusText(chip, t, lang)}</StatusText>
        ) : nextDay ? (
          <span className="pk-caption whitespace-nowrap">
            {nextDay === todayDN ? t('parcRoster.today') : capitalize(dayName(lang, nextDay, 'long'))}
          </span>
        ) : null}
      </div>
    </li>
  );
}

/**
 * The app's errors, for the coach who maintains it: a closed row at the end
 * of the roster, opened to read them.
 */
function ErrorsTriage({ errors }) {
  const { t, lang } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <ListGroup title={t('parcRoster.appErrors')}>
      <li>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="pk-row w-full bg-transparent text-left"
        >
          <span className="pk-headline flex-1">
            {t(pluralKey(lang, errors.length, 'parcRoster.errorsCount'), { n: formatNumber(lang, errors.length) })}
          </span>
          <Icon name={open ? 'chevron-up' : 'chevron-down'} size={18} className="shrink-0 text-ink-2" />
        </button>
      </li>
      {open &&
        errors.map((e) => (
          <li key={e.id} className="pk-row flex-col items-start gap-1">
            <span className="pk-caption">
              {[e.role, formatDateTime(lang, e.created_at)].filter(Boolean).join(', ')}
            </span>
            <span className="pk-body break-words">{e.message}</span>
            {e.url && <span className="pk-caption break-all">{e.url}</span>}
          </li>
        ))}
    </ListGroup>
  );
}

// What stands where the rows will be while the athletes' status is read: the
// names are known, but the order is not — an athlete without a program or with
// sessions to review goes to the top — so rows drawn now would jump when the
// answer lands. Nothing in it can be tapped.
function RosterSkeleton({ count }) {
  const { t } = useI18n();
  return (
    <div role="status" aria-busy="true" aria-label={t('coachReviewComposerRoster.roster.loading')}>
      <ul className="pk-group">
        {Array.from({ length: count }, (_, i) => (
          <li key={i} className="pk-row motion-safe:animate-pulse" aria-hidden="true">
            <span className="h-11 w-11 shrink-0 rounded-full bg-fill" />
            <span className="flex flex-1 flex-col gap-2">
              <span className="h-3.5 w-1/2 rounded bg-fill" />
              <span className="h-2.5 w-1/3 rounded bg-fill" />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// The athletes' status — programs, sessions to review — got no answer. The
// rows below show what was read and nothing else: no status is invented for
// what was not.
function RosterStatusNotice({ state, onRetry, retrying }) {
  const { t } = useI18n();
  const offline = state === 'offline';
  return (
    <div role="status" className="flex items-center gap-3 rounded-group bg-surface p-4">
      <div className="min-w-0 flex-1">
        <p className="pk-body font-semibold">
          {offline
            ? t('coachReviewComposerRoster.roster.offlineTitle')
            : t('coachReviewComposerRoster.roster.failedTitle')}
        </p>
        <p className="pk-caption mt-0.5">
          {offline
            ? t('coachReviewComposerRoster.roster.offlineBody')
            : t('coachReviewComposerRoster.roster.failedBody')}
        </p>
      </div>
      <Button onClick={onRetry} disabled={retrying}>
        {t('coachEditorNavErrors.read.retry')}
      </Button>
    </div>
  );
}

function RosterView({ students, online, restoring }) {
  const { t, lang } = useI18n();
  const summaryRead = useCoachDashboardPrograms();
  // How many sessions wait for a review, per athlete — counted by the
  // database, or from the inbox alone: the chips need no history.
  const countsRead = useReviewCounts();
  const { data: clientErrors } = useClientErrors();
  const [query, setQuery] = useState('');

  // The two coach-wide reads the chips and the order come from. A read that
  // has not answered is null — unknown, never "nobody has a program" (review
  // items P48, N16) — and data, however old, wins over a refresh that failed.
  // The app-errors list is not part of it: it flags no athlete.
  const statusState = readState([summaryRead, countsRead], { online, restoring });
  const summary = summaryRead.data ?? null;
  const reviewCounts = countsRead.data ?? null;
  const missingReads = [summaryRead, countsRead].filter((read) => read.data == null);

  const roster = useMemo(
    () => buildRoster({ students, summary, reviewCounts }),
    [students, summary, reviewCounts],
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

  const loading = statusState === 'loading';
  // Priority first (design/parc/README.md: « À suivre » before « À jour »),
  // in the order `buildRoster` gives.
  const toFollow = filtered.filter((e) => e.hasAttention);
  const upToDate = filtered.filter((e) => !e.hasAttention);
  const count = (n) => t(pluralKey(lang, n, 'parcRoster.athletesCount'), { n: formatNumber(lang, n) });

  return (
    <div className="flex flex-col gap-4">
      <SearchField label={t('parcRoster.search')} value={query} onChange={(e) => setQuery(e.target.value)} />

      {(statusState === 'offline' || statusState === 'failed') && (
        <RosterStatusNotice
          state={statusState}
          onRetry={() => missingReads.forEach((read) => read.refetch({ cancelRefetch: false }))}
          retrying={missingReads.some((read) => read.isFetching)}
        />
      )}

      {loading ? (
        <RosterSkeleton count={students.length} />
      ) : filtered.length === 0 ? (
        <p className="rounded-group bg-surface p-4 pk-body">{t('parcRoster.noMatches')}</p>
      ) : (
        <div className="flex flex-col gap-6 lg:grid lg:grid-cols-2 lg:items-start">
          {toFollow.length > 0 && (
            <ListGroup title={t('parcRoster.toFollow')} aside={count(toFollow.length)}>
              {toFollow.map((entry) => (
                <RosterRow key={entry.student.id} entry={entry} />
              ))}
            </ListGroup>
          )}
          {/* « Up to date » says there is nothing to see to: not said of an
              athlete whose program or sessions to review were not read. */}
          {upToDate.length > 0 && (
            <ListGroup
              title={missingReads.length > 0 ? t('parcRoster.others') : t('parcRoster.upToDate')}
              aside={count(upToDate.length)}
            >
              {upToDate.map((entry) => (
                <RosterRow key={entry.student.id} entry={entry} />
              ))}
            </ListGroup>
          )}
        </div>
      )}

      {clientErrors && clientErrors.length > 0 && <ErrorsTriage errors={clientErrors} />}
    </div>
  );
}

export default function CoachHome() {
  const { t, lang } = useI18n();
  const { profile, signOut } = useAuth();
  const { studentId } = useParams();
  const navigate = useNavigate();
  const studentsRead = useStudents();
  const { data: students, isLoading } = studentsRead;
  const online = useOnlineStatus();
  const restoring = useIsRestoring();

  const selected = (students || []).find((s) => s.id === studentId) || null;
  // What the page has to show. A read that got no answer is not an empty
  // roster: it used to say "No students yet" to a coach who has athletes.
  const rosterState = students ? 'ready' : readState([studentsRead], { online, restoring });
  // The roster was read and this athlete is not on it: a link gone stale, or
  // an athlete who now trains with another coach.
  const unknownAthlete = rosterState === 'ready' && !!studentId && !selected;

  // Remember the athlete (and the session editor under them) so leaving for
  // another nav tab and tapping Athletes again comes back here instead of
  // dumping the coach on the roster. One call covers the editor too: it renders
  // in this component's Outlet, so useLocation() already sees its URL. The
  // memory lasts one launch: a cold start opens on the roster.
  useRememberCoachStudentsPath();
  // …but never an athlete who is not there, or every tap on Athletes would
  // open this "not found" again.
  useForgetCoachStudentsPath(unknownAthlete);

  // …and restore it when we land on the bare roster route: the ATHLETE PAGE
  // of what was remembered, never the session editor beneath it. Skipped when
  // the remembered athlete is no longer on the roster, so we never navigate
  // into a dead URL. "‹ All athletes" and a tap on the Athletes tab while it is
  // open both clear the memory first, which is what keeps the roster on screen.
  useEffect(() => {
    if (studentId || isLoading) return;
    const target = athletePageOf(getLastCoachStudentsPath());
    const savedStudentId = studentIdFromPath(target);
    if (!savedStudentId) return;
    if (!(students || []).some((s) => s.id === savedStudentId)) return;
    navigate(target, { replace: true });
  }, [studentId, isLoading, students, navigate]);

  // How many athletes and sessions to review, under the title.
  const reviewTotal = useToReviewCount();
  const facts = [];
  if (students) facts.push(t(pluralKey(lang, students.length, 'parcRoster.athletesCount'), { n: formatNumber(lang, students.length) }));
  if (reviewTotal) facts.push(t(pluralKey(lang, reviewTotal, 'parcRoster.sessionsToReview'), { n: formatNumber(lang, reviewTotal) }));

  // ONE header, not two. On an athlete the page header *is* the athlete: the
  // back button to the roster and the athlete's name as the h1. Stacking a
  // roster title, a back link and a separate identity row put the biggest type
  // on the page you just left and pushed the actual subject down at half the
  // size.
  const menu = <UserMenu fullName={profile?.full_name} onSignOut={signOut} />;
  // The session editor is a page of its own (design/parc/screens/
  // Editeur.dc.html): its title is the session, and the athlete's header
  // stands aside while it is shown. While the athlete is not known yet, or
  // not found, the page keeps its own header and its way back.
  const inEditor = !!useMatch('/coach/students/:studentId/s/:sessionId');
  return (
    <div className="flex flex-col gap-6 px-4 pt-3 pb-6 md:px-8">
      {inEditor && selected && rosterState === 'ready' ? null : selected ? (
        <LargeTitle
          title={(selected.profile?.full_name || '').trim() || t('parcRoster.unnamed')}
          back={{
            label: t('parcRoster.allAthletes'),
            as: Link,
            to: '/coach/students',
            // The coach's explicit "I want the roster" signal — forget the
            // remembered path, or the restore effect above would bounce them
            // straight back into the athlete they just left.
            onClick: clearLastCoachStudentsPath,
          }}
          actions={menu}
        />
      ) : (
        <LargeTitle
          title={t('nav.athletes')}
          subtitle={facts.length > 0 ? facts.join(', ') : null}
          trailing={menu}
        />
      )}

      {rosterState === 'loading' && (
        <div className="flex justify-center py-12"><Spinner /></div>
      )}

      {(rosterState === 'offline' || rosterState === 'failed') && (
        <CoachReadProblem
          state={rosterState}
          onRetry={() => studentsRead.refetch({ cancelRefetch: false })}
          retrying={studentsRead.isFetching}
        />
      )}

      {unknownAthlete && (
        <CoachNotFound
          title={t('coachEditorNavErrors.athlete.notFoundTitle')}
          body={t('coachEditorNavErrors.athlete.notFoundBody')}
          to="/coach/students"
          onLeave={clearLastCoachStudentsPath}
          linkLabel={t('parcRoster.allAthletes')}
        />
      )}

      {rosterState === 'ready' && !studentId && students.length === 0 && (
        <p className="rounded-group bg-surface p-4 pk-body">{t('parcRoster.empty')}</p>
      )}

      {rosterState === 'ready' && (
        studentId
          // No tab strip and no identity block: the athlete is ONE page
          // (StudentOverview) under a header that already names them.
          ? selected && <Outlet context={{ student: selected }} />
          : students.length > 0 && <RosterView students={students} online={online} restoring={restoring} />
      )}
    </div>
  );
}
