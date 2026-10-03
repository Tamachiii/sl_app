// Known holes from the 2026-09-30 review, as executable specifications.
//
// Each `it.fails` asserts the SECURE behaviour and fails today because the
// hole is real — vitest reports an expected failure as a pass, so the suite
// stays green. The finding id (P = code review, L = live review) opens the
// title.
//
// Fixing one:
//   1. delete `.fails` on its test — it goes red, with the actual damage in
//      the assertion message;
//   2. fix supabase/schema.sql (+ a migration) until it is green;
//   3. keep the "control" tests next to it green: they are the legitimate
//      path the fix must not close.
// A fix that lands without step 1 also turns the run red ("expected to
// fail"), so a marker cannot outlive its hole.
//
// Every test is one rolled-back transaction: arrange as `postgres`, attack as
// the role named in the finding, then read the ground truth as `postgres`.
// The attack goes through attempt() because the secure outcome may be an
// error or a silent no-op — what is asserted is the state it leaves behind.

import { beforeAll, describe, expect, it } from 'vitest';
import { asAnon, asUser, attempt, createDraftProgram, scenario, seed } from './harness.js';

let ids;
beforeAll(async () => {
  ids = await seed();
});

const printed = (outcome) => (outcome.ok ? `returned ${JSON.stringify(outcome.value)}` : outcome.error.message);

// ------------------------------------------------------------
// P1 — the five coach-only SECURITY DEFINER RPCs run without a session.
// `IF v_coach_id IS NULL OR v_coach_id <> auth.uid() THEN RAISE` is NULL, not
// true, when auth.uid() is NULL; and `REVOKE ALL … FROM public` leaves the
// EXECUTE grant that Supabase's default privileges give `anon` by name.
// ------------------------------------------------------------
describe('P1 — coach-only RPCs called by anon (no JWT)', () => {
  // Pull-up slot of session 1: the same exercise sits in the 3 later sessions.
  const firstPullUpSlot = () => ids.programA.slots[0];
  const pullUpSlots = (q) => q.value(
    `select count(*)
       from exercise_slots es
       join sessions s on s.id = es.session_id
       join weeks w on w.id = s.week_id
      where w.program_id = $1 and es.exercise_id = $2`,
    [ids.programA.id, ids.exercises.pullUp],
  );
  const requestPromotion = (q) => q(
    `insert into slot_deviations (exercise_slot_id, student_id, kind, promote_requested_at)
     values ($1, $2, 'skip', now())`,
    [firstPullUpSlot(), ids.studentA.id],
  );
  const promotionPending = (q) => q.value(
    `select promote_requested_at is not null from slot_deviations where exercise_slot_id = $1`,
    [firstPullUpSlot()],
  );

  it.fails('P1 — anon cannot call adopt_skip', () => scenario(async (q) => {
    const call = await attempt(() => asAnon((anon) => anon.value(
      `select public.adopt_skip($1)`, [firstPullUpSlot()],
    )));
    expect(call.ok, `adopt_skip ${printed(call)}`).toBe(false);
    expect(await pullUpSlots(q)).toBe(4);
  }));

  it.fails('P1 — anon cannot call adopt_swap', () => scenario(async (q) => {
    const call = await attempt(() => asAnon((anon) => anon.value(
      `select public.adopt_swap($1, $2)`, [firstPullUpSlot(), ids.exercises.squat],
    )));
    expect(call.ok, `adopt_swap ${printed(call)}`).toBe(false);
    expect(await pullUpSlots(q)).toBe(4);
  }));

  it.fails('P1 — anon cannot call approve_program', () => scenario(async (q) => {
    const draft = await createDraftProgram(ids.studentA, { submitted: true });
    const call = await attempt(() => asAnon((anon) => anon.value(
      `select public.approve_program($1)`, [draft.id],
    )));
    expect(call.ok, `approve_program ${printed(call)}`).toBe(false);
    expect(await q.value(`select status from programs where id = $1`, [draft.id])).toBe('draft');
  }));

  it.fails('P1 — anon cannot call send_back_program', () => scenario(async (q) => {
    const draft = await createDraftProgram(ids.studentA, { submitted: true });
    const call = await attempt(() => asAnon((anon) => anon.value(
      `select public.send_back_program($1)`, [draft.id],
    )));
    expect(call.ok, `send_back_program ${printed(call)}`).toBe(false);
    expect(await q.value(`select submitted_at is not null from programs where id = $1`, [draft.id])).toBe(true);
  }));

  it.fails('P1 — anon cannot call decline_promote_request', () => scenario(async (q) => {
    await requestPromotion(q);
    const call = await attempt(() => asAnon((anon) => anon.value(
      `select public.decline_promote_request($1)`, [firstPullUpSlot()],
    )));
    expect(call.ok, `decline_promote_request ${printed(call)}`).toBe(false);
    expect(await promotionPending(q)).toBe(true);
  }));

  // Controls — green today, and the fix must keep them green.
  it('control: a signed-in user who is not the coach is refused by all five', () => scenario(async (q) => {
    const draft = await createDraftProgram(ids.studentA, { submitted: true });
    await requestPromotion(q);
    const calls = [
      [`select public.adopt_skip($1)`, [firstPullUpSlot()]],
      [`select public.adopt_swap($1, $2)`, [firstPullUpSlot(), ids.exercises.squat]],
      [`select public.approve_program($1)`, [draft.id]],
      [`select public.send_back_program($1)`, [draft.id]],
      [`select public.decline_promote_request($1)`, [firstPullUpSlot()]],
    ];
    // Student B (another tenant) and student A (the owner of the data, not its coach).
    for (const caller of [ids.studentB, ids.studentA]) {
      for (const [sql, params] of calls) {
        const call = await attempt(() => asUser(caller, (user) => user.value(sql, params)));
        expect(call.error?.message, sql).toBe('not authorized');
      }
    }
    expect(await pullUpSlots(q)).toBe(4);
    expect(await q.one(`select status, submitted_at is not null as submitted from programs where id = $1`, [draft.id]))
      .toEqual({ status: 'draft', submitted: true });
    expect(await promotionPending(q)).toBe(true);
  }));

  it('control: the coach calls all five', () => scenario(async (q) => {
    const coach = (sql, params) => asUser(ids.coach, (user) => user.value(sql, params));

    await requestPromotion(q);
    expect(await coach(`select public.decline_promote_request($1)`, [firstPullUpSlot()]))
      .toEqual({ declined: true });

    const sentBack = await createDraftProgram(ids.studentA, { submitted: true });
    expect(await coach(`select public.send_back_program($1)`, [sentBack.id])).toEqual({ sent_back: true });
    expect(await coach(`select public.approve_program($1)`, [sentBack.id]))
      .toEqual({ approved: true, set_logs_created: 6 });

    // Dry runs first: both report the 3 later pull-up slots.
    expect(await coach(`select public.adopt_swap($1, $2, true)`, [firstPullUpSlot(), ids.exercises.squat]))
      .toEqual({ applied: 3, dry_run: true });
    expect(await coach(`select public.adopt_skip($1, true)`, [firstPullUpSlot()]))
      .toEqual({ applied: 3, dry_run: true });
    expect(await coach(`select public.adopt_skip($1)`, [firstPullUpSlot()]))
      .toEqual({ applied: 3, dry_run: false });
    expect(await pullUpSlots(q)).toBe(1);
  }));
});

// ------------------------------------------------------------
// P7 / L2 — "Coaches insert students" only checks coach_id = auth.uid(): it
// never looks at profiles.role. The coach has no `students` row of its own,
// so a student can register its coach as "its athlete".
// ------------------------------------------------------------
describe('P7/L2 — the coach ↔ athlete link can be forged', () => {
  it.fails('P7/L2 — a student cannot insert a students row making itself the coach of its coach', () => scenario(async (q) => {
    const forged = await attempt(() => asUser(ids.studentA, (student) => student(
      `insert into students (profile_id, coach_id) values ($1, $2)`, [ids.coach.id, ids.studentA.id],
    )));
    expect(
      await q.value(`select count(*) from students where coach_id = $1`, [ids.studentA.id]),
      `the insert ${forged.ok ? 'succeeded' : `failed: ${forged.error.message}`}`,
    ).toBe(0);
  }));
});

// ------------------------------------------------------------
// P14 / L6 — pin_set_log_targets_for_student pins target_* only. The DELETE
// policy trusts is_student_added, which the student can set itself.
// ------------------------------------------------------------
describe('P14/L6 — deleting a prescribed set through is_student_added', () => {
  it.fails('P14/L6 — a student cannot flip is_student_added and then delete a prescribed set_log', () => scenario(async (q) => {
    const prescribed = ids.programA.setLogs[0];
    await asUser(ids.studentA, async (student) => {
      await attempt(() => student(`update set_logs set is_student_added = true where id = $1`, [prescribed]));
      await attempt(() => student(`delete from set_logs where id = $1`, [prescribed]));
    });
    expect(await q.one(`select is_student_added from set_logs where id = $1`, [prescribed]))
      .toEqual({ is_student_added: false });
  }));

  it('control: a student adds an extra set and deletes it again', () => scenario(async (q) => {
    const slot = ids.programA.slots[0];
    const sets = () => q.value(`select count(*) from set_logs where exercise_slot_id = $1`, [slot]);
    await asUser(ids.studentA, async (student) => {
      const extra = await student.value(
        `insert into set_logs (exercise_slot_id, set_number, is_student_added, done)
         values ($1, 4, true, true) returning id`,
        [slot],
      );
      expect(await sets()).toBe(4);
      expect((await student(`delete from set_logs where id = $1`, [extra])).rowCount).toBe(1);
    });
    expect(await sets()).toBe(3);
  }));

  it('control: a student cannot delete a prescribed set_log directly', () => scenario(async (q) => {
    const prescribed = ids.programA.setLogs[0];
    const deleted = await asUser(ids.studentA, (student) => student(`delete from set_logs where id = $1`, [prescribed]));
    expect(deleted.rowCount).toBe(0);
    expect(await q.value(`select count(*) from set_logs where id = $1`, [prescribed])).toBe(1);
  }));
});

// ------------------------------------------------------------
// P13 — "Students author own draft sessions" is FOR ALL with no column pin:
// the draft's author can pre-fill the columns that mean "the coach reviewed
// it", "archived", "trained". After approval the session never reaches the
// coach's inbox.
// ------------------------------------------------------------
describe('P13 — coach-owned session columns in a student draft', () => {
  const stamped = (q, weekId) => q.value(
    `select count(*) from sessions
      where week_id = $1
        and (reviewed_at is not null or archived_at is not null or performed_at is not null)`,
    [weekId],
  );

  it.fails('P13 — a student cannot set reviewed_at / archived_at / performed_at on a session of its draft', () => scenario(async (q) => {
    const draft = await createDraftProgram(ids.studentA);
    await attempt(() => asUser(ids.studentA, (student) => student(
      `update sessions set reviewed_at = now(), archived_at = now(), performed_at = now() where id = $1`,
      [draft.sessions[0]],
    )));
    expect(await stamped(q, draft.weeks[0])).toBe(0);
  }));

  it.fails('P13 — a student cannot insert a draft session with reviewed_at / archived_at / performed_at pre-filled', () => scenario(async (q) => {
    const draft = await createDraftProgram(ids.studentA);
    await attempt(() => asUser(ids.studentA, (student) => student(
      `insert into sessions (week_id, title, sort_order, reviewed_at, archived_at, performed_at)
       values ($1, 'Already reviewed', 1, now(), now(), now())`,
      [draft.weeks[0]],
    )));
    expect(await stamped(q, draft.weeks[0])).toBe(0);
  }));

  it('control: a student edits and extends the sessions of its own draft', () => scenario(async (q) => {
    const draft = await createDraftProgram(ids.studentA);
    await asUser(ids.studentA, async (student) => {
      await student(`update sessions set title = 'Pull day', day_number = 2 where id = $1`, [draft.sessions[0]]);
      await student(`insert into sessions (week_id, title, sort_order) values ($1, 'Push day', 1)`, [draft.weeks[0]]);
    });
    expect(await q.rows(`select title, day_number from sessions where week_id = $1 order by sort_order`, [draft.weeks[0]]))
      .toEqual([{ title: 'Pull day', day_number: 2 }, { title: 'Push day', day_number: null }]);
  }));

  // The two legitimate writers of those columns are SECURITY DEFINER triggers
  // that run inside the STUDENT's request (performed_at) and the coach's
  // (reviewed_at). A pin keyed on auth.uid() must let both through.
  it('control: confirming a session stamps performed_at, coach feedback stamps reviewed_at', () => scenario(async (q) => {
    const session = ids.programA.sessions[0];
    await asUser(ids.studentA, (student) => student(
      `insert into session_confirmations (session_id, student_id, performed_on)
       values ($1, $2, current_date - 1)`,
      [session, ids.studentA.id],
    ));
    await asUser(ids.coach, (coach) => coach(
      `insert into messages (sender_id, recipient_id, body, session_id) values ($1, $2, 'Solid session.', $3)`,
      [ids.coach.id, ids.studentA.id, session],
    ));
    expect(await q.one(
      `select performed_at::date = current_date - 1 as performed, reviewed_at is not null as reviewed
         from sessions where id = $1`,
      [session],
    )).toEqual({ performed: true, reviewed: true });
  }));
});

// ------------------------------------------------------------
// P18 / L7 — goals.exercise_id is ON DELETE CASCADE (slots and deviations
// are RESTRICT): tidying the library wipes the athletes' goals and the
// progress they logged against them.
// ------------------------------------------------------------
describe('P18/L7 — deleting a library exercise that a goal uses', () => {
  it.fails('P18/L7 — deleting an exercise_library row used by a goal is restricted', () => scenario(async (q) => {
    const goal = await q.value(
      `insert into goals (student_id, coach_id, exercise_id, kind, target_weight_kg)
       values ($1, $2, $3, 'one_rm', 100) returning id`,
      [ids.studentA.id, ids.coach.id, ids.exercises.squat],
    );
    await q(`insert into goal_progress (goal_id, weight_kg, reps) values ($1, 80, 1)`, [goal]);

    const removal = await attempt(() => asUser(ids.coach, (coach) => coach(
      `delete from exercise_library where id = $1`, [ids.exercises.squat],
    )));
    expect(removal.ok, 'the DELETE went through').toBe(false);
    expect(await q.one(
      `select (select count(*) from goals where id = $1)              as goals,
              (select count(*) from goal_progress where goal_id = $1) as progress`,
      [goal],
    )).toEqual({ goals: 1, progress: 1 });
  }));

  it('control: an exercise nothing refers to can be deleted, one used by a slot cannot', () => scenario(async (q) => {
    await asUser(ids.coach, async (coach) => {
      expect((await coach(`delete from exercise_library where id = $1`, [ids.exercises.muscleUp])).rowCount).toBe(1);
      const inUse = await attempt(() => coach(`delete from exercise_library where id = $1`, [ids.exercises.pullUp]));
      expect(inUse.error?.code).toBe('23503');
    });
    expect(await q.value(`select count(*) from exercise_library`)).toBe(3);
  }));
});

// ------------------------------------------------------------
// P3 — "logged training can never be hard-deleted" is enforced on programs,
// weeks and sessions (block_*_delete_with_logged_sets) but not below: the
// coach editor deletes logged set_logs, and exercise_slots whose sets are
// logged, with their RPE, actuals, comments and videos.
// ------------------------------------------------------------
describe('P3 — hard-deleting logged training below the session', () => {
  const logFirstSet = () => asUser(ids.studentA, (student) => student(
    `update set_logs set done = true, rpe = 8, logged_at = now() where id = $1`, [ids.programA.setLogs[0]],
  ));

  it.fails('P3 — the coach cannot delete a logged set_log', () => scenario(async (q) => {
    await logFirstSet();
    const removal = await attempt(() => asUser(ids.coach, (coach) => coach(
      `delete from set_logs where id = $1`, [ids.programA.setLogs[0]],
    )));
    expect(
      await q.one(`select done, rpe from set_logs where id = $1`, [ids.programA.setLogs[0]]),
      `the DELETE ${removal.ok ? `removed ${removal.value.rowCount} row(s)` : `failed: ${removal.error.message}`}`,
    ).toEqual({ done: true, rpe: 8 });
  }));

  it.fails('P3 — the coach cannot delete an exercise_slot that has logged sets', () => scenario(async (q) => {
    await logFirstSet();
    const removal = await attempt(() => asUser(ids.coach, (coach) => coach(
      `delete from exercise_slots where id = $1`, [ids.programA.slots[0]],
    )));
    expect(
      await q.one(
        `select (select count(*) from exercise_slots where id = $1)            as slots,
                (select count(*) from set_logs where exercise_slot_id = $1)   as set_logs`,
        [ids.programA.slots[0]],
      ),
      `the DELETE ${removal.ok ? `removed ${removal.value.rowCount} row(s)` : `failed: ${removal.error.message}`}`,
    ).toEqual({ slots: 1, set_logs: 3 });
  }));

  it('control: the session, week and program above a logged set are already protected', () => scenario(async () => {
    await logFirstSet();
    await asUser(ids.coach, async (coach) => {
      const session = await attempt(() => coach(`delete from sessions where id = $1`, [ids.programA.sessions[0]]));
      const week = await attempt(() => coach(`delete from weeks where id = $1`, [ids.programA.weeks[0]]));
      const program = await attempt(() => coach(`delete from programs where id = $1`, [ids.programA.id]));
      expect(session.error?.message).toMatch(/still has 1 logged set/);
      expect(week.error?.message).toMatch(/still has 1 logged set/);
      expect(program.error?.message).toMatch(/still has 1 logged set/);
    });
  }));

  it('control: the coach deletes a set_log and a slot nobody trained yet', () => scenario(async (q) => {
    await asUser(ids.coach, async (coach) => {
      expect((await coach(`delete from set_logs where id = $1`, [ids.programA.setLogs[2]])).rowCount).toBe(1);
      expect((await coach(`delete from exercise_slots where id = $1`, [ids.programA.slots[1]])).rowCount).toBe(1);
    });
    expect(await q.value(`select count(*) from set_logs`)).toBe(30 - 1 - 3);
  }));
});
