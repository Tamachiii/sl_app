// Who holds what on the tables of `public` — review finding L24, closed by
// migration 2026_10_13_14_table_grants_lockdown.
//
// Supabase grants `anon`, `authenticated` and `service_role` EVERY privilege,
// by name, on every table `postgres` creates in `public`. Row-level security
// was therefore the only gate on all 20 tables — and it is a gate for rows.
// TRUNCATE is not subject to it: `truncate public.profiles cascade`, sent as
// `anon`, emptied the database. Since the migration:
//
//   anon, PUBLIC      nothing — on a table, a view or a sequence
//   authenticated     SELECT, INSERT, UPDATE, DELETE on a table: the four the
//                     policies judge row by row. USAGE on a sequence.
//   service_role      everything (the Edge Functions), and so the owner
//   a new table       starts with the same
//
// The first blocks are PERMANENT: they read the catalog of schema.sql, so they
// hold for every table a later migration adds.
//
// ADDING A TABLE — a migration that creates one:
//   * enables row-level security on it in the same file, and writes its
//     policies. The four privileges of a signed-in user are on every table:
//     without row-level security they are the whole table, for every account;
//   * defines it ABOVE the TABLE PRIVILEGES block of schema.sql, and carries
//     its own REVOKE and GRANT in the migration (supabase/migrations/README.md);
//   * gives rls-matrix.test.js its insert probe.
// A view is created WITH (security_invoker = true). A table on which a
// signed-in user must hold LESS than the four is listed in LESS_FOR_USERS,
// with the reason.
//
// Then: every table is sent every statement by each caller the app has, and
// the migration file itself is applied to the frozen production baseline,
// with the checks of its runbook page read off the page.

import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  asAdmin, asAnon, asService, asUser, attempt, repoRoot, scenario, scratchDatabase, seed,
} from './harness.js';
import { catalogSnapshot, diffCatalogs } from './catalog.js';
import { splitStatements } from './sql.js';
import { LEDGER, loadManifest, REFUSAL } from '../migrations/manifest.js';

const MIGRATION = '2026_10_13_14_table_grants_lockdown';
const manifest = loadManifest();
const migration = manifest.migrations.find((m) => m.name === MIGRATION);
const read = (file) => fs.readFileSync(path.join(repoRoot, file), 'utf8');

// ------------------------------------------------------------
// The privileges there are, and who is meant to hold which.
// ------------------------------------------------------------
/** Every privilege on a table or a view, sorted. */
const EVERYTHING = ['DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE'];
/** What a signed-in user holds on a table: what row-level security judges. */
const ROWS = ['DELETE', 'INSERT', 'SELECT', 'UPDATE'];
/** Every privilege on a sequence; a signed-in user holds USAGE (nextval). */
const ON_A_SEQUENCE = ['SELECT', 'UPDATE', 'USAGE'];
/**
 * Tables on which a signed-in user holds less than ROWS:
 * `[table, [what it does hold], why]`. None today.
 */
const LESS_FOR_USERS = [];

// Every table, view and sequence of `public`, with what each role can do to
// it — as PostgreSQL answers it: a grant to PUBLIC counts, and so does a grant
// on a single column of a table.
const relationsOfPublic = (q) => q.rows(
  `select c.relname::text as name,
          case c.relkind when 'v' then 'view' when 'm' then 'materialized view'
                         when 'f' then 'foreign table' when 'S' then 'sequence' else 'table' end as kind,
          pg_get_userbyid(c.relowner)::text as owner,
          c.relrowsecurity as rls,
          coalesce(c.reloptions, '{}') as options,
          (select coalesce(array_agg(g.name order by g.name collate "C"), '{}')
             from (select distinct case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee)::text end as name
                     from aclexplode(coalesce(c.relacl, acldefault(case when c.relkind = 'S' then 'S' else 'r' end::"char", c.relowner))) a) g
          ) as grantees,
          (select coalesce(array_agg(a.attname::text order by a.attnum), '{}')
             from pg_attribute a
            where a.attrelid = c.oid and a.attacl is not null and not a.attisdropped) as column_grants,
          (select jsonb_object_agg(w.who, (
                    select coalesce(jsonb_agg(p.privilege order by p.privilege), '[]')
                      from unnest(case when c.relkind = 'S' then $2::text[] else $1::text[] end) as p (privilege)
                     where case when c.relkind = 'S' then has_sequence_privilege(w.who, c.oid, p.privilege)
                                when p.privilege in ('SELECT', 'INSERT', 'UPDATE', 'REFERENCES')
                                  then has_any_column_privilege(w.who, c.oid, p.privilege)
                                else has_table_privilege(w.who, c.oid, p.privilege) end))
             from (values ('anon'), ('authenticated'), ('service_role'), ('postgres')) as w (who)) as held
     from pg_class c
    where c.relnamespace = 'public'::regnamespace
      and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
    order by 1`,
  [EVERYTHING, ON_A_SEQUENCE],
);

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const SECURITY_INVOKER = /^security_invoker=(true|on|1|yes)$/i;

/** What a signed-in user is meant to hold on a relation of `public`. */
function forUsers({ name, kind }) {
  if (kind === 'sequence') return ['USAGE'];
  // Row-level security guards tables, and views that read with the caller's
  // rights. Nothing guards the rows of a materialized view or a foreign table.
  if (kind !== 'table' && kind !== 'view') return [];
  return LESS_FOR_USERS.find(([table]) => table === name)?.[1] ?? ROWS;
}

/**
 * What is wrong with the relations of `public`, rule by rule: each a list of
 * sentences, `[]` when the rule holds.
 */
function judge(relations) {
  const out = { rls: [], views: [], anon: [], everyone: [], users: [], keepers: [], grantees: [], owners: [] };
  const list = (privileges) => privileges.join(', ') || 'nothing';
  for (const r of relations) {
    const all = r.kind === 'sequence' ? ON_A_SEQUENCE : EVERYTHING;
    if (r.kind === 'table' && !r.rls) out.rls.push(r.name);
    if (r.kind === 'view' && !r.options.some((option) => SECURITY_INVOKER.test(option))) out.views.push(r.name);
    if (r.held.anon.length) out.anon.push(`${r.name}: ${list(r.held.anon)}`);
    if (r.grantees.includes('PUBLIC')) out.everyone.push(r.name);
    if (!same(r.held.authenticated, forUsers(r))) out.users.push(`${r.name}: ${list(r.held.authenticated)}`);
    for (const keeper of ['service_role', 'postgres']) {
      if (!same(r.held[keeper], all)) out.keepers.push(`${r.name}: ${keeper} holds ${list(r.held[keeper])}`);
    }
    const others = r.grantees.filter((role) => !['authenticated', 'postgres', 'service_role'].includes(role));
    if (others.length || r.column_grants.length) {
      out.grantees.push(`${r.name}: ${[...others, ...r.column_grants.map((column) => `column ${column}`)].join(', ')}`);
    }
    if (r.owner !== 'postgres') out.owners.push(`${r.name}: ${r.owner}`);
  }
  return out;
}

const deniedTable = (name) => `permission denied for table ${name}`;
const isDenied = (error) => error?.code === '42501' && /^permission denied for /.test(error.message);

// An INSERT of no row: the privilege is asked all the same. The columns are
// named because a generated one cannot be written.
const insertNothing = (q, table) => q.value(
  `select format('insert into %s (%s) select %2$s from %1$s limit 0', $1::text,
                 string_agg(quote_ident(a.attname), ', ' order by a.attnum))
     from pg_attribute a
    where a.attrelid = $1::regclass and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''`,
  [table],
);

let ids;
let catalog;   // relationsOfPublic(), read once
let tables;    // the names of the tables among them
let judged;

beforeAll(async () => {
  ids = await seed();
  catalog = await asAdmin(relationsOfPublic);
  tables = catalog.filter((r) => r.kind === 'table').map((r) => r.name);
  judged = judge(catalog);
});

// ============================================================
// PERMANENT — read off the catalog of schema.sql
// ============================================================
describe('who holds what on the tables of public', () => {
  it('reads a catalog that has the tables of the app in it, and lists that name tables', () => {
    expect(tables.length).toBeGreaterThanOrEqual(20);
    expect(tables).toEqual(expect.arrayContaining(['profiles', 'students', 'programs', 'sessions', 'set_logs', 'messages']));
    const listed = LESS_FOR_USERS.map(([table]) => table);
    expect(listed.filter((table) => !tables.includes(table)), 'listed in LESS_FOR_USERS, not a table of public').toEqual([]);
    for (const [table, held, why] of LESS_FOR_USERS) {
      expect(held.every((privilege) => ROWS.includes(privilege)) && held.length < ROWS.length, table).toBe(true);
      expect(why, table).toMatch(/\S{3,}/);
    }
  });

  it('no table is without row-level security', () => {
    expect(
      judged.rls,
      'a signed-in user holds SELECT, INSERT, UPDATE and DELETE on every table of public: without row-level security '
      + 'that is every row, for every account. Write `ALTER TABLE … ENABLE ROW LEVEL SECURITY` and the policies next '
      + 'to the table, in the migration and in schema.sql',
    ).toEqual([]);
  });

  it('a view reads with the rights of whoever asks (security_invoker)', () => {
    expect(
      judged.views,
      'a view runs with the rights of its owner, which row-level security does not hold: it shows every row of its '
      + 'tables to whoever may read it. Create it WITH (security_invoker = true)',
    ).toEqual([]);
  });

  it('a request without a session holds nothing — on a table, a view or a sequence — and neither does PUBLIC', () => {
    expect(judged.anon, 'never a GRANT to anon: nothing of this app is served without a session').toEqual([]);
    expect(judged.everyone, 'a grant to PUBLIC is a grant to anon').toEqual([]);
  });

  it('a signed-in user holds SELECT, INSERT, UPDATE and DELETE on every table, and nothing else', () => {
    expect(
      judged.users,
      'what `authenticated` holds on a table of public is not the four privileges row-level security judges (USAGE, on '
      + 'a sequence): see the TABLE PRIVILEGES block of schema.sql, and LESS_FOR_USERS in this file for a table that '
      + 'must give less',
    ).toEqual([]);
    // Not vacuous: said of each table by name.
    for (const table of tables) {
      expect(catalog.find((r) => r.name === table).held.authenticated, table)
        .toEqual(LESS_FOR_USERS.find(([name]) => name === table)?.[1] ?? ROWS);
    }
  });

  it('the service role and the owner hold everything', () => {
    expect(judged.keepers).toEqual([]);
    expect(judged.owners).toEqual([]);
  });

  it('the grants are the owner, service_role and authenticated — no other role, and none on a single column', () => {
    expect(judged.grantees).toEqual([]);
    expect(catalog.filter((r) => r.kind === 'table' && !same(r.grantees, ['authenticated', 'postgres', 'service_role']))
      .map((r) => `${r.name}: ${r.grantees.join(', ')}`)).toEqual([]);
  });
});

// The default privileges, and the traps they leave: what the rules above are
// for. Each is shown going wrong first.
describe('a table created after schema.sql', () => {
  const probe = async (q, name) => (await relationsOfPublic(q)).find((r) => r.name === name);

  it('in public: nothing without a session, rows for a signed-in user, everything for the service role', () => scenario(async (q) => {
    await q(`create table public.acl_probe (id bigserial primary key, label text)`);
    expect((await probe(q, 'acl_probe')).held).toEqual({
      anon: [], authenticated: ROWS, service_role: EVERYTHING, postgres: EVERYTHING,
    });
    // The counter of its serial column: the next number, and no more.
    expect((await probe(q, 'acl_probe_id_seq')).held).toEqual({
      anon: [], authenticated: ['USAGE'], service_role: ON_A_SEQUENCE, postgres: ON_A_SEQUENCE,
    });

    const said = async (as, sql) => {
      const tried = await attempt(() => as((caller) => caller(sql)));
      return tried.ok ? 'went through' : tried.error.message;
    };
    const anon = (sql) => said(asAnon, sql);
    const athlete = (sql) => said((fn) => asUser(ids.studentA, fn), sql);
    const service = (sql) => said(asService, sql);

    expect(await anon(`select count(*) from public.acl_probe`)).toBe(deniedTable('acl_probe'));
    expect(await anon(`insert into public.acl_probe (label) values ('x')`)).toBe(deniedTable('acl_probe'));
    expect(await anon(`select nextval('public.acl_probe_id_seq')`)).toBe('permission denied for sequence acl_probe_id_seq');

    expect(await athlete(`insert into public.acl_probe (label) values ('mine')`)).toBe('went through');
    expect(await athlete(`select setval('public.acl_probe_id_seq', 1)`)).toBe('permission denied for sequence acl_probe_id_seq');
    expect(await athlete(`select last_value from public.acl_probe_id_seq`)).toBe('permission denied for sequence acl_probe_id_seq');
    expect(await athlete(`truncate public.acl_probe`)).toBe(deniedTable('acl_probe'));
    expect(await athlete(`reindex table public.acl_probe`)).toBe(deniedTable('acl_probe'));

    expect(await service(`insert into public.acl_probe (label) values ('theirs')`)).toBe('went through');
    expect(await service(`truncate public.acl_probe`)).toBe('went through');

    // An identity column asks nothing of whoever inserts: not even USAGE.
    await q(`create table public.acl_probe_identity (id bigint generated always as identity primary key, label text)`);
    await q(`revoke all on sequence public.acl_probe_identity_id_seq from authenticated`);
    expect(await athlete(`insert into public.acl_probe_identity (label) values ('mine')`)).toBe('went through');
  }));

  // The four privileges are on the new table from its first moment. What
  // keeps one account out of the rows of another is row-level security, and
  // only that — which is why the catalog is asked for it above.
  it('…and until it has row-level security, every signed-in user reads and writes all of it', () => scenario(async (q) => {
    await q(`create table public.acl_probe (id uuid primary key default gen_random_uuid(), owner_id uuid, label text)`);
    await asUser(ids.studentA, (athlete) => athlete(
      `insert into public.acl_probe (owner_id, label) values ($1, 'private')`, [ids.studentA.id],
    ));
    const seenByAnother = () => asUser(ids.studentB, (other) => other.value(`select count(*) from public.acl_probe`));
    expect(await seenByAnother()).toBe(1);
    expect(judge(await relationsOfPublic(q)).rls).toEqual(['acl_probe']);

    await q(`alter table public.acl_probe enable row level security`);
    await q(`create policy "own rows" on public.acl_probe for all using (owner_id = auth.uid()) with check (owner_id = auth.uid())`);
    expect(await seenByAnother()).toBe(0);
    expect(await asUser(ids.studentA, (athlete) => athlete.value(`select count(*) from public.acl_probe`))).toBe(1);
    expect(judge(await relationsOfPublic(q)).rls).toEqual([]);
  }));

  it('a view shows every row to whoever may read it, unless it is security_invoker', () => scenario(async (q) => {
    const all = await q.value(`select count(*) from public.profiles`);
    const own = await asUser(ids.studentA, (athlete) => athlete.value(`select count(*) from public.profiles`));
    expect(own).toBeLessThan(all);

    await q(`create view public.acl_probe_view as select id, role, full_name from public.profiles`);
    const through = () => asUser(ids.studentA, (athlete) => athlete.value(`select count(*) from public.acl_probe_view`));
    expect((await probe(q, 'acl_probe_view')).held.authenticated).toEqual(ROWS);
    expect(await through()).toBe(all);
    expect(judge(await relationsOfPublic(q)).views).toEqual(['acl_probe_view']);

    await q(`alter view public.acl_probe_view set (security_invoker = true)`);
    expect(await through()).toBe(own);
    expect(judge(await relationsOfPublic(q)).views).toEqual([]);
    // Without a session, neither kind is read.
    const anonymous = await attempt(() => asAnon((anon) => anon.value(`select count(*) from public.acl_probe_view`)));
    expect(anonymous.error?.message).toBe('permission denied for view acl_probe_view');
  }));

  // The judge of this file, tried on what it must refuse: a judge that
  // accepts everything looks exactly like a green suite.
  it('…and the checks on the catalog would notice a privilege that comes back', () => scenario(async (q) => {
    await q(`grant select on public.profiles to anon`);
    await q(`grant select on public.students to public`);
    await q(`grant truncate on public.set_logs to authenticated`);
    await q(`revoke insert on public.messages from authenticated`);
    await q(`grant select (message) on public.client_errors to authenticated`);
    await q(`revoke truncate on public.goals from service_role`);
    await q(`create sequence public.acl_probe_seq`);
    await q(`grant select on sequence public.acl_probe_seq to authenticated`);
    await q(`create materialized view public.acl_probe_mat as select id from public.profiles`);

    const found = judge(await relationsOfPublic(q));
    expect(found.anon).toEqual(['profiles: SELECT', 'students: SELECT']);
    expect(found.everyone).toEqual(['students']);
    expect(found.users).toEqual([
      'acl_probe_mat: DELETE, INSERT, SELECT, UPDATE',
      'acl_probe_seq: SELECT, USAGE',
      'messages: DELETE, SELECT, UPDATE',
      'set_logs: DELETE, INSERT, SELECT, TRUNCATE, UPDATE',
    ]);
    expect(found.keepers).toEqual(['goals: service_role holds DELETE, INSERT, MAINTAIN, REFERENCES, SELECT, TRIGGER, UPDATE']);
    expect(found.grantees).toEqual(['client_errors: column message', 'profiles: anon', 'students: PUBLIC']);
  }));
});

// The plan: one block at the end of schema.sql, like the one for functions.
// Read off the text of the file.
describe('schema.sql says who holds what on a table in one place', () => {
  const statements = splitStatements(read('supabase/schema.sql')).map((s) => s.text.replace(/\s+/g, ' '));
  const ON_FUNCTION = /\bon (all )?(function|functions|routine|routines|procedure|procedures)\b/i;
  // A GRANT or a REVOKE that is not about a function, a schema, or the
  // private schema of the ledger: it is about a table or a sequence of public.
  const ON_TABLE = (s) => /^(grant|revoke)\b/i.test(s) && !ON_FUNCTION.test(s)
    && !/\bon schema\b/i.test(s) && !/\bapp_private\./i.test(s);
  const DEFAULTS = (s) => /^alter default privileges\b.*\bon (tables|sequences)\b/i.test(s);
  const inBlock = (s) => ON_TABLE(s) || DEFAULTS(s);
  const start = statements.findIndex(inBlock);

  it('has a block of table privileges', () => {
    expect(start).toBeGreaterThan(0);
    const block = statements.filter(inBlock).map((s) => s.toLowerCase());
    expect(block).toEqual(expect.arrayContaining([
      'alter default privileges for role postgres in schema public revoke all on tables from anon',
      'alter default privileges for role postgres in schema public revoke all on sequences from anon',
      'alter default privileges for role postgres in schema public revoke truncate, references, trigger, maintain on tables from authenticated',
      'alter default privileges for role postgres in schema public revoke select, update on sequences from authenticated',
      'revoke all on all tables in schema public from public, anon',
      'revoke all on all sequences in schema public from public, anon',
      'revoke truncate, references, trigger, maintain on all tables in schema public from authenticated',
      'revoke select, update on all sequences in schema public from authenticated',
    ]));
  });

  it('is in one piece, and no table, view or sequence of public is created below it', () => {
    const after = statements.slice(start);
    const block = after.filter(inBlock);
    // Every statement about table privileges, one after the other: none
    // stands next to a table further up, none comes back further down.
    expect(after.slice(0, block.length)).toEqual(block);
    expect(
      after.filter((s) => /^create (or replace )?((unlogged|temp|temporary|recursive|materialized|foreign) )*(table|view|sequence)\b/i.test(s)
        && !/^create [a-z ]*?(table|view|sequence) (if not exists )?app_private\./i.test(s)),
      'a table defined below the TABLE PRIVILEGES block is not covered by its REVOKE: move it above',
    ).toEqual([]);
  });

  it('gives nothing to anon or PUBLIC, anywhere in the file', () => {
    expect(statements.filter((s) => /^grant\b/i.test(s) && /\bto\b.*\b(anon|public)\b/i.test(s))).toEqual([]);
    // What it gives a signed-in user on a table, it gives in the block.
    expect(statements.slice(0, start).filter((s) => /^grant\b/i.test(s) && !ON_FUNCTION.test(s))).toEqual([]);
  });
});

// ============================================================
// Sent, by everyone
// ============================================================
describe('without a session', () => {
  it('every table refuses every statement, before a policy or a helper is looked at', () => scenario(async (q) => {
    for (const table of tables) {
      const name = `public.${table}`;
      const sent = [
        `select count(*) from ${name}`,
        await insertNothing(q, name),
        `update ${name} set id = id`,
        `delete from ${name}`,
        `truncate ${name}`,
        `truncate ${name} cascade`,
      ];
      for (const sql of sent) {
        const tried = await attempt(() => asAnon((anon) => anon.dryRun(sql)));
        expect(tried.error?.message, sql).toBe(deniedTable(table));
        expect(tried.error.code, sql).toBe('42501');
      }
    }
    expect(await q.value(`select count(*) from public.set_logs`)).toBe(30);
  }));
});

describe('signed in', () => {
  const callers = () => [['athlete A', ids.studentA], ['the coach', ids.coach]];

  // rls-matrix.test.js says how many rows each of them gets; this says that no
  // statement of the four kinds stops at the door of a table.
  it('reading, inserting, updating and deleting are refused by no table for want of a privilege', () => scenario(async (q) => {
    const refused = [];
    for (const table of tables) {
      const name = `public.${table}`;
      const sent = [`select count(*) from ${name}`, await insertNothing(q, name), `update ${name} set id = id`, `delete from ${name}`];
      for (const [who, user] of callers()) {
        for (const sql of sent) {
          const tried = await attempt(() => asUser(user, (caller) => caller.dryRun(sql)));
          if (isDenied(tried.error)) refused.push(`${who}: ${sql.split(' (')[0]} — ${tried.error.message}`);
        }
      }
    }
    expect(refused).toEqual([]);
  }));

  it('nobody empties a table, rebuilds one or hangs a trigger on one', () => scenario(async (q) => {
    for (const [who, user] of callers()) {
      const said = async (sql) => (await attempt(() => asUser(user, (caller) => caller(sql)))).error?.message ?? 'went through';
      for (const table of tables) {
        expect(await said(`truncate public.${table}`), `${who}: ${table}`).toBe(deniedTable(table));
      }
      // The statement the finding is about: one line, every table of the app.
      expect(await said(`truncate public.profiles cascade`), who).toBe(deniedTable('profiles'));
      expect(await said(`reindex table public.set_logs`), who).toBe(deniedTable('set_logs'));
      // A trigger function everyone may execute: the table is what refuses.
      expect(await said(
        `create trigger acl_probe before update on public.set_logs
           for each row execute function suppress_redundant_updates_trigger()`,
      ), who).toBe(deniedTable('set_logs'));
    }
    expect(await q.value(`select count(*) from public.set_logs`)).toBe(30);
    expect(await q.value(`select count(*) from pg_trigger where tgname = 'acl_probe'`)).toBe(0);
  }));

  it('the service role still holds everything: it empties a table', () => scenario(async (q) => {
    await q(`insert into public.client_errors (user_id, message) values ($1, 'boom')`, [ids.studentA.id]);
    await asService((service) => service(`truncate public.client_errors`));
    expect(await q.value(`select count(*) from public.client_errors`)).toBe(0);
  }));
});

// ============================================================
// The migration file, on the database it is written for: the frozen
// production baseline with the migrations before it. And the checks its
// runbook page gives, read off the page.
// ============================================================
describe('migration 14 applied to the production baseline', () => {
  const COACH = '00000000-0000-4000-8000-00000000c0ac';
  const ATHLETE = '00000000-0000-4000-8000-0000000000a1';
  const LINK = '00000000-0000-4000-8000-000000000101';
  const EXERCISE = '00000000-0000-4000-8000-000000000201';
  const BLOCK = '00000000-0000-4000-8000-000000000301';
  const WEEK = '00000000-0000-4000-8000-000000000401';
  const S1 = '00000000-0000-4000-8000-000000000451';
  const S2 = '00000000-0000-4000-8000-000000000452';
  const SLOT1 = '00000000-0000-4000-8000-000000000501';
  const SLOT2 = '00000000-0000-4000-8000-000000000502';
  const TO_COME = '2099_01_01_99_a_migration_to_come';

  // A coach, an athlete, a block of two sessions with the same exercise.
  // The role is set the way a dump restore sets it: on the baseline the
  // documented `update profiles set role = 'coach'` is undone for every
  // caller (finding P20, closed by migration 07).
  const WORLD = `
    insert into auth.users (id, email, aud, role, email_confirmed_at, raw_user_meta_data) values
      ('${COACH}',   'coach@sl.test', 'authenticated', 'authenticated', now(), '{"full_name": "Coach"}'),
      ('${ATHLETE}', 'alex@sl.test',  'authenticated', 'authenticated', now(), '{"full_name": "Alex"}');
    BEGIN;
    SET LOCAL session_replication_role = replica;
    update public.profiles set role = 'coach' where id = '${COACH}';
    COMMIT;
    insert into public.students (id, profile_id, coach_id) values ('${LINK}', '${ATHLETE}', '${COACH}');
    insert into public.exercise_library (id, coach_id, name, type, difficulty)
      values ('${EXERCISE}', '${COACH}', 'Pull-up', 'pull', 2);
    insert into public.programs (id, student_id, name, is_active) values ('${BLOCK}', '${LINK}', 'Block', true);
    insert into public.weeks (id, program_id, week_number) values ('${WEEK}', '${BLOCK}', 1);
    insert into public.sessions (id, week_id, title, sort_order) values
      ('${S1}', '${WEEK}', 'S1', 0), ('${S2}', '${WEEK}', 'S2', 1);
    insert into public.exercise_slots (id, session_id, exercise_id, sets, reps, sort_order) values
      ('${SLOT1}', '${S1}', '${EXERCISE}', 3, 5, 0), ('${SLOT2}', '${S2}', '${EXERCISE}', 3, 5, 0);
    insert into public.set_logs (exercise_slot_id, set_number, target_reps)
      select '${SLOT1}', n, 5 from generate_series(1, 3) as n;
  `;

  /** The frozen baseline with that world in it and the migrations before 14 applied. */
  const production = async () => {
    const db = await scratchDatabase();
    await db.runFile(manifest.baseline);
    await db.runSql(WORLD, 'world');
    for (const earlier of manifest.migrations) {
      if (earlier.name === MIGRATION) break;
      await db.runFile(earlier.paths.migration);
    }
    return db;
  };

  // One transaction, always undone. Each step is a statement, or an actor:
  // from there on the statements are a request of that caller, role and
  // claims set the way PostgREST sets them. The answer is the first value of
  // the last statement, or the message of the statement that raised.
  const user = (sub) => ({ role: 'authenticated', claims: { role: 'authenticated', sub } });
  const NOBODY = { role: 'anon', claims: { role: 'anon' } };
  const THE_ATHLETE = user(ATHLETE);
  const THE_COACH = user(COACH);
  const THE_SERVICE = { role: 'service_role', claims: { role: 'service_role' } };
  /** The SQL editor again: to read what a caller left behind. */
  const THE_OWNER = { role: 'postgres', claims: {} };
  const actor = (step) => `select set_config('role', '${step.role}', true), set_config('request.jwt.claims', '${JSON.stringify(step.claims)}', true)`;
  const story = async (db, ...steps) => {
    const text = steps.map((step) => (typeof step === 'string' ? step : actor(step)));
    const tried = await attempt(() => db.runSql(`BEGIN;\n${text.join(';\n')};\nROLLBACK;`, 'request'));
    if (!tried.ok) return (tried.error.cause ?? tried.error).message;
    const [found] = tried.value.at(-2).rows;
    return found ? Object.values(found)[0] : null;
  };

  const WIPE = `truncate public.profiles cascade`;
  const ROWS_LEFT = `select ((select count(*) from public.profiles) + (select count(*) from public.exercise_slots)
                             + (select count(*) from public.set_logs))::int`;
  const WENT_THROUGH = `select 'went through'`;
  const HANG_A_TRIGGER = `create trigger acl_probe before update on public.set_logs
                            for each row execute function suppress_redundant_updates_trigger()`;
  const tablesOf = async (db) => (await db.query.rows(
    `select c.relname::text as name from pg_class c
      where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' order by 1`,
  )).map((row) => row.name);

  // The runbook page, which is what the person applying the file reads.
  const page = read(migration.paths.runbook);
  // Its fenced commands, without the indent of the list item they stand in.
  const commands = [...page.matchAll(/^( *)```bash\n([\s\S]*?)\n\1```$/gm)]
    .map(([, indent, body]) => body.split('\n').map((line) => line.slice(indent.length)).join('\n'));
  const pageChecks = commands
    .map((command) => /^supabase db query --linked '(do \$check\$[\s\S]+\$check\$)'$/.exec(command)?.[1])
    .filter(Boolean);
  const [asAnonCheck, asUserCheck] = pageChecks;

  const printedAudit = async (db) => {
    const [result] = await db.readOnly(read(migration.paths.audit), 'audit');
    return result.rows.map((row) => [row.check, row.value]);
  };
  const auditLine = async (db, n) => (await printedAudit(db))[n - 1][1];
  const untouched = async (db, before) => {
    expect(diffCatalogs(before, await catalogSnapshot(db.query), { left: 'before', right: 'after' })).toEqual([]);
    expect(await db.query.value(`select count(*) from ${LEDGER} where name = $1`, [MIGRATION])).toBe(0);
  };

  it('the page gives the two checks this test runs', () => {
    expect(pageChecks).toHaveLength(2);
    expect(asAnonCheck).toBe('do $check$ begin set local role anon; perform 1 from public.profiles limit 1; end $check$');
    expect(asUserCheck).toContain('set local role authenticated;');
    // Pasted between single quotes in a shell: neither may hold one.
    expect(pageChecks.filter((sql) => sql.includes("'"))).toEqual([]);
  });

  it('one statement emptied the database, for anyone; after, no table lets it through; after the rollback it does again', async () => {
    const db = await production();
    expect(await story(db, THE_OWNER, ROWS_LEFT)).toBe(2 + 2 + 3);
    // "Every table of the app": each one hangs under profiles by a chain of
    // foreign keys, which is what CASCADE follows.
    expect(await db.query.rows(
      `with recursive reached (oid) as (
         select 'public.profiles'::regclass::oid
         union
         select k.conrelid from pg_constraint k join reached r on k.confrelid = r.oid where k.contype = 'f'
       )
       select c.relname from pg_class c
        where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.oid not in (select oid from reached)`,
    )).toEqual([]);

    // Before: the finding. Not through the API, which has no TRUNCATE — as the
    // role an API request runs as, which is what a function that executes a
    // text it was handed would run it as.
    expect(await story(db, NOBODY, WIPE, THE_OWNER, ROWS_LEFT)).toBe(0);
    expect(await story(db, THE_ATHLETE, WIPE, THE_OWNER, ROWS_LEFT)).toBe(0);
    expect(await story(db, NOBODY, HANG_A_TRIGGER, WENT_THROUGH)).toBe('went through');
    expect(await story(db, THE_ATHLETE, `reindex table public.set_logs`, WENT_THROUGH)).toBe('went through');
    // And the rows: nothing to read, and a write that is accepted and lost.
    expect(await story(db, NOBODY, `select count(*)::int from public.profiles`)).toBe(0);
    expect(await story(db, NOBODY, `with written as (update public.profiles set full_name = 'x' returning 1) select count(*)::int from written`)).toBe(0);
    await db.runSql(asAnonCheck, 'page check');   // goes through

    await db.runFile(migration.paths.migration);

    for (const caller of [NOBODY, THE_ATHLETE, THE_COACH]) {
      expect(await story(db, caller, WIPE, THE_OWNER, ROWS_LEFT)).toBe(deniedTable('profiles'));
      expect(await story(db, caller, HANG_A_TRIGGER, WENT_THROUGH)).toBe(deniedTable('set_logs'));
      expect(await story(db, caller, `reindex table public.set_logs`, WENT_THROUGH)).toBe(deniedTable('set_logs'));
    }
    expect(await story(db, NOBODY, `select count(*)::int from public.profiles`)).toBe(deniedTable('profiles'));
    expect(await story(db, NOBODY, `update public.profiles set full_name = 'x'`)).toBe(deniedTable('profiles'));
    const refused = await attempt(() => db.runSql(asAnonCheck, 'page check'));
    expect((refused.error?.cause ?? refused.error)?.message).toBe(deniedTable('profiles'));

    // Signed in, with the app that is deployed today: as before.
    expect(await story(db, THE_ATHLETE, `select count(*)::int from public.set_logs`)).toBe(3);
    expect(await story(db, THE_ATHLETE, `update public.set_logs set done = true where set_number = 1 returning done`)).toBe(true);
    expect(await story(db, THE_ATHLETE, `select count(*)::int from public.profiles`)).toBe(2);
    expect(await story(db, THE_COACH, `select count(*)::int from public.exercise_slots`)).toBe(2);
    expect(await story(db, THE_COACH, `delete from public.set_logs where set_number = 3 returning set_number`)).toBe(3);
    // A function that locks rows with the caller's rights (FOR UPDATE asks for UPDATE).
    expect(await story(
      db, THE_COACH, `select public.reorder_sessions('${WEEK}', array['${S2}', '${S1}']::uuid[])`,
      THE_OWNER, `select string_agg(title, ',' order by sort_order) from public.sessions`,
    )).toBe('S2,S1');
    // The service role: everything, as before.
    expect(await story(db, THE_SERVICE, `truncate public.client_errors`, WENT_THROUGH)).toBe('went through');
    await db.runSql(asUserCheck, 'page check');   // goes through
    // The checks leave the connection as they found it.
    expect(await db.query.value(`select current_user::text`)).toBe('postgres');
    expect(await story(db, THE_OWNER, ROWS_LEFT)).toBe(2 + 2 + 3);

    await db.runFile(migration.paths.rollback);
    expect(await story(db, NOBODY, WIPE, THE_OWNER, ROWS_LEFT)).toBe(0);
    await db.runSql(asAnonCheck, 'page check');
    await db.drop();
  });

  // What a request without a session gets from each table: the page lists the
  // ones that answered with no row before, and says the others refused already.
  it('without a session every table refuses to be read; the page names the eleven that answered before', async () => {
    const db = await production();
    const tableNames = await tablesOf(db);
    const reading = async () => {
      const out = {};
      for (const table of tableNames) out[table] = await story(db, NOBODY, `select count(*)::int from public.${table}`);
      return out;
    };

    const before = await reading();
    const answered = tableNames.filter((table) => before[table] === 0);
    const refusedAlready = tableNames.filter((table) => /^permission denied for function /.test(String(before[table])));
    expect(answered).toHaveLength(11);
    expect(refusedAlready).toHaveLength(9);
    expect(tableNames).toHaveLength(20);

    await db.runFile(migration.paths.migration);
    expect(await reading()).toEqual(Object.fromEntries(tableNames.map((table) => [table, deniedTable(table)])));

    const [, sentence] = /\n- a read of (.+?) used to return no row;/.exec(page) ?? [];
    expect(sentence, 'the page no longer lists the tables').toBeTruthy();
    expect([...sentence.matchAll(/`([a-z_]+)`/g)].map((match) => match[1]).sort()).toEqual(answered);
    expect(page).toContain('- the nine other tables have refused since migration 03');
    // …and the header of the migration lists the same eleven.
    const header = read(migration.paths.migration).split('\n').filter((line) => line.startsWith('--')).join(' ').replace(/\s*--\s*/g, ' ');
    expect(header).toContain(`11 tables answered a read with no row: ${answered.join(', ')};`);
    await db.drop();
  });

  // The runbook page tells the person applying the file what the audit prints
  // before and after. This is that table, read off the page.
  it('its audit prints the "before" and "after" columns of the runbook page', async () => {
    const db = await production();
    const onPage = page.split('\n')
      .map((line) => /^\| (\d+) \| (.+?) \| `(.+?)` \| `(.+?)` \|$/.exec(line))
      .filter(Boolean)
      .map(([, n, check, before, after]) => ({ n: Number(n), check, before, after }));
    expect(onPage.map((row) => row.n)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));

    expect(await printedAudit(db)).toEqual(onPage.map((row) => [row.check, row.before]));
    await db.runFile(migration.paths.migration);
    expect(await printedAudit(db)).toEqual(onPage.map((row) => [row.check, row.after]));
    // …and the header of the audit file says the same.
    const header = read(migration.paths.audit).split('\n').filter((line) => line.startsWith('--')).join('\n');
    for (const { before, after } of onPage) {
      expect(header).toContain(before);
      expect(header).toContain(after);
    }

    // Line 7, the one that must read `none`: a table closed by hand is named.
    await db.query(`revoke update on public.client_errors from authenticated`);
    expect(await auditLine(db, 7)).toBe('1 of 20: client_errors');
    await db.drop();
  });

  it('changes the privileges of two roles and what a new table starts with — no table, no column, no policy, no function', async () => {
    const db = await production();
    const tableNames = await tablesOf(db);
    const before = await catalogSnapshot(db.query);
    await db.runFile(migration.paths.migration);
    const after = await catalogSnapshot(db.query);

    const all = (role, privileges = EVERYTHING) => `${role}: ${privileges.join(', ')}`;
    const lost = (key, from, to) => `${key}: privileges: ${JSON.stringify(from)} only in before; ${JSON.stringify(to)} only in after`;
    expect(diffCatalogs(before, after, { left: 'before', right: 'after' }).sort()).toEqual([
      ...tableNames.map((table) => lost(
        `tables public.${table}`, [all('anon'), all('authenticated')], [all('authenticated', ROWS)],
      )),
      lost(
        'defaultPrivileges objects created by postgres in schema public: tables',
        [all('anon'), all('authenticated')], [all('authenticated', ROWS)],
      ),
      lost(
        'defaultPrivileges objects created by postgres in schema public: sequences',
        [all('anon', ON_A_SEQUENCE), all('authenticated', ON_A_SEQUENCE)], [all('authenticated', ['USAGE'])],
      ),
      `data rows of app_private.app_migrations: rows: ["{\\"name\\":\\"${MIGRATION}\\"}"] only in after`,
    ].sort());

    // What is left on a table, in full.
    for (const table of tableNames) {
      expect(after.tables[`public.${table}`].privileges, table)
        .toEqual([all('authenticated', ROWS), all('postgres'), all('service_role')]);
    }
    await db.drop();
  });

  // Production may hold what the repository does not: something made by hand
  // in the SQL editor. The file is written for whatever is in public.
  it('treats what was made by hand like the rest: a view, a sequence, a table without policies, a privilege on one column', async () => {
    const db = await production();
    await db.runSql(
      `create sequence public.made_by_hand_seq;
       create view public.made_by_hand_view as select id from public.profiles;
       create table public.made_by_hand (id uuid primary key);
       grant select on public.exercise_library to public;
       grant select (message) on public.client_errors to anon;
       grant select (id), references (id) on public.client_errors to authenticated;`,
      'made by hand',
    );
    const lines = async () => {
      const printed = await printedAudit(db);
      return Object.fromEntries([2, 3, 5, 6, 8, 9, 11, 12].map((n) => [n, printed[n - 1][1]]));
    };
    expect(await lines()).toEqual({
      2: '21',
      3: 'made_by_hand_seq (sequence); made_by_hand_view (view)',
      5: '1 of 21: made_by_hand',
      6: 'all 22',
      8: 'all 22',
      9: '1 of 22: exercise_library',
      11: 'client_errors.id; client_errors.message',
      12: 'made_by_hand_seq',
    });

    await db.runFile(migration.paths.migration);

    expect(await lines()).toEqual({
      2: '21',
      3: 'made_by_hand_seq (sequence); made_by_hand_view (view)',
      // Not this file's to decide: it says so, and goes on.
      5: '1 of 21: made_by_hand',
      6: 'none',
      8: 'none',
      9: 'none',
      // A signed-in user's privilege to read one column stays; the one to
      // reference it went with the others, and so did what anon held.
      11: 'client_errors.id',
      12: 'none',
    });
    const held = Object.fromEntries((await relationsOfPublic(db.query))
      .filter((r) => r.name.startsWith('made_by_hand'))
      .map((r) => [r.name, { anon: r.held.anon, authenticated: r.held.authenticated }]));
    expect(held).toEqual({
      made_by_hand: { anon: [], authenticated: ROWS },
      made_by_hand_seq: { anon: [], authenticated: ['USAGE'] },
      made_by_hand_view: { anon: [], authenticated: ROWS },
    });
    expect(await story(db, NOBODY, `select count(*)::int from public.made_by_hand_view`))
      .toBe('permission denied for view made_by_hand_view');
    expect(await story(db, NOBODY, `select message from public.client_errors`)).toBe(deniedTable('client_errors'));

    // The rollback gives the two roles everything back on these too.
    await db.runFile(migration.paths.rollback);
    expect((await lines())[6]).toBe('all 22');
    await db.drop();
  });

  it('a table created after it starts with the same, and after its rollback with everything again', async () => {
    const db = await production();
    const startsWith = async (name) => {
      await db.query(`create table public.${name} (id bigserial primary key)`);
      const found = (await relationsOfPublic(db.query)).filter((r) => r.name.startsWith(name));
      return Object.fromEntries(found.map((r) => [r.name.slice(name.length) || 'table', {
        anon: r.held.anon, authenticated: r.held.authenticated, service_role: r.held.service_role,
      }]));
    };
    expect(await startsWith('made_before')).toEqual({
      table: { anon: EVERYTHING, authenticated: EVERYTHING, service_role: EVERYTHING },
      _id_seq: { anon: ON_A_SEQUENCE, authenticated: ON_A_SEQUENCE, service_role: ON_A_SEQUENCE },
    });

    await db.runFile(migration.paths.migration);
    expect(await startsWith('made_after')).toEqual({
      table: { anon: [], authenticated: ROWS, service_role: EVERYTHING },
      _id_seq: { anon: [], authenticated: ['USAGE'], service_role: ON_A_SEQUENCE },
    });

    await db.runFile(migration.paths.rollback);
    expect(await startsWith('made_after_rollback')).toEqual({
      table: { anon: EVERYTHING, authenticated: EVERYTHING, service_role: EVERYTHING },
      _id_seq: { anon: ON_A_SEQUENCE, authenticated: ON_A_SEQUENCE, service_role: ON_A_SEQUENCE },
    });
    await db.drop();
  });

  it('without the ledger it says which migration is missing (SLM02) instead of failing on a missing table', async () => {
    const db = await scratchDatabase();
    await db.runFile(manifest.baseline);
    const before = await catalogSnapshot(db.query);

    const refused = await attempt(() => db.runFile(migration.paths.migration));
    expect(refused.error?.code).toBe(REFUSAL.predecessorMissing);
    expect(refused.error.message).toContain('needs 2026_10_13_13_ensure_claim_rpcs, which is not applied');
    const undone = await attempt(() => db.runFile(migration.paths.rollback));
    expect(undone.error?.code).toBe(REFUSAL.notApplied);

    expect(diffCatalogs(before, await catalogSnapshot(db.query), { left: 'before', right: 'after' })).toEqual([]);
    await db.drop();
  });

  it('refuses to run as another role than postgres, and so does its rollback', async () => {
    const db = await production();
    const asServiceRole = (file) => {
      const text = read(file);
      const changed = text.replace(`SET LOCAL lock_timeout = '5s';`, `SET LOCAL lock_timeout = '5s';\nSET LOCAL ROLE service_role;`);
      expect(changed).not.toBe(text);
      return changed;
    };
    const before = await catalogSnapshot(db.query);
    const refused = await attempt(() => db.runSql(asServiceRole(migration.paths.migration), 'migration'));
    expect(refused.error?.message).toContain(`migration ${MIGRATION} must be run as postgres, not as service_role`);
    expect(await db.query.value(`select current_user::text`)).toBe('postgres');
    await untouched(db, before);

    await db.runFile(migration.paths.migration);
    const applied = await catalogSnapshot(db.query);
    const kept = await attempt(() => db.runSql(asServiceRole(migration.paths.rollback), 'rollback'));
    expect(kept.error?.message).toContain(`the rollback of ${MIGRATION} must be run as postgres, not as service_role`);
    expect(diffCatalogs(applied, await catalogSnapshot(db.query), { left: 'before', right: 'after' })).toEqual([]);
    await db.drop();
  });

  // The privileges on a table are its owner's to take back: on a table of
  // another role the REVOKE would answer with a warning and change nothing.
  it('refuses to run when public holds a table postgres does not own — and changes nothing', async () => {
    const db = await production();
    // The one other role `postgres` can hand a table to in this cluster.
    await db.runSql(
      `grant create on schema public to supabase_storage_admin;
       alter table public.client_errors owner to supabase_storage_admin;`,
      'another owner',
    );
    expect(await auditLine(db, 4)).toBe('client_errors (supabase_storage_admin)');
    const before = await catalogSnapshot(db.query);

    const refused = await attempt(() => db.runFile(migration.paths.migration));
    expect(refused.error?.message).toContain(
      `migration ${MIGRATION} cannot change tables postgres does not own: client_errors (supabase_storage_admin)`,
    );
    await untouched(db, before);
    await db.drop();
  });

  // A grant that `postgres` did not make is one its REVOKE does not remove.
  // The file reads its own result back, so it cannot end "applied" with a
  // table still open.
  it('undoes itself when the result is not the one it meant', async () => {
    const db = await production();
    await db.runSql(
      `BEGIN;
       grant select on public.client_errors to service_role with grant option;
       set local role service_role;
       grant select on public.client_errors to anon;
       COMMIT;`,
      'a grant made by another role',
    );
    let before = await catalogSnapshot(db.query);
    let refused = await attempt(() => db.runFile(migration.paths.migration));
    expect(refused.error?.message).toContain(
      `migration ${MIGRATION} did not get the privileges it meant: client_errors: a request without a session still holds SELECT`,
    );
    await untouched(db, before);
    // Every other table was closed, and is open again: the file is one transaction.
    expect(await auditLine(db, 6)).toBe('all 20');

    // The same for what a new table starts with: a default for every schema,
    // which this file does not touch.
    await db.runSql(
      `BEGIN;
       set local role service_role;
       revoke select on public.client_errors from anon;
       COMMIT;
       alter default privileges for role postgres grant select on tables to anon;`,
      'a default made by hand',
    );
    before = await catalogSnapshot(db.query);
    refused = await attempt(() => db.runFile(migration.paths.migration));
    expect(refused.error?.message).toContain(
      `migration ${MIGRATION} did not get the default privileges it meant: a new table would give anon SELECT`,
    );
    await untouched(db, before);

    await db.query(`alter default privileges for role postgres revoke select on tables from anon`);
    await db.runFile(migration.paths.migration);
    expect(await auditLine(db, 6)).toBe('none');
    await db.drop();
  });

  it('its rollback is refused while the ledger records a later migration, and changes nothing', async () => {
    const db = await production();
    await db.runFile(migration.paths.migration);
    await db.query(`insert into ${LEDGER} (name) values ($1)`, [TO_COME]);
    const before = await catalogSnapshot(db.query);

    const refused = await attempt(() => db.runFile(migration.paths.rollback));
    expect(refused.error?.code).toBe(REFUSAL.stillNeeded);
    expect(refused.error.message).toContain(`the ledger still records later migrations: ${TO_COME}`);
    expect(diffCatalogs(before, await catalogSnapshot(db.query), { left: 'before', right: 'after' })).toEqual([]);
    expect(await story(db, NOBODY, `select count(*)::int from public.profiles`)).toBe(deniedTable('profiles'));
    await db.drop();
  });
});
