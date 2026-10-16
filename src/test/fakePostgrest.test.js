import { describe, it, expect } from 'vitest';
import { fakePostgrest } from './fakePostgrest';

// The hook tests that prove a read pages are only as good as this double: if it
// handed back the whole fixture, a read that stops at the first page would pass.
const rowsOf = (n) => Array.from({ length: n }, (_, i) => ({ id: `r-${String(i).padStart(5, '0')}`, n: i }));

describe('fakePostgrest', () => {
  it('never returns more than 1000 rows, whatever limit it is sent', async () => {
    const db = fakePostgrest({ set_logs: rowsOf(1352) });
    const { data, error } = await db.from('set_logs').select('id').limit(20000);
    expect(error).toBeNull();
    expect(data).toHaveLength(1000);
    // …and none at all is the same cut.
    expect((await db.from('set_logs').select('id')).data).toHaveLength(1000);
  });

  it('sorts, applies the cursor and cuts, in that order', async () => {
    const db = fakePostgrest({ set_logs: rowsOf(10).reverse() });
    const { data } = await db
      .from('set_logs')
      .select('id, n')
      .gt('id', 'r-00003')
      .order('id', { ascending: true })
      .limit(3);
    expect(data.map((r) => r.n)).toEqual([4, 5, 6]);

    const down = await db.from('set_logs').select('id, n').lt('id', 'r-00003').order('id', { ascending: false });
    expect(down.data.map((r) => r.n)).toEqual([2, 1, 0]);
  });

  // An offset page: `.range(from, to)` is `offset=from&limit=to-from+1`, cut by
  // max rows like any other request.
  it('skips and cuts a range, after the sort, and never past max rows', async () => {
    const db = fakePostgrest({ set_logs: rowsOf(1352).reverse() });
    const { data } = await db.from('set_logs').select('id, n').order('id', { ascending: true }).range(30, 59);
    expect(data.map((r) => r.n)).toEqual(Array.from({ length: 30 }, (_, i) => 30 + i));
    expect(db.requests[0].range).toEqual({ from: 30, to: 59 });

    const end = await db.from('set_logs').select('id').order('id').range(1340, 1369);
    expect(end.data).toHaveLength(12);
    expect((await db.from('set_logs').select('id').range(0, 1999)).data).toHaveLength(1000);
  });

  // `order=confirmed_at.desc,id.desc`: the first key decides, the next breaks
  // its ties.
  it('sorts by every order, the first one first', async () => {
    const db = fakePostgrest({
      t: [
        { id: 'a', at: 1 },
        { id: 'c', at: 2 },
        { id: 'b', at: 2 },
        { id: 'd', at: 1 },
      ],
    });
    const { data } = await db.from('t').select('id, at').order('at', { ascending: false }).order('id', { ascending: false });
    expect(data.map((r) => r.id)).toEqual(['c', 'b', 'd', 'a']);
    expect(db.requests[0].orders).toEqual([
      { column: 'at', ascending: false },
      { column: 'id', ascending: false },
    ]);
  });

  it('records every argument of a filter, the three of .not() included', async () => {
    const db = fakePostgrest({ t: [] });
    await db.from('t').select('id').not('session.archived_at', 'is', null).eq('a', 1);
    expect(db.requests[0].filters).toEqual([
      ['not', 'session.archived_at', 'is', null],
      ['eq', 'a', 1],
    ]);
  });

  it('records the other filters without applying them', async () => {
    const db = fakePostgrest({ set_logs: [{ id: 'a', done: false }] });
    const { data } = await db.from('set_logs').select('id, done').eq('done', true).is('x.deleted_at', null);
    // The fixture is what the WHERE clause lets through; the test reads the filters.
    expect(data).toEqual([{ id: 'a', done: false }]);
    expect(db.requests).toEqual([
      {
        table: 'set_logs',
        select: 'id, done',
        options: null,
        filters: [['eq', 'done', true], ['is', 'x.deleted_at', null]],
        order: null,
        limit: null,
      },
    ]);
    expect(db.requestsTo('set_logs')).toHaveLength(1);
    expect(db.requestsTo('programs')).toHaveLength(0);
  });

  it('answers a head count with a count that is not cut, and no rows', async () => {
    const db = fakePostgrest({ set_logs: rowsOf(1352), session_confirmations: { count: 4210 } });
    expect(await db.from('set_logs').select('id', { count: 'exact', head: true })).toEqual({
      data: null, count: 1352, error: null,
    });
    expect((await db.from('session_confirmations').select('id', { count: 'exact', head: true })).count).toBe(4210);
  });

  it('gives one row to maybeSingle and single, and refuses single anything but one', async () => {
    const db = fakePostgrest({ one: [{ id: 'st-1' }], none: [], two: rowsOf(2) });
    expect((await db.from('one').select('id').maybeSingle()).data).toEqual({ id: 'st-1' });
    expect((await db.from('none').select('id').maybeSingle()).data).toBeNull();
    expect((await db.from('one').select('id').single()).data).toEqual({ id: 'st-1' });
    expect((await db.from('none').select('id').single()).error.code).toBe('PGRST116');
    expect((await db.from('two').select('id').single()).error.code).toBe('PGRST116');
  });

  it('serves a table from a function of the request, and an error as an error', async () => {
    const boom = { code: '42501', message: 'permission denied' };
    const db = fakePostgrest({
      set_logs: (request) => (request.limit === 1 ? { error: boom } : rowsOf(2)),
    });
    expect((await db.from('set_logs').select('id')).data).toHaveLength(2);
    expect(await db.from('set_logs').select('id').limit(1)).toEqual({ data: null, count: null, error: boom });
  });

  it('answers an unknown table with no rows', async () => {
    const db = fakePostgrest({});
    expect((await db.from('nowhere').select('id')).data).toEqual([]);
  });
});
