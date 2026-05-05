import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import Spinner from '../ui/Spinner';
import Dialog from '../ui/Dialog';
import ThemeToggle from '../ui/ThemeToggle';
import LanguageSelect from '../ui/LanguageSelect';
import EditableText from '../ui/EditableText';
import { useAuth } from '../../hooks/useAuth';
import { useI18n } from '../../hooks/useI18n';
import { useMyCoach } from '../../hooks/useStudents';
import { useMyGoals } from '../../hooks/useGoals';
import { useStudentLifetimeStats } from '../../hooks/useStudentLifetimeStats';

function initialsOf(name) {
  return (name || '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}

function StatTile({ label, value, mono = true }) {
  return (
    <div className="sl-card p-3 flex flex-col items-start">
      <span className="sl-label text-ink-400">{label}</span>
      <span className={`sl-display text-[24px] text-gray-900 mt-1 tabular-nums ${mono ? '' : ''}`}>{value}</span>
    </div>
  );
}

function ChangePasswordDialog({ open, onClose }) {
  const { t } = useI18n();
  const { updatePassword } = useAuth();
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  function reset() {
    setPw('');
    setPw2('');
    setErr('');
    setBusy(false);
    setDone(false);
  }

  function handleClose() {
    reset();
    onClose();
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setErr('');
    if (pw.length < 8) {
      setErr(t('student.profile.account.pwTooShort'));
      return;
    }
    if (pw !== pw2) {
      setErr(t('student.profile.account.pwMismatch'));
      return;
    }
    setBusy(true);
    const { error } = await updatePassword(pw);
    setBusy(false);
    if (error) {
      setErr(error.message || t('student.profile.account.pwError'));
      return;
    }
    setDone(true);
  }

  return (
    <Dialog open={open} onClose={handleClose} title={t('student.profile.account.changePassword')}>
      {done ? (
        <div className="space-y-4">
          <p className="text-[14px] text-gray-700">{t('student.profile.account.pwChanged')}</p>
          <button
            type="button"
            onClick={handleClose}
            className="sl-btn-primary w-full text-[14px]"
            style={{ padding: '10px 16px' }}
          >
            {t('common.close')}
          </button>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-3">
          <label className="block">
            <span className="sl-label text-ink-400 block mb-1">{t('student.profile.account.newPassword')}</span>
            <input
              type="password"
              autoComplete="new-password"
              value={pw}
              onChange={(e) => setPw(e.target.value)}
              required
              className="w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-[16px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
            />
          </label>
          <label className="block">
            <span className="sl-label text-ink-400 block mb-1">{t('student.profile.account.confirmPassword')}</span>
            <input
              type="password"
              autoComplete="new-password"
              value={pw2}
              onChange={(e) => setPw2(e.target.value)}
              required
              className="w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-[16px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
            />
          </label>
          {err && (
            <p className="text-[13px]" style={{ color: 'var(--color-danger, #c00)' }}>{err}</p>
          )}
          <div className="flex gap-2 pt-1">
            <button
              type="submit"
              disabled={busy}
              className="flex-1 sl-btn-primary text-[14px] disabled:opacity-50"
              style={{ padding: '10px 16px' }}
            >
              {busy ? t('common.saving') : t('common.save')}
            </button>
            <button
              type="button"
              onClick={handleClose}
              className="flex-1 bg-ink-100 text-ink-700 rounded-lg py-2 sl-display text-[14px] hover:bg-ink-200"
            >
              {t('common.cancel')}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

export default function StudentProfile() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { user, profile, signOut, updateProfile } = useAuth();
  const { data: coach } = useMyCoach();
  const { data: goals } = useMyGoals();
  const { data: stats, isLoading: statsLoading } = useStudentLifetimeStats();
  const [pwOpen, setPwOpen] = useState(false);
  const [renameError, setRenameError] = useState('');

  const fullName = profile?.full_name || '';
  const initials = initialsOf(fullName);

  // Goal to surface: first non-achieved goal, or fall back to the most recent one.
  const featuredGoal =
    (goals || []).find((g) => !g.achieved) || (goals && goals[0]) || null;

  async function handleRename(next) {
    setRenameError('');
    if (!next) return;
    const { error } = await updateProfile({ full_name: next });
    if (error) setRenameError(error.message || t('student.profile.header.renameError'));
  }

  return (
    <div className="p-4 pb-6 md:p-8 space-y-5">
      {/* Editorial header matching every other top-level student page —
          kicker + giant display title on the left. The right-hand slot
          (where UserMenu's avatar normally lives) holds a back button
          instead, since the avatar would just navigate to where we already
          are. Hit zone matches the avatar's so muscle memory transfers. */}
      <div className="pt-3 pb-1 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="sl-label text-ink-400">{t('student.profile.kicker')}</div>
          <h1 className="sl-display text-[32px] md:text-[44px] text-gray-900 leading-none mt-1">
            {t('student.profile.title')}
          </h1>
        </div>
        <button
          type="button"
          onClick={() => navigate(-1)}
          aria-label={t('common.back')}
          className="w-10 h-10 rounded-full bg-ink-100 flex items-center justify-center text-ink-700 hover:brightness-95 active:scale-95 transition-transform shrink-0"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
      </div>

      {/* Identity card */}
      <div className="sl-card p-5 flex items-center gap-4">
        <div
          className="w-16 h-16 rounded-full bg-ink-100 flex items-center justify-center sl-display text-[20px] text-ink-900 shrink-0"
          style={{ border: '2px solid var(--color-accent)' }}
          aria-hidden="true"
        >
          {initials || '·'}
        </div>
        <div className="min-w-0 flex-1">
          <div className="sl-label text-ink-400">{t('student.profile.header.displayName')}</div>
          <EditableText
            value={fullName}
            onSave={handleRename}
            placeholder={t('student.profile.header.namePlaceholder')}
            ariaLabel={t('student.profile.header.editName')}
            className="sl-display text-[24px] text-gray-900 block mt-1"
            inputClassName="sl-display text-[20px] w-full"
          />
          {renameError && (
            <p className="text-[12px] mt-1" style={{ color: 'var(--color-danger, #c00)' }}>{renameError}</p>
          )}
        </div>
      </div>

      {/* Coach card */}
      {coach && (
        <div className="sl-card p-4 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="sl-label text-ink-400">{t('student.profile.coach.title')}</div>
            <div className="sl-display text-[18px] text-gray-900 mt-0.5 truncate">{coach.full_name}</div>
          </div>
          <Link
            to={`/student/messages`}
            className="sl-pill shrink-0"
            style={{ background: 'var(--color-accent)', color: 'var(--color-ink-900)' }}
          >
            {t('student.profile.coach.message')}
          </Link>
        </div>
      )}

      {/* Lifetime totals */}
      <section aria-labelledby="profile-lifetime-heading" className="space-y-2">
        <h2 id="profile-lifetime-heading" className="sl-label text-ink-400">{t('student.profile.lifetime.title')}</h2>
        {statsLoading ? (
          <div className="flex justify-center py-6"><Spinner /></div>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            <StatTile
              label={t('student.profile.lifetime.sessions')}
              value={stats?.sessionsCompleted ?? 0}
            />
            <StatTile
              label={t('student.profile.lifetime.setsDone')}
              value={stats?.setsDone ?? 0}
            />
            <StatTile
              label={t('student.profile.lifetime.volumeKg')}
              value={(stats?.totalVolumeKg ?? 0).toLocaleString()}
            />
          </div>
        )}
      </section>

      {/* Featured goal */}
      <section aria-labelledby="profile-goal-heading" className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 id="profile-goal-heading" className="sl-label text-ink-400">{t('student.profile.goal.title')}</h2>
          <Link to="/student/goals" className="sl-mono text-[11px]" style={{ color: 'var(--color-accent)' }}>
            {t('student.profile.goal.viewAll')}
          </Link>
        </div>
        {featuredGoal ? (
          <Link to="/student/goals" className="sl-card p-4 block hover:bg-ink-50 transition-colors">
            <div className="sl-display text-[16px] text-gray-900 truncate">
              {featuredGoal.exercise?.name || t('student.profile.goal.untitled')}
            </div>
            {featuredGoal.notes && (
              <p className="text-[12px] text-gray-700 mt-1 line-clamp-2">{featuredGoal.notes}</p>
            )}
          </Link>
        ) : (
          <p className="sl-card p-4 sl-mono text-[12px] text-ink-400">{t('student.profile.goal.empty')}</p>
        )}
      </section>

      {/* Preferences */}
      <section aria-labelledby="profile-prefs-heading" className="space-y-2">
        <h2 id="profile-prefs-heading" className="sl-label text-ink-400">{t('student.profile.prefs.title')}</h2>
        <div className="sl-card divide-y divide-ink-100">
          <div className="flex items-center justify-between gap-2 px-3 py-2.5">
            <span className="sl-label">{t('common.theme')}</span>
            <ThemeToggle />
          </div>
          <div className="flex items-center justify-between gap-2 px-3 py-2.5">
            <span className="sl-label">{t('common.language')}</span>
            <LanguageSelect />
          </div>
        </div>
      </section>

      {/* Account */}
      <section aria-labelledby="profile-account-heading" className="space-y-2">
        <h2 id="profile-account-heading" className="sl-label text-ink-400">{t('student.profile.account.title')}</h2>
        <div className="sl-card divide-y divide-ink-100">
          <div className="flex items-center justify-between gap-2 px-3 py-2.5">
            <span className="sl-label">{t('student.profile.account.email')}</span>
            <span className="sl-mono text-[12px] text-ink-700 truncate max-w-[60%]">
              {user?.email || '—'}
            </span>
          </div>
          <button
            type="button"
            onClick={() => setPwOpen(true)}
            className="w-full flex items-center justify-between gap-2 px-3 py-2.5 text-left hover:bg-ink-50 transition-colors"
          >
            <span className="sl-label">{t('student.profile.account.changePassword')}</span>
            <span className="sl-mono text-[11px] text-ink-400">→</span>
          </button>
          <button
            type="button"
            onClick={signOut}
            className="w-full flex items-center gap-2 px-3 py-2.5 text-left text-[14px] text-gray-900 hover:bg-ink-50 transition-colors"
          >
            <svg className="w-4 h-4 text-ink-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
            </svg>
            {t('common.signOut')}
          </button>
        </div>
      </section>

      <ChangePasswordDialog open={pwOpen} onClose={() => setPwOpen(false)} />
    </div>
  );
}
