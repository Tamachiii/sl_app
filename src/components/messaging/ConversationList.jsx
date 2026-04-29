import { Link } from 'react-router-dom';
import { useI18n } from '../../hooks/useI18n';
import { useAuth } from '../../hooks/useAuth';
import { useConversations, formatMessageStamp } from '../../hooks/useMessages';
import Spinner from '../ui/Spinner';
import EmptyState from '../ui/EmptyState';

function initialsOf(fullName) {
  return (fullName || '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}

/**
 * `linkPrefix`/`linkSuffix` let coach + student callers point at their own
 * thread URL: coach = `/coach/messages/<otherProfileId>`, student = a fixed
 * `/student/messages` (single coach, no list).
 */
export default function ConversationList({ linkBuilder, emptyMessage }) {
  const { t, lang } = useI18n();
  const { user } = useAuth();
  const me = user?.id;
  const { data: conversations, isLoading } = useConversations();

  if (isLoading) {
    return <div className="flex justify-center py-12"><Spinner /></div>;
  }

  if (!conversations || conversations.length === 0) {
    return <EmptyState message={emptyMessage || t('messaging.noConversations')} />;
  }

  return (
    <ul className="space-y-2 list-none p-0 m-0">
      {conversations.map((c) => {
        const fromMe = c.lastMessage.sender_id === me;
        const previewPrefix = fromMe ? `${t('messaging.youPrefix')} ` : '';
        const preview = `${previewPrefix}${c.lastMessage.body}`;
        return (
          <li key={c.otherProfileId}>
            <Link
              to={linkBuilder(c)}
              className="sl-card flex items-center gap-3 px-3.5 py-3 hover:bg-ink-50/50 dark:hover:bg-ink-800 transition-colors"
            >
              <div
                className="w-11 h-11 rounded-full flex items-center justify-center sl-display text-[14px] shrink-0"
                style={{
                  background: 'color-mix(in srgb, var(--color-accent) 15%, transparent)',
                  color: 'var(--color-accent)',
                  border: '1px solid color-mix(in srgb, var(--color-accent) 35%, transparent)',
                }}
                aria-hidden="true"
              >
                {initialsOf(c.otherFullName) || '—'}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2 justify-between">
                  <span className="sl-display text-[15px] text-gray-900 truncate">
                    {c.otherFullName || '—'}
                  </span>
                  <span className="sl-mono text-[10px] text-ink-400 tabular-nums shrink-0">
                    {formatMessageStamp(c.lastMessage.created_at, lang)}
                  </span>
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  <p className="text-[13px] text-ink-700 truncate flex-1">{preview}</p>
                  {c.unreadCount > 0 && (
                    <span
                      className="sl-mono text-[10px] tabular-nums px-2 py-0.5 rounded-full shrink-0"
                      style={{
                        background: 'var(--color-accent)',
                        color: 'var(--color-ink-900)',
                      }}
                      aria-label={t('messaging.unreadAria', { n: c.unreadCount })}
                    >
                      {c.unreadCount}
                    </span>
                  )}
                </div>
              </div>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
