// Archived and reviewed sessions are read-only for the athlete — review
// findings P58 and L5 (the upload rule), closed by migration
// 2026_10_12_08_session_write_gates.
//
// An athlete writes five things in a session: sets, a note on an exercise, a
// swap or a skip, the video of a set, and the file of that video. The state
// of the session was asked of almost none of them, so a screen that was out
// of date, or a request sent by hand, changed what the coach had already
// reviewed. Since the migration an athlete's write asks three questions:
//
//   whose            student_profile_for_slot(x) = auth.uid()
//   which program    program_active_for_slot(x) = true      — the block being trained
//   which session    session_writable_for_slot(x)           — neither archived nor reviewed
//
// and a video is stored at <athlete>/<exercise slot of its set>/<file>.
// Reading is what it was.
//
// A refusal has two shapes, and the tests name which: an INSERT (an upsert
// included) raises 42501; an UPDATE or a DELETE reaches no row and says
// nothing. So a test about a refused write reads the rows back — "0 rows"
// from a statement that was mistyped would prove nothing — and every refused
// write of this file is first shown to go through on a session in progress.
//
// The first blocks run against schema.sql, as the callers the app has. The
// writes of the app that is DEPLOYED today are replayed as it sends them
// (src/lib/offlineMutations.js, src/hooks/useSetLogs.js, useSlotDeviations.js,
// useSetVideo.js): the migration is applied while that app is live. The last
// block applies the migration file itself to the frozen production baseline,
// with the checks of its runbook page read off the page.

import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  asAdmin, asAnon, asService, asUser, attempt, createUser, pastBlock, repoRoot, scenario, scratchDatabase, seed,
} from './harness.js';
import { catalogSnapshot, diffCatalogs } from './catalog.js';
import { LEDGER, loadManifest, REFUSAL } from '../migrations/manifest.js';

const MIGRATION = '2026_10_12_08_session_write_gates';
const manifest = loadManifest();
const migration = manifest.migrations.find((m) => m.name === MIGRATION);
const read = (file) => fs.readFileSync(path.join(repoRoot, file), 'utf8');

// seed(): coach Carla; athlete A with the active Block A (2 weeks × 2
// sessions, each a pull-up slot and a dip slot of 3 sets); athlete B with the
// active Block B. Una is an account nobody coaches.
let ids;
let una;
beforeAll(async () => {
  ids = await seed();
  una = await createUser({ email: 'una@sl.test', fullName: 'Una Unlinked' });
});

const sessionsOfA = () => ids.programA.tree.flatMap((week) => week.sessions);
/** Session n of athlete A's block: `{ id, pullUp, dip }`, each `{ id, setLogs: [id × 3] }`. */
const session = (n) => {
  const { id, slots: [pullUp, dip] } = sessionsOfA()[n];
  return { id, pullUp, dip };
};
const fileOf = (athlete, slot, name) => `${athlete.id}/${slot.id}/${name}`;

const RLS = (table) => `new row violates row-level security policy for table "${table}"`;

// ------------------------------------------------------------
// The app, as SQL. One entry per request the deployed client sends
// (PostgREST turns `.update().eq().select().single()` into UPDATE …
// RETURNING, `.upsert(…, { onConflict })` into INSERT … ON CONFLICT DO UPDATE
// SET every column it was given).
// ------------------------------------------------------------
const app = {
  // lib/offlineMutations.js
  tick: (q, set) => q(
    `update set_logs set done = true, failed = false, logged_at = now(), failed_at = null where id = $1 returning id`, [set],
  ),
  rate: (q, set) => q(`update set_logs set rpe = 8 where id = $1 returning id`, [set]),
  logActual: (q, set) => q(`update set_logs set actual_reps = 4, actual_weight_kg = 22.5 where id = $1 returning id`, [set]),
  skip: (q, set) => q(
    `update set_logs set skipped = true, done = false, failed = false, rpe = null, logged_at = null, failed_at = null,
                         actual_reps = null, actual_weight_kg = null
      where id = $1 returning id`, [set],
  ),
  confirm: (q, athlete, sessionId) => q(
    `insert into session_confirmations (session_id, student_id, notes, performed_on) values ($1, $2, null, current_date)
     on conflict (session_id) do update
       set student_id = excluded.student_id, notes = excluded.notes, performed_on = excluded.performed_on
     returning id`, [sessionId, athlete.id],
  ),
  saveComment: (q, athlete, slot, body) => q(
    `insert into slot_comments (exercise_slot_id, student_id, body, updated_at) values ($1, $2, $3, now())
     on conflict (exercise_slot_id) do update
       set student_id = excluded.student_id, body = excluded.body, updated_at = excluded.updated_at
     returning id`, [slot.id, athlete.id, body],
  ),
  clearComment: (q, slot) => q(`delete from slot_comments where exercise_slot_id = $1`, [slot.id]),
  saveDeviation: (q, athlete, slot, kind, substitute = null) => q(
    `insert into slot_deviations (exercise_slot_id, student_id, kind, substitute_exercise_id, note, updated_at)
     values ($1, $2, $3, $4, null, now())
     on conflict (exercise_slot_id) do update
       set student_id = excluded.student_id, kind = excluded.kind,
           substitute_exercise_id = excluded.substitute_exercise_id, note = excluded.note, updated_at = excluded.updated_at
     returning id`, [slot.id, athlete.id, kind, substitute],
  ),
  clearDeviation: (q, slot) => q(`delete from slot_deviations where exercise_slot_id = $1`, [slot.id]),
  // hooks/useSlotDeviations.js — "Ask coach to make this permanent"
  requestPromote: (q, slot) => q(`update slot_deviations set promote_requested_at = now() where exercise_slot_id = $1`, [slot.id]),
  // hooks/useSetLogs.js
  ensureSet: (q, slot, n) => q(
    `insert into set_logs (exercise_slot_id, set_number, done, target_reps, target_duration_seconds, target_weight_kg, target_rest_seconds)
     values ($1, $2, false, 5, null, 20, 120) returning id`, [slot.id, n],
  ),
  addExtraSet: (q, slot, n) => q(
    `insert into set_logs (exercise_slot_id, set_number, is_student_added, done, failed) values ($1, $2, true, false, false) returning id`,
    [slot.id, n],
  ),
  removeExtraSet: (q, set) => q(`delete from set_logs where id = $1 and is_student_added = true`, [set]),
  // hooks/useSetVideo.js — the Storage API inserts and deletes the row of
  // storage.objects as the caller, under these policies.
  upload: (q, name) => q(`insert into storage.objects (bucket_id, name, owner) values ('set-videos', $1, auth.uid())`, [name]),
  removeFile: (q, name) => q(`delete from storage.objects where bucket_id = 'set-videos' and name = $1`, [name]),
  addVideo: (q, set, storagePath) => q(
    `insert into set_log_videos (set_log_id, storage_path, mime_type, size_bytes) values ($1, $2, 'video/mp4', 1000) returning id`,
    [set, storagePath],
  ),
  // The wave-2 client replaces a video by pointing the row at the new file.
  moveVideo: (q, set, storagePath) => q(`update set_log_videos set storage_path = $2 where set_log_id = $1`, [set, storagePath]),
  removeVideo: (q, set) => q(`delete from set_log_videos where set_log_id = $1`, [set]),
};

/** How a write ended: `1 row`, `0 rows`, or what refused it. */
const outcome = async (run) => {
  const tried = await attempt(run);
  if (tried.ok) return `${tried.value.rowCount} row${tried.value.rowCount === 1 ? '' : 's'}`;
  const { code, message } = tried.error;
  return code === '42501' && /row-level security/.test(message) ? 'refused' : `${code}: ${message}`;
};

// ------------------------------------------------------------
// A session that has been trained: what the athlete leaves in it while it is
// open, written as the athlete. Returns the ids the later writes aim at.
// ------------------------------------------------------------
async function train(n, athlete = ids.studentA) {
  const s = session(n);
  const clip = fileOf(athlete, s.pullUp, '1-clip.mp4');
  return asUser(athlete, async (q) => {
    await app.tick(q, s.pullUp.setLogs[0]);
    const extra = (await app.addExtraSet(q, s.pullUp, 4)).rows[0].id;
    await app.saveComment(q, athlete, s.pullUp, 'Felt heavy');
    await app.saveDeviation(q, athlete, s.dip, 'skip');
    await app.upload(q, clip);
    await app.addVideo(q, s.pullUp.setLogs[0], clip);
    return { ...s, extra, clip };
  });
}

/**
 * Every write an athlete has on a session, as the app sends them:
 * `[what, kind, run]` — kind 'insert' raises when refused, 'write' reaches no
 * row. Each one finds what it needs in what train() left, so they can be run
 * one after the other (attemptAll) or each on its own and undone (tryAll).
 */
const everyWrite = (t, athlete = ids.studentA) => {
  const second = fileOf(athlete, t.pullUp, '2-clip.mp4');
  const again = fileOf(athlete, t.pullUp, '1-again.mp4');
  return [
    ['a set: tick', 'write', (q) => app.tick(q, t.pullUp.setLogs[1])],
    ['a set: rate', 'write', (q) => app.rate(q, t.pullUp.setLogs[0])],
    ['a set: actual reps and load', 'write', (q) => app.logActual(q, t.pullUp.setLogs[0])],
    ['a set: skip', 'write', (q) => app.skip(q, t.pullUp.setLogs[2])],
    ['a set: the prescribed row the app adds when one is missing', 'insert', (q) => app.ensureSet(q, t.dip, 5)],
    ['a set: add an extra one', 'insert', (q) => app.addExtraSet(q, t.dip, 6)],
    ['a set: remove an extra one', 'write', (q) => app.removeExtraSet(q, t.extra)],
    ['a note: rewrite', 'insert', (q) => app.saveComment(q, athlete, t.pullUp, 'Felt fine, actually')],
    ['a note: add', 'insert', (q) => app.saveComment(q, athlete, t.dip, 'Elbow')],
    ['a note: remove', 'write', (q) => app.clearComment(q, t.pullUp)],
    ['a skip: make it a swap', 'insert', (q) => app.saveDeviation(q, athlete, t.dip, 'swap', ids.exercises.squat)],
    ['a skip: add', 'insert', (q) => app.saveDeviation(q, athlete, t.pullUp, 'skip')],
    ['a swap: ask the coach to make it permanent', 'write', (q) => app.requestPromote(q, t.dip)],
    ['a swap: remove', 'write', (q) => app.clearDeviation(q, t.dip)],
    ['a file: upload', 'insert', (q) => app.upload(q, second)],
    ['a video: add', 'insert', (q) => app.addVideo(q, t.pullUp.setLogs[1], second)],
    ['a file: upload the replacement', 'insert', (q) => app.upload(q, again)],
    ['a video: point it at the replacement', 'write', (q) => app.moveVideo(q, t.pullUp.setLogs[0], again)],
    ['a file: remove', 'write', (q) => app.removeFile(q, t.clip)],
    ['a video: remove', 'write', (q) => app.removeVideo(q, t.pullUp.setLogs[0])],
  ];
};

/** All of them, one after the other, each one kept. */
const attemptAll = async (writes, athlete = ids.studentA) => {
  const out = {};
  for (const [what, , run] of writes) out[what] = await outcome(() => asUser(athlete, run));
  return out;
};
/** Each of them on its own, undone as soon as it has answered: the rows stay as they are. */
const tryAll = async (writes, athlete = ids.studentA) => {
  const out = {};
  for (const [what, , run] of writes) {
    out[what] = await outcome(() => asUser(athlete, (q) => run((sql, params) => q.dryRun(sql, params))));
  }
  return out;
};
const all = (writes, answer) => Object.fromEntries(writes.map(([what, kind]) => [what, answer(kind)]));
const ACCEPTED = (writes) => all(writes, () => '1 row');
const REFUSED = (writes) => all(writes, (kind) => (kind === 'insert' ? 'refused' : '0 rows'));

/** Everything athlete-written that hangs under a session, as the owner reads it. */
const contents = (q, t) => q.one(
  `select
     (select jsonb_agg(to_jsonb(sl) - 'updated_at' order by sl.exercise_slot_id, sl.set_number)
        from set_logs sl where sl.exercise_slot_id = any($1)) as sets,
     (select jsonb_agg(jsonb_build_object('slot', c.exercise_slot_id, 'body', c.body) order by c.exercise_slot_id)
        from slot_comments c where c.exercise_slot_id = any($1)) as notes,
     (select jsonb_agg(jsonb_build_object('slot', d.exercise_slot_id, 'kind', d.kind, 'substitute', d.substitute_exercise_id,
                                          'asked', d.promote_requested_at is not null) order by d.exercise_slot_id)
        from slot_deviations d where d.exercise_slot_id = any($1)) as deviations,
     (select jsonb_agg(jsonb_build_object('set', v.set_log_id, 'path', v.storage_path) order by v.storage_path)
        from set_log_videos v join set_logs sl on sl.id = v.set_log_id where sl.exercise_slot_id = any($1)) as videos,
     (select jsonb_agg(o.name order by o.name)
        from storage.objects o where o.bucket_id = 'set-videos' and o.name like $2) as files`,
  [[t.pullUp.id, t.dip.id], `%/${t.pullUp.id}/%`],
);

// The coach, as the app: feedback (which stamps the review), "Finish without
// feedback", archive, restore.
const coach = (sql, params) => asUser(ids.coach, (q) => q(sql, params));
const sendFeedback = (sessionId, athlete = ids.studentA) => coach(
  `insert into messages (sender_id, recipient_id, body, session_id) values ($1, $2, 'Good session.', $3)`,
  [ids.coach.id, athlete.id, sessionId],
);
const finishWithoutFeedback = (sessionId) => coach(
  `update sessions set reviewed_at = now() where id = $1 and reviewed_at is null returning id`, [sessionId],
);
const archive = (sessionId) => coach(`update sessions set archived_at = now() where id = $1`, [sessionId]);
const restore = (sessionId) => coach(`update sessions set archived_at = null where id = $1`, [sessionId]);
const confirmAsAthlete = (sessionId, athlete = ids.studentA) => asUser(athlete, (q) => app.confirm(q, athlete, sessionId));

// ============================================================
// The helpers
// ============================================================
describe('session_writable: is this session open for its athlete', () => {
  const writable = (q, sessionId) => q.value(`select public.session_writable($1)`, [sessionId]);
  const forSlot = (q, slotId) => q.value(`select public.session_writable_for_slot($1)`, [slotId]);

  it('true for a session in progress and for a confirmed one; false once it is archived or reviewed; true again when that is taken back', () => scenario(async (q) => {
    const s = session(0);
    expect([await writable(q, s.id), await forSlot(q, s.pullUp.id), await forSlot(q, s.dip.id)]).toEqual([true, true, true]);

    await confirmAsAthlete(s.id);
    expect([await writable(q, s.id), await forSlot(q, s.pullUp.id)]).toEqual([true, true]);

    await archive(s.id);
    expect([await writable(q, s.id), await forSlot(q, s.pullUp.id)]).toEqual([false, false]);
    await restore(s.id);
    expect([await writable(q, s.id), await forSlot(q, s.pullUp.id)]).toEqual([true, true]);

    expect((await finishWithoutFeedback(s.id)).rowCount).toBe(1);
    expect([await writable(q, s.id), await forSlot(q, s.pullUp.id), await forSlot(q, s.dip.id)]).toEqual([false, false, false]);
    await archive(s.id);
    expect(await writable(q, s.id)).toBe(false);
    // The other sessions of the block are not concerned.
    expect([await writable(q, session(1).id), await forSlot(q, session(1).pullUp.id)]).toEqual([true, true]);

    await q(`update sessions set reviewed_at = null, archived_at = null where id = $1`, [s.id]);
    expect(await writable(q, s.id)).toBe(true);
  }));

  it('feedback from the coach closes the session, as "Finish without feedback" does', () => scenario(async (q) => {
    const s = session(0);
    await confirmAsAthlete(s.id);
    await sendFeedback(s.id);
    expect(await q.value(`select reviewed_at is not null from sessions where id = $1`, [s.id])).toBe(true);
    expect([await writable(q, s.id), await forSlot(q, s.pullUp.id)]).toEqual([false, false]);
  }));

  // `IF NOT session_writable(x) THEN RAISE` must refuse what does not exist:
  // an IF on NULL skips its branch.
  it('never answers NULL: a session, a slot or a set that does not exist is not writable', () => scenario(async (q) => {
    const nowhere = await q.value(`select gen_random_uuid()`);
    expect(await q.one(
      `select public.session_writable($1) as session, public.session_writable(null) as no_session,
              public.session_writable_for_slot($1) as slot, public.session_writable_for_slot(null) as no_slot,
              public.session_writable_for_slot(public.slot_for_set_log($1)) as set,
              public.slot_for_set_log($1) as slot_of_nothing`,
      [nowhere],
    )).toEqual({ session: false, no_session: false, slot: false, no_slot: false, set: false, slot_of_nothing: null });
  }));

  // The trap the name holds: it is the SESSION's lock. Whether the program is
  // the block being trained is the other helper's question, and a write asks
  // both.
  it('says nothing about the program: a session of a past block, of a trashed block or of a draft is "writable", and program_active_for_slot says no', () => scenario(async (q) => {
    const s = session(0);
    const both = () => q.one(
      `select public.session_writable($1) as session, public.program_active_for_slot($2) as program`, [s.id, s.pullUp.id],
    );
    expect(await both()).toEqual({ session: true, program: true });
    // A past block: switched off more than 72 hours ago. Inside those 72 hours
    // the program is still open for its athlete (migration 17,
    // replay-grace.test.js) — the lock of the session says nothing of that
    // either.
    await pastBlock(q, ids.programA.id);
    expect(await both()).toEqual({ session: true, program: false });
    await q(`update programs set deleted_at = now() where id = $1`, [ids.programA.id]);
    expect(await both()).toEqual({ session: true, program: false });
  }));

  // session_writable(session) was closed to a signed-in user by migration 08:
  // no policy asked it. Since migration 09 the UPDATE and DELETE policies of
  // session_confirmations do (review-lifecycle.test.js).
  it('answers the same whoever asks, by slot and by session — and nothing to a request without a session', () => scenario(async () => {
    const s = session(0);
    await archive(s.id);
    for (const who of [ids.studentA, ids.studentB, ids.coach, una]) {
      expect(await asUser(who, (user) => user.value(`select public.session_writable_for_slot($1)`, [s.pullUp.id]))).toBe(false);
      expect(await asUser(who, (user) => user.value(`select public.session_writable_for_slot($1)`, [session(1).pullUp.id]))).toBe(true);
      expect(await asUser(who, (user) => user.value(`select public.session_writable($1)`, [s.id]))).toBe(false);
      expect(await asUser(who, (user) => user.value(`select public.session_writable($1)`, [session(1).id]))).toBe(true);
    }
    expect(await asService((service) => service.value(`select public.session_writable($1)`, [s.id]))).toBe(false);
    for (const call of [
      `select public.session_writable('${s.id}')`,
      `select public.session_writable_for_slot('${s.pullUp.id}')`,
      `select public.slot_for_set_log('${s.pullUp.setLogs[0]}')`,
      `select public.set_video_slot('a/b/c')`,
    ]) {
      const anon = await attempt(() => asAnon((nobody) => nobody.value(call)));
      expect(anon.error?.code, call).toBe('42501');
    }
  }));

  it('slot_for_set_log gives the exercise slot of a set', () => scenario(async (q) => {
    const s = session(2);
    expect(await q.value(`select public.slot_for_set_log($1)`, [s.dip.setLogs[1]])).toBe(s.dip.id);
    expect(await asUser(ids.studentA, (athlete) => athlete.value(`select public.slot_for_set_log($1)`, [s.pullUp.setLogs[0]])))
      .toBe(s.pullUp.id);
  }));
});

describe('set_video_slot: the exercise slot the path of a video names', () => {
  it('is the second folder of <athlete>/<slot>/<file>, and NULL for a path of any other shape — it never fails', () => scenario(async (q) => {
    const athlete = ids.studentA.id;
    const slot = session(0).pullUp.id;
    const cases = [
      [`${athlete}/${slot}/1-clip.mp4`, slot],
      // What storage.foldername() calls the second folder.
      [`${athlete}/${slot}/deeper/1-clip.mp4`, slot],
      [`${athlete}/${slot}/`, slot],
      [`anything/${slot}/1-clip.mp4`, slot],
      // No second folder: the slot would be the name of the file.
      [`${athlete}/${slot}`, null],
      [`${slot}/1-clip.mp4`, null],
      [`${slot}`, null],
      // Not a uuid as PostgreSQL prints one.
      [`${athlete}/${slot.toUpperCase()}/1-clip.mp4`, null],
      [`${athlete}/{${slot}}/1-clip.mp4`, null],
      [`${athlete}/${slot.replace(/-/g, '')}/1-clip.mp4`, null],
      [`${athlete}/${slot} /1-clip.mp4`, null],
      [`${athlete}/${slot}\n/1-clip.mp4`, null],
      [`${athlete}/not-a-uuid/1-clip.mp4`, null],
      [`${athlete}//1-clip.mp4`, null],
      ['a/b/c', null],
      ['', null],
      ['/', null],
      ['///', null],
      [null, null],
    ];
    for (const [name, expected] of cases) {
      expect(await q.value(`select public.set_video_slot($1)`, [name]), JSON.stringify(name)).toBe(expected);
      // …and it agrees with the folder the storage policies read.
      if (expected) expect(await q.value(`select (storage.foldername($1))[2]`, [name])).toBe(expected);
    }
  }));
});

// ============================================================
// A session in progress — and a confirmed one
// ============================================================
describe('an athlete writes in a session that is in progress', () => {
  it('every write of the app goes through, and is kept', () => scenario(async (q) => {
    const t = await train(0);
    const writes = everyWrite(t);
    expect(await attemptAll(writes)).toEqual(ACCEPTED(writes));

    const kept = await contents(q, t);
    const told = (slot) => kept.sets.filter((set) => set.exercise_slot_id === slot.id)
      .map((set) => [set.set_number, set.done, set.skipped, set.rpe, set.actual_reps, set.is_student_added]
        .map((value) => value ?? '-').join(' '));
    expect(told(t.pullUp)).toEqual([
      '1 true false 8 4 false',      // ticked while training, then rated, with actuals
      '2 true false - - false',      // ticked
      '3 false true - - false',      // skipped
    ]);                              // …and the extra set of training is gone
    expect(told(t.dip)).toEqual([
      '1 false false - - false',
      '2 false false - - false',
      '3 false false - - false',
      '5 false false - - false',     // the prescribed row the app adds
      '6 false false - - true',      // the extra set
    ]);
    expect(kept.notes).toEqual([{ slot: t.dip.id, body: 'Elbow' }]);
    expect(kept.deviations).toEqual([{ slot: t.pullUp.id, kind: 'skip', substitute: null, asked: false }]);
    expect(kept.videos).toEqual([{ set: t.pullUp.setLogs[1], path: fileOf(ids.studentA, t.pullUp, '2-clip.mp4') }]);
    expect(kept.files).toEqual([
      fileOf(ids.studentA, t.pullUp, '1-again.mp4'),
      fileOf(ids.studentA, t.pullUp, '2-clip.mp4'),
    ]);
  }));

  // The decision behind the gate: sets logged without a connection are sent
  // one by one, the confirmation separately, and a set may arrive after it.
  it('the confirmation does not close it: what is replayed after an offline confirm is accepted', () => scenario(async (q) => {
    const t = await train(1);
    expect((await confirmAsAthlete(t.id)).rowCount).toBe(1);
    expect(await q.value(`select count(*) from session_confirmations where session_id = $1`, [t.id])).toBe(1);

    const writes = everyWrite(t);
    expect(await attemptAll(writes)).toEqual(ACCEPTED(writes));
    // A second replay of the confirmation itself is the upsert it always was.
    expect((await confirmAsAthlete(t.id)).rowCount).toBe(1);
  }));

  it('athlete B writes in their own session, and reaches nothing of athlete A\'s', () => scenario(async (q) => {
    const t = await train(0);
    const before = await contents(q, t);
    // As B, the writes aimed at A's rows — with B's own id where the app sends one.
    const writes = everyWrite(t, ids.studentB);
    expect(await attemptAll(writes, ids.studentB)).toEqual(REFUSED(writes));
    expect(await contents(q, t)).toEqual(before);

    const [pullUp] = ids.programB.tree[0].sessions[0].slots;
    expect(await outcome(() => asUser(ids.studentB, (b) => app.tick(b, pullUp.setLogs[0])))).toBe('1 row');
    expect(await outcome(() => asUser(ids.studentB, (b) => app.saveComment(b, ids.studentB, pullUp, 'Mine')))).toBe('1 row');
  }));
});

// ============================================================
// The lock
// ============================================================
describe('a session the coach reviewed or archived is read-only for its athlete', () => {
  const CLOSED = {
    'reviewed, with feedback': async (t) => {
      await confirmAsAthlete(t.id);
      await sendFeedback(t.id);
    },
    'reviewed, finished without feedback': async (t) => {
      await confirmAsAthlete(t.id);
      expect((await finishWithoutFeedback(t.id)).rowCount).toBe(1);
    },
    // The coach app that was deployed with this migration offered the review
    // of a session its athlete had not confirmed — reached from the
    // notification of a swap, while the athlete was still training. The
    // athlete app went by the confirmation: it listed that session as still
    // to do and opened it unlocked, so there the database was the only lock.
    // Line 13 of the migration's audit counts these sessions (last block of
    // this file). Since migration 09 a coach can no longer make one; the ones
    // from before are still there, and here one is left the way they were:
    // a review without a confirmation, stamped by the owner.
    'reviewed before the athlete confirmed it': async (t) => {
      expect((await finishWithoutFeedback(t.id).catch((error) => error)).code).toBe('42501');
      expect((await asAdmin((owner) => owner(`update sessions set reviewed_at = now() where id = $1`, [t.id]))).rowCount).toBe(1);
    },
    'archived': (t) => archive(t.id),
    'reviewed and archived': async (t) => {
      await confirmAsAthlete(t.id);
      await sendFeedback(t.id);
      await archive(t.id);
    },
  };

  for (const [state, close] of Object.entries(CLOSED)) {
    it(`${state}: every write is refused, on all five surfaces, and nothing moves`, () => scenario(async (q) => {
      const t = await train(0);
      const writes = everyWrite(t);
      // The same writes on the same rows, each one undone: all of them go
      // through as long as the session is open. "0 rows" below is the lock.
      expect(await tryAll(writes)).toEqual(ACCEPTED(writes));
      const open = await contents(q, t);

      await close(t);
      expect(await contents(q, t)).toEqual(open);
      expect(await attemptAll(writes)).toEqual(REFUSED(writes));
      expect(await contents(q, t)).toEqual(open);

      // The rest of the block is trained as before.
      const next = session(1);
      expect(await outcome(() => asUser(ids.studentA, (athlete) => app.tick(athlete, next.pullUp.setLogs[0])))).toBe('1 row');
      expect(await outcome(() => asUser(ids.studentA, (athlete) => app.saveComment(athlete, ids.studentA, next.dip, 'Next')))).toBe('1 row');
    }));
  }

  it('what the deployed app shows for each refusal: "permission" for an insert, nothing saved for the rest', () => scenario(async () => {
    const t = await train(0);
    await confirmAsAthlete(t.id);
    await sendFeedback(t.id);
    // An upsert onto a row that is there is judged as the INSERT it starts as.
    for (const [table, run] of [
      ['slot_comments', (q) => app.saveComment(q, ids.studentA, t.pullUp, 'Rewritten')],
      ['slot_deviations', (q) => app.saveDeviation(q, ids.studentA, t.dip, 'swap', ids.exercises.squat)],
      ['set_logs', (q) => app.addExtraSet(q, t.pullUp, 9)],
      ['set_log_videos', (q) => app.addVideo(q, t.pullUp.setLogs[1], fileOf(ids.studentA, t.pullUp, '2-clip.mp4'))],
      ['objects', (q) => app.upload(q, fileOf(ids.studentA, t.pullUp, '2-clip.mp4'))],
    ]) {
      const refused = await attempt(() => asUser(ids.studentA, run));
      // src/lib/mutationErrors.js: 42501 → errors.notAllowed.
      expect([refused.error?.code, refused.error?.message], table).toEqual(['42501', RLS(table)]);
    }
    // `.update(…).select().single()` on no row is PGRST116 for the app:
    // errors.generic, and the set goes back to what it was.
    const ticked = await asUser(ids.studentA, (q) => app.tick(q, t.pullUp.setLogs[1]));
    expect([ticked.rowCount, ticked.rows]).toEqual([0, []]);
  }));

  it('reading is what it was: the athlete and the coach see everything of a closed session', () => scenario(async () => {
    const t = await train(0);
    await confirmAsAthlete(t.id);
    await sendFeedback(t.id);
    await archive(t.id);
    const seen = (who) => asUser(who, (q) => q.one(
      `select (select count(*) from set_logs where exercise_slot_id = any($1)) as sets,
              (select count(*) from slot_comments where exercise_slot_id = any($1)) as notes,
              (select count(*) from slot_deviations where exercise_slot_id = any($1)) as deviations,
              (select count(*) from set_log_videos v join set_logs sl on sl.id = v.set_log_id
                where sl.exercise_slot_id = any($1)) as videos,
              (select count(*) from storage.objects where name = $2) as files`,
      [[t.pullUp.id, t.dip.id], t.clip],
    ));
    const everything = { sets: 7, notes: 1, deviations: 1, videos: 1, files: 1 };
    expect(await seen(ids.studentA)).toEqual(everything);
    expect(await seen(ids.coach)).toEqual(everything);
    expect(await seen(ids.studentB)).toEqual({ sets: 0, notes: 0, deviations: 0, videos: 0, files: 0 });
  }));

  it('opens again: restored by the coach, or the review taken back by the owner', () => scenario(async (q) => {
    const archived = await train(0);
    await archive(archived.id);
    expect(await outcome(() => asUser(ids.studentA, (a) => app.tick(a, archived.pullUp.setLogs[1])))).toBe('0 rows');
    await restore(archived.id);
    const writes = everyWrite(archived);
    expect(await attemptAll(writes)).toEqual(ACCEPTED(writes));

    const reviewed = await train(1);
    await confirmAsAthlete(reviewed.id);
    await sendFeedback(reviewed.id);
    expect(await outcome(() => asUser(ids.studentA, (a) => app.tick(a, reviewed.pullUp.setLogs[1])))).toBe('0 rows');
    // The app has no way to take a review back: this is the owner's
    // statement, the one the runbook page gives.
    await q(`update sessions set reviewed_at = null where id = $1`, [reviewed.id]);
    const again = everyWrite(reviewed);
    expect(await attemptAll(again)).toEqual(ACCEPTED(again));
  }));

  it('an athlete cannot open a session themselves: reviewed_at and archived_at are not theirs to write', () => scenario(async (q) => {
    const t = await train(0);
    await confirmAsAthlete(t.id);
    await sendFeedback(t.id);
    await archive(t.id);
    const tried = await asUser(ids.studentA, (athlete) => athlete(
      `update sessions set reviewed_at = null, archived_at = null where id = $1`, [t.id],
    ));
    expect(tried.rowCount).toBe(0);
    // Undoing the confirmation does not open it either: the gate is the review.
    await asUser(ids.studentA, (athlete) => athlete(`delete from session_confirmations where session_id = $1`, [t.id]));
    expect(await q.value(`select public.session_writable($1)`, [t.id])).toBe(false);
    expect(await outcome(() => asUser(ids.studentA, (a) => app.tick(a, t.pullUp.setLogs[1])))).toBe('0 rows');
  }));
});

// ============================================================
// The program
// ============================================================
// "No longer" is 72 hours after the block was switched off, since migration
// 17: what an athlete logged without a connection is replayed against a block
// the coach has switched off in between (replay-grace.test.js). A past block
// here is one whose 72 hours are over; the trash closes a block at once.
describe('a block that is no longer the one being trained', () => {
  for (const [state, change] of [
    ['a past block', (q) => pastBlock(q, ids.programA.id)],
    ['a block in the trash', (q) => q(`update programs set is_active = false, deleted_at = now() where id = $1`, [ids.programA.id])],
  ]) {
    it(`${state}: sets, notes, swaps — and now videos and their files — are refused`, () => scenario(async (q) => {
      const t = await train(0);
      await change(q);
      const before = await contents(q, t);
      const writes = everyWrite(t);
      expect(await attemptAll(writes)).toEqual(REFUSED(writes));
      expect(await contents(q, t)).toEqual(before);
      // …and still read.
      expect(await asUser(ids.studentA, (a) => a.value(`select count(*) from set_log_videos`))).toBe(1);
    }));
  }
});

// ============================================================
// Where a video is stored
// ============================================================
describe('a video is stored under its athlete and the exercise of its set', () => {
  const add = (who, set, storagePath) => outcome(() => asUser(who, (q) => app.addVideo(q, set, storagePath)));

  it('the row of a video names <athlete>/<slot of the set>/<file>, and no other place', () => scenario(async (q) => {
    const s = session(0);
    const [set] = s.pullUp.setLogs;
    const A = ids.studentA;
    const elsewhere = [
      // Under another exercise of the same session, and of a session to come:
      // the file would stay replaceable after the review of this one.
      fileOf(A, s.dip, '1-clip.mp4'),
      fileOf(A, session(3).pullUp, '1-clip.mp4'),
      // In another athlete's folder, under the right slot and under theirs.
      fileOf(ids.studentB, s.pullUp, '1-clip.mp4'),
      fileOf(ids.studentB, ids.programB.tree[0].sessions[0].slots[0], '1-clip.mp4'),
      // No folder for the slot, or one that is not a slot.
      `${A.id}/1-clip.mp4`,
      `${A.id}/${s.pullUp.id}`,
      `${A.id}/${s.pullUp.id.toUpperCase()}/1-clip.mp4`,
      `${A.id}/not-a-uuid/1-clip.mp4`,
      `${s.pullUp.id}/${A.id}/1-clip.mp4`,
      'a/b/1-clip.mp4',
      '',
    ];
    // Refused by the policy — never by a cast that fails on the path.
    for (const storagePath of elsewhere) expect(await add(A, set, storagePath), storagePath).toBe('refused');
    expect(await q.value(`select count(*) from set_log_videos`)).toBe(0);

    expect(await add(A, set, fileOf(A, s.pullUp, '1-clip.mp4'))).toBe('1 row');
    // Once there, it cannot be pointed elsewhere either.
    for (const storagePath of elsewhere) {
      const moved = await attempt(() => asUser(A, (athlete) => app.moveVideo(athlete, set, storagePath)));
      expect([moved.error?.code, moved.error?.message], storagePath).toEqual(['42501', RLS('set_log_videos')]);
    }
    expect(await outcome(() => asUser(A, (athlete) => app.moveVideo(athlete, set, fileOf(A, s.pullUp, '1-better.mp4'))))).toBe('1 row');
  }));

  it('nobody adds a video to a set that is not theirs: another athlete, the coach, an account nobody coaches', () => scenario(async (q) => {
    const s = session(0);
    for (const who of [ids.studentB, ids.coach, una]) {
      expect(await add(who, s.pullUp.setLogs[0], fileOf(who, s.pullUp, '1-clip.mp4'))).toBe('refused');
      expect(await add(who, s.pullUp.setLogs[0], fileOf(ids.studentA, s.pullUp, '1-clip.mp4'))).toBe('refused');
    }
    expect(await q.value(`select count(*) from set_log_videos`)).toBe(0);
  }));

  // The story the path rule is there for.
  it('a video of a reviewed session cannot be swapped for another through a file kept under a session to come', () => scenario(async (q) => {
    const first = session(0);
    const later = session(3);
    const parked = fileOf(ids.studentA, later.pullUp, '1-clip.mp4');
    // The file itself may be uploaded there: the session to come is open.
    expect(await outcome(() => asUser(ids.studentA, (a) => app.upload(a, parked)))).toBe('1 row');
    // The row of a set of the FIRST session may not name it.
    expect(await add(ids.studentA, first.pullUp.setLogs[0], parked)).toBe('refused');

    // So the video of the first session is where its own lock reaches it.
    const t = await train(0);
    await confirmAsAthlete(t.id);
    await sendFeedback(t.id);
    expect(await outcome(() => asUser(ids.studentA, (a) => app.removeFile(a, t.clip)))).toBe('0 rows');
    expect(await outcome(() => asUser(ids.studentA, (a) => app.upload(a, t.clip)))).not.toBe('1 row');
    expect(await outcome(() => asUser(ids.studentA, (a) => a(
      `update storage.objects set name = $2 where name = $1`, [t.clip, fileOf(ids.studentA, later.pullUp, 'moved.mp4')],
    )))).toBe('0 rows');
    expect((await contents(q, t)).files).toEqual([t.clip]);
  }));

  it('a video that was stored elsewhere before the rule stays readable, and its athlete can still remove it while the session is open', () => scenario(async (q) => {
    const s = session(0);
    await q(
      `insert into set_log_videos (set_log_id, storage_path, mime_type, size_bytes) values ($1, 'a/b/1-clip.mp4', 'video/mp4', 1000)`,
      [s.pullUp.setLogs[0]],
    );
    expect(await asUser(ids.studentA, (a) => a.value(`select storage_path from set_log_videos`))).toBe('a/b/1-clip.mp4');
    expect(await asUser(ids.coach, (c) => c.value(`select storage_path from set_log_videos`))).toBe('a/b/1-clip.mp4');
    // The deployed app replaces a video by deleting the row and inserting one.
    expect(await outcome(() => asUser(ids.studentA, (a) => app.removeVideo(a, s.pullUp.setLogs[0])))).toBe('1 row');
  }));
});

// ============================================================
// The files
// ============================================================
describe('the files of the set-videos bucket', () => {
  const upload = (who, name) => outcome(() => asUser(who, (q) => app.upload(q, name)));
  const remove = (who, name) => outcome(() => asUser(who, (q) => app.removeFile(q, name)));

  it('an athlete uploads under their own id and an exercise of their own, in a writable session — nowhere else', () => scenario(async (q) => {
    const A = ids.studentA;
    const s = session(0);
    const slotOfB = ids.programB.tree[0].sessions[0].slots[0];
    expect(await upload(A, fileOf(A, s.pullUp, '1-clip.mp4'))).toBe('1 row');
    expect(await upload(A, fileOf(A, session(3).dip, '2-clip.webm'))).toBe('1 row');

    for (const name of [
      // Under another athlete's exercise, in their own folder or in the other's.
      fileOf(A, slotOfB, '1-clip.mp4'),
      fileOf(ids.studentB, slotOfB, '1-clip.mp4'),
      fileOf(ids.studentB, s.pullUp, '1-clip.mp4'),
      // Under no exercise, or under something that is not one.
      `${A.id}/1-clip.mp4`,
      `${A.id}/${s.pullUp.id}`,
      `${A.id}/${s.pullUp.id.toUpperCase()}/1-clip.mp4`,
      `${A.id}/${await q.value(`select gen_random_uuid()`)}/1-clip.mp4`,
      `${A.id}/not-a-uuid/1-clip.mp4`,
      `${A.id}//1-clip.mp4`,
      '1-clip.mp4',
      '',
    ]) {
      expect(await upload(A, name), JSON.stringify(name)).toBe('refused');
    }
    // Another bucket is not opened by these policies.
    await q(`insert into storage.buckets (id, name) values ('other', 'other')`);
    const other = await attempt(() => asUser(A, (athlete) => athlete(
      `insert into storage.objects (bucket_id, name) values ('other', $1)`, [fileOf(A, s.pullUp, '1-clip.mp4')],
    )));
    expect(other.error?.message).toBe(RLS('objects'));
    expect(await q.value(`select count(*) from storage.objects`)).toBe(2);
  }));

  // L5: with open sign-up, any account could fill the bucket under its own id.
  it('an account nobody coaches uploads nothing, and neither does a coach', () => scenario(async (q) => {
    const s = session(0);
    for (const who of [una, ids.coach]) {
      for (const name of [
        `${who.id}/1-clip.mp4`,
        `${who.id}/${who.id}/1-clip.mp4`,
        fileOf(who, s.pullUp, '1-clip.mp4'),
        fileOf(ids.studentA, s.pullUp, '1-clip.mp4'),
      ]) {
        expect(await upload(who, name), name).toBe('refused');
      }
    }
    const anon = await attempt(() => asAnon((nobody) => app.upload(nobody, fileOf(ids.studentA, s.pullUp, '1-clip.mp4'))));
    expect(anon.error?.message).toBe(RLS('objects'));
    expect(await q.value(`select count(*) from storage.objects`)).toBe(0);
  }));

  it('a file is removed by its athlete while its session is writable, and by nobody else', () => scenario(async (q) => {
    const t = await train(0);
    for (const who of [ids.studentB, ids.coach, una]) expect(await remove(who, t.clip)).toBe('0 rows');
    const anon = await asAnon((nobody) => app.removeFile(nobody, t.clip));
    expect(anon.rowCount).toBe(0);
    expect((await contents(q, t)).files).toEqual([t.clip]);

    expect(await remove(ids.studentA, t.clip)).toBe('1 row');
    expect((await contents(q, t)).files).toBeNull();
  }));

  it('the file of a reviewed, an archived or a past session stays: not removed, not replaced, not renamed', () => scenario(async (q) => {
    for (const [n, close] of [
      [0, async (t) => { await confirmAsAthlete(t.id); await sendFeedback(t.id); }],
      [1, (t) => archive(t.id)],
    ]) {
      const t = await train(n);
      await close(t);
      expect(await remove(ids.studentA, t.clip), `session ${n}`).toBe('0 rows');
      expect(await upload(ids.studentA, fileOf(ids.studentA, t.pullUp, '1-other.mp4')), `session ${n}`).toBe('refused');
      // No UPDATE policy, as before: a file is not overwritten or renamed.
      const renamed = await asUser(ids.studentA, (a) => a(`update storage.objects set name = name || '.bak' where name = $1`, [t.clip]));
      expect(renamed.rowCount).toBe(0);
      expect((await contents(q, t)).files).toEqual([t.clip]);
    }
    // The whole block, once it is no longer the one being trained.
    const open = await train(2);
    expect(await remove(ids.studentA, open.clip)).toBe('1 row');
    await asUser(ids.studentA, (a) => app.upload(a, open.clip));
    await pastBlock(q, ids.programA.id);
    expect(await remove(ids.studentA, open.clip)).toBe('0 rows');
    expect(await upload(ids.studentA, fileOf(ids.studentA, open.pullUp, '9-late.mp4'))).toBe('refused');
  }));

  it('reading is not gated by the session: the athlete reads their own files, the coach the files their athletes\' videos name, nobody else any', () => scenario(async () => {
    const t = await train(0);
    // An upload whose row never came: the athlete's file, and no video names it.
    await asUser(ids.studentA, (q) => app.upload(q, fileOf(ids.studentA, t.pullUp, '2-orphan.mp4')));
    await confirmAsAthlete(t.id);
    await sendFeedback(t.id);
    const sees = (as) => as((q) => q.value(`select count(*) from storage.objects where bucket_id = 'set-videos'`));
    expect(await sees((fn) => asUser(ids.studentA, fn))).toBe(2);
    // Migration 25: the coach reads the file the video names, not the other one.
    expect(await sees((fn) => asUser(ids.coach, fn))).toBe(1);
    expect(await sees((fn) => asUser(ids.studentB, fn))).toBe(0);
    expect(await sees((fn) => asUser(una, fn))).toBe(0);
    expect(await sees(asAnon)).toBe(0);
    expect(await sees(asService)).toBe(2);
  }));

  // What the deployed useUploadSetVideo does to replace a video, request by
  // request, on a session in progress and on a reviewed one.
  it('the deployed app replaces a video on a session in progress; on a reviewed one the upload fails and the old video stays', () => scenario(async (q) => {
    const replace = async (t, name) => asUser(ids.studentA, async (a) => {
      const existing = await a.one(`select id, storage_path from set_log_videos where set_log_id = $1`, [t.pullUp.setLogs[0]]);
      await app.removeFile(a, existing.storage_path);
      await a(`delete from set_log_videos where id = $1`, [existing.id]);
      const uploaded = await attempt(() => app.upload(a, name));
      if (!uploaded.ok) return uploaded.error.message;
      await app.addVideo(a, t.pullUp.setLogs[0], name);
      return 'replaced';
    });

    const open = await train(1);
    const newer = fileOf(ids.studentA, open.pullUp, '1-newer.mp4');
    expect(await replace(open, newer)).toBe('replaced');
    expect(await contents(q, open)).toMatchObject({ videos: [{ set: open.pullUp.setLogs[0], path: newer }], files: [newer] });

    const reviewed = await train(0);
    await confirmAsAthlete(reviewed.id);
    await sendFeedback(reviewed.id);
    const before = await contents(q, reviewed);
    expect(await replace(reviewed, fileOf(ids.studentA, reviewed.pullUp, '1-newer.mp4'))).toBe(RLS('objects'));
    expect(await contents(q, reviewed)).toEqual(before);
  }));
});

// ============================================================
// Everybody else
// ============================================================
describe('the coach, the service role and the owner are not concerned', () => {
  it('the coach works on a reviewed and archived session as before: editor, review, Adopt, Remove from upcoming, Decline', () => scenario(async (q) => {
    const t = await train(0);
    await asUser(ids.studentA, (a) => app.saveDeviation(a, ids.studentA, t.dip, 'swap', ids.exercises.squat));
    await asUser(ids.studentA, (a) => app.requestPromote(a, t.dip));
    await confirmAsAthlete(t.id);
    await sendFeedback(t.id);
    await archive(t.id);

    await asUser(ids.coach, async (c) => {
      // The editor: a target of a set to do, a set added, an unlogged one removed.
      expect((await c(`update set_logs set target_reps = 6 where id = $1`, [t.pullUp.setLogs[2]])).rowCount).toBe(1);
      expect((await c(
        `insert into set_logs (exercise_slot_id, set_number, target_reps, target_weight_kg) values ($1, 7, 5, 20)`, [t.pullUp.id],
      )).rowCount).toBe(1);
      expect((await c(`delete from set_logs where exercise_slot_id = $1 and set_number = 7`, [t.pullUp.id])).rowCount).toBe(1);
      // The review: everything the athlete left is read.
      expect(await c.one(
        `select (select count(*) from slot_comments where exercise_slot_id = $1) as notes,
                (select count(*) from slot_deviations where exercise_slot_id = $2) as deviations,
                (select count(*) from set_log_videos) as videos`, [t.pullUp.id, t.dip.id],
      )).toEqual({ notes: 1, deviations: 1, videos: 1 });
      // The athlete asked for the swap to be made permanent: the dialog's
      // count, then Decline — a write to slot_deviations of a closed session.
      expect(await c.value(`select public.adopt_swap($1, $2, true)`, [t.dip.id, ids.exercises.squat])).toEqual({ applied: 3, dry_run: true });
      expect(await c.value(`select public.decline_promote_request($1)`, [t.dip.id])).toEqual({ declined: true });
      expect(await c.value(`select public.adopt_swap($1, $2)`, [t.dip.id, ids.exercises.squat])).toMatchObject({ applied: 3 });
    });
    expect(await q.value(`select promote_requested_at from slot_deviations where exercise_slot_id = $1`, [t.dip.id])).toBeNull();
  }));

  it('the coach still writes no note, no swap and no video for an athlete — on any session', () => scenario(async (q) => {
    const t = await train(0);
    const before = await contents(q, t);
    const writes = everyWrite(t, ids.coach).filter(([what]) => !what.startsWith('a set:'));
    expect(await attemptAll(writes, ids.coach)).toEqual(REFUSED(writes));
    expect(await contents(q, t)).toEqual(before);
  }));

  it('the service role and the owner write a closed session', () => scenario(async (q) => {
    const t = await train(0);
    await confirmAsAthlete(t.id);
    await sendFeedback(t.id);
    for (const as of [asService, asAdmin]) {
      await as(async (who) => {
        expect((await who(`update set_logs set rpe = 9 where id = $1`, [t.pullUp.setLogs[0]])).rowCount).toBe(1);
        expect((await who(`update slot_comments set body = 'Corrected' where exercise_slot_id = $1`, [t.pullUp.id])).rowCount).toBe(1);
        expect((await who(`update slot_deviations set note = 'Corrected' where exercise_slot_id = $1`, [t.dip.id])).rowCount).toBe(1);
        expect((await who(`update set_log_videos set duration_ms = 1 where set_log_id = $1`, [t.pullUp.setLogs[0]])).rowCount).toBe(1);
        expect((await who(`update storage.objects set metadata = '{}' where name = $1`, [t.clip])).rowCount).toBe(1);
      });
    }
    expect(await q.value(`select rpe from set_logs where id = $1`, [t.pullUp.setLogs[0]])).toBe(9);
  }));

  // What runs inside the athlete's own request, on their behalf.
  it('confirming a session still stamps the day it was trained, and a swap still tells the coach', () => scenario(async (q) => {
    const t = await train(2);
    await confirmAsAthlete(t.id);
    expect(await q.value(`select performed_at is not null from sessions where id = $1`, [t.id])).toBe(true);
    expect(await q.value(
      `select count(*) from notifications where recipient_id = $1 and kind in ('session_completed', 'session_deviation')`,
      [ids.coach.id],
    )).toBe(2);
  }));

  // A draft has no set, and its author writes its sessions and exercises
  // through the draft policies: none of the five surfaces is reachable there.
  it('an athlete writes no set, note, swap or video in a draft of their own', () => scenario(async (q) => {
    const tree = {
      program: { id: await q.value(`select gen_random_uuid()`), name: 'My block' },
      weeks: [{ id: await q.value(`select gen_random_uuid()`), week_number: 1 }],
      sessions: [], slots: [],
    };
    tree.sessions.push({ id: await q.value(`select gen_random_uuid()`), week_id: tree.weeks[0].id, title: 'D1', sort_order: 0 });
    tree.slots.push({
      id: await q.value(`select gen_random_uuid()`), session_id: tree.sessions[0].id,
      exercise_id: ids.exercises.pullUp, sets: 3, reps: 5, sort_order: 0,
    });
    await asUser(ids.studentA, (a) => a(`select public.save_draft_tree($1)`, [tree]));
    const slot = { id: tree.slots[0].id };
    expect(await q.value(`select public.session_writable_for_slot($1)`, [slot.id])).toBe(true);
    expect(await outcome(() => asUser(ids.studentA, (a) => app.addExtraSet(a, slot, 1)))).toBe('refused');
    expect(await outcome(() => asUser(ids.studentA, (a) => app.saveComment(a, ids.studentA, slot, 'Note')))).toBe('refused');
    expect(await outcome(() => asUser(ids.studentA, (a) => app.saveDeviation(a, ids.studentA, slot, 'skip')))).toBe('refused');
    expect(await outcome(() => asUser(ids.studentA, (a) => app.upload(a, fileOf(ids.studentA, slot, '1-clip.mp4'))))).toBe('refused');
    // …and saves the draft again, which replaces its sessions and exercises.
    expect(await asUser(ids.studentA, (a) => a.value(`select public.save_draft_tree($1)`, [tree])))
      .toMatchObject({ sessions: 1, slots: 1 });
  }));
});

// ============================================================
// The migration file, on the production baseline
// ============================================================
describe('migration 08 applied to the production baseline', () => {
  const COACH = '00000000-0000-4000-8000-00000000c0ac';
  const ATHLETE = '00000000-0000-4000-8000-0000000000a1';
  const STRANGER = '00000000-0000-4000-8000-0000000000e1';
  const LINK = '00000000-0000-4000-8000-000000000101';
  const PULL_UP = '00000000-0000-4000-8000-000000000201';
  const PROGRAM = '00000000-0000-4000-8000-000000000301';
  const WEEK = '00000000-0000-4000-8000-000000000401';
  const REVIEWED = '00000000-0000-4000-8000-000000000451';
  const OPEN = '00000000-0000-4000-8000-000000000452';
  const ARCHIVED = '00000000-0000-4000-8000-000000000453';
  const SLOT_R = '00000000-0000-4000-8000-000000000501';
  const SLOT_O = '00000000-0000-4000-8000-000000000502';
  const SLOT_A = '00000000-0000-4000-8000-000000000503';
  const SET_R = '00000000-0000-4000-8000-000000000601';
  const SET_O = '00000000-0000-4000-8000-000000000602';
  const SET_A = '00000000-0000-4000-8000-000000000603';
  const FILE = `${ATHLETE}/${SLOT_R}/1-clip.mp4`;
  const TO_COME = '2099_01_01_99_a_migration_to_come';

  // A coach and their athlete, who trains a block of three sessions: the
  // first trained, confirmed and reviewed — with a note, a video and its
  // file —, the second in progress, the third archived with a skip in it.
  // And an account nobody coaches. The coach's role is set the way a dump
  // restore sets it: on the baseline the documented `update profiles set role
  // = 'coach'` is undone for every caller (finding P20, closed by migration 07).
  const WORLD = `
    insert into auth.users (id, email, aud, role, email_confirmed_at, raw_user_meta_data) values
      ('${COACH}',    'coach@sl.test', 'authenticated', 'authenticated', now(), '{"full_name": "Coach Carla"}'),
      ('${ATHLETE}',  'alex@sl.test',  'authenticated', 'authenticated', now(), '{"full_name": "Alex"}'),
      ('${STRANGER}', 'una@sl.test',   'authenticated', 'authenticated', now(), '{"full_name": "Una"}');
    BEGIN;
    SET LOCAL session_replication_role = replica;
    update public.profiles set role = 'coach' where id = '${COACH}';
    COMMIT;
    insert into public.students (id, profile_id, coach_id) values ('${LINK}', '${ATHLETE}', '${COACH}');
    insert into public.exercise_library (id, coach_id, name, type, difficulty)
      values ('${PULL_UP}', '${COACH}', 'Pull-up', 'pull', 2);

    insert into public.programs (id, student_id, name, is_active) values ('${PROGRAM}', '${LINK}', 'Block', true);
    insert into public.weeks (id, program_id, week_number) values ('${WEEK}', '${PROGRAM}', 1);
    insert into public.sessions (id, week_id, title, sort_order, reviewed_at, archived_at) values
      ('${REVIEWED}', '${WEEK}', 'S1', 0, '2026-10-01 10:00+00', null),
      ('${OPEN}',     '${WEEK}', 'S2', 1, null, null),
      ('${ARCHIVED}', '${WEEK}', 'S3', 2, null, '2026-10-02 10:00+00');
    insert into public.exercise_slots (id, session_id, exercise_id, sets, reps, weight_kg, sort_order) values
      ('${SLOT_R}', '${REVIEWED}', '${PULL_UP}', 3, 5, 20, 0),
      ('${SLOT_O}', '${OPEN}',     '${PULL_UP}', 3, 5, 20, 0),
      ('${SLOT_A}', '${ARCHIVED}', '${PULL_UP}', 3, 5, 20, 0);
    insert into public.set_logs (id, exercise_slot_id, set_number, target_reps, target_weight_kg) values
      ('${SET_R}', '${SLOT_R}', 1, 5, 20),
      ('${SET_O}', '${SLOT_O}', 1, 5, 20),
      ('${SET_A}', '${SLOT_A}', 1, 5, 20);
    insert into public.set_logs (exercise_slot_id, set_number, target_reps, target_weight_kg)
      select slot, n, 5, 20
        from unnest(array['${SLOT_R}', '${SLOT_O}', '${SLOT_A}']::uuid[]) as slot, generate_series(2, 3) as n;
    update public.set_logs set done = true, rpe = 8, logged_at = '2026-09-30 18:00+00' where exercise_slot_id = '${SLOT_R}';

    insert into public.session_confirmations (session_id, student_id, performed_on)
      values ('${REVIEWED}', '${ATHLETE}', '2026-09-30');
    insert into public.slot_comments (exercise_slot_id, student_id, body) values ('${SLOT_R}', '${ATHLETE}', 'Felt heavy');
    insert into public.slot_deviations (exercise_slot_id, student_id, kind) values ('${SLOT_A}', '${ATHLETE}', 'skip');
    insert into public.set_log_videos (set_log_id, storage_path, mime_type, size_bytes)
      values ('${SET_R}', '${FILE}', 'video/mp4', 1000);
    insert into storage.objects (bucket_id, name) values ('set-videos', '${FILE}');
  `;

  /** The frozen baseline with that world in it — and `more` of it — and the migrations before 08 applied. */
  const production = async (more = '') => {
    const db = await scratchDatabase();
    await db.runFile(manifest.baseline);
    await db.runSql(WORLD + more, 'world');
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
  const THE_STRANGER = user(STRANGER);
  const send = (db, { role, claims }, sql, end) => attempt(() => db.runSql(
    `BEGIN;
     select set_config('role', '${role}', true),
            set_config('request.jwt.claims', '${JSON.stringify(claims)}', true);
     ${sql};
     ${end};`,
    'request',
  ));
  // The answer of the last statement of the request — null when it reached no
  // row — or the sentence it was refused with.
  const answer = (tried) => {
    if (!tried.ok) return (tried.error.cause ?? tried.error).message;
    const [found] = tried.value.at(-2).rows;
    return found ? Object.values(found)[0] : null;
  };
  const request = async (db, actor, sql) => answer(await send(db, actor, sql, 'ROLLBACK'));
  /** The same, kept. */
  const committed = async (db, actor, sql) => answer(await send(db, actor, sql, 'COMMIT'));

  // The finding, one request of the athlete per surface, and L5.
  const HOLES = {
    'a set of the reviewed session is ticked off again':
      `update public.set_logs set done = false, rpe = null, logged_at = null where id = '${SET_R}' returning 'written'`,
    'a set of the archived session is logged':
      `update public.set_logs set done = true, logged_at = now() where id = '${SET_A}' returning 'written'`,
    'an extra set is added to the reviewed session':
      `insert into public.set_logs (exercise_slot_id, set_number, is_student_added, done, failed)
       values ('${SLOT_R}', 4, true, false, false) returning 'written'`,
    'the note of the reviewed session is rewritten':
      `update public.slot_comments set body = 'Easy' where exercise_slot_id = '${SLOT_R}' returning 'written'`,
    'the skip of the archived session is removed':
      `delete from public.slot_deviations where exercise_slot_id = '${SLOT_A}' returning 'written'`,
    'the skip of the archived session is turned into a request':
      `update public.slot_deviations set promote_requested_at = now() where exercise_slot_id = '${SLOT_A}' returning 'written'`,
    'the video of the reviewed session is removed':
      `delete from public.set_log_videos where set_log_id = '${SET_R}' returning 'written'`,
    'the video of the reviewed session is pointed at another file':
      `update public.set_log_videos set storage_path = 'somewhere/else.mp4' where set_log_id = '${SET_R}' returning 'written'`,
    'the file of the reviewed video is removed':
      `delete from storage.objects where bucket_id = 'set-videos' and name = '${FILE}' returning 'written'`,
    'a file is uploaded under the reviewed session':
      `insert into storage.objects (bucket_id, name) values ('set-videos', '${ATHLETE}/${SLOT_R}/2-late.mp4') returning 'written'`,
  };
  const UPLOAD_ANYTHING = `insert into storage.objects (bucket_id, name)
                           values ('set-videos', '${STRANGER}/whatever/film.mp4') returning 'written'`;
  const holes = async (db) => {
    const out = {};
    for (const [what, sql] of Object.entries(HOLES)) out[what] = await request(db, THE_ATHLETE, sql);
    out['an account nobody coaches uploads a file'] = await request(db, THE_STRANGER, UPLOAD_ANYTHING);
    return out;
  };
  const OPEN_HOLES = Object.fromEntries([...Object.keys(HOLES), 'an account nobody coaches uploads a file'].map((what) => [what, 'written']));
  const REFUSAL_OF = (sql) => {
    if (!/^\s*insert/.test(sql)) return null;
    return `new row violates row-level security policy for table "${/into (?:public|storage)\.(\w+)/.exec(sql)[1]}"`;
  };
  const CLOSED_HOLES = {
    ...Object.fromEntries(Object.entries(HOLES).map(([what, sql]) => [what, REFUSAL_OF(sql)])),
    'an account nobody coaches uploads a file': REFUSAL_OF(UPLOAD_ANYTHING),
  };

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
  // A query the page gives as a command, by a table only that one reads.
  const queryAbout = (table) => commands
    .map((command) => /^supabase db query --linked "(select [^"]+)"$/.exec(command)?.[1])
    .find((sql) => sql?.includes(table));
  /** The text under a `## ` heading of the page. */
  const sectionOf = (title) => page.split(/^## /m).find((part) => part.startsWith(`${title}\n`));
  const PROTECTED = 'check only, nothing was written: protected: the athlete writes a set of a session in progress, and not one of a reviewed session';

  const printedAudit = async (db) => {
    const [result] = await db.readOnly(read(migration.paths.audit), 'audit');
    return Object.fromEntries(result.rows.map((line) => [line.check, line.value]));
  };
  const LINE = {
    sets: 'an athlete writes a set only while its session is neither archived nor reviewed (P58)',
    notes: '… and a note on an exercise',
    deviations: '… and a swap or a skip of an exercise',
    videos: '… and the video of a set',
    files: '… and the file of that video, which goes under an exercise of their own (L5)',
    stored: 'a video is stored under its athlete and the exercise of its set',
    callable: 'functions of this migration a signed-in user may execute',
    strangers: 'policies that write these tables and that the migration does not know',
    reviewed: 'reviewed sessions of a block being trained, not archived',
    unconfirmed: '… of which their athlete has not confirmed',
    lacking: '… of which lack a set their exercise prescribes',
    count: 'videos',
  };
  const GATED = [LINE.sets, LINE.notes, LINE.deviations, LINE.videos, LINE.files, LINE.stored];
  const gates = (value) => Object.fromEntries(GATED.map((line) => [line, value]));

  it('the holes are there before, closed after, and back after the rollback', async () => {
    const db = await production();
    expect(await holes(db)).toEqual(OPEN_HOLES);

    await db.runFile(migration.paths.migration);
    expect(await holes(db)).toEqual(CLOSED_HOLES);

    // The app that is deployed today, on the session in progress: as before.
    const tick = `update public.set_logs set done = true, failed = false, logged_at = now(), failed_at = null where id = '${SET_O}' returning done`;
    expect(await request(db, THE_ATHLETE, tick)).toBe(true);
    expect(await request(db, THE_ATHLETE, `insert into public.set_logs (exercise_slot_id, set_number, is_student_added, done, failed) values ('${SLOT_O}', 4, true, false, false) returning is_student_added`)).toBe(true);
    expect(await request(db, THE_ATHLETE,
      `insert into public.slot_comments (exercise_slot_id, student_id, body, updated_at) values ('${SLOT_O}', '${ATHLETE}', 'Good', now())
       on conflict (exercise_slot_id) do update set student_id = excluded.student_id, body = excluded.body, updated_at = excluded.updated_at
       returning body`)).toBe('Good');
    expect(await request(db, THE_ATHLETE,
      `insert into public.slot_deviations (exercise_slot_id, student_id, kind, updated_at) values ('${SLOT_O}', '${ATHLETE}', 'skip', now())
       on conflict (exercise_slot_id) do update set kind = excluded.kind, updated_at = excluded.updated_at returning kind`)).toBe('skip');
    expect(await request(db, THE_ATHLETE,
      `insert into storage.objects (bucket_id, name) values ('set-videos', '${ATHLETE}/${SLOT_O}/1-clip.mp4');
       insert into public.set_log_videos (set_log_id, storage_path, mime_type, size_bytes)
       values ('${SET_O}', '${ATHLETE}/${SLOT_O}/1-clip.mp4', 'video/mp4', 1000) returning storage_path`)).toBe(`${ATHLETE}/${SLOT_O}/1-clip.mp4`);
    // …confirmed, it is still written: the gate is the review.
    expect(await request(db, THE_ATHLETE,
      `insert into public.session_confirmations (session_id, student_id, performed_on) values ('${OPEN}', '${ATHLETE}', current_date);
       ${tick}`)).toBe(true);
    // …and reviewed in the same breath, it no longer is.
    expect(await request(db, THE_COACH,
      `update public.sessions set reviewed_at = now() where id = '${OPEN}' and reviewed_at is null;
       select set_config('request.jwt.claims', '${JSON.stringify(THE_ATHLETE.claims)}', true);
       ${tick}`)).toBeNull();
    // Reading, and the coach: as before.
    expect(await request(db, THE_ATHLETE,
      `select (select count(*) from public.set_logs) + (select count(*) from public.slot_comments)
            + (select count(*) from public.slot_deviations) + (select count(*) from public.set_log_videos)
            + (select count(*) from storage.objects)`)).toBe(9 + 1 + 1 + 1 + 1);
    expect(await request(db, THE_COACH, `update public.set_logs set target_reps = 6 where id = '${SET_A}' returning target_reps`)).toBe(6);
    expect(await request(db, THE_COACH, `select count(*) from storage.objects`)).toBe(1);
    // Nothing above was kept, and the migration itself touches no row.
    expect(await db.query.one(
      `select (select count(*) from public.set_logs) as sets, (select count(*) from public.slot_comments) as notes,
              (select count(*) from public.slot_deviations) as deviations, (select count(*) from public.set_log_videos) as videos,
              (select count(*) from storage.objects) as files,
              (select count(*) from public.sessions where reviewed_at is not null) as reviewed`,
    )).toEqual({ sets: 9, notes: 1, deviations: 1, videos: 1, files: 1, reviewed: 1 });

    await db.runFile(migration.paths.rollback);
    expect(await holes(db)).toEqual(OPEN_HOLES);
    await db.drop();
  });

  it('adds 4 functions, replaces 11 policies and makes the one on videos four, signs the ledger — no table, no column, no trigger', async () => {
    const db = await production();
    const before = await catalogSnapshot(db.query);
    await db.runFile(migration.paths.migration);
    const after = await catalogSnapshot(db.query);

    const lines = diffCatalogs(before, after, { left: 'before', right: 'after' });
    const only = (side) => lines.filter((line) => line.endsWith(`: only in ${side}`))
      .map((line) => line.slice(0, -`: only in ${side}`.length)).sort();
    expect(only('after')).toEqual([
      'functions public.session_writable(sess_id uuid)',
      'functions public.session_writable_for_slot(slot_id uuid)',
      'functions public.set_video_slot(object_name text)',
      'functions public.slot_for_set_log(log_id uuid)',
      'policies public.set_log_videos.Students delete own set log videos',
      'policies public.set_log_videos.Students insert own set log videos',
      'policies public.set_log_videos.Students read own set log videos',
      'policies public.set_log_videos.Students update own set log videos',
    ]);
    expect(only('before')).toEqual(['policies public.set_log_videos.Students manage own set log videos']);
    const changed = lines.filter((line) => !/: only in (before|after)$/.test(line))
      .map((line) => /^(.*?): \w+: /.exec(line)[1]);
    expect([...new Set(changed)].sort()).toEqual([
      'data rows of app_private.app_migrations',
      'policies public.set_logs.Students delete own set logs',
      'policies public.set_logs.Students insert own set logs',
      'policies public.set_logs.Students update own set logs',
      'policies public.slot_comments.Students delete own slot comments',
      'policies public.slot_comments.Students insert own slot comments',
      'policies public.slot_comments.Students update own slot comments',
      'policies public.slot_deviations.Students delete own slot deviations',
      'policies public.slot_deviations.Students insert own slot deviations',
      'policies public.slot_deviations.Students update own slot deviations',
      'policies storage.objects.Students delete own set videos',
      'policies storage.objects.Students upload own set videos',
    ]);

    // The four functions: who may execute them, and how they run.
    const OPEN_TO_USERS = ['authenticated: EXECUTE', 'postgres: EXECUTE', 'service_role: EXECUTE'];
    const CLOSED = ['postgres: EXECUTE', 'service_role: EXECUTE'];
    for (const [key, privileges, definer, volatility] of [
      ['public.session_writable(sess_id uuid)', CLOSED, true, 'STABLE'],
      ['public.session_writable_for_slot(slot_id uuid)', OPEN_TO_USERS, true, 'STABLE'],
      ['public.slot_for_set_log(log_id uuid)', OPEN_TO_USERS, true, 'STABLE'],
      ['public.set_video_slot(object_name text)', OPEN_TO_USERS, false, 'IMMUTABLE'],
    ]) {
      const fn = after.functions[key];
      expect(fn.privileges, key).toEqual(privileges);
      expect(fn.owner, key).toBe('postgres');
      expect(fn.definition, key).toContain(`\n SET search_path TO 'public', 'pg_temp'\n`);
      expect(fn.definition.includes('SECURITY DEFINER'), key).toBe(definer);
      expect(fn.definition, key).toMatch(new RegExp(`\\n ${volatility}\\b`));
    }
    // The policies that read, and the coach's, are the ones from before.
    for (const key of Object.keys(before.policies)) {
      if (/\.(Coaches |Students read )/.test(key)) expect(after.policies[key], key).toEqual(before.policies[key]);
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
    expect(rows.map((line) => line.n)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
    // Written between back-ticks: a value the page gives exactly. The others
    // are a number and a sentence about production's sessions and videos.
    const exact = rows.filter((line) => /^`.+`$/.test(line.before) && /^`.+`$/.test(line.after))
      .map((line) => ({ ...line, before: line.before.slice(1, -1), after: line.after.slice(1, -1) }));
    expect(rows.filter((line) => !exact.some((e) => e.n === line.n)).map((line) => line.check)).toEqual([LINE.reviewed, LINE.count]);
    const onPage = (column) => [
      ...exact.map((line) => [line.n, line.check, line[column]]),
      [12, LINE.reviewed, '1'],
      [15, LINE.count, '1 video(s), 0 of them stored elsewhere than under their athlete and exercise'],
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

  it('the page\'s check answers NOT PROTECTED before, protected after, BROKEN when a session in progress cannot be written — and writes nothing', async () => {
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
      `select (select count(*) from public.set_logs where logged_at is not null) as logged, current_user::text as role,
              coalesce(current_setting('request.jwt.claims', true), '') as claims`,
    );
    const untouched = { logged: 3, role: 'postgres', claims: '' };

    expect(await checked()).toBe('check only, nothing was written: NOT PROTECTED: the athlete wrote a set of a reviewed session');
    expect(await state()).toEqual(untouched);

    await db.runFile(migration.paths.migration);
    expect(await checked()).toBe(PROTECTED);
    expect(await state()).toEqual(untouched);
    // What the page says the command prints.
    expect(page).toContain(`\`${PROTECTED}\``);
    expect(page).toContain('`… NOT PROTECTED: the athlete wrote a set of a reviewed session`');
    expect(page).toContain('`… BROKEN: the athlete cannot write a set of a session in progress`');

    // The thing to roll back for: an athlete who can no longer log a set.
    await db.query(`alter policy "Students update own set logs" on public.set_logs using (false)`);
    expect(await checked()).toBe('check only, nothing was written: BROKEN: the athlete cannot write a set of a session in progress');
    expect(await state()).toEqual(untouched);

    // With no athlete who has both kinds of session there is nothing to try,
    // and it says so.
    await db.query(`update public.sessions set reviewed_at = null`);
    const NOTHING = 'check only: no athlete has both a reviewed session and one in progress in the block they are training, nothing to try';
    expect(await checked()).toBe(NOTHING);
    expect(page).toContain(`\`${NOTHING}\` is no answer either way`);
    await db.drop();
  });

  // The page of migration 06 has a check of its own: as an athlete, it marks
  // one of their prescribed sets as an extra one, to see the pin hold. From
  // this migration on an athlete's update reaches no row of a reviewed
  // session — and here the first set there is sits in one.
  it('the check of the page of migration 06 still tries: it takes a set of a session in progress', async () => {
    const db = await production();
    await db.runFile(migration.paths.migration);
    const earlier = read(manifest.migrations.find((m) => m.order === 6).paths.runbook);
    const [, check] = /^ *supabase db query --linked '(do \$check\$[\s\S]+?\$check\$)'$/m.exec(earlier) ?? [];
    expect(check, 'the page of migration 06 no longer gives its check').toBeTruthy();
    const said = await attempt(() => db.runSql(check.split('\n').map((line) => line.replace(/^ {3}/, '')).join('\n'), 'page check of 06'));
    expect((said.error?.cause ?? said.error)?.message)
      .toBe('check only, nothing was written: protected: the set is still a prescribed one');
    // The set it would have taken before: the first one, of the reviewed session.
    expect(await db.query.value(`select id from public.set_logs where not is_student_added order by id limit 1`)).toBe(SET_R);
    expect(await request(db, THE_ATHLETE, `update public.set_logs set is_student_added = true where id = '${SET_R}' returning 'written'`)).toBeNull();
    await db.drop();
  });

  // "Letting an athlete write a reviewed session again": the two statements
  // the page gives.
  it('from the SQL editor: the page\'s statements open a reviewed session for its athlete, and close it again', async () => {
    const db = await production();
    await db.runFile(migration.paths.migration);
    const tick = `update public.set_logs set rpe = 9 where id = '${SET_R}' returning rpe`;
    expect(await request(db, THE_ATHLETE, tick)).toBeNull();

    const reopen = inline('update public.sessions set reviewed_at = null');
    expect(reopen, 'the page no longer gives the statement').toBe(
      `update public.sessions set reviewed_at = null where id = '<id of the session>'`,
    );
    expect((await db.query(reopen.replace('<id of the session>', REVIEWED))).rowCount).toBe(1);
    expect(await request(db, THE_ATHLETE, tick)).toBe(9);
    expect((await printedAudit(db))[LINE.reviewed]).toBe('0');

    const close = inline('update public.sessions set reviewed_at = now()');
    expect(close, 'the page no longer gives the statement').toBe(
      `update public.sessions set reviewed_at = now() where id = '<id of the session>'`,
    );
    expect((await db.query(close.replace('<id of the session>', REVIEWED))).rowCount).toBe(1);
    expect(await request(db, THE_ATHLETE, tick)).toBeNull();

    // An archived one is restored by the coach, in the app.
    const log = `update public.set_logs set done = true, logged_at = now() where id = '${SET_A}' returning done`;
    expect(await request(db, THE_ATHLETE, log)).toBeNull();
    expect(await committed(db, THE_COACH, `update public.sessions set archived_at = null where id = '${ARCHIVED}' returning archived_at is null`)).toBe(true);
    expect(await request(db, THE_ATHLETE, log)).toBe(true);
    await db.drop();
  });

  // Line 13 of the audit. The coach app that is deployed reviews a session
  // whose athlete has not confirmed it: its review page shows the feedback box
  // and "Finish without feedback" either way, and the notification of a swap
  // or a skip leads there while the athlete is still training. The athlete app
  // that is deployed goes by the confirmation: such a session is in the list
  // as still to do, and opens with nothing locked. So this is where an athlete
  // meets the lock on a screen that is NOT out of date — and where "a set no
  // longer saves on a session in progress", the page's reason to roll back, is
  // what the owner hears. The page has to tell the two apart.
  it('a session reviewed before its athlete confirmed it: counted, listed by the page\'s query, refused to the app as the page says, opened by the page\'s statement — and not the rollback case', async () => {
    const UNCONFIRMED = '00000000-0000-4000-8000-000000000454';
    const SLOT_U = '00000000-0000-4000-8000-000000000504';
    const SLOT_SKIPPED = '00000000-0000-4000-8000-000000000505';
    const SET_U = '00000000-0000-4000-8000-000000000604';
    // S4, two exercises of 3 sets: the athlete skipped the second and logged
    // one set of the first. The coach opened the review from the notification
    // of the skip, and finished without feedback. No confirmation.
    const db = await production(`
      insert into public.sessions (id, week_id, title, sort_order, reviewed_at)
        values ('${UNCONFIRMED}', '${WEEK}', 'S4', 3, '2026-10-05 12:00+00');
      insert into public.exercise_slots (id, session_id, exercise_id, sets, reps, weight_kg, sort_order) values
        ('${SLOT_U}',       '${UNCONFIRMED}', '${PULL_UP}', 3, 5, 20, 0),
        ('${SLOT_SKIPPED}', '${UNCONFIRMED}', '${PULL_UP}', 3, 5, 20, 1);
      insert into public.set_logs (exercise_slot_id, set_number, target_reps, target_weight_kg)
        select slot, n, 5, 20
          from unnest(array['${SLOT_U}', '${SLOT_SKIPPED}']::uuid[]) as slot, generate_series(1, 3) as n
         where (slot, n) <> ('${SLOT_U}', 2);
      insert into public.set_logs (id, exercise_slot_id, set_number, target_reps, target_weight_kg)
        values ('${SET_U}', '${SLOT_U}', 2, 5, 20);
      update public.set_logs set done = true, rpe = 7, logged_at = '2026-10-05 09:00+00'
       where exercise_slot_id = '${SLOT_U}' and set_number = 1;
      insert into public.slot_deviations (exercise_slot_id, student_id, kind) values ('${SLOT_SKIPPED}', '${ATHLETE}', 'skip');
    `);
    // Two reviewed sessions of the block being trained; one of them — not S1,
    // which is confirmed — has no confirmation. Neither lacks a set.
    const COUNTED = { [LINE.reviewed]: '2', [LINE.unconfirmed]: '1', [LINE.lacking]: '0' };
    expect(await printedAudit(db)).toMatchObject(COUNTED);

    // The query of the page lists that session, and no other.
    const anchor = '](#sessions-reviewed-that-their-athlete-has-not-confirmed)';
    const section = sectionOf('Sessions reviewed that their athlete has not confirmed');
    expect(section, 'the page no longer has the section of line 13').toBeTruthy();
    const listing = queryAbout('session_confirmations');
    expect(listing, 'the page no longer gives the query').toBeTruthy();
    expect(section).toContain(`supabase db query --linked "${listing}"`);
    const listed = async () => (await db.readOnly(listing, 'page query')).at(-1).rows;
    const ROW = {
      session_id: UNCONFIRMED, athlete: 'Alex', block: 'Block', session: 'S4',
      reviewed_on: '2026-10-05', feedback_sent: false, sets_logged: '1 of 6',
    };
    expect(await listed()).toEqual([ROW]);

    // What the app that is deployed sends from that screen, which shows the
    // session open: a set ticked, a note, the skip offered to the coach as
    // permanent — and the confirmation.
    const SENT = {
      'a set is ticked':
        `update public.set_logs set done = true, failed = false, logged_at = now(), failed_at = null where id = '${SET_U}' returning 'written'`,
      'a note is written':
        `insert into public.slot_comments (exercise_slot_id, student_id, body, updated_at) values ('${SLOT_U}', '${ATHLETE}', 'Heavy', now())
         on conflict (exercise_slot_id) do update set student_id = excluded.student_id, body = excluded.body, updated_at = excluded.updated_at
         returning 'written'`,
      'the coach is asked to make the skip permanent':
        `update public.slot_deviations set promote_requested_at = now() where exercise_slot_id = '${SLOT_SKIPPED}' returning 'written'`,
      'the session is confirmed':
        `insert into public.session_confirmations (session_id, student_id, notes, performed_on) values ('${UNCONFIRMED}', '${ATHLETE}', null, current_date)
         on conflict (session_id) do update set student_id = excluded.student_id, notes = excluded.notes, performed_on = excluded.performed_on
         returning 'written'`,
    };
    const sent = async () => {
      const out = {};
      for (const [what, sql] of Object.entries(SENT)) out[what] = await request(db, THE_ATHLETE, sql);
      return out;
    };
    const ALL_WRITTEN = Object.fromEntries(Object.keys(SENT).map((what) => [what, 'written']));
    expect(await sent()).toEqual(ALL_WRITTEN);

    await db.runFile(migration.paths.migration);
    // The migration changes neither number, and the list is the same.
    expect(await printedAudit(db)).toMatchObject(COUNTED);
    expect(await listed()).toEqual([ROW]);
    expect(await sent()).toEqual({
      // `.update(…).select().single()` on no row: errors.generic.
      'a set is ticked': null,
      // 42501: errors.notAllowed.
      'a note is written': 'new row violates row-level security policy for table "slot_comments"',
      // A bare `.update()`: no row, no error, and no notification for the coach.
      'the coach is asked to make the skip permanent': null,
      // Not one of the five surfaces: the way out the app leaves the athlete.
      'the session is confirmed': 'written',
    });
    // …which is what the page tells the owner the athlete sees there,
    expect(section).toContain('each set they tick answers "Couldn\'t save that. Please try again." and goes back to what it was');
    expect(section).toContain('a note, a swap, a skip or an extra set answers "You don\'t have permission to do that."');
    expect(section).toContain('*Confirm session* still works');
    expect(page).toContain('| asks the coach to make a swap or a skip permanent | nothing: no message, the button is back a moment later — and **the coach is not told** |');
    // where the entry of line 13, the smoke check and the rollback send them,
    expect(page).toContain(`- **13** is not \`0\` — **before you apply, go to [Sessions reviewed that their athlete has not confirmed${anchor}.**`);
    expect(sectionOf('After')).toContain(anchor);
    const rollback = sectionOf('Rollback');
    expect(rollback).toContain('is not that case when the session is a reviewed one — check before you roll back');
    expect(rollback).toContain(anchor);
    expect(section).toContain('**This is not the case the rollback is for.**');
    // and the check of the page agrees: with that session in the world it
    // answers `protected`, not the `BROKEN` the rollback is for.
    const checked = await attempt(() => db.runSql(pageCheck, 'page check'));
    expect((checked.error?.cause ?? checked.error)?.message).toBe(PROTECTED);

    // What the section sends the owner to: the review taken back, with the
    // session_id of the row. The session is then written like any other,
    expect(section).toContain('](#letting-an-athlete-write-a-reviewed-session-again)');
    const reopen = inline('update public.sessions set reviewed_at = null');
    expect((await db.query(reopen.replace('<id of the session>', ROW.session_id))).rowCount).toBe(1);
    expect(await sent()).toEqual(ALL_WRITTEN);
    expect(await printedAudit(db)).toMatchObject({ [LINE.reviewed]: '1', [LINE.unconfirmed]: '0' });
    expect(await listed()).toEqual([]);
    // and S1, reviewed and confirmed, stays closed.
    expect(await request(db, THE_ATHLETE, `update public.set_logs set rpe = 9 where id = '${SET_R}' returning 'written'`)).toBeNull();

    // The other way out of the list, for a session its athlete has trained:
    // they confirm it. It stays closed — and is no longer one of line 13.
    const close = inline('update public.sessions set reviewed_at = now()');
    expect((await db.query(close.replace('<id of the session>', ROW.session_id))).rowCount).toBe(1);
    expect(await printedAudit(db)).toMatchObject(COUNTED);
    expect(await committed(db, THE_ATHLETE, SENT['the session is confirmed'])).toBe('written');
    expect(await printedAudit(db)).toMatchObject({ [LINE.reviewed]: '2', [LINE.unconfirmed]: '0' });
    expect(await listed()).toEqual([]);
    expect(await request(db, THE_ATHLETE, SENT['a set is ticked'])).toBeNull();
    await db.drop();
  });

  // Line 14 of the audit, what the page says of it, and its statement.
  it('a reviewed session that lacks a prescribed set: counted, refused to the app from then on, and filled by the page\'s statement', async () => {
    const db = await production();
    // An exercise that says 4 sets and holds 3, and one set that was never created.
    await db.query(`update public.exercise_slots set sets = 4 where id = '${SLOT_R}'`);
    await db.query(`delete from public.set_logs where exercise_slot_id = '${SLOT_A}' and set_number = 3`);
    expect(await printedAudit(db)).toMatchObject({ [LINE.reviewed]: '1', [LINE.lacking]: '1' });

    // What the deployed app sends when the athlete opens the session.
    const ensure = `insert into public.set_logs (exercise_slot_id, set_number, done, target_reps, target_duration_seconds, target_weight_kg, target_rest_seconds)
                    values ('${SLOT_R}', 4, false, 5, null, 20, null) returning 'written'`;
    expect(await request(db, THE_ATHLETE, ensure)).toBe('written');
    await db.runFile(migration.paths.migration);
    expect(await request(db, THE_ATHLETE, ensure)).toBe('new row violates row-level security policy for table "set_logs"');
    expect(page).toContain('the athlete reads "You don\'t have permission to do that." when opening it');
    expect((await printedAudit(db))[LINE.lacking]).toBe('1');

    const [fill] = fences('sql');
    expect(fill, 'the page no longer gives the statement').toMatch(/^insert into public\.set_logs /);
    const added = await db.query(fill);
    // The reviewed session of the block being trained — not the archived one.
    expect(added.rows).toEqual([{ exercise_slot_id: SLOT_R, set_number: 4 }]);
    expect(await db.query.one(
      `select target_reps, target_weight_kg, done, is_student_added from public.set_logs
        where exercise_slot_id = '${SLOT_R}' and set_number = 4`,
    )).toEqual({ target_reps: 5, target_weight_kg: 20, done: false, is_student_added: false });
    expect((await printedAudit(db))[LINE.lacking]).toBe('0');
    // Nothing left for the app to add: opening the session sends no insert.
    expect((await db.query(fill)).rows).toEqual([]);
    await db.drop();
  });

  // Line 15 of the audit.
  it('a video stored elsewhere than under its athlete and exercise is counted, and left', async () => {
    const db = await production();
    await db.query(
      `insert into public.set_log_videos (set_log_id, storage_path, mime_type, size_bytes)
       values ('${SET_O}', '${ATHLETE}/${SLOT_R}/9-elsewhere.mp4', 'video/mp4', 1), ('${SET_A}', 'by-hand.mp4', 'video/mp4', 1)`,
    );
    const SENTENCE = '3 video(s), 2 of them stored elsewhere than under their athlete and exercise';
    expect((await printedAudit(db))[LINE.count]).toBe(SENTENCE);
    await db.runFile(migration.paths.migration);
    expect((await printedAudit(db))[LINE.count]).toBe(SENTENCE);
    expect(await request(db, THE_ATHLETE, `select count(*) from public.set_log_videos`)).toBe(3);
    await db.drop();
  });

  // Line 11 of the audit: a rule made by hand, under a name the file does not
  // replace, would stay next to the new ones — and policies add up.
  it('a write policy it does not know: named by the audit, and the migration undoes itself', async () => {
    for (const [byHand, named, said] of [
      [`create policy "By hand" on public.slot_comments for update using (student_id = auth.uid())`,
        'public.slot_comments: By hand', 'public.slot_comments has the policy "By hand" for UPDATE, which this migration does not know'],
      [`create policy "Anything goes" on storage.objects for all to authenticated using (bucket_id = 'set-videos')`,
        'storage.objects: Anything goes', 'storage.objects has the policy "Anything goes" for ALL, which this migration does not know'],
    ]) {
      const db = await production();
      await db.query(byHand);
      expect((await printedAudit(db))[LINE.strangers]).toBe(named);
      const before = await catalogSnapshot(db.query);
      const refused = await attempt(() => db.runFile(migration.paths.migration));
      expect(refused.error?.message).toContain(`migration ${MIGRATION} did not get the policies it meant: ${said}`);
      expect(diffCatalogs(before, await catalogSnapshot(db.query), { left: 'before', right: 'after' })).toEqual([]);
      expect(await db.query.value(`select count(*) from ${LEDGER} where name = $1`, [MIGRATION])).toBe(0);
      await db.drop();
    }
    expect(page).toContain('**11** is not `none` — **stop and report the line.**');
  });

  it('a gate that is there and does not ask is not "yes" for the audit', async () => {
    const db = await production();
    expect(await printedAudit(db)).toMatchObject({ ...gates('no'), [LINE.callable]: 'none', [LINE.strangers]: 'none' });
    await db.runFile(migration.paths.migration);
    expect(await printedAudit(db)).toMatchObject({
      ...gates('yes'),
      [LINE.callable]: 'session_writable_for_slot(uuid); set_video_slot(text); slot_for_set_log(uuid)',
      [LINE.strangers]: 'none',
    });

    await db.query(`alter policy "Students update own set logs" on public.set_logs
                      using (public.student_profile_for_slot(exercise_slot_id) = auth.uid())`);
    await db.query(`drop policy "Students delete own slot deviations" on public.slot_deviations`);
    await db.query(`alter policy "Students insert own set log videos" on public.set_log_videos
                      with check (public.session_writable_for_slot(public.slot_for_set_log(set_log_id)))`);
    expect(await printedAudit(db)).toMatchObject({
      ...gates('yes'), [LINE.sets]: 'no', [LINE.deviations]: 'no', [LINE.stored]: 'no',
    });
    await db.drop();
  });

  it('without migration 07 it says so (SLM02), and its rollback says there is nothing to undo (SLM03)', async () => {
    const db = await scratchDatabase();
    await db.runFile(manifest.baseline);
    const refusals = async () => {
      const before = await catalogSnapshot(db.query);
      const refused = await attempt(() => db.runFile(migration.paths.migration));
      const undone = await attempt(() => db.runFile(migration.paths.rollback));
      expect(diffCatalogs(before, await catalogSnapshot(db.query), { left: 'before', right: 'after' })).toEqual([]);
      return [refused.error?.code, refused.error?.message, undone.error?.code];
    };
    // Without a ledger at all, then with the ledger and the migrations before 07 only.
    const needs = 'needs 2026_10_11_07_profile_rules, which is not applied';
    let [code, message, undone] = await refusals();
    expect([code, undone]).toEqual([REFUSAL.predecessorMissing, REFUSAL.notApplied]);
    expect(message).toContain(needs);
    for (const earlier of manifest.migrations.slice(0, 6)) await db.runFile(earlier.paths.migration);
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
    // A session_writable made by hand, with a second argument: a caller
    // could reach it instead of the one the policies are written with.
    await db.query(`create function public.session_writable(sess_id uuid, p_who uuid) returns boolean language sql as 'select true'`);
    expect(await refusal()).toContain(`migration ${MIGRATION} would not replace: session_writable(uuid,uuid)`);
    await db.query(`drop function public.session_writable(uuid, uuid)`);

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
       create function public.session_writable(sess_id uuid) returns boolean language sql as 'select true';
       grant execute on function public.session_writable(uuid) to service_role with grant option;
       set local role service_role;
       grant execute on function public.session_writable(uuid) to anon;
       COMMIT;`,
      'a function made by hand, opened by another role',
    );
    const before = await catalogSnapshot(db.query);
    const refused = await attempt(() => db.runFile(migration.paths.migration));
    expect(refused.error?.message).toContain(
      `migration ${MIGRATION} did not get the functions it meant: public.session_writable(uuid): anon may execute it`,
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
    expect(await holes(db)).toEqual(CLOSED_HOLES);
    await db.drop();
  });
});
