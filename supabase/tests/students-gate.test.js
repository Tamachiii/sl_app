// The coach ↔ athlete link cannot be forged — review findings P7 and L2,
// closed by migration 2026_10_11_05_students_role_gate.
//
// public.students says who coaches whom, and every "Coaches …" policy is
// written against it. Any signed-in account could write it as long as it put
// its own id in coach_id: an athlete registered their coach as "their
// athlete", a row could be pointed at another profile, an athlete could be
// deleted in one request. The exercise library had the same gap, and nothing
// checked whose library the exercise of a slot or of a swap came from. Since
// the migration:
//
//   students              no signed-in user inserts or deletes a row, none
//                         moves a link; the coach of a row, who is a coach,
//                         writes its other columns
//   a link, for anybody   a profile with the role coach, another one with the
//                         role student — the SQL editor and the service role
//                         included
//   exercise_library      added to and edited by a coach: is_coach()
//   a slot, a swap        an exercise of the library of the program's coach,
//                         asked when the row is created or the exercise
//                         changes, so what a change of coach left stays editable
//
// The first blocks run against schema.sql, as the callers the app has. The
// writes of the app that is DEPLOYED today are replayed as it sends them
// (src/hooks/useExerciseLibrary.js, useSession.js, lib/offlineMutations.js):
// the migration is applied while that app is live. The last block applies the
// migration file itself to the frozen production baseline, with the checks of
// its runbook page read off the page.

import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  asAdmin, asAnon, asService, asUser, attempt, createDraftProgram, createProgram, createUser, repoRoot,
  scenario, scratchDatabase, seed,
} from './harness.js';
import { catalogSnapshot, diffCatalogs } from './catalog.js';
import { LEDGER, loadManifest, REFUSAL } from '../migrations/manifest.js';

const MIGRATION = '2026_10_11_05_students_role_gate';
const manifest = loadManifest();
const migration = manifest.migrations.find((m) => m.name === MIGRATION);
const read = (file) => fs.readFileSync(path.join(repoRoot, file), 'utf8');

// seed(): coach Carla with athletes A and B, and her library (pull-up, dip,
// squat, muscle-up). Next to them: a second coach, Olga, with her athlete
// Casey and a library of one exercise, and Una, an account nobody coaches.
let ids;
let olga;
let casey;
let una;
let row;      // the exercise of Olga's library
let blockC;   // Casey's active block: 1 session, 1 slot of `row`, 3 sets

beforeAll(async () => {
  ids = await seed();
  olga = await createUser({ email: 'olga@sl.test', fullName: 'Coach Olga', role: 'coach' });
  casey = await createUser({ email: 'casey@sl.test', fullName: 'Casey Athlete', coach: olga });
  una = await createUser({ email: 'una@sl.test', fullName: 'Una Unlinked' });
  row = await asAdmin((q) => q.value(
    `insert into exercise_library (coach_id, name, type, difficulty) values ($1, 'Row', 'pull', 1) returning id`,
    [olga.id],
  ), { commit: true });
  blockC = await createProgram({ student: casey, name: 'Block C', exercises: [row], active: true });
});

// The sentences of the migration, and the one row-level security speaks.
const NOT_A_COACH = (id, role = 'student') => `students.coach_id ${id} is not a coach: its profile has the role ${role}`;
const NOT_AN_ATHLETE = (id, role = 'coach') => `students.profile_id ${id} is not an athlete: its profile has the role ${role}`;
const OWN_COACH = (id) => `students: profile ${id} cannot be its own coach`;
const LINK_FIXED = (id) => `the coach-athlete link ${id} cannot be changed from the app`;
const FOREIGN_EXERCISE = (id) => `exercise ${id} is not in the library of the coach of this program`;
const FOREIGN_SUBSTITUTE = (id) => `substitute exercise ${id} is not in the library of the coach of this program`;
const RLS = (table) => `new row violates row-level security policy for table "${table}"`;

// What the app that is DEPLOYED does with the error of a write
// (src/lib/mutationErrors.js, as production runs it), for the codes this
// migration raises. Restated here: that code is live, and a refusal must come
// out as a sentence that fits — never as "archive it instead" or "in use".
const toastOf = (error) => {
  const said = `${error.message || ''} ${error.detail || ''} ${error.hint || ''}`.toLowerCase();
  if (said.includes('logged set')) return 'errors.hasLoggedTraining';
  if (error.code === '23503' || said.includes('foreign key') || said.includes('still referenced')) return 'errors.inUse';
  if (error.code === '23514') {
    return /set_logs_|exercise_slots_unit_one_of|slot_deviations_swap_has_substitute|sessions_week_sort_order_unique|programs_one_active_per_student/.test(said)
      ? 'a named constraint' : 'errors.constraint.generic';
  }
  if (error.code === '42501' || said.includes('row-level security') || said.includes('permission denied')) return 'errors.notAllowed';
  return 'errors.generic';
};

const links = (q) => q.rows(`select id, profile_id, coach_id, notes from students order by created_at, id`);

// A row nobody should have been able to write, as the hole left it. The
// triggers are stepped around, the way a dump restore does.
const withoutTriggers = async (q, fn) => {
  await q(`select set_config('session_replication_role', 'replica', true)`);
  try {
    return await fn();
  } finally {
    await q(`select set_config('session_replication_role', 'origin', true)`);
  }
};

// ============================================================
// is_coach()
// ============================================================
describe('is_coach()', () => {
  const ask = (as) => as((q) => q.value(`select public.is_coach()`));

  it('answers for the caller: a coach, an athlete, an account nobody coaches', async () => {
    expect(await ask((fn) => asUser(ids.coach, fn))).toBe(true);
    expect(await ask((fn) => asUser(olga, fn))).toBe(true);
    expect(await ask((fn) => asUser(ids.studentA, fn))).toBe(false);
    expect(await ask((fn) => asUser(una, fn))).toBe(false);
  });

  it('is false for a token whose account has no profile, and for the service role', async () => {
    expect(await ask((fn) => asUser('00000000-0000-4000-8000-00000000dead', fn))).toBe(false);
    expect(await ask(asService)).toBe(false);
  });

  it('is not for a request without a session', async () => {
    const tried = await attempt(() => ask(asAnon));
    expect(tried.error?.message).toBe('permission denied for function is_coach');
  });

  // profiles.role is the answer, and a signed-in user cannot write it.
  it('cannot be turned true by the caller', () => scenario(async () => {
    await asUser(ids.studentA, async (athlete) => {
      await athlete(`update profiles set role = 'coach' where id = $1`, [ids.studentA.id]);
      expect(await athlete.value(`select public.is_coach()`)).toBe(false);
    });
  }));
});

// ============================================================
// students: who writes a row
// ============================================================
describe('no signed-in user creates or removes a link', () => {
  // The finding first: the coach has no row of their own, so nothing but the
  // policy stood between an athlete and "coach of my coach".
  it.each([
    ['their coach as their own athlete (the finding)', () => [ids.coach.id, ids.studentA.id], () => NOT_A_COACH(ids.studentA.id)],
    ['an account nobody coaches as their athlete', () => [una.id, ids.studentA.id], () => NOT_A_COACH(ids.studentA.id)],
    ['themselves as their own coach', () => [ids.studentA.id, ids.studentA.id], () => OWN_COACH(ids.studentA.id)],
    ['an account nobody coaches, in the name of their coach', () => [una.id, ids.coach.id], () => RLS('students')],
  ])('an athlete cannot register %s', (_, link, refusal) => scenario(async (q) => {
    const before = await links(q);
    const tried = await attempt(() => asUser(ids.studentA, (athlete) => athlete(
      `insert into students (profile_id, coach_id) values ($1, $2)`, link(),
    )));
    expect(tried.error?.message).toBe(refusal());
    expect(await links(q)).toEqual(before);
  }));

  it('an account nobody coaches cannot make itself the coach of anybody either', () => scenario(async (q) => {
    const before = await links(q);
    for (const profile of [ids.coach.id, olga.id, una.id]) {
      const tried = await attempt(() => asUser(una, (user) => user(
        `insert into students (profile_id, coach_id) values ($1, $2)`, [profile, una.id],
      )));
      expect(tried.ok, profile).toBe(false);
    }
    expect(await links(q)).toEqual(before);
  }));

  // A link that is right in every respect: it is still not made through the API.
  it('a coach does not create a link through the API, not even a right one', () => scenario(async (q) => {
    const before = await links(q);
    const plain = await attempt(() => asUser(ids.coach, (coach) => coach(
      `insert into students (profile_id, coach_id) values ($1, $2)`, [una.id, ids.coach.id],
    )));
    expect(plain.error?.message).toBe(RLS('students'));
    expect(plain.error.code).toBe('42501');
    // …nor as an upsert onto a row that is already theirs.
    const upsert = await attempt(() => asUser(ids.coach, (coach) => coach(
      `insert into students (profile_id, coach_id, notes) values ($1, $2, 'mine')
       on conflict (profile_id) do update set notes = excluded.notes`,
      [ids.studentA.id, ids.coach.id],
    )));
    expect(upsert.error?.message).toBe(RLS('students'));
    expect(await links(q)).toEqual(before);
  }));

  it('nobody deletes a link through the API: not the coach, not the athlete, not another coach', () => scenario(async (q) => {
    const before = await links(q);
    for (const who of [ids.coach, ids.studentA, ids.studentB, olga]) {
      const removed = await asUser(who, (user) => user(`delete from students`));
      expect(removed.rowCount).toBe(0);
    }
    expect(await links(q)).toEqual(before);
  }));

  it('reading is what it was: a coach their athletes, an athlete their own row', async () => {
    // A and B were linked in one transaction: nothing orders them but the id.
    const seen = async (user) => (await asUser(user, (q) => q.rows(`select profile_id from students`)))
      .map((link) => link.profile_id).sort();
    expect(await seen(ids.coach)).toEqual([ids.studentA.id, ids.studentB.id].sort());
    expect(await seen(olga)).toEqual([casey.id]);
    expect(await seen(ids.studentA)).toEqual([ids.studentA.id]);
    expect(await seen(una)).toEqual([]);
  });
});

describe('a signed-in user does not move a link', () => {
  const rowA = () => ids.studentA.studentRowId;

  it('the coach writes the notes of their athlete, and nobody else does', () => scenario(async (q) => {
    const written = await asUser(ids.coach, (coach) => coach.one(
      `update students set notes = 'Left shoulder' where id = $1 returning notes, coach_id`, [rowA()],
    ));
    expect(written).toEqual({ notes: 'Left shoulder', coach_id: ids.coach.id });
    for (const who of [ids.studentA, ids.studentB, olga, una]) {
      const tried = await asUser(who, (user) => user(`update students set notes = 'forged' where id = $1`, [rowA()]));
      expect(tried.rowCount).toBe(0);
    }
    expect(await q.value(`select notes from students where id = $1`, [rowA()])).toBe('Left shoulder');
  }));

  // What a client sends when it writes a row back whole.
  it('a row written back with the link it has goes through', () => scenario(async () => {
    const written = await asUser(ids.coach, (coach) => coach.one(
      `update students set id = id, profile_id = $2, coach_id = $3, notes = 'Whole row' where id = $1 returning notes`,
      [rowA(), ids.studentA.id, ids.coach.id],
    ));
    expect(written).toEqual({ notes: 'Whole row' });
  }));

  it.each([
    ['at another account', () => [`profile_id = $2`, una.id]],
    ['at themselves', () => [`profile_id = $2`, ids.coach.id]],
    ['to another coach', () => [`coach_id = $2`, olga.id]],
    ['to another id', () => [`id = $2`, '00000000-0000-4000-8000-00000000beef']],
  ])('the coach cannot point the row %s', (_, change) => scenario(async (q) => {
    const before = await links(q);
    const [set, value] = change();
    const tried = await attempt(() => asUser(ids.coach, (coach) => coach(
      `update students set ${set}, notes = 'moved' where id = $1`, [rowA(), value],
    )));
    expect(tried.error?.message).toBe(LINK_FIXED(rowA()));
    expect(tried.error.code).toBe('42501');
    expect(toastOf(tried.error)).toBe('errors.notAllowed');
    expect(await links(q)).toEqual(before);
  }));

  // The row is out of reach of everybody but its coach: an athlete does not
  // choose their coach, and a coach does not take an athlete.
  it('an athlete cannot re-point their own row, and a coach cannot take another coach\'s athlete', () => scenario(async (q) => {
    const before = await links(q);
    const tries = [
      [ids.studentA, `update students set coach_id = $2 where id = $1`, [rowA(), olga.id]],
      [ids.studentA, `update students set coach_id = $2 where id = $1`, [rowA(), ids.studentA.id]],
      [ids.studentA, `update students set profile_id = $2 where id = $1`, [rowA(), una.id]],
      [ids.studentB, `update students set profile_id = $2 where id = $1`, [rowA(), ids.studentB.id]],
      [olga, `update students set coach_id = $2 where id = $1`, [rowA(), olga.id]],
      [una, `update students set coach_id = $2 where id = $1`, [rowA(), una.id]],
      [ids.coach, `update students set coach_id = $2 where id = $1`, [casey.studentRowId, ids.coach.id]],
    ];
    for (const [who, sql, params] of tries) {
      const tried = await attempt(() => asUser(who, (user) => user(sql, params)));
      expect(tried.value?.rowCount ?? 0, `${who.email}: ${sql}`).toBe(0);
    }
    expect(await links(q)).toEqual(before);
  }));

  // The state the migration refuses to start from, and why: the policies of
  // every other table still read `coach_id = auth.uid()` off this one.
  it('a link forged before the gate still gives its "coach" the reach of one — which is why the migration refuses to run on one', () => scenario(async (q) => {
    await withoutTriggers(q, () => q(
      `insert into students (profile_id, coach_id) values ($1, $2)`, [una.id, ids.studentA.id],
    ));
    await asUser(ids.studentA, async (forger) => {
      expect(await forger.value(`select count(*) from students where coach_id = $1`, [ids.studentA.id])).toBe(1);
      expect(await forger.value(`select full_name from profiles where id = $1`, [una.id])).toBe('Una Unlinked');
      // The row itself is out of reach: not a coach.
      expect((await forger(`update students set notes = 'mine' where coach_id = $1`, [ids.studentA.id])).rowCount).toBe(0);
      expect((await forger(`delete from students where coach_id = $1`, [ids.studentA.id])).rowCount).toBe(0);
    });
  }));
});

// ============================================================
// students: what a row may say, whoever writes it
// ============================================================
describe('a link joins a coach and an athlete, for every writer', () => {
  const writers = [['postgres (the SQL editor)', asAdmin], ['the service role', asService]];

  it.each(writers)('%s links an athlete to a coach', (_, as) => scenario(async (q) => {
    await as((writer) => writer(`insert into students (profile_id, coach_id) values ($1, $2)`, [una.id, ids.coach.id]));
    expect(await q.value(`select coach_id from students where profile_id = $1`, [una.id])).toBe(ids.coach.id);
    // Both ends see it, through the policies that were already there.
    expect(await asUser(una, (athlete) => athlete.value(`select full_name from profiles where id = $1`, [ids.coach.id])))
      .toBe('Coach Carla');
    expect(await asUser(ids.coach, (coach) => coach.value(`select count(*) from students`))).toBe(3);
  }));

  it.each(writers)('%s is refused a coach who is not one, an athlete who is one, and a profile linked to itself', (_, as) => scenario(async (q) => {
    const before = await links(q);
    const tryLink = (profile, coach) => attempt(() => as((writer) => writer(
      `insert into students (profile_id, coach_id) values ($1, $2)`, [profile, coach],
    )));

    const notACoach = await tryLink(una.id, ids.studentA.id);
    expect(notACoach.error?.message).toBe(NOT_A_COACH(ids.studentA.id));
    expect(notACoach.error.code).toBe('23514');
    expect(notACoach.error.hint).toBe('Only a profile with the role coach can be given athletes.');

    const notAnAthlete = await tryLink(olga.id, ids.coach.id);
    expect(notAnAthlete.error?.message).toBe(NOT_AN_ATHLETE(olga.id));
    expect(notAnAthlete.error.code).toBe('23514');

    expect((await tryLink(ids.coach.id, ids.coach.id)).error?.message).toBe(OWN_COACH(ids.coach.id));
    expect((await tryLink(una.id, una.id)).error?.message).toBe(OWN_COACH(una.id));
    expect(await links(q)).toEqual(before);
  }));

  it('an id that is no profile is left to the foreign key, and a second coach for an athlete to the unique key', () => scenario(async (q) => {
    const nobody = '00000000-0000-4000-8000-00000000dead';
    const noCoach = await attempt(() => q(`insert into students (profile_id, coach_id) values ($1, $2)`, [una.id, nobody]));
    expect(noCoach.error?.code).toBe('23503');
    const noAthlete = await attempt(() => q(`insert into students (profile_id, coach_id) values ($1, $2)`, [nobody, ids.coach.id]));
    expect(noAthlete.error?.code).toBe('23503');
    const second = await attempt(() => q(`insert into students (profile_id, coach_id) values ($1, $2)`, [ids.studentA.id, olga.id]));
    expect(second.error?.code).toBe('23505');
    expect(second.error.message).toContain('students_profile_id_key');
  }));

  // Moving an athlete is done without a user id, and the new link is judged
  // like a new row.
  it.each(writers)('%s moves an athlete to another coach, and only to a coach', (_, as) => scenario(async (q) => {
    const rowA = ids.studentA.studentRowId;
    const toAnAthlete = await attempt(() => as((writer) => writer(
      `update students set coach_id = $2 where id = $1`, [rowA, ids.studentB.id],
    )));
    expect(toAnAthlete.error?.message).toBe(NOT_A_COACH(ids.studentB.id));
    const toThemselves = await attempt(() => as((writer) => writer(
      `update students set coach_id = profile_id where id = $1`, [rowA],
    )));
    expect(toThemselves.error?.message).toBe(OWN_COACH(ids.studentA.id));
    const toACoach = await attempt(() => as((writer) => writer(
      `update students set profile_id = $2 where id = $1`, [rowA, olga.id],
    )));
    expect(toACoach.error?.message).toBe(NOT_AN_ATHLETE(olga.id));

    await as((writer) => writer(`update students set coach_id = $2 where id = $1`, [rowA, olga.id]));
    expect(await q.value(`select coach_id from students where id = $1`, [rowA])).toBe(olga.id);
    // The policies follow the link: Olga reads the block, Carla no longer does.
    const blocks = (coach) => asUser(coach, (user) => user.value(`select count(*) from programs where id = $1`, [ids.programA.id]));
    expect({ olga: await blocks(olga), carla: await blocks(ids.coach) }).toEqual({ olga: 1, carla: 0 });
  }));

  // A row that is only edited is not judged again: what is next to the link
  // can always be written, and the link can always be put right.
  it('a row whose link the gate would refuse can still be edited, and repaired — not moved to another wrong one', () => scenario(async (q) => {
    const forged = await withoutTriggers(q, () => q.value(
      `insert into students (profile_id, coach_id) values ($1, $2) returning id`, [una.id, ids.studentA.id],
    ));
    await q(`update students set notes = 'written before the gate' where id = $1`, [forged]);
    await asService((service) => service(`update students set notes = notes || '.' where id = $1`, [forged]));
    expect(await q.value(`select notes from students where id = $1`, [forged])).toBe('written before the gate.');

    const stillWrong = await attempt(() => q(`update students set coach_id = $2 where id = $1`, [forged, ids.studentB.id]));
    expect(stillWrong.error?.message).toBe(NOT_A_COACH(ids.studentB.id));
    await q(`update students set coach_id = $2 where id = $1`, [forged, ids.coach.id]);
    expect(await q.value(`select coach_id from students where id = $1`, [forged])).toBe(ids.coach.id);
  }));

  it('with a user id the link does not move, whatever the role of the connection', () => scenario(async (q) => {
    // A function that runs with the owner's rights inside a user's request.
    await q(
      `create function public.move_link_probe(p_row uuid, p_coach uuid) returns void
         language sql security definer set search_path = public, pg_temp
         as $$ update public.students set coach_id = p_coach where id = p_row $$`,
    );
    await q(`grant execute on function public.move_link_probe(uuid, uuid) to authenticated`);
    const tried = await attempt(() => asUser(ids.coach, (coach) => coach(
      `select public.move_link_probe($1, $2)`, [ids.studentA.studentRowId, olga.id],
    )));
    expect(tried.error?.message).toBe(LINK_FIXED(ids.studentA.studentRowId));
    expect(await q.value(`select coach_id from students where id = $1`, [ids.studentA.studentRowId])).toBe(ids.coach.id);
  }));
});

// ============================================================
// The exercise library
// ============================================================
describe('the exercise library is written by a coach', () => {
  const library = (q, owner) => q.rows(
    `select name from exercise_library where coach_id = $1 order by name`, [owner],
  );

  // src/hooks/useExerciseLibrary.js: useCreateExercise, useUpdateExercise, useDeleteExercise.
  it('the deployed app, as a coach: an exercise is added, edited and deleted as before', () => scenario(async (q) => {
    await asUser(ids.coach, async (coach) => {
      const created = await coach.one(
        `insert into exercise_library (name, type, difficulty, volume_weight, load_mode, coach_id)
         values ('Front lever', 'pull', 3, 1, null, $1) returning id, coach_id`,
        [ids.coach.id],
      );
      expect(created.coach_id).toBe(ids.coach.id);
      expect(await coach.one(
        `update exercise_library set name = 'Front lever raise', difficulty = 2 where id = $1 returning name, difficulty`,
        [created.id],
      )).toEqual({ name: 'Front lever raise', difficulty: 2 });
      expect((await coach(`delete from exercise_library where id = $1`, [created.id])).rowCount).toBe(1);
    });
    expect(await library(q, ids.coach.id)).toEqual([
      { name: 'Dip' }, { name: 'Muscle-up' }, { name: 'Pull-up' }, { name: 'Squat' },
    ]);
  }));

  it.each([
    ['an athlete', () => ids.studentA],
    ['an account nobody coaches', () => una],
  ])('%s cannot start a library of their own', (_, who) => scenario(async (q) => {
    const tried = await attempt(() => asUser(who(), (user) => user(
      `insert into exercise_library (name, type, difficulty, coach_id) values ('Mine', 'pull', 1, $1)`, [who().id],
    )));
    expect(tried.error?.message).toBe(RLS('exercise_library'));
    expect(toastOf(tried.error)).toBe('errors.notAllowed');
    expect(await library(q, who().id)).toEqual([]);
  }));

  it('an athlete cannot add to, edit or empty the library of their coach', () => scenario(async (q) => {
    const before = await library(q, ids.coach.id);
    await asUser(ids.studentA, async (athlete) => {
      const added = await attempt(() => athlete(
        `insert into exercise_library (name, type, difficulty, coach_id) values ('Planted', 'pull', 1, $1)`, [ids.coach.id],
      ));
      expect(added.error?.message).toBe(RLS('exercise_library'));
      expect((await athlete(`update exercise_library set name = 'Renamed'`)).rowCount).toBe(0);
      expect((await athlete(`delete from exercise_library`)).rowCount).toBe(0);
    });
    expect(await library(q, ids.coach.id)).toEqual(before);
  }));

  it('a coach does not write another coach\'s library, nor a row into it', () => scenario(async (q) => {
    await asUser(olga, async (other) => {
      expect((await other(`update exercise_library set name = 'Renamed' where coach_id = $1`, [ids.coach.id])).rowCount).toBe(0);
      expect((await other(`delete from exercise_library where coach_id = $1`, [ids.coach.id])).rowCount).toBe(0);
      const planted = await attempt(() => other(
        `insert into exercise_library (name, type, difficulty, coach_id) values ('Planted', 'pull', 1, $1)`, [ids.coach.id],
      ));
      expect(planted.error?.message).toBe(RLS('exercise_library'));
      // Nor does a row of their own leave for another library.
      const given = await attempt(() => other(`update exercise_library set coach_id = $2 where id = $1`, [row, ids.coach.id]));
      expect(given.error?.message).toBe(RLS('exercise_library'));
    });
    expect((await library(q, ids.coach.id)).length).toBe(4);
    expect(await library(q, olga.id)).toEqual([{ name: 'Row' }]);
  }));

  // Rows written while the hole was open. The owner still reads them and may
  // throw them away; adding or editing one needs the role.
  it('a library an athlete filled before the gate: read and deleted by them, no longer added to or edited', () => scenario(async (q) => {
    const [first, second] = await q.rows(
      `insert into exercise_library (coach_id, name, type, difficulty)
       values ($1, 'Mine 1', 'pull', 1), ($1, 'Mine 2', 'push', 1) returning id`,
      [ids.studentA.id],
    );
    await asUser(ids.studentA, async (athlete) => {
      // Theirs, and their coach's four.
      expect(await athlete.value(`select count(*) from exercise_library`)).toBe(6);
      const edited = await attempt(() => athlete(`update exercise_library set name = 'Edited' where id = $1`, [first.id]));
      expect(edited.error?.message).toBe(RLS('exercise_library'));
      expect((await athlete(`delete from exercise_library where id = $1`, [second.id])).rowCount).toBe(1);
    });
    expect(await library(q, ids.studentA.id)).toEqual([{ name: 'Mine 1' }]);
  }));

  it('reading asks for no role: an athlete reads their coach\'s library, a request without a session reads nothing', async () => {
    expect(await asUser(ids.studentA, (athlete) => athlete.value(`select count(*) from exercise_library`))).toBe(4);
    expect(await asUser(casey, (athlete) => athlete.rows(`select name from exercise_library`))).toEqual([{ name: 'Row' }]);
    expect(await asUser(una, (user) => user.value(`select count(*) from exercise_library`))).toBe(0);
    // Since migration 14 for want of any privilege on the table; before it, no row.
    const anonymous = await attempt(() => asAnon((anon) => anon.value(`select count(*) from exercise_library`)));
    expect(anonymous.error?.message).toBe('permission denied for table exercise_library');
  });
});

// ============================================================
// The exercise of a slot
// ============================================================
describe('a slot takes an exercise of the library of its program\'s coach', () => {
  const session = () => ids.programA.sessions[2];   // nobody trained it
  const addSlot = `insert into exercise_slots (session_id, exercise_id, sets, reps, duration_seconds, weight_kg, sort_order, superset_group, rest_seconds)
                   values ($1, $2, 3, 5, null, 20, 9, null, 120) returning id`;
  const slots = (q) => q.value(`select count(*) from exercise_slots`);

  // src/hooks/useSession.js: useAddSlot, then useUpdateSlot with another exercise.
  it('the deployed app, as the coach: an exercise of their library is added to a session, and replaced by another', () => scenario(async (q) => {
    const before = await slots(q);
    await asUser(ids.coach, async (coach) => {
      const slot = await coach.value(addSlot, [session(), ids.exercises.squat]);
      expect(await coach.value(
        `update exercise_slots set exercise_id = $2 where id = $1 returning exercise_id`, [slot, ids.exercises.muscleUp],
      )).toBe(ids.exercises.muscleUp);
    });
    expect(await slots(q)).toBe(before + 1);
  }));

  it('the coach cannot add another coach\'s exercise to a session, nor replace one with it', () => scenario(async (q) => {
    const before = await slots(q);
    const added = await attempt(() => asUser(ids.coach, (coach) => coach(addSlot, [session(), row])));
    expect(added.error?.message).toBe(FOREIGN_EXERCISE(row));
    expect(added.error.code).toBe('23514');
    expect(added.error.hint).toBe('An exercise slot takes an exercise from the library of its athlete\'s coach.');
    expect(toastOf(added.error)).toBe('errors.constraint.generic');

    const replaced = await attempt(() => asUser(ids.coach, (coach) => coach(
      `update exercise_slots set exercise_id = $2 where id = $1`, [ids.programA.slots[0], row],
    )));
    expect(replaced.error?.message).toBe(FOREIGN_EXERCISE(row));
    expect(await slots(q)).toBe(before);
    expect(await q.value(`select exercise_id from exercise_slots where id = $1`, [ids.programA.slots[0]]))
      .toBe(ids.exercises.pullUp);
  }));

  it('an exercise from a "library" an athlete filled is refused like any other that is not the coach\'s', () => scenario(async (q) => {
    const planted = await q.value(
      `insert into exercise_library (coach_id, name, type, difficulty) values ($1, 'Pull-up', 'pull', 2) returning id`,
      [ids.studentA.id],
    );
    const added = await attempt(() => asUser(ids.coach, (coach) => coach(addSlot, [session(), planted])));
    expect(added.error?.message).toBe(FOREIGN_EXERCISE(planted));
  }));

  it.each([['postgres (the SQL editor)', asAdmin], ['the service role', asService]])(
    'the rule is the same for %s', (_, as) => scenario(async (q) => {
      const before = await slots(q);
      const foreign = await attempt(() => as((writer) => writer(addSlot, [session(), row])));
      expect(foreign.error?.message).toBe(FOREIGN_EXERCISE(row));
      expect(foreign.error.code).toBe('23514');
      expect(await slots(q)).toBe(before);
      // Each library into the block of its own coach's athlete.
      await as((writer) => writer(addSlot, [session(), ids.exercises.squat]));
      await as((writer) => writer(addSlot, [blockC.sessions[0], row]));
      expect(await slots(q)).toBe(before + 2);
    }),
  );

  it('a session or an exercise that does not exist is left to the foreign key', () => scenario(async (q) => {
    const nothing = '00000000-0000-4000-8000-00000000dead';
    expect((await attempt(() => q(addSlot, [nothing, ids.exercises.squat]))).error?.code).toBe('23503');
    expect((await attempt(() => q(addSlot, [session(), nothing]))).error?.code).toBe('23503');
  }));

  // src/hooks/useDuplicate.js, copySlotsInto: the slots of a session, inserted again.
  it('the deployed app duplicates a session: its slots are copied', () => scenario(async (q) => {
    const before = await slots(q);
    const copied = await asUser(ids.coach, async (coach) => {
      const copy = await coach.value(
        `insert into sessions (week_id, title, sort_order) values ($1, 'W1 · S1 (copy)', 9) returning id`,
        [ids.programA.weeks[0]],
      );
      return coach(
        `insert into exercise_slots (session_id, exercise_id, sets, reps, weight_kg, sort_order, notes,
                                     duration_seconds, superset_group, rest_seconds, record_video_set_numbers)
         select $2, exercise_id, sets, reps, weight_kg, sort_order, notes,
                duration_seconds, superset_group, rest_seconds, record_video_set_numbers
           from exercise_slots where session_id = $1 order by sort_order
         returning id`,
        [ids.programA.sessions[0], copy],
      );
    });
    expect(copied.rowCount).toBe(2);
    expect(await slots(q)).toBe(before + 2);
  }));

  // A draft is written by the athlete: save_draft_tree checks the exercises
  // itself and answers `exercise_unavailable`, which the app has a sentence for.
  it('an athlete\'s draft: saved with the coach\'s exercises as before, and refused another library\'s as before', () => scenario(async (q) => {
    const uuid = () => q.value(`select gen_random_uuid()`);
    const [program, week, sessionId, slot] = [await uuid(), await uuid(), await uuid(), await uuid()];
    const tree = (exercise) => ({
      program: { id: program, name: 'Written offline' },
      weeks: [{ id: week, week_number: 1 }],
      sessions: [{ id: sessionId, week_id: week, title: 'Pull', sort_order: 0 }],
      slots: [{ id: slot, session_id: sessionId, exercise_id: exercise, sets: 3, reps: 5, sort_order: 0 }],
    });
    const save = (exercise) => attempt(() => asUser(ids.studentB, (athlete) => athlete.value(
      `select public.save_draft_tree($1)`, [tree(exercise)],
    )));
    expect((await save(ids.exercises.pullUp)).value).toEqual({ program_id: program, weeks: 1, sessions: 1, slots: 1 });
    expect((await save(ids.exercises.dip)).value).toEqual({ program_id: program, weeks: 1, sessions: 1, slots: 1 });
    const foreign = await save(row);
    expect(foreign.error?.message).toBe('exercise_unavailable');
    expect(await q.value(`select exercise_id from exercise_slots where id = $1`, [slot])).toBe(ids.exercises.dip);

    // Written row by row instead of through the function: refused all the same.
    const direct = await attempt(() => asUser(ids.studentB, (athlete) => athlete(
      `insert into exercise_slots (session_id, exercise_id, sets, reps, sort_order) values ($1, $2, 3, 5, 1)`,
      [sessionId, row],
    )));
    expect(direct.ok).toBe(false);
    expect(await q.value(`select count(*) from exercise_slots where session_id = $1`, [sessionId])).toBe(1);
  }));

  it('approve_program and adopt_swap, which write slots and sets for the coach, still do', () => scenario(async (q) => {
    const draft = await createDraftProgram(ids.studentB, { submitted: true });
    const coach = (sql, params) => asUser(ids.coach, (user) => user.value(sql, params));
    expect(await coach(`select public.approve_program($1)`, [draft.id])).toEqual({ approved: true, set_logs_created: 6 });
    expect(await coach(`select public.adopt_swap($1, $2)`, [ids.programA.slots[0], ids.exercises.squat]))
      .toEqual({ applied: 3, dry_run: false });
    expect(await q.value(
      `select count(*) from exercise_slots es join sessions s on s.id = es.session_id join weeks w on w.id = s.week_id
        where w.program_id = $1 and es.exercise_id = $2`,
      [ids.programA.id, ids.exercises.squat],
    )).toBe(3);
    // Its own check comes first, with its own sentence.
    const foreign = await attempt(() => coach(`select public.adopt_swap($1, $2)`, [ids.programA.slots[0], row]));
    expect(foreign.error?.message).toBe('substitute not in coach library');
  }));

  // Casey moves from Olga to Carla. Their block still holds Olga's exercise.
  describe('after an athlete changed coach', () => {
    const move = (q) => q(`update students set coach_id = $2 where id = $1`, [casey.studentRowId, ids.coach.id]);
    const [slotC] = [() => blockC.slots[0]];

    it('the slots that hold the former coach\'s exercise are edited in every other column', () => scenario(async (q) => {
      await move(q);
      await asUser(ids.coach, async (coach) => {
        expect(await coach.one(
          `update exercise_slots set sets = 4, reps = 8, notes = 'Slow', rest_seconds = 90 where id = $1 returning sets, notes`,
          [slotC()],
        )).toEqual({ sets: 4, notes: 'Slow' });
        // Written back whole, with the exercise it has.
        expect(await coach.value(
          `update exercise_slots set exercise_id = $2, sort_order = 3 where id = $1 returning sort_order`, [slotC(), row],
        )).toBe(3);
      });
      expect(await q.value(`select exercise_id from exercise_slots where id = $1`, [slotC()])).toBe(row);
    }));

    it('it is replaced by an exercise of the new coach\'s library, and does not come back', () => scenario(async (q) => {
      await move(q);
      await asUser(ids.coach, async (coach) => {
        expect(await coach.value(
          `update exercise_slots set exercise_id = $2 where id = $1 returning exercise_id`, [slotC(), ids.exercises.pullUp],
        )).toBe(ids.exercises.pullUp);
        const back = await attempt(() => coach(`update exercise_slots set exercise_id = $2 where id = $1`, [slotC(), row]));
        expect(back.error?.message).toBe(FOREIGN_EXERCISE(row));
      });
      expect(await q.value(`select exercise_id from exercise_slots where id = $1`, [slotC()])).toBe(ids.exercises.pullUp);
    }));

    it('a new slot takes the new coach\'s exercises only — a copy of the old one is refused until it is replaced', () => scenario(async (q) => {
      await move(q);
      await asUser(ids.coach, async (coach) => {
        await coach(addSlot, [blockC.sessions[0], ids.exercises.squat]);
        const old = await attempt(() => coach(addSlot, [blockC.sessions[0], row]));
        expect(old.error?.message).toBe(FOREIGN_EXERCISE(row));
        const copy = await attempt(() => coach(
          `insert into exercise_slots (session_id, exercise_id, sets, reps, sort_order)
           select session_id, exercise_id, sets, reps, 8 from exercise_slots where id = $1`,
          [slotC()],
        ));
        expect(copy.error?.message).toBe(FOREIGN_EXERCISE(row));
      });
      expect(await q.value(`select count(*) from exercise_slots where session_id = $1`, [blockC.sessions[0]])).toBe(2);
    }));

    it('the former coach is out: the link decides, not the exercise', () => scenario(async (q) => {
      await move(q);
      const tried = await asUser(olga, (former) => former(`update exercise_slots set sets = 9 where id = $1`, [slotC()]));
      expect(tried.rowCount).toBe(0);
      expect(await q.value(`select sets from exercise_slots where id = $1`, [slotC()])).toBe(3);
    }));
  });
});

// ============================================================
// The substitute of a swap
// ============================================================
describe('a swap takes a substitute of the library of the program\'s coach', () => {
  // src/lib/offlineMutations.js, saveSlotDeviationFn: an upsert on the slot,
  // every column of the payload written on conflict.
  const SAVE = `insert into slot_deviations (exercise_slot_id, student_id, kind, substitute_exercise_id, note, updated_at)
                values ($1, $2, $3, $4, $5, now())
                on conflict (exercise_slot_id) do update
                  set exercise_slot_id = excluded.exercise_slot_id, student_id = excluded.student_id, kind = excluded.kind,
                      substitute_exercise_id = excluded.substitute_exercise_id, note = excluded.note,
                      updated_at = excluded.updated_at
                returning kind, substitute_exercise_id, note`;
  const save = (athlete, slot, kind, substitute, note = null) => asUser(athlete, (user) => user.one(
    SAVE, [slot, athlete.id, kind, kind === 'swap' ? substitute : null, note],
  ));
  const slotA = () => ids.programA.slots[0];
  const deviation = (q, slot) => q.one(
    `select kind, substitute_exercise_id, note from slot_deviations where exercise_slot_id = $1`, [slot],
  );

  it('the deployed app, as an athlete: a swap is saved, changed, turned into a skip and cleared', () => scenario(async (q) => {
    const A = ids.studentA;
    expect(await save(A, slotA(), 'swap', ids.exercises.squat))
      .toEqual({ kind: 'swap', substitute_exercise_id: ids.exercises.squat, note: null });
    expect(await save(A, slotA(), 'swap', ids.exercises.muscleUp, 'No bar today'))
      .toEqual({ kind: 'swap', substitute_exercise_id: ids.exercises.muscleUp, note: 'No bar today' });
    expect(await save(A, slotA(), 'skip', null, 'Elbow'))
      .toEqual({ kind: 'skip', substitute_exercise_id: null, note: 'Elbow' });
    expect(await save(A, slotA(), 'swap', ids.exercises.dip)).toMatchObject({ kind: 'swap' });
    expect((await asUser(A, (athlete) => athlete(`delete from slot_deviations where exercise_slot_id = $1`, [slotA()]))).rowCount).toBe(1);
    expect(await deviation(q, slotA())).toBeNull();
  }));

  it('an athlete cannot swap to an exercise of another coach\'s library — as a first save or over an existing one', () => scenario(async (q) => {
    const A = ids.studentA;
    const first = await attempt(() => save(A, slotA(), 'swap', row));
    expect(first.error?.message).toBe(FOREIGN_SUBSTITUTE(row));
    expect(first.error.code).toBe('23514');
    expect(first.error.hint).toBe('A swap takes an exercise from the library of the athlete\'s coach.');
    expect(toastOf(first.error)).toBe('errors.constraint.generic');
    expect(await deviation(q, slotA())).toBeNull();

    for (const [kind, substitute] of [['skip', null], ['swap', ids.exercises.squat]]) {
      await save(A, slotA(), kind, substitute, 'kept');
      const over = await attempt(() => save(A, slotA(), 'swap', row, 'forged'));
      expect(over.error?.message, kind).toBe(FOREIGN_SUBSTITUTE(row));
      const direct = await attempt(() => asUser(A, (athlete) => athlete(
        `update slot_deviations set kind = 'swap', substitute_exercise_id = $2 where exercise_slot_id = $1`, [slotA(), row],
      )));
      expect(direct.error?.message, kind).toBe(FOREIGN_SUBSTITUTE(row));
      expect(await deviation(q, slotA())).toEqual({ kind, substitute_exercise_id: substitute, note: 'kept' });
    }
  }));

  // The finding: "slot_deviations can reference a student-created exercise".
  it('nor to an exercise of a "library" they filled themselves', () => scenario(async (q) => {
    const planted = await q.value(
      `insert into exercise_library (coach_id, name, type, difficulty) values ($1, 'Ghost', 'pull', 1) returning id`,
      [ids.studentA.id],
    );
    const tried = await attempt(() => save(ids.studentA, slotA(), 'swap', planted));
    expect(tried.error?.message).toBe(FOREIGN_SUBSTITUTE(planted));
    expect(await deviation(q, slotA())).toBeNull();
  }));

  it('the rule is the same without a user id', () => scenario(async (q) => {
    for (const as of [asAdmin, asService]) {
      const tried = await attempt(() => as((writer) => writer(
        `insert into slot_deviations (exercise_slot_id, student_id, kind, substitute_exercise_id) values ($1, $2, 'swap', $3)`,
        [slotA(), ids.studentA.id, row],
      )));
      expect(tried.error?.message).toBe(FOREIGN_SUBSTITUTE(row));
    }
    await asService((service) => service(
      `insert into slot_deviations (exercise_slot_id, student_id, kind, substitute_exercise_id) values ($1, $2, 'swap', $3)`,
      [slotA(), ids.studentA.id, ids.exercises.squat],
    ));
    expect(await deviation(q, slotA())).toMatchObject({ substitute_exercise_id: ids.exercises.squat });
  }));

  // Casey swapped under Olga, to an exercise of Olga's library; then moved to
  // Carla. The app only knows the upsert: without the exception for "the same
  // substitute as the row already has", a note could no longer be added.
  describe('a swap made before the athlete changed coach', () => {
    let second;   // a second exercise of Olga's library
    const slotC = () => blockC.slots[0];
    const arrange = async (q) => {
      second = await q.value(
        `insert into exercise_library (coach_id, name, type, difficulty) values ($1, 'Curl', 'pull', 1) returning id`, [olga.id],
      );
      await save(casey, slotC(), 'swap', second, 'Under Olga');
      await q(`update students set coach_id = $2 where id = $1`, [casey.studentRowId, ids.coach.id]);
    };

    it('is saved again as it is, with a new note', () => scenario(async (q) => {
      await arrange(q);
      expect(await save(casey, slotC(), 'swap', second, 'Still the curl'))
        .toEqual({ kind: 'swap', substitute_exercise_id: second, note: 'Still the curl' });
      await asUser(casey, (athlete) => athlete(
        `update slot_deviations set promote_requested_at = now() where exercise_slot_id = $1`, [slotC()],
      ));
      expect(await q.value(`select promote_requested_at is not null from slot_deviations where exercise_slot_id = $1`, [slotC()]))
        .toBe(true);
    }));

    it('takes a substitute of the new coach\'s library, and then does not go back', () => scenario(async (q) => {
      await arrange(q);
      // Another exercise of the former coach: not the one the row has.
      const other = await attempt(() => save(casey, slotC(), 'swap', row));
      expect(other.error?.message).toBe(FOREIGN_SUBSTITUTE(row));
      expect(await save(casey, slotC(), 'swap', ids.exercises.squat)).toMatchObject({ substitute_exercise_id: ids.exercises.squat });
      const back = await attempt(() => save(casey, slotC(), 'swap', second));
      expect(back.error?.message).toBe(FOREIGN_SUBSTITUTE(second));
      expect(await deviation(q, slotC())).toMatchObject({ substitute_exercise_id: ids.exercises.squat });
    }));

    it('cleared, it is a new swap: the former coach\'s exercise is not taken again', () => scenario(async (q) => {
      await arrange(q);
      await asUser(casey, (athlete) => athlete(`delete from slot_deviations where exercise_slot_id = $1`, [slotC()]));
      const again = await attempt(() => save(casey, slotC(), 'swap', second));
      expect(again.error?.message).toBe(FOREIGN_SUBSTITUTE(second));
    }));
  });
});

// ============================================================
// The migration file, on production as it was frozen
// ============================================================
describe('migration 05 applied to the production baseline', () => {
  const COACH = '00000000-0000-4000-8000-00000000c0ac';
  const OLGA = '00000000-0000-4000-8000-00000000c0b0';
  const ATHLETE = '00000000-0000-4000-8000-0000000000a1';
  const FREE = '00000000-0000-4000-8000-0000000000a2';
  const LINK = '00000000-0000-4000-8000-000000000101';
  const PULL_UP = '00000000-0000-4000-8000-000000000201';
  const DIP = '00000000-0000-4000-8000-000000000202';
  const ROW = '00000000-0000-4000-8000-000000000203';
  const PROGRAM = '00000000-0000-4000-8000-000000000301';
  const SESSION = '00000000-0000-4000-8000-000000000451';
  const SLOT = '00000000-0000-4000-8000-000000000501';
  const TO_COME = '2099_01_01_99_a_migration_to_come';

  // Two coaches, an athlete of the first with a block of one session, and an
  // account nobody coaches. The roles are set the way a dump restore sets
  // them: on the baseline the documented `update profiles set role = 'coach'`
  // is undone by profiles_pin_immutable_columns for every caller (finding
  // P20, closed by migration 07).
  const WORLD = `
    insert into auth.users (id, email, aud, role, email_confirmed_at, raw_user_meta_data) values
      ('${COACH}',   'coach@sl.test', 'authenticated', 'authenticated', now(), '{"full_name": "Coach Carla"}'),
      ('${OLGA}',    'olga@sl.test',  'authenticated', 'authenticated', now(), '{"full_name": "Coach Olga"}'),
      ('${ATHLETE}', 'alex@sl.test',  'authenticated', 'authenticated', now(), '{"full_name": "Alex"}'),
      ('${FREE}',    'una@sl.test',   'authenticated', 'authenticated', now(), '{"full_name": "Una"}');
    BEGIN;
    SET LOCAL session_replication_role = replica;
    update public.profiles set role = 'coach' where id in ('${COACH}', '${OLGA}');
    COMMIT;
    insert into public.students (id, profile_id, coach_id, created_at)
      values ('${LINK}', '${ATHLETE}', '${COACH}', '2026-01-05 10:00+00');
    insert into public.exercise_library (id, coach_id, name, type, difficulty) values
      ('${PULL_UP}', '${COACH}', 'Pull-up', 'pull', 2),
      ('${DIP}',     '${COACH}', 'Dip',     'push', 2),
      ('${ROW}',     '${OLGA}',  'Row',     'pull', 1);
    insert into public.programs (id, student_id, name, is_active)
      values ('${PROGRAM}', '${LINK}', 'Block', true);
    insert into public.weeks (id, program_id, week_number)
      values ('00000000-0000-4000-8000-000000000401', '${PROGRAM}', 1);
    insert into public.sessions (id, week_id, title, sort_order)
      values ('${SESSION}', '00000000-0000-4000-8000-000000000401', 'S1', 0);
    insert into public.exercise_slots (id, session_id, exercise_id, sets, reps, sort_order)
      values ('${SLOT}', '${SESSION}', '${PULL_UP}', 3, 5, 0);
  `;

  /** The frozen baseline with that world in it and the migrations before 05 applied. */
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
    const [found] = tried.value[2].rows;
    return found ? Object.values(found)[0] : null;
  };

  // The finding, and what hung on the same gap.
  const forge = `insert into public.students (profile_id, coach_id) values ('${COACH}', '${ATHLETE}') returning profile_id`;
  const repoint = `update public.students set profile_id = '${FREE}' where id = '${LINK}' returning profile_id`;
  const unlink = `delete from public.students where id = '${LINK}' returning id`;
  const ownLibrary = `insert into public.exercise_library (coach_id, name, type, difficulty) values ('${ATHLETE}', 'Mine', 'pull', 1) returning name`;
  const foreignSlot = `insert into public.exercise_slots (session_id, exercise_id, sets, reps, sort_order) values ('${SESSION}', '${ROW}', 3, 5, 1) returning sets`;
  const swapTo = (exercise) => `insert into public.slot_deviations (exercise_slot_id, student_id, kind, substitute_exercise_id) values ('${SLOT}', '${ATHLETE}', 'swap', '${exercise}') returning kind`;

  // The runbook page, which is what the person applying the file reads.
  const page = read(migration.paths.runbook);
  // Its fenced blocks, without the indent of the list item they stand in.
  const fences = (lang) => [...page.matchAll(new RegExp(`^( *)\`\`\`${lang}\\n([\\s\\S]*?)\\n\\1\`\`\`$`, 'gm'))]
    .map(([, indent, body]) => body.split('\n').map((line) => line.slice(indent.length)).join('\n'));
  const commands = fences('bash');
  const [pageCheck] = commands
    .map((command) => /^supabase db query --linked '(do \$check\$[\s\S]+\$check\$)'$/.exec(command)?.[1])
    .filter(Boolean);
  const quoted = (start) => commands
    .map((command) => /^supabase db query --linked "(.+)"$/.exec(command)?.[1])
    .find((sql) => sql?.startsWith(start));
  const listRefused = quoted('select s.id as link');
  const removeLink = quoted('delete from public.students');
  const [linkAthlete] = fences('sql');

  const printedAudit = async (db) => {
    const [result] = await db.readOnly(read(migration.paths.audit), 'audit');
    return Object.fromEntries(result.rows.map((line) => [line.check, line.value]));
  };

  it('the hole is there before, closed after, and back after the rollback', async () => {
    const db = await production();

    // Before: the finding, as the two reviews traced it through the policies.
    expect(await request(db, THE_ATHLETE, forge)).toBe(COACH);
    expect(await request(db, THE_COACH, repoint)).toBe(FREE);
    expect(await request(db, THE_COACH, unlink)).toBe(LINK);
    expect(await request(db, THE_ATHLETE, ownLibrary)).toBe('Mine');
    expect(await request(db, THE_COACH, foreignSlot)).toBe(3);
    expect(await request(db, THE_ATHLETE, swapTo(ROW))).toBe('swap');

    await db.runFile(migration.paths.migration);

    expect(await request(db, THE_ATHLETE, forge)).toBe(NOT_A_COACH(ATHLETE));
    expect(await request(db, THE_COACH, repoint)).toBe(LINK_FIXED(LINK));
    expect(await request(db, THE_COACH, unlink)).toBeNull();
    expect(await request(db, THE_ATHLETE, ownLibrary)).toBe(RLS('exercise_library'));
    expect(await request(db, THE_COACH, foreignSlot)).toBe(FOREIGN_EXERCISE(ROW));
    expect(await request(db, THE_ATHLETE, swapTo(ROW))).toBe(FOREIGN_SUBSTITUTE(ROW));
    // A right link, by the coach, through the API: not that way either.
    expect(await request(db, THE_COACH, `insert into public.students (profile_id, coach_id) values ('${FREE}', '${COACH}') returning id`))
      .toBe(RLS('students'));

    // The app that is deployed today, as the coach and as the athlete: as before.
    expect(await request(db, THE_COACH, `insert into public.exercise_library (coach_id, name, type, difficulty) values ('${COACH}', 'Squat', 'push', 1) returning name`))
      .toBe('Squat');
    expect(await request(db, THE_COACH, `update public.exercise_library set name = 'Chin-up' where id = '${PULL_UP}' returning name`)).toBe('Chin-up');
    expect(await request(db, THE_COACH, `delete from public.exercise_library where id = '${DIP}' returning name`)).toBe('Dip');
    expect(await request(db, THE_COACH, foreignSlot.replace(ROW, DIP))).toBe(3);
    expect(await request(db, THE_COACH, `update public.exercise_slots set exercise_id = '${DIP}' where id = '${SLOT}' returning sets`)).toBe(3);
    expect(await request(db, THE_COACH, `update public.students set notes = 'Left shoulder' where id = '${LINK}' returning notes`)).toBe('Left shoulder');
    expect(await request(db, THE_ATHLETE, swapTo(DIP))).toBe('swap');
    expect(await request(db, THE_ATHLETE, `select count(*) from public.exercise_library`)).toBe(2);
    // Nothing above was kept, and the migration itself touches no row.
    expect(await db.query.one(
      `select (select count(*) from public.students) as links, (select count(*) from public.exercise_library) as exercises,
              (select count(*) from public.exercise_slots) as slots, (select count(*) from public.slot_deviations) as swaps`,
    )).toEqual({ links: 1, exercises: 3, slots: 1, swaps: 0 });

    await db.runFile(migration.paths.rollback);
    expect(await request(db, THE_ATHLETE, forge)).toBe(COACH);
    expect(await request(db, THE_COACH, unlink)).toBe(LINK);
    expect(await request(db, THE_COACH, foreignSlot)).toBe(3);
    await db.drop();
  });

  it('drops 2 policies, rewrites 2, adds 4 functions and 3 triggers, signs the ledger — no table, no column, no privilege of what was there', async () => {
    const db = await production();
    const before = await catalogSnapshot(db.query);
    await db.runFile(migration.paths.migration);
    const after = await catalogSnapshot(db.query);

    const lines = diffCatalogs(before, after, { left: 'before', right: 'after' });
    const only = (side) => lines.filter((line) => line.endsWith(`: only in ${side}`))
      .map((line) => line.slice(0, -`: only in ${side}`.length));
    expect(only('after')).toEqual([
      'triggers public.exercise_slots.trg_check_slot_exercise_in_coach_library',
      'triggers public.slot_deviations.trg_check_deviation_substitute_in_coach_library',
      'triggers public.students.trg_check_students_link',
      'functions public.check_deviation_substitute_in_coach_library()',
      'functions public.check_slot_exercise_in_coach_library()',
      'functions public.check_students_link()',
      'functions public.is_coach()',
    ]);
    expect(only('before')).toEqual([
      'policies public.students.Coaches delete their students',
      'policies public.students.Coaches insert students',
    ]);
    const changed = lines.filter((line) => !/: only in (before|after)$/.test(line))
      .map((line) => /^(.*?): (\w+): /.exec(line).slice(1, 3).join(' → '));
    expect(changed).toEqual([
      'policies public.exercise_library.Coaches manage own library → with_check',
      'policies public.students.Coaches update their students → using',
      'policies public.students.Coaches update their students → with_check',
      'data rows of app_private.app_migrations → rows',
    ]);

    // What the two policies ask now (the catalog prints an expression the way
    // pg_get_expr(…, true) does: without the outer parentheses).
    const ownsTheRow = 'coach_id = auth.uid()';
    const asksForACoach = `${ownsTheRow} AND ( SELECT is_coach() AS is_coach)`;
    expect(before.policies['public.students.Coaches update their students'])
      .toMatchObject({ command: 'UPDATE', using: ownsTheRow, with_check: null });
    expect(after.policies['public.students.Coaches update their students'])
      .toMatchObject({ command: 'UPDATE', using: asksForACoach, with_check: asksForACoach });
    expect(before.policies['public.exercise_library.Coaches manage own library'])
      .toMatchObject({ command: 'ALL', using: ownsTheRow, with_check: null });
    expect(after.policies['public.exercise_library.Coaches manage own library'])
      .toMatchObject({ command: 'ALL', using: ownsTheRow, with_check: asksForACoach });
    // The policies the athletes read through are the ones from before.
    for (const key of ['public.students.Students see own row', 'public.students.Coaches see their students',
      'public.exercise_library.Students read their coachs library']) {
      expect(after.policies[key], key).toEqual(before.policies[key]);
    }

    // The new functions: is_coach() for a signed-in user, the three trigger
    // functions for nobody but their owner and the service role.
    for (const key of only('after').filter((line) => line.startsWith('functions ')).map((line) => line.slice('functions '.length))) {
      expect(after.functions[key].privileges, key).toEqual(key === 'public.is_coach()'
        ? ['authenticated: EXECUTE', 'postgres: EXECUTE', 'service_role: EXECUTE']
        : ['postgres: EXECUTE', 'service_role: EXECUTE']);
      expect(after.functions[key].owner, key).toBe('postgres');
      expect(after.functions[key].definition, key).toContain(`\n SET search_path TO 'public', 'pg_temp'\n`);
      expect(after.functions[key].definition, key).toContain('SECURITY DEFINER');
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
    // Written between back-ticks: a value the page gives exactly. The other
    // one is a sentence about production's accounts.
    const exact = rows.filter((line) => /^`.+`$/.test(line.before) && /^`.+`$/.test(line.after))
      .map((line) => ({ ...line, before: line.before.slice(1, -1), after: line.after.slice(1, -1) }));
    expect(rows.filter((line) => !exact.some((e) => e.n === line.n)).map((line) => line.check)).toEqual(['accounts']);
    const onPage = (column) => [
      ...exact.map((line) => [line.n, line.check, line[column]]),
      [15, 'accounts', '2 coach(es), 1 athlete(s) with a coach, 1 athlete(s) without one'],
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

  // What the hole may have left behind, written the way it was open: without
  // any check. Then the page, followed to the letter.
  it('refuses to run on a link the gate would refuse (SLM05); the page lists it, removes it, and the file then applies', async () => {
    const db = await production();
    const FORGED = '00000000-0000-4000-8000-000000000102';
    const SELF = '00000000-0000-4000-8000-000000000103';
    await db.runSql(`
      -- The finding, done: Alex, an athlete, holds Una as "their athlete".
      insert into public.students (id, profile_id, coach_id, created_at) values ('${FORGED}', '${FREE}', '${ATHLETE}', '2026-09-01 10:00+00');
      -- A coach linked to herself, by a slip in the SQL editor.
      insert into public.students (id, profile_id, coach_id, created_at) values ('${SELF}', '${OLGA}', '${OLGA}', '2026-09-02 10:00+00');
      -- A program written under the forged link, a library of Alex's own, and
      -- another coach's exercise in a session and in a swap.
      insert into public.programs (student_id, name) values ('${FORGED}', 'Ghost block');
      insert into public.exercise_library (coach_id, name, type, difficulty) values ('${ATHLETE}', 'Mine', 'pull', 1);
      insert into public.exercise_slots (id, session_id, exercise_id, sets, reps, sort_order)
        values ('00000000-0000-4000-8000-000000000502', '${SESSION}', '${ROW}', 3, 5, 1);
      insert into public.slot_deviations (exercise_slot_id, student_id, kind, substitute_exercise_id)
        values ('${SLOT}', '${ATHLETE}', 'swap', '${ROW}');
    `, 'what the hole left');

    const LEFT = {
      'coach-athlete links the gate refuses': '2 (1 whose coach is not a coach, 1 whose athlete is not a student, 1 linked to itself)',
      'library exercises that belong to an account that is not a coach': '1 of 1 account(s)',
      'exercise slots that hold an exercise of another coach\'s library': '1 in 1 program(s)',
      'swaps whose substitute is from another coach\'s library': '1',
      accounts: '2 coach(es), 2 athlete(s) with a coach, 0 athlete(s) without one',
    };
    expect(await printedAudit(db)).toMatchObject(LEFT);

    const before = await catalogSnapshot(db.query);
    const refused = await attempt(() => db.runFile(migration.paths.migration));
    expect(refused.error?.code).toBe(REFUSAL.rowsInTheWay);
    expect(refused.error.message).toContain(
      `migration ${MIGRATION}: 2 row(s) of public.students link profiles the gate refuses: `
      + `${FORGED} (coach_id has the role student); ${SELF} (its own coach, profile_id has the role coach)`,
    );
    expect(refused.error.message).toContain(migration.paths.runbook);
    expect(diffCatalogs(before, await catalogSnapshot(db.query), { left: 'before', right: 'after' })).toEqual([]);
    expect(await db.query.value(`select count(*) from ${LEDGER} where name = $1`, [MIGRATION])).toBe(0);
    // The page names the code and the words of the refusal.
    expect(page).toContain('`link profiles the gate refuses` (code `SLM05`)');

    // The page: list them…
    expect(listRefused, 'the page no longer gives the list').toBeTruthy();
    // Pasted between double quotes in a shell: these would be read by it.
    expect(listRefused).not.toMatch(/["$`\\!;]/);
    const [listed] = await db.readOnly(listRefused, 'the list of the page');
    expect(listed.rows).toEqual([
      { link: FORGED, since: '2026-09-01', coach: 'Alex', coach_role: 'student', athlete: 'Una', athlete_role: 'student', programs: 1 },
      { link: SELF, since: '2026-09-02', coach: 'Coach Olga', coach_role: 'coach', athlete: 'Coach Olga', athlete_role: 'coach', programs: 0 },
    ]);
    // …and remove them, one by one, with the `link` of each row.
    expect(removeLink, 'the page no longer gives the removal').toBeTruthy();
    expect(removeLink).toBe(`delete from public.students where id = '<link>' returning id`);
    for (const { link } of listed.rows) {
      const removed = await db.query.rows(removeLink.replace('<link>', link));
      expect(removed).toEqual([{ id: link }]);
    }
    expect(await db.query.value(`select count(*) from public.programs where name = 'Ghost block'`)).toBe(0);
    expect(await printedAudit(db)).toMatchObject({
      ...LEFT,
      'coach-athlete links the gate refuses': '0',
      accounts: '2 coach(es), 1 athlete(s) with a coach, 1 athlete(s) without one',
    });

    // Lines 12 to 14 do not stop the migration, and it changes none of them.
    await db.runFile(migration.paths.migration);
    expect(await printedAudit(db)).toMatchObject({ ...LEFT,
      'coach-athlete links the gate refuses': '0',
      accounts: '2 coach(es), 1 athlete(s) with a coach, 1 athlete(s) without one',
    });
    // What they are, as the page says: still there, still editable, not copied.
    expect(await request(db, THE_COACH, `update public.exercise_slots set sets = 4 where exercise_id = '${ROW}' returning sets`)).toBe(4);
    expect(await request(db, THE_COACH, foreignSlot)).toBe(FOREIGN_EXERCISE(ROW));
    expect(await request(db, THE_ATHLETE, `select count(*) from public.exercise_library where coach_id = '${ATHLETE}'`)).toBe(1);
    expect(await request(db, THE_ATHLETE, `update public.exercise_library set name = 'Edited' where coach_id = '${ATHLETE}' returning name`))
      .toBe(RLS('exercise_library'));
    await db.drop();
  });

  it('a link that holds logged training is not removed by the page\'s statement: it says so', async () => {
    const db = await production();
    await db.runSql(`
      insert into public.set_logs (exercise_slot_id, set_number, target_reps, done) values ('${SLOT}', 1, 5, true);
    `, 'a set Alex did');
    const removed = await attempt(() => db.query(removeLink.replace('<link>', LINK)));
    expect(removed.error?.message).toMatch(/still has 1 logged set\(s\)/);
    expect(page).toContain('`… still has N logged set(s) …`');
    expect(await db.query.value(`select count(*) from public.students`)).toBe(1);
    await db.drop();
  });

  it('the page\'s check answers NOT PROTECTED before and protected after — and writes nothing either way', async () => {
    const db = await production();
    expect(pageCheck, 'the page no longer gives the check').toBeTruthy();
    // Pasted between single quotes in a shell: it may not hold one.
    expect(pageCheck).not.toContain("'");
    const answer = async () => {
      const tried = await attempt(() => db.runSql(pageCheck, 'page check'));
      expect(tried.ok, 'the check must always fail: that is what undoes it').toBe(false);
      return (tried.error.cause ?? tried.error).message;
    };
    const state = () => db.query.one(
      `select (select count(*) from public.students) as links, current_user::text as role,
              coalesce(current_setting('request.jwt.claims', true), '') as claims`,
    );

    expect(await answer()).toBe('check only, nothing was written: NOT PROTECTED: the forged link went in');
    expect(await state()).toEqual({ links: 1, role: 'postgres', claims: '' });

    await db.runFile(migration.paths.migration);
    expect(await answer()).toBe(`check only, nothing was written: protected: ${NOT_A_COACH(ATHLETE)}`);
    expect(await state()).toEqual({ links: 1, role: 'postgres', claims: '' });
    // What the page says the command prints.
    expect(page).toContain('`check only, nothing was written: protected: students.coach_id … is not a coach: its profile has the role student`');
    expect(page).toContain('`… NOT PROTECTED: the forged link went in`');

    // With nobody linked there is nothing to try, and it says so.
    await db.query(`delete from public.students`);
    expect(await answer()).toBe('check only: no athlete is linked to a coach in this database, nothing to try');
    await db.drop();
  });

  it('the page\'s statement links an athlete to a coach, and answers what the page says when the addresses are wrong', async () => {
    const db = await production();
    await db.runFile(migration.paths.migration);
    expect(linkAthlete, 'the page no longer gives the statement').toBeTruthy();
    expect(linkAthlete).toContain(`'<e-mail of the athlete>'`);
    expect(linkAthlete).toContain(`'<e-mail of the coach>'`);
    const link = (athlete, coach) => attempt(() => db.query.rows(
      linkAthlete.replace('<e-mail of the athlete>', athlete).replace('<e-mail of the coach>', coach).replace(/;\s*$/, ''),
    ));
    const onPage = (sentence) => expect(page, sentence).toContain(`| \`${sentence}\` |`);

    // Every refusal of the page's table first; nothing is written by any.
    expect((await link('una@sl.test', 'nobody@sl.test')).value).toEqual([]);
    expect((await link('una@sl.test', 'alex@sl.test')).error?.message).toBe(NOT_A_COACH(ATHLETE));
    onPage('students.coach_id … is not a coach: its profile has the role student');
    expect((await link('olga@sl.test', 'coach@sl.test')).error?.message).toBe(NOT_AN_ATHLETE(OLGA));
    onPage('students.profile_id … is not an athlete: its profile has the role coach');
    expect((await link('coach@sl.test', 'coach@sl.test')).error?.message).toBe(OWN_COACH(COACH));
    onPage('students: profile … cannot be its own coach');
    expect((await link('alex@sl.test', 'olga@sl.test')).error?.message)
      .toBe('duplicate key value violates unique constraint "students_profile_id_key"');
    onPage('duplicate key value violates unique constraint "students_profile_id_key"');
    expect(await db.query.value(`select count(*) from public.students`)).toBe(1);

    // And the link.
    const made = await link('una@sl.test', 'coach@sl.test');
    expect(made.value).toEqual([{ id: expect.any(String), profile_id: FREE, coach_id: COACH }]);
    // Both sides see it, as the page says.
    expect(await request(db, user(FREE), `select full_name from public.profiles where id = '${COACH}'`)).toBe('Coach Carla');
    expect(await request(db, THE_COACH, `select count(*) from public.students`)).toBe(2);
    await db.drop();
  });

  it('without migration 04 it says so (SLM02), and its rollback says there is nothing to undo (SLM03)', async () => {
    const db = await scratchDatabase();
    await db.runFile(manifest.baseline);
    const refusals = async () => {
      const before = await catalogSnapshot(db.query);
      const refused = await attempt(() => db.runFile(migration.paths.migration));
      const undone = await attempt(() => db.runFile(migration.paths.rollback));
      expect(diffCatalogs(before, await catalogSnapshot(db.query), { left: 'before', right: 'after' })).toEqual([]);
      return [refused.error?.code, refused.error?.message, undone.error?.code];
    };
    // Without a ledger at all, then with the ledger and the migrations before 04 only.
    const needs = 'needs 2026_10_11_04_logged_history_guards, which is not applied';
    let [code, message, undone] = await refusals();
    expect([code, undone]).toEqual([REFUSAL.predecessorMissing, REFUSAL.notApplied]);
    expect(message).toContain(needs);
    for (const earlier of manifest.migrations.slice(0, 3)) await db.runFile(earlier.paths.migration);
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
    // A helper of the same name, made by hand, that answers for any profile.
    await db.query(`create function public.is_coach(p uuid) returns boolean language sql as 'select true'`);
    expect(await refusal()).toContain(`migration ${MIGRATION} would not replace: is_coach(uuid)`);
    await db.query(`drop function public.is_coach(uuid)`);

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

  // A policy the file does not know would keep open the door it closes. It
  // reads its own result back, so it cannot end "applied" next to one.
  it('undoes itself when a policy made by hand would leave the table open', async () => {
    const db = await production();
    const refusal = async () => {
      const before = await catalogSnapshot(db.query);
      const refused = await attempt(() => db.runFile(migration.paths.migration));
      expect(diffCatalogs(before, await catalogSnapshot(db.query), { left: 'before', right: 'after' })).toEqual([]);
      expect(await db.query.value(`select count(*) from ${LEDGER} where name = $1`, [MIGRATION])).toBe(0);
      return refused.error?.message ?? 'it ran';
    };

    await db.query(`create policy "Coaches add athletes" on public.students for insert with check (coach_id = auth.uid())`);
    expect(await refusal()).toContain(
      `migration ${MIGRATION} did not get the policies it meant: public.students still has the policy "Coaches add athletes" for INSERT`,
    );
    await db.query(`drop policy "Coaches add athletes" on public.students`);

    await db.query(`create policy "Anyone adds exercises" on public.exercise_library for insert with check (coach_id = auth.uid())`);
    expect(await refusal()).toContain(
      'did not get the policies it meant: public.exercise_library has the policy "Anyone adds exercises", which writes without asking for is_coach()',
    );
    await db.query(`drop policy "Anyone adds exercises" on public.exercise_library`);

    await db.query(`alter table public.students disable row level security`);
    expect(await refusal()).toContain('did not get the policies it meant: row-level security is off on public.students');
    await db.query(`alter table public.students enable row level security`);

    // One of the three already dropped by hand is not in the way.
    await db.query(`drop policy "Coaches delete their students" on public.students`);
    await db.runFile(migration.paths.migration);
    expect((await printedAudit(db))['policies that let a signed-in user write students (P7, L2)'])
      .toBe('Coaches update their students (UPDATE)');
    await db.drop();
  });

  // A grant that `postgres` did not make is one its REVOKE does not remove.
  it('undoes itself when one of its functions would stay open to a request without a session', async () => {
    const db = await production();
    await db.runSql(
      `BEGIN;
       create function public.check_students_link() returns trigger language plpgsql as 'begin return new; end';
       grant execute on function public.check_students_link() to service_role with grant option;
       set local role service_role;
       grant execute on function public.check_students_link() to anon;
       COMMIT;`,
      'a function made by hand, opened by another role',
    );
    const before = await catalogSnapshot(db.query);
    const refused = await attempt(() => db.runFile(migration.paths.migration));
    expect(refused.error?.message).toContain(
      `migration ${MIGRATION} did not get the functions it meant: public.check_students_link(): anon may execute it`,
    );
    expect(diffCatalogs(before, await catalogSnapshot(db.query), { left: 'before', right: 'after' })).toEqual([]);
    expect(await db.query.value(`select count(*) from ${LEDGER} where name = $1`, [MIGRATION])).toBe(0);
    await db.drop();
  });

  it('a check that is there and switched off is not "in place" for the audit', async () => {
    const db = await production();
    await db.runFile(migration.paths.migration);
    await db.query(`alter table public.students disable trigger trg_check_students_link`);
    await db.query(`alter table public.slot_deviations disable trigger trg_check_deviation_substitute_in_coach_library`);
    expect(await printedAudit(db)).toMatchObject({
      'a students row is checked when it is written': 'missing',
      'the exercise of a slot is checked against the coach\'s library': 'in place',
      'the substitute of a swap is checked against the coach\'s library': 'missing',
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
    expect(await request(db, THE_ATHLETE, forge)).toBe(NOT_A_COACH(ATHLETE));
    await db.drop();
  });
});
