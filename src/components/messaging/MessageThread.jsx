import { useEffect, useRef } from 'react';
import { useAuth } from '../../hooks/useAuth';
import { useI18n } from '../../hooks/useI18n';
import {
  useMessageThread,
  useMarkThreadRead,
  useGroupedThread,
  formatMessageStamp,
} from '../../hooks/useMessages';
import Spinner from '../ui/Spinner';
import EmptyState from '../ui/EmptyState';
import MessageComposer from './MessageComposer';

/**
 * Renders the message history with `otherProfileId` plus a sticky composer.
 *
 * Auto-scrolls to the bottom on first paint and on new messages, and marks
 * the visible incoming messages as read while the thread is mounted.
 *
 * `headerSlot` is optional — pages can put a back arrow / counterpart label /
 * archive pill there. Inside a tab body we render with no header.
 */
export default function MessageThread({ otherProfileId, otherFullName, headerSlot, className = '' }) {
  const { user } = useAuth();
  const me = user?.id;
  const { t, lang } = useI18n();

  const { data: messages, isLoading, isError } = useMessageThread(otherProfileId);
  const markRead = useMarkThreadRead();
  const { mutate: markReadMutate } = markRead;
  const groups = useGroupedThread(messages);

  const scrollerRef = useRef(null);
  const lastSeenIdRef = useRef(null);
  // Tracks the id of the last incoming message we've already attempted to
  // mark as read for THIS counterpart, so the effect doesn't refire on every
  // re-render. Resets when the thread switches counterparts.
  const lastMarkedIdRef = useRef(null);

  useEffect(() => {
    lastMarkedIdRef.current = null;
  }, [otherProfileId]);

  // Mark unread incoming messages as read whenever the thread is mounted +
  // a new unread incoming message arrives. The ref guard makes this a noop
  // when nothing new has come in (otherwise React-Query invalidations
  // re-render us with a fresh `messages` array reference and we'd loop).
  useEffect(() => {
    if (!otherProfileId || !me || !messages?.length) return;
    const lastIncomingUnread = [...messages]
      .reverse()
      .find((m) => m.sender_id === otherProfileId && m.recipient_id === me && !m.read_at);
    if (!lastIncomingUnread) return;
    if (lastMarkedIdRef.current === lastIncomingUnread.id) return;
    lastMarkedIdRef.current = lastIncomingUnread.id;
    markReadMutate(otherProfileId);
  }, [otherProfileId, me, messages, markReadMutate]);

  // Auto-scroll to bottom on initial load and when a new message arrives.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || !messages?.length) return;
    const lastId = messages[messages.length - 1].id;
    if (lastSeenIdRef.current === lastId) return;
    lastSeenIdRef.current = lastId;
    // RAF so we measure after the new bubble lays out.
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }, [messages]);

  return (
    <div className={`flex flex-col min-h-0 flex-1 ${className}`}>
      {headerSlot && (
        <div className="shrink-0 pb-3 px-4 md:px-8">{headerSlot}</div>
      )}

      <div
        ref={scrollerRef}
        className="flex-1 min-h-0 overflow-y-auto px-4 md:px-8"
        role="log"
        aria-live="polite"
        aria-label={t('messaging.threadLabel', { name: otherFullName || '—' })}
      >
        {isLoading && (
          <div className="flex justify-center py-6"><Spinner /></div>
        )}

        {isError && (
          <EmptyState message={t('messaging.loadError')} />
        )}

        {!isLoading && !isError && (!messages || messages.length === 0) && (
          <EmptyState message={t('messaging.empty')} />
        )}

        {!isLoading && !isError && messages && messages.length > 0 && (
          <div className="space-y-3 pb-2">
            {groups.map((group, gi) => {
              const fromMe = group.senderId === me;
              return (
                <div
                  key={`${group.senderId}-${gi}`}
                  className={`flex flex-col gap-1 ${fromMe ? 'items-end' : 'items-start'}`}
                >
                  {group.messages.map((m, mi) => {
                    const isLastInGroup = mi === group.messages.length - 1;
                    return (
                      <div
                        key={m.id}
                        className={`max-w-[80%] md:max-w-[70%] rounded-2xl px-3.5 py-2 text-[14px] leading-snug whitespace-pre-wrap ${
                          fromMe
                            ? 'bg-[var(--color-accent)] text-[var(--color-ink-900)]'
                            : 'bg-ink-100 text-ink-800'
                        }`}
                        style={fromMe ? { borderBottomRightRadius: 6 } : { borderBottomLeftRadius: 6 }}
                      >
                        {m.body}
                        {isLastInGroup && (
                          <div
                            className={`sl-mono text-[10px] mt-1 tabular-nums ${
                              fromMe ? 'opacity-70' : 'text-ink-400'
                            }`}
                          >
                            {formatMessageStamp(m.created_at, lang)}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="shrink-0" style={{ paddingBottom: 'var(--kb-inset, 0px)' }}>
        <MessageComposer recipientProfileId={otherProfileId} />
      </div>
    </div>
  );
}
