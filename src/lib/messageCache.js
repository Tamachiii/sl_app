import {
  createDeletedIds,
  createdAt,
  isWhole,
  mergeRow,
  patchCached,
  pickRow,
} from './realtimeCache';

// The messages cache, kept up to date one change at a time: a message that
// arrives, is read or is deleted changes the entries that show it and nothing
// else. The realtime channel, the send, the delete and the mark-read all go
// through here, and applying one change twice leaves the cache as once.

export const MESSAGES_ROOT = 'messages';

/** The newest messages of a pair that its thread holds. */
export const THREAD_LIMIT = 500;

/** The columns of `messages`, which is every column the thread caches. */
export const MESSAGE_COLUMNS = Object.freeze([
  'id', 'sender_id', 'recipient_id', 'body', 'session_id', 'read_at', 'created_at',
]);
const FEEDBACK_COLUMNS = Object.freeze(MESSAGE_COLUMNS.filter((column) => column !== 'read_at'));
const TIMESTAMPS = Object.freeze(['read_at', 'created_at']);

/**
 * Build the (a,b)-symmetric pair key used for the thread query: order the two
 * uuids deterministically so /coach→student and /student→coach share the
 * same cache entry.
 */
export function pairKey(a, b) {
  if (!a || !b) return null;
  return a < b ? [a, b] : [b, a];
}

export const messageKeys = {
  thread: (me, other) => [MESSAGES_ROOT, 'thread', ...(pairKey(me, other) || [me, other])],
  conversations: (me) => [MESSAGES_ROOT, 'conversations', me],
  unreadCount: (me) => [MESSAGES_ROOT, 'unread-count', me],
  sessionFeedback: (sessionId) => [MESSAGES_ROOT, 'session-feedback', sessionId],
  feedbackSessionIds: (me) => [MESSAGES_ROOT, 'my-feedback-session-ids', me],
};

/**
 * The bindings of the messages channel: the rows I receive, the rows I send —
 * so a row of someone else's pair never reaches this client — and the
 * deletions, which Realtime does not filter on a column: what a deletion
 * carries under row-level security is the id and nothing else.
 */
export function messageBindings(me) {
  return [
    { event: '*', schema: 'public', table: 'messages', filter: `recipient_id=eq.${me}` },
    { event: '*', schema: 'public', table: 'messages', filter: `sender_id=eq.${me}` },
    { event: 'DELETE', schema: 'public', table: 'messages' },
  ];
}

/** The order of the conversation list: the latest message first. */
export function compareConversations(a, b) {
  return new Date(b.lastMessage.created_at).getTime() - new Date(a.lastMessage.created_at).getTime();
}

const deletedIds = createDeletedIds();

/** `a` was created strictly after `b`, both times known. */
function isAfter(a, b) {
  const timeA = createdAt(a);
  const timeB = createdAt(b);
  return timeA !== null && timeB !== null && timeA > timeB;
}

function unreadForMe(message, me) {
  return !!message && message.recipient_id === me && !message.read_at;
}

/**
 * `row` in `thread` (oldest first): merged over the cached row of the same id,
 * or — for a new message — put in its place by time and the oldest dropped
 * past THREAD_LIMIT. The same array when nothing changes.
 */
export function placeInThread(thread, row, { insert }) {
  if (!Array.isArray(thread)) return thread;
  const index = thread.findIndex((m) => m.id === row.id);
  if (index >= 0) {
    const merged = mergeRow(thread[index], row);
    if (merged === thread[index]) return thread;
    const next = thread.slice();
    next[index] = merged;
    return next;
  }
  if (!insert) return thread;
  const time = createdAt(row);
  let at = thread.length;
  if (time !== null) {
    while (at > 0 && (createdAt(thread[at - 1]) ?? -Infinity) > time) at -= 1;
  }
  const next = [...thread.slice(0, at), row, ...thread.slice(at)];
  return next.length > THREAD_LIMIT ? next.slice(next.length - THREAD_LIMIT) : next;
}

function patchConversation(list, other, change) {
  let changed = false;
  const next = list.map((conversation) => {
    if (conversation.otherProfileId !== other) return conversation;
    const patched = change(conversation);
    if (patched !== conversation) changed = true;
    return patched;
  });
  if (!changed) return list;
  return next.filter(Boolean).sort(compareConversations);
}

function addToCount(delta) {
  return (count) => (typeof count === 'number' ? Math.max(0, count + delta) : count);
}

/**
 * A message that is new (`insert`) or changed: the whole row from Realtime or
 * from the send, or a part of it — the mark-read hands over id, read_at and
 * the pair. Only a message of the signed-in user is applied.
 */
export function applyMessageUpsert(qc, me, record, { insert, refresh }) {
  const incoming = pickRow(record, MESSAGE_COLUMNS, { complete: insert, timestamps: TIMESTAMPS });
  const { id, sender_id: sender, recipient_id: recipient } = incoming;
  if (!id || (sender !== me && recipient !== me) || deletedIds.has(qc, id)) return;
  const other = sender === me ? recipient : sender;
  const threadKey = messageKeys.thread(me, other);
  const conversationsKey = messageKeys.conversations(me);
  const unreadKey = messageKeys.unreadCount(me);

  const thread = qc.getQueryData(threadKey);
  const conversations = qc.getQueryData(conversationsKey);
  const conversation = Array.isArray(conversations)
    ? conversations.find((c) => c.otherProfileId === other)
    : undefined;
  const inThread = Array.isArray(thread) ? thread.find((m) => m.id === id) : undefined;
  const asLast = conversation?.lastMessage?.id === id ? conversation.lastMessage : undefined;

  // The message as the cache knew it before this change: a row, null when it
  // did not exist, undefined when no entry that can be trusted can say — then
  // the counts are read again rather than guessed. A whole thread holds the
  // newest messages of the pair, so a new one it lacks is new to it; a whole
  // conversation list holds the latest message of each pair, so a message
  // after it is new to it too.
  let before;
  if (Array.isArray(thread) && isWhole(qc, threadKey)) before = inThread ?? (insert ? null : undefined);
  if (before === undefined && conversation && isWhole(qc, conversationsKey)) {
    if (asLast) before = asLast;
    else if (insert && isAfter(incoming, conversation.lastMessage)) before = null;
  }
  const base = inThread ?? asLast;
  const message = base ? mergeRow(base, incoming) : incoming;
  const delta = before === undefined
    ? 0
    : Number(unreadForMe(message, me)) - Number(unreadForMe(before, me));
  if (before === undefined && message.recipient_id === me) {
    refresh(unreadKey);
    refresh(conversationsKey);
  }

  patchCached(qc, threadKey, (t) => placeInThread(t, message, { insert }), refresh);
  if (delta !== 0) patchCached(qc, unreadKey, addToCount(delta), refresh);

  if (Array.isArray(conversations)) {
    if (!conversation) {
      // A counterpart the list does not hold: its name and role come with a read.
      refresh(conversationsKey);
    } else {
      patchCached(qc, conversationsKey, (list) => patchConversation(list, other, (c) => {
        let lastMessage = c.lastMessage;
        if (lastMessage?.id === id) lastMessage = mergeRow(lastMessage, message);
        else if (insert && !isAfter(lastMessage, message)) lastMessage = message;
        const unreadCount = Math.max(0, c.unreadCount + delta);
        if (lastMessage === c.lastMessage && unreadCount === c.unreadCount) return c;
        return { ...c, lastMessage, unreadCount };
      }), refresh);
    }
  }

  // A message attached to a session is that session's coach feedback: the
  // feedback card and the review read it under its own key, and the athlete's
  // list of sessions with feedback carries its pill.
  const sessionId = message.session_id;
  if (sessionId) {
    patchCached(qc, messageKeys.sessionFeedback(sessionId), (old) => {
      const row = pickRow(message, FEEDBACK_COLUMNS, { complete: true });
      return old ? mergeRow(old, row) : row;
    }, refresh);
    if (message.recipient_id === me) {
      patchCached(qc, messageKeys.feedbackSessionIds(me), (ids) => (
        Array.isArray(ids) && !ids.includes(sessionId) ? [...ids, sessionId] : ids
      ), refresh);
    }
  }
}

/** A message that is gone, known by its id alone. */
export function applyMessageDelete(qc, me, id, { refresh }) {
  if (!id || deletedIds.has(qc, id)) return;
  deletedIds.add(qc, id);
  const conversationsKey = messageKeys.conversations(me);
  const unreadKey = messageKeys.unreadCount(me);

  let base;
  let before;
  for (const query of qc.getQueryCache().findAll({ queryKey: [MESSAGES_ROOT, 'thread'] })) {
    const thread = query.state.data;
    const found = Array.isArray(thread) ? thread.find((m) => m.id === id) : undefined;
    if (!found) continue;
    base = found;
    if (!query.state.isInvalidated) before = found;
    patchCached(qc, query.queryKey, (t) => t.filter((m) => m.id !== id), refresh);
  }
  const conversations = qc.getQueryData(conversationsKey);
  const asLast = Array.isArray(conversations)
    ? conversations.find((c) => c.lastMessage?.id === id)?.lastMessage
    : undefined;
  if (!base && asLast) {
    base = asLast;
    if (isWhole(qc, conversationsKey)) before = asLast;
  }
  if (!base) {
    // No entry holds it. The binding on deletions hears every message deleted
    // anywhere, and an id alone does not say whose it was.
    refresh(unreadKey);
    refresh(conversationsKey);
    return;
  }
  if (before === undefined && base.recipient_id === me) {
    refresh(unreadKey);
    refresh(conversationsKey);
  }
  const delta = before && unreadForMe(before, me) ? -1 : 0;
  if (delta !== 0) patchCached(qc, unreadKey, addToCount(delta), refresh);

  const other = base.sender_id === me ? base.recipient_id : base.sender_id;
  if (Array.isArray(conversations)) {
    const threadKey = messageKeys.thread(me, other);
    const thread = qc.getQueryData(threadKey);
    const threadWhole = Array.isArray(thread) && isWhole(qc, threadKey);
    patchCached(qc, conversationsKey, (list) => patchConversation(list, other, (c) => {
      let { lastMessage } = c;
      if (lastMessage?.id === id) {
        // The message before it, from a thread that holds the pair's newest;
        // an empty one means the pair has no message left.
        if (!threadWhole) {
          refresh(conversationsKey);
        } else if (thread.length === 0) {
          return null;
        } else {
          lastMessage = thread[thread.length - 1];
        }
      }
      const unreadCount = Math.max(0, c.unreadCount + delta);
      if (lastMessage === c.lastMessage && unreadCount === c.unreadCount) return c;
      return { ...c, lastMessage, unreadCount };
    }), refresh);
  }

  if (base.session_id) {
    patchCached(qc, messageKeys.sessionFeedback(base.session_id), (old) => (
      old?.id === id ? null : old
    ), refresh);
    if (base.recipient_id === me) {
      patchCached(qc, messageKeys.feedbackSessionIds(me), (ids) => (
        Array.isArray(ids) && ids.includes(base.session_id)
          ? ids.filter((sessionId) => sessionId !== base.session_id)
          : ids
      ), refresh);
    }
  }
}

/** One event of the messages channel, as realtime-js hands it over. */
export function applyMessageChange(qc, me, payload, refresh) {
  switch (payload?.eventType) {
    case 'INSERT':
      applyMessageUpsert(qc, me, payload.new, { insert: true, refresh });
      break;
    case 'UPDATE':
      applyMessageUpsert(qc, me, payload.new, { insert: false, refresh });
      break;
    case 'DELETE':
      // Under row-level security the old record is the primary key alone.
      applyMessageDelete(qc, me, payload.old?.id, { refresh });
      break;
    default:
      break;
  }
}
