import { describe, it, expect, vi, afterEach } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { writeCached } from './cacheWrite';

const TWO_MINUTES = 2 * 60 * 1000;

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity, staleTime: TWO_MINUTES } },
  });
}

const stateOf = (qc, key) => qc.getQueryState(key);
const isStale = (qc, key) => qc.getQueryCache().find({ queryKey: key }).isStaleByTime(TWO_MINUTES);

afterEach(() => {
  vi.useRealTimers();
});

describe('writeCached', () => {
  it('writes every entry the key matches, and hands each its own data', () => {
    const qc = makeClient();
    qc.setQueryData(['ids', 'u-1'], ['a']);
    qc.setQueryData(['ids', 'u-2'], ['b']);
    qc.setQueryData(['other'], ['c']);

    writeCached(qc, ['ids'], (ids) => [...ids, 'x']);

    expect(qc.getQueryData(['ids', 'u-1'])).toEqual(['a', 'x']);
    expect(qc.getQueryData(['ids', 'u-2'])).toEqual(['b', 'x']);
    expect(qc.getQueryData(['other'])).toEqual(['c']);
  });

  // The point of the helper. `setQueryData` alone would stamp the entry as
  // read at the moment of the write.
  it('leaves the entry as old as its last read: a guess is not a read', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-13T17:00:00Z'));
    const qc = makeClient();
    qc.setQueryData(['ids', 'u-1'], ['a']);
    const readAt = stateOf(qc, ['ids', 'u-1']).dataUpdatedAt;

    // An hour of workout later.
    vi.setSystemTime(new Date('2026-10-13T18:00:00Z'));
    expect(isStale(qc, ['ids', 'u-1'])).toBe(true);
    writeCached(qc, ['ids'], (ids) => [...ids, 'x']);

    expect(qc.getQueryData(['ids', 'u-1'])).toEqual(['a', 'x']);
    expect(stateOf(qc, ['ids', 'u-1']).dataUpdatedAt).toBe(readAt);
    // Still due for a read when a page opens on it.
    expect(isStale(qc, ['ids', 'u-1'])).toBe(true);

    // The same write through `setQueryData`: fresh for two more minutes.
    qc.setQueryData(['ids', 'u-1'], (ids) => [...ids, 'y']);
    expect(isStale(qc, ['ids', 'u-1'])).toBe(false);
  });

  it('keeps the "to be read again" flag of an entry whose refresh could not be served', async () => {
    const qc = makeClient();
    qc.setQueryData(['ids', 'u-1'], ['a']);
    await qc.invalidateQueries({ queryKey: ['ids'], refetchType: 'none' });
    expect(stateOf(qc, ['ids', 'u-1']).isInvalidated).toBe(true);

    writeCached(qc, ['ids'], (ids) => [...ids, 'x']);

    expect(qc.getQueryData(['ids', 'u-1'])).toEqual(['a', 'x']);
    expect(stateOf(qc, ['ids', 'u-1']).isInvalidated).toBe(true);
  });

  it('does not flag an entry that was not flagged', () => {
    const qc = makeClient();
    qc.setQueryData(['ids', 'u-1'], ['a']);
    writeCached(qc, ['ids'], (ids) => [...ids, 'x']);
    expect(stateOf(qc, ['ids', 'u-1']).isInvalidated).toBe(false);
  });

  it('leaves an entry alone when the update answers nothing, or the same data', () => {
    const qc = makeClient();
    qc.setQueryData(['ids', 'u-1'], ['a']);
    const before = stateOf(qc, ['ids', 'u-1']);

    writeCached(qc, ['ids'], () => undefined);
    writeCached(qc, ['ids'], (ids) => ids);

    expect(stateOf(qc, ['ids', 'u-1'])).toBe(before);
  });

  // A list made of the one row the device knows about would be an answer
  // nobody gave.
  it('never makes an entry: one that holds nothing is not asked, and a key nobody read stays unread', async () => {
    const qc = makeClient();
    // Asked for, never answered.
    const never = qc.fetchQuery({ queryKey: ['ids', 'u-1'], queryFn: () => new Promise(() => {}) });
    never.catch(() => {});
    const update = vi.fn(() => ['x']);

    writeCached(qc, ['ids'], update);

    expect(update).not.toHaveBeenCalled();
    expect(qc.getQueryData(['ids', 'u-1'])).toBeUndefined();
    expect(qc.getQueryCache().findAll({ queryKey: ['ids'] })).toHaveLength(1);
    await qc.cancelQueries({ queryKey: ['ids'] });
  });

  it('an answer that is empty is an answer, and is written like any other', () => {
    const qc = makeClient();
    qc.setQueryData(['ids', 'u-1'], []);
    qc.setQueryData(['row', 's-1'], null);

    writeCached(qc, ['ids'], (ids) => [...ids, 'x']);
    writeCached(qc, ['row'], () => ({ id: 1 }));

    expect(qc.getQueryData(['ids', 'u-1'])).toEqual(['x']);
    expect(qc.getQueryData(['row', 's-1'])).toEqual({ id: 1 });
  });
});
