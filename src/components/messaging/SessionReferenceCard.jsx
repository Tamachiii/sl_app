import { useI18n } from '../../hooks/useI18n';

/**
 * Small "Re: <session>" card rendered above a feedback message bubble. Tap
 * deep-links the viewer to the session — coach → review screen, student →
 * session view (which gates read/write itself).
 *
 * `session` may be null while the metadata query is in flight; we still
 * render a tappable card with a placeholder title so the card position is
 * stable.
 */
export default function SessionReferenceCard({ sessionId, session, fromMe, onOpen, lang = 'en' }) {
  const { t } = useI18n();
  const title = session?.title?.trim() || '—';
  const dateIso = session?.scheduled_date;
  const dateLabel = dateIso ? formatRefDate(dateIso, lang) : null;

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={t('messaging.sessionRefOpen')}
      className={`w-full text-left rounded-xl px-3 py-1.5 text-[12px] flex items-center gap-2 transition-colors ${
        fromMe
          ? 'bg-[color-mix(in_srgb,var(--color-accent)_18%,transparent)] hover:bg-[color-mix(in_srgb,var(--color-accent)_28%,transparent)] text-[var(--color-ink-900)]'
          : 'bg-ink-100 hover:bg-ink-200 text-ink-700'
      }`}
      style={{ border: '1px solid color-mix(in srgb, var(--color-accent) 30%, transparent)' }}
    >
      <svg className="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
      </svg>
      <span className="truncate flex-1 min-w-0">
        {t('messaging.sessionRefLabel', { title })}
        {dateLabel && (
          <span className="ml-1.5 sl-mono text-[10px] opacity-70">· {dateLabel}</span>
        )}
      </span>
    </button>
  );
}

function formatRefDate(iso, lang) {
  // Treat scheduled_date as a calendar date — parse the YYYY-MM-DD without a
  // timezone shift so the displayed date matches what the coach picked.
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return null;
  const locale = lang === 'fr' ? 'fr-FR' : lang === 'de' ? 'de-DE' : 'en-US';
  return d.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
}
