// A review needs a confirmation, and closes it — review finding P57 and the
// server half of L12, closed by migration 2026_10_13_09_review_lifecycle.
//
// A confirmation ("I have trained this session") and a review ("I have read
// it", with feedback or without) were two facts nothing tied together. Since
// the migration:
//
//   a review closes the confirmation   the athlete's UPDATE and DELETE policies
//                                      ask session_writable(session) — and
//                                      block_confirmation_delete_when_reviewed
//                                      holds when a DELETE and a review cross
//   a review needs a confirmation      trg_review_needs_confirmation on
//                                      sessions, and the INSERT policy of
//                                      messages (session_is_confirmed)
//   what is taken back takes its       two AFTER DELETE triggers, on
//   unread notifications with it       session_confirmations and slot_deviations
//   the push of a confirmation         tagged by session
//
// The refusals have three shapes, and the tests name which: an UPDATE or a
// DELETE that a policy refuses reaches no row and says nothing; an INSERT —
// an updating upsert included — raises 42501 from the policy; and the two
// triggers raise 42501 with a sentence of their own. So a test about a
// refused write shows the same statement going through first, and reads the
// rows back.
//
// The first blocks run against schema.sql, as the callers the app has. Two
// apps send a confirmation: the one deployed before wave 1 (an upsert that
// UPDATES the row it meets) and the one of wave 1 (insert or nothing) — the
// migration is applied while the first is live. Three tests need three
// connections: they are about two requests that cross. The last block
// applies the migration file itself to the frozen production baseline, with
// the checks and the statements of its runbook page read off the page.

import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  asAdmin, asAnon, asService, asUser, attempt, createDraftProgram, createProgram, createUser, enablePush,
  httpCalls, repoRoot, scenario, scratchDatabase, seed,
} from './harness.js';
import { catalogSnapshot, diffCatalogs } from './catalog.js';
import { LEDGER, loadManifest, REFUSAL } from '../migrations/manifest.js';

const MIGRATION = '2026_10_13_09_review_lifecycle';
const manifest = loadManifest();
const migration = manifest.migrations.find((m) => m.name === MIGRATION);
const read = (file) => fs.readFileSync(path.join(repoRoot, file), 'utf8');

// seed(): coach Carla; athlete A with the active Block A (2 weeks × 2
// sessions, each a pull-up slot and a dip slot of 3 sets); athlete B with the
// active Block B. Una is an account nobody coaches. Rae is a third athlete of
// the coach, with a block of her own: the three tests on several connections
// commit what they write, and write it there.
let ids;
let una;
let rae;
let raceBlock;
beforeAll(async () => {
  ids = await seed();
  una = await createUser({ email: 'una@sl.test', fullName: 'Una Unlinked' });
  rae = await createUser({ email: 'rae@sl.test', fullName: 'Rae Racer', coach: ids.coach });
  raceBlock = await createProgram({
    student: rae, name: 'Block R', exercises: [ids.exercises.pullUp], sessions: 3, active: true,
  });
});

/** Session n of athlete A's block: `{ id, weekId, pullUp, dip }`, each slot `{ id, setLogs }`. */
const session = (n) => {
  const week = ids.programA.tree[Math.floor(n / 2)];
  const { id, slots: [pullUp, dip] } = week.sessions[n % 2];
  return { id, weekId: week.id, pullUp, dip };
};

const RLS = (table) => `new row violates row-level security policy for table "${table}"`;
const RLS_USING = (table) => `new row violates row-level security policy (USING expression) for table "${table}"`;
const NOT_CONFIRMED = (sessionId) => `session ${sessionId} is not confirmed by its athlete — it cannot be marked as reviewed`;
const REVIEWED = (sessionId) => `session ${sessionId} has been reviewed by the coach — its confirmation cannot be taken back`;

// ------------------------------------------------------------
// The app, as SQL. `run` is a `q`, or its `q.dryRun` when the statement is
// only to be shown going through.
// ------------------------------------------------------------
const app = {
  // lib/offlineMutations.js as deployed before wave 1: `.upsert(row, { onConflict: 'session_id' })`,
  // which PostgREST sends as DO UPDATE SET every column of the payload.
  confirmAsDeployed: (run, athlete, sessionId, notes = null, performedOn = null) => run(
    `insert into session_confirmations (session_id, student_id, notes, performed_on) values ($1, $2, $3, $4)
     on conflict (session_id) do update
       set session_id = excluded.session_id, student_id = excluded.student_id,
           notes = excluded.notes, performed_on = excluded.performed_on
     returning id`, [sessionId, athlete.id, notes, performedOn],
  ),
  // …and as wave 1 sends it: `{ onConflict: 'session_id', ignoreDuplicates: true }`.
  confirm: (run, athlete, sessionId, notes = null, performedOn = null) => run(
    `insert into session_confirmations (session_id, student_id, notes, performed_on) values ($1, $2, $3, $4)
     on conflict (session_id) do nothing
     returning id`, [sessionId, athlete.id, notes, performedOn],
  ),
  undo: (run, sessionId) => run(`delete from session_confirmations where session_id = $1`, [sessionId]),
  // hooks/useMessages.js, from SessionFeedbackComposer: the feedback, which stamps the review.
  feedback: (run, athlete, sessionId, body = 'Good session.') => run(
    `insert into messages (sender_id, recipient_id, body, session_id) values ($1, $2, $3, $4) returning id`,
    [ids.coach.id, athlete.id, body, sessionId],
  ),
  // hooks/useSession.js, useMarkSessionReviewed: "Finish without feedback".
  finish: (run, sessionId) => run(
    `update sessions set reviewed_at = now() where id = $1 and reviewed_at is null returning id`, [sessionId],
  ),
  // hooks/useSlotDeviations.js
  saveDeviation: (run, athlete, slot, kind, substitute = null) => run(
    `insert into slot_deviations (exercise_slot_id, student_id, kind, substitute_exercise_id, note, updated_at)
     values ($1, $2, $3, $4, null, now())
     on conflict (exercise_slot_id) do update
       set student_id = excluded.student_id, kind = excluded.kind,
           substitute_exercise_id = excluded.substitute_exercise_id, note = excluded.note, updated_at = excluded.updated_at
     returning id`, [slot.id, athlete.id, kind, substitute],
  ),
  clearDeviation: (run, slot) => run(`delete from slot_deviations where exercise_slot_id = $1`, [slot.id]),
  requestPromote: (run, slot) => run(`update slot_deviations set promote_requested_at = now() where exercise_slot_id = $1`, [slot.id]),
};

const athlete = (fn, who = ids.studentA) => asUser(who, fn);
const coach = (fn) => asUser(ids.coach, fn);
/** The statement, undone as soon as it has answered. */
const dry = (q) => (sql, params) => q.dryRun(sql, params);

/** How a write ended: `1 row`, `0 rows`, or the SQLSTATE and the sentence it was refused with. */
const outcome = async (run) => {
  const tried = await attempt(run);
  if (tried.ok) return `${tried.value.rowCount} row${tried.value.rowCount === 1 ? '' : 's'}`;
  return `${tried.error.code}: ${tried.error.message}`;
};

/** What a session and its confirmation hold, as the owner reads them. */
const state = (q, sessionId) => q.one(
  `select (select jsonb_build_object('notes', c.notes, 'performed_on', c.performed_on, 'student', c.student_id)
             from session_confirmations c where c.session_id = s.id) as confirmation,
          s.reviewed_at is not null as reviewed,
          s.performed_at is not null as trained,
          s.archived_at is not null as archived,
          (select count(*) from messages m where m.session_id = s.id) as feedback
     from sessions s where s.id = $1`, [sessionId],
);
const NOTHING = { confirmation: null, reviewed: false, trained: false, archived: false, feedback: 0 };

/** The coach's bell about one session: `['session_completed unread', …]`, sorted. */
const bell = async (q, sessionId, recipient = ids.coach) => (await q.rows(
  `select kind || ' ' || case when read_at is null then 'unread' else 'read' end as line
     from notifications
    where recipient_id = $1 and payload->>'session_id' = $2
    order by 1`, [recipient.id, sessionId],
)).map((row) => row.line);

const YESTERDAY = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);

// ============================================================
// A review closes the confirmation
// ============================================================
describe('a confirmation is the athlete\'s until the review', () => {
  it('not reviewed: confirmed, changed, taken back and confirmed again — by the deployed app and by the next one', () => scenario(async (q) => {
    const s = session(0);
    expect(await state(q, s.id)).toEqual(NOTHING);

    expect(await outcome(() => athlete((a) => app.confirm(a, ids.studentA, s.id, 'First', YESTERDAY)))).toBe('1 row');
    expect(await state(q, s.id)).toEqual({
      ...NOTHING, trained: true, confirmation: { notes: 'First', performed_on: YESTERDAY, student: ids.studentA.id },
    });
    // The same confirm again: insert-or-nothing writes nothing, the updating upsert replaces the note.
    expect(await outcome(() => athlete((a) => app.confirm(a, ids.studentA, s.id, 'Second')))).toBe('0 rows');
    expect((await state(q, s.id)).confirmation.notes).toBe('First');
    expect(await outcome(() => athlete((a) => app.confirmAsDeployed(a, ids.studentA, s.id, 'Second', YESTERDAY)))).toBe('1 row');
    expect((await state(q, s.id)).confirmation.notes).toBe('Second');

    expect(await outcome(() => athlete((a) => app.undo(a, s.id)))).toBe('1 row');
    expect(await state(q, s.id)).toEqual(NOTHING);
    expect(await outcome(() => athlete((a) => app.confirmAsDeployed(a, ids.studentA, s.id)))).toBe('1 row');
    expect((await state(q, s.id)).trained).toBe(true);
  }));

  const REVIEWS = {
    'with feedback': (sessionId) => coach((c) => app.feedback(c, ids.studentA, sessionId)),
    'finished without feedback': (sessionId) => coach((c) => app.finish(c, sessionId)),
  };
  for (const [kind, review] of Object.entries(REVIEWS)) {
    it(`reviewed, ${kind}: "Undo confirmation" reaches nothing, a change reaches nothing, and the confirmation is what the coach read`, () => scenario(async (q) => {
      const s = session(0);
      const other = session(2);
      await athlete((a) => app.confirm(a, ids.studentA, s.id, 'Left shoulder tight', YESTERDAY));
      const writes = [
        ['Undo confirmation', (run) => app.undo(run, s.id)],
        ['the note is rewritten', (run) => run(`update session_confirmations set notes = 'All good' where session_id = $1`, [s.id])],
        ['the day it was trained is moved', (run) => run(`update session_confirmations set performed_on = current_date where session_id = $1`, [s.id])],
        ['the confirmation is moved to another session', (run) => run(`update session_confirmations set session_id = $2 where session_id = $1`, [s.id, other.id])],
      ];
      const tryAll = async (how) => {
        const out = {};
        for (const [what, write] of writes) out[what] = await outcome(() => athlete((a) => write(how(a))));
        return out;
      };
      const each = (answer) => Object.fromEntries(writes.map(([what]) => [what, answer]));

      // Each of them, undone at once: they all go through while the session is not reviewed.
      expect(await tryAll(dry)).toEqual(each('1 row'));

      expect((await review(s.id)).rowCount).toBe(1);
      const read = await state(q, s.id);
      expect(read).toMatchObject({
        reviewed: true, trained: true,
        confirmation: { notes: 'Left shoulder tight', performed_on: YESTERDAY, student: ids.studentA.id },
      });

      expect(await tryAll((a) => a)).toEqual(each('0 rows'));
      expect(await state(q, s.id)).toEqual(read);
      expect(await state(q, other.id)).toEqual(NOTHING);
      // The athlete still reads it.
      expect(await athlete((a) => a.value(`select notes from session_confirmations where session_id = $1`, [s.id])))
        .toBe('Left shoulder tight');
    }));
  }

  // A confirm is sent twice when the answer of the first was lost, or by a
  // second device whose screen still shows the session as to do. The app
  // deployed before wave 1 sends an upsert that UPDATES the row it meets:
  // PostgreSQL judges that by the UPDATE policy and raises — it never skips
  // it in silence. Wave 1 sends insert-or-nothing, which is an INSERT only.
  it('a confirmation sent a second time after the review: the deployed app is told no, the next one writes nothing — the first confirmation stays, and the coach is not told again', () => scenario(async (q) => {
    await enablePush();
    const s = session(0);
    await athlete((a) => app.confirmAsDeployed(a, ids.studentA, s.id, 'Left shoulder tight', YESTERDAY));
    // Shown going through, and undone: before the review a second one replaces the first.
    expect(await outcome(() => athlete((a) => app.confirmAsDeployed(dry(a), ids.studentA, s.id, null, null)))).toBe('1 row');

    await coach((c) => app.finish(c, s.id));
    const read = await state(q, s.id);
    const pushes = (await httpCalls()).length;
    expect(await bell(q, s.id)).toEqual(['session_completed unread']);

    expect(await outcome(() => athlete((a) => app.confirmAsDeployed(a, ids.studentA, s.id, null, null))))
      .toBe(`42501: ${RLS_USING('session_confirmations')}`);
    expect(await outcome(() => athlete((a) => app.confirm(a, ids.studentA, s.id, null, null)))).toBe('0 rows');

    expect(await state(q, s.id)).toEqual(read);
    expect(read.confirmation).toEqual({ notes: 'Left shoulder tight', performed_on: YESTERDAY, student: ids.studentA.id });
    expect(await bell(q, s.id)).toEqual(['session_completed unread']);
    expect((await httpCalls()).length).toBe(pushes);
  }));

  // What the two policies asked before, and still ask: the rewrite kept it.
  it('archived, or of a block that is no longer the one being trained: nothing of a confirmation is written, as before', () => scenario(async (q) => {
    const s = session(0);
    await athlete((a) => app.confirm(a, ids.studentA, s.id, 'Done'));
    await coach((c) => c(`update sessions set archived_at = now() where id = $1`, [s.id]));
    expect(await outcome(() => athlete((a) => app.undo(a, s.id)))).toBe('0 rows');
    expect(await outcome(() => athlete((a) => a(`update session_confirmations set notes = 'x' where session_id = $1`, [s.id])))).toBe('0 rows');
    expect(await outcome(() => athlete((a) => app.confirmAsDeployed(a, ids.studentA, s.id, 'x')))).toBe(`42501: ${RLS('session_confirmations')}`);
    await coach((c) => c(`update sessions set archived_at = null where id = $1`, [s.id]));
    expect(await outcome(() => athlete((a) => app.undo(dry(a), s.id)))).toBe('1 row');

    await q(`update programs set is_active = false where id = $1`, [ids.programA.id]);
    expect(await outcome(() => athlete((a) => app.undo(a, s.id)))).toBe('0 rows');
    expect(await outcome(() => athlete((a) => app.confirm(a, ids.studentA, session(1).id)))).toBe(`42501: ${RLS('session_confirmations')}`);
    expect((await state(q, s.id)).confirmation.notes).toBe('Done');
  }));

  // Sessions reviewed without a confirmation exist from before the rule
  // (line 13 of the audit). The athlete's app lists such a session as still
  // to do until it is confirmed: the INSERT policy does not ask about the
  // review, and that is on purpose.
  it('a session reviewed without a confirmation can still be confirmed — and that confirmation is final', () => scenario(async (q) => {
    const s = session(0);
    await q(`update sessions set reviewed_at = now() where id = $1`, [s.id]);
    expect(await state(q, s.id)).toEqual({ ...NOTHING, reviewed: true });

    // By either app, shown first; then kept.
    expect(await outcome(() => athlete((a) => app.confirmAsDeployed(dry(a), ids.studentA, s.id, 'Late', YESTERDAY)))).toBe('1 row');
    expect(await outcome(() => athlete((a) => app.confirm(a, ids.studentA, s.id, 'Late', YESTERDAY)))).toBe('1 row');
    expect(await state(q, s.id)).toEqual({
      ...NOTHING, reviewed: true, trained: true,
      confirmation: { notes: 'Late', performed_on: YESTERDAY, student: ids.studentA.id },
    });
    expect(await bell(q, s.id)).toEqual(['session_completed unread']);

    expect(await outcome(() => athlete((a) => app.undo(a, s.id)))).toBe('0 rows');
    expect((await state(q, s.id)).confirmation.notes).toBe('Late');
  }));

  it('opens again when the owner takes the review back', () => scenario(async (q) => {
    const s = session(0);
    await athlete((a) => app.confirm(a, ids.studentA, s.id));
    await coach((c) => app.feedback(c, ids.studentA, s.id));
    expect(await outcome(() => athlete((a) => app.undo(a, s.id)))).toBe('0 rows');

    await q(`update sessions set reviewed_at = null where id = $1`, [s.id]);
    expect(await outcome(() => athlete((a) => app.undo(a, s.id)))).toBe('1 row');
    expect(await state(q, s.id)).toEqual({ ...NOTHING, feedback: 1 });
  }));

  it('nobody else writes it: another athlete, the coach, an account nobody coaches', () => scenario(async (q) => {
    const s = session(0);
    await athlete((a) => app.confirm(a, ids.studentA, s.id, 'Mine'));
    for (const who of [ids.studentB, ids.coach, una]) {
      expect(await outcome(() => asUser(who, (user) => app.undo(user, s.id))), who.email).toBe('0 rows');
      expect(await outcome(() => asUser(who, (user) => user(`update session_confirmations set notes = 'x' where session_id = $1`, [s.id]))), who.email).toBe('0 rows');
      expect(await outcome(() => asUser(who, (user) => app.confirm(user, who, session(1).id))), who.email)
        .toBe(`42501: ${RLS('session_confirmations')}`);
    }
    expect((await state(q, s.id)).confirmation).toEqual({ notes: 'Mine', performed_on: null, student: ids.studentA.id });
  }));

  // The owner of the database and the service role are not judged: removing
  // an account cascades to its confirmations while the sessions are there.
  it('the owner and the service role take a confirmation away whatever the session says', () => scenario(async (q) => {
    const s = session(0);
    await athlete((a) => app.confirm(a, ids.studentA, s.id));
    await coach((c) => app.finish(c, s.id));
    expect(await outcome(() => athlete((a) => app.undo(a, s.id)))).toBe('0 rows');
    expect(await outcome(() => asService((service) => app.undo(dry(service), s.id)))).toBe('1 row');
    expect(await outcome(() => app.undo(q, s.id))).toBe('1 row');
    expect(await state(q, s.id)).toEqual({ ...NOTHING, reviewed: true });
  }));

  // The cascade the exemption is there for: session_confirmations.student_id
  // points at the profile, so the confirmations of an account go with it —
  // some of them before their sessions do.
  it('an account that is removed takes its confirmations with it, reviewed or not', () => scenario(async (q) => {
    const [reviewed] = ids.programB.sessions;
    await athlete((b) => app.confirm(b, ids.studentB, reviewed), ids.studentB);
    await coach((c) => app.finish(c, reviewed));
    expect(await q.value(`select count(*) from session_confirmations where student_id = $1`, [ids.studentB.id])).toBe(1);

    expect(await outcome(() => q(`delete from auth.users where id = $1`, [ids.studentB.id]))).toBe('1 row');
    expect(await q.one(
      `select (select count(*) from profiles where id = $1) as profiles,
              (select count(*) from session_confirmations where student_id = $1) as confirmations,
              (select count(*) from sessions where id = $2) as sessions`, [ids.studentB.id, reviewed],
    )).toEqual({ profiles: 0, confirmations: 0, sessions: 0 });
  }));

  // A session the coach deletes takes its confirmation with it. The guard
  // fires on that cascade, for a request that carries the coach's id — and
  // the session it would read is already gone.
  it('a reviewed session the coach deletes: its confirmation follows', () => scenario(async (q) => {
    const s = session(0);
    await athlete((a) => app.confirm(a, ids.studentA, s.id));
    await coach((c) => app.finish(c, s.id));
    expect(await outcome(() => coach((c) => c(`delete from sessions where id = $1`, [s.id])))).toBe('1 row');
    expect(await q.value(`select count(*) from session_confirmations where session_id = $1`, [s.id])).toBe(0);
  }));
});

// ============================================================
// A review needs a confirmation
// ============================================================
describe('a review needs a confirmation', () => {
  const feedbackPushes = async () => (await httpCalls()).filter((call) => /^Feedback from /.test(call.body.payload.title)).length;

  it('feedback and "Finish without feedback" on a session that is not confirmed are refused, and nothing is written', () => scenario(async (q) => {
    await enablePush();
    const s = session(0);

    const finished = await attempt(() => coach((c) => app.finish(c, s.id)));
    expect(finished.error?.code).toBe('42501');
    expect(finished.error.message).toBe(NOT_CONFIRMED(s.id));
    expect(await outcome(() => coach((c) => app.feedback(c, ids.studentA, s.id)))).toBe(`42501: ${RLS('messages')}`);

    expect(await state(q, s.id)).toEqual(NOTHING);
    expect(await bell(q, s.id, ids.studentA)).toEqual([]);
    expect(await feedbackPushes()).toBe(0);
    // An ordinary message — no session — is sent as before.
    expect(await outcome(() => coach((c) => c(
      `insert into messages (sender_id, recipient_id, body) values ($1, $2, 'See you Monday')`, [ids.coach.id, ids.studentA.id],
    )))).toBe('1 row');
  }));

  it('once its athlete has confirmed it, both go through, as before', () => scenario(async (q) => {
    await enablePush();
    const s = session(0);
    await athlete((a) => app.confirm(a, ids.studentA, s.id));

    expect(await outcome(() => coach((c) => app.finish(dry(c), s.id)))).toBe('1 row');
    expect(await state(q, s.id)).toMatchObject({ reviewed: false });

    expect(await outcome(() => coach((c) => app.feedback(c, ids.studentA, s.id)))).toBe('1 row');
    expect(await state(q, s.id)).toMatchObject({ reviewed: true, feedback: 1 });
    expect(await q.value(
      `select s.reviewed_at = m.created_at from sessions s join messages m on m.session_id = s.id where s.id = $1`, [s.id],
    )).toBe(true);
    expect(await bell(q, s.id, ids.studentA)).toEqual(['session_feedback unread']);
    expect(await feedbackPushes()).toBe(1);
  }));

  // The walkthrough of the finding: the athlete confirms by mistake, takes it
  // back and goes on training; the coach follows the "session completed"
  // notification — or the push — to the review page.
  it('confirmed, taken back, then reviewed from the old notification: refused both ways — and the session is there to review once it is confirmed again', () => scenario(async (q) => {
    const s = session(0);
    await athlete((a) => app.confirm(a, ids.studentA, s.id));
    await athlete((a) => app.undo(a, s.id));

    expect(await outcome(() => coach((c) => app.finish(c, s.id)))).toBe(`42501: ${NOT_CONFIRMED(s.id)}`);
    expect(await outcome(() => coach((c) => app.feedback(c, ids.studentA, s.id)))).toBe(`42501: ${RLS('messages')}`);
    expect(await state(q, s.id)).toEqual(NOTHING);

    await athlete((a) => app.confirm(a, ids.studentA, s.id));
    // The coach's "to review" list (useAllConfirmations): confirmations of sessions neither reviewed nor archived.
    const toReview = () => coach((c) => c.value(
      `select count(*) from session_confirmations sc join sessions se on se.id = sc.session_id
        where sc.session_id = $1 and se.reviewed_at is null and se.archived_at is null`, [s.id],
    ));
    expect(await toReview()).toBe(1);
    expect(await outcome(() => coach((c) => app.finish(c, s.id)))).toBe('1 row');
    expect(await toReview()).toBe(0);
  }));

  // The rule is for a request that carries a user id. The statement of the
  // page of migration 08 that closes a session by hand still does.
  it('the owner and the service role stamp what they decide', () => scenario(async (q) => {
    const s = session(0);
    expect(await outcome(() => asService((service) => app.finish(dry(service), s.id)))).toBe('1 row');
    expect(await outcome(() => asService((service) => app.feedback(dry(service), ids.studentA, s.id)))).toBe('1 row');
    expect(await outcome(() => q(`update public.sessions set reviewed_at = now() where id = $1`, [s.id]))).toBe('1 row');
    expect(await state(q, s.id)).toEqual({ ...NOTHING, reviewed: true });
  }));

  it('another coach, an athlete and an account nobody coaches review nothing, confirmed or not', () => scenario(async (q) => {
    const other = await createUser({ email: 'olga@sl.test', fullName: 'Coach Olga', role: 'coach' });
    const s = session(0);
    await athlete((a) => app.confirm(a, ids.studentA, s.id));
    for (const who of [other, ids.studentA, ids.studentB, una]) {
      expect(await outcome(() => asUser(who, (user) => app.finish(user, s.id))), who.email).toBe('0 rows');
      expect(await outcome(() => asUser(who, (user) => user(
        `insert into messages (sender_id, recipient_id, body, session_id) values ($1, $2, 'Forged', $3)`, [who.id, ids.studentA.id, s.id],
      ))), who.email).toBe(`42501: ${RLS('messages')}`);
    }
    expect(await state(q, s.id)).toMatchObject({ reviewed: false, feedback: 0 });
  }));

  // ON THE TRANSITION ONLY. A session reviewed without a confirmation is a
  // row like any other for everything else the coach does with it.
  it('a session reviewed without a confirmation is still archived, restored, renamed, dated, reordered and moved to another phase', () => scenario(async (q) => {
    const s = session(0);
    const neighbour = session(1);
    const [third, fourth] = [session(2), session(3)];
    await q(`update sessions set reviewed_at = now() - interval '3 days' where id = $1`, [s.id]);
    const asCoach = (sql, params) => outcome(() => coach((c) => c(sql, params)));

    expect(await asCoach(`update sessions set archived_at = now() where id = $1`, [s.id])).toBe('1 row');
    expect(await asCoach(`update sessions set archived_at = null where id = $1`, [s.id])).toBe('1 row');
    expect(await asCoach(`update sessions set title = 'Renamed', scheduled_date = current_date, day_number = 3 where id = $1`, [s.id])).toBe('1 row');
    // useReorderSessions: park, then place.
    expect(await asCoach(`update sessions set sort_order = sort_order + 100000 where week_id = $1`, [s.weekId])).toBe('2 rows');
    expect(await asCoach(`update sessions set sort_order = 0 where id = $1`, [neighbour.id])).toBe('1 row');
    expect(await asCoach(`update sessions set sort_order = 1 where id = $1`, [s.id])).toBe('1 row');
    // Dragged across the divider, to the end of the second phase.
    await coach((c) => c(`select public.move_session($1, $2, $3, $4)`, [s.id, third.weekId, [neighbour.id], [third.id, fourth.id, s.id]]));
    expect(await q.one(
      `select week_id, sort_order, title, reviewed_at is not null as reviewed, archived_at is null as restored from sessions where id = $1`, [s.id],
    )).toEqual({ week_id: third.weekId, sort_order: 2, title: 'Renamed', reviewed: true, restored: true });

    // The stamp itself: written again while it is set, and taken back.
    expect(await asCoach(`update sessions set reviewed_at = now() where id = $1`, [s.id])).toBe('1 row');
    expect(await asCoach(`update sessions set reviewed_at = null where id = $1`, [s.id])).toBe('1 row');
    // …and from NULL it is the rule again.
    expect(await asCoach(`update sessions set reviewed_at = now() where id = $1`, [s.id])).toBe(`42501: ${NOT_CONFIRMED(s.id)}`);
    // A whole-row write that sends the column back as it is asks nothing.
    expect(await asCoach(`update sessions set reviewed_at = reviewed_at, title = 'Again' where week_id = $1`, [third.weekId])).toBe('3 rows');
  }));

  // BEFORE triggers fire in the order of their names. On a session of a draft
  // the pin of migration 06 puts reviewed_at back to NULL — silently — and
  // only then is "from NULL to a value" asked.
  it('a session of a draft stays silent: the pin of migration 06 answers first', () => scenario(async (q) => {
    const draft = await createDraftProgram(ids.studentA);
    for (const who of [ids.coach, ids.studentA]) {
      const written = await asUser(who, (user) => user.one(
        `update sessions set reviewed_at = now(), title = 'Stamped' where id = $1 returning reviewed_at, title`, [draft.sessions[0]],
      ));
      expect(written, who.email).toEqual({ reviewed_at: null, title: 'Stamped' });
    }
    // ROW (1) + BEFORE (2) + UPDATE (16)
    expect((await q.rows(
      `select tgname from pg_trigger
        where tgrelid = 'public.sessions'::regclass and not tgisinternal and tgtype & 19 = 19
        order by tgname collate "C"`,
    )).map((row) => row.tgname)).toEqual(['trg_pin_draft_session_columns', 'trg_review_needs_confirmation']);
  }));

  it('session_is_confirmed answers the same whoever asks, never NULL — and nothing to a request without a session', () => scenario(async (q) => {
    const s = session(0);
    await athlete((a) => app.confirm(a, ids.studentA, s.id));
    for (const who of [ids.studentA, ids.studentB, ids.coach, una]) {
      const asked = await asUser(who, (user) => user.one(
        `select public.session_is_confirmed($1) as confirmed, public.session_is_confirmed($2) as other,
                public.session_is_confirmed(gen_random_uuid()) as unknown, public.session_is_confirmed(null) as nothing`,
        [s.id, session(1).id],
      ));
      expect(asked, who.email).toEqual({ confirmed: true, other: false, unknown: false, nothing: false });
    }
    expect(await asService((service) => service.value(`select public.session_is_confirmed($1)`, [s.id]))).toBe(true);
    const anon = await attempt(() => asAnon((nobody) => nobody.value(`select public.session_is_confirmed($1)`, [s.id])));
    expect(anon.error?.message).toBe('permission denied for function session_is_confirmed');
    expect(await q.one(
      `select p.provolatile, p.prosecdef from pg_proc p where p.oid = 'public.session_is_confirmed(uuid)'::regprocedure`,
    )).toEqual({ provolatile: 's', prosecdef: true });
  }));
});

// ============================================================
// When the two cross
// ============================================================
// A policy — and a STABLE function — judges the database as its statement saw
// it when it STARTED. A review and an undo sent in the same instant each
// start before the other is committed: each would be accepted on what it saw,
// and the session would be reviewed with no confirmation. One connection
// cannot show that; these hold one request open while the other arrives.
describe('a review and an undo that cross', () => {
  const lockWaits = () => asAdmin((q) => q.value(
    `select count(*) from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
  ));
  const untilItWaits = async (what) => {
    for (let tries = 0; await lockWaits() === 0; tries += 1) {
      if (tries === 500) throw new Error(`${what} never waited for the row`);
      await new Promise((resolve) => { setTimeout(resolve, 10); });
    }
  };
  const committed = (who, fn) => asUser(who, fn, { commit: true });
  const stateNow = (sessionId) => asAdmin((q) => state(q, sessionId));

  /**
   * `first` runs and is held open, uncommitted; `second` starts, and is shown
   * to wait for it; then `first` commits. Resolves to how `second` ended.
   */
  async function cross({ first, second, what }) {
    let letGo;
    const untilLetGo = new Promise((resolve) => { letGo = resolve; });
    let isHeld;
    const held = new Promise((resolve) => { isHeld = resolve; });
    const holder = first(async () => { isHeld(); await untilLetGo; });
    let waiter;
    try {
      await Promise.race([held, holder]);
      let answered = false;
      waiter = second().finally(() => { answered = true; });
      waiter.catch(() => {});
      await untilItWaits(what);
      expect(answered, `${what} had answered before the first request was committed: nothing crossed`).toBe(false);
      letGo();
      await holder;
      return await attempt(() => waiter);
    } finally {
      letGo();
      await Promise.allSettled([holder, waiter]);
    }
  }

  it('the coach finishes without feedback while "Undo confirmation" is on its way: the undo waits, and is refused', async () => {
    const [s] = raceBlock.sessions;
    await committed(rae, (a) => app.confirm(a, rae, s));

    const undo = await cross({
      what: 'the undo',
      first: (hold) => committed(ids.coach, async (c) => {
        expect((await app.finish(c, s)).rowCount).toBe(1);
        await hold();
      }),
      second: () => committed(rae, (a) => app.undo(a, s)),
    });
    expect(undo.error?.code).toBe('42501');
    expect(undo.error.message).toBe(REVIEWED(s));
    expect(await stateNow(s)).toMatchObject({ reviewed: true, trained: true, confirmation: { student: rae.id } });
    // …and it stays refused, now by the policy: nothing, and no message.
    expect(await outcome(() => committed(rae, (a) => app.undo(a, s)))).toBe('0 rows');
  });

  it('"Undo confirmation" while the coach finishes without feedback: the review waits, and is refused', async () => {
    const [, s] = raceBlock.sessions;
    await committed(rae, (a) => app.confirm(a, rae, s));

    const review = await cross({
      what: 'the review',
      first: (hold) => committed(rae, async (a) => {
        expect((await app.undo(a, s)).rowCount).toBe(1);
        await hold();
      }),
      second: () => committed(ids.coach, (c) => app.finish(c, s)),
    });
    expect(review.error?.code).toBe('42501');
    expect(review.error.message).toBe(NOT_CONFIRMED(s));
    expect(await stateNow(s)).toEqual(NOTHING);
  });

  // The policy of messages has accepted the feedback — the confirmation was
  // there when the INSERT started — and the trigger that stamps the review
  // then waits for the session. The refusal undoes the message with it.
  it('"Undo confirmation" while the coach sends feedback: the feedback waits, and is not sent', async () => {
    const [, , s] = raceBlock.sessions;
    await committed(rae, (a) => app.confirm(a, rae, s));

    const feedback = await cross({
      what: 'the feedback',
      first: (hold) => committed(rae, async (a) => {
        expect((await app.undo(a, s)).rowCount).toBe(1);
        await hold();
      }),
      second: () => committed(ids.coach, (c) => app.feedback(c, rae, s)),
    });
    expect(feedback.error?.code).toBe('42501');
    expect(feedback.error.message).toBe(NOT_CONFIRMED(s));
    expect(await stateNow(s)).toEqual(NOTHING);
    expect(await asAdmin((q) => bell(q, s, rae))).toEqual([]);
  });
});

// ============================================================
// What is taken back takes its unread notifications with it
// ============================================================
describe('the coach\'s bell follows what the athlete takes back', () => {
  it('confirm, undo, confirm: one "session completed" line, not two', () => scenario(async (q) => {
    const s = session(0);
    await athlete((a) => app.confirm(a, ids.studentA, s.id));
    expect(await bell(q, s.id)).toEqual(['session_completed unread']);
    await athlete((a) => app.undo(a, s.id));
    expect(await bell(q, s.id)).toEqual([]);
    await athlete((a) => app.confirmAsDeployed(a, ids.studentA, s.id));
    expect(await bell(q, s.id)).toEqual(['session_completed unread']);
    // The line names the confirmation that is there.
    expect(await q.value(
      `select n.payload->>'confirmation_id' = c.id::text
         from notifications n join session_confirmations c on c.session_id = $1
        where n.kind = 'session_completed' and n.payload->>'session_id' = $1::text`, [s.id],
    )).toBe(true);
  }));

  it('a line the coach has read stays: it is their history', () => scenario(async (q) => {
    const s = session(0);
    await athlete((a) => app.confirm(a, ids.studentA, s.id));
    expect((await coach((c) => c(`update notifications set read_at = now() where payload->>'session_id' = $1`, [s.id]))).rowCount).toBe(1);
    await athlete((a) => app.undo(a, s.id));
    expect(await bell(q, s.id)).toEqual(['session_completed read']);
  }));

  it('the unread lines earlier rounds left about the session go with it — and nothing else does', () => scenario(async (q) => {
    const s = session(0);
    const other = session(1);
    const line = (recipient, kind, payload, read = false) => q(
      `insert into notifications (recipient_id, kind, payload, read_at) values ($1, $2, $3, case when $4 then now() end)`,
      [recipient.id, kind, payload, read],
    );
    const gone = () => q.value(`select gen_random_uuid()`);
    // Left by rounds before the trigger existed: the confirmations they name are gone.
    await line(ids.coach, 'session_completed', { session_id: s.id, confirmation_id: await gone() });
    await line(ids.coach, 'session_completed', { session_id: s.id, confirmation_id: await gone() });
    await line(ids.coach, 'session_completed', { session_id: s.id, confirmation_id: await gone() }, true);
    // About another session, of another kind, for somebody else.
    await line(ids.coach, 'session_completed', { session_id: other.id, confirmation_id: await gone() });
    await line(ids.coach, 'session_deviation', { session_id: s.id, slot_id: s.dip.id });
    await line(ids.studentA, 'session_feedback', { session_id: s.id });

    await athlete((a) => app.confirm(a, ids.studentA, s.id));
    expect(await bell(q, s.id)).toEqual([
      'session_completed read', 'session_completed unread', 'session_completed unread', 'session_completed unread',
      'session_deviation unread',
    ]);
    await athlete((a) => app.undo(a, s.id));
    expect(await bell(q, s.id)).toEqual(['session_completed read', 'session_deviation unread']);
    expect(await bell(q, other.id)).toEqual(['session_completed unread']);
    expect(await bell(q, s.id, ids.studentA)).toEqual(['session_feedback unread']);
  }));

  it('a session that is deleted takes the line of its confirmation with it', () => scenario(async (q) => {
    const s = session(0);
    await athlete((a) => app.confirm(a, ids.studentA, s.id));
    expect(await bell(q, s.id)).toEqual(['session_completed unread']);
    await coach((c) => c(`delete from sessions where id = $1`, [s.id]));
    expect(await bell(q, s.id)).toEqual([]);
  }));

  // L12: a tap on "Skip" tells the coach, and Undo left the line behind.
  it('swap, undo, skip: one "off-plan" line, and it says what is there', () => scenario(async (q) => {
    const s = session(0);
    const lines = () => q.rows(
      `select payload->>'deviation_kind' as kind, read_at is null as unread from notifications
        where recipient_id = $1 and kind = 'session_deviation' and payload->>'slot_id' = $2`, [ids.coach.id, s.dip.id],
    );
    await athlete((a) => app.saveDeviation(a, ids.studentA, s.dip, 'swap', ids.exercises.squat));
    expect(await lines()).toEqual([{ kind: 'swap', unread: true }]);
    await athlete((a) => app.clearDeviation(a, s.dip));
    expect(await lines()).toEqual([]);
    await athlete((a) => app.saveDeviation(a, ids.studentA, s.dip, 'skip'));
    expect(await lines()).toEqual([{ kind: 'skip', unread: true }]);
  }));

  it('a swap the athlete asked to keep, then removed: the unread request goes with it — the line the coach has read stays, and so does the line of another exercise', () => scenario(async (q) => {
    const s = session(0);
    const ofSlot = async (slot) => (await q.rows(
      `select kind || ' ' || case when read_at is null then 'unread' else 'read' end as line from notifications
        where recipient_id = $1 and payload->>'slot_id' = $2 order by 1`, [ids.coach.id, slot.id],
    )).map((row) => row.line);

    await athlete((a) => app.saveDeviation(a, ids.studentA, s.dip, 'swap', ids.exercises.squat));
    await athlete((a) => app.requestPromote(a, s.dip));
    await athlete((a) => app.saveDeviation(a, ids.studentA, s.pullUp, 'skip'));
    expect(await ofSlot(s.dip)).toEqual(['promote_requested unread', 'session_deviation unread']);
    expect(await ofSlot(s.pullUp)).toEqual(['session_deviation unread']);

    await coach((c) => c(`update notifications set read_at = now() where kind = 'session_deviation' and payload->>'slot_id' = $1`, [s.dip.id]));
    await athlete((a) => app.clearDeviation(a, s.dip));
    expect(await ofSlot(s.dip)).toEqual(['session_deviation read']);
    expect(await ofSlot(s.pullUp)).toEqual(['session_deviation unread']);
  }));

  it('an exercise the coach removes takes the lines of its swap with it', () => scenario(async (q) => {
    const s = session(0);
    await athlete((a) => app.saveDeviation(a, ids.studentA, s.dip, 'skip'));
    expect(await bell(q, s.id)).toEqual(['session_deviation unread']);
    await coach((c) => c(`delete from exercise_slots where id = $1`, [s.dip.id]));
    expect(await bell(q, s.id)).toEqual([]);
  }));

  // The trigger runs as its owner: the athlete holds nothing on the coach's bell.
  it('the athlete removes nothing from the coach\'s bell by any other way', () => scenario(async (q) => {
    const s = session(0);
    await athlete((a) => app.confirm(a, ids.studentA, s.id));
    expect(await outcome(() => athlete((a) => a(`delete from notifications`)))).toBe('0 rows');
    expect(await outcome(() => athlete((a) => a(`update notifications set read_at = now()`)))).toBe('0 rows');
    const called = await attempt(() => athlete((a) => a(`select public.retract_session_completed_notification()`)));
    expect(called.error?.message).toBe('permission denied for function retract_session_completed_notification');
    expect(await bell(q, s.id)).toEqual(['session_completed unread']);
  }));
});

// ============================================================
// The push of a confirmation
// ============================================================
describe('the push of a confirmation', () => {
  it('is tagged by session: a second confirmation of the same session replaces the first on the lock screen', () => scenario(async () => {
    await enablePush();
    const [s, other] = [session(0), session(1)];
    await athlete((a) => app.confirm(a, ids.studentA, s.id));
    await athlete((a) => app.undo(a, s.id));
    await athlete((a) => app.confirmAsDeployed(a, ids.studentA, s.id));
    await athlete((a) => app.confirm(a, ids.studentA, other.id));

    const pushes = (await httpCalls()).filter((call) => call.body.payload.title === 'Session completed');
    expect(pushes.map((call) => call.body.payload.tag)).toEqual([
      `session-confirm-${s.id}`, `session-confirm-${s.id}`, `session-confirm-${other.id}`,
    ]);
    // The rest of the push is what it was — with, since 2026_10_13_15, the
    // day send_push_event gives the push service to deliver it.
    expect(pushes[0].body).toEqual({
      user_id: ids.coach.id,
      payload: {
        title: 'Session completed',
        body: 'Alex Athlete completed W1 · S1',
        tag: `session-confirm-${s.id}`,
        data: { url: `/sl_app/#/coach/student/${ids.studentA.studentRowId}/session/${s.id}/review` },
      },
      ttl: 86400,
    });
  }));
});

// ============================================================
// The migration file, on the production baseline
// ============================================================
describe('migration 09 applied to the production baseline', () => {
  const COACH = '00000000-0000-4000-8000-00000000c0ac';
  const ATHLETE = '00000000-0000-4000-8000-0000000000a1';
  const LINK = '00000000-0000-4000-8000-000000000101';
  const PULL_UP = '00000000-0000-4000-8000-000000000201';
  const PROGRAM = '00000000-0000-4000-8000-000000000301';
  const WEEK = '00000000-0000-4000-8000-000000000401';
  const SESSION_R = '00000000-0000-4000-8000-000000000451';   // confirmed, reviewed with feedback
  const WAITING = '00000000-0000-4000-8000-000000000452';     // confirmed, not reviewed
  const OPEN = '00000000-0000-4000-8000-000000000453';        // not confirmed
  const LEGACY = '00000000-0000-4000-8000-000000000454';      // reviewed, never confirmed
  const SLOT_R = '00000000-0000-4000-8000-000000000501';
  const SLOT_W = '00000000-0000-4000-8000-000000000502';
  const SLOT_O = '00000000-0000-4000-8000-000000000503';
  const SLOT_L = '00000000-0000-4000-8000-000000000504';
  const GONE_1 = '00000000-0000-4000-8000-000000000701';
  const GONE_2 = '00000000-0000-4000-8000-000000000702';
  const GONE_3 = '00000000-0000-4000-8000-000000000703';
  // The notifications written by hand, by what the migration does with them.
  const STALE = {
    'session completed, unread, of a confirmation taken back': '00000000-0000-4000-8000-000000000801',
    'session completed, unread, of an earlier round of a session that is confirmed': '00000000-0000-4000-8000-000000000802',
    'off-plan, unread, of a skip that was undone': '00000000-0000-4000-8000-000000000803',
    'wants to keep it, unread, of a swap that was undone': '00000000-0000-4000-8000-000000000804',
  };
  const KEPT = {
    'session completed, read, of a confirmation taken back': '00000000-0000-4000-8000-000000000811',
    'off-plan, read, of a skip that was undone': '00000000-0000-4000-8000-000000000812',
    'of another kind, unread': '00000000-0000-4000-8000-000000000813',
  };
  const TO_COME = '2099_01_01_99_a_migration_to_come';

  // A coach and their athlete, who trains a block of four sessions: the first
  // confirmed and reviewed with feedback; the second confirmed, waiting for
  // its review, with a skip in it; the third not confirmed; the fourth
  // reviewed without ever being confirmed. The triggers of the baseline write
  // the notifications of what is there (two confirmations, one skip, one
  // feedback); the stale ones are written by hand, as the rounds before left
  // them. The coach's role is set the way a dump restore sets it.
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
    insert into public.sessions (id, week_id, title, sort_order, reviewed_at) values
      ('${SESSION_R}', '${WEEK}', 'S1', 0, null),
      ('${WAITING}',   '${WEEK}', 'S2', 1, null),
      ('${OPEN}',      '${WEEK}', 'S3', 2, null),
      ('${LEGACY}',    '${WEEK}', 'S4', 3, '2026-10-01 10:00+00');
    insert into public.exercise_slots (id, session_id, exercise_id, sets, reps, weight_kg, sort_order) values
      ('${SLOT_R}', '${SESSION_R}', '${PULL_UP}', 3, 5, 20, 0),
      ('${SLOT_W}', '${WAITING}',   '${PULL_UP}', 3, 5, 20, 0),
      ('${SLOT_O}', '${OPEN}',      '${PULL_UP}', 3, 5, 20, 0),
      ('${SLOT_L}', '${LEGACY}',    '${PULL_UP}', 3, 5, 20, 0);

    insert into public.session_confirmations (session_id, student_id, notes, performed_on) values
      ('${SESSION_R}', '${ATHLETE}', 'Left shoulder tight', '2026-09-30'),
      ('${WAITING}',   '${ATHLETE}', null, '2026-10-02');
    insert into public.messages (sender_id, recipient_id, body, session_id)
      values ('${COACH}', '${ATHLETE}', 'Good session.', '${SESSION_R}');
    insert into public.slot_deviations (exercise_slot_id, student_id, kind) values ('${SLOT_W}', '${ATHLETE}', 'skip');

    insert into public.notifications (id, recipient_id, kind, payload, read_at) values
      ('${STALE['session completed, unread, of a confirmation taken back']}', '${COACH}', 'session_completed',
       '{"session_id": "${OPEN}", "confirmation_id": "${GONE_1}"}', null),
      ('${STALE['session completed, unread, of an earlier round of a session that is confirmed']}', '${COACH}', 'session_completed',
       '{"session_id": "${WAITING}", "confirmation_id": "${GONE_2}"}', null),
      ('${STALE['off-plan, unread, of a skip that was undone']}', '${COACH}', 'session_deviation',
       '{"session_id": "${OPEN}", "slot_id": "${SLOT_O}", "deviation_kind": "skip"}', null),
      ('${STALE['wants to keep it, unread, of a swap that was undone']}', '${COACH}', 'promote_requested',
       '{"session_id": "${OPEN}", "slot_id": "${SLOT_O}", "deviation_kind": "swap"}', null),
      ('${KEPT['session completed, read, of a confirmation taken back']}', '${COACH}', 'session_completed',
       '{"session_id": "${OPEN}", "confirmation_id": "${GONE_3}"}', now()),
      ('${KEPT['off-plan, read, of a skip that was undone']}', '${COACH}', 'session_deviation',
       '{"session_id": "${OPEN}", "slot_id": "${SLOT_O}", "deviation_kind": "skip"}', now()),
      ('${KEPT['of another kind, unread']}', '${ATHLETE}', 'program_approved', '{"program_id": "${PROGRAM}"}', null);
  `;

  /** The frozen baseline with that world in it — and `more` of it — and the migrations before 09 applied. */
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

  // One API request: role and claims set the way PostgREST sets them, the
  // statements, and everything undone — the answer is what is looked at.
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
  // What the owner then reads, in the same request: the athlete's statement
  // has run, and nothing is kept.
  const THEN_AS_OWNER = `select set_config('role', 'postgres', true), set_config('request.jwt.claims', '', true)`;

  const UPSERT = (sessionId, notes) => `insert into public.session_confirmations (session_id, student_id, notes, performed_on)
       values ('${sessionId}', '${ATHLETE}', ${notes}, current_date)
       on conflict (session_id) do update
         set session_id = excluded.session_id, student_id = excluded.student_id,
             notes = excluded.notes, performed_on = excluded.performed_on
       returning 'written'`;
  const FINISH = (sessionId) => `update public.sessions set reviewed_at = now() where id = '${sessionId}' and reviewed_at is null returning 'written'`;
  const FEEDBACK = (sessionId) => `insert into public.messages (sender_id, recipient_id, body, session_id)
       values ('${COACH}', '${ATHLETE}', 'Well done.', '${sessionId}') returning 'written'`;
  const UNDO = (sessionId) => `delete from public.session_confirmations where session_id = '${sessionId}' returning 'written'`;

  // The finding, one request each. `[who, sql]`.
  const HOLES = {
    'the athlete takes back the confirmation of the reviewed session': [THE_ATHLETE, UNDO(SESSION_R)],
    'the athlete rewrites the note of that confirmation':
      [THE_ATHLETE, `update public.session_confirmations set notes = 'All good' where session_id = '${SESSION_R}' returning 'written'`],
    'the athlete\'s phone sends that confirmation again, and it replaces the first': [THE_ATHLETE, UPSERT(SESSION_R, 'null')],
    'the coach finishes without feedback a session that is not confirmed': [THE_COACH, FINISH(OPEN)],
    'the coach sends feedback on a session that is not confirmed': [THE_COACH, FEEDBACK(OPEN)],
    'unread "session completed" lines left once the confirmation of a session is taken back': [THE_ATHLETE,
      `${UNDO(WAITING)};
       ${THEN_AS_OWNER};
       select count(*)::int from public.notifications
        where kind = 'session_completed' and read_at is null and payload->>'session_id' = '${WAITING}'`],
    'unread "off-plan" lines left once the skip is undone': [THE_ATHLETE,
      `delete from public.slot_deviations where exercise_slot_id = '${SLOT_W}';
       ${THEN_AS_OWNER};
       select count(*)::int from public.notifications
        where kind = 'session_deviation' and read_at is null and payload->>'slot_id' = '${SLOT_W}'`],
  };
  const holes = async (db) => {
    const out = {};
    for (const [what, [who, sql]] of Object.entries(HOLES)) out[what] = await request(db, who, sql);
    return out;
  };
  const OPEN_HOLES = {
    'the athlete takes back the confirmation of the reviewed session': 'written',
    'the athlete rewrites the note of that confirmation': 'written',
    'the athlete\'s phone sends that confirmation again, and it replaces the first': 'written',
    'the coach finishes without feedback a session that is not confirmed': 'written',
    'the coach sends feedback on a session that is not confirmed': 'written',
    // The one its own confirmation wrote, and the one an earlier round left.
    'unread "session completed" lines left once the confirmation of a session is taken back': 2,
    'unread "off-plan" lines left once the skip is undone': 1,
  };
  const CLOSED_HOLES = {
    'the athlete takes back the confirmation of the reviewed session': null,
    'the athlete rewrites the note of that confirmation': null,
    'the athlete\'s phone sends that confirmation again, and it replaces the first': RLS_USING('session_confirmations'),
    'the coach finishes without feedback a session that is not confirmed': NOT_CONFIRMED(OPEN),
    'the coach sends feedback on a session that is not confirmed': RLS('messages'),
    'unread "session completed" lines left once the confirmation of a session is taken back': 0,
    'unread "off-plan" lines left once the skip is undone': 0,
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
  const PROTECTED = 'check only, nothing was written: protected: a confirmation is taken back until the review and not after, and a session that is not confirmed is not marked as reviewed';

  const printedAudit = async (db) => {
    const [result] = await db.readOnly(read(migration.paths.audit), 'audit');
    return Object.fromEntries(result.rows.map((line) => [line.check, line.value]));
  };
  const LINE = {
    closed: 'an athlete changes or takes back a confirmation only while its session is neither archived nor reviewed (P57)',
    crossing: '… and not while the review of that session is being written',
    needs: 'a signed-in user marks a session as reviewed only once its athlete has confirmed it',
    feedback: '… and sends feedback on a confirmed session only',
    retractConfirmation: 'a confirmation that is taken back takes its unread notifications with it',
    retractDeviation: '… and so does a swap or a skip that is removed (L12)',
    tag: 'the push of a confirmation is tagged by session',
    callable: 'functions of this migration a signed-in user may execute',
    strangers: 'policies that write these tables and that the migration does not know',
    legacy: 'sessions reviewed without a confirmation',
    staleCompleted: 'unread "session completed" notifications whose confirmation is gone',
    staleOffPlan: 'unread "off-plan" notifications whose swap or skip is gone',
  };
  const RULES = [LINE.closed, LINE.crossing, LINE.needs, LINE.feedback, LINE.retractConfirmation, LINE.retractDeviation, LINE.tag];
  const rules = (value) => Object.fromEntries(RULES.map((line) => [line, value]));
  const notificationsLeft = async (db) => (await db.query.rows(`select id from public.notifications order by id`)).map((row) => row.id);

  it('the holes are there before, closed after, and back after the rollback', async () => {
    const db = await production();
    expect(await holes(db)).toEqual(OPEN_HOLES);

    await db.runFile(migration.paths.migration);
    expect(await holes(db)).toEqual(CLOSED_HOLES);

    // The app that is deployed today, on what is not reviewed: as before.
    expect(await request(db, THE_ATHLETE, UPSERT(OPEN, `'Done'`))).toBe('written');
    expect(await request(db, THE_ATHLETE, UPSERT(WAITING, `'A note added later'`))).toBe('written');
    expect(await request(db, THE_ATHLETE, UNDO(WAITING))).toBe('written');
    expect(await request(db, THE_ATHLETE, `${UNDO(WAITING)}; ${UPSERT(WAITING, 'null')}`)).toBe('written');
    expect(await request(db, THE_COACH, FINISH(WAITING))).toBe('written');
    expect(await request(db, THE_COACH, FEEDBACK(WAITING))).toBe('written');
    // …confirmed and reviewed in the same breath, the confirmation is closed.
    expect(await request(db, THE_COACH,
      `${FINISH(WAITING)};
       select set_config('request.jwt.claims', '${JSON.stringify(THE_ATHLETE.claims)}', true);
       ${UNDO(WAITING)}`)).toBeNull();
    // The session reviewed without a confirmation: confirmed by its athlete, and then for good.
    expect(await request(db, THE_ATHLETE, UPSERT(LEGACY, 'null'))).toBe('written');
    expect(await request(db, THE_ATHLETE, `${UPSERT(LEGACY, 'null')}; ${UNDO(LEGACY)}`)).toBeNull();
    // Reading: as before.
    expect(await request(db, THE_ATHLETE, `select count(*) from public.session_confirmations`)).toBe(2);
    expect(await request(db, THE_COACH, `select count(*) from public.session_confirmations`)).toBe(2);
    // Nothing above was kept.
    expect(await db.query.one(
      `select (select count(*) from public.session_confirmations) as confirmations,
              (select count(*) from public.sessions where reviewed_at is not null) as reviewed,
              (select count(*) from public.messages) as messages,
              (select count(*) from public.slot_deviations) as deviations`,
    )).toEqual({ confirmations: 2, reviewed: 2, messages: 1, deviations: 1 });

    await db.runFile(migration.paths.rollback);
    // The holes are back. The lines the migration deleted are not: one "session completed" line of S2 is left, its own.
    expect(await holes(db)).toEqual({
      ...OPEN_HOLES,
      'unread "session completed" lines left once the confirmation of a session is taken back': 1,
    });
    await db.drop();
  });

  it('adds 5 functions and 4 triggers, replaces 3 policies and the function of the push, opens session_writable to signed-in users, signs the ledger — no table, no column', async () => {
    const db = await production();
    const before = await catalogSnapshot(db.query);
    await db.runFile(migration.paths.migration);
    const after = await catalogSnapshot(db.query);

    const lines = diffCatalogs(before, after, { left: 'before', right: 'after' });
    const only = (side) => lines.filter((line) => line.endsWith(`: only in ${side}`))
      .map((line) => line.slice(0, -`: only in ${side}`.length)).sort();
    expect(only('after')).toEqual([
      'functions public.block_confirmation_delete_when_reviewed()',
      'functions public.retract_session_completed_notification()',
      'functions public.retract_slot_deviation_notifications()',
      'functions public.review_needs_confirmation()',
      'functions public.session_is_confirmed(sess_id uuid)',
      'triggers public.session_confirmations.block_confirmation_delete_when_reviewed',
      'triggers public.session_confirmations.trg_retract_session_completed_notification',
      'triggers public.sessions.trg_review_needs_confirmation',
      'triggers public.slot_deviations.trg_retract_slot_deviation_notifications',
    ]);
    expect(only('before')).toEqual([]);
    const changed = lines.filter((line) => !/: only in (before|after)$/.test(line))
      .map((line) => /^(.*?): \w+: /.exec(line)[1]);
    expect([...new Set(changed)].sort()).toEqual([
      'data row count of public.notifications',
      'data rows of app_private.app_migrations',
      'functions public.notify_coach_on_session_confirm()',
      'functions public.session_writable(sess_id uuid)',
      'policies public.messages.Send to coach-student counterpart',
      'policies public.session_confirmations.Students delete own session confirmations',
      'policies public.session_confirmations.Students update own session confirmations',
    ]);

    // Who may execute them, and how they run.
    const OPEN_TO_USERS = ['authenticated: EXECUTE', 'postgres: EXECUTE', 'service_role: EXECUTE'];
    const CLOSED = ['postgres: EXECUTE', 'service_role: EXECUTE'];
    for (const [key, privileges, volatility] of [
      ['public.session_is_confirmed(sess_id uuid)', OPEN_TO_USERS, 'STABLE'],
      ['public.session_writable(sess_id uuid)', OPEN_TO_USERS, 'STABLE'],
      ['public.review_needs_confirmation()', CLOSED, null],
      ['public.block_confirmation_delete_when_reviewed()', CLOSED, null],
      ['public.retract_session_completed_notification()', CLOSED, null],
      ['public.retract_slot_deviation_notifications()', CLOSED, null],
      ['public.notify_coach_on_session_confirm()', CLOSED, null],
    ]) {
      const fn = after.functions[key];
      expect(fn.privileges, key).toEqual(privileges);
      expect(fn.owner, key).toBe('postgres');
      expect(fn.definition, key).toContain(`\n SET search_path TO 'public', 'pg_temp'\n`);
      expect(fn.definition, key).toContain('SECURITY DEFINER');
      // VOLATILE is the default, and pg_get_functiondef does not print it.
      expect(/\n (STABLE|IMMUTABLE)\b/.exec(fn.definition)?.[1] ?? null, key).toBe(volatility);
    }
    // The function of the push: one line.
    const changedLines = (a, b) => a.split('\n').filter((line, i) => line !== b.split('\n')[i]);
    expect(changedLines(
      after.functions['public.notify_coach_on_session_confirm()'].definition,
      before.functions['public.notify_coach_on_session_confirm()'].definition,
    )).toEqual([`            'tag',   'session-confirm-' || NEW.session_id::text,`]);
    // The policies that read, the coach's, and the athlete's INSERT of a confirmation are the ones from before.
    for (const key of Object.keys(before.policies)) {
      if (/^public\.(session_confirmations|messages)\./.test(key) && !changed.includes(`policies ${key}`)) {
        expect(after.policies[key], key).toEqual(before.policies[key]);
      }
    }
    expect(Object.keys(before.policies)).toContain('public.session_confirmations.Students insert own session confirmations');
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
    // are numbers about production's sessions and notifications.
    const exact = rows.filter((line) => /^`.+`$/.test(line.before) && /^`.+`$/.test(line.after))
      .map((line) => ({ ...line, before: line.before.slice(1, -1), after: line.after.slice(1, -1) }));
    const counted = rows.filter((line) => !exact.some((e) => e.n === line.n));
    expect(counted.map((line) => [line.check, line.before, line.after])).toEqual([
      [LINE.legacy, 'a number', 'the same number'],
      [LINE.staleCompleted, 'a number', '`0`'],
      [LINE.staleOffPlan, 'a number', '`0`'],
    ]);
    const onPage = (column, numbers) => [
      ...exact.map((line) => [line.n, line.check, line[column]]),
      ...counted.map((line, i) => [line.n, line.check, numbers[i]]),
    ].sort((a, b) => a[0] - b[0]).map(([, check, value]) => [check, value]);

    expect(await printed()).toEqual(onPage('before', ['1', '2', '2']));
    await db.runFile(migration.paths.migration);
    expect(await printed()).toEqual(onPage('after', ['1', '0', '0']));
    // …and the header of the audit file says the same.
    const header = audit.split('\n').filter((line) => line.startsWith('--')).join('\n');
    for (const { check, before, after } of exact) {
      expect(header, check).toContain(check);
      expect(header).toContain(before);
      expect(header).toContain(after);
    }
    for (const { check } of counted) expect(header, check).toContain(check);
    await db.drop();
  });

  // session_writable(uuid) is migration 08's function, and its audit lists
  // what a signed-in user may execute of them: the page says what that line
  // reads from now on.
  it('the audit of migration 08, run again afterwards: its gates still read yes, and its line 9 names session_writable too', async () => {
    const db = await production();
    const earlier = manifest.migrations.find((m) => m.order === 8);
    const audit08 = async () => {
      const [result] = await db.readOnly(read(earlier.paths.audit), 'audit of 08');
      return Object.fromEntries(result.rows.map((line) => [line.check, line.value]));
    };
    const CALLABLE = 'functions of this migration a signed-in user may execute';
    const before = await audit08();
    expect(before[CALLABLE]).toBe('session_writable_for_slot(uuid); set_video_slot(text); slot_for_set_log(uuid)');

    await db.runFile(migration.paths.migration);
    expect(await audit08()).toEqual({
      ...before, [CALLABLE]: 'session_writable(uuid); session_writable_for_slot(uuid); set_video_slot(text); slot_for_set_log(uuid)',
    });
    expect(page).toContain('lists `session_writable(uuid)` on its line 9 as well');
    await db.drop();
  });

  it('deletes the notifications that are stale, and those only — they do not come back with the rollback', async () => {
    const db = await production();
    const all = await notificationsLeft(db);
    // Written by the triggers of the baseline: two confirmations, one skip, one feedback.
    expect(all).toHaveLength(Object.keys(STALE).length + Object.keys(KEPT).length + 4);
    expect(all).toEqual(expect.arrayContaining([...Object.values(STALE), ...Object.values(KEPT)]));
    expect(await printedAudit(db)).toMatchObject({ [LINE.staleCompleted]: '2', [LINE.staleOffPlan]: '2' });

    await db.runFile(migration.paths.migration);
    const left = await notificationsLeft(db);
    expect(all.filter((id) => !left.includes(id)).sort()).toEqual(Object.values(STALE).sort());
    expect(left).toEqual(expect.arrayContaining(Object.values(KEPT)));
    expect(await printedAudit(db)).toMatchObject({ [LINE.staleCompleted]: '0', [LINE.staleOffPlan]: '0' });
    // What is there keeps its line: the two confirmations, the skip, the feedback.
    expect(await db.query.rows(
      `select kind, count(*) as lines from public.notifications where read_at is null and id <> all($1) group by kind order by kind`,
      [Object.values(KEPT)],
    )).toEqual([
      { kind: 'session_completed', lines: 2 }, { kind: 'session_deviation', lines: 1 }, { kind: 'session_feedback', lines: 1 },
    ]);

    await db.runFile(migration.paths.rollback);
    expect(await notificationsLeft(db)).toEqual(left);
    // The page and the two files say so.
    expect(page).toContain('**the notifications the migration deleted do not come back**');
    expect(read(migration.paths.rollback)).toContain('THE NOTIFICATIONS THE MIGRATION DELETED DO');
    expect(read(migration.paths.migration)).toContain('They do not come back with the\n--      rollback.');
    await db.drop();
  });

  it('the page\'s check answers NOT PROTECTED before, protected after, BROKEN when a confirmation can no longer be undone — and writes nothing', async () => {
    const db = await production();
    expect(pageCheck, 'the page no longer gives the check').toBeTruthy();
    // Pasted between single quotes in a shell: it may not hold one.
    expect(pageCheck).not.toContain("'");
    const checked = async () => {
      const tried = await attempt(() => db.runSql(pageCheck, 'page check'));
      expect(tried.ok, 'the check must always fail: that is what undoes it').toBe(false);
      return (tried.error.cause ?? tried.error).message;
    };
    const untouched = async () => db.query.one(
      `select (select count(*) from public.session_confirmations) as confirmations,
              (select count(*) from public.sessions where reviewed_at is not null) as reviewed,
              (select count(*) from public.notifications) as notifications,
              current_user::text as role, coalesce(current_setting('request.jwt.claims', true), '') as claims`,
    );
    const start = await untouched();
    expect(start).toMatchObject({ confirmations: 2, reviewed: 2, role: 'postgres', claims: '' });

    expect(await checked()).toBe('check only, nothing was written: NOT PROTECTED: the athlete took back the confirmation of a reviewed session');
    expect(await untouched()).toEqual(start);

    await db.runFile(migration.paths.migration);
    const applied = await untouched();
    expect(await checked()).toBe(PROTECTED);
    expect(await untouched()).toEqual(applied);
    // What the page says the command prints.
    expect(page).toContain(`\`${PROTECTED}\``);
    expect(page).toContain('`… NOT PROTECTED: the athlete took back the confirmation of a reviewed session`');
    expect(page).toContain('`… BROKEN: the athlete cannot take back a confirmation the coach has not reviewed`');

    // The second half of the rule, alone: a review that asks nothing.
    await db.query(`alter table public.sessions disable trigger trg_review_needs_confirmation`);
    expect(await checked()).toBe('check only, nothing was written: NOT PROTECTED: the coach marked as reviewed a session its athlete has not confirmed');
    await db.query(`alter table public.sessions enable trigger trg_review_needs_confirmation`);
    // A refusal that is not the rule's is not read as "protected".
    await db.query(`revoke update on public.sessions from authenticated`);
    expect(await checked()).toBe('permission denied for table sessions');
    await db.query(`grant update on public.sessions to authenticated`);
    expect(await checked()).toBe(PROTECTED);

    // The thing to roll back for: an athlete who can no longer undo a confirmation.
    await db.query(`alter policy "Students delete own session confirmations" on public.session_confirmations using (false)`);
    expect(await checked()).toBe('check only, nothing was written: BROKEN: the athlete cannot take back a confirmation the coach has not reviewed');
    expect(await untouched()).toEqual(applied);

    // With no session of one of the three kinds there is nothing to try, and it says so.
    await db.query(`update public.sessions set reviewed_at = null`);
    const NOTHING_TO_TRY = 'check only: the blocks being trained do not hold a reviewed session, a confirmed one that is not reviewed and one that is not confirmed, nothing to try';
    expect(await checked()).toBe(NOTHING_TO_TRY);
    expect(page).toContain(`\`${NOTHING_TO_TRY}\` is no answer either way`);
    await db.drop();
  });

  // Line 13 of the audit: what the coach app deployed before wave 1 could
  // leave behind, and the owner still can.
  it('a session reviewed without a confirmation: counted, listed by the page\'s query, left as it is — and it leaves the list when its athlete confirms it', async () => {
    const db = await production();
    const list = queryAbout('public.messages m');
    expect(list, 'the page no longer gives the query that lists them').toBeTruthy();
    const listed = async () => (await db.readOnly(list, 'page query'))[0].rows;
    const LISTED = [{
      session_id: LEGACY, athlete: 'Alex', block: 'Block', block_is: 'being trained', session: 'S4',
      reviewed_on: '2026-10-01', archived: false, feedback_sent: false,
    }];
    expect((await printedAudit(db))[LINE.legacy]).toBe('1');
    expect(await listed()).toEqual(LISTED);

    await db.runFile(migration.paths.migration);
    expect((await printedAudit(db))[LINE.legacy]).toBe('1');
    expect(await listed()).toEqual(LISTED);
    // The coach still works with it…
    expect(await committed(db, THE_COACH, `update public.sessions set archived_at = now() where id = '${LEGACY}' returning 'written'`)).toBe('written');
    expect((await listed())[0]).toMatchObject({ archived: true });
    expect(await committed(db, THE_COACH, `update public.sessions set archived_at = null, title = 'S4 — deload' where id = '${LEGACY}' returning 'written'`)).toBe('written');
    // …and its athlete confirms it.
    expect(await committed(db, THE_ATHLETE, UPSERT(LEGACY, 'null'))).toBe('written');
    expect(await listed()).toEqual([]);
    expect((await printedAudit(db))[LINE.legacy]).toBe('0');

    // A past block and the trash are named as such.
    await db.query(`delete from public.session_confirmations where session_id = '${LEGACY}'`);
    await db.query(`update public.programs set is_active = false where id = '${PROGRAM}'`);
    expect((await listed())[0]).toMatchObject({ session_id: LEGACY, block_is: 'a past block' });
    await db.query(`update public.programs set deleted_at = now() where id = '${PROGRAM}'`);
    expect((await listed())[0]).toMatchObject({ session_id: LEGACY, block_is: 'in the trash' });
    await db.drop();
  });

  // "Taking a review back": the app has no reopening, the page has the three
  // statements.
  it('from the SQL editor: the page\'s statements take a review back, and the coach reviews the session again once it is confirmed', async () => {
    const db = await production();
    await db.runFile(migration.paths.migration);
    expect(await request(db, THE_ATHLETE, UNDO(SESSION_R))).toBeNull();

    const reopen = inline('update public.sessions set reviewed_at = null');
    expect(reopen, 'the page no longer gives the statement').toBe(
      `update public.sessions set reviewed_at = null where id = '<id of the session>'`,
    );
    expect((await db.query(reopen.replace('<id of the session>', SESSION_R))).rowCount).toBe(1);
    // Open again: the athlete takes the confirmation back, corrects, confirms again.
    expect(await committed(db, THE_ATHLETE, UNDO(SESSION_R))).toBe('written');
    expect(await request(db, THE_COACH, FEEDBACK(SESSION_R))).toBe(RLS('messages'));
    expect(await committed(db, THE_ATHLETE, UPSERT(SESSION_R, `'Corrected'`))).toBe('written');

    // The feedback of the first review is still there, and a session has one.
    expect(await request(db, THE_COACH, FEEDBACK(SESSION_R)))
      .toBe('duplicate key value violates unique constraint "messages_session_idx"');
    const forget = inline('delete from public.messages where session_id');
    const forgetLine = inline('delete from public.notifications where kind');
    expect(forget, 'the page no longer gives the statement').toBe(`delete from public.messages where session_id = '<id of the session>'`);
    expect(forgetLine, 'the page no longer gives the statement').toBe(
      `delete from public.notifications where kind = 'session_feedback' and payload->>'session_id' = '<id of the session>'`,
    );
    expect((await db.query(forget.replace('<id of the session>', SESSION_R))).rowCount).toBe(1);
    expect((await db.query(forgetLine.replace('<id of the session>', SESSION_R))).rowCount).toBe(1);

    expect(await committed(db, THE_COACH, FEEDBACK(SESSION_R))).toBe('written');
    expect(await db.query.one(
      `select s.reviewed_at is not null as reviewed, (select body from public.messages m where m.session_id = s.id) as feedback,
              (select notes from public.session_confirmations c where c.session_id = s.id) as notes
         from public.sessions s where s.id = $1`, [SESSION_R],
    )).toEqual({ reviewed: true, feedback: 'Well done.', notes: 'Corrected' });
    expect(await request(db, THE_ATHLETE, UNDO(SESSION_R))).toBeNull();

    // The statement of the page of migration 08 that closes a session by hand
    // is still accepted from the SQL editor — and this page says what it leaves.
    const earlier = read(manifest.migrations.find((m) => m.order === 8).paths.runbook);
    const close = [...earlier.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]).find((code) => code.startsWith('update public.sessions set reviewed_at = now()'));
    expect(close, 'the page of migration 08 no longer gives the statement').toBeTruthy();
    expect((await db.query(close.replace('<id of the session>', OPEN))).rowCount).toBe(1);
    expect((await printedAudit(db))[LINE.legacy]).toBe('2');
    expect(page).toContain('the statement is accepted from the SQL editor, and the session joins the list of line 13');
    await db.drop();
  });

  // Line 12 of the audit: a rule made by hand, under a name the file does not
  // know, would stay next to the new ones — and policies add up.
  it('a write policy it does not know: named by the audit, and the migration undoes itself — the notifications included', async () => {
    for (const [byHand, named, said] of [
      [`create policy "By hand" on public.session_confirmations for delete using (student_id = auth.uid())`,
        'public.session_confirmations: By hand',
        'public.session_confirmations has the policy "By hand" for DELETE, which this migration does not know'],
      [`create policy "Anything goes" on public.messages for all to authenticated using (sender_id = auth.uid())`,
        'public.messages: Anything goes', 'public.messages has the policy "Anything goes" for ALL, which this migration does not know'],
    ]) {
      const db = await production();
      await db.query(byHand);
      expect((await printedAudit(db))[LINE.strangers]).toBe(named);
      const before = await catalogSnapshot(db.query);
      const rows = await notificationsLeft(db);
      const refused = await attempt(() => db.runFile(migration.paths.migration));
      expect(refused.error?.message).toContain(`migration ${MIGRATION} did not get the policies it meant: ${said}`);
      expect(diffCatalogs(before, await catalogSnapshot(db.query), { left: 'before', right: 'after' })).toEqual([]);
      expect(await notificationsLeft(db)).toEqual(rows);
      expect(await db.query.value(`select count(*) from ${LEDGER} where name = $1`, [MIGRATION])).toBe(0);
      await db.drop();
    }
    expect(page).toContain('**12** is not `none` — **stop and report the line.**');
  });

  it('a rule that is there and does not ask, or a trigger that is switched off, is not "yes" for the audit', async () => {
    const db = await production();
    expect(await printedAudit(db)).toMatchObject({ ...rules('no'), [LINE.callable]: 'none', [LINE.strangers]: 'none' });
    await db.runFile(migration.paths.migration);
    expect(await printedAudit(db)).toMatchObject({
      ...rules('yes'), [LINE.callable]: 'session_is_confirmed(uuid); session_writable(uuid)', [LINE.strangers]: 'none',
    });

    await db.query(`alter policy "Students delete own session confirmations" on public.session_confirmations
                      using (student_id = auth.uid())`);
    await db.query(`alter table public.sessions disable trigger trg_review_needs_confirmation`);
    await db.query(`alter policy "Send to coach-student counterpart" on public.messages with check (sender_id = auth.uid())`);
    await db.query(`drop trigger trg_retract_slot_deviation_notifications on public.slot_deviations`);
    expect(await printedAudit(db)).toMatchObject({
      ...rules('yes'), [LINE.closed]: 'no', [LINE.needs]: 'no', [LINE.feedback]: 'no', [LINE.retractDeviation]: 'no',
    });
    await db.drop();
  });

  it('without migration 08 it says so (SLM02), and its rollback says there is nothing to undo (SLM03)', async () => {
    const db = await scratchDatabase();
    await db.runFile(manifest.baseline);
    const refusals = async () => {
      const before = await catalogSnapshot(db.query);
      const refused = await attempt(() => db.runFile(migration.paths.migration));
      const undone = await attempt(() => db.runFile(migration.paths.rollback));
      expect(diffCatalogs(before, await catalogSnapshot(db.query), { left: 'before', right: 'after' })).toEqual([]);
      return [refused.error?.code, refused.error?.message, undone.error?.code];
    };
    // Without a ledger at all, then with the ledger and the migrations before 08 only.
    const needs = 'needs 2026_10_12_08_session_write_gates, which is not applied';
    let [code, message, undone] = await refusals();
    expect([code, undone]).toEqual([REFUSAL.predecessorMissing, REFUSAL.notApplied]);
    expect(message).toContain(needs);
    for (const earlier of manifest.migrations.slice(0, 7)) await db.runFile(earlier.paths.migration);
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
    // A session_is_confirmed made by hand, with a second argument: a policy
    // written later could reach it instead of the one of this file.
    await db.query(`create function public.session_is_confirmed(sess_id uuid, p_who uuid) returns boolean language sql as 'select true'`);
    expect(await refusal()).toContain(`migration ${MIGRATION} would not replace: session_is_confirmed(uuid,uuid)`);
    await db.query(`drop function public.session_is_confirmed(uuid, uuid)`);

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
       create function public.session_is_confirmed(sess_id uuid) returns boolean language sql as 'select true';
       grant execute on function public.session_is_confirmed(uuid) to service_role with grant option;
       set local role service_role;
       grant execute on function public.session_is_confirmed(uuid) to anon;
       COMMIT;`,
      'a function made by hand, opened by another role',
    );
    const before = await catalogSnapshot(db.query);
    const rows = await notificationsLeft(db);
    const refused = await attempt(() => db.runFile(migration.paths.migration));
    expect(refused.error?.message).toContain(
      `migration ${MIGRATION} did not get the functions it meant: public.session_is_confirmed(uuid): anon may execute it`,
    );
    expect(diffCatalogs(before, await catalogSnapshot(db.query), { left: 'before', right: 'after' })).toEqual([]);
    expect(await notificationsLeft(db)).toEqual(rows);
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
