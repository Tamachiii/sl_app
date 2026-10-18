import { useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import Spinner from '../ui/Spinner';
import LanguageSelect from '../ui/LanguageSelect';
import EditableText from '../ui/EditableText';
import { formatNumber, pluralKey } from '../../lib/i18n/format';
import { Avatar, Button, LargeTitle, ListGroup, Row, Sheet } from '../parc';
import { useAuth } from '../../hooks/useAuth';
import { useI18n } from '../../hooks/useI18n';
import { useBackOr } from '../../hooks/useBackOr';
import { useMyCoach } from '../../hooks/useStudents';
import { useMyGoals } from '../../hooks/useGoals';
import { useStudentLifetimeStats } from '../../hooks/useStudentLifetimeStats';
import { usePushSubscription } from '../../hooks/usePushSubscription';

// One figure of the athlete's history, in large condensed digits over what
// it counts.
function Figure({ value, label }) {
  return (
    <div className="min-w-0">
      <div className="pk-condensed pk-tnum text-[36px] font-extrabold leading-none">{value}</div>
      <div className="pk-small mt-1">{label}</div>
    </div>
  );
}

// A wrong password, as GoTrue says it: the code `invalid_credentials`, or a
// bare 400 from a server that predates error codes. A rate limit (429), no
// network (`AuthRetryableFetchError`) or any other refusal says nothing about
// the password, and must not be reported as "wrong".
function isWrongPassword(error) {
  if (error?.code) return error.code === 'invalid_credentials';
  return error?.status === 400;
}

// Whoever holds an unlocked phone holds the session; the current password is
// the proof that it is the athlete. It is checked with a sign-in of the same
// account (`signIn` of `useAuth`): auth-js announces it as a SIGNED_IN of the
// account that is already signed in, which the provider does not act on, and a
// failed one leaves the session as it was. Server-side re-authentication
// ("Secure password change") stays off: it sends a code by e-mail.
function ChangePasswordDialog({ open, onClose }) {
  const { t } = useI18n();
  const { user, signIn, updatePassword } = useAuth();
  const [current, setCurrent] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  // One number per submit, moved on by a close as well: an answer that comes
  // back to a dialog closed since is dropped, and a check that was still on
  // its way when the athlete cancelled goes no further — Cancel means no
  // change. A change already sent cannot be called back.
  const attempt = useRef(0);
  const inFlight = useRef(false);

  function reset() {
    setCurrent('');
    setPw('');
    setPw2('');
    setErr('');
    setBusy(false);
    setDone(false);
  }

  function handleClose() {
    attempt.current += 1;
    inFlight.current = false;
    reset();
    onClose();
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (inFlight.current) return;
    setErr('');
    // Everything that needs no network first: a new password that would be
    // refused must not cost a sign-in attempt.
    if (!current) {
      setErr(t('profilePasswordRecheck.currentMissing'));
      return;
    }
    if (pw.length < 8) {
      setErr(t('student.profile.account.pwTooShort'));
      return;
    }
    if (pw !== pw2) {
      setErr(t('student.profile.account.pwMismatch'));
      return;
    }
    const email = user?.email;
    if (!email) {
      setErr(t('profilePasswordRecheck.checkFailed'));
      return;
    }
    const mine = ++attempt.current;
    const ours = () => attempt.current === mine;
    inFlight.current = true;
    setBusy(true);
    let checked = false;
    try {
      const { error: checkError } = await signIn(email, current);
      if (!ours()) return;
      if (checkError) {
        if (isWrongPassword(checkError)) setErr(t('profilePasswordRecheck.currentWrong'));
        else setErr(t('profilePasswordRecheck.checkFailed'));
        return;
      }
      checked = true;
      const { error } = await updatePassword(pw);
      if (!ours()) return;
      if (error) {
        setErr(error.message || t('student.profile.account.pwError'));
        return;
      }
      setCurrent('');
      setPw('');
      setPw2('');
      setDone(true);
    } catch {
      if (!ours()) return;
      if (checked) setErr(t('student.profile.account.pwError'));
      else setErr(t('profilePasswordRecheck.checkFailed'));
    } finally {
      if (ours()) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  }

  const field = (label, props) => (
    <label className="flex flex-col gap-1.5">
      <span className="pk-caption">{label}</span>
      <input type="password" required className="pk-field" {...props} />
    </label>
  );

  return (
    <Sheet open={open} onClose={handleClose} title={t('student.profile.account.changePassword')}>
      {done ? (
        <div className="flex flex-col gap-4">
          <p className="pk-body m-0">{t('student.profile.account.pwChanged')}</p>
          <Button variant="primary" size="lg" onClick={handleClose}>
            {t('common.close')}
          </Button>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          {field(t('profilePasswordRecheck.currentPassword'), {
            autoComplete: 'current-password',
            value: current,
            onChange: (e) => setCurrent(e.target.value),
          })}
          {field(t('student.profile.account.newPassword'), {
            autoComplete: 'new-password',
            value: pw,
            onChange: (e) => setPw(e.target.value),
          })}
          {field(t('student.profile.account.confirmPassword'), {
            autoComplete: 'new-password',
            value: pw2,
            onChange: (e) => setPw2(e.target.value),
          })}
          {err && (
            <p role="alert" className="m-0 text-[13px] leading-[1.35] text-red">
              {err}
            </p>
          )}
          <div className="flex flex-col gap-1">
            <Button type="submit" variant="primary" size="lg" disabled={busy}>
              {busy ? t('common.saving') : t('common.save')}
            </Button>
            <Button variant="text" onClick={handleClose}>
              {t('common.cancel')}
            </Button>
          </div>
        </form>
      )}
    </Sheet>
  );
}

function RestNotificationToggle() {
  const { t } = useI18n();
  const { supported, enabled, permission, pending, errorKey, enable, disable } = usePushSubscription();

  // Always render the section so users know the feature exists. Body
  // copy adapts to capability + permission state; a live error wins.
  const hint = errorKey
    ? t(errorKey)
    : !supported
      ? t('student.profile.notifications.unsupported')
      : permission === 'denied'
        ? t('student.profile.notifications.denied')
        : t('student.profile.notifications.restTimerHint');

  return (
    <ListGroup title={t('parcProfile.notifications')}>
      <li className="pk-row">
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="pk-headline">{t('parcProfile.restLabel')}</span>
          <span className="pk-caption">{hint}</span>
        </span>
        <Button
          variant={enabled ? 'primary' : 'secondary'}
          onClick={enabled ? disable : enable}
          disabled={pending || !supported || permission === 'denied'}
          aria-pressed={enabled}
          className="shrink-0"
        >
          {pending
            ? t('student.profile.notifications.pending')
            : enabled
              ? t('student.profile.notifications.disable')
              : t('student.profile.notifications.enable')}
        </Button>
      </li>
    </ListGroup>
  );
}

export default function StudentProfile() {
  const { t, lang } = useI18n();
  const nameHintId = useId();
  // Back on the first entry of the tab (a link, a cold start) goes to the
  // athlete's home instead of leaving the app (L31).
  const goBack = useBackOr('/student');
  const { user, profile, signOut, updateProfile } = useAuth();
  const { data: coach } = useMyCoach();
  const { data: goals } = useMyGoals();
  const { data: stats, isLoading: statsLoading } = useStudentLifetimeStats();
  const [pwOpen, setPwOpen] = useState(false);
  const [renameError, setRenameError] = useState('');

  const fullName = profile?.full_name || '';

  // Profile shows a count, not a singular "active goal". Picking one from
  // many would be arbitrary (the previous logic just grabbed the first
  // non-achieved row by created_at) and misleading when several goals are
  // in flight. The count + tap-through to /student/goals is honest and
  // small; richer surfacing (pinning, recent-progress sort) can come later.
  const activeGoalsCount = (goals || []).filter((g) => !g.achieved).length;
  const totalGoalsCount = (goals || []).length;

  async function handleRename(next) {
    setRenameError('');
    if (!next) return;
    const { error } = await updateProfile({ full_name: next });
    if (error) setRenameError(error.message || t('student.profile.header.renameError'));
  }

  const sessions = stats?.sessionsCompleted ?? 0;
  const sets = stats?.setsDone ?? 0;

  return (
    <div className="flex flex-col gap-6 px-4 pt-3 pb-6 md:px-8">
      {/* A page of the athlete's own, reached from the avatar: back where the
          avatar would be, since it would lead here. */}
      <LargeTitle back={{ label: t('common.back'), onClick: goBack }} title={t('parcProfile.title')} />

      <section className="flex items-center gap-4 rounded-group bg-surface p-4">
        <Avatar name={fullName} size={64} />
        <div className="min-w-0 flex-1">
          <h2 className="pk-title m-0">
            <EditableText
              value={fullName}
              onSave={handleRename}
              placeholder={t('student.profile.header.namePlaceholder')}
              ariaLabel={false}
              describedBy={nameHintId}
              inputClassName="!text-[22px] font-bold"
            />
          </h2>
          <p id={nameHintId} className="pk-caption m-0 mt-0.5">
            {t('parcProfile.nameHint')}
          </p>
          {renameError && (
            <p role="alert" className="m-0 mt-1 text-[13px] leading-[1.35] text-red">
              {renameError}
            </p>
          )}
        </div>
      </section>

      {coach && (
        <ListGroup title={t('parcProfile.coach')}>
          <Row
            leading={<Avatar name={coach.full_name} />}
            title={coach.full_name}
            trailing={
              <Button
                as={Link}
                to="/student/messages"
                aria-label={t('parcProfile.writeTo', { name: coach.full_name })}
                className="shrink-0"
              >
                {t('parcProfile.write')}
              </Button>
            }
          />
        </ListGroup>
      )}

      <section aria-labelledby="profile-lifetime-heading" className="flex flex-col gap-2.5">
        <h2 id="profile-lifetime-heading" className="pk-headline">
          {t('parcProfile.lifetime')}
        </h2>
        {statsLoading ? (
          <div className="flex justify-center py-6"><Spinner /></div>
        ) : (
          <div className="grid grid-cols-3 gap-3 rounded-group bg-surface p-4">
            <Figure value={formatNumber(lang, sessions)} label={t(pluralKey(lang, sessions, 'parcProfile.sessions'))} />
            <Figure value={formatNumber(lang, sets)} label={t(pluralKey(lang, sets, 'parcProfile.sets'))} />
            <Figure
              value={formatNumber(lang, Math.round(stats?.totalVolumeKg ?? 0))}
              label={t('parcProfile.volume')}
            />
          </div>
        )}
      </section>

      {/* The bodyweight and the records live on the Stats page
          (design/parc/screens/Stats.dc.html). Goals, and a program to draft
          for the coach to approve (Phase 3.4), are pages of their own. */}
      <ListGroup label={t('parcProfile.goals')}>
        <Row
          to="/student/goals"
          title={t('parcProfile.goals')}
          subtitle={
            totalGoalsCount === 0
              ? t('parcProfile.goalsEmpty')
              : t(pluralKey(lang, activeGoalsCount, 'parcProfile.goalsInProgress'), {
                  n: formatNumber(lang, activeGoalsCount),
                })
          }
        />
        <Row to="/student/author" title={t('parcProfile.draftTitle')} subtitle={t('parcProfile.draftCaption')} />
      </ListGroup>

      <section aria-labelledby="profile-prefs-heading" className="flex flex-col gap-2.5">
        <h2 id="profile-prefs-heading" className="pk-headline">
          {t('parcProfile.prefs')}
        </h2>
        <div className="rounded-group bg-surface p-4">
          <LanguageSelect label={t('common.language')} />
        </div>
      </section>

      <RestNotificationToggle />

      <ListGroup title={t('parcProfile.account')}>
        <Row title={t('student.profile.account.email')} subtitle={user?.email || '–'} />
        <Row onClick={() => setPwOpen(true)} chevron title={t('student.profile.account.changePassword')} />
        <Row onClick={signOut} title={<span className="text-red">{t('common.signOut')}</span>} />
      </ListGroup>

      <ChangePasswordDialog open={pwOpen} onClose={() => setPwOpen(false)} />
    </div>
  );
}
