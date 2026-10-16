// What the realtime hooks share to patch the React Query cache from one change
// at a time: the shape of a row as the cache holds it, the test of a cached
// entry that can be trusted, and the exact keys to read again when it cannot.

/**
 * How long the reads that a burst of events asks for are gathered. One
 * mark-read of N messages is N events: they ask for one read, not N reads
 * that cancel each other.
 */
export const REFRESH_DELAY_MS = 300;

// Postgres' text form of a timestamptz, which Realtime hands over unchanged
// ("2026-10-13 12:00:00.123456+00"), where PostgREST answers with
// "2026-10-13T12:00:00.123456+00:00". Safari's Date reads only the second.
const PG_TIMESTAMP = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)(Z|[+-]\d{2}(?::?\d{2})?)$/;

/** A timestamp in the form PostgREST gives it; anything else is returned as it came. */
export function normalizeTimestamp(value) {
  if (typeof value !== 'string') return value;
  const match = PG_TIMESTAMP.exec(value);
  if (!match) return value;
  const [, date, time, zone] = match;
  let offset = zone;
  if (/^[+-]\d{2}$/.test(zone)) offset = `${zone}:00`;
  else if (/^[+-]\d{4}$/.test(zone)) offset = `${zone.slice(0, 3)}:${zone.slice(3)}`;
  return `${date}T${time}${offset}`;
}

/**
 * The columns of `record` that the cache holds, and only those, timestamps in
 * PostgREST's form. `complete` fills a missing column with null — a new row —
 * where a partial change leaves it out, to be merged over the cached row.
 */
export function pickRow(record, columns, { complete = false, timestamps = [] } = {}) {
  const row = {};
  for (const column of columns) {
    if (record && column in record) {
      row[column] = timestamps.includes(column) ? normalizeTimestamp(record[column]) : record[column];
    } else if (complete) {
      row[column] = null;
    }
  }
  return row;
}

/** `base` with the values of `patch` over it — `base` itself when nothing differs. */
export function mergeRow(base, patch) {
  for (const key of Object.keys(patch)) {
    if (base[key] !== patch[key]) return { ...base, ...patch };
  }
  return base;
}

/** The time of a row's `created_at`, or null when it cannot be read. */
export function createdAt(row) {
  const time = Date.parse(row?.created_at);
  return Number.isNaN(time) ? null : time;
}

/**
 * A cached entry that says what the server holds: it has data, and nothing
 * has marked it as behind. An entry invalidated by a resync keeps its old data
 * until it is read again, and that data cannot tell what a change replaces.
 */
export function isWhole(qc, queryKey) {
  const state = qc.getQueryState(queryKey);
  return !!state && state.data !== undefined && !state.isInvalidated;
}

/**
 * Asks for `queryKey` to be read again when a read of it is in flight: that
 * read was sent before the change that is being applied arrived, and may
 * answer without it. For an entry a change cannot be written into — not read
 * yet, or marked as behind — that is all the change can do.
 */
export function refreshInFlight(qc, queryKey, refresh) {
  if (qc.getQueryState(queryKey)?.fetchStatus === 'fetching') refresh(queryKey);
}

/**
 * Changes a cached entry with `update(data)`, and leaves an entry that is not
 * cached as it is — a patch never creates one. A read in flight answers with
 * what the server held when it was sent and would put back what the patch
 * changed, so that entry is read again.
 *
 * An entry that has no data yet is not patched, and its first read, if it is
 * in flight, is read again once it has answered. An entry already marked as
 * behind is not patched either: writing it would mark it current, and a page
 * that shows it later would trust data that missed events. It is read when it
 * is shown; one being read now is read again.
 */
export function patchCached(qc, queryKey, update, refresh) {
  const state = qc.getQueryState(queryKey);
  if (!state) return;
  if (state.data === undefined || state.isInvalidated) {
    refreshInFlight(qc, queryKey, refresh);
    return;
  }
  const next = update(state.data);
  if (next === state.data) return;
  qc.setQueryData(queryKey, next);
  refreshInFlight(qc, queryKey, refresh);
}

// An invalidation cancels and sends again the read in flight of an entry that
// has data and is shown. Any other read in flight — a first read, the read of
// an entry nobody shows — it joins, and that read, sent before the change,
// clears the mark when it answers.
function invalidationJoins(qc, queryKey) {
  const query = qc.getQueryCache().find({ queryKey, exact: true });
  if (!query || query.state.fetchStatus !== 'fetching') return false;
  return query.state.data === undefined || !query.isActive();
}

/**
 * Gathers the exact keys to read again and invalidates each once, after
 * `delayMs`, or at `flush()`. Never the root of a cache: a key whose entry is
 * not shown on the page is only marked stale. A key whose read in flight the
 * invalidation would only join waits, a round of `delayMs` at a time, until
 * that read has answered.
 */
export function createRefresher(qc, delayMs = REFRESH_DELAY_MS) {
  const pending = new Map();
  let timer = null;

  function flush() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    const keys = [...pending];
    pending.clear();
    for (const [hash, queryKey] of keys) {
      if (invalidationJoins(qc, queryKey)) pending.set(hash, queryKey);
      else qc.invalidateQueries({ queryKey, exact: true });
    }
    if (pending.size > 0) timer = setTimeout(flush, delayMs);
  }

  return {
    refresh(queryKey) {
      pending.set(JSON.stringify(queryKey), queryKey);
      if (timer === null) timer = setTimeout(flush, delayMs);
    },
    flush,
    dispose() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pending.clear();
    },
  };
}

/**
 * Remembers the ids of the rows a cache saw deleted, per query client, so that
 * a deletion heard twice — by the mutation and by the channel, or by two
 * bindings of the channel — is applied once and asks for nothing the second
 * time.
 */
export function createDeletedIds(limit = 200) {
  const byClient = new WeakMap();
  function idsOf(qc) {
    let ids = byClient.get(qc);
    if (!ids) {
      ids = new Set();
      byClient.set(qc, ids);
    }
    return ids;
  }
  return {
    has: (qc, id) => idsOf(qc).has(id),
    add(qc, id) {
      const ids = idsOf(qc);
      ids.add(id);
      if (ids.size > limit) ids.delete(ids.values().next().value);
    },
  };
}
