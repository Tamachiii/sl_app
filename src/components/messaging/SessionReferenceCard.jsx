import { useI18n } from '../../hooks/useI18n';
import { parseISODate } from '../../lib/day';
import { formatDate } from '../../lib/i18n/format';
import { capitalize } from '../student/sessionModel';

/**
 * The session a feedback message is about, as a card above the message
 * (design/parc/screens/Conversation.dc.html): « À propos de la séance », its
 * title, the day it was planned for. A tap opens it — the review for the
 * coach, the session for the athlete (which gates read/write itself).
 *
 * `session` may be null while its read is on its way: the card is drawn all
 * the same, so it does not move.
 */
export default function SessionReferenceCard({ session, onOpen }) {
  const { t, lang } = useI18n();
  const title = session?.title?.trim() || t('parcMessages.sessionUntitled');
  const date = session?.scheduled_date ? parseISODate(session.scheduled_date) : null;

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={t('parcMessages.openSession', { title })}
      className="flex w-full min-w-[220px] flex-col items-start gap-0.5 rounded-group border border-line bg-surface px-4 py-3 text-left text-ink hover:bg-fill"
    >
      <span className="text-[13px] font-bold leading-[1.35] text-blue">{t('parcMessages.sessionKicker')}</span>
      <span className="pk-headline">{title}</span>
      {date && (
        <span className="pk-caption">
          {capitalize(formatDate(lang, date, { weekday: 'long', day: 'numeric', month: 'long' }))}
        </span>
      )}
    </button>
  );
}
