import { Link } from 'react-router-dom';
import { useI18n } from '../../hooks/useI18n';

function initialsOf(fullName) {
  return (fullName || '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}

function formatDate(iso, lang) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const locale = lang === 'fr' ? 'fr-FR' : lang === 'de' ? 'de-DE' : 'en-US';
  return d.toLocaleDateString(locale, { year: 'numeric', month: 'short' });
}

/**
 * Athlete identity + the two cross-surface actions, pinned above the tab strip.
 *
 * This used to be a whole tab (StudentProfileSection) holding an avatar, the
 * word "Student", a join date and two links — context and shortcuts, never a
 * destination. As a header it costs no tab and the coach can see WHO they are
 * programming for from every tab, which is exactly when it matters.
 *
 * Deliberately carries no week strip: that data comes from the active-program
 * summary query, so it would contradict the sheet below whenever the coach is
 * editing a non-active block.
 */
export default function StudentHeader({ student }) {
  const { t, lang } = useI18n();
  const fullName = student.profile?.full_name || 'Student';
  const since = formatDate(student.created_at, lang);
  const messageHref = student.profile_id ? `/coach/messages/${student.profile_id}` : null;

  // flex-wrap + a min-width on the identity group: on a narrow phone the two
  // action pills drop to their own line instead of squeezing the name and
  // truncating the "coaching since" meta mid-word.
  return (
    <div className="flex items-center gap-x-3 gap-y-2 flex-wrap">
      <div
        className="w-11 h-11 rounded-full flex items-center justify-center sl-display text-[15px] shrink-0"
        style={{
          background: 'color-mix(in srgb, var(--color-accent) 15%, transparent)',
          color: 'var(--color-accent)',
          border: '1px solid color-mix(in srgb, var(--color-accent) 35%, transparent)',
        }}
        aria-hidden="true"
      >
        {initialsOf(fullName) || '—'}
      </div>

      <div className="min-w-0 flex-1 basis-[150px]">
        <h2 className="sl-display text-[19px] md:text-[21px] text-gray-900 leading-tight truncate">
          {fullName}
        </h2>
        {since && (
          <p className="sl-mono text-[10px] text-ink-400 mt-0.5 truncate">
            {t('coach.profile.coachingSinceLabel')} {since}
          </p>
        )}
      </div>

      <div className="flex items-center gap-1.5 shrink-0 ml-auto">
        <Link
          to={`/coach/sessions?student=${student.id}`}
          className="sl-pill bg-ink-100 text-ink-700 hover:bg-ink-200 transition-colors"
        >
          {t('coach.home.viewSessions')}
        </Link>
        {messageHref && (
          <Link
            to={messageHref}
            className="sl-pill bg-ink-100 text-ink-700 hover:bg-ink-200 transition-colors"
          >
            {t('coach.profile.message')}
          </Link>
        )}
      </div>
    </div>
  );
}
