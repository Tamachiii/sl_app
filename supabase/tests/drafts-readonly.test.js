// The draft an athlete is writing is theirs alone — review finding P53,
// closed by migration 2026_10_16_20_drafts_coach_readonly.
//
// A draft is a block its athlete writes and sends to the coach (Phase 3.4).
// The coach's policies on its tree — "Coaches manage weeks", "… sessions",
// "… exercise slots", "… set log prescriptions" — are FOR ALL and never look
// at programs.status, so the coach wrote a draft like any block, and:
//   * what the coach wrote was lost at the athlete's next save — save_draft_tree
//     deletes the phases and writes them again from what the phone holds;
//   * the sets of a higher "Sets", which the editor writes with the targets of
//     a last row a draft does not have, outlived the approval without reps or
//     load: approve_program added only the set numbers that had no row.
// Since the migration:
//
//   block_draft_tree_write   on weeks, sessions, exercise_slots, set_logs:
//                            a write that carries a user id other than the
//                            draft's author (programs.created_by), on a row of
//                            a program whose status is 'draft' — its parent as
//                            it was and as it would be — is refused: P0001,
//                            draft_read_only.
//   approve_program          marks the program approved FIRST, drops the sets
//                            without a target, writes the missing sets from
//                            the exercises; answers as before.
//
// The first blocks run against schema.sql, as the callers the app has. The
// coach's requests are written out as the app that is deployed sends them
// (src/hooks/useSession.js, useWeek.js, useProgram.js; the RPCs of migrations
// 11 and 12), the author's as src/hooks/useAuthoring.js and
// src/lib/offlineMutations.js send them. The last block applies the migration
// file itself to the frozen production baseline, with the checks of its
// runbook page read off the page.

import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  asAdmin, asService, asUser, attempt, createDraftProgram, createProgram, createUser, repoRoot, scenario,
  scratchDatabase, seed,
} from './harness.js';
import { catalogSnapshot, diffCatalogs } from './catalog.js';
import { LEDGER, loadManifest, migrationsBefore, REFUSAL } from '../migrations/manifest.js';

const MIGRATION = '2026_10_16_20_drafts_coach_readonly';
const manifest = loadManifest();
const migration = manifest.migrations.find((m) => m.name === MIGRATION);
const read = (file) => fs.readFileSync(path.join(repoRoot, file), 'utf8');

const P0001 = 'P0001';
const DENIED = '42501';
const READ_ONLY = ['draft_read_only', P0001];
const TABLES = ['weeks', 'sessions', 'exercise_slots', 'set_logs'];

// seed(): coach Carla; Alex (athlete A) trains "Block A" — 2 weeks × 2
// sessions, each a pull-up slot and a dip slot of 3 sets; Billie (athlete B)
// trains "Block B". Next to them:
//   sent      "Sent in" — Alex's draft, sent to the coach: 1 phase, 2 sessions
//   writing   "Being written" — Billie's draft, not sent yet
//   thrown    "Thrown away" — an older draft of Alex, in the trash
//   casey     a third athlete of Carla, with "Old block": approved, not active
let ids;
let sent;
let writing;
let thrown;
let casey;
let oldBlock;
beforeAll(async () => {
  ids = await seed();
  thrown = await createDraftProgram(ids.studentA, { name: 'Thrown away' });
  await asAdmin((q) => q(`update programs set deleted_at = now() where id = $1`, [thrown.id]), { commit: true });
  sent = await createDraftProgram(ids.studentA, { name: 'Sent in', sessions: 2, submitted: true });
  writing = await createDraftProgram(ids.studentB, { name: 'Being written' });
  casey = await createUser({ email: 'casey@sl.test', fullName: 'Casey Athlete', coach: ids.coach });
  oldBlock = await createProgram({ student: casey, name: 'Old block' });
});

const coach = (fn, options) => asUser(ids.coach, fn, options);
const alex = (fn, options) => asUser(ids.studentA, fn, options);
const billie = (fn, options) => asUser(ids.studentB, fn, options);

/** `[message, SQLSTATE]` of what `fn` raised — or `'it went through'`. */
const refusal = async (fn) => {
  const tried = await attempt(fn);
  return tried.ok ? 'it went through' : [tried.error.message, tried.error.code];
};

/** How many rows the five tables hold. */
const census = (q) => q.one(
  `select (select count(*) from programs) as programs, (select count(*) from weeks) as weeks,
          (select count(*) from sessions) as sessions, (select count(*) from exercise_slots) as slots,
          (select count(*) from set_logs) as set_logs`,
);
/** A whole program as JSON — every column of every row under it, no id. */
const treeOf = (q, programId) => q.value(
  `select jsonb_build_object(
            'program', to_jsonb(p) - 'id' - 'created_at',
            'weeks', (select coalesce(jsonb_agg((to_jsonb(w) - 'id' - 'program_id' - 'created_at') || jsonb_build_object(
              'sessions', (select coalesce(jsonb_agg((to_jsonb(s) - 'id' - 'week_id' - 'created_at') || jsonb_build_object(
                'slots', (select coalesce(jsonb_agg((to_jsonb(es) - 'id' - 'session_id' - 'created_at') || jsonb_build_object(
                  'sets', (select coalesce(jsonb_agg(to_jsonb(sl) - 'id' - 'exercise_slot_id' - 'created_at' order by sl.set_number), '[]'::jsonb)
                             from set_logs sl where sl.exercise_slot_id = es.id))
                  order by es.sort_order, es.exercise_id), '[]'::jsonb)
                  from exercise_slots es where es.session_id = s.id))
                order by s.sort_order, s.id), '[]'::jsonb)
                from sessions s where s.week_id = w.id))
              order by w.week_number), '[]'::jsonb)
              from weeks w where w.program_id = p.id))
     from programs p where p.id = $1`, [programId],
);
/** The sets of an exercise: `[set_number, target_reps, target_weight_kg, target_rest_seconds]`. */
const setsOf = async (q, slotId) => (await q.rows(
  `select set_number, target_reps, target_weight_kg::float8 as weight, target_rest_seconds
     from set_logs where exercise_slot_id = $1 order by set_number`, [slotId],
)).map((s) => [s.set_number, s.target_reps, s.weight, s.target_rest_seconds]);

// What the coach's editor sent to a draft before the migration: the rows of a
// higher "Sets" — the targets of a last row a draft does not have, so none.
// Written as the owner: the coach can no longer write them.
const coachMadeSets = (q, slotId, numbers) => q(
  `insert into set_logs (exercise_slot_id, set_number, done)
   select $1, n, false from unnest($2::int[]) as n`, [slotId, numbers],
);

// ------------------------------------------------------------
// The coach's editor, as SQL: one entry per request of the app that is
// deployed. `[what, sql, params]`; each `returning id`, as `.select()` does.
// ------------------------------------------------------------
const editorOn = (draft) => {
  const [week] = draft.weeks;
  const [session] = draft.sessions;
  const [slot] = draft.tree[0].sessions[0].slots;
  return [
    // useWeek.js
    ['a phase added', `insert into weeks (program_id, week_number, label) values ($1, 9, 'Deload') returning id`, [draft.id]],
    ['a phase renamed', `update weeks set label = 'Peak' where id = $1 returning id`, [week]],
    ['a phase deleted', `delete from weeks where id = $1 returning id`, [week]],
    ['a session added', `insert into sessions (week_id, title, sort_order) values ($1, 'Extra', 9) returning id`, [week]],
    ['a session renamed', `update sessions set title = 'Renamed', day_number = 4 where id = $1 returning id`, [session]],
    ['a session archived', `update sessions set archived_at = now() where id = $1 returning id`, [session]],
    ['a session dated', `update sessions set scheduled_date = '2026-11-02' where id = $1 returning id`, [session]],
    ['a session marked reviewed', `update sessions set reviewed_at = now() where id = $1 and reviewed_at is null returning id`, [session]],
    ['the sessions parked, as the app before wave 2 reordered', `update sessions set sort_order = sort_order + 100000 where week_id = $1 returning id`, [week]],
    ['a session deleted', `delete from sessions where id = $1 returning id`, [session]],
    // useSession.js
    ['an exercise added', `insert into exercise_slots (session_id, exercise_id, sets, reps, weight_kg, sort_order)
                           values ($1, $2, 3, 8, 30, 9) returning id`, [session, ids.exercises.squat]],
    ['more sets for an exercise', `update exercise_slots set sets = 5 where id = $1 returning id`, [slot.id]],
    ['a note on an exercise', `update exercise_slots set notes = 'Elbows in' where id = $1 returning id`, [slot.id]],
    ['a superset', `update exercise_slots set superset_group = gen_random_uuid() where id = $1 returning id`, [slot.id]],
    ['a video asked for', `update exercise_slots set record_video_set_numbers = '{1}' where id = $1 returning id`, [slot.id]],
    ['another exercise', `update exercise_slots set exercise_id = $2 where id = $1 returning id`, [slot.id, ids.exercises.squat]],
    ['an exercise removed', `delete from exercise_slots where id = $1 returning id`, [slot.id]],
    ['the sets of a new exercise', `insert into set_logs (exercise_slot_id, set_number, target_reps, target_weight_kg)
                                    values ($1, 1, 8, 30) returning id`, [slot.id]],
  ];
};
/** The same on the set rows the editor wrote in a draft before the migration. */
const editorOnSets = (setIds) => [
  ['a target of one set', `update set_logs set target_reps = 6 where id = $1 and not done and not failed and not skipped returning id`, [setIds[0]]],
  ['the sets renumbered', `update set_logs set set_number = set_number + 100000 where id = any($1) returning id`, [setIds]],
  ['a set removed', `delete from set_logs where id = $1 returning id`, [setIds[0]]],
];

/** Each request on its own, as the coach: `{ what: [message, code] }`. */
const asTheCoach = async (requests, as = coach) => {
  const out = {};
  for (const [what, sql, params] of requests) {
    out[what] = await refusal(() => as((c) => c(sql, params)));
  }
  return out;
};
const allRefused = (requests) => Object.fromEntries(requests.map(([what]) => [what, READ_ONLY]));

// ============================================================
// The coach
// ============================================================
describe('the coach changes nothing in a draft of their athlete', () => {
  it('every request of the editor is refused with draft_read_only, and nothing is written — a draft sent in, one being written, one in the trash', () => scenario(async (q) => {
    const before = await census(q);
    const shapes = { [sent.id]: await treeOf(q, sent.id), [writing.id]: await treeOf(q, writing.id), [thrown.id]: await treeOf(q, thrown.id) };
    for (const draft of [sent, writing, thrown]) {
      const requests = editorOn(draft);
      expect(await asTheCoach(requests), draft.id).toEqual(allRefused(requests));
    }
    expect(await census(q)).toEqual(before);
    for (const draft of [sent, writing, thrown]) expect(await treeOf(q, draft.id)).toEqual(shapes[draft.id]);
  }));

  it('the sets the editor wrote in a draft before the migration: the coach no longer touches them either', () => scenario(async (q) => {
    const [slot] = sent.tree[0].sessions[0].slots;
    await coachMadeSets(q, slot.id, [1, 2, 3, 4]);
    const setIds = (await q.rows(`select id from set_logs where exercise_slot_id = $1 order by set_number`, [slot.id])).map((r) => r.id);
    const before = await treeOf(q, sent.id);
    const requests = editorOnSets(setIds);
    expect(await asTheCoach(requests)).toEqual(allRefused(requests));
    expect(await treeOf(q, sent.id)).toEqual(before);
  }));

  it('nothing moves into a draft, and nothing out of one: a session, an exercise, a set', () => scenario(async (q) => {
    const blockWeek = ids.programA.weeks[0];
    const [blockSession] = ids.programA.sessions;
    const [blockSlot] = ids.programA.slots;
    const [blockSet] = ids.programA.setLogs;
    const [draftWeek] = sent.weeks;
    const [draftSession] = sent.sessions;
    const [draftSlot] = sent.tree[0].sessions[0].slots;
    await coachMadeSets(q, draftSlot.id, [1]);
    const draftSet = await q.value(`select id from set_logs where exercise_slot_id = $1`, [draftSlot.id]);
    const before = await census(q);
    const blockBefore = await treeOf(q, ids.programA.id);
    const draftBefore = await treeOf(q, sent.id);
    const moves = [
      ['a session of the block into the draft', `update sessions set week_id = $2, sort_order = 50 where id = $1 returning id`, [blockSession, draftWeek]],
      ['a session of the draft into the block', `update sessions set week_id = $2, sort_order = 50 where id = $1 returning id`, [draftSession, blockWeek]],
      ['an exercise of the block into the draft', `update exercise_slots set session_id = $2 where id = $1 returning id`, [blockSlot, draftSession]],
      ['an exercise of the draft into the block', `update exercise_slots set session_id = $2 where id = $1 returning id`, [draftSlot.id, blockSession]],
      ['a set of the block into the draft', `update set_logs set exercise_slot_id = $2, set_number = 50 where id = $1 returning id`, [blockSet, draftSlot.id]],
      ['a set of the draft into the block', `update set_logs set exercise_slot_id = $2, set_number = 50 where id = $1 returning id`, [draftSet, blockSlot]],
    ];
    expect(await asTheCoach(moves)).toEqual(allRefused(moves));
    expect(await census(q)).toEqual(before);
    expect(await treeOf(q, ids.programA.id)).toEqual(blockBefore);
    expect(await treeOf(q, sent.id)).toEqual(draftBefore);
  }));

  // useAddSlot writes the exercise, then its sets; useUpdateSlot the count,
  // then the rows (reconcileSetLogCount). The first request is refused, the
  // app stops there — and the second, sent on its own, is refused as well.
  it('the editor\'s writes in two requests leave nothing half-written', () => scenario(async (q) => {
    const [session] = sent.sessions;
    const [slot] = sent.tree[0].sessions[0].slots;
    const before = await treeOf(q, sent.id);
    // "Add exercise".
    expect(await refusal(() => coach((c) => c.value(
      `insert into exercise_slots (session_id, exercise_id, sets, reps, weight_kg, rest_seconds, sort_order)
       values ($1, $2, 2, 8, 30, 90, 5) returning id`, [session, ids.exercises.squat],
    )))).toEqual(READ_ONLY);
    // "Sets: 3 → 5": the count, then the two new rows, without a target.
    expect(await refusal(() => coach((c) => c(`update exercise_slots set sets = 5 where id = $1`, [slot.id])))).toEqual(READ_ONLY);
    expect(await refusal(() => coach((c) => c(
      `insert into set_logs (exercise_slot_id, set_number, done, target_reps, target_duration_seconds, target_weight_kg, target_rest_seconds)
       values ($1, 1, false, null, null, null, null), ($1, 2, false, null, null, null, null)`, [slot.id],
    )))).toEqual(READ_ONLY);
    expect(await treeOf(q, sent.id)).toEqual(before);
  }));

  it('the functions that run with the coach\'s rights are refused the same way: move, reorder, duplicate, copy into a draft', () => scenario(async (q) => {
    const [week] = sent.weeks;
    const [first, second] = sent.sessions;
    // A second phase, so that there is an order to change (an order that is
    // already the one asked for writes nothing).
    const later = await q.value(`insert into weeks (program_id, week_number) values ($1, 2) returning id`, [sent.id]);
    const before = await census(q);
    const draftBefore = await treeOf(q, sent.id);
    const calls = [
      ['move_session', `select public.move_session($1, $2, $3, $4)`, [first, week, [second, first], [second, first]]],
      ['reorder_sessions', `select public.reorder_sessions($1, $2)`, [week, [second, first]]],
      ['reorder_weeks', `select public.reorder_weeks($1, $2)`, [sent.id, [later, week]]],
      ['duplicate_session', `select public.duplicate_session($1)`, [first]],
      ['duplicate_week', `select public.duplicate_week($1)`, [week]],
      ['copy_sessions from the block', `select public.copy_sessions($1, $2)`, [[ids.programA.sessions[0]], week]],
      ['duplicate_week of the block into the draft', `select public.duplicate_week(p_week_id => $1, p_dest_program_id => $2)`, [ids.programA.weeks[0], sent.id]],
    ];
    expect(await asTheCoach(calls)).toEqual(allRefused(calls));
    expect(await census(q)).toEqual(before);
    expect(await treeOf(q, sent.id)).toEqual(draftBefore);
  }));

  // What src/lib/mutationErrors.js reads: message, details and hint together.
  // None of its phrases is there, so the app shows its generic line — and
  // the word is the one the next app looks for.
  it('the refusal: P0001, the word draft_read_only, and two sentences that name the program and what to do', () => scenario(async () => {
    const [slot] = sent.tree[0].sessions[0].slots;
    const tried = await attempt(() => coach((c) => c(`update exercise_slots set notes = 'x' where id = $1`, [slot.id])));
    expect(tried.error).toMatchObject({ code: P0001, message: 'draft_read_only' });
    expect(tried.error.detail).toBe(
      `The exercise belongs to program ${sent.id}, a draft: only the account that wrote it changes its phases, sessions, exercises and sets.`,
    );
    expect(tried.error.hint).toBe('Approve the draft or send it back to its athlete. Once approved, it is edited like any other block.');
    const said = `${tried.error.message} ${tried.error.detail} ${tried.error.hint}`.toLowerCase();
    for (const phrase of ['logged set', 'foreign key', 'still referenced', 'permission denied', 'row-level security']) {
      expect(said).not.toContain(phrase);
    }
    const kinds = {};
    for (const [table, sql, id] of [
      ['weeks', `update weeks set label = 'x' where id = $1`, sent.weeks[0]],
      ['sessions', `update sessions set title = 'x' where id = $1`, sent.sessions[0]],
    ]) {
      const t = await attempt(() => coach((c) => c(sql, [id])));
      kinds[table] = t.error.detail;
    }
    expect(kinds).toEqual({
      weeks: `The phase belongs to program ${sent.id}, a draft: only the account that wrote it changes its phases, sessions, exercises and sets.`,
      sessions: `The session belongs to program ${sent.id}, a draft: only the account that wrote it changes its phases, sessions, exercises and sets.`,
    });
  }));
});

describe('the coach still handles the draft itself', () => {
  it('approves it and sends it back, as before', () => scenario(async (q) => {
    expect(await coach((c) => c.value(`select public.send_back_program($1)`, [sent.id]))).toEqual({ sent_back: true });
    expect(await q.value(`select submitted_at from programs where id = $1`, [sent.id])).toBeNull();
    expect(await coach((c) => c.value(`select public.approve_program($1)`, [sent.id])))
      .toEqual({ approved: true, set_logs_created: 12 });
    expect(await q.one(`select status, is_active, created_by from programs where id = $1`, [sent.id]))
      .toEqual({ status: 'approved', is_active: false, created_by: ids.studentA.id });
  }));

  it('renames it, puts it in the trash and takes it out — the row of the program is not judged', () => scenario(async (q) => {
    await coach(async (c) => {
      // useRenameProgram, useDeleteProgram, useRestoreProgram.
      expect((await c(`update programs set name = 'Alex, week 1' where id = $1`, [sent.id])).rowCount).toBe(1);
      expect((await c(`update programs set deleted_at = now(), is_active = false where id = $1`, [sent.id])).rowCount).toBe(1);
      expect((await c(`update programs set deleted_at = null where id = $1`, [sent.id])).rowCount).toBe(1);
    });
    expect(await q.one(`select name, deleted_at, status from programs where id = $1`, [sent.id]))
      .toEqual({ name: 'Alex, week 1', deleted_at: null, status: 'draft' });
  }));

  // useHardDeleteProgram: one DELETE of the program. The cascade reaches the
  // four tables with the coach's user id; each trigger finds no parent — "not
  // a draft" — and lets the row go.
  it('deletes it with everything under it — in the trash or not, with the sets the editor wrote in it', () => scenario(async (q) => {
    await coachMadeSets(q, sent.tree[0].sessions[0].slots[0].id, [1, 2, 3, 4]);
    const before = await census(q);
    for (const draft of [thrown, sent]) {
      expect((await coach((c) => c(`delete from programs where id = $1`, [draft.id]))).rowCount, draft.id).toBe(1);
    }
    expect(await census(q)).toEqual({
      programs: before.programs - 2,
      weeks: before.weeks - 2,
      sessions: before.sessions - 3,
      slots: before.slots - 6,
      set_logs: before.set_logs - 4,
    });
  }));

  it('duplicates it into a block of its own, which the coach then edits like any other', () => scenario(async (q) => {
    const made = await coach((c) => c.value(`select public.duplicate_program($1)`, [sent.id]));
    expect(made).toMatchObject({ weeks: 1, sessions: 2, slots: 4, set_logs: 0 });
    expect(await q.one(`select status, created_by from programs where id = $1`, [made.program_id]))
      .toEqual({ status: 'approved', created_by: null });
    const session = await q.value(`select s.id from sessions s join weeks w on w.id = s.week_id where w.program_id = $1 order by s.sort_order limit 1`, [made.program_id]);
    expect(await coach((c) => c.value(
      `insert into exercise_slots (session_id, exercise_id, sets, reps, sort_order) values ($1, $2, 3, 5, 9) returning sets`,
      [session, ids.exercises.squat],
    ))).toBe(3);
  }));
});

// ============================================================
// The author, and everybody else
// ============================================================
describe('the author writes the draft as before', () => {
  // src/hooks/useAuthoring.js, buildSnapshot → save_draft_tree (the request
  // of pins.test.js): the program row, then the phases deleted and written
  // again — through the four triggers, with the author's user id.
  it('save_draft_tree, twice over — a new draft, then the draft that is there', () => scenario(async (q) => {
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
    // Casey has no draft: one draft in flight per athlete.
    const save = () => asUser(casey, (author) => author.value(`select public.save_draft_tree($1)`, [tree]));
    for (const run of [1, 2]) {
      expect(await save(), `run ${run}`).toEqual({ program_id: program, weeks: 1, sessions: 2, slots: 1 });
    }
    // …and Alex saves the draft that is there, sent in.
    const sentTree = {
      program: { id: sent.id, name: 'Sent in, again', submitted_at: null },
      weeks: [{ id: sent.weeks[0], program_id: sent.id, week_number: 1, label: 'One' }],
      sessions: [{ id: sent.sessions[0], week_id: sent.weeks[0], title: 'Only one', sort_order: 0 }],
      slots: [{
        id: sent.slots[0], session_id: sent.sessions[0], exercise_id: ids.exercises.dip, sets: 4, reps: 6,
        weight_kg: 10, duration_seconds: null, rest_seconds: 60, sort_order: 0,
      }],
    };
    expect(await alex((a) => a.value(`select public.save_draft_tree($1)`, [sentTree])))
      .toEqual({ program_id: sent.id, weeks: 1, sessions: 1, slots: 1 });
    expect(await q.one(`select name, submitted_at is not null as sent from programs where id = $1`, [sent.id]))
      .toEqual({ name: 'Sent in, again', sent: true });
  }));

  it('every write of their own the policies let through: a phase, a session, an exercise — and discarding the draft', () => scenario(async (q) => {
    const [week] = sent.weeks;
    const [session] = sent.sessions;
    const [slot] = sent.tree[0].sessions[0].slots;
    await alex(async (a) => {
      expect(await a.value(`insert into weeks (program_id, week_number) values ($1, 2) returning week_number`, [sent.id])).toBe(2);
      expect(await a.value(`update sessions set title = 'Pull day' where id = $1 returning title`, [session])).toBe('Pull day');
      expect(await a.value(`update exercise_slots set sets = 5, notes = 'Mine' where id = $1 returning sets`, [slot.id])).toBe(5);
      expect(await a.value(
        `insert into exercise_slots (session_id, exercise_id, sets, reps, sort_order) values ($1, $2, 3, 5, 9) returning sets`,
        [session, ids.exercises.squat],
      )).toBe(3);
      expect((await a(`delete from sessions where id = $1`, [sent.sessions[1]])).rowCount).toBe(1);
      expect((await a(`update weeks set label = 'One' where id = $1`, [week])).rowCount).toBe(1);
    });
    // useDiscardDraft (src/lib/offlineMutations.js): one DELETE of the program.
    expect((await alex((a) => a(`delete from programs where id = $1`, [sent.id]))).rowCount).toBe(1);
    expect(await q.value(`select count(*) from weeks where program_id = $1`, [sent.id])).toBe(0);
  }));

  // The athlete writes no set in a draft: their policies on set_logs ask for
  // the block being trained. The trigger lets the author by — row-level
  // security refuses, as before.
  it('a set is still refused to them by row-level security, as before', () => scenario(async () => {
    const [slot] = sent.tree[0].sessions[0].slots;
    const tried = await attempt(() => alex((a) => a(`insert into set_logs (exercise_slot_id, set_number) values ($1, 1)`, [slot.id])));
    expect(tried.error?.code).toBe(DENIED);
    expect(tried.error.message).toContain('row-level security policy for table "set_logs"');
  }));

  // Billie is no author of Alex's draft. An UPDATE and a DELETE reach no row
  // (row-level security picks the rows first). An INSERT is judged by its
  // triggers BEFORE row-level security checks the row: refused, by this one.
  it('another athlete: an update and a delete reach no row, as before; an insert is refused — now by the trigger', () => scenario(async (q) => {
    const before = await treeOf(q, sent.id);
    await billie(async (b) => {
      expect((await b(`update sessions set title = 'Mine' where id = $1`, [sent.sessions[0]])).rowCount).toBe(0);
      expect((await b(`delete from weeks where id = $1`, [sent.weeks[0]])).rowCount).toBe(0);
    });
    expect(await refusal(() => billie((b) => b(`insert into weeks (program_id, week_number) values ($1, 7)`, [sent.id]))))
      .toEqual(READ_ONLY);
    expect(await treeOf(q, sent.id)).toEqual(before);
  }));

  it('a request without a user id writes it as before: the owner of the database, the service role', () => scenario(async (q) => {
    const [slot] = sent.tree[0].sessions[0].slots;
    await q(`update exercise_slots set notes = 'By the owner' where id = $1`, [slot.id]);
    await asService((s) => s(`insert into weeks (program_id, week_number) values ($1, 5)`, [sent.id]));
    await coachMadeSets(q, slot.id, [1]);
    await asService((s) => s(`delete from set_logs where exercise_slot_id = $1`, [slot.id]));
    expect(await q.one(`select notes, (select count(*) from weeks where program_id = $2) as weeks from exercise_slots where id = $1`, [slot.id, sent.id]))
      .toEqual({ notes: 'By the owner', weeks: 2 });
  }));
});

// ============================================================
// Everything that is not a draft
// ============================================================
describe('a block that is not a draft is written as before', () => {
  it('the coach edits a block of theirs, and the athlete trains it', () => scenario(async (q) => {
    const [session] = ids.programA.sessions;
    const [slot] = ids.programA.slots;
    await coach(async (c) => {
      // useAddSlot: the exercise, then its sets.
      const added = await c.value(
        `insert into exercise_slots (session_id, exercise_id, sets, reps, weight_kg, sort_order) values ($1, $2, 2, 8, 30, 9) returning id`,
        [session, ids.exercises.squat],
      );
      expect((await c(`insert into set_logs (exercise_slot_id, set_number, target_reps, target_weight_kg)
                       values ($1, 1, 8, 30), ($1, 2, 8, 30)`, [added])).rowCount).toBe(2);
      // useUpdateSlot, then reconcileSetLogCount.
      expect((await c(`update exercise_slots set sets = 4 where id = $1`, [slot])).rowCount).toBe(1);
      expect((await c(`insert into set_logs (exercise_slot_id, set_number, target_reps, target_weight_kg) values ($1, 4, 5, 20)`, [slot])).rowCount).toBe(1);
      expect((await c(`update sessions set title = 'Heavy pull' where id = $1`, [session])).rowCount).toBe(1);
    });
    // The athlete ticks a set (src/lib/offlineMutations.js, toggleDone).
    expect(await alex((a) => a.value(
      `update set_logs set done = true, failed = false, logged_at = now(), failed_at = null where id = $1 returning done`,
      [ids.programA.setLogs[0]],
    ))).toBe(true);
    expect(await q.value(`select count(*) from set_logs where exercise_slot_id = $1`, [slot])).toBe(4);
  }));

  it('a draft, once approved, is the coach\'s to edit', () => scenario(async (q) => {
    await coach((c) => c.value(`select public.approve_program($1)`, [sent.id]));
    const [slot] = sent.tree[0].sessions[0].slots;
    expect(await coach((c) => c.value(`update exercise_slots set notes = 'Elbows in' where id = $1 returning notes`, [slot.id])))
      .toBe('Elbows in');
    expect(await q.value(`select count(*) from set_logs where exercise_slot_id = $1`, [slot.id])).toBe(3);
  }));

  // No screen of the app makes a block a draft again; a coach who does it
  // through the API gets a draft nobody wrote (created_by is empty) — and the
  // rule is asked of the author: nobody who signs in writes its tree until it
  // is approved. approve_program gives it back.
  it('a block made a draft again is read-only for its coach too, until it is approved again', () => scenario(async (q) => {
    const [slot] = oldBlock.slots;
    await coach((c) => c(`update programs set status = 'draft' where id = $1`, [oldBlock.id]));
    expect(await q.one(`select status, created_by from programs where id = $1`, [oldBlock.id])).toEqual({ status: 'draft', created_by: null });
    expect(await refusal(() => coach((c) => c(`update exercise_slots set notes = 'x' where id = $1`, [slot])))).toEqual(READ_ONLY);
    expect(await refusal(() => coach((c) => c(`update set_logs set target_reps = 9 where id = $1`, [oldBlock.setLogs[0]])))).toEqual(READ_ONLY);
    // The owner writes it.
    await q(`update exercise_slots set notes = 'By the owner' where id = $1`, [slot]);
    // Approved again: every set it held is kept, nothing is missing.
    expect(await coach((c) => c.value(`select public.approve_program($1)`, [oldBlock.id]))).toEqual({ approved: true, set_logs_created: 0 });
    expect(await coach((c) => c.value(`update exercise_slots set notes = 'Mine again' where id = $1 returning notes`, [slot]))).toBe('Mine again');
  }));

  // During a cascade the parent row is already gone: no row, no draft.
  it('a row whose parent is not there is not a draft\'s: the foreign key answers for it', () => scenario(async () => {
    for (const [table, sql] of [
      ['weeks', `insert into weeks (program_id, week_number) values (gen_random_uuid(), 1)`],
      ['sessions', `insert into sessions (week_id, title, sort_order) values (gen_random_uuid(), 'x', 0)`],
      ['exercise_slots', `insert into exercise_slots (session_id, exercise_id, sets, reps, sort_order) values (gen_random_uuid(), '${ids.exercises.squat}', 1, 1, 0)`],
      ['set_logs', `insert into set_logs (exercise_slot_id, set_number) values (gen_random_uuid(), 1)`],
    ]) {
      const tried = await attempt(() => coach((c) => c(sql)));
      expect(tried.error?.code, table).not.toBe(P0001);
      expect(tried.error?.message, table).not.toBe('draft_read_only');
    }
  }));
});

// ============================================================
// approve_program
// ============================================================
describe('approve_program: the status first, and every set with its target', () => {
  // A draft of Casey: one phase, one session, a pull-up and a dip of 3 sets
  // of 5 at 20 kg, 120 s rest. In it, what the coach's editor and the owner
  // wrote before the migration.
  const draftWithSets = async (q) => {
    const draft = await createDraftProgram(casey, { submitted: true });
    const [pullUp, dip] = draft.tree[0].sessions[0].slots;
    // "Sets: 3 → 4" on the pull-up: the count, and four rows without a target.
    await q(`update exercise_slots set sets = 4 where id = $1`, [pullUp.id]);
    await coachMadeSets(q, pullUp.id, [1, 2, 3, 4]);
    // The dip: a set with a target (useAddSlot), and three rows without one
    // that are not the editor's to drop — logged, filmed, added by the athlete.
    await q(`insert into set_logs (exercise_slot_id, set_number, target_reps, target_weight_kg) values ($1, 1, 8, 30)`, [dip.id]);
    await q(`insert into set_logs (exercise_slot_id, set_number, rpe) values ($1, 2, 8)`, [dip.id]);
    const filmed = await q.value(`insert into set_logs (exercise_slot_id, set_number) values ($1, 3) returning id`, [dip.id]);
    await q(`insert into set_log_videos (set_log_id, storage_path, mime_type, size_bytes) values ($1, $2, 'video/mp4', 1000)`,
      [filmed, `${casey.id}/${dip.id}/1-clip.mp4`]);
    await q(`insert into set_logs (exercise_slot_id, set_number, is_student_added) values ($1, 4, true)`, [dip.id]);
    return { draft, pullUp, dip };
  };
  const dipRows = (q, slotId) => q.rows(
    `select set_number, target_reps, rpe::float8 as rpe, is_student_added,
            exists (select 1 from set_log_videos v where v.set_log_id = sl.id) as filmed
       from set_logs sl where exercise_slot_id = $1 order by set_number`, [slotId],
  );

  it('drops the sets without a target and writes them again from the exercise; keeps every other set; counts what it wrote', () => scenario(async (q) => {
    const { draft, pullUp, dip } = await draftWithSets(q);
    expect(await setsOf(q, pullUp.id)).toEqual([[1, null, null, null], [2, null, null, null], [3, null, null, null], [4, null, null, null]]);
    const dipBefore = await dipRows(q, dip.id);

    expect(await coach((c) => c.value(`select public.approve_program($1)`, [draft.id]))).toEqual({ approved: true, set_logs_created: 4 });
    expect(await setsOf(q, pullUp.id)).toEqual([[1, 5, 20, 120], [2, 5, 20, 120], [3, 5, 20, 120], [4, 5, 20, 120]]);
    expect(await dipRows(q, dip.id)).toEqual(dipBefore);
    expect(await q.one(`select status, submitted_at, approved_at is not null as approved from programs where id = $1`, [draft.id]))
      .toEqual({ status: 'approved', submitted_at: null, approved: true });
  }));

  it('a draft without a set gets all of them, as before', () => scenario(async (q) => {
    const draft = await createDraftProgram(casey, { submitted: true, sessions: 2 });
    expect(await coach((c) => c.value(`select public.approve_program($1)`, [draft.id]))).toEqual({ approved: true, set_logs_created: 12 });
    expect(await q.value(
      `select count(*) from set_logs where exercise_slot_id = any($1) and target_reps = 5 and target_weight_kg = 20`, [draft.slots],
    )).toBe(12);
  }));

  it('a caller who may not approve changes nothing — and a program that is not a draft answers approved: false', () => scenario(async (q) => {
    const { draft } = await draftWithSets(q);
    const before = await treeOf(q, draft.id);
    for (const caller of [casey, ids.studentA, ids.studentB]) {
      expect(await refusal(() => asUser(caller, (u) => u.value(`select public.approve_program($1)`, [draft.id]))), caller.email)
        .toEqual(['not authorized', P0001]);
    }
    expect(await treeOf(q, draft.id)).toEqual(before);
    expect(await coach((c) => c.value(`select public.approve_program($1)`, [ids.programA.id]))).toEqual({ approved: false });
  }));

  it('the status is written before anything else, and the program is asked for once more under its lock', async () => {
    const body = await asAdmin((q) => q.value(`select prosrc from pg_proc where oid = 'public.approve_program(uuid)'::regprocedure`));
    const code = body.replace(/--.*$/gm, '');
    const first = (needle) => code.indexOf(needle);
    const flip = first(`UPDATE public.programs SET status = 'approved'`);
    expect(flip).toBeGreaterThan(first('RAISE EXCEPTION \'not authorized\''));
    for (const write of ['UPDATE public.sessions', 'DELETE FROM public.set_logs', 'INSERT INTO public.set_logs', 'INSERT INTO public.notifications']) {
      expect(flip, write).toBeLessThan(first(write));
    }
    expect(code).toMatch(/WHERE id = p_program_id AND status = 'draft';\s+IF NOT FOUND THEN\s+RETURN jsonb_build_object\('approved', false\);/);
  });
});

// ============================================================
// Two requests at once
// ============================================================
describe('two requests that cross', () => {
  const lockWaits = () => asAdmin((q) => q.value(
    `select count(*) from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
  ));
  const untilWaiting = async (what) => {
    for (let tries = 0; await lockWaits() === 0; tries += 1) {
      if (tries === 500) throw new Error(`${what} never waited`);
      await new Promise((resolve) => { setTimeout(resolve, 10); });
    }
  };
  /** The coach approves in a transaction that stays open until `letGo()`. */
  const approvalHeldOpen = (programId) => {
    let letGo;
    const untilLetGo = new Promise((resolve) => { letGo = resolve; });
    let approved;
    const done = new Promise((resolve) => { approved = resolve; });
    const tx = coach(async (c) => {
      const answer = await c.value(`select public.approve_program($1)`, [programId]);
      approved(answer);
      await untilLetGo;
      return answer;
    }, { commit: true });
    return { tx, answered: Promise.race([done, tx]), letGo };
  };
  const cleanUp = (programId) => asAdmin(async (q) => {
    await q(`delete from notifications where payload->>'program_id' = $1`, [programId]);
    await q(`delete from programs where id = $1`, [programId]);
  }, { commit: true });

  // The save's first statement writes the row of the program, which the
  // approval holds from its first write on: the save waits, then finds a
  // program that is no longer a draft. Before the migration the approval
  // wrote that row LAST: the save went through, and deleted the phases under
  // the sets being written.
  it('the author\'s save that arrives while the coach approves waits, and is refused: the block is the one approved, every set with its target', async () => {
    const draft = await createDraftProgram(casey, { submitted: true });
    const approval = approvalHeldOpen(draft.id);
    let save;
    try {
      expect(await approval.answered).toEqual({ approved: true, set_logs_created: 6 });
      const tree = {
        program: { id: draft.id, name: 'Changed my mind', submitted_at: null },
        weeks: [{ id: draft.weeks[0], program_id: draft.id, week_number: 1, label: null }],
        sessions: [{ id: draft.sessions[0], week_id: draft.weeks[0], title: 'Only squats', sort_order: 0 }],
        slots: [],
      };
      save = asUser(casey, (author) => author.value(`select public.save_draft_tree($1)`, [tree]), { commit: true });
      save.catch(() => {});
      await untilWaiting('the save');
      approval.letGo();
      await approval.tx;
      const tried = await attempt(() => save);
      expect(tried.error?.code).toBe(DENIED);
      expect(tried.error.message).toContain('row-level security');
      await asAdmin(async (q) => {
        expect(await q.one(`select status, name from programs where id = $1`, [draft.id])).toEqual({ status: 'approved', name: 'My draft' });
        expect(await q.value(
          `select count(*) from set_logs where exercise_slot_id = any($1) and target_reps = 5 and target_weight_kg = 20`, [draft.slots],
        )).toBe(6);
        expect(await q.value(`select count(*) from exercise_slots where id = any($1)`, [draft.slots])).toBe(2);
      });
    } finally {
      approval.letGo();
      await Promise.allSettled([approval.tx, save]);
      await cleanUp(draft.id);
    }
  });

  it('two approvals that cross: the first approves, the second answers approved: false — one set of sets, one notification', async () => {
    const draft = await createDraftProgram(casey, { submitted: true });
    const approval = approvalHeldOpen(draft.id);
    let second;
    try {
      expect(await approval.answered).toEqual({ approved: true, set_logs_created: 6 });
      second = coach((c) => c.value(`select public.approve_program($1)`, [draft.id]), { commit: true });
      second.catch(() => {});
      await untilWaiting('the second approval');
      approval.letGo();
      await approval.tx;
      expect(await second).toEqual({ approved: false });
      await asAdmin(async (q) => {
        expect(await q.value(`select count(*) from set_logs where exercise_slot_id = any($1)`, [draft.slots])).toBe(6);
        expect(await q.value(
          `select count(*) from notifications where kind = 'program_approved' and payload->>'program_id' = $1`, [draft.id],
        )).toBe(1);
      });
    } finally {
      approval.letGo();
      await Promise.allSettled([approval.tx, second]);
      await cleanUp(draft.id);
    }
  });
});

// ============================================================
// The four triggers, in the catalog
// ============================================================
describe('block_draft_tree_write', () => {
  it('is on the four tables of the tree, before every other BEFORE trigger of each, on insert, update and delete', () => asAdmin(async (q) => {
    for (const table of TABLES) {
      const before = (await q.rows(
        `select tgname from pg_trigger where tgrelid = $1::regclass and not tgisinternal and tgtype & 3 = 3 order by tgname collate "C"`,
        [`public.${table}`],
      )).map((t) => t.tgname);
      expect(before[0], table).toBe('block_draft_tree_write');
      expect(await q.value(
        `select pg_get_triggerdef(oid) from pg_trigger where tgrelid = $1::regclass and tgname = 'block_draft_tree_write'`, [`public.${table}`],
      )).toMatch(new RegExp(`^CREATE TRIGGER block_draft_tree_write BEFORE INSERT OR DELETE OR UPDATE ON public\\.${table} FOR EACH ROW EXECUTE FUNCTION block_draft_\\w+_write\\(\\)$`));
    }
  }));

  it('its functions are STABLE, run as their owner with the search_path pinned, and nobody may call them', () => asAdmin(async (q) => {
    const rows = await q.rows(
      `select p.proname::text as name, p.provolatile as volatility, p.prosecdef as as_owner,
              p.proconfig as config,
              has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated
         from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'block_draft_%_write'
        order by 1`,
    );
    expect(rows).toEqual(['block_draft_session_write', 'block_draft_set_log_write', 'block_draft_slot_write', 'block_draft_week_write'].map((name) => ({
      name, volatility: 's', as_owner: true, config: ['search_path=public, pg_temp'], anon: false, authenticated: false,
    })));
  }));
});

// ============================================================
// The migration file, on the frozen production baseline
// ============================================================
describe('migration 2026_10_16_20_drafts_coach_readonly', () => {
  const COACH = '00000000-0000-4000-8000-00000000c0ac';
  const ATHLETE = '00000000-0000-4000-8000-0000000000a1';
  const LINK = '00000000-0000-4000-8000-000000000101';
  const PULL_UP = '00000000-0000-4000-8000-000000000201';
  const DIP = '00000000-0000-4000-8000-000000000202';
  const BLOCK = '00000000-0000-4000-8000-000000000301';
  const DRAFT = '00000000-0000-4000-8000-000000000302';
  const THROWN = '00000000-0000-4000-8000-000000000303';
  const W_BLOCK = '00000000-0000-4000-8000-000000000401';
  const W_DRAFT = '00000000-0000-4000-8000-000000000402';
  const W_THROWN = '00000000-0000-4000-8000-000000000403';
  const S_BLOCK = '00000000-0000-4000-8000-000000000451';
  const S_DRAFT = '00000000-0000-4000-8000-000000000452';
  const SLOT_BLOCK = '00000000-0000-4000-8000-000000000501';
  const SLOT_DRAFT = '00000000-0000-4000-8000-000000000502';
  const SLOT_DRAFT_2 = '00000000-0000-4000-8000-000000000503';
  const SET_BLOCK = '00000000-0000-4000-8000-000000000601';
  const TO_COME = '2099_01_01_99_a_migration_to_come';

  // A coach and their athlete. Alex trains "Block" (one session, one set) and
  // has sent "My draft" in: one session, a pull-up of 3 sets of 5 at 20 kg
  // that Alex wrote — in which the coach raised "Sets" to 4, before the
  // migration: four rows without a target — and a dip the coach added, with
  // its two sets. "Thrown away", an older draft of Alex, is in the trash. The
  // coach's role is set the way a dump restore sets it (finding P20, closed
  // by migration 07).
  const WORLD = `
    insert into auth.users (id, email, aud, role, email_confirmed_at, raw_user_meta_data) values
      ('${COACH}',   'coach@sl.test', 'authenticated', 'authenticated', now(), '{"full_name": "Coach Carla"}'),
      ('${ATHLETE}', 'alex@sl.test',  'authenticated', 'authenticated', now(), '{"full_name": "Alex"}');
    BEGIN;
    SET LOCAL session_replication_role = replica;
    update public.profiles set role = 'coach' where id = '${COACH}';
    COMMIT;
    insert into public.students (id, profile_id, coach_id) values ('${LINK}', '${ATHLETE}', '${COACH}');
    insert into public.exercise_library (id, coach_id, name, type, difficulty) values
      ('${PULL_UP}', '${COACH}', 'Pull-up', 'pull', 2), ('${DIP}', '${COACH}', 'Dip', 'push', 2);

    insert into public.programs (id, student_id, name, is_active) values ('${BLOCK}', '${LINK}', 'Block', true);
    insert into public.programs (id, student_id, name, status, is_active, created_by, submitted_at, deleted_at) values
      ('${DRAFT}',  '${LINK}', 'My draft',    'draft', false, '${ATHLETE}', '2026-10-14 18:00+00', null),
      ('${THROWN}', '${LINK}', 'Thrown away', 'draft', false, '${ATHLETE}', null, '2026-10-01 10:00+00');
    insert into public.weeks (id, program_id, week_number) values
      ('${W_BLOCK}', '${BLOCK}', 1), ('${W_DRAFT}', '${DRAFT}', 1), ('${W_THROWN}', '${THROWN}', 1);
    insert into public.sessions (id, week_id, title, sort_order) values
      ('${S_BLOCK}', '${W_BLOCK}', 'S1', 0), ('${S_DRAFT}', '${W_DRAFT}', 'Pull', 0);
    insert into public.exercise_slots (id, session_id, exercise_id, sets, reps, weight_kg, rest_seconds, sort_order) values
      ('${SLOT_BLOCK}',   '${S_BLOCK}', '${PULL_UP}', 1, 5, 20, 120, 0),
      ('${SLOT_DRAFT}',   '${S_DRAFT}', '${PULL_UP}', 4, 5, 20, 120, 0),
      ('${SLOT_DRAFT_2}', '${S_DRAFT}', '${DIP}',     2, 8, 30, 90,  1);
    insert into public.set_logs (id, exercise_slot_id, set_number, target_reps, target_weight_kg) values
      ('${SET_BLOCK}', '${SLOT_BLOCK}', 1, 5, 20);
    insert into public.set_logs (exercise_slot_id, set_number, target_reps, target_weight_kg, target_rest_seconds) values
      ('${SLOT_DRAFT}', 1, null, null, null), ('${SLOT_DRAFT}', 2, null, null, null),
      ('${SLOT_DRAFT}', 3, null, null, null), ('${SLOT_DRAFT}', 4, null, null, null),
      ('${SLOT_DRAFT_2}', 1, 8, 30, 90), ('${SLOT_DRAFT_2}', 2, 8, 30, 90);
  `;

  /** The frozen baseline with that world in it and the migrations before 20 applied. */
  const production = async () => {
    const db = await scratchDatabase();
    await db.runFile(manifest.baseline);
    await db.runSql(WORLD, 'world');
    for (const earlier of migrationsBefore(manifest.migrations, MIGRATION)) await db.runFile(earlier.paths.migration);
    return db;
  };

  // One transaction, always undone (replay-grace.test.js): each step is a
  // statement or an actor; the answer is the first value of the last
  // statement, or the message of the statement that raised.
  const user = (sub) => ({ role: 'authenticated', claims: JSON.stringify({ role: 'authenticated', sub }) });
  const THE_COACH = user(COACH);
  const THE_ATHLETE = user(ATHLETE);
  const THE_OWNER = { role: 'postgres', claims: '' };
  const actor = ({ role, claims }) => `select set_config('role', '${role}', true), set_config('request.jwt.claims', '${claims}', true)`;
  const statements = (steps) => steps.map((step) => (typeof step === 'string' ? step : actor(step))).join(';\n');
  const story = async (db, ...steps) => {
    const tried = await attempt(() => db.runSql(`BEGIN;\n${statements(steps)};\nROLLBACK;`, 'request'));
    if (!tried.ok) return (tried.error.cause ?? tried.error).message;
    const [found] = tried.value.at(-2).rows;
    return found ? Object.values(found)[0] : null;
  };

  // The coach's editor, as the app that is deployed sends it; the approval.
  const noteOnTheDraft = `update public.exercise_slots set notes = 'Elbows in' where id = '${SLOT_DRAFT}' returning 'saved'`;
  const moreSets = `update public.exercise_slots set sets = 5 where id = '${SLOT_DRAFT}' returning 'saved'`;
  const approve = `select public.approve_program('${DRAFT}')`;
  const setsOfTheDraft = `select count(*) filter (where target_reps is null) || ' without a target, ' || count(*) || ' in all'
                            from public.set_logs where exercise_slot_id in ('${SLOT_DRAFT}', '${SLOT_DRAFT_2}')`;
  const authorsSave = `update public.exercise_slots set reps = 6 where id = '${SLOT_DRAFT}' returning 'saved'`;
  const noteOnTheBlock = `update public.exercise_slots set notes = 'Elbows in' where id = '${SLOT_BLOCK}' returning 'saved'`;
  const tick = `update public.set_logs set done = true, logged_at = now() where id = '${SET_BLOCK}' returning 'saved'`;

  const finding = async (db) => ({
    note: await story(db, THE_COACH, noteOnTheDraft),
    sets: await story(db, THE_COACH, moreSets),
    approved: await story(db, THE_COACH, approve, THE_OWNER, setsOfTheDraft),
    answer: await story(db, THE_COACH, approve),
  });
  const OPEN = { note: 'saved', sets: 'saved', approved: '4 without a target, 6 in all', answer: { approved: true, set_logs_created: 0 } };
  const CLOSED = { note: 'draft_read_only', sets: 'draft_read_only', approved: '0 without a target, 6 in all', answer: { approved: true, set_logs_created: 4 } };

  const rows = (db) => db.query.one(
    `select (select count(*) from public.programs) as programs, (select count(*) from public.weeks) as weeks,
            (select count(*) from public.sessions) as sessions, (select count(*) from public.exercise_slots) as slots,
            (select count(*) from public.set_logs) as sets,
            (select count(*) from public.set_logs where target_reps is null) as without_a_target,
            (select string_agg(status, ', ' order by name) from public.programs) as statuses`,
  );
  const AS_IT_WAS = { programs: 3, weeks: 3, sessions: 2, slots: 3, sets: 7, without_a_target: 4, statuses: 'approved, draft, draft' };

  // The runbook page, which is what the person applying the file reads.
  const page = read(migration.paths.runbook);
  const fences = (lang) => [...page.matchAll(new RegExp(`^( *)\`\`\`${lang}\\n([\\s\\S]*?)\\n\\1\`\`\`$`, 'gm'))]
    .map(([, indent, body]) => body.split('\n').map((line) => line.slice(indent.length)).join('\n'));
  const commands = fences('bash');
  const [pageCheck] = commands
    .map((command) => /^supabase db query --linked '(do \$check\$[\s\S]+\$check\$)'$/.exec(command)?.[1])
    .filter(Boolean);
  const quoted = (start) => commands
    .map((command) => /^supabase db query --linked "(.+)"$/.exec(command)?.[1])
    .find((sql) => sql?.startsWith(start));
  const listDrafts = quoted('select pr.full_name as athlete, p.name as draft');

  const printedAudit = async (db) => {
    const [result] = await db.readOnly(read(migration.paths.audit), 'audit');
    return Object.fromEntries(result.rows.map((line) => [line.check, line.value]));
  };
  const LINE = {
    who: 'who writes the phases, sessions, exercises and sets of a draft (P53)',
    triggers: 'the triggers that keep a draft its author\'s (block_draft_tree_write)',
    approval: 'what approve_program does with the sets of a draft (P53)',
    strangers: 'functions of these names that the migration does not know',
    asOwner: 'functions of this migration that run as their owner',
    drafts: 'drafts out of the trash',
    trash: 'drafts in the trash',
    nobody: 'drafts nobody wrote: a block made a draft again by its coach (no author)',
    sets: 'sets in drafts — written by a coach, before the migration',
    without: '… without a target: dropped and written again from their exercise when the draft is approved',
    others: '… the others — a target, or logged, added or filmed: kept when the draft is approved',
  };
  const BEFORE = { who: 'its author, and the coach of its athlete', approval: 'adds the missing sets, then marks the program approved' };
  const AFTER = {
    who: 'its author only',
    approval: 'marks the program approved, drops the sets without a target, adds the missing sets',
  };
  const untouched = async (db, before) => {
    expect(diffCatalogs(before, await catalogSnapshot(db.query), { left: 'before', right: 'after' })).toEqual([]);
    expect(await db.query.value(`select count(*) from ${LEDGER} where name = $1`, [MIGRATION])).toBe(0);
  };
  const refusalOf = async (db, run = () => db.runFile(migration.paths.migration)) => {
    const before = await catalogSnapshot(db.query);
    const refused = await attempt(run);
    await untouched(db, before);
    return refused.error?.message ?? 'it ran';
  };

  it('the coach writes in the draft and the approval keeps sets without a target before; refused and rebuilt after; back after the rollback — no row is written by either file', async () => {
    const db = await production();
    expect(await finding(db)).toEqual(OPEN);

    await db.runFile(migration.paths.migration);
    expect(await finding(db)).toEqual(CLOSED);
    // The author writes their draft; the coach renames it, and writes the block that is trained; the athlete trains it.
    expect(await story(db, THE_ATHLETE, authorsSave)).toBe('saved');
    expect(await story(db, THE_COACH, `update public.programs set name = 'Renamed' where id = '${DRAFT}' returning name`)).toBe('Renamed');
    expect(await story(db, THE_COACH, noteOnTheBlock)).toBe('saved');
    expect(await story(db, THE_ATHLETE, tick)).toBe('saved');
    // The coach deletes the draft in the trash with what is under it.
    expect(await story(db, THE_COACH, `delete from public.programs where id = '${THROWN}' returning 'deleted'`)).toBe('deleted');
    // Nothing above was kept, and the migration itself touches no row.
    expect(await rows(db)).toEqual(AS_IT_WAS);

    await db.runFile(migration.paths.rollback);
    expect(await finding(db)).toEqual(OPEN);
    expect(await rows(db)).toEqual(AS_IT_WAS);
    await db.drop();
  });

  it('adds 4 triggers and their functions, replaces 1 function and signs the ledger — no table, no column, no policy, no privilege of what was there', async () => {
    const db = await production();
    const before = await catalogSnapshot(db.query);
    await db.runFile(migration.paths.migration);
    const after = await catalogSnapshot(db.query);

    const lines = diffCatalogs(before, after, { left: 'before', right: 'after' });
    const only = (side) => lines.filter((line) => line.endsWith(`: only in ${side}`))
      .map((line) => line.slice(0, -`: only in ${side}`.length)).sort();
    const APPROVE = 'public.approve_program(p_program_id uuid)';
    const FUNCTIONS = ['block_draft_session_write', 'block_draft_set_log_write', 'block_draft_slot_write', 'block_draft_week_write'];
    expect(only('after')).toEqual([
      ...FUNCTIONS.map((name) => `functions public.${name}()`),
      ...['exercise_slots', 'sessions', 'set_logs', 'weeks'].map((table) => `triggers public.${table}.block_draft_tree_write`),
    ].sort());
    expect(only('before')).toEqual([]);
    expect(lines.filter((line) => !/: only in (before|after)$/.test(line)).map((line) => /^(.*?): (\w+): /.exec(line).slice(1, 3).join(' → ')))
      .toEqual([`functions ${APPROVE} → definition`, 'data rows of app_private.app_migrations → rows']);

    // The approval keeps its header and who may call it; the trigger functions are nobody's to call.
    const header = (key) => after.functions[key].definition.split(/\nAS /)[0];
    expect(header(APPROVE)).toBe(before.functions[APPROVE].definition.split(/\nAS /)[0]);
    expect(after.functions[APPROVE].privileges).toEqual(before.functions[APPROVE].privileges);
    expect(after.functions[APPROVE].privileges).toEqual(['authenticated: EXECUTE', 'postgres: EXECUTE', 'service_role: EXECUTE']);
    for (const name of FUNCTIONS) {
      const fn = after.functions[`public.${name}()`];
      expect(fn.privileges, name).toEqual(['postgres: EXECUTE', 'service_role: EXECUTE']);
      expect(fn.owner, name).toBe('postgres');
      expect(header(`public.${name}()`)).toContain('STABLE SECURITY DEFINER');
      expect(header(`public.${name}()`)).toContain(`\n SET search_path TO 'public', 'pg_temp'`);
    }
    for (const table of TABLES) {
      expect(after.triggers[`public.${table}.block_draft_tree_write`]).toMatchObject({ state: 'enabled' });
    }

    // The ledger, as the page says it reads: without the optional 19, which
    // production does not have.
    expect(await db.query.rows(`select name from ${LEDGER} order by name`)).toHaveLength(19);
    expect(await db.query.value(`select name from ${LEDGER} order by name desc limit 1`)).toBe(MIGRATION);
    expect(page).toContain(`Expected: nineteen rows, the last one \`${MIGRATION}\` — twenty where the optional migration 19 was applied at Checkpoint B.`);
    expect(page).toContain('| Kind | required · adds 4 triggers and their functions, replaces 1 function; no table, no column, no policy, no row |');
    await db.drop();
  });

  it('its audit prints the "before" and "after" columns of the runbook page', async () => {
    const db = await production();
    const audit = read(migration.paths.audit);
    const printed = async () => {
      const [result] = await db.readOnly(audit, 'audit');
      return result.rows.map((line) => [line.check, line.value]);
    };
    const table = page.split('\n')
      .map((line) => /^\| (\d+) \| (.+?) \| (.+?) \| (.+?) \|$/.exec(line))
      .filter(Boolean)
      .map(([, n, check, before, after]) => ({ n: Number(n), check, before, after }));
    expect(table.map((line) => line.n)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
    const exact = table.filter((line) => /^`.+`$/.test(line.before) && /^`.+`$/.test(line.after))
      .map((line) => ({ ...line, before: line.before.slice(1, -1), after: line.after.slice(1, -1) }));
    expect(table.filter((line) => !exact.some((e) => e.n === line.n)).map((line) => line.check))
      .toEqual([LINE.drafts, LINE.trash, LINE.nobody, LINE.sets, LINE.without, LINE.others]);
    const onPage = (column) => [
      ...exact.map((line) => [line.n, line.check, line[column]]),
      // "My draft", sent in; "Thrown away"; both written by Alex; the four
      // rows of a higher "Sets" and the dip's two.
      [10, LINE.drafts, '0 being written, 1 sent in'],
      [11, LINE.trash, '1'],
      [12, LINE.nobody, '0'],
      [13, LINE.sets, '6'],
      [14, LINE.without, '4'],
      [15, LINE.others, '2'],
    ].sort((x, y) => x[0] - y[0]).map(([, check, value]) => [check, value]);

    expect(await printed()).toEqual(onPage('before'));
    await db.runFile(migration.paths.migration);
    expect(await printed()).toEqual(onPage('after'));
    expect(Object.fromEntries(await printed())).toMatchObject({ [LINE.who]: AFTER.who, [LINE.approval]: AFTER.approval });
    // …and the header of the audit file says the same.
    const header = audit.split('\n').filter((line) => line.startsWith('--')).join('\n');
    for (const { check, before, after } of exact) {
      expect(header, check).toContain(check);
      expect(header).toContain(before);
      expect(header).toContain(after);
    }
    // The md5 the audit knows the approval of this migration by is the one of the file.
    expect(audit).toContain(await db.query.value(
      `select md5(regexp_replace(btrim(prosrc, E' \\t\\r\\n'), '[[:space:]]+', ' ', 'g')) from pg_proc where oid = 'public.approve_program(uuid)'::regprocedure`,
    ));
    // The draft in the trash, and a block of the coach made a draft by hand:
    // lines 10 to 12 follow.
    await db.query(`update public.programs set deleted_at = now() where id = '${DRAFT}'`);
    await db.query(`insert into public.programs (student_id, name, status, is_active) values ('${LINK}', 'Made a draft', 'draft', false)`);
    expect(await printedAudit(db)).toMatchObject({ [LINE.drafts]: '1 being written, 0 sent in', [LINE.trash]: '2', [LINE.nobody]: '1' });
    await db.runFile(migration.paths.rollback);
    await db.drop();
  });

  it('the page\'s check answers NOT THERE before and "in place" after, names what is wrong when something is — and writes nothing', async () => {
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
      `select (select count(*) from auth.users) as accounts, (select count(*) from public.profiles) as profiles,
              (select count(*) from public.students) as links, (select count(*) from public.programs) as blocks,
              (select count(*) from public.set_logs) as sets, (select count(*) from public.notifications) as notifications,
              current_user::text as role, coalesce(current_setting('request.jwt.claims', true), '') as claims`,
    );
    const UNTOUCHED = { accounts: 2, profiles: 2, links: 1, blocks: 3, sets: 7, notifications: 0, role: 'postgres', claims: '' };
    const answer = (said) => `check only, nothing was written: ${said}`;
    const IN_PLACE = answer('in place: the coach changes nothing in a draft of their athlete and is answered draft_read_only; '
      + 'the athlete writes it as before; the coach renames it and approves it, and every set of the approved block has the reps and load of its exercise');

    expect(await checked()).toBe(answer('NOT THERE: the coach of an athlete still writes in their draft'));
    expect(await state()).toEqual(UNTOUCHED);

    await db.runFile(migration.paths.migration);
    expect(await checked()).toBe(IN_PLACE);
    expect(await state()).toEqual(UNTOUCHED);
    expect(await rows(db)).toEqual(AS_IT_WAS);
    expect(page).toContain(`\`${IN_PLACE}\``);
    expect(page).toContain('`… NOT THERE: the coach of an athlete still writes in their draft`');

    // Each part made wrong by hand, one at a time.
    const withWrong = async (signature, change) => {
      const was = await db.query.value(`select pg_get_functiondef($1::regprocedure)`, [signature]);
      expect(change(was), signature).not.toBe(was);
      await db.query(change(was));
      const said = await checked();
      await db.query(was);
      expect(await checked(), `${signature} put back`).toBe(IN_PLACE);
      return said;
    };
    // The trigger on the sets switched off.
    await db.query(`alter table public.set_logs disable trigger block_draft_tree_write`);
    expect(await checked()).toBe(answer('NOT PROTECTED: the coach wrote in a draft of their athlete: a set added, a set removed'));
    expect((await printedAudit(db))[LINE.who]).toBe('PARTLY: the trigger is there and switched on for weeks, sessions, exercise_slots — not for set_logs');
    expect((await printedAudit(db))[LINE.triggers]).toBe('weeks, sessions, exercise_slots, set_logs (SWITCHED OFF)');
    await db.query(`alter table public.set_logs enable trigger block_draft_tree_write`);
    // A trigger on the exercises that never finds a draft.
    expect(await withWrong('public.block_draft_slot_write()', (was) => was.replace(`AND p.status = 'draft'`, `AND p.status = 'nothing'`)))
      .toBe(answer('NOT PROTECTED: the coach wrote in a draft of their athlete: more sets for the exercise, the exercise removed'));
    // One that refuses the author too.
    expect(await withWrong('public.block_draft_slot_write()', (was) => was.replace('AND p.created_by IS DISTINCT FROM v_caller', '')))
      .toBe(answer('BROKEN: the athlete could not change their own draft'));
    // The approval of migration 15: it writes the sets while the program is
    // still a draft — and the trigger on the sets refuses its own coach.
    const migration15 = read('supabase/migrations/2026_10_13_15_push_plumbing.sql');
    const approve15 = migration15.slice(
      migration15.indexOf('CREATE OR REPLACE FUNCTION public.approve_program(p_program_id uuid)'),
      migration15.indexOf('\n$$;\n', migration15.indexOf('CREATE OR REPLACE FUNCTION public.approve_program(p_program_id uuid)')) + 4,
    );
    expect(await withWrong('public.approve_program(uuid)', () => approve15))
      .toBe(answer('BROKEN: approve_program answered {"error": "draft_read_only"} and the draft is draft'));
    expect(page).toContain('- `… NOT PROTECTED: …` or `… BROKEN: …` — the migration does not do what this page says: **roll back**, and report the full message.');
    expect(await state()).toEqual(UNTOUCHED);
    await db.drop();
  });

  it('where nobody can be made a coach, the page\'s check says NOT TRIED', async () => {
    const db = await production();
    await db.runFile(migration.paths.migration);
    await db.query(`create or replace function public.profiles_pin_immutable_columns() returns trigger
      language plpgsql set search_path = public, pg_temp as $$ begin NEW.role := OLD.role; return NEW; end $$`);
    const tried = await attempt(() => db.runSql(pageCheck, 'page check'));
    expect((tried.error.cause ?? tried.error).message)
      .toBe('check only, nothing was written: NOT TRIED: the account made for the check could not be made a coach');
    expect(page).toContain('- `… NOT TRIED: the account made for the check could not be made a coach` — migration 07 is not in the database');
    expect(await db.query.value(`select count(*) from auth.users`)).toBe(2);
    await db.drop();
  });

  it('the drafts and their sets: listed by the page\'s statement, before and after, as the audit counts them', async () => {
    const db = await production();
    expect(listDrafts, 'the page no longer lists the drafts').toBeTruthy();
    const listed = () => db.query.rows(listDrafts);
    const AS_LISTED = [
      { athlete: 'Alex', draft: 'My draft', state: 'sent in', in_trash: false, written_by: 'Alex', sets: 6, without_a_target: 4, draft_id: DRAFT },
      { athlete: 'Alex', draft: 'Thrown away', state: 'being written', in_trash: true, written_by: 'Alex', sets: 0, without_a_target: 0, draft_id: THROWN },
    ];
    expect(await listed()).toEqual(AS_LISTED);
    await db.runFile(migration.paths.migration);
    expect(await listed()).toEqual(AS_LISTED);
    // Approved, "My draft" is no draft any more.
    await db.runSql(`BEGIN;\n${statements([THE_COACH, approve])};\nCOMMIT;`, 'approve');
    expect(await listed()).toEqual([AS_LISTED[1]]);
    expect(await printedAudit(db)).toMatchObject({ [LINE.sets]: '0', [LINE.without]: '0' });
    expect(await db.query.value(`select count(*) from public.set_logs where exercise_slot_id = '${SLOT_DRAFT}' and target_reps = 5`)).toBe(4);
    expect(page).toContain('- **`sets` is not 0** — an athlete writes no set in a draft');
    await db.drop();
  });

  it('without migration 18 it says so (SLM02), and its rollback says there is nothing to undo (SLM03)', async () => {
    const db = await scratchDatabase();
    await db.runFile(manifest.baseline);
    const refusals = async () => {
      const before = await catalogSnapshot(db.query);
      const refused = await attempt(() => db.runFile(migration.paths.migration));
      const undone = await attempt(() => db.runFile(migration.paths.rollback));
      expect(diffCatalogs(before, await catalogSnapshot(db.query), { left: 'before', right: 'after' })).toEqual([]);
      return [refused.error?.code, refused.error?.message, undone.error?.code];
    };
    const needs = 'needs 2026_10_13_18_retention, which is not applied';
    let [code, message, undone] = await refusals();
    expect([code, undone]).toEqual([REFUSAL.predecessorMissing, REFUSAL.notApplied]);
    expect(message).toContain(needs);
    for (const earlier of manifest.migrations.slice(0, 17)) await db.runFile(earlier.paths.migration);
    expect(await db.query.value(`select name from ${LEDGER} order by name desc limit 1`)).toBe('2026_10_13_17_replay_grace_window');
    [code, message, undone] = await refusals();
    expect([code, undone]).toEqual([REFUSAL.predecessorMissing, REFUSAL.notApplied]);
    expect(message).toContain(needs);
    expect(page).toContain(`| \`${needs}\` (code \`SLM02\`) |`);
    // Migration 19 is optional: 20 does not need it.
    await db.runFile(manifest.migrations[17].paths.migration);
    await db.runFile(migration.paths.migration);
    expect(await db.query.value(`select count(*) from ${LEDGER} where name = $1`, [MIGRATION])).toBe(1);
    await db.drop();
  });

  it('refuses to run as another role than postgres', async () => {
    const db = await production();
    const text = read(migration.paths.migration);
    const asServiceRole = text.replace(`SET LOCAL lock_timeout = '5s';`, `SET LOCAL lock_timeout = '5s';\nSET LOCAL ROLE service_role;`);
    expect(asServiceRole).not.toBe(text);
    expect(await refusalOf(db, () => db.runSql(asServiceRole, 'migration')))
      .toContain(`migration ${MIGRATION} must be run as postgres, not as service_role`);
    expect(page).toContain('| `must be run as postgres` |');
    await db.drop();
  });

  it('refuses to run next to a trigger or a function of its names, and changes nothing', async () => {
    const db = await production();
    await db.query(`create function public.block_draft_slot_write() returns trigger language plpgsql as 'begin return new; end'`);
    expect(await refusalOf(db)).toContain(`migration ${MIGRATION} would not create: the function block_draft_slot_write() is already there`);
    await db.query(`create trigger block_draft_tree_write before update on public.exercise_slots
                    for each row execute function public.block_draft_slot_write()`);
    expect(await refusalOf(db)).toContain(
      `migration ${MIGRATION} would not create: the function block_draft_slot_write(), the trigger block_draft_tree_write on exercise_slots is already there`,
    );
    expect(await printedAudit(db)).toMatchObject({
      [LINE.who]: 'PARTLY: the trigger is there and switched on for exercise_slots — not for weeks, sessions, set_logs',
      [LINE.triggers]: 'exercise_slots',
    });
    expect(page).toContain('- **2** starts with `PARTLY:` — **stop and report the line.**');
    expect(page).toContain('| `would not create: … is already there` |');
    await db.query(`drop trigger block_draft_tree_write on public.exercise_slots`);
    await db.query(`drop function public.block_draft_slot_write()`);

    // A function of one of the names with other arguments: it is there all the same.
    await db.query(`create function public.block_draft_week_write(uuid) returns boolean language sql as 'select true'`);
    expect(await refusalOf(db)).toContain(`migration ${MIGRATION} would not create: the function block_draft_week_write(uuid) is already there`);
    expect(await printedAudit(db)).toMatchObject({ [LINE.strangers]: 'block_draft_week_write(uuid)' });
    expect(page).toContain('- **5** is not `none` — **stop and report the line.**');
    await db.query(`drop function public.block_draft_week_write(uuid)`);

    // Whoever runs it, and with whatever search_path: the same database.
    const text = read(migration.paths.migration);
    const elsewhere = text.replace(`SET LOCAL lock_timeout = '5s';`, `SET LOCAL lock_timeout = '5s';\nSET LOCAL search_path = pg_catalog;`);
    expect(elsewhere).not.toBe(text);
    await db.runSql(elsewhere, 'migration');
    const other = await production();
    await other.runFile(migration.paths.migration);
    expect(diffCatalogs(await catalogSnapshot(other.query), await catalogSnapshot(db.query), { left: 'usual', right: 'pg_catalog' }))
      .toEqual([]);
    await other.drop();
    await db.drop();
  });

  // approve_program is replaced by name: it must be the one the file was written for.
  it('refuses to replace an approval that is not the one of migration 15 — and takes the same text laid out another way', async () => {
    const db = await production();
    const THE_APPROVAL = await db.query.value(`select pg_get_functiondef('public.approve_program(uuid)'::regprocedure)`);

    // Changed by hand.
    await db.query(THE_APPROVAL.replace(`'set_logs_created', v_created`, `'created', v_created`));
    expect(await refusalOf(db)).toMatch(new RegExp(
      `migration ${MIGRATION} would not replace approve_program: public\\.approve_program\\(uuid\\) is not the text of migration 15 \\(md5 of its text, spaces folded: [0-9a-f]{32}\\)`,
    ));
    expect((await printedAudit(db))[LINE.approval]).toMatch(/^SOMETHING ELSE: a text this migration does not know \(md5 [0-9a-f]{32}\)$/);
    expect(page).toContain('- **4** starts with `SOMETHING ELSE:` or `NOT THERE:` — **stop and report the line.**');
    expect(page).toContain('| `would not replace approve_program: …` |');

    // A second one, with other arguments.
    await db.query(THE_APPROVAL);
    await db.query(`create function public.approve_program(p_program_id uuid, p_note text) returns jsonb language sql as 'select null::jsonb'`);
    expect(await refusalOf(db)).toContain(
      `migration ${MIGRATION} would not replace approve_program: approve_program(uuid,text) stands next to public.approve_program(uuid)`,
    );
    expect(await printedAudit(db)).toMatchObject({ [LINE.strangers]: 'approve_program(uuid, text)' });
    await db.query(`drop function public.approve_program(uuid, text)`);

    // Not there at all.
    await db.query(`alter function public.approve_program(uuid) rename to approve_program_by_hand`);
    expect(await refusalOf(db)).toContain(`migration ${MIGRATION} would not replace approve_program: public.approve_program(uuid) is not there`);
    expect((await printedAudit(db))[LINE.approval]).toBe('NOT THERE: no function approve_program(uuid)');
    await db.query(`alter function public.approve_program_by_hand(uuid) rename to approve_program`);

    // A column the triggers are written with, under another name.
    await db.query(`alter table public.programs rename column created_by to author`);
    expect(await refusalOf(db)).toContain(`migration ${MIGRATION} does not find what its functions are written with: public.programs.created_by`);
    expect(page).toContain('| `does not find what its functions are written with: …` |');
    await db.query(`alter table public.programs rename column author to created_by`);

    // The same text, pasted with other line breaks and tabs: it is the approval.
    await db.query(THE_APPROVAL.replace(/\n {2}(SELECT|IF|UPDATE|INSERT)/g, '\r\n\t$1'));
    expect(await db.query.value(`select pg_get_functiondef('public.approve_program(uuid)'::regprocedure)`)).not.toBe(THE_APPROVAL);
    expect((await printedAudit(db))[LINE.approval]).toBe(BEFORE.approval);
    await db.runFile(migration.paths.migration);
    expect((await printedAudit(db))[LINE.approval]).toBe(AFTER.approval);
    await db.drop();
  });

  // The file reads its own result back: a copy of it that forgot a part undoes itself.
  it('a file that left a part out says so, and changes nothing', async () => {
    const db = await production();
    const text = read(migration.paths.migration);
    const wrong = async (changed) => {
      expect(changed).not.toBe(text);
      return refusalOf(db, () => db.runSql(changed, 'migration'));
    };
    expect(await wrong(text.replace('GRANT EXECUTE ON FUNCTION public.approve_program(uuid) TO authenticated;\n', ''))).toContain(
      `migration ${MIGRATION} did not get what it meant: public.approve_program(uuid) is not executable by a signed-in user: the coach could not approve a draft`,
    );
    expect(await wrong(text.replace('REVOKE ALL ON FUNCTION public.block_draft_slot_write() FROM PUBLIC, anon, authenticated;\n', '')
      .replace('ALTER DEFAULT', 'ALTER DEFAULT')
      .replace(/(CREATE FUNCTION public\.block_draft_slot_write\(\)\nRETURNS trigger\nLANGUAGE plpgsql\n)STABLE\n/, '$1'))).toContain(
      `migration ${MIGRATION} did not get what it meant: public.block_draft_slot_write() is not STABLE`,
    );
    expect(await wrong(text.replace('  BEFORE INSERT OR UPDATE OR DELETE ON public.set_logs\n', '  BEFORE INSERT OR UPDATE ON public.set_logs\n'))).toContain(
      `migration ${MIGRATION} did not get what it meant: the trigger block_draft_tree_write on public.set_logs is not the one meant: `
      + 'CREATE TRIGGER block_draft_tree_write BEFORE INSERT OR UPDATE ON set_logs',
    );
    // The status written last again, as in migration 15.
    const flip = `  UPDATE public.programs SET status = 'approved', approved_at = now(), submitted_at = NULL
   WHERE id = p_program_id AND status = 'draft';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('approved', false);
  END IF;
`;
    expect(text).toContain(flip);
    expect(await wrong(text.replace(flip, '').replace('  GET DIAGNOSTICS v_created = ROW_COUNT;\n', () => `  GET DIAGNOSTICS v_created = ROW_COUNT;\n${flip}`)))
      .toContain(`migration ${MIGRATION} did not get what it meant: public.approve_program(uuid) does not mark the program approved before it writes a set`);
    expect(page).toContain('| `did not get what it meant: …` |');
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
    expect(await story(db, THE_COACH, noteOnTheDraft)).toBe('draft_read_only');
    expect(page).toContain('It is refused (code `SLM04`) once a later migration is in the ledger.');
    await db.drop();
  });

  it('rolled back: the approval of migration 15, byte for byte — and a draft approved meanwhile keeps its sets', async () => {
    const db = await production();
    const before = await catalogSnapshot(db.query);
    await db.runFile(migration.paths.migration);
    await db.runSql(`BEGIN;\n${statements([THE_COACH, approve])};\nCOMMIT;`, 'approve');
    const kept = await rows(db);
    expect(kept).toMatchObject({ sets: 7, without_a_target: 0, statuses: 'approved, approved, draft' });

    await db.runFile(migration.paths.rollback);
    // The bell row of the approval is the one row the catalog counts.
    await db.query(`delete from public.notifications where kind = 'program_approved'`);
    expect(diffCatalogs(before, await catalogSnapshot(db.query), { left: 'before', right: 'rolled back' })).toEqual([]);
    expect(await rows(db)).toEqual(kept);
    expect(await printedAudit(db)).toMatchObject({ [LINE.who]: BEFORE.who, [LINE.approval]: BEFORE.approval, [LINE.triggers]: 'none' });
    expect(page).toContain('**It reopens P53**');
    expect(page).toContain('A draft approved while the migration was in place keeps the sets it was given.');
    await db.drop();
  });
});
