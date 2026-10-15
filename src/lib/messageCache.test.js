import { describe, it, expect, vi, afterEach } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { normalizeTimestamp, pickRow, mergeRow, createRefresher } from './realtimeCache';
import { placeInThread, THREAD_LIMIT, messageKeys, pairKey } from './messageCache';
import { placeInList, NOTIFICATIONS_PAGE_SIZE } from './notificationCache';

afterEach(() => {
  vi.useRealTimers();
});

describe('normalizeTimestamp', () => {
  it('turns the Postgres text that Realtime hands over into the form PostgREST answers with', () => {
    expect(normalizeTimestamp('2026-10-13 12:00:00.123456+00')).toBe('2026-10-13T12:00:00.123456+00:00');
    expect(normalizeTimestamp('2026-10-13 12:00:00+02')).toBe('2026-10-13T12:00:00+02:00');
    expect(normalizeTimestamp('2026-10-13 12:00:00-0530')).toBe('2026-10-13T12:00:00-05:30');
    expect(normalizeTimestamp('2026-10-13 12:00:00+05:30')).toBe('2026-10-13T12:00:00+05:30');
  });

  it('leaves the PostgREST form, null and anything else as they are', () => {
    expect(normalizeTimestamp('2026-10-13T12:00:00.5+00:00')).toBe('2026-10-13T12:00:00.5+00:00');
    expect(normalizeTimestamp('2026-10-13T12:00:00Z')).toBe('2026-10-13T12:00:00Z');
    expect(normalizeTimestamp(null)).toBeNull();
    expect(normalizeTimestamp('now')).toBe('now');
  });

  it('gives a date every engine reads, where the raw form is not', () => {
    expect(Number.isNaN(Date.parse(normalizeTimestamp('2026-10-13 12:00:00.123456+00')))).toBe(false);
    expect(Date.parse(normalizeTimestamp('2026-10-13 12:00:00+00'))).toBe(Date.UTC(2026, 9, 13, 12));
  });
});

describe('pickRow and mergeRow', () => {
  it('keeps the cached columns only, fills a new row and leaves a partial one partial', () => {
    const columns = ['id', 'body', 'read_at'];
    expect(pickRow({ id: 1, body: 'x', extra: true }, columns, { complete: true }))
      .toEqual({ id: 1, body: 'x', read_at: null });
    expect(pickRow({ id: 1, read_at: '2026-10-13 12:00:00+00' }, columns, { timestamps: ['read_at'] }))
      .toEqual({ id: 1, read_at: '2026-10-13T12:00:00+00:00' });
  });

  it('returns the same row when nothing differs', () => {
    const row = { id: 1, read_at: null };
    expect(mergeRow(row, { read_at: null })).toBe(row);
    expect(mergeRow(row, { read_at: 'x' })).toEqual({ id: 1, read_at: 'x' });
  });
});

describe('placeInThread', () => {
  const at = (minute) => `2026-10-13T12:${String(minute).padStart(2, '0')}:00+00:00`;

  it('appends a new message, and puts a late one in its place by time', () => {
    const thread = [{ id: 'a', created_at: at(1) }, { id: 'c', created_at: at(3) }];
    expect(placeInThread(thread, { id: 'd', created_at: at(4) }, { insert: true }).map((m) => m.id))
      .toEqual(['a', 'c', 'd']);
    expect(placeInThread(thread, { id: 'b', created_at: at(2) }, { insert: true }).map((m) => m.id))
      .toEqual(['a', 'b', 'c']);
  });

  it('keeps the newest THREAD_LIMIT messages, as the read does', () => {
    const thread = Array.from({ length: THREAD_LIMIT }, (_, i) => ({ id: `m${i}`, created_at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() }));
    const next = placeInThread(thread, { id: 'new', created_at: '2027-01-01T00:00:00+00:00' }, { insert: true });
    expect(next).toHaveLength(THREAD_LIMIT);
    expect(next[0].id).toBe('m1');
    expect(next.at(-1).id).toBe('new');
  });

  it('changes nothing for an update of a message it does not hold, or one already as given', () => {
    const thread = [{ id: 'a', created_at: at(1), read_at: null }];
    expect(placeInThread(thread, { id: 'z', read_at: 'x' }, { insert: false })).toBe(thread);
    expect(placeInThread(thread, { id: 'a', read_at: null }, { insert: false })).toBe(thread);
    expect(placeInThread(undefined, { id: 'a' }, { insert: true })).toBeUndefined();
  });

  it('the thread key is the one the thread query uses, whichever side asks', () => {
    expect(messageKeys.thread('s1', 'me')).toEqual(['messages', 'thread', ...pairKey('me', 's1')]);
    expect(messageKeys.thread('me', 's1')).toEqual(messageKeys.thread('s1', 'me'));
  });
});

describe('placeInList', () => {
  it('puts a new notification first and keeps the page to its size', () => {
    const list = Array.from({ length: NOTIFICATIONS_PAGE_SIZE }, (_, i) => ({ id: `n${i}`, created_at: new Date(Date.UTC(2026, 0, 1, 0, 59 - i)).toISOString() }));
    const next = placeInList(list, { id: 'new', created_at: '2027-01-01T00:00:00+00:00' }, { insert: true });
    expect(next).toHaveLength(NOTIFICATIONS_PAGE_SIZE);
    expect(next[0].id).toBe('new');
    expect(next.at(-1).id).toBe(`n${NOTIFICATIONS_PAGE_SIZE - 2}`);
  });
});

describe('createRefresher', () => {
  it('reads each exact key once for a burst, after the delay', () => {
    vi.useFakeTimers();
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const refresher = createRefresher(qc, 300);
    refresher.refresh(['messages', 'unread-count', 'me']);
    refresher.refresh(['messages', 'unread-count', 'me']);
    refresher.refresh(['messages', 'conversations', 'me']);
    expect(invalidate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(invalidate.mock.calls).toEqual([
      [{ queryKey: ['messages', 'unread-count', 'me'], exact: true }],
      [{ queryKey: ['messages', 'conversations', 'me'], exact: true }],
    ]);
  });

  it('flush sends at once, and dispose drops what waits', () => {
    vi.useFakeTimers();
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const refresher = createRefresher(qc, 300);
    refresher.refresh(['a']);
    refresher.flush();
    expect(invalidate).toHaveBeenCalledTimes(1);
    refresher.refresh(['b']);
    refresher.dispose();
    vi.advanceTimersByTime(1_000);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });
});
