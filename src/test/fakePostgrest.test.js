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
