// The five coach-only RPCs, called by everyone — review finding P1, closed by
// migration 2026_10_03_02_rpc_auth_null_guard.
//
//   adopt_swap · adopt_skip · decline_promote_request · approve_program · send_back_program
//
// They are SECURITY DEFINER: they bypass RLS, so the line in which each one
// compares the caller with the athlete's coach is the whole gate. It used to be
// `v_coach_id <> auth.uid()`, which is NULL — not true — for a caller without a
// user id, and the function went on. It is now
//
//   IF auth.uid() IS NULL OR v_coach_id IS DISTINCT FROM auth.uid() THEN RAISE
//
// What is tested here:
//   1. every caller who is not the coach of the athlete is refused by all
//      five, and nothing in the database moves — with a user id and without;
//   2. the coach is accepted, and each call still does what it did;
//   3. the migration file itself, on the frozen production baseline: the hole
//      is there before, gone after, back after the rollback.
//
// Why the callers without a user id matter beyond `anon`: migration 03 takes
// the EXECUTE of `anon` away, and from then on an anonymous call fails on the
// privilege, whatever the function body says. The service role and a token
// that names no user keep the privilege — they are the cases that go on
// testing the body.

import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  asAdmin, asAnon, asService, asUser, attempt, createDraftProgram, createProgram, createUser,
  enablePush, httpCalls, repoRoot, scenario, scratchDatabase, seed,
} from './harness.js';
import { catalogSnapshot, diffCatalogs } from './catalog.js';
import { LEDGER, loadManifest, REFUSAL } from '../migrations/manifest.js';

const MIGRATION = '2026_10_03_02_rpc_auth_null_guard';
const manifest = loadManifest();
const [ledger, nullGuard] = manifest.migrations;

// The world: seed() gives one coach with athletes A and B. A second coach with
// an athlete and a library of her own is added — a coach in every sense, only
// not the coach of A.
let ids;
let otherCoach;
let athleteC;
let otherExercise;
let programC;

beforeAll(async () => {
  ids = await seed();
  otherCoach = await createUser({ email: 'olga@sl.test', fullName: 'Coach Olga', role: 'coach' });
  athleteC = await createUser({ email: 'casey@sl.test', fullName: 'Casey Athlete', coach: otherCoach });
  otherExercise = await asAdmin((q) => q.value(
    `insert into exercise_library (coach_id, name, type, difficulty) values ($1, 'Row', 'pull', 1) returning id`,
    [otherCoach.id],
  ), { commit: true });
  programC = await createProgram({
    student: athleteC, name: 'Block C', exercises: [otherExercise], sessions: 2, active: true,
  });
});

it('migration 02 is the one this file is about', () => {
  expect(ledger.name).toBe('2026_10_03_01_migration_ledger');
  expect(nullGuard.name).toBe(MIGRATION);
});

// ------------------------------------------------------------
// What the five act on, in athlete A's data.
// ------------------------------------------------------------
// Pull-up slot of session 1 of Block A: the same exercise is in the three
// later sessions, which is what adopt_swap / adopt_skip would rewrite.
const firstPullUp = () => ids.programA.slots[0];

/** A submitted draft of athlete A, and a "make this permanent" request on the first pull-up. */
async function arrange(q) {
  const draft = await createDraftProgram(ids.studentA, { submitted: true });
  await q(
    `insert into slot_deviations (exercise_slot_id, student_id, kind, promote_requested_at)
     values ($1, $2, 'skip', now())`,
    [firstPullUp(), ids.studentA.id],
  );
  return { draft };
}

// Every statement a client can send to the five — the two dry runs included:
// they write nothing, but they answer with a count, and that is not for
// everyone either.
const CALLS = [
  ['adopt_swap', () => [`select public.adopt_swap($1, $2)`, [firstPullUp(), ids.exercises.squat]]],
  ['adopt_swap (dry run)', () => [`select public.adopt_swap($1, $2, true)`, [firstPullUp(), ids.exercises.squat]]],
  ['adopt_skip', () => [`select public.adopt_skip($1)`, [firstPullUp()]]],
  ['adopt_skip (dry run)', () => [`select public.adopt_skip($1, true)`, [firstPullUp()]]],
  ['decline_promote_request', () => [`select public.decline_promote_request($1)`, [firstPullUp()]]],
  ['approve_program', ({ draft }) => [`select public.approve_program($1)`, [draft.id]]],
  ['send_back_program', ({ draft }) => [`select public.send_back_program($1)`, [draft.id]]],
];

// Everything the five write, as one value: which exercise every slot holds,
// the state of every program, the pending requests, and how many set_logs and
// notifications there are.
const state = (q) => q.one(
  `select (select jsonb_agg(jsonb_build_array(es.id, es.exercise_id) order by es.id)
             from exercise_slots es)                                              as slots,
          (select jsonb_agg(jsonb_build_array(p.id, p.status, p.submitted_at is not null,
                                              p.approved_at is not null) order by p.id)
             from programs p)                                                     as programs,
          (select count(*) from slot_deviations where promote_requested_at is not null) as requests,
          (select count(*) from set_logs)                                         as set_logs,
          (select count(*) from notifications)                                    as notifications`,
);

const outcome = (tried) => (tried.ok ? `returned ${JSON.stringify(tried.value)}` : tried.error.message);

// ------------------------------------------------------------
// 1. Refused
// ------------------------------------------------------------
// `as(fn)` runs fn as that caller, inside the scenario's transaction.
const WITHOUT_USER_ID = [
  ['anon — the public key, no session', (fn) => asAnon(fn)],
  ['the service role', (fn) => asService(fn)],
  // Role `authenticated`, and no `sub` in the token: the privilege to execute
  // is there, the identity is not.
  ['a token of role authenticated that names no user', (fn) => asUser(ids.coach, fn, { claims: { sub: null } })],
  ['postgres — the SQL editor', (fn) => asAdmin(fn)],
];
const WITH_ANOTHER_USER_ID = [
  ['another coach', (fn) => asUser(otherCoach, fn)],
  ['the athlete the data belongs to', (fn) => asUser(ids.studentA, fn)],
  ['another athlete of the same coach', (fn) => asUser(ids.studentB, fn)],
  ['an athlete of another coach', (fn) => asUser(athleteC, fn)],
];

describe('a caller who is not the coach of the athlete', () => {
  it('the callers of this file are who their names say', async () => {
    const who = (as) => as((q) => q.one(
      `select current_user::text as role, auth.uid() is not null as has_user_id`,
    ));
    for (const [label, as] of WITHOUT_USER_ID) {
      expect((await who(as)).has_user_id, label).toBe(false);
    }
    for (const [label, as] of WITH_ANOTHER_USER_ID) {
      expect(await who(as), label).toEqual({ role: 'authenticated', has_user_id: true });
    }
    expect(await who(WITHOUT_USER_ID[0][1])).toEqual({ role: 'anon', has_user_id: false });
    expect(await who(WITHOUT_USER_ID[1][1])).toEqual({ role: 'service_role', has_user_id: false });
    expect(await who(WITHOUT_USER_ID[2][1])).toEqual({ role: 'authenticated', has_user_id: false });
    expect(await who(WITHOUT_USER_ID[3][1])).toEqual({ role: 'postgres', has_user_id: false });
  });

  describe.each([
    ['without a user id', WITHOUT_USER_ID],
    ['signed in as someone else', WITH_ANOTHER_USER_ID],
  ])('%s', (_, callers) => {
    it.each(callers)('%s: refused by all five, and nothing changes', (label, as) => scenario(async (q) => {
      const world = await arrange(q);
      const before = await state(q);

      for (const [name, call] of CALLS) {
        const [sql, params] = call(world);
        const tried = await attempt(() => as((caller) => caller.value(sql, params)));
        expect(outcome(tried), `${name}, called by ${label}`).toBe('not authorized');
      }
      expect(await state(q)).toEqual(before);
    }));
  });

  it('another coach is refused even when the substitute is an exercise of her own library', () => scenario(async (q) => {
    const before = await state(q);
    const tried = await attempt(() => asUser(otherCoach, (olga) => olga.value(
      `select public.adopt_swap($1, $2)`, [firstPullUp(), otherExercise],
    )));
    expect(outcome(tried)).toBe('not authorized');
    expect(await state(q)).toEqual(before);
  }));

  // What the five answer BEFORE they reach the gate is left as it was: an id
  // that is no slot, a program that is not a draft to act on. It tells a
  // caller whether a uuid it already holds is a slot or a pending draft, and
  // nothing else — the plan keeps the bodies unchanged apart from the gate.
  it.each([WITHOUT_USER_ID[0], WITHOUT_USER_ID[2]])(
    '%s: the same answers as before for ids there is nothing to do with',
    (_, as) => scenario(async (q) => {
      const nothing = '00000000-0000-0000-0000-000000000000';
      const before = await state(q);
      const call = (sql, params) => attempt(() => as((caller) => caller.value(sql, params)));

      expect(outcome(await call(`select public.adopt_skip($1)`, [nothing]))).toBe('slot not found');
      expect(outcome(await call(`select public.adopt_swap($1, $2)`, [nothing, ids.exercises.squat]))).toBe('slot not found');
      expect(outcome(await call(`select public.decline_promote_request($1)`, [nothing]))).toBe('slot not found');
      // Block A is approved: not a draft to approve, not a submitted one to send back.
      expect((await call(`select public.approve_program($1)`, [ids.programA.id])).value).toEqual({ approved: false });
      expect((await call(`select public.send_back_program($1)`, [ids.programA.id])).value).toEqual({ sent_back: false });
      expect(await state(q)).toEqual(before);
    }),
  );
});

// ------------------------------------------------------------
// 2. Accepted
// ------------------------------------------------------------
describe('the coach of the athlete', () => {
  const coach = (sql, params) => asUser(ids.coach, (user) => user.value(sql, params));
  const exerciseOfLaterPullUps = (q) => q.rows(
    `select es.exercise_id
       from exercise_slots es
       join sessions s on s.id = es.session_id
       join weeks w on w.id = s.week_id
      where w.program_id = $1 and es.sort_order = 0 and es.id <> $2
      order by w.week_number, s.sort_order`,
    [ids.programA.id, firstPullUp()],
  );
  const notified = (q, kind) => q.rows(
    `select recipient_id, payload from notifications where kind = $1`, [kind],
  );

  it('adopt_swap: the dry run counts and writes nothing, the call re-points the later sessions', () => scenario(async (q) => {
    const before = await state(q);
    expect(await coach(`select public.adopt_swap($1, $2, true)`, [firstPullUp(), ids.exercises.squat]))
      .toEqual({ applied: 3, dry_run: true });
    expect(await state(q)).toEqual(before);

    expect(await coach(`select public.adopt_swap($1, $2)`, [firstPullUp(), ids.exercises.squat]))
      .toEqual({ applied: 3, dry_run: false });
    expect(await exerciseOfLaterPullUps(q)).toEqual(Array(3).fill({ exercise_id: ids.exercises.squat }));
    // The slot the coach was reviewing keeps its history.
    expect(await q.value(`select exercise_id from exercise_slots where id = $1`, [firstPullUp()]))
      .toBe(ids.exercises.pullUp);
    expect(await notified(q, 'swap_adopted')).toEqual([{
      recipient_id: ids.studentA.id,
      payload: expect.objectContaining({
        original_exercise: 'Pull-up', substitute_exercise: 'Squat', applied_count: 3, coach_name: 'Coach Carla',
      }),
    }]);
  }));

  it('adopt_swap: the substitute must be in the coach\'s own library', () => scenario(async (q) => {
    const before = await state(q);
    const tried = await attempt(() => coach(`select public.adopt_swap($1, $2)`, [firstPullUp(), otherExercise]));
    expect(outcome(tried)).toBe('substitute not in coach library');
    expect(await state(q)).toEqual(before);
  }));

  it('adopt_skip: the dry run counts and writes nothing, the call drops the exercise from the later sessions', () => scenario(async (q) => {
    const before = await state(q);
    expect(await coach(`select public.adopt_skip($1, true)`, [firstPullUp()])).toEqual({ applied: 3, dry_run: true });
    expect(await state(q)).toEqual(before);

    expect(await coach(`select public.adopt_skip($1)`, [firstPullUp()])).toEqual({ applied: 3, dry_run: false });
    expect(await exerciseOfLaterPullUps(q)).toEqual([]);
    expect(await q.value(`select count(*) from exercise_slots where id = $1`, [firstPullUp()])).toBe(1);
    expect(await notified(q, 'skip_adopted')).toEqual([{
      recipient_id: ids.studentA.id,
      payload: expect.objectContaining({ original_exercise: 'Pull-up', applied_count: 3 }),
    }]);
  }));

  it('decline_promote_request: clears the request, keeps the deviation, tells the athlete', () => scenario(async (q) => {
    await arrange(q);
    expect(await coach(`select public.decline_promote_request($1)`, [firstPullUp()])).toEqual({ declined: true });
    expect(await q.one(
      `select kind, promote_requested_at is null as cleared from slot_deviations where exercise_slot_id = $1`,
      [firstPullUp()],
    )).toEqual({ kind: 'skip', cleared: true });
    expect(await notified(q, 'promote_declined')).toEqual([{
      recipient_id: ids.studentA.id,
      payload: expect.objectContaining({ original_exercise: 'Pull-up' }),
    }]);
    // Nothing left to decline: a second call is a no-op, not a second notification.
    expect(await coach(`select public.decline_promote_request($1)`, [firstPullUp()])).toEqual({ declined: false });
    expect(await notified(q, 'promote_declined')).toHaveLength(1);
  }));

  it('approve_program: the draft becomes an approved, inactive program with its set_logs', () => scenario(async (q) => {
    const { draft } = await arrange(q);
    expect(await coach(`select public.approve_program($1)`, [draft.id]))
      .toEqual({ approved: true, set_logs_created: 6 });
    expect(await q.one(
      `select status, is_active, approved_at is not null as stamped, submitted_at is null as cleared
         from programs where id = $1`,
      [draft.id],
    )).toEqual({ status: 'approved', is_active: false, stamped: true, cleared: true });
    expect(await q.value(
      `select count(*) from set_logs where exercise_slot_id = any($1)`, [draft.slots],
    )).toBe(6);
    expect(await notified(q, 'program_approved')).toEqual([{
      recipient_id: ids.studentA.id,
      payload: { program_id: draft.id, program_name: 'My draft' },
    }]);
    // Approved once: there is no draft left to approve.
    expect(await coach(`select public.approve_program($1)`, [draft.id])).toEqual({ approved: false });
  }));

  it('send_back_program: the draft is the athlete\'s again', () => scenario(async (q) => {
    const { draft } = await arrange(q);
    expect(await coach(`select public.send_back_program($1)`, [draft.id])).toEqual({ sent_back: true });
    expect(await q.one(
      `select status, submitted_at is null as with_the_athlete from programs where id = $1`, [draft.id],
    )).toEqual({ status: 'draft', with_the_athlete: true });
    expect(await notified(q, 'program_sent_back')).toEqual([{
      recipient_id: ids.studentA.id,
      payload: { program_id: draft.id, program_name: 'My draft' },
    }]);
    expect(await coach(`select public.send_back_program($1)`, [draft.id])).toEqual({ sent_back: false });
  }));

  it('the gate is "the coach of THIS athlete": the other coach is accepted on hers', () => scenario(async (q) => {
    const olga = (sql, params) => asUser(otherCoach, (user) => user.value(sql, params));
    const [first] = programC.slots;
    const draft = await createDraftProgram(athleteC, { submitted: true });
    await q(
      `insert into slot_deviations (exercise_slot_id, student_id, kind, promote_requested_at)
       values ($1, $2, 'skip', now())`,
      [first, athleteC.id],
    );

    expect(await olga(`select public.decline_promote_request($1)`, [first])).toEqual({ declined: true });
    expect(await olga(`select public.send_back_program($1)`, [draft.id])).toEqual({ sent_back: true });
    expect(await olga(`select public.approve_program($1)`, [draft.id])).toEqual({ approved: true, set_logs_created: 3 });
    expect(await olga(`select public.adopt_swap($1, $2, true)`, [first, otherExercise])).toEqual({ applied: 1, dry_run: true });
    expect(await olga(`select public.adopt_skip($1)`, [first])).toEqual({ applied: 1, dry_run: false });

    // …and the first coach is refused there.
    const tried = await attempt(() => coach(`select public.adopt_skip($1, true)`, [first]));
    expect(outcome(tried)).toBe('not authorized');
  }));

  // The five were re-created whole. Their push branch is part of what was
  // re-created: run it, and run it failing.
  it('each real call queues one push to the athlete once the Vault secrets exist', () => scenario(async (q) => {
    const { draft } = await arrange(q);
    await enablePush();

    await coach(`select public.decline_promote_request($1)`, [firstPullUp()]);
    await coach(`select public.send_back_program($1)`, [draft.id]);
    await coach(`select public.approve_program($1)`, [draft.id]);
    await coach(`select public.adopt_swap($1, $2)`, [firstPullUp(), ids.exercises.squat]);
    // The dip slot of session 1: the pull-ups after it are squats now.
    await coach(`select public.adopt_skip($1)`, [ids.programA.slots[1]]);

    const calls = await httpCalls();
    expect(calls.map((call) => call.body.payload.title)).toEqual([
      'Coach kept your plan', 'Program sent back', 'Program approved', 'Program updated', 'Program updated',
    ]);
    for (const call of calls) {
      expect(call).toMatchObject({
        url: 'https://functions.sl.test/functions/v1/send-push',
        headers: { Authorization: 'Bearer test-internal-bearer' },
        body: { user_id: ids.studentA.id },
      });
    }
    expect(await q.value(`select count(*) from notifications where recipient_id = $1`, [ids.studentA.id])).toBe(5);
  }));

  it('a push that cannot be sent does not undo the call', () => scenario(async (q) => {
    const { draft } = await arrange(q);
    await enablePush();
    await q(`select set_config('shim.http_post_fails', 'on', true)`);

    expect(await coach(`select public.decline_promote_request($1)`, [firstPullUp()])).toEqual({ declined: true });
    expect(await coach(`select public.send_back_program($1)`, [draft.id])).toEqual({ sent_back: true });
    expect(await coach(`select public.approve_program($1)`, [draft.id])).toEqual({ approved: true, set_logs_created: 6 });
    expect(await coach(`select public.adopt_swap($1, $2)`, [firstPullUp(), ids.exercises.squat]))
      .toEqual({ applied: 3, dry_run: false });
    expect(await coach(`select public.adopt_skip($1)`, [ids.programA.slots[1]])).toEqual({ applied: 3, dry_run: false });

    expect(await httpCalls()).toEqual([]);
    expect(await q.value(`select count(*) from notifications where recipient_id = $1`, [ids.studentA.id])).toBe(5);
  }));
});

// ------------------------------------------------------------
// The gate, read off the catalog.
// ------------------------------------------------------------
describe('in the catalog', () => {
  const FIVE = ['adopt_skip', 'adopt_swap', 'approve_program', 'decline_promote_request', 'send_back_program'];

  it('each of the five tests the caller with the NULL-safe line, and compares auth.uid() with nothing by = or <>', async () => {
    const rows = await asAdmin((q) => q.rows(
      `select p.proname as name, p.prosrc as body
         from pg_proc p
        where p.pronamespace = 'public'::regnamespace and p.proname = any($1)
        order by 1`,
      [FIVE],
    ));
    expect(rows.map((row) => row.name)).toEqual(FIVE);
    for (const { name, body } of rows) {
      const code = body.replace(/--.*$/gm, '');
      expect(code, name).toContain('IF auth.uid() IS NULL OR v_coach_id IS DISTINCT FROM auth.uid() THEN');
      // `=`, `<>` and `!=` are NULL when auth.uid() is: the trap of the finding.
      // (`:=`, an assignment, is not a comparison.)
      expect(code, name).not.toMatch(/(?:(?<!:)=|<>)\s*auth\.uid\(\)|auth\.uid\(\)\s*(?:=|<>|!=)/);
    }
  });

  // A SECURITY DEFINER function that writes and that a client can call by name
  // is a gate of its own. This list is the five; a function that joins it must
  // be called here as every caller above before it ships.
  it('the SECURITY DEFINER functions a client can call to write are these five', async () => {
    const callable = await asAdmin((q) => q.rows(
      `select p.proname as name
         from pg_proc p
        where p.pronamespace = 'public'::regnamespace
          and p.prosecdef
          and p.provolatile = 'v'
          and p.prorettype <> 'trigger'::regtype
        order by 1`,
    ));
    expect(
      callable.map((row) => row.name),
      'a new SECURITY DEFINER function that is neither a trigger nor STABLE: it bypasses RLS, so it must refuse '
      + 'a caller without a user id itself (auth.uid() IS NULL first, then IS DISTINCT FROM) — add it to CALLS '
      + 'in supabase/tests/rpc-auth.test.js, or test here why nobody can call it',
    ).toEqual(FIVE);
  });
});

// ------------------------------------------------------------
// L29 — two warnings written to the database log. The repository said
// "send-push (…) failed"; production runs the wording of the migration that
// created the two functions. Migration 02 re-creates both with that wording.
// ------------------------------------------------------------
describe('L29 — the two push warnings of the submit loop', () => {
  const DEPLOYED = 'supabase/migrations/2026_07_22_program_submit_notify.sql';

  it('read as in the migration production runs', async () => {
    const deployed = fs.readFileSync(path.join(repoRoot, DEPLOYED), 'utf8');
    const warnings = [...deployed.matchAll(/RAISE WARNING '([^']+)'/g)].map((match) => match[1]);
    expect(warnings).toEqual([
      'send-push fan-out (program submitted) failed: %',
      'send-push fan-out (program sent back) failed: %',
    ]);

    const body = (name) => asAdmin((q) => q.value(
      `select prosrc from pg_proc where pronamespace = 'public'::regnamespace and proname = $1`, [name],
    ));
    expect(await body('notify_coach_on_program_submit')).toContain(`RAISE WARNING '${warnings[0]}'`);
    expect(await body('send_back_program')).toContain(`RAISE WARNING '${warnings[1]}'`);
  });

  // notify_coach_on_program_submit is not one of the five, but the migration
  // re-creates it for that string: its trigger must still do its work.
  const submit = (draft) => asUser(ids.studentA, (athlete) => athlete(
    `update programs set submitted_at = now() where id = $1`, [draft.id],
  ));

  it('submitting a draft still notifies the coach, once, with a push', () => scenario(async (q) => {
    const draft = await createDraftProgram(ids.studentA);
    await enablePush();
    await submit(draft);
    // A second save of an already submitted draft is not a second submission.
    await asUser(ids.studentA, (athlete) => athlete(
      `update programs set submitted_at = now() + interval '1 minute' where id = $1`, [draft.id],
    ));

    expect(await q.rows(`select recipient_id, payload from notifications where kind = 'program_submitted'`)).toEqual([{
      recipient_id: ids.coach.id,
      payload: expect.objectContaining({
        program_id: draft.id, program_name: 'My draft', student_name: 'Alex Athlete',
        student_row_id: ids.studentA.studentRowId,
      }),
    }]);
    const calls = await httpCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({ user_id: ids.coach.id, payload: { title: 'Program submitted' } });
  }));

  it('a push that cannot be sent does not undo the submission', () => scenario(async (q) => {
    const draft = await createDraftProgram(ids.studentA);
    await enablePush();
    await q(`select set_config('shim.http_post_fails', 'on', true)`);
    await submit(draft);

    expect(await q.value(`select submitted_at is not null from programs where id = $1`, [draft.id])).toBe(true);
    expect(await q.value(`select count(*) from notifications where kind = 'program_submitted'`)).toBe(1);
    expect(await httpCalls()).toEqual([]);
  }));
});

// ------------------------------------------------------------
// 3. The migration file, on production as it was frozen.
//
// Everything above runs against schema.sql. parity.test.js proves that the
// baseline plus the migrations IS schema.sql, so it holds for production too —
// but this is the fix the review calls critical, so here is the direct proof:
// the file is applied to the frozen baseline and the hole is tried before and
// after, by the caller the finding names.
// ------------------------------------------------------------
describe('migration 02 applied to the production baseline', () => {
  const COACH = '00000000-0000-4000-8000-00000000c0ac';
  const ATHLETE = '00000000-0000-4000-8000-0000000000a1';
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
      ('00000000-0000-4000-8000-000000000451', '00000000-0000-4000-8000-000000000401', 'S1', 0),
      ('00000000-0000-4000-8000-000000000452', '00000000-0000-4000-8000-000000000401', 'S2', 1);
    insert into public.exercise_slots (id, session_id, exercise_id, sets, reps, sort_order) values
      ('${SLOT_1}', '00000000-0000-4000-8000-000000000451', '00000000-0000-4000-8000-000000000201', 3, 5, 0),
      ('00000000-0000-4000-8000-000000000502', '00000000-0000-4000-8000-000000000452', '00000000-0000-4000-8000-000000000201', 3, 5, 0);
  `;

  const production = async () => {
    const db = await scratchDatabase();
    await db.runFile(manifest.baseline);
    await db.runSql(WORLD, 'world');
    return db;
  };

  // One API request: role and claims set the way PostgREST sets them, one
  // statement, and everything undone — the answer is what is looked at.
  const ANON = { role: 'anon', claims: { role: 'anon' } };
  const SQL_EDITOR = { role: 'postgres', claims: null };
  const THE_COACH = { role: 'authenticated', claims: { role: 'authenticated', sub: COACH } };
  const request = async (db, { role, claims }, sql) => {
    const tried = await attempt(() => db.runSql(
      `BEGIN;
       select set_config('role', '${role}', true),
              set_config('request.jwt.claims', '${claims ? JSON.stringify(claims) : ''}', true);
       ${sql};
       ROLLBACK;`,
      'request',
    ));
    return tried.ok ? Object.values(tried.value[2].rows[0])[0] : (tried.error.cause ?? tried.error).message;
  };
  const skip = `select public.adopt_skip('${SLOT_1}')`;
  const dryRun = `select public.adopt_skip('${SLOT_1}', true)`;
  // The check the runbook page gives the person who applied the file, read off
  // the page: what is tested is the statement they will run.
  const [, probe] = /supabase db query --linked "(select public\.adopt_skip\(.+\))"/.exec(
    fs.readFileSync(path.join(repoRoot, nullGuard.paths.runbook), 'utf8'),
  ) ?? [];
  const slots = (db) => db.query.value(`select count(*) from public.exercise_slots`);

  it('the hole is there before, closed after, and back after the rollback', async () => {
    const db = await production();

    expect(probe).toBe('select public.adopt_skip((select id from public.exercise_slots order by id limit 1), true)');

    // Before: the finding, as the review reproduced it.
    expect(await request(db, ANON, skip)).toEqual({ applied: 1, dry_run: false });
    expect(await request(db, ANON, dryRun)).toEqual({ applied: 1, dry_run: true });
    expect(await request(db, SQL_EDITOR, probe)).toEqual({ applied: 1, dry_run: true });

    await db.runFile(ledger.paths.migration);
    await db.runFile(nullGuard.paths.migration);

    expect(await request(db, ANON, skip)).toBe('not authorized');
    expect(await request(db, ANON, dryRun)).toBe('not authorized');
    expect(await request(db, SQL_EDITOR, probe)).toBe('not authorized');
    // The coach, with the app that is deployed today: as before.
    expect(await request(db, THE_COACH, dryRun)).toEqual({ applied: 1, dry_run: true });
    expect(await request(db, THE_COACH, skip)).toEqual({ applied: 1, dry_run: false });
    // Nothing above was kept, and the migration itself touches no row.
    expect(await slots(db)).toBe(2);

    await db.runFile(nullGuard.paths.rollback);
    expect(await request(db, ANON, skip)).toEqual({ applied: 1, dry_run: false });

    await db.drop();
  });

  // "Bodies otherwise unchanged", as a test: the catalog before and after,
  // object by object, and the six bodies line by line.
  it('changes one line in each of the five, two warning texts, and signs the ledger — nothing else', async () => {
    const db = await production();
    await db.runFile(ledger.paths.migration);
    const before = await catalogSnapshot(db.query);
    await db.runFile(nullGuard.paths.migration);
    const after = await catalogSnapshot(db.query);

    const OLD = `IF v_coach_id IS NULL OR v_coach_id <> auth.uid() THEN`;
    const NEW = `IF auth.uid() IS NULL OR v_coach_id IS DISTINCT FROM auth.uid() THEN`;
    const RAISE = ` RAISE EXCEPTION 'not authorized'; END IF;`;
    const warning = (text) => `EXCEPTION WHEN OTHERS THEN RAISE WARNING '${text} failed: %', SQLERRM; END;`;
    const expected = {
      'public.adopt_skip(p_slot_id uuid, p_dry_run boolean)': [[OLD, NEW]],
      'public.adopt_swap(p_slot_id uuid, p_substitute_id uuid, p_dry_run boolean)': [[OLD, NEW]],
      'public.approve_program(p_program_id uuid)': [[OLD, NEW]],
      'public.decline_promote_request(p_slot_id uuid)': [[OLD, NEW]],
      'public.notify_coach_on_program_submit()': [
        [warning('send-push (program submitted)'), warning('send-push fan-out (program submitted)')],
      ],
      'public.send_back_program(p_program_id uuid)': [
        [OLD + RAISE, NEW + RAISE],
        [warning('send-push (program sent back)'), warning('send-push fan-out (program sent back)')],
      ],
    };

    // Which objects moved, and which of their fields: the definition of six
    // functions (not their owner, not their privileges) and the ledger's rows.
    const moved = diffCatalogs(before, after, { left: 'before', right: 'after' })
      .map((line) => /^(.*?): (\w+): /.exec(line).slice(1, 3).join(' → '));
    expect(moved).toEqual([
      ...Object.keys(expected).map((key) => `functions ${key} → definition`),
      'data rows of app_private.app_migrations → rows',
    ]);

    // Inside each definition: comments aside, the lines that are not the same.
    const code = (snapshot, key) => snapshot.functions[key].definition
      .split('\n').filter((line) => !/^\s*--/.test(line)).map((line) => line.trim());
    for (const [key, lines] of Object.entries(expected)) {
      const [was, is] = [code(before, key), code(after, key)];
      expect(is.length, key).toBe(was.length);
      expect(was.map((line, n) => [line, is[n]]).filter(([a, b]) => a !== b), key).toEqual(lines);
    }
    await db.drop();
  });

  // The runbook page tells the person applying the file what the audit prints
  // before and after. This is that table.
  it('its audit reads "the five" before and "none" after on the line of the finding', async () => {
    const db = await production();
    const audit = fs.readFileSync(path.join(repoRoot, nullGuard.paths.audit), 'utf8');
    const read = async () => {
      const [result] = await db.readOnly(audit, 'audit');
      return Object.fromEntries(result.rows.map((row) => [row.check, row.value]));
    };
    const five = 'adopt_skip(uuid, boolean); adopt_swap(uuid, uuid, boolean); approve_program(uuid); '
      + 'decline_promote_request(uuid); send_back_program(uuid)';
    const unchanged = {
      'running as': 'postgres',
      'coach RPCs found': five,
      'coach RPCs a signed-in user cannot execute': 'none',
      'coach RPCs that are not SECURITY DEFINER with a search_path': 'none',
      'coach RPCs not owned by postgres': 'none',
      'coach RPCs anon may execute': five,
    };

    // It runs before migration 01 too: it does not need the ledger.
    expect(await read()).toEqual({
      ...unchanged,
      'coach RPCs that run without a session (P1)': five,
      // The baseline is the repository's text. Production reads both names
      // here, before and after: it already runs the wording of 2026_07_22.
      'push warnings worded "send-push fan-out (…) failed" (L29)': 'none',
    });

    await db.runFile(ledger.paths.migration);
    await db.runFile(nullGuard.paths.migration);
    expect(await read()).toEqual({
      ...unchanged,
      'coach RPCs that run without a session (P1)': 'none',
      'push warnings worded "send-push fan-out (…) failed" (L29)': 'notify_coach_on_program_submit; send_back_program',
    });

    // A copy with other arguments shows up as a sixth entry, still open.
    await db.query(
      `create function public.adopt_skip(p_slot_id uuid) returns jsonb language sql as 'select null::jsonb'`,
    );
    expect(await read()).toMatchObject({
      'coach RPCs found': `adopt_skip(uuid); ${five}`,
      'coach RPCs that run without a session (P1)': 'adopt_skip(uuid)',
    });
    await db.drop();
  });

  it('without migration 01 it says so (SLM02) instead of failing on a missing table', async () => {
    const db = await production();
    const before = await catalogSnapshot(db.query);

    const refused = await attempt(() => db.runFile(nullGuard.paths.migration));
    expect(refused.error?.code).toBe(REFUSAL.predecessorMissing);
    expect(refused.error.message).toContain(`needs ${ledger.name}, which is not applied`);
    const undone = await attempt(() => db.runFile(nullGuard.paths.rollback));
    expect(undone.error?.code).toBe(REFUSAL.notApplied);

    expect(diffCatalogs(before, await catalogSnapshot(db.query), { left: 'before', right: 'after' })).toEqual([]);
    await db.drop();
  });

  it('refuses to run when one of the five also exists with other arguments, and changes nothing', async () => {
    const db = await production();
    await db.runFile(ledger.paths.migration);
    // An older shape of adopt_skip, left behind: CREATE OR REPLACE would not touch it.
    await db.query(
      `create function public.adopt_skip(p_slot_id uuid) returns jsonb language sql as 'select null::jsonb'`,
    );
    const before = await catalogSnapshot(db.query);

    const refused = await attempt(() => db.runFile(nullGuard.paths.migration));
    expect(refused.ok).toBe(false);
    expect(refused.error.message).toContain(`migration ${MIGRATION} would not replace: adopt_skip(uuid)`);
    expect(diffCatalogs(before, await catalogSnapshot(db.query), { left: 'before', right: 'after' })).toEqual([]);
    expect(await db.query.value(`select count(*) from ${LEDGER} where name = $1`, [MIGRATION])).toBe(0);

    // Once the stray copy is gone, it applies.
    await db.query(`drop function public.adopt_skip(uuid)`);
    await db.runFile(nullGuard.paths.migration);
    expect(await request(db, ANON, skip)).toBe('not authorized');
    await db.drop();
  });

  it('its rollback is refused while the ledger records a later migration, and changes nothing', async () => {
    const db = await production();
    await db.runFile(ledger.paths.migration);
    await db.runFile(nullGuard.paths.migration);
    await db.query(`insert into ${LEDGER} (name) values ($1)`, [TO_COME]);
    const before = await catalogSnapshot(db.query);

    const refused = await attempt(() => db.runFile(nullGuard.paths.rollback));
    expect(refused.error?.code).toBe(REFUSAL.stillNeeded);
    expect(refused.error.message).toContain(`the ledger still records later migrations: ${TO_COME}`);
    expect(diffCatalogs(before, await catalogSnapshot(db.query), { left: 'before', right: 'after' })).toEqual([]);
    expect(await request(db, ANON, skip)).toBe('not authorized');
    await db.drop();
  });
});
