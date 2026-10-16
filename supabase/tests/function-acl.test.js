// Who may execute the functions of `public` — review findings B2, L21 and L23,
// closed by migration 2026_10_11_03_function_grants_lockdown.
//
// Supabase grants `anon`, `authenticated` and `service_role` EXECUTE, by name,
// on every function `postgres` creates in `public`, on top of the EXECUTE
// PostgreSQL gives PUBLIC. All 36 functions were therefore callable through
// /rest/v1/rpc/ with the anon key alone — the twelve SECURITY DEFINER helpers
// the policies are written with included, which say for any uuid whom a
// session, a slot, a set or a goal belongs to. Since the migration:
//
//   anon, PUBLIC      nothing
//   authenticated     an explicit allow-list: the helpers the policies call
//                     and the RPCs the app calls
//   service_role      everything (the Edge Functions)
//   a new function    closed from birth: its owner and service_role
//   every function    search_path = public, pg_temp
//
// The first blocks are PERMANENT: they read the catalog of schema.sql, so they
// hold for every function a later migration adds.
//
// ADDING A FUNCTION — a migration that creates one changes this file too:
//   * a policy (or a default, a constraint, a view, an index) calls it
//                                   → HELPERS, and the allow-list of schema.sql
//   * the app calls it with supabase.rpc()
//                                   → RPCS, and the allow-list of schema.sql
//   * a trigger function            → nothing to do
//   * anything else (an Edge Function or a cron job calls it, or another
//     SECURITY DEFINER function does)
//                                   → NOT_FOR_USERS, with the reason
// and its definition carries `SET search_path = public, pg_temp`.
//
// Then: every one of today's 36 is run once, as the caller the app is — the
// helpers and the RPCs by a signed-in user, the trigger functions by the
// statement that fires them — and the migration file itself is applied to the
// frozen production baseline, with the checks of its runbook page read off
// the page.

import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  asAdmin, asAnon, asPlatformRole, asService, asUser, attempt, createDraftProgram, enablePush,
  httpCalls, repoRoot, scenario, scratchDatabase, seed,
} from './harness.js';
import { catalogSnapshot, diffCatalogs } from './catalog.js';
import { splitStatements } from './sql.js';
import { LEDGER, loadManifest, REFUSAL } from '../migrations/manifest.js';

const MIGRATION = '2026_10_11_03_function_grants_lockdown';
const manifest = loadManifest();
const migration = manifest.migrations.find((m) => m.name === MIGRATION);
const read = (file) => fs.readFileSync(path.join(repoRoot, file), 'utf8');

// ------------------------------------------------------------
// The allow-list: what a signed-in user may execute. `name(argument types)`,
// as the audit and the migration spell them.
// ------------------------------------------------------------
/** Called by a policy: evaluated with the privileges of whoever queries the table. */
const HELPERS = [
  'coach_profile_for_goal(uuid)',
  'coach_profile_for_session(uuid)',
  'exercise_readable_through_use(uuid)',   // 2026_10_16_23_library_read_follows_program
  'is_coach()',   // 2026_10_11_05_students_role_gate
  'profiles_are_coach_student(uuid, uuid)',
  'program_active_for_session(uuid)',
  'program_active_for_slot(uuid)',
  'program_is_own_draft(uuid)',
  'session_is_confirmed(uuid)',        // 2026_10_13_09_review_lifecycle
  'session_is_own_draft(uuid)',
  'session_writable(uuid)',            // 2026_10_12_08; asked by a policy since 2026_10_13_09_review_lifecycle
  'session_writable_for_slot(uuid)',   // 2026_10_12_08_session_write_gates
  'set_video_slot(text)',              // 2026_10_12_08_session_write_gates
  'slot_for_set_log(uuid)',            // 2026_10_12_08_session_write_gates
  'student_profile_for_goal(uuid)',
  'student_profile_for_session(uuid)',
  'student_profile_for_set_log(uuid)',
  'student_profile_for_slot(uuid)',
  'week_is_own_draft(uuid)',
];
/** Called by the app, through supabase.rpc(). */
const RPCS = [
  'activate_program(uuid)',           // 2026_10_13_11_activate_reorder_rpcs
  'adopt_skip(uuid, boolean)',
  'adopt_swap(uuid, uuid, boolean)',
  'approve_program(uuid)',
  'cancel_rest_push(uuid)',           // 2026_10_13_16_rest_push_scheduling
  'claim_push_subscription(text, text, text, text)',   // 2026_10_13_13_ensure_claim_rpcs
  'coach_review_counts()',            // 2026_10_16_26_coach_list_rpcs (optional)
  'copy_sessions(uuid[], uuid)',      // 2026_10_13_12_copy_rpcs
  'decline_promote_request(uuid)',
  'duplicate_program(uuid, uuid, text)',   // 2026_10_13_12_copy_rpcs
  'duplicate_session(uuid, text)',    // 2026_10_13_12_copy_rpcs
  'duplicate_week(uuid, uuid, text)', // 2026_10_13_12_copy_rpcs
  'ensure_set_logs(uuid)',            // 2026_10_13_13_ensure_claim_rpcs
  'move_session(uuid, uuid, uuid[], uuid[])',
  'my_conversations()',               // 2026_10_16_26_coach_list_rpcs (optional)
  'reorder_sessions(uuid, uuid[])',   // 2026_10_13_11_activate_reorder_rpcs
  'reorder_weeks(uuid, uuid[])',      // 2026_10_13_11_activate_reorder_rpcs
  'save_draft_tree(jsonb)',
  'schedule_rest_push(integer, jsonb, text)',   // 2026_10_13_16_rest_push_scheduling
  'send_back_program(uuid)',
];
const ALLOW_LIST = [...HELPERS, ...RPCS].sort();
/**
 * Neither a trigger function nor for a signed-in user: `[signature, why]`.
 * Whatever is listed here is reachable by the owner and service_role only.
 */
const NOT_FOR_USERS = [
  // 2026_10_11_04_logged_history_guards
  ['history_delete_allowed()', 'read by the six guards on logged training — SECURITY DEFINER trigger functions, which call it as their owner'],
  ['set_log_is_logged(set_logs)', 'the one definition of a logged set: called by SECURITY DEFINER functions only (the guards, the pin on targets, adopt_swap, adopt_skip), as their owner'],
  // 2026_10_13_10_goals_fk_coach_links
  ['transfer_student(uuid, uuid)', 'moves an athlete and their goals to another coach: called by the owner of the database (the SQL editor) or with the service-role key, never by a signed-in user — it refuses a request that carries a user id'],
  // 2026_10_13_15_push_plumbing
  ['send_push_event(uuid, jsonb, jsonb)', 'hands a push to the send-push Edge Function: whoever may call it sends any text and any link to any account. Called by the eleven SECURITY DEFINER functions that notify somebody, as their owner, and by the service role — never by a signed-in user (push-plumbing.test.js)'],
  // 2026_10_13_16_rest_push_scheduling
  ['claim_rest_push(uuid)', 'the one way a rest push gets sent: it hands the row to whoever asks, once. Called by the Edge Functions that send (dispatch-rest-push, send-push) with the service-role key — an account that could call it would stop its own notification, and it is SECURITY INVOKER so that it could do no more (rest-push.test.js)'],
  ['dispatch_due_rest_pushes()', 'what the optional pg_cron job sl-rest-push runs every ten seconds, as the owner of the database: it closes the rest pushes that are late and hands the due ones to send-push. Never by a signed-in user (rest-push.test.js)'],
  // 2026_10_13_18_retention
  ['run_retention()', 'deletes the rest pushes, the read notifications and the client errors that are past their time, in every account: run by the owner of the database once a month, or by the optional nightly pg_cron job — never by a signed-in user, and SECURITY INVOKER so that one could delete no more than their own rights allow (retention.test.js)'],
];

const SEARCH_PATH = 'search_path=public, pg_temp';

// Every function of `public`, with who may execute it. `call` is a statement
// that calls it with NULL arguments: the privilege is checked before any
// argument is looked at.
const functionsOfPublic = (q) => q.rows(
  `select p.proname || '(' || oidvectortypes(p.proargtypes) || ')' as signature,
          p.proname as name,
          p.prorettype = 'trigger'::regtype as is_trigger,
          pg_get_userbyid(p.proowner) as owner,
          has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
          has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
          has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role,
          (select coalesce(array_agg(g.name order by g.name collate "C"), '{}')
             from (select case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee)::text end as name
                     from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a) g) as grantees,
          p.proconfig as settings,
          'select public.' || quote_ident(p.proname) || '('
            || coalesce((select string_agg('null::' || format_type(t.oid, null), ', ' order by t.n)
                           from unnest(p.proargtypes::oid[]) with ordinality as t(oid, n)), '')
            || ')' as call
     from pg_proc p
    where p.pronamespace = 'public'::regnamespace
    order by 1`,
);

const deniedFunction = (error) => error?.code === '42501' && /^permission denied for function /.test(error.message);

let ids;
let draft;   // a draft athlete A is writing
let goal;    // a goal the coach set for athlete A
let catalog; // functionsOfPublic(), read once

beforeAll(async () => {
  ids = await seed();
  draft = await createDraftProgram(ids.studentA);
  goal = await asAdmin((q) => q.value(
    `insert into goals (student_id, coach_id, exercise_id, kind, target_weight_kg)
     values ($1, $2, $3, 'one_rm', 100) returning id`,
    [ids.studentA.id, ids.coach.id, ids.exercises.squat],
  ), { commit: true });
  catalog = await asAdmin(functionsOfPublic);
});

// ============================================================
// PERMANENT — read off the catalog of schema.sql
// ============================================================
describe('who may execute the functions of public', () => {
  it('the lists of this file name functions that exist, once each', () => {
    const all = [...ALLOW_LIST, ...NOT_FOR_USERS.map(([signature]) => signature)];
    expect(all.filter((signature, i) => all.indexOf(signature) !== i), 'listed twice').toEqual([]);
    const existing = catalog.map((f) => f.signature);
    expect(all.filter((signature) => !existing.includes(signature)), 'listed here, not in public').toEqual([]);
    expect(catalog.length).toBeGreaterThanOrEqual(36);
  });

  it('anon executes none of them, and PUBLIC holds no grant on any', () => {
    expect(catalog.filter((f) => f.anon).map((f) => f.signature)).toEqual([]);
    expect(catalog.filter((f) => f.grantees.includes('PUBLIC')).map((f) => f.signature)).toEqual([]);
  });

  it('a signed-in user executes the allow-list, and nothing else', () => {
    expect(
      catalog.filter((f) => f.authenticated).map((f) => f.signature),
      'a function `authenticated` may execute and this file does not list, or the reverse: see ADDING A FUNCTION '
      + 'at the top of supabase/tests/function-acl.test.js',
    ).toEqual(ALLOW_LIST);
  });

  it('what a signed-in user may not execute is a trigger function, or listed with its reason', () => {
    const closed = catalog.filter((f) => !f.authenticated && !f.is_trigger).map((f) => f.signature);
    expect(closed).toEqual(NOT_FOR_USERS.map(([signature]) => signature).sort());
    for (const [signature, why] of NOT_FOR_USERS) expect(why, signature).toMatch(/\S{3,}/);
    // A trigger function needs no grant: nobody calls it by name.
    expect(catalog.filter((f) => f.is_trigger && f.authenticated).map((f) => f.signature)).toEqual([]);
  });

  it('the grants are the owner, service_role, and authenticated on the allow-list — no other role', () => {
    const unexpected = catalog
      .map((f) => [f.signature, f.grantees, ALLOW_LIST.includes(f.signature)
        ? ['authenticated', 'postgres', 'service_role']
        : ['postgres', 'service_role']])
      .filter(([, held, wanted]) => JSON.stringify(held) !== JSON.stringify(wanted))
      .map(([signature, held]) => `${signature}: ${held.join(', ')}`);
    expect(unexpected).toEqual([]);
    expect(catalog.filter((f) => f.owner !== 'postgres').map((f) => f.signature)).toEqual([]);
    expect(catalog.filter((f) => !f.service_role).map((f) => f.signature)).toEqual([]);
  });

  // A policy runs with the privileges of the user who queries the table; so
  // does a column default, a check constraint, a view and the expression of an
  // index. Read from pg_depend, which is what PostgreSQL itself goes by — not
  // from the text of the policies. Triggers are the exception: firing one
  // needs no privilege on its function.
  it('the functions a policy, a default, a constraint, a view or an index depends on are the HELPERS', async () => {
    const needed = await asAdmin((q) => q.rows(
      `select distinct p.proname || '(' || oidvectortypes(p.proargtypes) || ')' as signature
         from pg_depend d
         join pg_proc p on p.oid = d.refobjid
        where d.refclassid = 'pg_proc'::regclass
          and p.pronamespace = 'public'::regnamespace
          and d.classid in ('pg_policy'::regclass, 'pg_attrdef'::regclass, 'pg_constraint'::regclass,
                            'pg_rewrite'::regclass, 'pg_class'::regclass)
        order by 1`,
    ));
    expect(
      needed.map((row) => row.signature),
      'a function a policy (or a default, a constraint, a view, an index) calls must be executable by the user who '
      + 'queries the table: list it in HELPERS and in the FUNCTION PRIVILEGES block of schema.sql. One that nothing '
      + 'calls any more leaves both.',
    ).toEqual(HELPERS);
  });

  // The app's side of the list, read off its source: a call to a function that
  // is not granted would be refused in production and nowhere before.
  it('every function the app calls with supabase.rpc() is one of the RPCS', () => {
    const rpcNames = (text) => [...text.matchAll(/\.rpc\(\s*['"`]([A-Za-z_][A-Za-z0-9_]*)['"`]/g)].map((m) => m[1]);
    expect(rpcNames(`await supabase.rpc('one', { p: 1 }); client\n  .rpc(\n    "two",\n  ); rpc('not_a_call')`))
      .toEqual(['one', 'two']);

    const sources = (dir) => fs.readdirSync(path.join(repoRoot, dir), { withFileTypes: true }).flatMap((entry) => {
      const file = `${dir}/${entry.name}`;
      if (entry.isDirectory()) return sources(file);
      return /\.(js|jsx)$/.test(entry.name) && !/\.test\./.test(entry.name) ? [file] : [];
    });
    const called = new Map();
    for (const file of sources('src')) {
      for (const name of rpcNames(read(file))) called.set(name, [...(called.get(name) ?? []), file]);
    }
    // An empty list would pass everything below.
    expect(called.size).toBeGreaterThan(0);
    const names = RPCS.map((signature) => signature.split('(')[0]);
    expect(
      [...called].filter(([name]) => !names.includes(name)).map(([name, files]) => `${name} (${files.join(', ')})`),
      'the app calls a function a signed-in user may not execute',
    ).toEqual([]);
  });

  it('every function runs with search_path = public, pg_temp', () => {
    expect(
      catalog
        .filter((f) => !(f.settings ?? []).includes(SEARCH_PATH))
        .map((f) => `${f.signature}: ${(f.settings ?? []).join('; ') || 'no setting'}`),
      'CREATE OR REPLACE drops a SET clause the new text does not repeat: write '
      + '`SET search_path = public, pg_temp` in every definition, in the migration and in schema.sql',
    ).toEqual([]);
  });
});

describe('a function created after schema.sql', () => {
  const mayExecute = (q, fn) => q.one(
    `select has_function_privilege('anon', $1, 'EXECUTE')          as anon,
            has_function_privilege('authenticated', $1, 'EXECUTE') as authenticated,
            has_function_privilege('authenticator', $1, 'EXECUTE') as authenticator,
            has_function_privilege('service_role', $1, 'EXECUTE')  as service_role,
            has_function_privilege('postgres', $1, 'EXECUTE')      as postgres`,
    [fn],
  );

  it('in public: its owner and service_role may execute it, nobody else', () => scenario(async (q) => {
    await q(`create function public.acl_probe() returns int language sql as 'select 1'`);
    expect(await mayExecute(q, 'public.acl_probe()')).toEqual({
      anon: false, authenticated: false, authenticator: false, service_role: true, postgres: true,
    });
    for (const [who, as] of [['anon', asAnon], ['a signed-in user', (fn) => asUser(ids.studentA, fn)]]) {
      const called = await attempt(() => as((caller) => caller.value(`select public.acl_probe()`)));
      expect(called.error?.message, who).toBe('permission denied for function acl_probe');
    }
    expect(await asService((service) => service.value(`select public.acl_probe()`))).toBe(1);

    // …until a GRANT says who.
    await q(`grant execute on function public.acl_probe() to authenticated`);
    expect(await asUser(ids.studentA, (athlete) => athlete.value(`select public.acl_probe()`))).toBe(1);
    expect((await attempt(() => asAnon((anon) => anon.value(`select public.acl_probe()`)))).error?.code).toBe('42501');
  }));

  // The EXECUTE of PUBLIC is PostgreSQL's built-in default: it follows a
  // function into every schema, and only a GLOBAL default privilege takes it
  // away. In a schema the API roles can use, it would be the whole gate.
  it('in another schema: no EXECUTE for PUBLIC either', () => scenario(async (q) => {
    await q(`create schema acl_probe_schema`);
    await q(`grant usage on schema acl_probe_schema to anon, authenticated, service_role`);
    await q(`create function acl_probe_schema.probe() returns int language sql as 'select 1'`);
    expect(await mayExecute(q, 'acl_probe_schema.probe()')).toEqual({
      anon: false, authenticated: false, authenticator: false, service_role: false, postgres: true,
    });
    const called = await attempt(() => asAnon((anon) => anon.value(`select acl_probe_schema.probe()`)));
    expect(called.error?.message).toBe('permission denied for function probe');
  }));

  it('CREATE OR REPLACE keeps the grants of a function, and drops a search_path it does not repeat', () => scenario(async (q) => {
    await q(
      `create or replace function public.student_profile_for_goal(g uuid) returns uuid
         language sql security definer stable
         as $$ select student_id from public.goals where id = g $$`,
    );
    expect(await q.one(
      `select has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated,
              has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
              p.proconfig as settings
         from pg_proc p where p.oid = 'public.student_profile_for_goal(uuid)'::regprocedure`,
    )).toEqual({ authenticated: true, anon: false, settings: null });
  }));
});

// The plan: "in schema.sql the allow-list is one trailing block that stays
// last". Read off the text of the file.
describe('schema.sql says who may execute what in one place', () => {
  const statements = splitStatements(read('supabase/schema.sql')).map((s) => s.text.replace(/\s+/g, ' '));
  const ON_FUNCTION = /^(grant|revoke)\b.*\bon (all )?(function|functions|routine|routines|procedure|procedures)\b/i;
  const DEFAULTS = /^alter default privileges\b.*\bon (functions|routines)\b/i;
  const start = statements.findIndex((s) => DEFAULTS.test(s) || ON_FUNCTION.test(s));

  it('has a block of function privileges', () => {
    expect(start).toBeGreaterThan(0);
    expect(statements.filter((s) => DEFAULTS.test(s))).toHaveLength(2);
    expect(statements.some((s) => /^revoke all on all routines in schema public from public, anon, authenticated$/i.test(s))).toBe(true);
  });

  it('is in one piece, and no function is defined below it', () => {
    const after = statements.slice(start);
    const block = after.filter((s) => DEFAULTS.test(s) || ON_FUNCTION.test(s));
    // Every statement about function privileges, one after the other: none
    // stands next to a function further up, none comes back further down.
    expect(after.slice(0, block.length)).toEqual(block);
    expect(
      after.filter((s) => /^create (or replace )?(function|procedure|aggregate)\b/i.test(s)),
      'a function defined below the FUNCTION PRIVILEGES block is not covered by its REVOKE: move it above',
    ).toEqual([]);
  });

  it('grants EXECUTE to authenticated only, and names every function with its arguments', () => {
    const grants = statements.filter((s) => /^grant\b/i.test(s) && ON_FUNCTION.test(s));
    expect(grants.length).toBeGreaterThan(0);
    const granted = [];
    for (const grant of grants) {
      const [, list, to] = /^grant execute on function (.+) to (.+)$/i.exec(grant) ?? [];
      expect(to, grant).toBe('authenticated');
      granted.push(...list.split(/,\s*(?=public\.)/));
    }
    const spelled = (signature) => `public.${signature}`;
    expect(granted.sort()).toEqual(ALLOW_LIST.map(spelled).sort());
  });
});

// ============================================================
// Called, by everyone
// ============================================================
describe('without a session', () => {
  it('every function of public is refused before it is entered', () => scenario(async () => {
    for (const { name, call } of catalog) {
      const tried = await attempt(() => asAnon((anon) => anon(call)));
      expect(tried.error?.message, call).toBe(`permission denied for function ${name}`);
      expect(tried.error.code, call).toBe('42501');
    }
  }));

  // The finding, as the live review reproduced it: a uuid from a URL or a
  // push payload, and the anon key.
  it('the lookups that said whom a uuid belongs to answer nothing', async () => {
    const lookups = [
      [`select public.student_profile_for_slot($1)`, [ids.programA.slots[0]]],
      [`select public.student_profile_for_session($1)`, [ids.programA.sessions[0]]],
      [`select public.student_profile_for_set_log($1)`, [ids.programA.setLogs[0]]],
      [`select public.student_profile_for_goal($1)`, [goal]],
      [`select public.coach_profile_for_session($1)`, [ids.programA.sessions[0]]],
      [`select public.coach_profile_for_goal($1)`, [goal]],
      [`select public.profiles_are_coach_student($1, $2)`, [ids.coach.id, ids.studentA.id]],
      [`select public.program_active_for_session($1)`, [ids.programA.sessions[0]]],
      [`select public.program_active_for_slot($1)`, [ids.programA.slots[0]]],
    ];
    for (const [sql, params] of lookups) {
      const tried = await attempt(() => asAnon((anon) => anon.value(sql, params)));
      expect(tried.ok, `${sql} answered ${JSON.stringify(tried.value)}`).toBe(false);
      expect(deniedFunction(tried.error), tried.error.message).toBe(true);
    }
  });
});

describe('signed in', () => {
  it('a user gets past the privilege on the allow-list, and is refused every other function', () => scenario(async () => {
    const entered = [];
    for (const { signature, name, call } of catalog) {
      const tried = await attempt(() => asUser(ids.studentA, (athlete) => athlete(call)));
      if (deniedFunction(tried.error)) expect(tried.error.message, call).toBe(`permission denied for function ${name}`);
      else entered.push(signature);
    }
    expect(entered).toEqual(ALLOW_LIST);
  }));

  it('the service role gets past the privilege on every function', () => scenario(async () => {
    for (const { call } of catalog) {
      const tried = await attempt(() => asService((service) => service(call)));
      expect(deniedFunction(tried.error), call).toBe(false);
    }
  }));

  // Each of the twelve, called by name with real ids: the privilege is there
  // and the answer is the one from before the search_path was pinned.
  it('the twelve helpers answer as before, for an athlete and for the coach', async () => {
    const A = ids.studentA.id;
    const coach = ids.coach.id;
    const [session] = ids.programA.sessions;
    const [slot] = ids.programA.slots;
    const [setLog] = ids.programA.setLogs;
    const ask = (user) => asUser(user, async (q) => ({
      student_profile_for_slot: await q.value(`select public.student_profile_for_slot($1)`, [slot]),
      student_profile_for_session: await q.value(`select public.student_profile_for_session($1)`, [session]),
      student_profile_for_set_log: await q.value(`select public.student_profile_for_set_log($1)`, [setLog]),
      student_profile_for_goal: await q.value(`select public.student_profile_for_goal($1)`, [goal]),
      coach_profile_for_session: await q.value(`select public.coach_profile_for_session($1)`, [session]),
      coach_profile_for_goal: await q.value(`select public.coach_profile_for_goal($1)`, [goal]),
      profiles_are_coach_student: [
        await q.value(`select public.profiles_are_coach_student($1, $2)`, [coach, A]),
        await q.value(`select public.profiles_are_coach_student($1, $2)`, [A, ids.studentB.id]),
      ],
      program_active_for_session: [
        await q.value(`select public.program_active_for_session($1)`, [session]),
        await q.value(`select public.program_active_for_session($1)`, [draft.sessions[0]]),
      ],
      program_active_for_slot: [
        await q.value(`select public.program_active_for_slot($1)`, [slot]),
        await q.value(`select public.program_active_for_slot($1)`, [draft.slots[0]]),
      ],
      // "Own" is the caller: the three below answer differently for the two.
      program_is_own_draft: await q.value(`select public.program_is_own_draft($1)`, [draft.id]),
      week_is_own_draft: await q.value(`select public.week_is_own_draft($1)`, [draft.weeks[0]]),
      session_is_own_draft: await q.value(`select public.session_is_own_draft($1)`, [draft.sessions[0]]),
    }));
    const whoeverAsks = {
      student_profile_for_slot: A,
      student_profile_for_session: A,
      student_profile_for_set_log: A,
      student_profile_for_goal: A,
      coach_profile_for_session: coach,
      coach_profile_for_goal: coach,
      profiles_are_coach_student: [true, false],
      program_active_for_session: [true, false],
      program_active_for_slot: [true, false],
    };
    const own = (yes) => ({ program_is_own_draft: yes, week_is_own_draft: yes, session_is_own_draft: yes });

    const asked = { athlete: await ask(ids.studentA), coach: await ask(ids.coach) };
    // The twelve of migration 03; a helper added since is called in the test file of its own migration.
    expect(Object.keys(asked.athlete)).toHaveLength(12);
    expect(HELPERS.map((signature) => signature.split('(')[0])).toEqual(expect.arrayContaining(Object.keys(asked.athlete)));
    expect(asked.athlete).toEqual({ ...whoeverAsks, ...own(true) });
    expect(asked.coach).toEqual({ ...whoeverAsks, ...own(false) });
  });

  // The five coach RPCs are called, by every caller, in rpc-auth.test.js; the
  // three of migration 11 (activate_program, reorder_sessions, reorder_weeks)
  // in atomic-rpcs.test.js; the four of migration 12 (duplicate_session,
  // copy_sessions, duplicate_week, duplicate_program) in copy-rpcs.test.js;
  // the two of migration 13 (ensure_set_logs, claim_push_subscription) in
  // ensure-claim.test.js.
  it('save_draft_tree and move_session, the two RPCs of migration 03 that ride the caller\'s own RLS, still run', () => scenario(async (q) => {
    const uuid = () => q.value(`select gen_random_uuid()`);
    const [program, week, session, slot] = [await uuid(), await uuid(), await uuid(), await uuid()];
    const tree = {
      program: { id: program, name: 'Written offline' },
      weeks: [{ id: week, week_number: 1 }],
      sessions: [{ id: session, week_id: week, title: 'Pull', sort_order: 0 }],
      slots: [{ id: slot, session_id: session, exercise_id: ids.exercises.pullUp, sets: 3, reps: 5, sort_order: 0 }],
    };
    // Athlete B has no draft yet: this is the first save of one.
    expect(await asUser(ids.studentB, (athlete) => athlete.value(`select public.save_draft_tree($1)`, [tree])))
      .toEqual({ program_id: program, weeks: 1, sessions: 1, slots: 1 });
    expect(await q.one(`select status, created_by from programs where id = $1`, [program]))
      .toEqual({ status: 'draft', created_by: ids.studentB.id });

    // The coach drags session 2 of week 1 to the end of week 2.
    const [[first, moved], [third, fourth]] = ids.programA.tree.map((w) => w.sessions.map((s) => s.id));
    await asUser(ids.coach, (coach) => coach(
      `select public.move_session($1, $2, $3, $4)`,
      [moved, ids.programA.weeks[1], [first], [third, fourth, moved]],
    ));
    expect(await q.rows(
      `select s.id, w.week_number, s.sort_order
         from sessions s join weeks w on w.id = s.week_id
        where w.program_id = $1 order by 2, 3`,
      [ids.programA.id],
    )).toEqual([
      { id: first, week_number: 1, sort_order: 0 },
      { id: third, week_number: 2, sort_order: 0 },
      { id: fourth, week_number: 2, sort_order: 1 },
      { id: moved, week_number: 2, sort_order: 2 },
    ]);
  }));

  // ------------------------------------------------------------
  // Every policy, as the two users the app has. A policy that names a function
  // the caller may not execute fails the statement when it STARTS — before a
  // row is looked at — so one statement per table and per command reaches
  // every helper its policies name. (rls-matrix.test.js then says how many
  // rows each of them gets.)
  // ------------------------------------------------------------
  const TABLES_SQL = `
    select 'public.' || quote_ident(c.relname) as name from pg_class c
     where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
    union all select 'storage.objects'
    order by 1`;

  // An INSERT of no row: its WITH CHECK is prepared, and the privilege on the
  // functions in it checked, all the same. The columns are named because a
  // generated one cannot be written.
  const insertNothing = (q, table) => q.value(
    `select format('insert into %s (%s) select %2$s from %1$s limit 0', $1::text,
                   string_agg(quote_ident(a.attname), ', ' order by a.attnum))
       from pg_attribute a
      where a.attrelid = $1::regclass and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''`,
    [table],
  );

  /** `["athlete A: select count(*) from public.set_logs — permission denied for function …"]` */
  async function refusedForAFunction(q) {
    const out = [];
    const tables = (await q.rows(TABLES_SQL)).map((row) => row.name);
    for (const table of tables) {
      const statements = [
        `select count(*) from ${table}`,
        await insertNothing(q, table),
        `update ${table} set id = id`,
        `delete from ${table}`,
      ];
      for (const [who, user] of [['athlete A', ids.studentA], ['the coach', ids.coach]]) {
        for (const sql of statements) {
          const tried = await attempt(() => asUser(user, (caller) => caller.dryRun(sql)));
          if (deniedFunction(tried.error)) out.push(`${who}: ${sql.split(' (')[0]} — ${tried.error.message}`);
        }
      }
    }
    return out;
  }

  it('no table refuses a signed-in user for want of a function, whatever the statement', () => scenario(async (q) => {
    // Rows in every table a policy with a helper guards, storage included.
    await q(
      `insert into storage.objects (bucket_id, name) values ('set-videos', $1)`,
      [`${ids.studentA.id}/${ids.programA.slots[0]}/1-clip.mp4`],
    );
    expect(await refusedForAFunction(q)).toEqual([]);
  }));

  it('…and the check above would notice: a helper taken away shows on each table whose policies call it', () => scenario(async (q) => {
    // Read, updated and deleted through USING; inserted through WITH CHECK.
    await q(`revoke execute on function public.student_profile_for_slot(uuid) from authenticated`);
    const slotTables = ['public.set_logs', 'public.slot_comments', 'public.slot_deviations'];
    const refused = await refusedForAFunction(q);
    expect(refused.every((line) => line.endsWith('permission denied for function student_profile_for_slot'))).toBe(true);
    for (const who of ['athlete A', 'the coach']) {
      for (const table of slotTables) {
        expect(refused).toEqual(expect.arrayContaining([
          `${who}: select count(*) from ${table} — permission denied for function student_profile_for_slot`,
          `${who}: insert into ${table} — permission denied for function student_profile_for_slot`,
          `${who}: update ${table} set id = id — permission denied for function student_profile_for_slot`,
          `${who}: delete from ${table} — permission denied for function student_profile_for_slot`,
        ]));
      }
    }
    await q(`grant execute on function public.student_profile_for_slot(uuid) to authenticated`);

    // A helper that only an INSERT policy names: the insert of no row finds it.
    await q(`revoke execute on function public.profiles_are_coach_student(uuid, uuid) from authenticated`);
    expect(await refusedForAFunction(q)).toEqual([
      'athlete A: insert into public.messages — permission denied for function profiles_are_coach_student',
      'the coach: insert into public.messages — permission denied for function profiles_are_coach_student',
    ]);
  }));

  it('the storage policies: an athlete reads and deletes their own files, the coach the one a video names, another athlete none', () => scenario(async (q) => {
    const name = `${ids.studentA.id}/${ids.programA.slots[0]}/1-clip.mp4`;
    const orphan = `${ids.studentA.id}/${ids.programA.slots[0]}/2-orphan.mp4`;
    const seen = (user) => asUser(user, (caller) => caller.value(`select count(*) from storage.objects`));
    await asUser(ids.studentA, async (athlete) => {
      await athlete(`insert into storage.objects (bucket_id, name) values ('set-videos', $1), ('set-videos', $2)`, [name, orphan]);
      await athlete(
        `insert into set_log_videos (set_log_id, storage_path, mime_type, size_bytes) values ($1, $2, 'video/mp4', 1000)`,
        [ids.programA.setLogs[0], name],
      );
    });
    // The coach reads a file through the video that names it (migration 25): the orphan is the athlete's alone.
    expect({ athlete: await seen(ids.studentA), coach: await seen(ids.coach), other: await seen(ids.studentB) })
      .toEqual({ athlete: 2, coach: 1, other: 0 });
    expect((await asUser(ids.studentB, (other) => other(`delete from storage.objects`))).rowCount).toBe(0);
    expect((await asUser(ids.studentA, (athlete) => athlete(`delete from storage.objects`))).rowCount).toBe(2);
    expect(await q.value(`select count(*) from storage.objects`)).toBe(0);
  }));
});

// ============================================================
// The trigger functions: no grant, and they still do their work. With the
// search_path pinned, the body of each of the 17 that migration 03 found is
// run once — push branch included, which is wrapped in EXCEPTION WHEN OTHERS
// and would otherwise fail without a word.
// ============================================================
describe('the trigger functions fire for a caller who may not execute them', () => {
  it('none is executable by the user whose statement fires it', () => {
    const triggers = catalog.filter((f) => f.is_trigger);
    expect(triggers.length).toBeGreaterThanOrEqual(17);
    expect(triggers.filter((f) => f.authenticated || f.anon).map((f) => f.name)).toEqual([]);
  });

  // GoTrue, not `postgres`: the role every sign-up arrives as owns auth.users
  // and holds nothing on `public` — not even the EXECUTE that PUBLIC used to
  // give it on handle_new_user.
  it('handle_new_user: a sign-up made by GoTrue still gets its profile', async () => {
    await asPlatformRole('supabase_auth_admin', async (gotrue, owner) => {
      expect(await gotrue.one(
        `select current_user::text as role,
                has_function_privilege('public.handle_new_user()', 'EXECUTE') as may_execute`,
      )).toEqual({ role: 'supabase_auth_admin', may_execute: false });
      // Its own search_path, as the role has it when GoTrue connects.
      await gotrue(`set local search_path = auth`);
      const id = await gotrue.value(
        `insert into users (email, raw_user_meta_data) values ('new@sl.test', '{"full_name": "New Athlete"}')
         returning id`,
      );
      expect(await owner.one(`select role, full_name from public.profiles where id = $1`, [id]))
        .toEqual({ role: 'student', full_name: 'New Athlete' });
    });
  });

  it('the other sixteen, each fired by the statement the app sends', () => scenario(async (q) => {
    await enablePush();
    const A = ids.studentA;
    const { coach } = ids;
    const [session] = ids.programA.sessions;
    const [slot] = ids.programA.slots;
    const [setLog] = ids.programA.setLogs;
    const athlete = (sql, params) => asUser(A, (user) => user.one(sql, params));
    const theCoach = (sql, params) => asUser(coach, (user) => user.one(sql, params));

    // profiles_pin_immutable_columns
    expect(await athlete(
      `update profiles set role = 'coach', full_name = 'Alex Renamed' where id = $1 returning role, full_name`, [A.id],
    )).toEqual({ role: 'student', full_name: 'Alex Renamed' });

    // restrict_student_goal_update
    expect(await athlete(
      `update goals set achieved = true, target_weight_kg = 999 where id = $1 returning achieved, target_weight_kg`, [goal],
    )).toEqual({ achieved: true, target_weight_kg: 100 });

    // pin_set_log_targets_for_student
    expect(await athlete(
      `update set_logs set done = true, rpe = 8, logged_at = now(), target_reps = 99 where id = $1
       returning done, target_reps`,
      [setLog],
    )).toEqual({ done: true, target_reps: 5 });

    // pin_program_authoring_columns, then notify_coach_on_program_submit
    expect(await athlete(
      `update programs set status = 'approved', name = 'My block' where id = $1 returning status, name`, [draft.id],
    )).toEqual({ status: 'draft', name: 'My block' });
    await athlete(`update programs set submitted_at = now() where id = $1 returning id`, [draft.id]);

    // sync_session_performed_at and notify_coach_on_session_confirm
    await athlete(
      `insert into session_confirmations (session_id, student_id, performed_on)
       values ($1, $2, current_date - 1) returning id`,
      [session, A.id],
    );
    expect(await q.value(`select performed_at::date = current_date - 1 from sessions where id = $1`, [session])).toBe(true);

    // notify_coach_on_slot_deviation, then notify_coach_on_promote_request
    await athlete(
      `insert into slot_deviations (exercise_slot_id, student_id, kind) values ($1, $2, 'skip') returning id`,
      [slot, A.id],
    );
    await athlete(
      `update slot_deviations set promote_requested_at = now() where exercise_slot_id = $1 returning id`, [slot],
    );

    // notify_student_on_session_feedback (which also stamps the review)
    await theCoach(
      `insert into messages (sender_id, recipient_id, body, session_id) values ($1, $2, 'Solid session.', $3)
       returning id`,
      [coach.id, A.id, session],
    );
    expect(await q.value(`select reviewed_at is not null from sessions where id = $1`, [session])).toBe(true);

    // notify_recipient_on_chat_message: a push, no bell row
    await athlete(
      `insert into messages (sender_id, recipient_id, body) values ($1, $2, 'Thanks!') returning id`, [A.id, coach.id],
    );

    // lock_message_fields_on_update, lock_notification_fields_on_update
    expect(await theCoach(
      `update messages set read_at = now(), body = 'forged' where id = $1 returning body, read_at is not null as read`,
      [ids.messages.aToCoach],
    )).toEqual({ body: 'Thanks coach!', read: true });
    expect(await theCoach(
      `update notifications set read_at = now(), kind = 'forged' where kind = 'session_completed'
       returning kind, read_at is not null as read`,
    )).toEqual({ kind: 'session_completed', read: true });

    // block_session / block_week / block_program _delete_with_logged_sets
    for (const [table, id] of [['sessions', session], ['weeks', ids.programA.weeks[0]], ['programs', ids.programA.id]]) {
      const tried = await attempt(() => theCoach(`delete from ${table} where id = $1 returning id`, [id]));
      expect(tried.error?.message, table).toMatch(/logged set/);
    }

    // What the six notify_* functions left: a bell row each but the chat
    // message, and a push each.
    expect(await q.rows(`select n.kind, n.recipient_id from notifications n order by n.kind`)).toEqual([
      { kind: 'program_submitted', recipient_id: coach.id },
      { kind: 'promote_requested', recipient_id: coach.id },
      { kind: 'session_completed', recipient_id: coach.id },
      { kind: 'session_deviation', recipient_id: coach.id },
      { kind: 'session_feedback', recipient_id: A.id },
    ]);
    const pushes = await httpCalls();
    expect(pushes.map((call) => call.body.user_id)).toEqual([
      coach.id,   // program submitted
      coach.id,   // session completed
      coach.id,   // exercise skipped
      coach.id,   // "make this permanent"
      A.id,       // feedback
      coach.id,   // chat message
    ]);
    for (const call of pushes) expect(call.body.payload.title).toMatch(/\S/);
  }));
});

// ============================================================
// The migration file, on production as it was frozen.
//
// Everything above runs against schema.sql; parity.test.js proves that the
// baseline plus the migrations IS schema.sql. This is the direct proof for
// the file with the widest reach of the review: applied to the frozen
// baseline, with the finding tried before and after, and the checks its
// runbook page gives read off the page.
// ============================================================
describe('migration 03 applied to the production baseline', () => {
  const COACH = '00000000-0000-4000-8000-00000000c0ac';
  const ATHLETE = '00000000-0000-4000-8000-0000000000a1';
  const SESSION_1 = '00000000-0000-4000-8000-000000000451';
  const SLOT_1 = '00000000-0000-4000-8000-000000000501';
  const TO_COME = '2099_01_01_99_a_migration_to_come';

  // A coach, an athlete, a block of two sessions with the same exercise.
  const WORLD = `
    insert into auth.users (id, email, aud, role, email_confirmed_at, raw_user_meta_data) values
      ('${COACH}',   'coach@sl.test', 'authenticated', 'authenticated', now(), '{"full_name": "Coach"}'),
      ('${ATHLETE}', 'alex@sl.test',  'authenticated', 'authenticated', now(), '{"full_name": "Alex"}');
    insert into public.students (id, profile_id, coach_id)
      values ('00000000-0000-4000-8000-000000000101', '${ATHLETE}', '${COACH}');
    insert into public.exercise_library (id, coach_id, name, type, difficulty)
      values ('00000000-0000-4000-8000-000000000201', '${COACH}', 'Pull-up', 'pull', 2);
    insert into public.programs (id, student_id, name, is_active)
      values ('00000000-0000-4000-8000-000000000301', '00000000-0000-4000-8000-000000000101', 'Block', true);
    insert into public.weeks (id, program_id, week_number)
      values ('00000000-0000-4000-8000-000000000401', '00000000-0000-4000-8000-000000000301', 1);
    insert into public.sessions (id, week_id, title, sort_order) values
      ('${SESSION_1}', '00000000-0000-4000-8000-000000000401', 'S1', 0),
      ('00000000-0000-4000-8000-000000000452', '00000000-0000-4000-8000-000000000401', 'S2', 1);
    insert into public.exercise_slots (id, session_id, exercise_id, sets, reps, sort_order) values
      ('${SLOT_1}', '${SESSION_1}', '00000000-0000-4000-8000-000000000201', 3, 5, 0),
      ('00000000-0000-4000-8000-000000000502', '00000000-0000-4000-8000-000000000452', '00000000-0000-4000-8000-000000000201', 3, 5, 0);
    insert into public.set_logs (exercise_slot_id, set_number, target_reps)
      select '${SLOT_1}', n, 5 from generate_series(1, 3) as n;
  `;

  /** The frozen baseline with a small world in it and the migrations before 03 applied. */
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

  // One API request: role and claims set the way PostgREST sets them, one
  // statement, and everything undone — the answer is what is looked at.
  const ANON = { role: 'anon', claims: { role: 'anon' } };
  const THE_ATHLETE = { role: 'authenticated', claims: { role: 'authenticated', sub: ATHLETE } };
  const THE_COACH = { role: 'authenticated', claims: { role: 'authenticated', sub: COACH } };
  const request = async (db, { role, claims }, sql) => {
    const tried = await attempt(() => db.runSql(
      `BEGIN;
       select set_config('role', '${role}', true),
              set_config('request.jwt.claims', '${JSON.stringify(claims)}', true);
       ${sql};
       ROLLBACK;`,
      'request',
    ));
    if (!tried.ok) return (tried.error.cause ?? tried.error).message;
    const [row] = tried.value[2].rows;
    return row ? Object.values(row)[0] : null;
  };
  const whoseSlot = `select public.student_profile_for_slot('${SLOT_1}')`;
  const whoseCoach = `select public.coach_profile_for_session('${SESSION_1}')`;
  const areLinked = `select public.profiles_are_coach_student('${COACH}', '${ATHLETE}')`;

  // The runbook page, which is what the person applying the file reads.
  const page = read(migration.paths.runbook);
  // Its fenced commands, without the indent of the list item they stand in.
  const commands = [...page.matchAll(/^( *)```bash\n([\s\S]*?)\n\1```$/gm)]
    .map(([, indent, body]) => body.split('\n').map((line) => line.slice(indent.length)).join('\n'));
  const pageChecks = commands
    .map((command) => /^supabase db query --linked '(do \$check\$[\s\S]+\$check\$)'$/.exec(command)?.[1])
    .filter(Boolean);
  const [asAnonCheck, asUserCheck] = pageChecks;

  it('the page gives the two checks this test runs', () => {
    expect(pageChecks).toHaveLength(2);
    expect(asAnonCheck).toBe(
      'do $check$ begin set local role anon; perform public.student_profile_for_slot(gen_random_uuid()); end $check$',
    );
    expect(asUserCheck).toContain('set local role authenticated;');
    // Pasted between single quotes in a shell: neither may hold one.
    expect(pageChecks.filter((sql) => sql.includes("'"))).toEqual([]);
  });

  it('the lookup is open before, closed after, and open again after the rollback', async () => {
    const db = await production();

    // Before: the finding, as the live review reproduced it with the anon key.
    expect(await request(db, ANON, whoseSlot)).toBe(ATHLETE);
    expect(await request(db, ANON, whoseCoach)).toBe(COACH);
    expect(await request(db, ANON, areLinked)).toBe(true);
    await db.runSql(asAnonCheck, 'page check');   // goes through

    await db.runFile(migration.paths.migration);

    expect(await request(db, ANON, whoseSlot)).toBe('permission denied for function student_profile_for_slot');
    expect(await request(db, ANON, whoseCoach)).toBe('permission denied for function coach_profile_for_session');
    expect(await request(db, ANON, areLinked)).toBe('permission denied for function profiles_are_coach_student');
    const refused = await attempt(() => db.runSql(asAnonCheck, 'page check'));
    expect((refused.error?.cause ?? refused.error)?.message).toBe('permission denied for function student_profile_for_slot');

    // Signed in, with the app that is deployed today: as before.
    expect(await request(db, THE_ATHLETE, `select count(*)::int from public.set_logs`)).toBe(3);
    expect(await request(db, THE_ATHLETE, `update public.set_logs set done = true returning done`)).toBe(true);
    expect(await request(db, THE_COACH, `select count(*)::int from public.exercise_slots`)).toBe(2);
    expect(await request(db, THE_COACH, `select public.adopt_skip('${SLOT_1}', true)`)).toEqual({ applied: 1, dry_run: true });
    expect(await request(db, THE_COACH, whoseSlot)).toBe(ATHLETE);
    await db.runSql(asUserCheck, 'page check');   // goes through
    // The checks leave the connection as they found it.
    expect(await db.query.value(`select current_user::text`)).toBe('postgres');

    await db.runFile(migration.paths.rollback);
    expect(await request(db, ANON, whoseSlot)).toBe(ATHLETE);
    await db.runSql(asAnonCheck, 'page check');
    await db.drop();
  });

  // What a request without a session gets from each table, right after the
  // file: the page lists the tables that now answer with an error.
  it('without a session, the tables whose policies call a helper refuse; the page names them', async () => {
    const db = await production();
    await db.runFile(migration.paths.migration);
    const tables = (await db.query.rows(
      `select c.relname as name from pg_class c
        where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' order by 1`,
    )).map((row) => row.name);

    const refusing = { read: [], insert: [] };
    for (const table of tables) {
      const reading = await request(db, ANON, `select count(*)::int from public.${table}`);
      if (reading !== 0) {
        expect(reading, table).toMatch(/^permission denied for function /);
        refusing.read.push(table);
      }
      const inserting = await request(db, ANON, `insert into public.${table} select * from public.${table} limit 0 returning 1`);
      if (/^permission denied for function /.test(String(inserting))) refusing.insert.push(table);
    }
    expect(refusing.read).toEqual([
      'exercise_slots', 'goal_progress', 'session_confirmations', 'sessions', 'set_log_videos', 'set_logs',
      'slot_comments', 'slot_deviations', 'weeks',
    ]);
    // Read without a helper, sent through one.
    expect(refusing.insert.filter((table) => !refusing.read.includes(table))).toEqual(['messages']);

    const [, sentence] = /\n- a query on (.+?) fails the same way/.exec(page) ?? [];
    expect(sentence, 'the page no longer lists the tables').toBeTruthy();
    expect([...sentence.matchAll(/`([a-z_]+)`/g)].map((match) => match[1]).sort())
      .toEqual([...refusing.read, 'messages'].sort());
    await db.drop();
  });

  // The runbook page tells the person applying the file what the audit prints
  // before and after. This is that table, read off the page.
  it('its audit prints the "before" and "after" columns of the runbook page', async () => {
    const db = await production();
    const audit = read(migration.paths.audit);
    const printed = async () => {
      const [result] = await db.readOnly(audit, 'audit');
      return result.rows.map((row) => [row.check, row.value]);
    };
    const onPage = page.split('\n')
      .map((line) => /^\| (\d+) \| (.+?) \| `(.+?)` \| `(.+?)` \|$/.exec(line))
      .filter(Boolean)
      .map(([, n, check, before, after]) => ({ n: Number(n), check, before, after }));
    expect(onPage.map((row) => row.n)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));

    expect(await printed()).toEqual(onPage.map((row) => [row.check, row.before]));
    await db.runFile(migration.paths.migration);
    expect(await printed()).toEqual(onPage.map((row) => [row.check, row.after]));
    // …and the header of the audit file says the same.
    const header = audit.split('\n').filter((line) => line.startsWith('--')).join('\n');
    for (const { before, after } of onPage) {
      expect(header).toContain(before);
      expect(header).toContain(after);
    }

    // A partial set is spelled out: one helper closed by hand.
    await db.query(`revoke execute on function public.week_is_own_draft(uuid) from authenticated`);
    expect(Object.fromEntries(await printed())['allow-listed functions a signed-in user may NOT execute'])
      .toBe('1 of 19: week_is_own_draft(uuid)');
    await db.drop();
  });

  it('changes privileges, default privileges and the SET clause of the 36 — no body, no table, no policy', async () => {
    const db = await production();
    const before = await catalogSnapshot(db.query);
    await db.runFile(migration.paths.migration);
    const after = await catalogSnapshot(db.query);

    const diff = diffCatalogs(before, after, { left: 'before', right: 'after' });
    const functions = Object.keys(before.functions).filter((key) => key.startsWith('public.')).sort();
    expect(functions).toHaveLength(36);
    // Of each function: its definition and its privileges — not its owner.
    expect(
      diff.filter((line) => line.startsWith('functions '))
        .map((line) => /^functions (public\.\w+\([^)]*\)): (\w+): /.exec(line).slice(1, 3)),
    ).toEqual(functions.flatMap((key) => [[key, 'definition'], [key, 'privileges']]));
    // Besides the functions: the global default entry is new, the entry for
    // `public` loses two names, and the ledger gains a row.
    expect(diff.filter((line) => !line.startsWith('functions '))).toEqual([
      'defaultPrivileges objects created by postgres in any schema: functions: only in after',
      'defaultPrivileges objects created by postgres in schema public: functions: privileges: '
      + '["anon: EXECUTE","authenticated: EXECUTE"] only in before',
      `data rows of app_private.app_migrations: rows: ["{\\"name\\":\\"${MIGRATION}\\"}"] only in after`,
    ]);

    // Inside each definition, the SET line is the whole difference.
    const withoutSet = (definition) => definition.split('\n').filter((line) => !/^\s*SET search_path TO /.test(line));
    for (const key of functions) {
      expect(withoutSet(after.functions[key].definition), key).toEqual(withoutSet(before.functions[key].definition));
      expect(after.functions[key].definition, key).toContain(`\n SET search_path TO 'public', 'pg_temp'\n`);
    }
    expect(after.defaultPrivileges['objects created by postgres in any schema: functions'].privileges)
      .toEqual(['postgres: EXECUTE']);
    expect(after.defaultPrivileges['objects created by postgres in schema public: functions'].privileges)
      .toEqual(['postgres: EXECUTE', 'service_role: EXECUTE']);
    await db.drop();
  });

  // The revoke takes every function of public and the grants name 19: a
  // function the file was not written for would be closed without a word.
  it('refuses to run when public holds a function it does not know, or lacks one — and changes nothing', async () => {
    const db = await production();
    const refusal = async () => {
      const before = await catalogSnapshot(db.query);
      const refused = await attempt(() => db.runFile(migration.paths.migration));
      expect(diffCatalogs(before, await catalogSnapshot(db.query), { left: 'before', right: 'after' })).toEqual([]);
      expect(await db.query.value(`select count(*) from ${LEDGER} where name = $1`, [MIGRATION])).toBe(0);
      return refused.error?.message ?? 'it ran';
    };

    await db.query(`create function public.made_by_hand(p uuid) returns uuid language sql as 'select p'`);
    expect(await refusal()).toContain(`migration ${MIGRATION} does not know: made_by_hand(uuid)`);
    await db.query(`drop function public.made_by_hand(uuid)`);

    // The same name with other arguments is another function.
    await db.query(`alter function public.move_session(uuid, uuid, uuid[], uuid[]) rename to move_session_old`);
    expect(await refusal()).toContain(`migration ${MIGRATION} does not know: move_session_old(uuid, uuid, uuid[], uuid[])`);
    await db.query(`drop function public.move_session_old(uuid, uuid, uuid[], uuid[])`);
    expect(await refusal()).toContain(`migration ${MIGRATION} does not find: move_session(uuid, uuid, uuid[], uuid[])`);
    await db.drop();
  });

  it('without the ledger it says which migration is missing (SLM02) instead of failing on a missing table', async () => {
    const db = await scratchDatabase();
    await db.runFile(manifest.baseline);
    const before = await catalogSnapshot(db.query);

    const refused = await attempt(() => db.runFile(migration.paths.migration));
    expect(refused.error?.code).toBe(REFUSAL.predecessorMissing);
    expect(refused.error.message).toContain('needs 2026_10_03_02_rpc_auth_null_guard, which is not applied');
    const undone = await attempt(() => db.runFile(migration.paths.rollback));
    expect(undone.error?.code).toBe(REFUSAL.notApplied);

    expect(diffCatalogs(before, await catalogSnapshot(db.query), { left: 'before', right: 'after' })).toEqual([]);
    await db.drop();
  });

  it('refuses to run as another role than postgres', async () => {
    const db = await production();
    const before = await catalogSnapshot(db.query);
    const text = read(migration.paths.migration);
    const asService = text.replace(`SET LOCAL lock_timeout = '5s';`, `SET LOCAL lock_timeout = '5s';\nSET LOCAL ROLE service_role;`);
    expect(asService).not.toBe(text);
    const refused = await attempt(() => db.runSql(asService, 'migration'));
    expect(refused.error?.message).toContain(`migration ${MIGRATION} must be run as postgres, not as service_role`);
    expect(await db.query.value(`select current_user::text`)).toBe('postgres');
    expect(diffCatalogs(before, await catalogSnapshot(db.query), { left: 'before', right: 'after' })).toEqual([]);
    await db.drop();
  });

  // A grant that `postgres` did not make is one its REVOKE does not remove.
  // The file reads its own result back, so it cannot end "applied" with a
  // function still open.
  it('undoes itself when the result is not the one it meant', async () => {
    const db = await production();
    await db.runSql(
      `BEGIN;
       grant execute on function public.handle_new_user() to service_role with grant option;
       set local role service_role;
       grant execute on function public.handle_new_user() to anon;
       COMMIT;`,
      'a grant made by another role',
    );
    const before = await catalogSnapshot(db.query);

    const refused = await attempt(() => db.runFile(migration.paths.migration));
    expect(refused.error?.message).toContain(
      `migration ${MIGRATION} did not get the privileges it meant: handle_new_user(): anon may execute it`,
    );
    expect(diffCatalogs(before, await catalogSnapshot(db.query), { left: 'before', right: 'after' })).toEqual([]);
    expect(await db.query.value(`select count(*) from ${LEDGER} where name = $1`, [MIGRATION])).toBe(0);
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
    expect(await request(db, ANON, whoseSlot)).toBe('permission denied for function student_profile_for_slot');
    await db.drop();
  });
});
