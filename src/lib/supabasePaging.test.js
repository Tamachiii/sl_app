import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { fetchAllRows, PAGE_SIZE } from './supabasePaging';
import { fakePostgrest } from '../test/fakePostgrest';

// Ids that sort the way they count, as a uuid column sorts by value.
const rowsOf = (n, from = 0) =>
  Array.from({ length: n }, (_, i) => ({ id: `r-${String(from + i).padStart(5, '0')}`, n: from + i }));

const read = (db, options) =>
  fetchAllRows(() => db.from('set_logs').select('id, n').eq('done', true), options);

describe('fetchAllRows', () => {
  it('reads a table that fits one page with one request', async () => {
    const db = fakePostgrest({ set_logs: rowsOf(3) });
    const rows = await read(db);

    expect(rows.map((r) => r.n)).toEqual([0, 1, 2]);
    expect(db.requests).toEqual([
      {
        table: 'set_logs',
        select: 'id, n',
        options: null,
        // The caller's filter is kept; the helper adds no cursor to page one.
        filters: [['eq', 'done', true]],
        order: { column: 'id', ascending: true },
        limit: PAGE_SIZE,
      },
    ]);
  });

  it('follows a 1000-row page with the next one and returns every row', async () => {
    // What the server holds is 1352 rows; what one request can carry is 1000.
    const db = fakePostgrest({ set_logs: rowsOf(1352) });
    const rows = await read(db);

    expect(rows).toHaveLength(1352);
    expect(rows.map((r) => r.n)).toEqual(rowsOf(1352).map((r) => r.n));

    expect(db.requests).toHaveLength(2);
    // Page two starts strictly after the last key of page one — a keyset, so a
    // row inserted meanwhile cannot shift it — and keeps the caller's filter.
    expect(db.requests[1].filters).toEqual([
      ['eq', 'done', true],
      ['gt', 'id', 'r-00999'],
    ]);
    expect(db.requests[1].order).toEqual({ column: 'id', ascending: true });
    expect(db.requests[1].limit).toBe(PAGE_SIZE);
  });

  it('asks again when exactly 1000 rows come back', async () => {
    // The trap: a full page looks like a complete answer. Only a second request
    // can tell "there were exactly 1000" from "the server stopped at 1000".
    const db = fakePostgrest({ set_logs: rowsOf(1000) });
    const rows = await read(db);

    expect(rows).toHaveLength(1000);
    expect(db.requests).toHaveLength(2);
    expect(db.requests[1].filters).toContainEqual(['gt', 'id', 'r-00999']);
  });

  it('keeps going over as many full pages as there are', async () => {
    const db = fakePostgrest({ set_logs: rowsOf(3001) });
    const rows = await read(db);
    expect(rows).toHaveLength(3001);
    expect(db.requests).toHaveLength(4);
  });

  it('returns each id once when two pages overlap', async () => {
    // A second page that hands back the last ten rows of the first (the mock
    // stands in for any reason two pages could overlap).
    const all = rowsOf(1200);
    let call = 0;
    const db = fakePostgrest({
      set_logs: () => ({ rows: call++ === 0 ? all.slice(0, 1000) : all.slice(990) }),
    });
    const rows = await fetchAllRows(() => {
      const q = db.from('set_logs').select('id, n');
      q.gt = () => q; // the overlap is the fixture's, so the fake must not filter it away
      return q;
    });

    const ids = rows.map((r) => r.id);
    expect(ids).toHaveLength(1200);
    expect(new Set(ids).size).toBe(1200);
  });

  it('throws instead of stopping when a full page brings nothing new', async () => {
    // The same full page twice: the cursor is not moving. Returning what was
    // read so far would be a silent truncation with extra steps.
    const page = rowsOf(1000);
    const db = fakePostgrest({ set_logs: () => ({ rows: page }) });
    await expect(
      fetchAllRows(() => {
        const q = db.from('set_logs').select('id, n');
        q.gt = () => q; // the "server" ignores the cursor
        return q;
      }),
    ).rejects.toThrow(/cannot advance/);
  });

  it('throws the error of a failed page rather than returning the pages before it', async () => {
    const boom = { code: '57014', message: 'canceling statement due to statement timeout' };
    const all = rowsOf(1500);
    const db = fakePostgrest({
      set_logs: (request) =>
        request.filters.some(([op]) => op === 'gt') ? { error: boom } : { rows: all },
    });
    await expect(read(db)).rejects.toBe(boom);
  });

  it('refuses a select without the key column, on the first page already', async () => {
    const db = fakePostgrest({ set_logs: [{ n: 1 }] });
    await expect(read(db)).rejects.toThrow(/select must include/);
  });

  it('walks another unique column downwards when asked to', async () => {
    const days = Array.from({ length: 5 }, (_, i) => ({ logged_on: `2026-04-0${i + 1}`, weight_kg: 70 + i }));
    const db = fakePostgrest({ bodyweight_logs: days });
    const rows = await fetchAllRows(
      () => db.from('bodyweight_logs').select('weight_kg, logged_on').eq('student_id', 'prof-1'),
      { column: 'logged_on', ascending: false, pageSize: 2 },
    );

    // Newest first, every day once.
    expect(rows.map((r) => r.logged_on)).toEqual([
      '2026-04-05', '2026-04-04', '2026-04-03', '2026-04-02', '2026-04-01',
    ]);
    expect(db.requests).toHaveLength(3);
    expect(db.requests[0].order).toEqual({ column: 'logged_on', ascending: false });
    expect(db.requests[1].filters).toContainEqual(['lt', 'logged_on', '2026-04-04']);
    expect(db.requests[2].filters).toContainEqual(['lt', 'logged_on', '2026-04-02']);
  });

  it('takes the page size as a bare number too', async () => {
    const db = fakePostgrest({ set_logs: rowsOf(5) });
    const rows = await read(db, 2);
    expect(rows).toHaveLength(5);
    expect(db.requests.map((r) => r.limit)).toEqual([2, 2, 2]);
  });

  it('rejects a page size that cannot page', async () => {
    const db = fakePostgrest({ set_logs: rowsOf(5) });
    await expect(read(db, 0)).rejects.toThrow(/pageSize/);
    expect(db.requests).toHaveLength(0);
  });
});

// The fake above speaks in builder calls. This one goes through the real
// supabase-js builder down to the URL, which is what PostgREST reads.
describe('fetchAllRows — the requests supabase-js sends', () => {
  it('orders on id, limits to a page, and puts the cursor in the next URL', async () => {
    const all = Array.from({ length: 1003 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      done: true,
    }));
    const urls = [];
    const fetchStub = async (input) => {
      const url = new URL(typeof input === 'string' ? input : input.url);
      urls.push(url);
      const after = url.searchParams.get('id')?.replace(/^gt\./, '');
      const limit = Number(url.searchParams.get('limit'));
      const page = all.filter((r) => !after || r.id > after).slice(0, Math.min(limit, 1000));
      return new Response(JSON.stringify(page), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const client = createClient('http://localhost:54321', 'anon-key', {
      global: { fetch: fetchStub },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });

    const rows = await fetchAllRows(() =>
      client
        .from('set_logs')
        .select('id, done, exercise_slots!inner(sessions!inner(weeks!inner(programs!inner(student_id))))')
        .eq('done', true)
        .eq('exercise_slots.sessions.weeks.programs.student_id', 'st-1'),
    );

    expect(rows).toHaveLength(1003);
    expect(urls).toHaveLength(2);
    for (const url of urls) {
      expect(url.pathname).toBe('/rest/v1/set_logs');
      expect(url.searchParams.get('order')).toBe('id.asc');
      expect(url.searchParams.get('limit')).toBe('1000');
      expect(url.searchParams.get('done')).toBe('eq.true');
      expect(url.searchParams.get('exercise_slots.sessions.weeks.programs.student_id')).toBe('eq.st-1');
      // Keyset, not offset.
      expect(url.searchParams.has('offset')).toBe(false);
    }
    expect(urls[0].searchParams.has('id')).toBe(false);
    expect(urls[1].searchParams.get('id')).toBe(`gt.${all[999].id}`);
  });
});

// `.limit(20000)` was how three hooks believed they read everything. A limit
// above one page is always that belief: the server returns a page at most.
describe('no read asks PostgREST for more than a page', () => {
  const root = resolve(__dirname, '../..');
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return walk(path);
      return /\.(js|jsx)$/.test(entry.name) && !/\.test\.(js|jsx)$/.test(entry.name) ? [path] : [];
    });

  // Reads known to ask for more than a page, each waiting for the package that
  // pages it. Delete the entry with the fix.
  const WAITING = {
    // The conversation list: 2000 asked, 1000 received (coach-lists-scale).
    'src/hooks/useMessages.js': [2000],
  };

  it('holds for every source file', () => {
    const offenders = {};
    for (const file of walk(resolve(root, 'src'))) {
      const name = relative(root, file).split('\\').join('/');
      if (name.startsWith('src/test/')) continue;
      // Code only: a comment may well quote the mistake it explains.
      const code = readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
        .join('\n');
      const found = [...code.matchAll(/\.limit\(\s*([\d_]+)\s*\)/g)]
        .map((m) => Number(m[1].replace(/_/g, '')))
        .filter((n) => n > PAGE_SIZE);
      const waiting = WAITING[name] || [];
      const unexpected = found.filter((n) => !waiting.includes(n));
      if (unexpected.length) offenders[name] = unexpected;
    }
    // A hit here is a read that silently stops at 1000 rows: page it with
    // fetchAllRows, or narrow it on the server.
    expect(offenders).toEqual({});
  });
});
