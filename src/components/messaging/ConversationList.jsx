import { Link } from 'react-router-dom';
import { useI18n } from '../../hooks/useI18n';
import { useAuth } from '../../hooks/useAuth';
import { useConversations, formatMessageStamp } from '../../hooks/useMessages';
import { formatNumber, pluralKey } from '../../lib/i18n/format';
import Spinner from '../ui/Spinner';
import { Avatar, Count } from '../parc';

/**
 * The coach's conversations (design/parc/screens/MessagesCoach.dc.html): one
 * row per counterpart, the newest first — the avatar, the name and the time of
 * the last message, the message itself (« Toi : … » when it is the coach's),
 * in ink with its count while it is unread. `linkBuilder` gives the thread's
 * address; `query` keeps the conversations whose name holds it.
 */
export default function ConversationList({ linkBuilder, emptyMessage, query = '' }) {
  const { t, lang } = useI18n();
  const { user } = useAuth();
  const me = user?.id;
  const { data: conversations, isLoading } = useConversations();

  if (isLoading) {
    return <div className="flex justify-center py-12"><Spinner /></div>;
  }

  if (!conversations || conversations.length === 0) {
    return <p className="rounded-group bg-surface p-4 pk-body">{emptyMessage || t('parcMessages.noConversationStudent')}</p>;
  }

  const q = query.trim().toLowerCase();
  const shown = q
    ? conversations.filter((c) => (c.otherFullName || '').toLowerCase().includes(q))
    : conversations;

  if (shown.length === 0) {
    return <p className="rounded-group bg-surface p-4 pk-body">{t('parcMessages.noMatch')}</p>;
  }

  return (
    <ul className="pk-group" aria-label={t('parcMessages.listLabel')}>
      {shown.map((c) => {
        const fromMe = c.lastMessage.sender_id === me;
        const preview = fromMe ? t('parcMessages.you', { text: c.lastMessage.body }) : c.lastMessage.body;
        const name = (c.otherFullName || '').trim() || t('parcMessages.unknown');
        const unread = c.unreadCount > 0;
        return (
          <li key={c.otherProfileId}>
            <Link to={linkBuilder(c)} className="pk-row text-ink no-underline">
              <Avatar name={name} />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex items-baseline justify-between gap-2">
                  <span className="pk-headline truncate">{name}</span>
                  <span className="pk-small pk-tnum shrink-0">
                    <span className="sr-only">, </span>
                    {formatMessageStamp(c.lastMessage.created_at, lang)}
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  <span className={`min-w-0 flex-1 truncate text-[14px] leading-[1.4] ${unread ? 'font-semibold text-ink' : 'text-ink-2'}`}>
                    <span className="sr-only">, </span>
                    {preview}
                  </span>
                  {unread && (
                    <>
                      <span className="sr-only">, </span>
                      <Count
                        count={c.unreadCount}
                        countLabel={t(pluralKey(lang, c.unreadCount, 'parcMessages.unreadMessages'), {
                          n: formatNumber(lang, c.unreadCount),
                        })}
                      />
                    </>
                  )}
                </span>
              </span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
