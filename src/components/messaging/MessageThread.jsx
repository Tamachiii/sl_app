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
import { useOnlineStatus } from '../../hooks/useOnlineStatus';
import Spinner from '../ui/Spinner';
import { ConfirmSheet } from '../parc';
import MessageComposer from './MessageComposer';
import SessionReferenceCard from './SessionReferenceCard';

// A reader within this distance of the end of the thread is reading the
// latest messages, and a new one scrolls the thread for them.
const NEAR_BOTTOM_PX = 80;

/**
 * Renders the message history with `otherProfileId` plus a sticky composer.
 *
 * Scrolls to the bottom on first paint, on a message of mine, and on a new
 * message when the reader was at the bottom — a reader scrolled up into the
 * history stays where they are. Marks the visible incoming messages as read
 * while the thread is mounted.
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
  const isOnline = useOnlineStatus();
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

  const startPress = useCallback(
    (messageId, e) => {
      // Deleting a message is online-only (it is not offline-queued), so
      // offline the long-press simply doesn't arm — better than opening a
      // dialog whose confirm would pause forever.
      if (!isOnline) return;
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
    },
    [isOnline],
  );

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
  // Whether the reader was at the end of the thread at their last scroll.
  // True until they scroll, so a thread opens at its bottom.
  const nearBottomRef = useRef(true);
  // Tracks the id of the last incoming message we've already attempted to
  // mark as read for THIS counterpart, so the effect doesn't refire on every
  // re-render. Resets when the thread switches counterparts.
  const lastMarkedIdRef = useRef(null);

  useEffect(() => {
    lastMarkedIdRef.current = null;
    // CoachMessages switches counterparts without remounting the thread: the
    // next one opens at its bottom too.
    nearBottomRef.current = true;
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

  function handleScroll(e) {
    const el = e.currentTarget;
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
  }

  // Scroll to the bottom on first paint, and when a new message arrives if it
  // is mine or the reader was at the bottom. A reader who scrolled up to read
  // the history is not pulled down by the other side's message.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || !messages?.length) return;
    const last = messages[messages.length - 1];
    if (lastSeenIdRef.current === last.id) return;
    lastSeenIdRef.current = last.id;
    if (last.sender_id !== me && !nearBottomRef.current) return;
    // RAF so we measure after the new bubble lays out.
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }, [messages, me]);

  const name = (otherFullName || '').trim();
  const note = (text) => <p className="pk-body py-6 text-center text-ink-2">{text}</p>;

  // The conversation (design/parc/screens/Conversation.dc.html): their
  // messages on `surface` at the left, mine on `blue` at the right, each run
  // of one sender with its time under it.
  return (
    <div className={`flex flex-col min-h-0 flex-1 ${className}`}>
      {headerSlot && (
        <div className="shrink-0 pb-3 px-4 md:px-8">{headerSlot}</div>
      )}

      <div
        ref={scrollerRef}
        onScroll={handleScroll}
        className="flex-1 min-h-0 overflow-y-auto px-4 py-3 md:px-8"
        role="log"
        aria-live="polite"
        aria-label={name ? t('parcMessages.threadLabel', { name }) : t('parcMessages.title')}
      >
        {isLoading && (
          <div className="flex justify-center py-6"><Spinner /></div>
        )}

        {isError && note(t('parcMessages.loadError'))}

        {!isLoading && !isError && (!messages || messages.length === 0) && note(t('parcMessages.empty'))}

        {!isLoading && !isError && messages && messages.length > 0 && (
          <div className="flex flex-col gap-4 pb-2">
            {groups.map((group, gi) => {
              const fromMe = group.senderId === me;
              return (
                <div
                  key={`${group.senderId}-${gi}`}
                  className={`flex flex-col gap-2 ${fromMe ? 'items-end' : 'items-start'}`}
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
                            if (!isOnline) return;
                            setPendingDeleteId(m.id);
                          },
                        }
                      : null;
                    return (
                      <div key={m.id} className={`flex max-w-[80%] flex-col gap-1 md:max-w-[70%] ${fromMe ? 'items-end' : 'items-start'}`}>
                        {m.session_id && (
                          <SessionReferenceCard
                            sessionId={m.session_id}
                            session={sessionRef}
                            onOpen={() => openSessionRef(m.session_id)}
                          />
                        )}
                        <p
                          {...pressHandlers}
                          className={`m-0 px-3.5 py-2.5 text-[16px] leading-[1.4] whitespace-pre-wrap wrap-anywhere transition-transform duration-150 ${
                            fromMe
                              ? 'rounded-[20px_20px_6px_20px] bg-blue text-on-blue'
                              : 'rounded-[20px_20px_20px_6px] bg-surface text-ink'
                          } ${isPressing ? 'scale-95 opacity-80' : ''} ${canDelete ? 'cursor-pointer select-none' : ''}`}
                          style={canDelete ? { WebkitTouchCallout: 'none' } : undefined}
                        >
                          {m.body}
                        </p>
                        {isLastInGroup && (
                          <p className="pk-small pk-tnum m-0">
                            {formatMessageStamp(m.created_at, lang)}
                          </p>
                        )}
                        {showReceipt && (
                          <p className="pk-small pk-tnum m-0" aria-live="polite">
                            {m.read_at
                              ? t('parcMessages.read', { when: formatMessageStamp(m.read_at, lang) })
                              : t('parcMessages.sent')}
                          </p>
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
        <MessageComposer recipientProfileId={otherProfileId} recipientName={otherFullName} />
      </div>

      <ConfirmSheet
        open={!!pendingDeleteId}
        onClose={() => setPendingDeleteId(null)}
        onConfirm={() => {
          if (!pendingDeleteId) return;
          deleteMessage.mutate(pendingDeleteId);
          setPendingDeleteId(null);
        }}
        title={t('parcMessages.deleteTitle')}
        message={
          pendingMessage
            ? t('parcMessages.deleteMessage', { preview: pendingMessage.body.slice(0, 80) })
            : t('parcMessages.deleteMessageFallback')
        }
        confirmText={t('parcMessages.delete')}
      />
    </div>
  );
}
