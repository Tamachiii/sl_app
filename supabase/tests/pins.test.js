// The set and session columns an athlete must not change — review findings
// P13, P14 and B4, closed by migration 2026_10_11_06_pin_student_writes.
//
// An athlete writes three kinds of rows that hold a column which is not
// theirs: a set (whether it is a prescribed one, which exercise it belongs
// to, its number), a session of the draft they are writing (reviewed,
// archived, trained, dated) and the draft itself (its submission, which
// notifies the coach). Since the migration:
//
//   a set, by its athlete     target_*, is_student_added, exercise_slot_id and
//                             set_number stay what they were; the rest of the
//                             write is saved
//   a session of a draft      reviewed_at, archived_at, performed_at and
//                             scheduled_date are NULL, whoever writes
//   approve_program           clears the four on the sessions it approves
//   a draft, by its author    submitted_at goes from NULL to a time, once
//
// All four are SILENT: the statement is accepted and the column keeps its
// value. So every test reads the row back — an error is never the proof.
//
// One test is not a scenario(): the pin on a session against an approval
// that is committed while the author's stamp is on its way. That takes three
// transactions of their own, and no test on one connection can fail on it.
//
// The first blocks run against schema.sql, as the callers the app has. The
// writes of the app that is DEPLOYED today are replayed as it sends them
// (src/lib/offlineMutations.js, src/hooks/useSetLogs.js, useSession.js,
// useWeek.js, useAuthoring.js): the migration is applied while that app is
// live. The last block applies the migration file itself to the frozen
// production baseline, with the checks of its runbook page read off the page.

import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  asAdmin, asService, asUser, attempt, createDraftProgram, createProgram, enablePush, httpCalls, pastBlock,
  repoRoot, scenario, scratchDatabase, seed,
} from './harness.js';
import { catalogSnapshot, diffCatalogs } from './catalog.js';
import { LEDGER, loadManifest, REFUSAL } from '../migrations/manifest.js';

const MIGRATION = '2026_10_11_06_pin_student_writes';
const manifest = loadManifest();
const migration = manifest.migrations.find((m) => m.name === MIGRATION);
const read = (file) => fs.readFileSync(path.join(repoRoot, file), 'utf8');

// seed(): coach Carla; athlete A with the active Block A (2 weeks × 2
// sessions, each a pull-up slot and a dip slot of 3 sets × 5 reps @ 20 kg);
// athlete B with the active Block B.
let ids;
beforeAll(async () => {
  ids = await seed();
});

const sessionsOfA = () => ids.programA.tree.flatMap((week) => week.sessions);
const pullUp = (n) => sessionsOfA()[n].slots[0];   // { id, exerciseId, setLogs: [id × 3] }
const dip = (n) => sessionsOfA()[n].slots[1];

// A row as it was left before a rule existed, or one a fixture needs without
// asking any rule: the triggers are stepped around, the way a dump restore
// does.
const withoutTriggers = async (q, fn) => {
  await q(`select set_config('session_replication_role', 'replica', true)`);
  try {
    return await fn();
  } finally {
    await q(`select set_config('session_replication_role', 'origin', true)`);
  }
};

// ============================================================
// P14 — a set
// ============================================================
describe('a set: what its athlete\'s own update leaves as it was (P14)', () => {
  const HELD = `exercise_slot_id, set_number, is_student_added, target_reps, target_duration_seconds,
                target_weight_kg, target_rest_seconds`;
  const held = (q, id) => q.one(`select ${HELD} from set_logs where id = $1`, [id]);
  const prescribed = (slot, n) => ({
    exercise_slot_id: slot.id, set_number: n, is_student_added: false,
    target_reps: 5, target_duration_seconds: null, target_weight_kg: 20, target_rest_seconds: 120,
  });
  const athlete = (fn) => asUser(ids.studentA, fn);

  // The finding: the DELETE policy lets an athlete delete a set they added —
  // and "added" was a column they could write.
  it('an athlete cannot mark a prescribed set as their own, and so cannot delete it', () => scenario(async (q) => {
    const [set] = pullUp(0).setLogs;
    await athlete(async (a) => {
      // Accepted, and held: what comes back is the row as it is stored.
      expect(await a.one(`update set_logs set is_student_added = true where id = $1 returning is_student_added`, [set]))
        .toEqual({ is_student_added: false });
      expect((await a(`delete from set_logs where id = $1`, [set])).rowCount).toBe(0);
      // The app's own delete of an extra set (useRemoveStudentSet) finds nothing either.
      expect((await a(`delete from set_logs where id = $1 and is_student_added = true`, [set])).rowCount).toBe(0);
    });
    expect(await held(q, set)).toEqual(prescribed(pullUp(0), 1));
    expect(await q.value(`select count(*) from set_logs where exercise_slot_id = $1`, [pullUp(0).id])).toBe(3);
  }));

  it('nor turn an extra set of theirs into a prescribed one', () => scenario(async (q) => {
    const extra = await athlete((a) => a.value(
      `insert into set_logs (exercise_slot_id, set_number, is_student_added, done, failed)
       values ($1, 4, true, false, false) returning id`,
      [pullUp(0).id],
    ));
    await athlete((a) => a(`update set_logs set is_student_added = false, done = true, logged_at = now() where id = $1`, [extra]));
    expect(await q.one(`select is_student_added, done from set_logs where id = $1`, [extra]))
      .toEqual({ is_student_added: true, done: true });
    // …so it is still theirs to take back.
    expect((await athlete((a) => a(`delete from set_logs where id = $1 and is_student_added = true`, [extra]))).rowCount).toBe(1);
  }));

  // The other lane of the finding: no DELETE needed. A set moved out of the
  // way frees its place in UNIQUE (exercise_slot_id, set_number), and the
  // INSERT policy takes a row with any targets.
  it('an athlete cannot give a set another number: the place it would leave stays taken', () => scenario(async (q) => {
    const [set] = pullUp(0).setLogs;
    await athlete(async (a) => {
      expect(await a.one(`update set_logs set set_number = 99 where id = $1 returning set_number`, [set]))
        .toEqual({ set_number: 1 });
      const replacement = await attempt(() => a(
        `insert into set_logs (exercise_slot_id, set_number, target_reps, target_weight_kg) values ($1, 1, 1, 300)`,
        [pullUp(0).id],
      ));
      expect(replacement.error?.code).toBe('23505');
    });
    expect(await held(q, set)).toEqual(prescribed(pullUp(0), 1));
    expect(await q.rows(`select set_number, target_weight_kg from set_logs where exercise_slot_id = $1 order by set_number`, [pullUp(0).id]))
      .toEqual([1, 2, 3].map((n) => ({ set_number: n, target_weight_kg: 20 })));
  }));

  it('an athlete cannot move a set to another exercise: one of theirs, another athlete\'s, or none', () => scenario(async (q) => {
    const [set] = pullUp(0).setLogs;
    const elsewhere = [
      ['another exercise of the same session', dip(0).id],
      ['an exercise of another of their sessions', pullUp(3).id],
      ['an exercise of another athlete', ids.programB.slots[0]],
      ['no exercise at all', null],
    ];
    for (const [where, slot] of elsewhere) {
      // With a free number, so that only the pin can stop it.
      const moved = await attempt(() => athlete((a) => a.one(
        `update set_logs set exercise_slot_id = $2, set_number = 9 where id = $1 returning exercise_slot_id, set_number`,
        [set, slot],
      )));
      expect(moved.value, `${where}: ${moved.error?.message}`).toEqual({ exercise_slot_id: pullUp(0).id, set_number: 1 });
      expect(await held(q, set), where).toEqual(prescribed(pullUp(0), 1));
    }
    expect(await q.value(`select count(*) from set_logs where exercise_slot_id = $1`, [pullUp(0).id])).toBe(3);
    expect(await q.value(`select count(*) from set_logs where exercise_slot_id = $1`, [ids.programB.slots[0]])).toBe(3);
  }));

  // Whose set it is, is asked of the row as it WAS. Asked of the new row, a
  // set pointed at a slot that is not the athlete's would not be "theirs" for
  // the trigger, and nothing of the statement would be held.
  it('pointing the set somewhere else does not get the rest of the write past the pin', () => scenario(async (q) => {
    const [set] = pullUp(0).setLogs;
    for (const slot of [ids.programB.slots[0], null]) {
      await attempt(() => athlete((a) => a(
        `update set_logs set exercise_slot_id = $2, target_reps = 1, target_weight_kg = 300, is_student_added = true
          where id = $1`,
        [set, slot],
      )));
      expect(await held(q, set)).toEqual(prescribed(pullUp(0), 1));
    }
  }));

  // The upsert of the API: INSERT … ON CONFLICT DO UPDATE. Onto a set that is
  // there it is an update of that set, and held like one.
  it('an upsert onto a prescribed set does not replace it', () => scenario(async (q) => {
    const [set] = pullUp(0).setLogs;
    await athlete((a) => a(
      `insert into set_logs (exercise_slot_id, set_number, is_student_added, target_reps, target_weight_kg, done)
       values ($1, 1, true, 1, 300, true)
       on conflict (exercise_slot_id, set_number) do update
         set is_student_added = excluded.is_student_added, target_reps = excluded.target_reps,
             target_weight_kg = excluded.target_weight_kg, done = excluded.done`,
      [pullUp(0).id],
    ));
    expect(await held(q, set)).toEqual(prescribed(pullUp(0), 1));
    expect(await q.one(`select count(*) as sets, bool_or(done) as done from set_logs where exercise_slot_id = $1`, [pullUp(0).id]))
      .toEqual({ sets: 3, done: true });
  }));

  it('in the same request, what the athlete did on the set is saved', () => scenario(async (q) => {
    const [set] = pullUp(0).setLogs;
    const written = await athlete((a) => a.one(
      `update set_logs
          set done = true, rpe = 8, logged_at = now(), actual_reps = 4, actual_weight_kg = 22.5,
              target_reps = 99, target_weight_kg = 300, target_rest_seconds = 1,
              is_student_added = true, set_number = 9, exercise_slot_id = $2
        where id = $1
        returning done, rpe, actual_reps, actual_weight_kg, logged_at is not null as logged`,
      [set, dip(0).id],
    ));
    expect(written).toEqual({ done: true, rpe: 8, actual_reps: 4, actual_weight_kg: 22.5, logged: true });
    expect(await held(q, set)).toEqual(prescribed(pullUp(0), 1));
  }));

  // src/lib/offlineMutations.js (patchForDone / patchForFailed / setRpe /
  // logActual / patchForSkipped) and src/hooks/useSetLogs.js (useAddStudentSet,
  // useRemoveStudentSet), as production runs them: none sends a held column
  // in an update.
  it('the deployed app, as an athlete: every write to a set goes through as before', () => scenario(async (q) => {
    const [set, second] = pullUp(0).setLogs;
    const write = (assignments, id = set) => athlete((a) => a.one(
      `update set_logs set ${assignments} where id = $1
       returning done, failed, skipped, rpe, actual_reps, actual_weight_kg,
                 logged_at is not null as logged, failed_at is not null as failed_marked`,
      [id],
    ));
    const blank = {
      done: false, failed: false, skipped: false, rpe: null, actual_reps: null, actual_weight_kg: null,
      logged: false, failed_marked: false,
    };

    expect(await write(`done = true, failed = false, logged_at = now(), failed_at = null`))
      .toEqual({ ...blank, done: true, logged: true });
    expect(await write(`rpe = 8`)).toEqual({ ...blank, done: true, logged: true, rpe: 8 });
    expect(await write(`actual_reps = 4, actual_weight_kg = 22.5`))
      .toEqual({ ...blank, done: true, logged: true, rpe: 8, actual_reps: 4, actual_weight_kg: 22.5 });
    expect(await write(`done = false, logged_at = null`))
      .toEqual({ ...blank, rpe: 8, actual_reps: 4, actual_weight_kg: 22.5 });
    expect(await write(`failed = true, done = false, failed_at = now(), logged_at = null, rpe = null`))
      .toEqual({ ...blank, failed: true, failed_marked: true, actual_reps: 4, actual_weight_kg: 22.5 });
    expect(await write(`failed = false, failed_at = null`)).toEqual({ ...blank, actual_reps: 4, actual_weight_kg: 22.5 });
    expect(await write(
      `skipped = true, done = false, failed = false, rpe = null, logged_at = null, failed_at = null,
       actual_reps = null, actual_weight_kg = null`,
      second,
    )).toEqual({ ...blank, skipped: true });
    expect(await write(`skipped = false`, second)).toEqual(blank);

    // An extra set: added, done, and taken back.
    const extra = await athlete((a) => a.one(
      `insert into set_logs (exercise_slot_id, set_number, is_student_added, done, failed)
       values ($1, 4, true, false, false) returning id, set_number, is_student_added`,
      [pullUp(0).id],
    ));
    expect(extra).toEqual({ id: expect.any(String), set_number: 4, is_student_added: true });
    expect(await write(`done = true, failed = false, logged_at = now(), failed_at = null`, extra.id))
      .toEqual({ ...blank, done: true, logged: true });
    expect((await athlete((a) => a(`delete from set_logs where id = $1 and is_student_added = true`, [extra.id]))).rowCount).toBe(1);

    // Nothing of what the sets ARE moved.
    expect(await held(q, set)).toEqual(prescribed(pullUp(0), 1));
    expect(await held(q, second)).toEqual(prescribed(pullUp(0), 2));
  }));

  // src/hooks/useSession.js, reconcileSetLogCount: when the coach changes
  // "Sets", the athlete's extra sets are renumbered to stay above the
  // prescription — parked at set_number + 100000, then placed.
  it('the deployed app, as the coach: the editor still renumbers an athlete\'s extra set', () => scenario(async (q) => {
    const slot = pullUp(0);
    const extra = await athlete((a) => a.value(
      `insert into set_logs (exercise_slot_id, set_number, is_student_added, done, failed, logged_at)
       values ($1, 4, true, true, false, now()) returning id`,
      [slot.id],
    ));
    const numbering = () => q.rows(
      `select set_number, is_student_added from set_logs where exercise_slot_id = $1 order by set_number`, [slot.id],
    );
    const the = (n, added = false) => ({ set_number: n, is_student_added: added });

    await asUser(ids.coach, async (coach) => {
      // "Sets" 3 → 4: the extra set gives its number to the new prescribed one.
      await coach(`update exercise_slots set sets = 4 where id = $1`, [slot.id]);
      expect((await coach(`update set_logs set set_number = $2 where id = $1`, [extra, 100004])).rowCount).toBe(1);
      await coach(
        `insert into set_logs (exercise_slot_id, set_number, done, target_reps, target_duration_seconds,
                               target_weight_kg, target_rest_seconds)
         values ($1, 4, false, 5, null, 20, 120)`,
        [slot.id],
      );
      expect((await coach(`update set_logs set set_number = $2 where id = $1`, [extra, 5])).rowCount).toBe(1);
    });
    expect(await numbering()).toEqual([the(1), the(2), the(3), the(4), the(5, true)]);

    await asUser(ids.coach, async (coach) => {
      // "Sets" 4 → 3: the prescribed set 4, which nobody trained, goes; the
      // extra one closes the gap.
      await coach(`update exercise_slots set sets = 3 where id = $1`, [slot.id]);
      await coach(`delete from set_logs where exercise_slot_id = $1 and set_number = 4`, [slot.id]);
      await coach(`update set_logs set set_number = $2 where id = $1`, [extra, 100005]);
      await coach(`update set_logs set set_number = $2 where id = $1`, [extra, 4]);
    });
    expect(await numbering()).toEqual([the(1), the(2), the(3), the(4, true)]);
  }));

  // The runbook page: "the number, the exercise and the 'extra' mark of a set
  // can be corrected with a plain update" from the SQL editor.
  it('a statement without a user id is not the athlete\'s: the service role and the owner correct a set', () => scenario(async (q) => {
    const [first, second] = dip(0).setLogs;
    await asService((service) => service(`update set_logs set set_number = 7 where id = $1`, [first]));
    await q(`update set_logs set is_student_added = true, exercise_slot_id = $2, set_number = 8 where id = $1`, [second, pullUp(0).id]);
    expect(await q.rows(`select ${HELD} from set_logs where id = any($1) order by set_number`, [[first, second]])).toEqual([
      { ...prescribed(dip(0), 7) },
      { ...prescribed(pullUp(0), 8), is_student_added: true },
    ]);
  }));

  // Row-level security is what it was: the pin adds nothing to who may write.
  it('another athlete, and an athlete whose block is no longer the active one, write nothing', () => scenario(async (q) => {
    const [set] = pullUp(0).setLogs;
    const tick = `update set_logs set done = true, logged_at = now(), set_number = 9 where id = $1`;
    expect((await asUser(ids.studentB, (other) => other(tick, [set]))).rowCount).toBe(0);
    // … "no longer": switched off more than 72 hours ago (migration 17).
    await pastBlock(q, ids.programA.id);
    expect((await athlete((a) => a(tick, [set]))).rowCount).toBe(0);
    expect(await q.one(`select done, set_number from set_logs where id = $1`, [set])).toEqual({ done: false, set_number: 1 });
  }));
});

// ============================================================
// P13 — a session of a draft
// ============================================================
describe('a session of a draft carries no review, no archive, no training date and no recommended date (P13)', () => {
  const FOUR = `reviewed_at, archived_at, performed_at, scheduled_date`;
  const STAMPED = `reviewed_at = now(), archived_at = now(), performed_at = now(), scheduled_date = current_date`;
  const EMPTY = { reviewed_at: null, archived_at: null, performed_at: null, scheduled_date: null };
  const four = (q, id) => q.one(`select ${FOUR} from sessions where id = $1`, [id]);
  const stampedIn = (q, programId) => q.value(
    `select count(*) from sessions s join weeks w on w.id = s.week_id
      where w.program_id = $1 and num_nonnulls(s.reviewed_at, s.archived_at, s.performed_at, s.scheduled_date) > 0`,
    [programId],
  );

  it('the author cannot stamp a session of their draft, on update or on insert — and what else they wrote is saved', () => scenario(async (q) => {
    const draft = await createDraftProgram(ids.studentA);
    const [session] = draft.sessions;
    await asUser(ids.studentA, async (author) => {
      // Each column alone, then the four at once.
      for (const column of ['reviewed_at = now()', 'archived_at = now()', 'performed_at = now()', 'scheduled_date = current_date', STAMPED]) {
        const written = await author.one(
          `update sessions set ${column}, title = 'Pull day' where id = $1 returning title, ${FOUR}`, [session],
        );
        expect(written, column).toEqual({ title: 'Pull day', ...EMPTY });
      }
      const inserted = await author.one(
        `insert into sessions (week_id, title, sort_order, day_number, ${FOUR})
         values ($1, 'Already reviewed', 1, 3, now(), now(), now(), current_date)
         returning title, day_number, ${FOUR}`,
        [draft.weeks[0]],
      );
      expect(inserted).toEqual({ title: 'Already reviewed', day_number: 3, ...EMPTY });
    });
    expect(await stampedIn(q, draft.id)).toBe(0);
    expect(await q.value(`select count(*) from sessions where week_id = $1`, [draft.weeks[0]])).toBe(2);
  }));

  // INSERT … ON CONFLICT DO UPDATE fires the INSERT trigger on the proposed
  // row and the UPDATE trigger on the one that is kept.
  it('an upsert does not stamp one either', () => scenario(async (q) => {
    const draft = await createDraftProgram(ids.studentA);
    const [session] = draft.sessions;
    await asUser(ids.studentA, (author) => author(
      `insert into sessions (id, week_id, title, sort_order, reviewed_at, performed_at)
       values ($1, $2, 'Upserted', 0, now(), now())
       on conflict (id) do update
         set title = excluded.title, reviewed_at = excluded.reviewed_at, performed_at = excluded.performed_at`,
      [session, draft.weeks[0]],
    ));
    expect(await q.one(`select title, ${FOUR} from sessions where id = $1`, [session])).toEqual({ title: 'Upserted', ...EMPTY });
  }));

  // src/hooks/useAuthoring.js, buildSnapshot → save_draft_tree: the only way
  // the deployed app writes the sessions of a draft.
  it('the deployed app, as the author: save_draft_tree saves the draft as before, twice over', () => scenario(async (q) => {
    const uuid = () => q.value(`select gen_random_uuid()`);
    const [program, week, monday, friday, slot] = [await uuid(), await uuid(), await uuid(), await uuid(), await uuid()];
    const tree = {
      program: { id: program, name: 'Written offline', submitted_at: null },
      weeks: [{ id: week, program_id: program, week_number: 1, label: null }],
      sessions: [
        { id: monday, week_id: week, title: 'Pull', day_number: 1, sort_order: 0 },
        { id: friday, week_id: week, title: 'Push', sort_order: 1 },
      ],
      slots: [{
        id: slot, session_id: monday, exercise_id: ids.exercises.pullUp, sets: 3, reps: 5,
        weight_kg: null, duration_seconds: null, rest_seconds: 90, sort_order: 0,
      }],
    };
    const save = () => asUser(ids.studentA, (author) => author.value(`select public.save_draft_tree($1)`, [tree]));
    for (const run of [1, 2]) {
      expect(await save(), `run ${run}`).toEqual({ program_id: program, weeks: 1, sessions: 2, slots: 1 });
      expect(await q.rows(`select title, day_number, sort_order, ${FOUR} from sessions where week_id = $1 order by sort_order`, [week]))
        .toEqual([
          { title: 'Pull', day_number: 1, sort_order: 0, ...EMPTY },
          { title: 'Push', day_number: null, sort_order: 1, ...EMPTY },
        ]);
    }
  }));

  // "Whoever writes": the rule is the status of the program, not the writer.
  // src/hooks/useWeek.js (useArchiveSession), SessionEditor (recommended date)
  // and useSession.js (useMarkReviewed) are what the coach's app sends.
  it('the coach, the service role and the owner of the database cannot stamp a session of a draft either', () => scenario(async (q) => {
    const draft = await createDraftProgram(ids.studentA, { submitted: true });
    const [session] = draft.sessions;
    await asUser(ids.coach, async (coach) => {
      // Accepted — one row — and not kept.
      expect(await coach.one(`update sessions set archived_at = now() where id = $1 returning ${FOUR}`, [session])).toEqual(EMPTY);
      expect(await coach.one(`update sessions set scheduled_date = '2026-11-02' where id = $1 returning ${FOUR}`, [session])).toEqual(EMPTY);
      expect(await coach.one(
        `update sessions set reviewed_at = now() where id = $1 and reviewed_at is null returning ${FOUR}`, [session],
      )).toEqual(EMPTY);
      // The rest of what the coach's editor writes on a session is.
      expect(await coach.one(`update sessions set title = 'Renamed', day_number = 4 where id = $1 returning title, day_number`, [session]))
        .toEqual({ title: 'Renamed', day_number: 4 });
    });
    await asService((service) => service(`update sessions set ${STAMPED} where id = $1`, [session]));
    expect(await four(q, session)).toEqual(EMPTY);
    await q(`update sessions set ${STAMPED} where id = $1`, [session]);
    await q(
      `insert into sessions (week_id, title, sort_order, ${FOUR}) values ($1, 'By hand', 5, now(), now(), now(), current_date)`,
      [draft.weeks[0]],
    );
    expect(await stampedIn(q, draft.id)).toBe(0);

    // In the trash, a draft is still a draft.
    await q(`update programs set deleted_at = now() where id = $1`, [draft.id]);
    await q(`update sessions set ${STAMPED} where id = $1`, [session]);
    expect(await stampedIn(q, draft.id)).toBe(0);
  }));

  it('a session moved into a draft arrives without the four', () => scenario(async (q) => {
    const draft = await createDraftProgram(ids.studentA);
    const other = await createProgram({ student: ids.studentA, name: 'Old block' });
    const [session] = other.sessions;
    await withoutTriggers(q, () => q(`update sessions set ${STAMPED} where id = $1`, [session]));
    expect(await stampedIn(q, other.id)).toBe(1);

    await q(`update sessions set week_id = $2, sort_order = 7 where id = $1`, [session, draft.weeks[0]]);
    expect(await four(q, session)).toEqual(EMPTY);
  }));

  // KNOWN residual: the rule is asked when a session is written. No path of
  // the app turns an approved program back into a draft; a coach who does it
  // through the API keeps the stamps of its sessions until each is written.
  it('a program made a draft again keeps what its sessions carry until they are next written', () => scenario(async (q) => {
    const other = await createProgram({ student: ids.studentA, name: 'Old block', sessions: 2 });
    await withoutTriggers(q, () => q(`update sessions set ${STAMPED} where id = any($1)`, [other.sessions]));
    await asUser(ids.coach, (coach) => coach(`update programs set status = 'draft' where id = $1`, [other.id]));
    expect(await q.value(`select status from programs where id = $1`, [other.id])).toBe('draft');
    expect(await stampedIn(q, other.id)).toBe(2);

    await asUser(ids.coach, (coach) => coach(`update sessions set title = 'Renamed' where id = $1`, [other.sessions[0]]));
    expect(await four(q, other.sessions[0])).toEqual(EMPTY);
    expect(await stampedIn(q, other.id)).toBe(1);
  }));

  // What a draft may carry from before the rule: written through the hole, or
  // by a coach who archived or dated a session of a draft in the app.
  describe('a draft that carries them from before', () => {
    const stale = async (q, options) => {
      const draft = await createDraftProgram(ids.studentA, { sessions: 2, ...options });
      await withoutTriggers(q, () => q(
        `update sessions set ${STAMPED} where id = any($1)`, [draft.sessions],
      ));
      expect(await stampedIn(q, draft.id)).toBe(2);
      return draft;
    };

    it('the next write of such a session clears it — the others wait for approval', () => scenario(async (q) => {
      const draft = await stale(q);
      await asUser(ids.studentA, (author) => author(`update sessions set title = 'Edited' where id = $1`, [draft.sessions[0]]));
      expect(await four(q, draft.sessions[0])).toEqual(EMPTY);
      expect(await stampedIn(q, draft.id)).toBe(1);
    }));

    it('approve_program clears every session of the program, and answers what it answered', () => scenario(async (q) => {
      const draft = await stale(q, { submitted: true });
      const other = await createProgram({ student: ids.studentB, name: 'Not this one' });
      await withoutTriggers(q, () => q(`update sessions set ${STAMPED} where id = $1`, [other.sessions[0]]));

      expect(await asUser(ids.coach, (coach) => coach.value(`select public.approve_program($1)`, [draft.id])))
        .toEqual({ approved: true, set_logs_created: 12 });
      expect(await stampedIn(q, draft.id)).toBe(0);
      expect(await q.one(`select status, submitted_at, approved_at is not null as approved from programs where id = $1`, [draft.id]))
        .toEqual({ status: 'approved', submitted_at: null, approved: true });
      // Its sessions, and nobody else's.
      expect(await stampedIn(q, other.id)).toBe(1);
      expect(await stampedIn(q, ids.programA.id)).toBe(0);
    }));

    it('a caller who may not approve clears nothing', () => scenario(async (q) => {
      const draft = await stale(q, { submitted: true });
      for (const caller of [ids.studentA, ids.studentB]) {
        const tried = await attempt(() => asUser(caller, (user) => user.value(`select public.approve_program($1)`, [draft.id])));
        expect(tried.error?.message).toBe('not authorized');
      }
      expect(await stampedIn(q, draft.id)).toBe(2);
    }));
  });

  // The reason the rule is keyed on the status of the program: this athlete
  // wrote the program they now train. performed_at is written by
  // sync_session_performed_at inside THEIR request — the request of the
  // author. A pin "for the author" would undo it.
  it('once approved, a program its athlete wrote is trained and reviewed like any other', () => scenario(async (q) => {
    const draft = await createDraftProgram(ids.studentA, { submitted: true });
    const [session] = draft.sessions;
    await asUser(ids.coach, async (coach) => {
      await coach.value(`select public.approve_program($1)`, [draft.id]);
      // "Set active" (src/hooks/useProgram.js): the other blocks off, this one on.
      await coach(`update programs set is_active = false where student_id = $1 and id <> $2`, [draft.studentRowId, draft.id]);
      await coach(`update programs set is_active = true where id = $1`, [draft.id]);
      // Archived and dated by the coach, now that it is a program: both stay.
      expect(await coach.one(
        `update sessions set scheduled_date = '2026-11-02' where id = $1 returning scheduled_date`, [session],
      )).toEqual({ scheduled_date: '2026-11-02' });
    });
    expect(await q.one(`select created_by, status, is_active from programs where id = $1`, [draft.id]))
      .toEqual({ created_by: ids.studentA.id, status: 'approved', is_active: true });

    // The athlete confirms (src/lib/offlineMutations.js, confirmSessionFn: an upsert).
    const confirm = (day) => asUser(ids.studentA, (athlete) => athlete(
      `insert into session_confirmations (session_id, student_id, notes, performed_on)
       values ($1, $2, null, ${day})
       on conflict (session_id) do update
         set student_id = excluded.student_id, notes = excluded.notes, performed_on = excluded.performed_on`,
      [session, ids.studentA.id],
    ));
    const trainedOn = () => q.value(`select current_date - performed_at::date from sessions where id = $1`, [session]);
    await confirm('current_date - 2');
    expect(await trainedOn()).toBe(2);
    // Replayed with another day, undone, made again.
    await confirm('current_date - 1');
    expect(await trainedOn()).toBe(1);
    await asUser(ids.studentA, (athlete) => athlete(`delete from session_confirmations where session_id = $1`, [session]));
    expect(await trainedOn()).toBeNull();
    await confirm('current_date - 1');
    expect(await trainedOn()).toBe(1);

    // The coach's feedback stamps the review; then the coach archives.
    await asUser(ids.coach, async (coach) => {
      await coach(
        `insert into messages (sender_id, recipient_id, body, session_id) values ($1, $2, 'Solid session.', $3)`,
        [ids.coach.id, ids.studentA.id, session],
      );
      await coach(`update sessions set archived_at = now() where id = $1`, [session]);
    });
    expect(await q.one(
      `select reviewed_at is not null as reviewed, archived_at is not null as archived,
              performed_at is not null as trained, scheduled_date from sessions where id = $1`,
      [session],
    )).toEqual({ reviewed: true, archived: true, trained: true, scheduled_date: '2026-11-02' });
  }));

  it('on a program the coach wrote, the four columns are written as before', () => scenario(async (q) => {
    const session = sessionsOfA()[0].id;
    await asUser(ids.studentA, (athlete) => athlete(
      `insert into session_confirmations (session_id, student_id, performed_on) values ($1, $2, current_date)`,
      [session, ids.studentA.id],
    ));
    await asUser(ids.coach, async (coach) => {
      // useMarkReviewed, the recommended date of the editor, useArchiveSession.
      expect((await coach(`update sessions set reviewed_at = now() where id = $1 and reviewed_at is null`, [session])).rowCount).toBe(1);
      await coach(`update sessions set scheduled_date = '2026-11-03' where id = $1`, [session]);
      await coach(`update sessions set archived_at = now() where id = $1`, [session]);
    });
    expect(await q.one(`select num_nonnulls(${FOUR}) as stamped from sessions where id = $1`, [session])).toEqual({ stamped: 4 });
    // And taken back: unarchived, the date removed.
    await asUser(ids.coach, (coach) => coach(`update sessions set archived_at = null, scheduled_date = null where id = $1`, [session]));
    expect(await q.one(`select num_nonnulls(${FOUR}) as stamped from sessions where id = $1`, [session])).toEqual({ stamped: 2 });
  }));

  it('a session whose week does not exist is left to the foreign key', () => scenario(async (q) => {
    const nowhere = await attempt(() => q(
      `insert into sessions (week_id, title, sort_order, reviewed_at) values (gen_random_uuid(), 'Nowhere', 0, now())`,
    ));
    expect(nowhere.error?.code).toBe('23503');
  }));

  // Row-level security is what it was: the author writes the sessions of
  // their DRAFT, and of nothing else.
  it('an athlete still writes no session of a program that is not their draft', () => scenario(async (q) => {
    const session = sessionsOfA()[0].id;
    const draftOfB = await createDraftProgram(ids.studentB);
    await asUser(ids.studentA, async (athlete) => {
      expect((await athlete(`update sessions set ${STAMPED}, title = 'Mine' where id = $1`, [session])).rowCount).toBe(0);
      expect((await athlete(`update sessions set title = 'Mine' where id = $1`, [draftOfB.sessions[0]])).rowCount).toBe(0);
    });
    expect(await four(q, session)).toEqual(EMPTY);
  }));

  // TWO REQUESTS AT ONCE. Everything above is one connection, where the
  // policy and the pin cannot disagree. They can when the coach approves
  // while a stamp of the author is on its way: the policy that lets the
  // author write the session ("Students author own draft sessions", through
  // the STABLE week_is_own_draft) judges the program as the STATEMENT saw it
  // when it started — a draft. A trigger function that is VOLATILE reads the
  // program again, as it is by the time the row is reached — approved — and
  // holds nothing: the stamp is written on an approved program, which is the
  // finding. pin_draft_session_columns is STABLE so that it reads what the
  // policy read.
  //
  // The stamp is made to wait at the row (another transaction holds it), the
  // approval is committed meanwhile, the row is let go. The athlete does not
  // need the third party: a few connections of theirs stamping the same
  // sessions wait for each other the same way, and before the function was
  // STABLE that stamped every session of the approved program, every time.
  it('a stamp on its way while the coach approves is judged as the policy judged it: the approved program starts without it', async () => {
    // Committed: three connections have to see it. Deleted at the end.
    const draft = await createDraftProgram(ids.studentA, { submitted: true });
    const [session] = draft.sessions;
    const lockWaits = () => asAdmin((q) => q.value(
      `select count(*) from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
    ));

    let letGo;
    const untilLetGo = new Promise((resolve) => { letGo = resolve; });
    let rowIsHeld;
    const held = new Promise((resolve) => { rowIsHeld = resolve; });
    // 1. Somebody holds the row, in a transaction that stays open.
    const holder = asAdmin(async (q) => {
      await q(`select id from sessions where id = $1 for update`, [session]);
      rowIsHeld();
      await untilLetGo;
    });
    let stamp;
    try {
      await Promise.race([held, holder]);

      // 2. The author's stamp: it starts — the program is a draft — and waits.
      let answered = false;
      stamp = asUser(ids.studentA, (author) => author.one(
        `update sessions set ${STAMPED} where id = $1 returning ${FOUR}`, [session],
      ), { commit: true }).finally(() => { answered = true; });
      // Read in step 4; a failure before that is not an unhandled one.
      stamp.catch(() => {});
      for (let tries = 0; await lockWaits() === 0; tries += 1) {
        if (tries === 500) throw new Error('the stamp never waited for the row');
        await new Promise((resolve) => { setTimeout(resolve, 10); });
      }

      // 3. The coach approves, and that is committed.
      expect(await asUser(ids.coach, (coach) => coach.value(`select public.approve_program($1)`, [draft.id]), { commit: true }))
        .toEqual({ approved: true, set_logs_created: 6 });
      expect(answered, 'the stamp was not on its way when the program was approved: nothing was tried').toBe(false);

      // 4. The row is let go, and the stamp goes on with what it had read.
      letGo();
      await holder;
      expect(await stamp).toEqual(EMPTY);
      await asAdmin(async (q) => {
        expect(await q.value(`select status from programs where id = $1`, [draft.id])).toBe('approved');
        expect(await four(q, session)).toEqual(EMPTY);
        expect(await stampedIn(q, draft.id)).toBe(0);
      });
    } finally {
      letGo();
      await Promise.allSettled([holder, stamp]);
      await asAdmin(async (q) => {
        await q(`delete from notifications where payload->>'program_id' = $1`, [draft.id]);
        await q(`delete from programs where id = $1`, [draft.id]);
      }, { commit: true });
    }
  });

  // KNOWN residual, the price of STABLE: the pin does not see a week that the
  // SAME statement creates (a data-modifying CTE) — it reads the database as
  // it was when the statement started, and so do the policies: for the author
  // and for the coach the session has no week yet, and the write is refused.
  // Only a caller that row-level security does not apply to gets such a
  // session in with a stamp. save_draft_tree writes the weeks, then the
  // sessions: two statements.
  it('a week and its session written in ONE statement: refused to the author and to the coach — the owner and the service role get the stamp in', () => scenario(async (q) => {
    const draft = await createDraftProgram(ids.studentA);
    const inOne = `with w as (insert into weeks (program_id, week_number) values ($1, $2) returning id)
                   insert into sessions (week_id, title, sort_order, reviewed_at) select id, 'In one', 0, now() from w
                   returning reviewed_at is not null as reviewed`;
    for (const writer of [ids.studentA, ids.coach]) {
      const tried = await attempt(() => asUser(writer, (user) => user(inOne, [draft.id, 2])));
      expect(tried.error?.code, writer.email).toBe('42501');
    }
    expect(await q.value(`select count(*) from weeks where program_id = $1`, [draft.id])).toBe(1);

    expect(await q.one(inOne, [draft.id, 2])).toEqual({ reviewed: true });
    expect(await asService((service) => service.one(inOne, [draft.id, 3]))).toEqual({ reviewed: true });
    expect(await stampedIn(q, draft.id)).toBe(2);
    // The next write of such a session clears it, like any other.
    await q(`update sessions set sort_order = 1 where title = 'In one'`);
    expect(await stampedIn(q, draft.id)).toBe(0);
  }));
});

// ============================================================
// B4 — a submission
// ============================================================
describe('a submission is made once (B4)', () => {
  const author = (fn) => asUser(ids.studentA, fn);
  const told = (q, programId) => q.value(
    `select count(*) from notifications
      where kind = 'program_submitted' and recipient_id = $1 and payload->>'program_id' = $2`,
    [ids.coach.id, programId],
  );
  const pushed = async () => (await httpCalls()).filter((call) => call.body.payload.title === 'Program submitted').length;
  const submittedAt = (q, programId) => q.value(`select submitted_at::text from programs where id = $1`, [programId]);

  it('the author cannot take a submission back and make it again: the coach is told once', () => scenario(async (q) => {
    await enablePush();
    const draft = await createDraftProgram(ids.studentA);
    await author((a) => a(`update programs set submitted_at = '2026-10-01 10:00:00+00' where id = $1`, [draft.id]));
    const first = await submittedAt(q, draft.id);
    expect(first).not.toBeNull();
    expect([await told(q, draft.id), await pushed()]).toEqual([1, 1]);

    for (let round = 0; round < 5; round += 1) {
      await author(async (a) => {
        // Accepted, and held.
        expect(await a.one(`update programs set submitted_at = null where id = $1 returning submitted_at is null as taken_back`, [draft.id]))
          .toEqual({ taken_back: false });
        await a(`update programs set submitted_at = now() where id = $1`, [draft.id]);
      });
    }
    expect(await submittedAt(q, draft.id)).toBe(first);
    expect([await told(q, draft.id), await pushed()]).toEqual([1, 1]);
  }));

  // src/hooks/useAuthoring.js, submit(): the stamp rides in the snapshot, and
  // every later save sends the snapshot again.
  it('the deployed app, as the author: a draft is submitted through save_draft_tree, and saved again it stays submitted', () => scenario(async (q) => {
    const uuid = () => q.value(`select gen_random_uuid()`);
    const [program, week, session] = [await uuid(), await uuid(), await uuid()];
    const save = (submitted_at, name = 'My block') => author((a) => a.value(`select public.save_draft_tree($1)`, [{
      program: { id: program, name, submitted_at },
      weeks: [{ id: week, program_id: program, week_number: 1, label: null }],
      sessions: [{ id: session, week_id: week, title: 'Pull', sort_order: 0 }],
      slots: [],
    }]));
    await save(null);
    expect([await submittedAt(q, program), await told(q, program)]).toEqual([null, 0]);

    await save('2026-10-01T10:00:00.000Z');
    const first = await submittedAt(q, program);
    expect(first).not.toBeNull();
    expect(await told(q, program)).toBe(1);

    // The same snapshot replayed, a later stamp, a snapshot without one.
    await save('2026-10-01T10:00:00.000Z');
    await save('2026-10-02T08:30:00.000Z', 'Renamed');
    await save(null);
    expect(await q.one(`select name, submitted_at::text as submitted_at from programs where id = $1`, [program]))
      .toEqual({ name: 'My block', submitted_at: first });
    expect(await told(q, program)).toBe(1);
  }));

  it('the coach sends it back, the author submits again, and the coach is told again — once', () => scenario(async (q) => {
    const draft = await createDraftProgram(ids.studentA);
    await author((a) => a(`update programs set submitted_at = now() where id = $1`, [draft.id]));
    expect(await told(q, draft.id)).toBe(1);

    expect(await asUser(ids.coach, (coach) => coach.value(`select public.send_back_program($1)`, [draft.id])))
      .toEqual({ sent_back: true });
    expect(await submittedAt(q, draft.id)).toBeNull();

    // Not submitted: the author may still leave it so, and then submit.
    await author((a) => a(`update programs set submitted_at = null, name = 'Reworked' where id = $1`, [draft.id]));
    expect(await told(q, draft.id)).toBe(1);
    await author((a) => a(`update programs set submitted_at = now() where id = $1`, [draft.id]));
    expect(await told(q, draft.id)).toBe(2);
    // …and that one is held like the first.
    await author(async (a) => {
      await a(`update programs set submitted_at = null where id = $1`, [draft.id]);
      await a(`update programs set submitted_at = now() where id = $1`, [draft.id]);
    });
    expect(await told(q, draft.id)).toBe(2);
    expect(await submittedAt(q, draft.id)).not.toBeNull();
  }));

  it('whoever is not the author is not held: the coach, the service role and the owner take a submission back', () => scenario(async (q) => {
    const draft = await createDraftProgram(ids.studentA, { submitted: true });
    const takeBack = `update programs set submitted_at = null where id = $1`;
    const submit = () => q(`update programs set submitted_at = now() where id = $1`, [draft.id]);

    await asUser(ids.coach, (coach) => coach(takeBack, [draft.id]));
    expect(await submittedAt(q, draft.id)).toBeNull();
    await submit();
    await asService((service) => service(takeBack, [draft.id]));
    expect(await submittedAt(q, draft.id)).toBeNull();
    await submit();
    await q(takeBack, [draft.id]);
    expect(await submittedAt(q, draft.id)).toBeNull();

    // approve_program clears it with the approval.
    await submit();
    await asUser(ids.coach, (coach) => coach.value(`select public.approve_program($1)`, [draft.id]));
    expect(await q.one(`select status, submitted_at from programs where id = $1`, [draft.id]))
      .toEqual({ status: 'approved', submitted_at: null });
  }));

  // KNOWN residual: the pin is on the draft. A draft discarded and written
  // again is another draft, and its submission is told like any first one
  // (src/hooks/useAuthoring.js: useDiscardDraft, then a new snapshot).
  it('a draft discarded and written again is a new submission: one notification per draft', () => scenario(async (q) => {
    const uuid = () => q.value(`select gen_random_uuid()`);
    const submitNew = async () => {
      const program = await uuid();
      await author((a) => a.value(`select public.save_draft_tree($1)`, [{
        program: { id: program, name: 'My block', submitted_at: '2026-10-01T10:00:00.000Z' }, weeks: [], sessions: [], slots: [],
      }]));
      return program;
    };
    const first = await submitNew();
    expect((await author((a) => a(`delete from programs where id = $1`, [first]))).rowCount).toBe(1);
    const second = await submitNew();
    expect([await told(q, first), await told(q, second)]).toEqual([1, 1]);
  }));

  it('what the author could not move before, they still cannot: status, approval, owner', () => scenario(async (q) => {
    const draft = await createDraftProgram(ids.studentA);
    await author((a) => a(
      `update programs set status = 'approved', approved_at = now(), created_by = $2, name = 'Renamed' where id = $1`,
      [draft.id, ids.studentB.id],
    ));
    expect(await q.one(`select status, approved_at, created_by, name from programs where id = $1`, [draft.id]))
      .toEqual({ status: 'draft', approved_at: null, created_by: ids.studentA.id, name: 'Renamed' });
  }));
});

// ============================================================
// The migration file, on production as it was frozen.
// ============================================================
describe('migration 06 applied to the production baseline', () => {
  const COACH = '00000000-0000-4000-8000-00000000c0ac';
  const ATHLETE = '00000000-0000-4000-8000-0000000000a1';
  const LINK = '00000000-0000-4000-8000-000000000101';
  const PULL_UP = '00000000-0000-4000-8000-000000000201';
  const PROGRAM = '00000000-0000-4000-8000-000000000301';
  const DRAFT = '00000000-0000-4000-8000-000000000302';
  const WEEK = '00000000-0000-4000-8000-000000000401';
  const DRAFT_WEEK = '00000000-0000-4000-8000-000000000402';
  const SESSION = '00000000-0000-4000-8000-000000000451';
  const DRAFT_SESSION = '00000000-0000-4000-8000-000000000452';
  const SLOT_1 = '00000000-0000-4000-8000-000000000501';
  const SLOT_2 = '00000000-0000-4000-8000-000000000502';
  const SET = '00000000-0000-4000-8000-000000000601';
  const TO_COME = '2099_01_01_99_a_migration_to_come';

  // A coach and their athlete; the block the athlete trains (one session, two
  // exercises of three sets); and a draft the athlete wrote and sent in. The
  // coach's role is set the way a dump restore sets it: on the baseline the
  // documented `update profiles set role = 'coach'` is undone for every
  // caller (finding P20, closed by migration 07).
  const WORLD = `
    insert into auth.users (id, email, aud, role, email_confirmed_at, raw_user_meta_data) values
      ('${COACH}',   'coach@sl.test', 'authenticated', 'authenticated', now(), '{"full_name": "Coach Carla"}'),
      ('${ATHLETE}', 'alex@sl.test',  'authenticated', 'authenticated', now(), '{"full_name": "Alex"}');
    BEGIN;
    SET LOCAL session_replication_role = replica;
    update public.profiles set role = 'coach' where id = '${COACH}';
    COMMIT;
    insert into public.students (id, profile_id, coach_id) values ('${LINK}', '${ATHLETE}', '${COACH}');
    insert into public.exercise_library (id, coach_id, name, type, difficulty)
      values ('${PULL_UP}', '${COACH}', 'Pull-up', 'pull', 2);

    insert into public.programs (id, student_id, name, is_active) values ('${PROGRAM}', '${LINK}', 'Block', true);
    insert into public.weeks (id, program_id, week_number) values ('${WEEK}', '${PROGRAM}', 1);
    insert into public.sessions (id, week_id, title, sort_order) values ('${SESSION}', '${WEEK}', 'S1', 0);
    insert into public.exercise_slots (id, session_id, exercise_id, sets, reps, weight_kg, sort_order) values
      ('${SLOT_1}', '${SESSION}', '${PULL_UP}', 3, 5, 20, 0),
      ('${SLOT_2}', '${SESSION}', '${PULL_UP}', 3, 5, 20, 1);
    insert into public.set_logs (id, exercise_slot_id, set_number, target_reps, target_weight_kg) values
      ('${SET}', '${SLOT_1}', 1, 5, 20);
    insert into public.set_logs (exercise_slot_id, set_number, target_reps, target_weight_kg)
      select slot, n, 5, 20
        from unnest(array['${SLOT_1}', '${SLOT_2}']::uuid[]) as slot, generate_series(1, 3) as n
       where (slot, n) <> ('${SLOT_1}'::uuid, 1);

    insert into public.programs (id, student_id, name, status, is_active, created_by, submitted_at)
      values ('${DRAFT}', '${LINK}', 'My block', 'draft', false, '${ATHLETE}', '2026-10-01 10:00+00');
    insert into public.weeks (id, program_id, week_number) values ('${DRAFT_WEEK}', '${DRAFT}', 1);
    insert into public.sessions (id, week_id, title, sort_order) values ('${DRAFT_SESSION}', '${DRAFT_WEEK}', 'D1', 0);
    insert into public.exercise_slots (session_id, exercise_id, sets, reps, sort_order)
      values ('${DRAFT_SESSION}', '${PULL_UP}', 2, 5, 0);
  `;

  /** The frozen baseline with that world in it and the migrations before 06 applied. */
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
  const user = (sub) => ({ role: 'authenticated', claims: { role: 'authenticated', sub } });
  const THE_COACH = user(COACH);
  const THE_ATHLETE = user(ATHLETE);
  const send = (db, { role, claims }, sql, end) => attempt(() => db.runSql(
    `BEGIN;
     select set_config('role', '${role}', true),
            set_config('request.jwt.claims', '${JSON.stringify(claims)}', true);
     ${sql};
     ${end};`,
    'request',
  ));
  // The answer of the last statement of the request: the one before the end
  // of the transaction.
  const answer = (tried) => {
    if (!tried.ok) return (tried.error.cause ?? tried.error).message;
    const [found] = tried.value.at(-2).rows;
    return found ? Object.values(found)[0] : null;
  };
  const request = async (db, actor, sql) => answer(await send(db, actor, sql, 'ROLLBACK'));
  /** The same, kept. */
  const committed = async (db, actor, sql) => answer(await send(db, actor, sql, 'COMMIT'));

  // The three findings, each as one request of the athlete.
  const markAsOwn = `update public.set_logs set is_student_added = true where id = '${SET}' returning is_student_added`;
  const renumber = `update public.set_logs set set_number = 9 where id = '${SET}' returning set_number`;
  const move = `update public.set_logs set exercise_slot_id = '${SLOT_2}', set_number = 9 where id = '${SET}' returning exercise_slot_id`;
  const stamp = `update public.sessions set reviewed_at = now(), archived_at = now(), performed_at = now(), scheduled_date = current_date
                  where id = '${DRAFT_SESSION}'
                  returning num_nonnulls(reviewed_at, archived_at, performed_at, scheduled_date)`;
  const insertStamped = `insert into public.sessions (week_id, title, sort_order, reviewed_at)
                         values ('${DRAFT_WEEK}', 'Already reviewed', 1, now()) returning reviewed_at is not null`;
  const takeBack = `update public.programs set submitted_at = null where id = '${DRAFT}' returning submitted_at is null`;

  // The runbook page, which is what the person applying the file reads.
  const page = read(migration.paths.runbook);
  // Its fenced blocks, without the indent of the list item they stand in.
  const fences = (lang) => [...page.matchAll(new RegExp(`^( *)\`\`\`${lang}\\n([\\s\\S]*?)\\n\\1\`\`\`$`, 'gm'))]
    .map(([, indent, body]) => body.split('\n').map((line) => line.slice(indent.length)).join('\n'));
  const commands = fences('bash');
  const [pageCheck] = commands
    .map((command) => /^supabase db query --linked '(do \$check\$[\s\S]+\$check\$)'$/.exec(command)?.[1])
    .filter(Boolean);
  // A statement the page gives in the text, between back-ticks.
  const inline = (start) => [...page.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]).find((code) => code.startsWith(start));

  const printedAudit = async (db) => {
    const [result] = await db.readOnly(read(migration.paths.audit), 'audit');
    return Object.fromEntries(result.rows.map((line) => [line.check, line.value]));
  };
  const LINE = {
    targets: 'an athlete\'s update leaves the targets of a set as they were',
    set: '… and its exercise, its number and whether it is an extra set (P14)',
    session: 'a session of a draft is kept without review, archive, training date and recommended date (P13)',
    approve: 'approving a draft clears those four columns on its sessions',
    submission: 'the author of a draft cannot take a submission back (B4)',
    callable: 'functions of this migration a signed-in user may execute',
    stale: 'sessions of a draft that carry a review, an archive, a training date or a recommended date',
    extras: 'sets marked as added by the athlete that carry a prescription',
    drafts: 'drafts',
  };

  it('the holes are there before, closed after, and back after the rollback', async () => {
    const db = await production();

    // Before: the three findings, as the review traced them.
    expect(await request(db, THE_ATHLETE, markAsOwn)).toBe(true);
    expect(await request(db, THE_ATHLETE, renumber)).toBe(9);
    expect(await request(db, THE_ATHLETE, move)).toBe(SLOT_2);
    expect(await request(db, THE_ATHLETE, stamp)).toBe(4);
    expect(await request(db, THE_ATHLETE, insertStamped)).toBe(true);
    expect(await request(db, THE_ATHLETE, takeBack)).toBe(true);

    await db.runFile(migration.paths.migration);

    expect(await request(db, THE_ATHLETE, markAsOwn)).toBe(false);
    expect(await request(db, THE_ATHLETE, renumber)).toBe(1);
    expect(await request(db, THE_ATHLETE, move)).toBe(SLOT_1);
    expect(await request(db, THE_ATHLETE, stamp)).toBe(0);
    expect(await request(db, THE_ATHLETE, insertStamped)).toBe(false);
    expect(await request(db, THE_ATHLETE, takeBack)).toBe(false);
    // The coach on the draft: accepted, not kept either.
    expect(await request(db, THE_COACH, stamp)).toBe(0);

    // The app that is deployed today, as the athlete and as the coach: as before.
    expect(await request(db, THE_ATHLETE, `update public.set_logs set done = true, rpe = 8, logged_at = now() where id = '${SET}' returning rpe`)).toBe(8);
    expect(await request(db, THE_ATHLETE, `insert into public.set_logs (exercise_slot_id, set_number, is_student_added, done, failed) values ('${SLOT_1}', 4, true, false, false) returning is_student_added`)).toBe(true);
    // Confirming a session still stamps the day it was trained.
    expect(await request(db, THE_ATHLETE,
      `insert into public.session_confirmations (session_id, student_id, performed_on) values ('${SESSION}', '${ATHLETE}', current_date - 1);
       select current_date - s.performed_at::date from public.sessions s where s.id = '${SESSION}'`)).toBe(1);
    expect(await request(db, THE_COACH, `update public.set_logs set set_number = 100001 where id = '${SET}' returning set_number`)).toBe(100001);
    expect(await request(db, THE_COACH, `update public.sessions set archived_at = now(), scheduled_date = '2026-11-02' where id = '${SESSION}' returning num_nonnulls(archived_at, scheduled_date)`)).toBe(2);
    expect(await request(db, THE_COACH, `select public.send_back_program('${DRAFT}')`)).toEqual({ sent_back: true });
    expect(await request(db, THE_COACH, `select public.approve_program('${DRAFT}')`)).toEqual({ approved: true, set_logs_created: 2 });
    // Nothing above was kept, and the migration itself touches no row.
    expect(await db.query.one(
      `select (select count(*) from public.set_logs) as sets, (select count(*) from public.sessions) as sessions,
              (select count(*) from public.session_confirmations) as confirmations,
              (select status from public.programs where id = '${DRAFT}') as draft,
              (select submitted_at is not null from public.programs where id = '${DRAFT}') as submitted`,
    )).toEqual({ sets: 6, sessions: 2, confirmations: 0, draft: 'draft', submitted: true });

    await db.runFile(migration.paths.rollback);
    expect(await request(db, THE_ATHLETE, markAsOwn)).toBe(true);
    expect(await request(db, THE_ATHLETE, renumber)).toBe(9);
    expect(await request(db, THE_ATHLETE, stamp)).toBe(4);
    expect(await request(db, THE_ATHLETE, takeBack)).toBe(true);
    await db.drop();
  });

  it('adds 1 function and 1 trigger, replaces 3 function bodies, signs the ledger — no table, no column, no policy, no privilege of what was there', async () => {
    const db = await production();
    const before = await catalogSnapshot(db.query);
    await db.runFile(migration.paths.migration);
    const after = await catalogSnapshot(db.query);

    const lines = diffCatalogs(before, after, { left: 'before', right: 'after' });
    const only = (side) => lines.filter((line) => line.endsWith(`: only in ${side}`))
      .map((line) => line.slice(0, -`: only in ${side}`.length));
    expect(only('after')).toEqual([
      'triggers public.sessions.trg_pin_draft_session_columns',
      'functions public.pin_draft_session_columns()',
    ]);
    expect(only('before')).toEqual([]);
    const changed = lines.filter((line) => !/: only in (before|after)$/.test(line))
      .map((line) => /^(.*?): (\w+): /.exec(line).slice(1, 3).join(' → '));
    expect(changed).toEqual([
      'functions public.approve_program(p_program_id uuid) → definition',
      'functions public.pin_program_authoring_columns() → definition',
      'functions public.pin_set_log_targets_for_student() → definition',
      'data rows of app_private.app_migrations → rows',
    ]);

    // Who may execute the four is what it was — and, for the new one, nobody
    // but its owner and the service role.
    const APPROVE = 'public.approve_program(p_program_id uuid)';
    const KEYS = [APPROVE, 'public.pin_program_authoring_columns()',
      'public.pin_set_log_targets_for_student()', 'public.pin_draft_session_columns()'];
    for (const key of KEYS) {
      expect(after.functions[key].privileges, key).toEqual(key === APPROVE
        ? ['authenticated: EXECUTE', 'postgres: EXECUTE', 'service_role: EXECUTE']
        : ['postgres: EXECUTE', 'service_role: EXECUTE']);
      if (before.functions[key]) expect(before.functions[key].privileges, key).toEqual(after.functions[key].privileges);
      expect(after.functions[key].owner, key).toBe('postgres');
      expect(after.functions[key].definition, key).toContain(`\n SET search_path TO 'public', 'pg_temp'\n`);
      expect(after.functions[key].definition, key).toContain('SECURITY DEFINER');
    }
    // The pin on sessions reads the program as the policy does: STABLE. The
    // three others are what they were (VOLATILE, which is not printed).
    expect(KEYS.filter((key) => /\n STABLE /.test(after.functions[key].definition)))
      .toEqual(['public.pin_draft_session_columns()']);
    // The two triggers that were there are the ones from before, enabled.
    for (const key of ['public.set_logs.trg_pin_set_log_targets_for_student', 'public.programs.trg_pin_program_authoring_columns']) {
      expect(after.triggers[key], key).toEqual(before.triggers[key]);
    }
    await db.drop();
  });

  // The runbook page tells the person applying the file what the audit prints
  // before and after. This is that table, read off the page.
  it('its audit prints the "before" and "after" columns of the runbook page', async () => {
    const db = await production();
    const audit = read(migration.paths.audit);
    const printed = async () => {
      const [result] = await db.readOnly(audit, 'audit');
      return result.rows.map((line) => [line.check, line.value]);
    };
    const rows = page.split('\n')
      .map((line) => /^\| (\d+) \| (.+?) \| (.+?) \| (.+?) \|$/.exec(line))
      .filter(Boolean)
      .map(([, n, check, before, after]) => ({ n: Number(n), check, before, after }));
    expect(rows.map((line) => line.n)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    // Written between back-ticks: a value the page gives exactly. The other
    // one is a sentence about production's drafts.
    const exact = rows.filter((line) => /^`.+`$/.test(line.before) && /^`.+`$/.test(line.after))
      .map((line) => ({ ...line, before: line.before.slice(1, -1), after: line.after.slice(1, -1) }));
    expect(rows.filter((line) => !exact.some((e) => e.n === line.n)).map((line) => line.check)).toEqual([LINE.drafts]);
    const onPage = (column) => [
      ...exact.map((line) => [line.n, line.check, line[column]]),
      [12, LINE.drafts, '1 draft(s), 1 of them sent in to the coach'],
    ].sort((a, b) => a[0] - b[0]).map(([, check, value]) => [check, value]);

    expect(await printed()).toEqual(onPage('before'));
    await db.runFile(migration.paths.migration);
    expect(await printed()).toEqual(onPage('after'));
    // …and the header of the audit file says the same.
    const header = audit.split('\n').filter((line) => line.startsWith('--')).join('\n');
    for (const { check, before, after } of exact) {
      expect(header, check).toContain(check);
      expect(header).toContain(before);
      expect(header).toContain(after);
    }
    await db.drop();
  });

  // Lines 10 and 11 of the audit: what the holes, or a coach working on a
  // draft, may have left. The migration starts all the same and changes none.
  it('a draft that already carries the columns, and a set marked as the athlete\'s own: counted, left alone, cleared by approval', async () => {
    const db = await production();
    // The findings, done: as the athlete, and kept.
    expect(await committed(db, THE_ATHLETE, stamp)).toBe(4);
    expect(await committed(db, THE_ATHLETE, insertStamped)).toBe(true);
    expect(await committed(db, THE_ATHLETE, markAsOwn)).toBe(true);
    const LEFT = {
      [LINE.stale]: '2 in 1 draft(s) (2 reviewed, 1 archived, 1 with a training date, 1 with a recommended date)',
      [LINE.extras]: '1 in 1 exercise(s)',
      [LINE.drafts]: '1 draft(s), 1 of them sent in to the coach',
    };
    expect(await printedAudit(db)).toMatchObject(LEFT);

    await db.runFile(migration.paths.migration);
    expect(await printedAudit(db)).toMatchObject({ ...LEFT, [LINE.session]: 'in place', [LINE.set]: 'yes' });
    // What the page says of line 11: the migration leaves the set — and the
    // athlete, who could delete it before, still can: it IS an extra set now.
    expect(page).toContain('The migration cannot tell which, and leaves them.');
    expect(await request(db, THE_ATHLETE, `delete from public.set_logs where id = '${SET}' returning is_student_added`)).toBe(true);

    // What the page says of line 10: cleared as soon as the session is next
    // written, and when the draft is approved.
    expect(page).toContain('they are cleared when the draft is approved, and as soon as that session is next written');
    expect(await committed(db, THE_ATHLETE, `update public.sessions set title = 'D1 again' where id = '${DRAFT_SESSION}' returning title`)).toBe('D1 again');
    expect((await printedAudit(db))[LINE.stale]).toBe('1 in 1 draft(s) (1 reviewed, 0 archived, 0 with a training date, 0 with a recommended date)');
    expect(await committed(db, THE_COACH, `select public.approve_program('${DRAFT}')`)).toEqual({ approved: true, set_logs_created: 2 });
    expect(await printedAudit(db)).toMatchObject({ [LINE.stale]: '0', [LINE.drafts]: '0 draft(s), 0 of them sent in to the coach' });
    expect(await db.query.value(
      `select count(*) from public.sessions s join public.weeks w on w.id = s.week_id
        where w.program_id = '${DRAFT}' and num_nonnulls(s.reviewed_at, s.archived_at, s.performed_at, s.scheduled_date) = 0`,
    )).toBe(2);
    await db.drop();
  });

  it('the page\'s check answers NOT PROTECTED before, protected after, NOT TRIED when the athlete\'s update reaches no row — and writes nothing', async () => {
    const db = await production();
    expect(pageCheck, 'the page no longer gives the check').toBeTruthy();
    // Pasted between single quotes in a shell: it may not hold one.
    expect(pageCheck).not.toContain("'");
    const checked = async () => {
      const tried = await attempt(() => db.runSql(pageCheck, 'page check'));
      expect(tried.ok, 'the check must always fail: that is what undoes it').toBe(false);
      return (tried.error.cause ?? tried.error).message;
    };
    const state = () => db.query.one(
      `select (select count(*) from public.set_logs where is_student_added) as marked, current_user::text as role,
              coalesce(current_setting('request.jwt.claims', true), '') as claims`,
    );

    expect(await checked()).toBe('check only, nothing was written: NOT PROTECTED: the prescribed set is now marked as added by the athlete');
    expect(await state()).toEqual({ marked: 0, role: 'postgres', claims: '' });

    await db.runFile(migration.paths.migration);
    expect(await checked()).toBe('check only, nothing was written: protected: the set is still a prescribed one');
    expect(await state()).toEqual({ marked: 0, role: 'postgres', claims: '' });
    // What the page says the command prints.
    expect(page).toContain('`check only, nothing was written: protected: the set is still a prescribed one`');
    expect(page).toContain('`… NOT PROTECTED: the prescribed set is now marked as added by the athlete`');

    // A rule of later that keeps the athlete from updating the set that is
    // picked — here, their UPDATE policy gone. The check has then asked the
    // pin nothing, and says that: with the pin and, after the rollback,
    // without it — where the unchanged row would read as "protected".
    const NOT_TRIED = 'check only, nothing was written: NOT TRIED: the update of the athlete matched no row';
    await db.query(`drop policy "Students update own set logs" on public.set_logs`);
    expect(await checked()).toBe(NOT_TRIED);
    await db.runFile(migration.paths.rollback);
    expect((await printedAudit(db))[LINE.set]).toBe('no');
    expect(await checked()).toBe(NOT_TRIED);
    expect(await state()).toEqual({ marked: 0, role: 'postgres', claims: '' });
    expect(page).toContain('`… NOT TRIED: the update of the athlete matched no row`');

    // With no block being trained there is nothing to try, and it says so.
    await db.query(`update public.programs set is_active = false`);
    expect(await checked()).toBe('check only: no athlete has a prescribed set in a session in progress of an active program, nothing to try');
    await db.drop();
  });

  // "Correcting one of these columns by hand": the statement the page gives
  // for a submission, and what it says of the two others.
  it('from the SQL editor: the page\'s statements take a submission back and make a set a prescribed one again; a session of a draft is not dated', async () => {
    const db = await production();
    await db.runFile(migration.paths.migration);
    const unsubmit = inline('update public.programs set submitted_at = null');
    expect(unsubmit, 'the page no longer gives the statement').toBe(
      `update public.programs set submitted_at = null where id = '<id of the draft>'`,
    );
    expect((await db.query(unsubmit.replace('<id of the draft>', DRAFT))).rowCount).toBe(1);
    expect(await db.query.one(`select submitted_at, status from public.programs where id = '${DRAFT}'`))
      .toEqual({ submitted_at: null, status: 'draft' });
    // "without the notification to the athlete"
    expect(await db.query.value(`select count(*) from public.notifications`)).toBe(0);

    // A set of line 11 of the audit, made a prescribed one again.
    await db.query(`update public.set_logs set set_number = 7, is_student_added = true where id = '${SET}'`);
    expect((await printedAudit(db))[LINE.extras]).toBe('1 in 1 exercise(s)');
    const prescribeAgain = inline('update public.set_logs set is_student_added = false');
    expect(prescribeAgain, 'the page no longer gives the statement').toBe(
      `update public.set_logs set is_student_added = false where id = '<id of the set>'`,
    );
    expect((await db.query(prescribeAgain.replace('<id of the set>', SET))).rowCount).toBe(1);
    expect(await db.query.one(`select set_number, is_student_added from public.set_logs where id = '${SET}'`))
      .toEqual({ set_number: 7, is_student_added: false });
    expect((await printedAudit(db))[LINE.extras]).toBe('0');

    await db.query(`update public.sessions set scheduled_date = '2026-11-02' where id in ('${SESSION}', '${DRAFT_SESSION}')`);
    expect(await db.query.rows(`select title, scheduled_date from public.sessions order by title`)).toEqual([
      { title: 'D1', scheduled_date: null },
      { title: 'S1', scheduled_date: '2026-11-02' },
    ]);
    await db.drop();
  });

  it('without migration 05 it says so (SLM02), and its rollback says there is nothing to undo (SLM03)', async () => {
    const db = await scratchDatabase();
    await db.runFile(manifest.baseline);
    const refusals = async () => {
      const before = await catalogSnapshot(db.query);
      const refused = await attempt(() => db.runFile(migration.paths.migration));
      const undone = await attempt(() => db.runFile(migration.paths.rollback));
      expect(diffCatalogs(before, await catalogSnapshot(db.query), { left: 'before', right: 'after' })).toEqual([]);
      return [refused.error?.code, refused.error?.message, undone.error?.code];
    };
    // Without a ledger at all, then with the ledger and the migrations before 05 only.
    const needs = 'needs 2026_10_11_05_students_role_gate, which is not applied';
    let [code, message, undone] = await refusals();
    expect([code, undone]).toEqual([REFUSAL.predecessorMissing, REFUSAL.notApplied]);
    expect(message).toContain(needs);
    for (const earlier of manifest.migrations.slice(0, 4)) await db.runFile(earlier.paths.migration);
    [code, message, undone] = await refusals();
    expect([code, undone]).toEqual([REFUSAL.predecessorMissing, REFUSAL.notApplied]);
    expect(message).toContain(needs);
    await db.drop();
  });

  it('refuses to run as another role than postgres', async () => {
    const db = await production();
    const before = await catalogSnapshot(db.query);
    const text = read(migration.paths.migration);
    const asServiceRole = text.replace(`SET LOCAL lock_timeout = '5s';`, `SET LOCAL lock_timeout = '5s';\nSET LOCAL ROLE service_role;`);
    expect(asServiceRole).not.toBe(text);
    const refused = await attempt(() => db.runSql(asServiceRole, 'migration'));
    expect(refused.error?.message).toContain(`migration ${MIGRATION} must be run as postgres, not as service_role`);
    expect(await db.query.value(`select current_user::text`)).toBe('postgres');
    expect(diffCatalogs(before, await catalogSnapshot(db.query), { left: 'before', right: 'after' })).toEqual([]);
    await db.drop();
  });

  it('refuses to run when one of its functions exists with other arguments, and changes nothing', async () => {
    const db = await production();
    const refusal = async () => {
      const before = await catalogSnapshot(db.query);
      const refused = await attempt(() => db.runFile(migration.paths.migration));
      expect(diffCatalogs(before, await catalogSnapshot(db.query), { left: 'before', right: 'after' })).toEqual([]);
      expect(await db.query.value(`select count(*) from ${LEDGER} where name = $1`, [MIGRATION])).toBe(0);
      return refused.error?.message ?? 'it ran';
    };
    // An approve_program made by hand, with a second argument: it would keep
    // the body that leaves a pre-filled review in place.
    await db.query(`create function public.approve_program(p_program_id uuid, p_note text) returns jsonb language sql as 'select null::jsonb'`);
    expect(await refusal()).toContain(`migration ${MIGRATION} would not replace: approve_program(uuid,text)`);
    await db.query(`drop function public.approve_program(uuid, text)`);

    // Whoever runs it, and with whatever search_path: the names are compared by oid.
    const text = read(migration.paths.migration);
    const elsewhere = text.replace(`SET LOCAL lock_timeout = '5s';`, `SET LOCAL lock_timeout = '5s';\nSET LOCAL search_path = pg_catalog;`);
    expect(elsewhere).not.toBe(text);
    await db.runSql(elsewhere, 'migration');
    expect(await db.query.value(`select count(*) from ${LEDGER} where name = $1`, [MIGRATION])).toBe(1);
    // …and applied that way, it is the same database as applied the usual way.
    const other = await production();
    await other.runFile(migration.paths.migration);
    expect(diffCatalogs(await catalogSnapshot(other.query), await catalogSnapshot(db.query), { left: 'usual', right: 'pg_catalog' }))
      .toEqual([]);
    await other.drop();
    await db.drop();
  });

  // A grant that `postgres` did not make is one its REVOKE does not remove.
  it('undoes itself when one of its functions would stay open to a request without a session', async () => {
    const db = await production();
    await db.runSql(
      `BEGIN;
       create function public.pin_draft_session_columns() returns trigger language plpgsql as 'begin return new; end';
       grant execute on function public.pin_draft_session_columns() to service_role with grant option;
       set local role service_role;
       grant execute on function public.pin_draft_session_columns() to anon;
       COMMIT;`,
      'a function made by hand, opened by another role',
    );
    const before = await catalogSnapshot(db.query);
    const refused = await attempt(() => db.runFile(migration.paths.migration));
    expect(refused.error?.message).toContain(
      `migration ${MIGRATION} did not get the functions it meant: public.pin_draft_session_columns(): anon may execute it`,
    );
    expect(diffCatalogs(before, await catalogSnapshot(db.query), { left: 'before', right: 'after' })).toEqual([]);
    expect(await db.query.value(`select count(*) from ${LEDGER} where name = $1`, [MIGRATION])).toBe(0);
    await db.drop();
  });

  // Line 2 of the audit, and what the page says of it: "the migration puts
  // it back".
  it('the pin on the targets, dropped or switched off by hand, reads "missing" — and the migration puts it back', async () => {
    for (const byHand of [
      `drop trigger trg_pin_set_log_targets_for_student on public.set_logs`,
      `alter table public.set_logs disable trigger trg_pin_set_log_targets_for_student`,
    ]) {
      const db = await production();
      await db.query(byHand);
      expect(await printedAudit(db), byHand).toMatchObject({ [LINE.targets]: 'missing', [LINE.set]: 'no' });
      expect(await request(db, THE_ATHLETE, `update public.set_logs set target_reps = 99 where id = '${SET}' returning target_reps`)).toBe(99);

      await db.runFile(migration.paths.migration);
      expect(await printedAudit(db), byHand).toMatchObject({ [LINE.targets]: 'in place', [LINE.set]: 'yes' });
      expect(await request(db, THE_ATHLETE, `update public.set_logs set target_reps = 99 where id = '${SET}' returning target_reps`)).toBe(5);
      await db.drop();
    }
    expect(page).toContain('was dropped or switched off by hand; the migration puts it back');
  });

  it('a pin that is there and switched off is not "in place" for the audit', async () => {
    const db = await production();
    await db.runFile(migration.paths.migration);
    await db.query(`alter table public.sessions disable trigger trg_pin_draft_session_columns`);
    await db.query(`alter table public.programs disable trigger trg_pin_program_authoring_columns`);
    expect(await printedAudit(db)).toMatchObject({
      [LINE.targets]: 'in place',
      [LINE.set]: 'yes',
      [LINE.session]: 'missing',
      [LINE.approve]: 'yes',
      [LINE.submission]: 'no',
      [LINE.callable]: 'approve_program(uuid)',
    });
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
    expect(await request(db, THE_ATHLETE, markAsOwn)).toBe(false);
    await db.drop();
  });
});
