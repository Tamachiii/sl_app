// Logged training cannot be deleted or rewritten below the session — review
// findings P3 and P17, closed by migration 2026_10_11_04_logged_history_guards.
//
// "Logged training can never be hard-deleted" was enforced on programs, weeks
// and sessions. Below them the coach's session editor deleted sets the athlete
// had done (the × on a set, a lower "Sets", "Remove exercise") and rewrote the
// targets of done sets; adopt_swap / adopt_skip counted a failed or rated set,
// a video and a comment as "not trained". Since the migration:
//
//   a logged set          set_log_is_logged(): done, failed, skipped, an RPE or
//                         an actual — one definition, read by everything below
//   deleting one          refused on set_logs, and on every table above it —
//                         a set with a video counts too; cascades included
//   lowering "Sets"       refused when a logged prescribed set is above the count
//   editing its targets   silently kept, for a signed-in user
//   adopt_swap/adopt_skip leave alone a slot with a logged set, a video, a comment
//   the way through       SET LOCAL app.allow_history_delete = 'on', read only
//                         when the statement comes with no user id
//
// The first blocks run against schema.sql, as the callers the app has. The
// writes of the app that is DEPLOYED today are replayed statement by statement
// (src/hooks/useSession.js): the migration is applied while that app is live.
// The last block applies the migration file itself to the frozen production
// baseline, with the checks of its runbook page read off the page.

import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  asAdmin, asService, asUser, attempt, createDraftProgram, createProgram, repoRoot, scenario,
  scratchDatabase, seed,
} from './harness.js';
import { catalogSnapshot, diffCatalogs } from './catalog.js';
import { LEDGER, loadManifest, REFUSAL } from '../migrations/manifest.js';

const MIGRATION = '2026_10_11_04_logged_history_guards';
const manifest = loadManifest();
const migration = manifest.migrations.find((m) => m.name === MIGRATION);
const read = (file) => fs.readFileSync(path.join(repoRoot, file), 'utf8');

let ids;
beforeAll(async () => {
  ids = await seed();
});

// Block A of athlete A: 2 weeks × 2 sessions, each session a pull-up slot and
// a dip slot, 3 sets × 5 reps @ 20 kg each.
const sessions = () => ids.programA.tree.flatMap((week) => week.sessions);
const pullUp = (n) => sessions()[n].slots[0];   // { id, exerciseId, setLogs: [id × 3] }
const dip = (n) => sessions()[n].slots[1];

// What an athlete does to a set, as the app writes it (src/lib/offlineMutations.js).
const WAYS = {
  done: `done = true, logged_at = now()`,
  failed: `failed = true, failed_at = now()`,
  skipped: `skipped = true`,
  'an RPE alone': `rpe = 7`,
  'actual reps alone': `actual_reps = 4`,
  'an actual load alone': `actual_weight_kg = 22.5`,
};
const athleteLogs = (setLog, way = 'done') => asUser(ids.studentA, (athlete) => athlete(
  `update set_logs set ${WAYS[way]} where id = $1`, [setLog],
));
const athleteFilms = (slot, n = 0) => asUser(ids.studentA, (athlete) => athlete(
  `insert into set_log_videos (set_log_id, storage_path, mime_type, size_bytes) values ($1, $2, 'video/mp4', 1000)`,
  [slot.setLogs[n], `${ids.studentA.id}/${slot.id}/${n + 1}-clip.mp4`],
));
const athleteComments = (slot) => asUser(ids.studentA, (athlete) => athlete(
  `insert into slot_comments (exercise_slot_id, student_id, body) values ($1, $2, 'Felt heavy')`,
  [slot.id, ids.studentA.id],
));
const athleteAddsExtraSet = (slot, { done = true } = {}) => asUser(ids.studentA, (athlete) => athlete.value(
  `insert into set_logs (exercise_slot_id, set_number, is_student_added, done, logged_at)
   values ($1, 4, true, $2, case when $2 then now() end) returning id`,
  [slot.id, done],
));

const coachTries = (sql, params) => attempt(() => asUser(ids.coach, (coach) => coach(sql, params)));

// How many rows there are of everything a delete could take along.
const everything = (q) => q.one(
  `select (select count(*) from programs)       as programs,
          (select count(*) from weeks)          as weeks,
          (select count(*) from sessions)       as sessions,
          (select count(*) from exercise_slots) as slots,
          (select count(*) from set_logs)       as set_logs,
          (select count(*) from set_log_videos) as videos,
          (select count(*) from slot_comments)  as comments,
          (select count(*) from students)       as students,
          (select count(*) from profiles)       as profiles`,
);

// The three sentences the new guards speak. Each contains 'logged set', which
// is all the deployed app looks for before it shows "archive it instead".
const SET_REFUSED = (slot, n) => `set ${n} of exercise slot ${slot.id} is a logged set — it cannot be deleted`;
const SLOT_REFUSED = (slot, count) => `exercise slot ${slot.id} still has ${count} logged set(s) — archive the session instead of deleting the exercise`;
const SETS_REFUSED = (slot, count, sets) => `exercise slot ${slot.id} has ${count} logged set(s) above set ${sets} — the set count cannot go below them`;

// What the app that is DEPLOYED does with the error of a write
// (src/lib/mutationErrors.js, as production runs it): message, details and
// hint in lower case, and whatever contains 'logged set' becomes the toast
// errors.hasLoggedTraining — "This has logged training — archive it instead of
// deleting." Restated here: that code is live, and a guard must speak to it.
const toastOf = (error) => (
  `${error.message || ''} ${error.detail || ''} ${error.hint || ''}`.toLowerCase().includes('logged set')
    ? 'errors.hasLoggedTraining'
    : 'another toast'
);

// ============================================================
// One definition
// ============================================================
describe('a logged set', () => {
  const isLogged = (q, setLog) => q.value(
    `select public.set_log_is_logged(sl) from set_logs sl where sl.id = $1`, [setLog],
  );

  it.each(Object.keys(WAYS))('%s makes a set logged, and the coach can no longer delete it', (way) => scenario(async (q) => {
    const slot = pullUp(0);
    expect(await isLogged(q, slot.setLogs[0])).toBe(false);
    await athleteLogs(slot.setLogs[0], way);
    expect(await isLogged(q, slot.setLogs[0])).toBe(true);

    const removal = await coachTries(`delete from set_logs where id = $1`, [slot.setLogs[0]]);
    expect(removal.error?.message).toBe(SET_REFUSED(slot, 1));
    expect(removal.error.code).toBe('P0001');
    expect(removal.error.message).toMatch(/logged set/);
    expect(toastOf(removal.error)).toBe('errors.hasLoggedTraining');
    expect(await q.value(`select count(*) from set_logs where exercise_slot_id = $1`, [slot.id])).toBe(3);
  }));

  it('a set that only carries a video is not "logged", and is kept all the same', () => scenario(async (q) => {
    const slot = pullUp(0);
    await athleteFilms(slot);
    expect(await isLogged(q, slot.setLogs[0])).toBe(false);

    const removal = await coachTries(`delete from set_logs where id = $1`, [slot.setLogs[0]]);
    expect(removal.error?.message).toBe(SET_REFUSED(slot, 1));
    expect(await q.one(`select (select count(*) from set_logs where id = $1) as set, (select count(*) from set_log_videos) as videos`, [slot.setLogs[0]]))
      .toEqual({ set: 1, videos: 1 });
  }));

  it('targets, a rest time and a timestamp do not make a set logged', () => scenario(async (q) => {
    const [setLog] = pullUp(0).setLogs;
    await q(`update set_logs set target_reps = 8, target_weight_kg = 40, target_rest_seconds = 90, logged_at = now() where id = $1`, [setLog]);
    expect(await isLogged(q, setLog)).toBe(false);
    expect((await asUser(ids.coach, (coach) => coach(`delete from set_logs where id = $1`, [setLog]))).rowCount).toBe(1);
  }));

  // The predicate takes the row type of the table. The migrations to come
  // change that table (a column added, RPE in half steps, a dead column
  // dropped): none of it may be held up by the function, or break it.
  it('set_logs can still be altered under the function, and the function follows', () => scenario(async (q) => {
    const slot = pullUp(0);
    await athleteLogs(slot.setLogs[0], 'an RPE alone');
    await q(`alter table public.set_logs add column target_rpe numeric(3,1)`);
    await q(`alter table public.set_logs alter column rpe type numeric(3,1)`);
    await q(`alter table public.set_logs drop column weight_kg`);
    expect(await q.rows(
      `select sl.set_number, public.set_log_is_logged(sl) as logged from set_logs sl where sl.exercise_slot_id = $1 order by 1`,
      [slot.id],
    )).toEqual([{ set_number: 1, logged: true }, { set_number: 2, logged: false }, { set_number: 3, logged: false }]);
    const removal = await coachTries(`delete from set_logs where exercise_slot_id = $1`, [slot.id]);
    expect(removal.error?.message).toBe(SET_REFUSED(slot, 1));
  }));
});

// ============================================================
// Deleting
// ============================================================
describe('logged training cannot be deleted, at any level', () => {
  it('the coach cannot delete an exercise that has a logged set — nor its comment, its other sets, its video', () => scenario(async (q) => {
    const slot = pullUp(0);
    await athleteLogs(slot.setLogs[1], 'failed');
    await athleteFilms(slot, 2);
    await athleteComments(slot);
    const before = await everything(q);

    const removal = await coachTries(`delete from exercise_slots where id = $1`, [slot.id]);
    expect(removal.error?.message).toBe(SLOT_REFUSED(slot, 2));   // the failed set, and the filmed one
    expect(toastOf(removal.error)).toBe('errors.hasLoggedTraining');
    expect(await everything(q)).toEqual(before);
  }));

  it('…and a video alone holds the exercise, the session, the phase and the program', () => scenario(async (q) => {
    const slot = dip(0);
    await athleteFilms(slot);
    const before = await everything(q);

    for (const [table, id, said] of [
      ['exercise_slots', slot.id, SLOT_REFUSED(slot, 1)],
      ['sessions', ids.programA.sessions[0], `session ${ids.programA.sessions[0]} still has 1 logged set(s) — archive it instead of deleting`],
      ['weeks', ids.programA.weeks[0], `week ${ids.programA.weeks[0]} still has 1 logged set(s) — archive it instead of deleting`],
      ['programs', ids.programA.id, `program ${ids.programA.id} still has 1 logged set(s) — move it to the trash instead of deleting`],
    ]) {
      const removal = await coachTries(`delete from ${table} where id = $1`, [id]);
      expect(removal.error?.message, table).toBe(said);
      expect(toastOf(removal.error), table).toBe('errors.hasLoggedTraining');
    }
    expect(await everything(q)).toEqual(before);
  }));

  // A row trigger fires on a cascade too. From the top of the tree, as the
  // callers that have no RLS in their way.
  it('a students row, a profile or an account with logged training cannot be deleted either', () => scenario(async (q) => {
    await athleteLogs(pullUp(0).setLogs[0]);
    const before = await everything(q);
    const refused = `program ${ids.programA.id} still has 1 logged set(s) — move it to the trash instead of deleting`;

    for (const [who, as] of [['the service role', asService], ['postgres', asAdmin]]) {
      const students = await attempt(() => as((caller) => caller(`delete from students where id = $1`, [ids.studentA.studentRowId])));
      expect(students.error?.message, who).toBe(refused);
      const profile = await attempt(() => as((caller) => caller(`delete from profiles where id = $1`, [ids.studentA.id])));
      expect(profile.error?.message, who).toBe(refused);
    }
    const account = await attempt(() => q(`delete from auth.users where id = $1`, [ids.studentA.id]));
    expect(account.error?.message).toBe(refused);
    expect(await everything(q)).toEqual(before);

    // Athlete B has trained nothing: the same deletes go through.
    expect((await q(`delete from auth.users where id = $1`, [ids.studentB.id])).rowCount).toBe(1);
    expect(await everything(q)).toEqual({
      ...before, programs: 1, weeks: 2, sessions: 4, slots: 8, set_logs: 24, students: 1, profiles: 2,
    });
  }));

  // The guard on set_logs is the net under the four above it. Proved by
  // switching those off: whatever starts the cascade, the row itself refuses.
  it('the guard on set_logs alone stops every cascade that reaches a logged set', () => scenario(async (q) => {
    const slot = pullUp(0);
    await athleteLogs(slot.setLogs[2], 'skipped');
    for (const [table, trigger] of [
      ['programs', 'block_program_delete_with_logged_sets'],
      ['weeks', 'block_week_delete_with_logged_sets'],
      ['sessions', 'block_session_delete_with_logged_sets'],
      ['exercise_slots', 'block_slot_delete_with_logged_sets'],
    ]) await q(`alter table public.${table} disable trigger ${trigger}`);
    const before = await everything(q);

    for (const [table, id] of [
      ['exercise_slots', slot.id],
      ['sessions', ids.programA.sessions[0]],
      ['weeks', ids.programA.weeks[0]],
      ['programs', ids.programA.id],
    ]) {
      const removal = await coachTries(`delete from ${table} where id = $1`, [id]);
      expect(removal.error?.message, table).toBe(SET_REFUSED(slot, 3));
    }
    for (const [table, id] of [
      ['students', ids.studentA.studentRowId],
      ['profiles', ids.studentA.id],
      ['auth.users', ids.studentA.id],
    ]) {
      const removal = await attempt(() => q(`delete from ${table} where id = $1`, [id]));
      expect(removal.error?.message, table).toBe(SET_REFUSED(slot, 3));
    }
    expect(await everything(q)).toEqual(before);
  }));

  it('an athlete cannot delete a prescribed set, logged or not; another athlete cannot delete anything', () => scenario(async (q) => {
    const slot = pullUp(0);
    await athleteLogs(slot.setLogs[0]);
    const extra = await athleteAddsExtraSet(slot);
    for (const athlete of [ids.studentA, ids.studentB]) {
      // RLS, before any trigger: the rows are not theirs to delete.
      const removed = await asUser(athlete, (user) => user(`delete from set_logs where id = any($1)`, [slot.setLogs]));
      expect(removed.rowCount).toBe(0);
    }
    expect((await asUser(ids.studentB, (other) => other(`delete from set_logs where id = $1`, [extra]))).rowCount).toBe(0);
    expect(await q.value(`select count(*) from set_logs where exercise_slot_id = $1`, [slot.id])).toBe(4);
  }));
});

// ============================================================
// The athlete's own extra set
// ============================================================
describe('an extra set belongs to the athlete who added it', () => {
  it('the athlete removes it again, done and filmed', () => scenario(async (q) => {
    const slot = pullUp(0);
    const extra = await athleteAddsExtraSet(slot);
    await asUser(ids.studentA, (athlete) => athlete(
      `insert into set_log_videos (set_log_id, storage_path, mime_type, size_bytes) values ($1, 'a/b/4-clip.mp4', 'video/mp4', 1000)`,
      [extra],
    ));
    // The write of useRemoveStudentSet.
    const removed = await asUser(ids.studentA, (athlete) => athlete(
      `delete from set_logs where id = $1 and is_student_added = true`, [extra],
    ));
    expect(removed.rowCount).toBe(1);
    expect(await q.one(`select (select count(*) from set_logs where exercise_slot_id = $1) as sets, (select count(*) from set_log_videos) as videos`, [slot.id]))
      .toEqual({ sets: 3, videos: 0 });
  }));

  it('the coach does not: a done extra set is training like any other', () => scenario(async (q) => {
    const slot = pullUp(0);
    const extra = await athleteAddsExtraSet(slot);
    const removal = await coachTries(`delete from set_logs where id = $1`, [extra]);
    expect(removal.error?.message).toBe(SET_REFUSED(slot, 4));
    // …and it holds the exercise, although it is not part of the prescription.
    expect((await coachTries(`delete from exercise_slots where id = $1`, [slot.id])).error?.message).toBe(SLOT_REFUSED(slot, 1));
    expect(await q.value(`select count(*) from set_logs where id = $1`, [extra])).toBe(1);
  }));

  // The exception asks who the slot belongs to. In a cascade the slot is
  // already deleted when its sets are reached, so the question has no answer
  // and the exception does not apply. No policy lets an athlete delete a slot
  // of an approved program; one is added here, and the guard on the slot is
  // switched off, to reach the line.
  it('the exception is for the set, deleted by itself: it does not let a cascade through', () => scenario(async (q) => {
    const slot = pullUp(0);
    const extra = await athleteAddsExtraSet(slot);
    await q(`create policy "athletes delete slots (test)" on public.exercise_slots for delete to authenticated using (true)`);
    await q(`alter table public.exercise_slots disable trigger block_slot_delete_with_logged_sets`);

    const cascade = await attempt(() => asUser(ids.studentA, (athlete) => athlete(
      `delete from exercise_slots where id = $1`, [slot.id],
    )));
    expect(cascade.error?.message).toBe(SET_REFUSED(slot, 4));
    expect(await q.value(`select count(*) from set_logs where exercise_slot_id = $1`, [slot.id])).toBe(4);
    // By itself, the same athlete removes the same set.
    expect((await asUser(ids.studentA, (athlete) => athlete(`delete from set_logs where id = $1`, [extra]))).rowCount).toBe(1);
  }));

  it('one that was added and never done is scaffolding: the coach removes the exercise with it', () => scenario(async (q) => {
    const slot = pullUp(0);
    await athleteAddsExtraSet(slot, { done: false });
    expect((await asUser(ids.coach, (coach) => coach(`delete from exercise_slots where id = $1`, [slot.id]))).rowCount).toBe(1);
    expect(await q.value(`select count(*) from set_logs where exercise_slot_id = $1`, [slot.id])).toBe(0);
  }));
});

// ============================================================
// The app that is deployed today, statement by statement
// ============================================================
describe('the writes of the deployed session editor', () => {
  // Five sets instead of three, as the coach who prescribed them.
  const fiveSets = (slot) => asUser(ids.coach, async (coach) => {
    await coach(`update exercise_slots set sets = 5 where id = $1`, [slot.id]);
    const rows = await coach.rows(
      `insert into set_logs (exercise_slot_id, set_number, target_reps, target_weight_kg, target_rest_seconds)
       select $1, n, 5, 20, 120 from generate_series(4, 5) as n returning id, set_number`,
      [slot.id],
    );
    return [...slot.setLogs, ...rows.sort((a, b) => a.set_number - b.set_number).map((row) => row.id)];
  });
  const shape = (q, slot) => q.one(
    `select es.sets,
            (select string_agg(sl.set_number || case when sl.done then '✓' else '' end, ' ' order by sl.set_number)
               from set_logs sl where sl.exercise_slot_id = es.id) as rows
       from exercise_slots es where es.id = $1`,
    [slot.id],
  );

  // useUpdateSlot: exercise_slots.sets first (useSession.js:236), then
  // reconcileSetLogCount deletes the prescribed rows numbered above it (:181).
  it('"Sets" 5 → 3 over a logged set 4: refused on the FIRST write, and nothing has changed', () => scenario(async (q) => {
    const slot = pullUp(0);
    const logs = await fiveSets(slot);
    await athleteLogs(logs[3]);
    expect(await shape(q, slot)).toEqual({ sets: 5, rows: '1 2 3 4✓ 5' });

    const first = await coachTries(
      `update exercise_slots set sets = 3 where id = $1 returning *`, [slot.id],
    );
    expect(first.error?.message).toBe(SETS_REFUSED(slot, 1, 3));
    expect(first.error.code).toBe('P0001');
    expect(toastOf(first.error)).toBe('errors.hasLoggedTraining');
    // The app stops there: its mutation function throws on the first error.
    expect(await shape(q, slot)).toEqual({ sets: 5, rows: '1 2 3 4✓ 5' });

    // Had it gone on, the delete would have been refused as well — after the
    // count was already wrong. That is why the guard is on the count.
    const second = await coachTries(`delete from set_logs where id = any($1)`, [logs.slice(3)]);
    expect(second.error?.message).toBe(SET_REFUSED(slot, 4));
  }));

  it('"Sets" 5 → 4 next to that logged set: both writes go through', () => scenario(async (q) => {
    const slot = pullUp(0);
    const logs = await fiveSets(slot);
    await athleteLogs(logs[3]);
    await asUser(ids.coach, async (coach) => {
      expect((await coach(`update exercise_slots set sets = 4 where id = $1 returning *`, [slot.id])).rowCount).toBe(1);
      expect((await coach(`delete from set_logs where id = any($1)`, [logs.slice(4)])).rowCount).toBe(1);
    });
    expect(await shape(q, slot)).toEqual({ sets: 4, rows: '1 2 3 4✓' });
  }));

  it('the count goes up, and any other column of the exercise is written, whatever is logged', () => scenario(async (q) => {
    const slot = pullUp(0);
    for (const setLog of slot.setLogs) await athleteLogs(setLog);
    await asUser(ids.coach, async (coach) => {
      await coach(`update exercise_slots set sets = 4, notes = 'Slow negatives', sort_order = 3 where id = $1`, [slot.id]);
      // The same number again, in a payload that names the column: not "lower".
      await coach(`update exercise_slots set sets = 4, rest_seconds = 90 where id = $1`, [slot.id]);
    });
    expect(await q.one(`select sets, notes, rest_seconds from exercise_slots where id = $1`, [slot.id]))
      .toEqual({ sets: 4, notes: 'Slow negatives', rest_seconds: 90 });
  }));

  it('an athlete\'s extra set is not part of the count: "Sets" goes below it', () => scenario(async (q) => {
    const slot = pullUp(0);
    await athleteAddsExtraSet(slot);
    await asUser(ids.coach, async (coach) => {
      await coach(`update exercise_slots set sets = 2 where id = $1`, [slot.id]);
      await coach(`delete from set_logs where id = $1`, [slot.setLogs[2]]);
      // The extra set is moved down behind the prescription: parked, then placed.
      await coach(`update set_logs set set_number = 100004 where exercise_slot_id = $1 and is_student_added`, [slot.id]);
      await coach(`update set_logs set set_number = 3 where exercise_slot_id = $1 and is_student_added`, [slot.id]);
    });
    expect(await shape(q, slot)).toEqual({ sets: 2, rows: '1 2 3✓' });
  }));

  // useRemoveSet: the delete by (slot, set number) comes first (:306).
  it('× on a logged set: refused on the first write, nothing has changed', () => scenario(async (q) => {
    const slot = pullUp(0);
    await athleteLogs(slot.setLogs[1]);
    const removal = await coachTries(
      `delete from set_logs where exercise_slot_id = $1 and set_number = 2`, [slot.id],
    );
    expect(removal.error?.message).toBe(SET_REFUSED(slot, 2));
    expect(toastOf(removal.error)).toBe('errors.hasLoggedTraining');
    expect(await shape(q, slot)).toEqual({ sets: 3, rows: '1 2✓ 3' });
  }));

  it('× on a set nobody did, below a logged one: the whole sequence goes through and the logged set moves down', () => scenario(async (q) => {
    const slot = pullUp(0);
    await athleteLogs(slot.setLogs[2]);
    await asUser(ids.coach, async (coach) => {
      await coach(`delete from set_logs where exercise_slot_id = $1 and set_number = 2`, [slot.id]);
      await coach(`update set_logs set set_number = 100003 where id = $1`, [slot.setLogs[2]]);   // park
      await coach(`update set_logs set set_number = 2 where id = $1`, [slot.setLogs[2]]);        // place
      await coach(`update exercise_slots set sets = 2, record_video_set_numbers = '{}' where id = $1`, [slot.id]);
    });
    expect(await shape(q, slot)).toEqual({ sets: 2, rows: '1 2✓' });
  }));

  // useDeleteSlot.
  it('"Remove exercise" on an exercise with a logged set: refused', () => scenario(async (q) => {
    const slot = pullUp(0);
    await athleteLogs(slot.setLogs[0]);
    const removal = await coachTries(`delete from exercise_slots where id = $1`, [slot.id]);
    expect(removal.error?.message).toBe(SLOT_REFUSED(slot, 1));
    expect(await shape(q, slot)).toEqual({ sets: 3, rows: '1✓ 2 3' });
  }));

  // fanOutTargetUpdate (:130): one UPDATE for every prescribed set of the slot.
  it('reps and load edited on a half-trained exercise: no error, the logged sets keep their numbers', () => scenario(async (q) => {
    const slot = pullUp(0);
    await athleteLogs(slot.setLogs[0]);
    await athleteLogs(slot.setLogs[1], 'failed');
    await athleteAddsExtraSet(slot);

    await asUser(ids.coach, async (coach) => {
      await coach(`update exercise_slots set reps = 8, weight_kg = 30, rest_seconds = 90 where id = $1 returning *`, [slot.id]);
      const fanOut = await coach(
        `update set_logs set target_reps = 8, target_weight_kg = 30, target_rest_seconds = 90
          where exercise_slot_id = $1 and is_student_added = false`,
        [slot.id],
      );
      expect(fanOut.rowCount).toBe(3);   // every row "written": the app sees no failure
    });
    expect(await q.rows(
      `select set_number, done, failed, target_reps, target_weight_kg, target_rest_seconds
         from set_logs where exercise_slot_id = $1 order by 1`,
      [slot.id],
    )).toEqual([
      { set_number: 1, done: true, failed: false, target_reps: 5, target_weight_kg: 20, target_rest_seconds: 120 },
      { set_number: 2, done: false, failed: true, target_reps: 5, target_weight_kg: 20, target_rest_seconds: 120 },
      { set_number: 3, done: false, failed: false, target_reps: 8, target_weight_kg: 30, target_rest_seconds: 90 },
      { set_number: 4, done: true, failed: false, target_reps: null, target_weight_kg: null, target_rest_seconds: null },
    ]);
  }));
});

// ============================================================
// The targets of a logged set
// ============================================================
describe('the targets of a logged set stay what they were', () => {
  const targets = (q, setLog) => q.one(
    `select target_reps, target_duration_seconds, target_weight_kg, target_rest_seconds from set_logs where id = $1`,
    [setLog],
  );
  const PRESCRIBED = { target_reps: 5, target_duration_seconds: null, target_weight_kg: 20, target_rest_seconds: 120 };
  // Each of the four, on its own: reps and duration exclude each other.
  const EDITS = [
    [`target_reps = 12`, { target_reps: 12 }],
    [`target_reps = null, target_duration_seconds = 45`, { target_reps: null, target_duration_seconds: 45 }],
    [`target_weight_kg = 55.5`, { target_weight_kg: 55.5 }],
    [`target_rest_seconds = 30`, { target_rest_seconds: 30 }],
  ];

  it.each(Object.keys(WAYS))('for the coach, once the set is logged — %s', (way) => scenario(async (q) => {
    const [logged, pending] = pullUp(0).setLogs;
    await athleteLogs(logged, way);
    for (const [edit, written] of EDITS) {
      // useUpdateSetTarget: one row, by id. It answers as if it had written.
      const one = await asUser(ids.coach, (coach) => coach(`update set_logs set ${edit} where id = $1`, [logged]));
      expect(one.rowCount, edit).toBe(1);
      expect(await targets(q, logged), edit).toEqual(PRESCRIBED);

      await asUser(ids.coach, (coach) => coach(`update set_logs set ${edit} where id = $1`, [pending]));
      expect(await targets(q, pending), edit).toEqual({ ...PRESCRIBED, ...written });
      await q(`update set_logs set target_reps = 5, target_duration_seconds = null, target_weight_kg = 20, target_rest_seconds = 120 where id = $1`, [pending]);
    }
  }));

  it('a set the athlete un-ticks is the coach\'s to edit again', () => scenario(async (q) => {
    const [setLog] = pullUp(0).setLogs;
    await athleteLogs(setLog);
    // patchForDone(false) of the app.
    await asUser(ids.studentA, (athlete) => athlete(
      `update set_logs set done = false, rpe = null, logged_at = null where id = $1`, [setLog],
    ));
    await asUser(ids.coach, (coach) => coach(`update set_logs set target_reps = 8 where id = $1`, [setLog]));
    expect((await targets(q, setLog)).target_reps).toBe(8);
  }));

  it('what the coach writes besides the targets goes through on a logged set', () => scenario(async (q) => {
    const [setLog] = pullUp(0).setLogs;
    await athleteLogs(setLog);
    await asUser(ids.coach, (coach) => coach(
      `update set_logs set set_number = 7, target_reps = 12 where id = $1`, [setLog],
    ));
    expect(await q.one(`select set_number, target_reps, done from set_logs where id = $1`, [setLog]))
      .toEqual({ set_number: 7, target_reps: 5, done: true });
  }));

  it('the athlete was pinned already, on every set, and still is', () => scenario(async (q) => {
    const [logged, pending] = pullUp(0).setLogs;
    await athleteLogs(logged);
    await asUser(ids.studentA, (athlete) => athlete(
      `update set_logs set target_reps = 99, target_weight_kg = 1 where id = any($1)`, [[logged, pending]],
    ));
    expect(await targets(q, logged)).toEqual(PRESCRIBED);
    expect(await targets(q, pending)).toEqual(PRESCRIBED);
  }));

  // A correction made on purpose, from the SQL editor or with the service-role
  // key: the pin is for a signed-in user.
  it('a statement without a user id corrects the targets of a logged set', () => scenario(async (q) => {
    const [first, second] = pullUp(0).setLogs;
    await athleteLogs(first);
    await athleteLogs(second);
    await q(`update set_logs set target_reps = 6 where id = $1`, [first]);
    await asService((service) => service(`update set_logs set target_weight_kg = 25 where id = $1`, [second]));
    expect(await targets(q, first)).toEqual({ ...PRESCRIBED, target_reps: 6 });
    expect(await targets(q, second)).toEqual({ ...PRESCRIBED, target_weight_kg: 25 });
  }));
});

// ============================================================
// What nobody trained
// ============================================================
describe('scaffolding is deleted and replaced as before', () => {
  it('the coach deletes a set, an exercise, a session and a phase nobody trained — comment and deviation included', () => scenario(async (q) => {
    const before = await everything(q);
    // The athlete left a note and a skip on exercises of session 4, and trained nothing.
    await athleteComments(pullUp(3));
    await asUser(ids.studentA, (athlete) => athlete(
      `insert into slot_deviations (exercise_slot_id, student_id, kind) values ($1, $2, 'skip')`, [dip(3).id, ids.studentA.id],
    ));
    await asUser(ids.coach, async (coach) => {
      expect((await coach(`delete from set_logs where id = $1`, [pullUp(0).setLogs[2]])).rowCount).toBe(1);
      expect((await coach(`delete from exercise_slots where id = $1`, [pullUp(3).id])).rowCount).toBe(1);
      expect((await coach(`delete from exercise_slots where id = $1`, [dip(3).id])).rowCount).toBe(1);
      expect((await coach(`delete from sessions where id = $1`, [ids.programA.sessions[2]])).rowCount).toBe(1);
      expect((await coach(`delete from weeks where id = $1`, [ids.programA.weeks[1]])).rowCount).toBe(1);
    });
    expect(await everything(q)).toEqual({
      ...before, weeks: before.weeks - 1, sessions: before.sessions - 2, slots: before.slots - 4, set_logs: before.set_logs - 13,
    });
    expect(await q.value(`select (select count(*) from slot_comments) + (select count(*) from slot_deviations)`)).toBe(0);
  }));

  // useHardDeleteProgram: from the trash, and only what holds no logged set.
  it('the coach empties the trash of a block nobody trained', () => scenario(async (q) => {
    const old = await createProgram({ student: ids.studentA, name: 'Never started' });
    const before = await everything(q);
    await asUser(ids.coach, async (coach) => {
      await coach(`update programs set deleted_at = now() where id = $1`, [old.id]);
      const removed = await coach(`delete from programs where id = $1 and deleted_at is not null`, [old.id]);
      expect(removed.rowCount).toBe(1);
    });
    expect(await everything(q)).toEqual({
      ...before, programs: before.programs - 1, weeks: before.weeks - 1, sessions: before.sessions - 1,
      slots: before.slots - 2, set_logs: before.set_logs - 6,
    });
  }));

  // save_draft_tree replaces the whole tree of a draft on every save: a DELETE
  // of its weeks, which cascades through sessions and slots — past every guard.
  it('an athlete saves a draft, saves it again with another tree, and discards it', () => scenario(async (q) => {
    const uuid = () => q.value(`select gen_random_uuid()`);
    const [program, week, s1, s2, e1, e2, e3] = [
      await uuid(), await uuid(), await uuid(), await uuid(), await uuid(), await uuid(), await uuid(),
    ];
    const tree = (slots) => ({
      program: { id: program, name: 'My block' },
      weeks: [{ id: week, week_number: 1 }],
      sessions: [{ id: s1, week_id: week, title: 'Pull', sort_order: 0 }, { id: s2, week_id: week, title: 'Push', sort_order: 1 }],
      slots,
    });
    const slot = (id, session, exercise) => ({ id, session_id: session, exercise_id: exercise, sets: 3, reps: 5, sort_order: 0 });
    const save = (slots) => asUser(ids.studentB, (athlete) => athlete.value(`select public.save_draft_tree($1)`, [tree(slots)]));
    const { pullUp: pull, dip: push, squat } = ids.exercises;

    expect(await save([slot(e1, s1, pull), slot(e2, s2, push)])).toEqual({ program_id: program, weeks: 1, sessions: 2, slots: 2 });
    // The same snapshot again (a replay), then one exercise swapped for another.
    expect(await save([slot(e1, s1, pull), slot(e2, s2, push)])).toEqual({ program_id: program, weeks: 1, sessions: 2, slots: 2 });
    expect(await save([slot(e1, s1, pull), slot(e3, s2, squat)])).toEqual({ program_id: program, weeks: 1, sessions: 2, slots: 2 });
    expect((await q.rows(
      `select es.exercise_id from exercise_slots es join sessions s on s.id = es.session_id where s.week_id = $1 order by s.sort_order`,
      [week],
    )).map((row) => row.exercise_id)).toEqual([pull, squat]);

    // discardDraft of the app.
    expect((await asUser(ids.studentB, (athlete) => athlete(`delete from programs where id = $1`, [program]))).rowCount).toBe(1);
    expect(await q.value(`select count(*) from weeks where id = $1`, [week])).toBe(0);
  }));

  it('a draft the coach approved gets its sets, and is deleted whole while nobody has trained it', () => scenario(async (q) => {
    const draft = await createDraftProgram(ids.studentA, { submitted: true });
    await asUser(ids.coach, (coach) => coach(`select public.approve_program($1)`, [draft.id]));
    expect(await q.value(
      `select count(*) from set_logs sl join exercise_slots es on es.id = sl.exercise_slot_id where es.session_id = $1`,
      [draft.sessions[0]],
    )).toBe(6);
    expect((await asUser(ids.coach, (coach) => coach(`delete from programs where id = $1`, [draft.id]))).rowCount).toBe(1);
  }));
});

// ============================================================
// The way through
// ============================================================
describe('app.allow_history_delete', () => {
  const ON = `set local app.allow_history_delete = 'on'`;

  it.each([
    ['postgres, in the SQL editor', asAdmin],
    ['the service role', asService],
  ])('%s: refused without the setting, through with it — at each level', (_, as) => scenario(async (q) => {
    // One logged set in each of the four sessions, and an extra set.
    for (const n of [0, 1, 2, 3]) await athleteLogs(pullUp(n).setLogs[2]);
    const extra = await athleteAddsExtraSet(dip(0));
    const before = await everything(q);

    const deletes = [
      [`delete from set_logs where id = $1`, [pullUp(0).setLogs[2]], SET_REFUSED(pullUp(0), 3)],
      [`delete from set_logs where id = $1`, [extra], SET_REFUSED(dip(0), 4)],
      [`update exercise_slots set sets = 2 where id = $1`, [pullUp(1).id], SETS_REFUSED(pullUp(1), 1, 2)],
      [`delete from exercise_slots where id = $1`, [pullUp(1).id], SLOT_REFUSED(pullUp(1), 1)],
      [`delete from sessions where id = $1`, [ids.programA.sessions[1]], /^session .* still has 1 logged set/],
      [`delete from weeks where id = $1`, [ids.programA.weeks[1]], /^week .* still has 2 logged set/],
      [`delete from programs where id = $1`, [ids.programA.id], /^program .* still has 5 logged set/],
    ];
    for (const [sql, params, said] of deletes) {
      const refused = await attempt(() => as((caller) => caller(sql, params)));
      if (typeof said === 'string') expect(refused.error?.message, sql).toBe(said);
      else expect(refused.error?.message, sql).toMatch(said);
    }
    expect(await everything(q)).toEqual(before);

    // The same statements, in the same order, in a transaction that said so.
    await as(async (caller) => {
      await caller(ON);
      for (const [sql, params] of deletes) expect((await caller(sql, params)).rowCount, sql).toBe(1);
    });
    expect(await everything(q)).toEqual({ ...before, programs: 1, weeks: 1, sessions: 1, slots: 2, set_logs: 6 });
  }));

  it('does nothing for a signed-in user, coach or athlete, in a transaction where it is on', () => scenario(async (q) => {
    const slot = pullUp(0);
    await athleteLogs(slot.setLogs[2]);
    const before = await everything(q);

    await q(ON);
    expect(await q.value(`select public.history_delete_allowed()`)).toBe(true);
    // A signed-in user cannot ask the question — and were they allowed to, the answer is no.
    for (const user of [ids.coach, ids.studentA]) {
      const asked = await attempt(() => asUser(user, (caller) => caller.value(`select public.history_delete_allowed()`)));
      expect(asked.error?.message).toBe('permission denied for function history_delete_allowed');
      await q(`grant execute on function public.history_delete_allowed() to authenticated`);
      expect(await asUser(user, (caller) => caller.value(`select public.history_delete_allowed()`))).toBe(false);
      await q(`revoke execute on function public.history_delete_allowed() from authenticated`);
    }

    for (const [sql, params, said] of [
      [`delete from set_logs where id = $1`, [slot.setLogs[2]], SET_REFUSED(slot, 3)],
      [`update exercise_slots set sets = 2 where id = $1`, [slot.id], SETS_REFUSED(slot, 1, 2)],
      [`delete from exercise_slots where id = $1`, [slot.id], SLOT_REFUSED(slot, 1)],
      [`delete from sessions where id = $1`, [ids.programA.sessions[0]], /^session .* still has 1 logged set/],
      [`delete from weeks where id = $1`, [ids.programA.weeks[0]], /^week .* still has 1 logged set/],
      [`delete from programs where id = $1`, [ids.programA.id], /^program .* still has 1 logged set/],
    ]) {
      // The coach, who says it once more themselves, for good measure.
      const refused = await attempt(() => asUser(ids.coach, async (coach) => {
        await coach(ON);
        return coach(sql, params);
      }));
      if (typeof said === 'string') expect(refused.error?.message, sql).toBe(said);
      else expect(refused.error?.message, sql).toMatch(said);
    }
    // The athlete: a prescribed set is not theirs to delete in the first place.
    expect((await asUser(ids.studentA, (athlete) => athlete(`delete from set_logs where id = $1`, [slot.setLogs[2]]))).rowCount).toBe(0);
    expect(await everything(q)).toEqual(before);
    expect(await q.one(
      `select es.sets, sl.done from set_logs sl join exercise_slots es on es.id = sl.exercise_slot_id where sl.id = $1`,
      [slot.setLogs[2]],
    )).toEqual({ sets: 3, done: true });
  }));

  it.each(['off', 'true', '1', 'ON', ''])('only the value \'on\' opens it — not %j', (value) => scenario(async (q) => {
    const slot = pullUp(0);
    await athleteLogs(slot.setLogs[0]);
    await q(`select set_config('app.allow_history_delete', $1, true)`, [value]);
    expect(await q.value(`select public.history_delete_allowed()`)).toBe(false);
    const refused = await attempt(() => q(`delete from set_logs where id = $1`, [slot.setLogs[0]]));
    expect(refused.error?.message).toBe(SET_REFUSED(slot, 1));
  }));

  // The clean-up after an end-to-end run on the test athlete (the plan's
  // "After-E2E"): the run leaves a logged extra set behind, and the athlete's
  // session is locked by then, so it is removed by SQL.
  it('the clean-up of an end-to-end run: a logged extra set, deleted by SQL', () => scenario(async (q) => {
    const slot = pullUp(0);
    const extra = await athleteAddsExtraSet(slot);
    const cleanup = `delete from public.set_logs where id = $1 and is_student_added`;

    expect((await attempt(() => q(cleanup, [extra]))).error?.message).toBe(SET_REFUSED(slot, 4));
    await q(ON);
    expect((await q(cleanup, [extra])).rowCount).toBe(1);
    expect(await q.value(`select count(*) from set_logs where exercise_slot_id = $1`, [slot.id])).toBe(3);
  }));
});

// ============================================================
// P17
// ============================================================
describe('adopt_swap and adopt_skip leave alone what the athlete has touched (P17)', () => {
  // The pull-up slot of session 1 is the one under review; the same exercise
  // comes back in sessions 2, 3 and 4.
  const coach = (sql, params) => asUser(ids.coach, (user) => user.value(sql, params));
  const dryRuns = async () => ({
    swap: await coach(`select public.adopt_swap($1, $2, true)`, [pullUp(0).id, ids.exercises.squat]),
    skip: await coach(`select public.adopt_skip($1, true)`, [pullUp(0).id]),
  });
  const counted = (applied) => ({
    swap: { applied, dry_run: true },
    skip: { applied, dry_run: true },
  });
  const TOUCHES = {
    'a failed set': () => athleteLogs(pullUp(1).setLogs[0], 'failed'),
    'a set that was only rated': () => athleteLogs(pullUp(1).setLogs[0], 'an RPE alone'),
    'a done set': () => athleteLogs(pullUp(1).setLogs[0]),
    'a skipped set': () => athleteLogs(pullUp(1).setLogs[0], 'skipped'),
    'an actual': () => athleteLogs(pullUp(1).setLogs[0], 'an actual load alone'),
    'a video on a set': () => athleteFilms(pullUp(1), 1),
    'a comment': () => athleteComments(pullUp(1)),
  };

  it('control: with nothing touched, both count the three sessions to come', () => scenario(async () => {
    expect(await dryRuns()).toEqual(counted(3));
  }));

  it.each(Object.keys(TOUCHES))('%s in the next session keeps its exercise out of both', (touch) => scenario(async (q) => {
    await TOUCHES[touch]();
    expect(await dryRuns()).toEqual(counted(2));

    // adopt_swap: the touched slot stays a pull-up.
    expect(await coach(`select public.adopt_swap($1, $2)`, [pullUp(0).id, ids.exercises.squat]))
      .toEqual({ applied: 2, dry_run: false });
    expect((await q.rows(
      `select es.exercise_id from exercise_slots es where es.id = any($1) order by array_position($1, es.id)`,
      [[0, 1, 2, 3].map((n) => pullUp(n).id)],
    )).map((row) => row.exercise_id)).toEqual([
      ids.exercises.pullUp, ids.exercises.pullUp, ids.exercises.squat, ids.exercises.squat,
    ]);
  }));

  it.each(Object.keys(TOUCHES))('%s is still there after a skip is adopted', (touch) => scenario(async (q) => {
    await TOUCHES[touch]();
    const before = await everything(q);
    expect(await coach(`select public.adopt_skip($1)`, [pullUp(0).id])).toEqual({ applied: 2, dry_run: false });
    expect(await everything(q)).toEqual({ ...before, slots: before.slots - 2, set_logs: before.set_logs - 6 });
    expect(await q.value(`select count(*) from set_logs where exercise_slot_id = $1`, [pullUp(1).id])).toBe(3);
  }));

  // What it deletes is what it counted, and none of that is held by a guard:
  // the DELETE inside it never meets a refusal.
  it('adopt_skip never raises: with every session to come touched, it removes nothing', () => scenario(async (q) => {
    await athleteLogs(pullUp(1).setLogs[0], 'failed');
    await athleteComments(pullUp(2));
    await athleteFilms(pullUp(3));
    const before = await everything(q);

    expect(await dryRuns()).toEqual(counted(0));
    expect(await coach(`select public.adopt_skip($1)`, [pullUp(0).id])).toEqual({ applied: 0, dry_run: false });
    expect(await coach(`select public.adopt_swap($1, $2)`, [pullUp(0).id, ids.exercises.squat])).toEqual({ applied: 0, dry_run: false });
    expect(await everything(q)).toEqual(before);
    // Nothing was adopted: the athlete is told nothing.
    expect(await q.value(`select count(*) from notifications where kind in ('skip_adopted', 'swap_adopted')`)).toBe(0);
  }));
});

// ============================================================
// The migration file, on production as it was frozen
// ============================================================
describe('migration 04 applied to the production baseline', () => {
  const COACH = '00000000-0000-4000-8000-00000000c0ac';
  const ATHLETE = '00000000-0000-4000-8000-0000000000a1';
  const PROGRAM = '00000000-0000-4000-8000-000000000301';
  const SESSION_1 = '00000000-0000-4000-8000-000000000451';
  const SLOT_1 = '00000000-0000-4000-8000-000000000501';
  const SLOT_2 = '00000000-0000-4000-8000-000000000502';
  const set = (slot, n) => `00000000-0000-4000-8000-0000000006${slot}${n}`;
  const TO_COME = '2099_01_01_99_a_migration_to_come';

  // A coach, an athlete, a block of two sessions with the same exercise.
  // Session 1: sets 1 and 3 done. Session 2: set 1 failed.
  const WORLD = `
    insert into auth.users (id, email, aud, role, email_confirmed_at, raw_user_meta_data) values
      ('${COACH}',   'coach@sl.test', 'authenticated', 'authenticated', now(), '{"full_name": "Coach"}'),
      ('${ATHLETE}', 'alex@sl.test',  'authenticated', 'authenticated', now(), '{"full_name": "Alex"}');
    insert into public.students (id, profile_id, coach_id)
      values ('00000000-0000-4000-8000-000000000101', '${ATHLETE}', '${COACH}');
    insert into public.exercise_library (id, coach_id, name, type, difficulty)
      values ('00000000-0000-4000-8000-000000000201', '${COACH}', 'Pull-up', 'pull', 2);
    insert into public.programs (id, student_id, name, is_active)
      values ('${PROGRAM}', '00000000-0000-4000-8000-000000000101', 'Block', true);
    insert into public.weeks (id, program_id, week_number)
      values ('00000000-0000-4000-8000-000000000401', '${PROGRAM}', 1);
    insert into public.sessions (id, week_id, title, sort_order) values
      ('${SESSION_1}', '00000000-0000-4000-8000-000000000401', 'S1', 0),
      ('00000000-0000-4000-8000-000000000452', '00000000-0000-4000-8000-000000000401', 'S2', 1);
    insert into public.exercise_slots (id, session_id, exercise_id, sets, reps, sort_order) values
      ('${SLOT_1}', '${SESSION_1}', '00000000-0000-4000-8000-000000000201', 3, 5, 0),
      ('${SLOT_2}', '00000000-0000-4000-8000-000000000452', '00000000-0000-4000-8000-000000000201', 3, 5, 0);
    insert into public.set_logs (id, exercise_slot_id, set_number, target_reps, done, failed, rpe) values
      ('${set(1, 1)}', '${SLOT_1}', 1, 5, true,  false, 8),
      ('${set(1, 2)}', '${SLOT_1}', 2, 5, false, false, null),
      ('${set(1, 3)}', '${SLOT_1}', 3, 5, true,  false, null),
      ('${set(2, 1)}', '${SLOT_2}', 1, 5, false, true,  null),
      ('${set(2, 2)}', '${SLOT_2}', 2, 5, false, false, null),
      ('${set(2, 3)}', '${SLOT_2}', 3, 5, false, false, null);
  `;

  /** The frozen baseline with that world in it and the migrations before 04 applied. */
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
  const THE_COACH = { role: 'authenticated', claims: { role: 'authenticated', sub: COACH } };
  const THE_ATHLETE = { role: 'authenticated', claims: { role: 'authenticated', sub: ATHLETE } };
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
  // The four writes of the deployed editor, and the count adopt_skip announces.
  const removeSet = `delete from public.set_logs where exercise_slot_id = '${SLOT_1}' and set_number = 1 returning set_number`;
  const lowerSets = `update public.exercise_slots set sets = 2 where id = '${SLOT_1}' returning sets`;
  const removeExercise = `delete from public.exercise_slots where id = '${SLOT_1}' returning sets`;
  const editReps = `with written as (
      update public.set_logs set target_reps = 8 where exercise_slot_id = '${SLOT_1}' and is_student_added = false
      returning set_number, target_reps)
    select string_agg(set_number || '×' || target_reps, ' ' order by set_number) from written`;
  const adoptSkip = `select public.adopt_skip('${SLOT_1}', true)`;

  // The runbook page, which is what the person applying the file reads.
  const page = read(migration.paths.runbook);
  // Its fenced blocks, without the indent of the list item they stand in.
  const fences = (lang) => [...page.matchAll(new RegExp(`^( *)\`\`\`${lang}\\n([\\s\\S]*?)\\n\\1\`\`\`$`, 'gm'))]
    .map(([, indent, body]) => body.split('\n').map((line) => line.slice(indent.length)).join('\n'));
  const [pageCheck] = fences('bash')
    .map((command) => /^supabase db query --linked '(do \$check\$[\s\S]+\$check\$)'$/.exec(command)?.[1])
    .filter(Boolean);
  const [onPurpose] = fences('sql');

  it('the hole is there before, closed after, and back after the rollback', async () => {
    const db = await production();

    // Before: the finding, as the review traced it through the editor.
    expect(await request(db, THE_COACH, removeSet)).toBe(1);
    expect(await request(db, THE_COACH, lowerSets)).toBe(2);
    expect(await request(db, THE_COACH, removeExercise)).toBe(3);
    expect(await request(db, THE_COACH, editReps)).toBe('1×8 2×8 3×8');
    expect(await request(db, THE_COACH, adoptSkip)).toEqual({ applied: 1, dry_run: true });   // P17: the failed set

    await db.runFile(migration.paths.migration);

    expect(await request(db, THE_COACH, removeSet)).toBe(`set 1 of exercise slot ${SLOT_1} is a logged set — it cannot be deleted`);
    expect(await request(db, THE_COACH, lowerSets))
      .toBe(`exercise slot ${SLOT_1} has 1 logged set(s) above set 2 — the set count cannot go below them`);
    expect(await request(db, THE_COACH, removeExercise))
      .toBe(`exercise slot ${SLOT_1} still has 2 logged set(s) — archive the session instead of deleting the exercise`);
    expect(await request(db, THE_COACH, editReps)).toBe('1×5 2×8 3×5');
    expect(await request(db, THE_COACH, adoptSkip)).toEqual({ applied: 0, dry_run: true });
    // The athlete, with the app that is deployed today: as before.
    expect(await request(db, THE_ATHLETE, `update public.set_logs set done = true, rpe = 7 where id = '${set(1, 2)}' returning rpe`)).toBe(7);
    expect(await request(db, THE_ATHLETE, `update public.set_logs set done = false, rpe = null where id = '${set(1, 1)}' returning done`)).toBe(false);
    // The coach, on a set nobody did: as before. An exercise with a failed
    // attempt and nothing else is held like one with a done set.
    expect(await request(db, THE_COACH, `delete from public.set_logs where id = '${set(1, 2)}' returning set_number`)).toBe(2);
    expect(await request(db, THE_COACH, `delete from public.exercise_slots where id = '${SLOT_2}' returning sets`))
      .toBe(`exercise slot ${SLOT_2} still has 1 logged set(s) — archive the session instead of deleting the exercise`);
    // Nothing above was kept, and the migration itself touches no row.
    expect(await db.query.value(`select count(*) from public.set_logs`)).toBe(6);

    await db.runFile(migration.paths.rollback);
    expect(await request(db, THE_COACH, removeSet)).toBe(1);
    expect(await request(db, THE_COACH, editReps)).toBe('1×8 2×8 3×8');
    expect(await request(db, THE_COACH, adoptSkip)).toEqual({ applied: 1, dry_run: true });
    await db.drop();
  });

  it('adds 6 functions and 4 triggers, rewrites 5 bodies, signs the ledger — no table, no policy, no privilege of what was there', async () => {
    const db = await production();
    const before = await catalogSnapshot(db.query);
    await db.runFile(migration.paths.migration);
    const after = await catalogSnapshot(db.query);

    const lines = diffCatalogs(before, after, { left: 'before', right: 'after' });
    const added = lines.filter((line) => line.endsWith(': only in after')).map((line) => line.slice(0, -': only in after'.length));
    expect(added).toEqual([
      'triggers public.exercise_slots.block_slot_delete_with_logged_sets',
      'triggers public.exercise_slots.block_slot_sets_below_logged_set',
      'triggers public.set_logs.block_set_log_delete_when_logged',
      'triggers public.set_logs.trg_pin_logged_set_log_targets',
      'functions public.block_set_log_delete_when_logged()',
      'functions public.block_slot_delete_with_logged_sets()',
      'functions public.block_slot_sets_below_logged_set()',
      'functions public.history_delete_allowed()',
      'functions public.pin_logged_set_log_targets()',
      'functions public.set_log_is_logged(sl set_logs)',
    ]);
    const changed = lines.filter((line) => !line.endsWith(': only in after'))
      .map((line) => /^(.*?): (\w+): /.exec(line).slice(1, 3).join(' → '));
    expect(changed).toEqual([
      'functions public.adopt_skip(p_slot_id uuid, p_dry_run boolean) → definition',
      'functions public.adopt_swap(p_slot_id uuid, p_substitute_id uuid, p_dry_run boolean) → definition',
      'functions public.block_program_delete_with_logged_sets() → definition',
      'functions public.block_session_delete_with_logged_sets() → definition',
      'functions public.block_week_delete_with_logged_sets() → definition',
      'data rows of app_private.app_migrations → rows',
    ]);

    // The new functions: closed to everyone but their owner and the service role.
    for (const key of added.filter((line) => line.startsWith('functions ')).map((line) => line.slice('functions '.length))) {
      expect(after.functions[key].privileges, key).toEqual(['postgres: EXECUTE', 'service_role: EXECUTE']);
      expect(after.functions[key].owner, key).toBe('postgres');
      expect(after.functions[key].definition, key).toContain(`\n SET search_path TO 'public', 'pg_temp'\n`);
    }
    // adopt_swap / adopt_skip: everything but the predicate is the text of
    // migration 02, the line that authorizes the caller included.
    const code = (snapshot, key) => snapshot.functions[key].definition
      .split('\n').filter((line) => !/^\s*--/.test(line)).map((line) => line.trim());
    const OLD_PREDICATE = [
      'AND (sl.done = true OR sl.skipped = true',
      'OR sl.actual_reps IS NOT NULL OR sl.actual_weight_kg IS NOT NULL)',
    ];
    const NEW_PREDICATE = [
      'AND (public.set_log_is_logged(sl)',
      'OR EXISTS (SELECT 1 FROM public.set_log_videos v WHERE v.set_log_id = sl.id))',
      ')',
      'AND NOT EXISTS (',
      'SELECT 1 FROM public.slot_comments c WHERE c.exercise_slot_id = es.id',
    ];
    for (const key of [
      'public.adopt_skip(p_slot_id uuid, p_dry_run boolean)',
      'public.adopt_swap(p_slot_id uuid, p_substitute_id uuid, p_dry_run boolean)',
    ]) {
      const [was, is] = [code(before, key), code(after, key)];
      const at = was.indexOf(OLD_PREDICATE[0]);
      expect(at, key).toBeGreaterThan(0);
      expect(is, key).toEqual([...was.slice(0, at), ...NEW_PREDICATE, ...was.slice(at + OLD_PREDICATE.length)]);
      expect(is, key).toContain('IF auth.uid() IS NULL OR v_coach_id IS DISTINCT FROM auth.uid() THEN');
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
      return result.rows.map((row) => [row.check, row.value]);
    };
    const rows = page.split('\n')
      .map((line) => /^\| (\d+) \| (.+?) \| (.+?) \| (.+?) \|$/.exec(line))
      .filter(Boolean)
      .map(([, n, check, before, after]) => ({ n: Number(n), check, before, after }));
    expect(rows.map((row) => row.n)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
    // Written between back-ticks: a value the page gives exactly. The two
    // others are counts of production's rows.
    const exact = rows.filter((row) => /^`.+`$/.test(row.before) && /^`.+`$/.test(row.after))
      .map((row) => ({ ...row, before: row.before.slice(1, -1), after: row.after.slice(1, -1) }));
    expect(rows.filter((row) => !exact.some((e) => e.n === row.n)).map((row) => row.check))
      .toEqual(['sets the athletes have logged', 'sets that carry a video']);
    const onPage = (column) => [
      ...exact.map((row) => [row.n, row.check, row[column]]),
      [11, 'sets the athletes have logged', '3 of 6'],
      [12, 'sets that carry a video', '0'],
    ].sort((a, b) => a[0] - b[0]).map(([, check, value]) => [check, value]);

    expect(await printed()).toEqual(onPage('before'));
    await db.runFile(migration.paths.migration);
    expect(await printed()).toEqual(onPage('after'));
    // …and the header of the audit file says the same.
    const header = audit.split('\n').filter((line) => line.startsWith('--')).join('\n');
    for (const { before, after } of exact) {
      expect(header).toContain(before);
      expect(header).toContain(after);
    }
    await db.drop();
  });

  it('its audit counts what an interrupted edit left behind, and a guard that is switched off', async () => {
    const db = await production();
    const audit = read(migration.paths.audit);
    const printed = async () => {
      const [result] = await db.readOnly(audit, 'audit');
      return Object.fromEntries(result.rows.map((row) => [row.check, row.value]));
    };
    const LEFT_BEHIND = [
      'sets left at a parked number (100000 or more)',
      'logged sets numbered above their exercise\'s set count',
      'exercises whose set count is not their number of prescribed sets',
    ];
    const leftBehind = async () => {
      const all = await printed();
      return LEFT_BEHIND.map((check) => all[check]);
    };
    expect(await leftBehind()).toEqual(['0', '0', '0']);

    // A draft has no set until it is approved: not a mismatch.
    await db.runSql(`
      insert into public.programs (id, student_id, name, status, created_by)
        values ('00000000-0000-4000-8000-000000000302', '00000000-0000-4000-8000-000000000101', 'Draft', 'draft', '${ATHLETE}');
      insert into public.weeks (id, program_id, week_number)
        values ('00000000-0000-4000-8000-000000000402', '00000000-0000-4000-8000-000000000302', 1);
      insert into public.sessions (id, week_id, title, sort_order)
        values ('00000000-0000-4000-8000-000000000453', '00000000-0000-4000-8000-000000000402', 'D1', 0);
      insert into public.exercise_slots (session_id, exercise_id, sets, reps, sort_order)
        values ('00000000-0000-4000-8000-000000000453', '00000000-0000-4000-8000-000000000201', 3, 5, 0);
    `, 'a draft');
    expect(await leftBehind()).toEqual(['0', '0', '0']);

    // A renumbering stopped between its two passes; a set count lowered
    // without its rows; a prescribed row that was never created; a video.
    await db.query(`update public.set_logs set set_number = 100002 where id = $1`, [set(1, 2)]);
    await db.query(`update public.set_logs set set_number = 100001 where id = $1`, [set(2, 1)]);
    await db.query(`update public.exercise_slots set sets = 2 where id = $1`, [SLOT_1]);
    await db.query(`delete from public.set_logs where id = $1`, [set(2, 3)]);
    await db.query(
      `insert into public.set_log_videos (set_log_id, storage_path, mime_type, size_bytes) values ($1, 'a/b/2-c.mp4', 'video/mp4', 1)`,
      [set(2, 2)],
    );
    expect(await leftBehind()).toEqual([
      '2 in 2 exercise(s), 1 of them logged',
      // Slot 1: its done set 3 above a count of 2 (its parked set 2 is not
      // logged). Slot 2: its failed set, parked.
      '2 in 2 exercise(s)',
      '2 (1 with fewer rows, 1 with more)',
    ]);
    expect(await printed()).toMatchObject({
      'sets the athletes have logged': '3 of 5',
      'sets that carry a video': '1',
    });

    // None of it stops the migration, and the migration changes none of it.
    await db.runFile(migration.paths.migration);
    expect(await leftBehind()).toEqual([
      '2 in 2 exercise(s), 1 of them logged', '2 in 2 exercise(s)', '2 (1 with fewer rows, 1 with more)',
    ]);

    // A guard that is there and switched off is not "in place".
    await db.query(`alter table public.set_logs disable trigger block_set_log_delete_when_logged`);
    await db.query(`alter table public.set_logs disable trigger trg_pin_logged_set_log_targets`);
    expect(await printed()).toMatchObject({
      'tables whose logged rows cannot be deleted (P3)': 'exercise_slots; programs; sessions; weeks',
      'the set count cannot go below a logged set': 'in place',
      'the targets of a logged set are pinned': 'missing',
    });
    await db.drop();
  });

  it('the page\'s check answers NOT PROTECTED before and protected after — and deletes nothing either way', async () => {
    const db = await production();
    expect(pageCheck, 'the page no longer gives the check').toBeTruthy();
    // Pasted between single quotes in a shell: it may not hold one.
    expect(pageCheck).not.toContain("'");
    const answer = async () => {
      const tried = await attempt(() => db.runSql(pageCheck, 'page check'));
      expect(tried.ok, 'the check must always fail: that is what undoes it').toBe(false);
      return (tried.error.cause ?? tried.error).message;
    };
    const rows = () => db.query.value(`select count(*) from public.set_logs`);

    expect(await answer()).toBe('check only, nothing was deleted: NOT PROTECTED: the delete went through');
    expect(await rows()).toBe(6);

    await db.runFile(migration.paths.migration);
    expect(await answer()).toBe(
      `check only, nothing was deleted: protected: set 1 of exercise slot ${SLOT_1} is a logged set — it cannot be deleted`,
    );
    expect(await rows()).toBe(6);
    // What the page says the command prints.
    expect(page).toContain('`check only, nothing was deleted: protected: set … of exercise slot … is a logged set — it cannot be deleted`');
    expect(page).toContain('`… NOT PROTECTED: the delete went through`');

    // With no set ticked done there is nothing to try, and it says so.
    await db.query(`update public.set_logs set done = false`);
    expect(await answer()).toBe('check only: no set is ticked done in this database, nothing to try');
    await db.drop();
  });

  it('the page\'s recipe deletes training history on purpose — as one paste, and only as one paste', async () => {
    const db = await production();
    await db.runFile(migration.paths.migration);
    expect(onPurpose, 'the page no longer gives the recipe').toBeTruthy();
    expect(onPurpose.split('\n')).toEqual([
      'begin;',
      `set local app.allow_history_delete = 'on';`,
      `delete from public.set_logs where id = '<id of the set>';`,
      'commit;',
    ]);
    const logged = () => db.query.value(`select count(*) from public.set_logs where done or failed`);
    const recipe = (statement) => onPurpose.replace(`delete from public.set_logs where id = '<id of the set>';`, statement);

    // Line by line, as the SQL editor would run a selection: the setting does
    // not outlive its statement, and the delete is refused.
    const [, setting, del] = onPurpose.split('\n');
    await db.query(setting.replace(/;$/, ''));
    const alone = await attempt(() => db.query(del.replace(/;$/, '').replace('<id of the set>', set(1, 1))));
    expect(alone.error?.message).toBe(`set 1 of exercise slot ${SLOT_1} is a logged set — it cannot be deleted`);
    expect(await logged()).toBe(3);

    // As one paste: a set…
    await db.runSql(recipe(`delete from public.set_logs where id = '${set(1, 1)}';`), 'recipe');
    expect(await logged()).toBe(2);
    // …and the next statement is guarded again.
    const next = await attempt(() => db.query(`delete from public.set_logs where id = $1`, [set(1, 3)]));
    expect(next.error?.message).toBe(`set 3 of exercise slot ${SLOT_1} is a logged set — it cannot be deleted`);
    // …an exercise, a phase, a program: whatever the delete line names.
    await db.runSql(recipe(`delete from public.exercise_slots where id = '${SLOT_1}';`), 'recipe');
    expect(await logged()).toBe(1);
    await db.runSql(recipe(`delete from public.programs where id = '${PROGRAM}';`), 'recipe');
    expect(await db.query.value(`select count(*) from public.set_logs`)).toBe(0);
    await db.drop();
  });

  it('puts back a guard that was dropped by hand and never re-created', async () => {
    const db = await production();
    // "Drop the trigger, delete, re-create it" — the recipe until this file — stopped halfway.
    await db.query(`drop trigger block_week_delete_with_logged_sets on public.weeks`);
    const tables = async () => {
      const [result] = await db.readOnly(read(migration.paths.audit), 'audit');
      return result.rows.find((row) => row.check === 'tables whose logged rows cannot be deleted (P3)').value;
    };
    expect(await tables()).toBe('programs; sessions');
    await db.runFile(migration.paths.migration);
    expect(await tables()).toBe('exercise_slots; programs; sessions; set_logs; weeks');
    expect(await request(db, THE_COACH, `delete from public.weeks returning id`))
      .toMatch(/^week .* still has 3 logged set\(s\) — archive it instead of deleting$/);
    await db.drop();
  });

  it('switches back on a guard that was disabled', async () => {
    const db = await production();
    await db.query(`alter table public.sessions disable trigger block_session_delete_with_logged_sets`);
    const state = () => db.query.value(
      `select tgenabled::text from pg_trigger where tgrelid = 'public.sessions'::regclass and tgname = 'block_session_delete_with_logged_sets'`,
    );
    expect(await state()).toBe('D');
    expect(await request(db, THE_COACH, `delete from public.sessions where id = '${SESSION_1}' returning sort_order`)).toBe(0);
    await db.runFile(migration.paths.migration);
    expect(await state()).toBe('O');
    expect(await request(db, THE_COACH, `delete from public.sessions where id = '${SESSION_1}' returning sort_order`))
      .toBe(`session ${SESSION_1} still has 2 logged set(s) — archive it instead of deleting`);
    await db.drop();
  });

  it('without migration 03 it says so (SLM02), and its rollback says there is nothing to undo (SLM03)', async () => {
    const db = await scratchDatabase();
    await db.runFile(manifest.baseline);
    const refusals = async () => {
      const before = await catalogSnapshot(db.query);
      const refused = await attempt(() => db.runFile(migration.paths.migration));
      const undone = await attempt(() => db.runFile(migration.paths.rollback));
      expect(diffCatalogs(before, await catalogSnapshot(db.query), { left: 'before', right: 'after' })).toEqual([]);
      return [refused.error?.code, refused.error?.message, undone.error?.code];
    };
    // Without a ledger at all, then with the ledger and the migration before 03 only.
    const needs = 'needs 2026_10_11_03_function_grants_lockdown, which is not applied';
    let [code, message, undone] = await refusals();
    expect([code, undone]).toEqual([REFUSAL.predecessorMissing, REFUSAL.notApplied]);
    expect(message).toContain(needs);
    await db.runFile(manifest.migrations[0].paths.migration);
    await db.runFile(manifest.migrations[1].paths.migration);
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
    // An older shape of adopt_skip, left behind: CREATE OR REPLACE would not touch it.
    await db.query(`create function public.adopt_skip(p_slot_id uuid) returns jsonb language sql as 'select null::jsonb'`);
    expect(await refusal()).toContain(`migration ${MIGRATION} would not replace: adopt_skip(uuid)`);
    await db.query(`drop function public.adopt_skip(uuid)`);
    // A helper of the same name, made by hand, that takes an id instead of the row.
    await db.query(`create function public.set_log_is_logged(p uuid) returns boolean language sql as 'select true'`);
    expect(await refusal()).toContain(`migration ${MIGRATION} would not replace: set_log_is_logged(uuid)`);
    await db.query(`drop function public.set_log_is_logged(uuid)`);

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
  // The file reads its own result back, so it cannot end "applied" with one of
  // its functions open.
  it('undoes itself when the result is not the one it meant', async () => {
    const db = await production();
    await db.runSql(
      `BEGIN;
       create function public.history_delete_allowed() returns boolean language sql as 'select false';
       grant execute on function public.history_delete_allowed() to service_role with grant option;
       set local role service_role;
       grant execute on function public.history_delete_allowed() to anon;
       COMMIT;`,
      'a function made by hand, opened by another role',
    );
    const before = await catalogSnapshot(db.query);

    const refused = await attempt(() => db.runFile(migration.paths.migration));
    expect(refused.error?.message).toContain(
      `migration ${MIGRATION} did not get the functions it meant: public.history_delete_allowed(): anon may execute it`,
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
    expect(await request(db, THE_COACH, removeSet)).toBe(`set 1 of exercise slot ${SLOT_1} is a logged set — it cannot be deleted`);
    await db.drop();
  });
});
