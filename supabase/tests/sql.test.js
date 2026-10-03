// sql.js: running a file the way the SQL editor does, and cutting one into
// its statements. Both are what the migration tests stand on.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { catalogSnapshot, diffCatalogs } from './catalog.js';
import {
  asAdmin, attempt, repoRoot, scratchDatabase,
} from './harness.js';
import { splitStatements } from './sql.js';

describe('splitStatements', () => {
  it('cuts on the semicolons that end a statement, and on no other', () => {
    const sql = [
      '-- a comment; with a semicolon',
      'BEGIN;',
      "SET LOCAL lock_timeout = '5s'; /* block; comment /* nested; */ still; */",
      'DO $guard$',
      'BEGIN',
      "  RAISE EXCEPTION 'no; not here';  -- nor here;",
      'END',
      '$guard$;',
      `CREATE FUNCTION f() RETURNS text LANGUAGE sql AS $$ select 'a;b' || $1 $$;`,
      `INSERT INTO t ("odd;name", note) VALUES (1, 'it''s; fine'), (2, E'tab\\'s; too');`,
      'COMMIT',
    ].join('\n');

    expect(splitStatements(sql).map((s) => [s.line, s.text.split('\n')[0]])).toEqual([
      [2, 'BEGIN'],
      [3, "SET LOCAL lock_timeout = '5s'"],
      [4, 'DO $guard$'],
      [9, `CREATE FUNCTION f() RETURNS text LANGUAGE sql AS $$ select 'a;b' || $1 $$`],
      [10, `INSERT INTO t ("odd;name", note) VALUES (1, 'it''s; fine'), (2, E'tab\\'s; too')`],
      [11, 'COMMIT'],
    ]);
  });

  it('keeps what a dollar-quoted body says, and drops what a comment says', () => {
    const [guard] = splitStatements(`DO $$ BEGIN -- inside: kept\n PERFORM 1; END $$; -- outside: dropped`);
    expect(guard.text).toContain('-- inside: kept');
    expect(guard.text).not.toContain('dropped');
  });

  it('finds no statement in comments and stray semicolons', () => {
    expect(splitStatements('-- nothing here\n/* at all */\n  ;;')).toEqual([]);
  });

  it('cuts schema.sql into the statements PostgreSQL sees', async () => {
    // The real file is the hardest input there is: function bodies, DO
    // blocks, policies with quoted names. Loaded one cut at a time, it must
    // build the same database as loaded in one go — a wrong cut is a syntax
    // error, or an object that went missing.
    const statements = splitStatements(await readFile(path.join(repoRoot, 'supabase/schema.sql'), 'utf8'));
    expect(statements.length).toBeGreaterThan(200);

    const db = await scratchDatabase();
    for (const statement of statements) await db.runSql(statement.text, `schema.sql:${statement.line}`);
    expect(diffCatalogs(
      await catalogSnapshot(db.query),
      await asAdmin((q) => catalogSnapshot(q)),
      { left: 'statement by statement', right: 'in one go' },
    )).toEqual([]);
    await db.drop();
  });
});

describe('a scratch database', () => {
  it('starts as an empty Supabase project, or as a copy of schema.sql', async () => {
    const tables = `select count(*) from pg_tables where schemaname = 'public'`;
    const bare = await scratchDatabase();
    const schema = await scratchDatabase({ from: 'schema' });
    expect(await bare.query.value(tables)).toBe(0);
    expect(await bare.query.value(`select count(*) from pg_roles where rolname in ('anon', 'authenticated', 'service_role')`)).toBe(3);
    expect(await schema.query.value(tables)).toBeGreaterThan(0);
    expect(await bare.query.value(`select current_user`)).toBe('postgres');
    await bare.drop();
    await schema.drop();
  });

  it('names the line of a statement PostgreSQL cannot parse, and keeps its SQLSTATE', async () => {
    const db = await scratchDatabase();
    const failed = await attempt(() => db.runSql('select 1;\nselect 2;\nselec 3;\n', 'some/file.sql'));
    expect(failed.error.message).toMatch(/^some\/file\.sql:3: syntax error at or near "selec"/);
    expect(failed.error.code).toBe('42601');
    await db.drop();
  });

  it('applies a file with its own BEGIN … COMMIT completely or not at all', async () => {
    const db = await scratchDatabase();
    const failed = await attempt(() => db.runSql(
      `BEGIN;
       CREATE TABLE public.half_done (id int);
       DO $$ BEGIN RAISE EXCEPTION 'stop here' USING ERRCODE = 'SLM01'; END $$;
       COMMIT;`,
      'migration',
    ));
    expect(failed.error.code).toBe('SLM01');
    expect(await db.query.value(`select to_regclass('public.half_done') is null`)).toBe(true);
    // The failed transaction was closed: the next file runs normally.
    await db.runSql(`BEGIN; CREATE TABLE public.done (id int); COMMIT;`, 'migration');
    expect(await db.query.value(`select to_regclass('public.done') is not null`)).toBe(true);
    await db.drop();
  });

  it('refuses a write in readOnly()', async () => {
    const db = await scratchDatabase({ from: 'schema' });
    const [result] = await db.readOnly(`select count(*) as profiles from public.profiles`, 'audit');
    expect(result.rows).toEqual([{ profiles: 0 }]);
    const wrote = await attempt(() => db.readOnly(`delete from public.profiles`, 'audit'));
    expect(wrote.error.code).toBe('25006');
    await db.drop();
  });
});
