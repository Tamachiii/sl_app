// catalog.js is what the parity test and the migration checks see a database
// through. A kind of change it does not see is a kind of drift nobody will
// ever be told about — so each kind is made here and must show up in the
// diff, on the right object.
//
// The changes are made to objects this file creates (`probe_*`), not to the
// app's: the test must not go red because a migration really did change the
// type of a column or the roles of a policy.

import { beforeAll, describe, expect, it } from 'vitest';
import { asAdmin, scenario } from './harness.js';
import { catalogSnapshot, diffCatalogs } from './catalog.js';

let before;
beforeAll(async () => {
  await asAdmin(async (q) => {
    await q(`create schema probe_schema`);
    await q(`alter default privileges for role postgres in schema probe_schema grant select on tables to anon`);
    await q(`create type public.probe_kind as enum ('a', 'b')`);
    await q(
      `create table public.probe_things (
         id       uuid primary key default gen_random_uuid(),
         owner_id uuid references public.profiles(id) on delete cascade,
         kind     public.probe_kind not null default 'a',
         amount   int,
         note     text
       )`,
    );
    await q(`alter table public.probe_things enable row level security`);
    await q(`grant select on public.probe_things to anon`);
    await q(`create policy "probe read" on public.probe_things for select using (owner_id = auth.uid())`);
    await q(`create policy "probe write" on public.probe_things for insert with check (owner_id = auth.uid())`);
    await q(`create policy "probe objects" on storage.objects for select to authenticated using (bucket_id = 'probe')`);
    await q(`create index probe_things_owner_idx on public.probe_things (owner_id)`);
    await q(
      `create function public.probe_owner(p_id uuid) returns uuid
         language sql stable security definer set search_path = public
         as $$ select owner_id from public.probe_things where id = p_id $$`,
    );
    await q(`grant execute on function public.probe_owner(uuid) to anon`);
    await q(`create function public.probe_touch() returns trigger language plpgsql as $$ begin return new; end $$`);
    await q(
      `create trigger probe_touch before update on public.probe_things
         for each row execute function public.probe_touch()`,
    );
    await q(`alter publication supabase_realtime add table public.probe_things`);
    await q(`insert into storage.buckets (id, name, file_size_limit) values ('probe', 'probe', 1000)`);
  }, { commit: true });
  before = await asAdmin((q) => catalogSnapshot(q));
});

// Make the change, read the catalog again, roll everything back.
const diffAfter = (sql) => scenario(async (q) => {
  await q(sql);
  return diffCatalogs(before, await catalogSnapshot(q), { left: 'before', right: 'after' });
});

describe('catalogSnapshot', () => {
  it('is the same twice in a row', async () => {
    expect(diffCatalogs(before, await asAdmin((q) => catalogSnapshot(q)))).toEqual([]);
  });

  it('must be read as postgres: another search_path would spell the same objects differently', async () => {
    await expect(scenario(async (q) => {
      await q(`set local search_path = public`);
      return catalogSnapshot(q);
    })).rejects.toThrow(/search_path/);
  });

  it.each([
    [
      'the body of a function',
      `create or replace function public.probe_owner(p_id uuid) returns uuid
         language sql stable security definer set search_path = public
         as $$ select null::uuid $$`,
      /^functions public\.probe_owner\(p_id uuid\): definition: first difference at line \d+ — /,
    ],
    [
      'SECURITY DEFINER on a function',
      `alter function public.probe_owner(uuid) security invoker`,
      /^functions public\.probe_owner\(p_id uuid\): definition/,
    ],
    [
      'the search_path of a function',
      `alter function public.probe_owner(uuid) set search_path = public, pg_temp`,
      /^functions public\.probe_owner\(p_id uuid\): definition/,
    ],
    [
      'a search_path lost in CREATE OR REPLACE',
      `create or replace function public.probe_owner(p_id uuid) returns uuid
         language sql stable security definer
         as $$ select owner_id from public.probe_things where id = p_id $$`,
      /^functions public\.probe_owner\(p_id uuid\): definition: first difference at line \d+ — "SET search_path TO 'public'" \(before\)/,
    ],
    [
      'who may execute a function',
      `revoke execute on function public.probe_owner(uuid) from anon`,
      /^functions public\.probe_owner\(p_id uuid\): privileges: \["anon: EXECUTE"\] only in before$/,
    ],
    [
      'a new function',
      `create function public.probe_new() returns boolean language sql stable as $$ select true $$`,
      /^functions public\.probe_new\(\): only in after$/,
    ],
    [
      'the expression of a policy',
      `alter policy "probe read" on public.probe_things using (owner_id = (select auth.uid()))`,
      /^policies public\.probe_things\.probe read: using: "owner_id = auth\.uid\(\)" \(before\) ≠ /,
    ],
    [
      'the roles of a policy',
      `alter policy "probe read" on public.probe_things to authenticated`,
      /^policies public\.probe_things\.probe read: roles: \["PUBLIC"\] only in before; \["authenticated"\] only in after$/,
    ],
    [
      'a dropped policy',
      `drop policy "probe write" on public.probe_things`,
      /^policies public\.probe_things\.probe write: only in before$/,
    ],
    [
      'a policy on storage.objects',
      `drop policy "probe objects" on storage.objects`,
      /^policies storage\.objects\.probe objects: only in before$/,
    ],
    [
      'row level security switched off',
      `alter table public.probe_things disable row level security`,
      /^tables public\.probe_things: rls: true \(before\) ≠ false \(after\)$/,
    ],
    [
      'a privilege on a table',
      `revoke select on public.probe_things from anon`,
      /^tables public\.probe_things: privileges: \["anon: [A-Z, ]+"\] only in before/,
    ],
    [
      'a new column',
      `alter table public.probe_things add column archived_at timestamptz`,
      /^columns public\.probe_things\.archived_at: only in after$/,
    ],
    [
      'the type of a column',
      `alter table public.probe_things alter column amount type numeric(3,1)`,
      /^columns public\.probe_things\.amount: type: "integer" \(before\) ≠ "numeric\(3,1\)" \(after\)$/,
    ],
    [
      'the default of a column',
      `alter table public.probe_things alter column kind set default 'b'`,
      /^columns public\.probe_things\.kind: default/,
    ],
    [
      'NOT NULL on a column',
      `alter table public.probe_things alter column note set not null`,
      /^columns public\.probe_things\.note: not_null: false \(before\) ≠ true \(after\)$/,
    ],
    [
      'a check constraint',
      `alter table public.probe_things add constraint probe_amount_range check (amount between 1 and 7)`,
      /^constraints public\.probe_things\.probe_amount_range: only in after$/,
    ],
    [
      'a constraint that is not validated',
      `alter table public.probe_things add constraint probe_amount_range check (amount between 1 and 7) not valid`,
      /^constraints public\.probe_things\.probe_amount_range: only in after$/,
    ],
    [
      'what a foreign key does on delete',
      `alter table public.probe_things drop constraint probe_things_owner_id_fkey,
         add constraint probe_things_owner_id_fkey foreign key (owner_id)
           references public.profiles(id) on delete restrict`,
      /^constraints public\.probe_things\.probe_things_owner_id_fkey: definition/,
    ],
    [
      'an index',
      `drop index public.probe_things_owner_idx`,
      /^indexes public\.probe_things_owner_idx: only in before$/,
    ],
    [
      'a trigger',
      `drop trigger probe_touch on public.probe_things`,
      /^triggers public\.probe_things\.probe_touch: only in before$/,
    ],
    [
      'a disabled trigger',
      `alter table public.probe_things disable trigger probe_touch`,
      /^triggers public\.probe_things\.probe_touch: state: "enabled" \(before\) ≠ "disabled" \(after\)$/,
    ],
    [
      'an enum value',
      `alter type public.probe_kind add value 'c'`,
      /^types public\.probe_kind: labels: \["c"\] only in after$/,
    ],
    [
      'a new table',
      `create table public.probe_more (id uuid primary key)`,
      /^tables public\.probe_more: only in after$/,
    ],
    [
      'a new schema',
      `create schema probe_other`,
      /^schemas probe_other: only in after$/,
    ],
    [
      'who may use a schema',
      `grant usage on schema probe_schema to authenticated`,
      /^schemas probe_schema: privileges: \["authenticated: USAGE"\] only in after$/,
    ],
    [
      'the privileges of objects created later in a schema',
      `alter default privileges for role postgres in schema probe_schema revoke select on tables from anon`,
      /^defaultPrivileges objects created by postgres in schema probe_schema: tables: only in before$/,
    ],
    [
      'a default privilege that is not tied to a schema',
      `alter default privileges for role postgres grant usage on types to anon`,
      /^defaultPrivileges objects created by postgres in any schema: types: only in after$/,
    ],
    [
      'what realtime publishes',
      `alter publication supabase_realtime drop table public.probe_things`,
      /^publications supabase_realtime: tables: \["public\.probe_things"\] only in before$/,
    ],
    [
      'the replica identity of a table',
      `alter table public.probe_things replica identity full`,
      /^tables public\.probe_things: replica_identity: "default" \(before\) ≠ "full" \(after\)$/,
    ],
    [
      'a comment',
      `comment on table public.probe_things is 'made for the catalog test'`,
      /^comments table public\.probe_things: only in after$/,
    ],
    [
      'a row the SQL files insert (a storage bucket)',
      `update storage.buckets set file_size_limit = 1 where id = 'probe'`,
      /^data rows of storage\.buckets: rows/,
    ],
    [
      'a row in an application table',
      `insert into public.probe_things default values`,
      /^data row count of public\.probe_things: count: 0 \(before\) ≠ 1 \(after\)$/,
    ],
    [
      'a row of the migration ledger',
      `insert into app_private.app_migrations (name) values ('2099_01_01_99_not_in_the_manifest')`,
      /^data rows of app_private\.app_migrations: rows: \["\{\\"name\\":\\"2099_01_01_99_not_in_the_manifest\\"\}"\] only in after$/,
    ],
  ])('sees %s', async (_, sql, expected) => {
    const diff = await diffAfter(sql);
    expect(diff.some((line) => expected.test(line)), diff.join('\n') || 'no difference reported').toBe(true);
  });

  it('reports one change as one line, and names nothing else', async () => {
    expect(await diffAfter(`drop index public.probe_things_owner_idx`)).toEqual([
      'indexes public.probe_things_owner_idx: only in before',
    ]);
  });

  it('does not see the order of columns: a migration appends, schema.sql may not', async () => {
    const diff = await diffAfter(
      `alter table public.probe_things drop column note;
       alter table public.probe_things drop column amount;
       alter table public.probe_things add column note text, add column amount int`,
    );
    expect(diff).toEqual([]);
  });
});
