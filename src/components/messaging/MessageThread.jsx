import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { useI18n } from '../../hooks/useI18n';
import {
  useMessageThread,
  useMarkThreadRead,
  useGroupedThread,
  formatMessageStamp,
  useSessionRefsForMessages,
  useDeleteMessage,
} from '../../hooks/useMessages';
import { useStudents } from '../../hooks/useStudents';
import Spinner from '../ui/Spinner';
import EmptyState from '../ui/EmptyState';
import ConfirmDialog from '../ui/ConfirmDialog';
import MessageComposer from './MessageComposer';
import SessionReferenceCard from './SessionReferenceCard';

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
  const { user, role } = useAuth();
  const me = user?.id;
  const { t, lang } = useI18n();
  const navigate = useNavigate();

  const { data: messages, isLoading, isError } = useMessageThread(otherProfileId);
  const markRead = useMarkThreadRead();
  const { mutate: markReadMutate } = markRead;
  const deleteMessage = useDeleteMessage();
  const groups = useGroupedThread(messages);
  const sessionRefs = useSessionRefsForMessages(messages);

  // iMessage-style receipt: the very last outgoing message gets a "Read · {time}"
  // or "Sent" caption underneath. Older outgoing bubbles stay quiet so a long
  // thread doesn't end up dotted with redundant labels.
  const lastFromMe = useMemo(() => {
    if (!messages?.length || !me) return null;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i].sender_id === me) return messages[i];
    }
    return null;
  }, [messages, me]);

  // Press-and-hold a bubble (or right-click on desktop) opens the confirm
  // dialog. `pressingId` powers the slight scale-down feedback while the
  // long-press timer is running.
  const [pendingDeleteId, setPendingDeleteId] = useState(null);
  const [pressingId, setPressingId] = useState(null);
  const pressTimerRef = useRef(null);
  const pressMovedRef = useRef(false);
  const pressOriginRef = useRef(null);
  const pendingMessage = pendingDeleteId
    ? (messages || []).find((m) => m.id === pendingDeleteId) || null
    : null;

  const cancelPress = useCallback(() => {
    if (pressTimerRef.current) {
      clearTimeout(pressTimerRef.current);
      pressTimerRef.current = null;
    }
    setPressingId(null);
    pressMovedRef.current = false;
    pressOriginRef.current = null;
  }, []);

  const startPress = useCallback((messageId, e) => {
    pressMovedRef.current = false;
    pressOriginRef.current = { x: e.clientX, y: e.clientY };
    setPressingId(messageId);
    if (pressTimerRef.current) clearTimeout(pressTimerRef.current);
    pressTimerRef.current = setTimeout(() => {
      pressTimerRef.current = null;
      if (pressMovedRef.current) return;
      // Light haptic on devices that support it — confirms the press fired.
      if (navigator.vibrate) navigator.vibrate(10);
      setPendingDeleteId(messageId);
      setPressingId(null);
    }, 450);
  }, []);

  const movePress = useCallback((e) => {
    const o = pressOriginRef.current;
    if (!o) return;
    const dx = Math.abs(e.clientX - o.x);
    const dy = Math.abs(e.clientY - o.y);
    if (dx > 8 || dy > 8) {
      pressMovedRef.current = true;
      cancelPress();
    }
  }, [cancelPress]);

  useEffect(() => () => {
    if (pressTimerRef.current) clearTimeout(pressTimerRef.current);
  }, []);

  // Coach-side deep-links to a session reference need the students.id row id
  // (the URL is /coach/student/:studentId/session/:sessionId/review). Student-
  // side links go to /student/session/:sessionId — no row id needed.
  const { data: students } = useStudents();
  const studentRowId = useMemo(() => {
    if (role !== 'coach') return null;
    const s = (students || []).find((x) => x.profile_id === otherProfileId);
    return s?.id || null;
  }, [role, students, otherProfileId]);

  function openSessionRef(sessionId) {
    if (!sessionId) return;
    if (role === 'coach' && studentRowId) {
      navigate(`/coach/student/${studentRowId}/session/${sessionId}/review`);
    } else {
      navigate(`/student/session/${sessionId}`);
    }
  }

  const scrollerRef = useRef(null);
  const lastSeenIdRef = useRef(null);
  // Tracks the id of the last incoming message we've already attempted to
  // mark as read for THIS counterpart, so the effect doesn't refire on every
  // re-render. Resets when the thread switches counterparts.
  const lastMarkedIdRef = useRef(null);

  useEffect(() => {
    lastMarkedIdRef.current = null;
    setPendingDeleteId(null);
    cancelPress();
  }, [otherProfileId, cancelPress]);

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
                    const sessionRef = m.session_id ? sessionRefs.get(m.session_id) : null;
                    const canDelete = fromMe && !m.session_id;
                    const showReceipt = fromMe && lastFromMe && m.id === lastFromMe.id;
                    const isPressing = canDelete && pressingId === m.id;
                    const pressHandlers = canDelete
                      ? {
                          onPointerDown: (e) => {
                            // Skip non-primary buttons (right/middle click) — those go through onContextMenu.
                            if (e.button !== 0) return;
                            startPress(m.id, e);
                          },
                          onPointerMove: movePress,
                          onPointerUp: cancelPress,
                          onPointerCancel: cancelPress,
                          onPointerLeave: cancelPress,
                          onContextMenu: (e) => {
                            e.preventDefault();
                            cancelPress();
                            setPendingDeleteId(m.id);
                          },
                        }
                      : null;
                    return (
                      <div key={m.id} className={`flex flex-col gap-1 max-w-[80%] md:max-w-[70%] ${fromMe ? 'items-end' : 'items-start'}`}>
                        {m.session_id && (
                          <SessionReferenceCard
                            sessionId={m.session_id}
                            session={sessionRef}
                            fromMe={fromMe}
                            onOpen={() => openSessionRef(m.session_id)}
                            lang={lang}
                          />
                        )}
                        <div
                          {...pressHandlers}
                          className={`rounded-2xl px-3.5 py-2 text-[14px] leading-snug whitespace-pre-wrap transition-transform duration-150 ${
                            fromMe
                              ? 'bg-[var(--color-accent)] text-[var(--color-ink-900)]'
                              : 'bg-ink-100 text-ink-800'
                          } ${isPressing ? 'scale-95 opacity-80' : ''} ${canDelete ? 'cursor-pointer select-none' : ''}`}
                          style={{
                            ...(fromMe ? { borderBottomRightRadius: 6 } : { borderBottomLeftRadius: 6 }),
                            // Suppress iOS long-press callout (text-selection menu) so
                            // our 450ms timer wins the gesture.
                            ...(canDelete ? { WebkitTouchCallout: 'none' } : null),
                          }}
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
                        {showReceipt && (
                          <div
                            className="sl-mono text-[10px] tabular-nums text-ink-400"
                            aria-live="polite"
                          >
                            {m.read_at
                              ? t('messaging.readReceipt', { when: formatMessageStamp(m.read_at, lang) })
                              : t('messaging.sentReceipt')}
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

      <ConfirmDialog
        open={!!pendingDeleteId}
        onClose={() => setPendingDeleteId(null)}
        onConfirm={() => {
          if (!pendingDeleteId) return;
          deleteMessage.mutate(pendingDeleteId);
          setPendingDeleteId(null);
        }}
        title={t('messaging.deleteTitle')}
        message={
          pendingMessage
            ? t('messaging.deleteConfirm', { preview: pendingMessage.body.slice(0, 80) })
            : t('messaging.deleteConfirmFallback')
        }
        confirmText={t('messaging.delete')}
      />
    </div>
  );
}
