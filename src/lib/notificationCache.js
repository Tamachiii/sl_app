import {
  createDeletedIds,
  createdAt,
  isWhole,
  mergeRow,
  patchCached,
  pickRow,
  refreshInFlight,
} from './realtimeCache';

// The bell's cache, kept up to date one change at a time: a notification that
// arrives, is read or is taken back changes the list and the count, and
// applying one change twice leaves them as once.

export const NOTIFICATIONS_ROOT = 'notifications';

/** The newest notifications the bell's list holds. */
export const NOTIFICATIONS_PAGE_SIZE = 30;

/** The columns the list caches — the recipient is the reader, so not among them. */
export const NOTIFICATION_COLUMNS = Object.freeze(['id', 'kind', 'payload', 'read_at', 'created_at']);
const TIMESTAMPS = Object.freeze(['read_at', 'created_at']);

export const notificationKeys = {
  list: (me) => [NOTIFICATIONS_ROOT, 'list', me],
  unreadCount: (me) => [NOTIFICATIONS_ROOT, 'unread-count', me],
};

/**
 * The bindings of the bell's channel: the rows addressed to me, and the
 * deletions — the retract triggers — which Realtime does not filter on a
 * column: a deletion carries the id and nothing else.
 */
export function notificationBindings(me) {
  return [
    { event: '*', schema: 'public', table: 'notifications', filter: `recipient_id=eq.${me}` },
    { event: 'DELETE', schema: 'public', table: 'notifications' },
  ];
}

const deletedIds = createDeletedIds();

function addToCount(delta) {
  return (count) => (typeof count === 'number' ? Math.max(0, count + delta) : count);
}

/** `row` in `list` (newest first), merged or put in its place, the page kept to its size. */
export function placeInList(list, row, { insert }) {
  if (!Array.isArray(list)) return list;
  const index = list.findIndex((n) => n.id === row.id);
  if (index >= 0) {
    const merged = mergeRow(list[index], row);
    if (merged === list[index]) return list;
    const next = list.slice();
    next[index] = merged;
    return next;
  }
  if (!insert) return list;
  const time = createdAt(row);
  let at = 0;
  if (time !== null) {
    while (at < list.length && (createdAt(list[at]) ?? Infinity) > time) at += 1;
  }
  return [...list.slice(0, at), row, ...list.slice(at)].slice(0, NOTIFICATIONS_PAGE_SIZE);
}

/** A notification that is new (`insert`) or changed, as Realtime hands it over. */
export function applyNotificationUpsert(qc, me, record, { insert, refresh }) {
  if (!record?.id || record.recipient_id !== me || deletedIds.has(qc, record.id)) return;
  const incoming = pickRow(record, NOTIFICATION_COLUMNS, { complete: insert, timestamps: TIMESTAMPS });
  const listKey = notificationKeys.list(me);
  const countKey = notificationKeys.unreadCount(me);
  const list = qc.getQueryData(listKey);
  const inList = Array.isArray(list) ? list.find((n) => n.id === incoming.id) : undefined;

  // The row as the cache knew it: a whole list holds the newest of the
  // user's notifications, so a new one it lacks is new to it. An older one
  // that changed is beyond the page, and the count is read again.
  let before;
  if (Array.isArray(list) && isWhole(qc, listKey)) before = inList ?? (insert ? null : undefined);
  const row = inList ? mergeRow(inList, incoming) : incoming;

  patchCached(qc, listKey, (l) => placeInList(l, row, { insert }), refresh);
  if (before === undefined) {
    refresh(countKey);
    return;
  }
  const delta = Number(!row.read_at) - Number(!!before && !before.read_at);
  if (delta !== 0) patchCached(qc, countKey, addToCount(delta), refresh);
}

/** A notification taken back, known by its id alone. */
export function applyNotificationDelete(qc, me, id, { refresh }) {
  if (!id || deletedIds.has(qc, id)) return;
  deletedIds.add(qc, id);
  const listKey = notificationKeys.list(me);
  const countKey = notificationKeys.unreadCount(me);
  const list = qc.getQueryData(listKey);
  const whole = Array.isArray(list) && isWhole(qc, listKey);
  const inList = Array.isArray(list) ? list.find((n) => n.id === id) : undefined;

  if (!inList) {
    // The binding on deletions hears every notification taken back. A whole
    // list shorter than a page holds all of the user's, so one it lacks was
    // someone else's; a full page or a list behind cannot say. A read of the
    // list in flight may answer with it.
    if (!(whole && list.length < NOTIFICATIONS_PAGE_SIZE)) refresh(countKey);
    refreshInFlight(qc, listKey, refresh);
    return;
  }
  patchCached(qc, listKey, (l) => l.filter((n) => n.id !== id), refresh);
  // The next one in line takes the freed place on a full page.
  if (list.length >= NOTIFICATIONS_PAGE_SIZE) refresh(listKey);
  if (!whole) refresh(countKey);
  else if (!inList.read_at) patchCached(qc, countKey, addToCount(-1), refresh);
}

/** One event of the bell's channel, as realtime-js hands it over. */
export function applyNotificationChange(qc, me, payload, refresh) {
  switch (payload?.eventType) {
    case 'INSERT':
      applyNotificationUpsert(qc, me, payload.new, { insert: true, refresh });
      break;
    case 'UPDATE':
      applyNotificationUpsert(qc, me, payload.new, { insert: false, refresh });
      break;
    case 'DELETE':
      // Under row-level security the old record is the primary key alone.
      applyNotificationDelete(qc, me, payload.old?.id, { refresh });
      break;
    default:
      break;
  }
}
