import { useNavigate, useOutletContext } from 'react-router-dom';
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
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const locale = lang === 'fr' ? 'fr-FR' : lang === 'de' ? 'de-DE' : 'en-US';
  return d.toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric' });
}

export default function StudentProfileSection() {
  const { student } = useOutletContext();
  const { t, lang } = useI18n();
  const navigate = useNavigate();

  const fullName = student.profile?.full_name || 'Student';
  const since = formatDate(student.created_at, lang);
  // Profile owns both surfaces:
  //  - "View sessions" → SessionsFeed pre-filtered to this student (uses
  //    students.id, the row id used in coach URLs)
  //  - "Message"       → opens the thread on the dedicated Messages tab
  //    (uses profiles.id, the recipient/sender key the messages table runs on)
  const sessionsHref = `/coach/sessions?student=${student.id}`;
  const messageHref = student.profile_id
    ? `/coach/messages/${student.profile_id}`
    : null;

  return (
    <div className="sl-card p-4 md:p-6 space-y-4">
      <div className="flex items-center gap-3">
        <div
          className="w-14 h-14 rounded-full flex items-center justify-center sl-display text-[18px] shrink-0"
          style={{
            background: 'color-mix(in srgb, var(--color-accent) 15%, transparent)',
            color: 'var(--color-accent)',
            border: '1px solid color-mix(in srgb, var(--color-accent) 35%, transparent)',
          }}
          aria-hidden="true"
        >
          {initialsOf(fullName) || '—'}
        </div>
        <div className="min-w-0 flex-1">
          <div className="sl-display text-[20px] md:text-[22px] text-gray-900 leading-tight truncate">
            {fullName}
          </div>
          <div className="sl-label text-ink-400 mt-1">
            {t('coach.profile.roleStudent')}
          </div>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => navigate(sessionsHref)}
          className="sl-pill bg-ink-100 text-ink-700 hover:bg-ink-200"
        >
          {t('coach.home.viewSessions')}
        </button>
        <button
          type="button"
          onClick={() => messageHref && navigate(messageHref)}
          disabled={!messageHref}
          className="sl-pill bg-ink-100 text-ink-700 hover:bg-ink-200 disabled:opacity-50"
        >
          {t('coach.profile.message')}
        </button>
      </div>

      <div className="sl-hairline -mx-4 md:-mx-6" />

      <div>
        <div className="sl-label text-ink-400">{t('coach.profile.coachingSinceLabel')}</div>
        <div className="sl-mono text-[13px] text-ink-700 tabular-nums mt-1">{since}</div>
      </div>
    </div>
  );
}
