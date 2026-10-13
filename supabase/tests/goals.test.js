// Goals outlive a library clean-up and a change of coach — review findings
// P18 / L7, P21 and B9, closed by migration 2026_10_13_10_goals_fk_coach_links.
//
// A goal is set by a coach, on an exercise of their library, for one athlete,
// who logs attempts against it (goal_progress). Until the migration:
//
//   the library      deleting an exercise that only a goal named deleted the
//                    goal and every attempt with it (goals.exercise_id CASCADE)
//   a coach's        deleting it deleted the links of their athletes — and the
//   account          programs under them — and the goals (students.coach_id
//                    and goals.coach_id CASCADE)
//   a change of      the former coach went on reading the athlete's attempts,
//   coach            and nobody managed the goals; the link was moved by hand
//
// Since the migration:
//
//   three foreign keys   RESTRICT: 23503, and nothing is removed. An athlete's
//                        own account still goes with what is theirs
//   archived_at          a column on exercise_library, for the exercise that
//                        can no longer be deleted. The database refuses
//                        nothing about an archived exercise
//   the progress         read by the coach who set the goal WHILE they coach
//                        its athlete (coach_profile_for_goal follows the link)
//   transfer_student     moves the link and the goals together — for the owner
//                        of the database and the service role, never for a
//                        request that carries a user id
//
// The first blocks run against schema.sql, as the callers there are. The
// writes of the app that is DEPLOYED today are replayed as it sends them
// (src/hooks/useExerciseLibrary.js, useGoals.js): the migration is applied
// while that app is live. The last block applies the migration file itself to
// the frozen production baseline, with the checks and the statements of its
// runbook page read off the page.

import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  asAdmin, asAnon, asPlatformRole, asService, asUser, attempt, createProgram, createUser, repoRoot,
  scenario, scratchDatabase, seed,
} from './harness.js';
import { catalogSnapshot, diffCatalogs } from './catalog.js';
import { LEDGER, loadManifest, REFUSAL } from '../migrations/manifest.js';

const MIGRATION = '2026_10_13_10_goals_fk_coach_links';
const manifest = loadManifest();
const migration = manifest.migrations.find((m) => m.name === MIGRATION);
const read = (file) => fs.readFileSync(path.join(repoRoot, file), 'utf8');

// seed(): coach Carla with athletes Alex (A) and Billie (B), and her library
// (pull-up and dip in both blocks; squat and muscle-up in none). Next to them:
// a second coach, Olga, with her athlete Casey and a library of one exercise,
// and Una, an account nobody coaches. Three goals:
//   goals.a   Carla → Alex, on the SQUAT — an exercise no program uses: the one
//             a library clean-up took. Two attempts.
//   goals.b   Carla → Billie, on the pull-up of her block. One attempt.
//   goals.c   Olga → Casey, on the row. One attempt.
let ids;
let olga;
let casey;
let una;
let row;      // the exercise of Olga's library
let goals;

beforeAll(async () => {
  ids = await seed();
  olga = await createUser({ email: 'olga@sl.test', fullName: 'Coach Olga', role: 'coach' });
  casey = await createUser({ email: 'casey@sl.test', fullName: 'Casey Athlete', coach: olga });
  una = await createUser({ email: 'una@sl.test', fullName: 'Una Unlinked' });
  row = await asAdmin((q) => q.value(
    `insert into exercise_library (coach_id, name, type, difficulty) values ($1, 'Row', 'pull', 1) returning id`,
    [olga.id],
  ), { commit: true });
  await createProgram({ student: casey, name: 'Block C', exercises: [row], active: true });
  goals = await asAdmin(async (q) => {
    const goal = (athlete, coach, exercise) => q.value(
      `insert into goals (student_id, coach_id, exercise_id, kind, target_weight_kg)
       values ($1, $2, $3, 'one_rm', 100) returning id`,
      [athlete.id, coach.id, exercise],
    );
    const logged = (goalId, kg) => q(`insert into goal_progress (goal_id, weight_kg, reps) values ($1, $2, 1)`, [goalId, kg]);
    const a = await goal(ids.studentA, ids.coach, ids.exercises.squat);
    const b = await goal(ids.studentB, ids.coach, ids.exercises.pullUp);
    const c = await goal(casey, olga, row);
    await logged(a, 80);
    await logged(a, 85);
    await logged(b, 40);
    await logged(c, 60);
    return { a, b, c };
  }, { commit: true });
});

// The sentences of PostgreSQL 17 and of the migration.
const FK = (table, constraint, on) => `update or delete on table "${table}" violates foreign key constraint "${constraint}" on table "${on}"`;
const NOT_FROM_THE_APP = 'an athlete is moved to another coach by the owner of the database, not from the app';
const NO_LINK = (id) => `profile ${id} is not the athlete of a coach: there is no link to move`;
const NOT_A_COACH = (id, role = 'student') => `students.coach_id ${id} is not a coach: its profile has the role ${role}`;
const OWN_COACH = (id) => `students: profile ${id} cannot be its own coach`;
const NO_EXECUTE = 'permission denied for function transfer_student';

// What the app that is DEPLOYED does with the error of a write
// (src/lib/mutationErrors.js, as production runs it), for the codes this
// migration raises. Restated here: that code is live, and the refusal of a
// library delete must come out as "in use" — never as "archive it instead".
const toastOf = (error) => {
  const said = `${error.message || ''} ${error.detail || ''} ${error.hint || ''}`.toLowerCase();
  if (said.includes('logged set')) return 'errors.hasLoggedTraining';
  if (error.code === '23503' || said.includes('foreign key') || said.includes('still referenced')) return 'errors.inUse';
  if (error.code === '42501' || said.includes('row-level security') || said.includes('permission denied')) return 'errors.notAllowed';
  return 'errors.generic';
};

// How many attempts a caller reads — all of them, through their own eyes.
const attemptsRead = (who) => asUser(who, (user) => user.value(`select count(*) from goal_progress`));
const goalsRead = (who) => asUser(who, (user) => user.value(`select count(*) from goals`));
// Everything a wrong DELETE could take with it.
const census = (q) => q.one(
  `select (select count(*) from profiles)          as profiles,
          (select count(*) from students)          as links,
          (select count(*) from programs)          as programs,
          (select count(*) from set_logs)          as sets,
          (select count(*) from exercise_library)  as exercises,
          (select count(*) from goals)             as goals,
          (select count(*) from goal_progress)     as attempts,
          (select count(*) from messages)          as messages`,
);
const transfer = (as, athlete, coach) => as((caller) => caller.value(
  `select public.transfer_student($1, $2)`, [athlete?.id ?? athlete, coach?.id ?? coach],
));
const writers = [['postgres (the SQL editor)', asAdmin], ['the service role', asService]];

// ============================================================
// P18 / L7 — the exercise of a goal
// ============================================================
describe('a library exercise that a goal is set on is not deleted (P18, L7)', () => {
  const squatAndItsGoal = (q) => q.one(
    `select (select count(*) from exercise_library where id = $1)  as exercise,
            (select count(*) from goals where id = $2)             as goal,
            (select count(*) from goal_progress where goal_id = $2) as attempts`,
    [ids.exercises.squat, goals.a],
  );

  // useDeleteExercise: supabase.from('exercise_library').delete().eq('id', id).
  it('the deployed app, as the coach: refused, shown as "in use" — the exercise, the goal and its attempts stay', () => scenario(async (q) => {
    const removal = await attempt(() => asUser(ids.coach, (coach) => coach(
      `delete from exercise_library where id = $1`, [ids.exercises.squat],
    )));
    expect(removal.error?.message).toBe(FK('exercise_library', 'goals_exercise_id_fkey', 'goals'));
    expect(removal.error.code).toBe('23503');
    expect(toastOf(removal.error)).toBe('errors.inUse');
    expect(await squatAndItsGoal(q)).toEqual({ exercise: 1, goal: 1, attempts: 2 });
  }));

  it.each(writers)('%s is refused too: a foreign key judges every writer', (_, as) => scenario(async (q) => {
    const removal = await attempt(() => as((writer) => writer(
      `delete from exercise_library where id = $1`, [ids.exercises.squat],
    )));
    expect(removal.error?.code).toBe('23503');
    expect(removal.error.constraint).toBe('goals_exercise_id_fkey');
    expect(await squatAndItsGoal(q)).toEqual({ exercise: 1, goal: 1, attempts: 2 });
  }));

  // Deleting a GOAL is its coach's decision (useDeleteGoal), and still takes
  // its attempts: goal_progress follows goals, as before.
  it('the coach deletes the goal, its attempts go with it, and the exercise can then be deleted', () => scenario(async (q) => {
    await asUser(ids.coach, async (coach) => {
      expect((await coach(`delete from goals where id = $1`, [goals.a])).rowCount).toBe(1);
      expect((await coach(`delete from exercise_library where id = $1`, [ids.exercises.squat])).rowCount).toBe(1);
    });
    expect(await squatAndItsGoal(q)).toEqual({ exercise: 0, goal: 0, attempts: 0 });
    // Nobody else's goal went with either.
    expect(await q.value(`select count(*) from goals`)).toBe(2);
  }));

  it('an exercise nothing names is deleted as before; one in a session is refused as before', () => scenario(async (q) => {
    await asUser(ids.coach, async (coach) => {
      expect((await coach(`delete from exercise_library where id = $1`, [ids.exercises.muscleUp])).rowCount).toBe(1);
      const inUse = await attempt(() => coach(`delete from exercise_library where id = $1`, [ids.exercises.dip]));
      expect(inUse.error?.message).toBe(FK('exercise_library', 'exercise_slots_exercise_id_fkey', 'exercise_slots'));
    });
    expect(await q.value(`select count(*) from exercise_library where coach_id = $1`, [ids.coach.id])).toBe(3);
  }));

  it('the whole library in one statement: nothing goes while one exercise is named', () => scenario(async (q) => {
    const removal = await attempt(() => asUser(ids.coach, (coach) => coach(`delete from exercise_library`)));
    expect(removal.error?.code).toBe('23503');
    expect(await q.value(`select count(*) from exercise_library where coach_id = $1`, [ids.coach.id])).toBe(4);
  }));
});

// ============================================================
// exercise_library.archived_at
// ============================================================
describe('an exercise can be archived', () => {
  const archived = (q, exercise) => q.value(
    `select archived_at is not null from exercise_library where id = $1`, [exercise],
  );

  it('every exercise starts out not archived, and the library read of the deployed app carries the column', async () => {
    // useExerciseLibrary: supabase.from('exercise_library').select('*').
    const rows = await asUser(ids.coach, (coach) => coach.rows(`select * from exercise_library order by name`));
    expect(rows.map((exercise) => [exercise.name, exercise.archived_at])).toEqual([
      ['Dip', null], ['Muscle-up', null], ['Pull-up', null], ['Squat', null],
    ]);
  });

  it('its coach archives it and restores it; archived, it is still read by the athlete — in the library and under their goal', () => scenario(async (q) => {
    await asUser(ids.coach, async (coach) => {
      expect((await coach(`update exercise_library set archived_at = now() where id = $1`, [ids.exercises.squat])).rowCount).toBe(1);
    });
    expect(await archived(q, ids.exercises.squat)).toBe(true);

    await asUser(ids.studentA, async (athlete) => {
      expect(await athlete.value(`select count(*) from exercise_library`)).toBe(4);
      // useMyGoals embeds the exercise of each goal.
      expect(await athlete.rows(
        `select el.name, el.archived_at is not null as archived
           from goals g join exercise_library el on el.id = g.exercise_id`,
      )).toEqual([{ name: 'Squat', archived: true }]);
      // …and an attempt is still logged against it.
      await athlete(`insert into goal_progress (goal_id, weight_kg, reps) values ($1, 90, 1)`, [goals.a]);
    });
    expect(await attemptsRead(ids.coach)).toBe(4);

    await asUser(ids.coach, (coach) => coach(`update exercise_library set archived_at = null where id = $1`, [ids.exercises.squat]));
    expect(await archived(q, ids.exercises.squat)).toBe(false);
  }));

  it('nobody else archives it: not an athlete of that coach, not another coach, not a request without a session', () => scenario(async (q) => {
    const archive = `update exercise_library set archived_at = now() where id = $1`;
    for (const who of [ids.studentA, olga, una]) {
      const tried = await attempt(() => asUser(who, (user) => user(archive, [ids.exercises.squat])));
      expect(tried.ok ? tried.value.rowCount : tried.error.message, who.email).toBe(0);
    }
    await attempt(() => asAnon((anon) => anon(archive, [ids.exercises.squat])));
    expect(await archived(q, ids.exercises.squat)).toBe(false);
  }));

  // "Not offered for new work" is the pickers' rule. The database keeps
  // treating an archived exercise as an exercise: a function that copies a
  // session copies its slots whatever their exercise has become.
  it('the database refuses nothing about an archived exercise: its slots stay, a new slot takes it, and it is still not deleted while named', () => scenario(async (q) => {
    await asUser(ids.coach, async (coach) => {
      await coach(`update exercise_library set archived_at = now() where id = any($1)`,
        [[ids.exercises.pullUp, ids.exercises.squat, ids.exercises.muscleUp]]);
      expect(await coach.value(`select count(*) from exercise_slots where exercise_id = $1`, [ids.exercises.pullUp])).toBe(5);
      await coach(
        `insert into exercise_slots (session_id, exercise_id, sets, reps, sort_order) values ($1, $2, 3, 5, 9)`,
        [ids.programA.sessions[0], ids.exercises.squat],
      );
      const named = await attempt(() => coach(`delete from exercise_library where id = $1`, [ids.exercises.pullUp]));
      expect(named.error?.code).toBe('23503');
      // Archived and named by nothing: deleted like any other.
      expect((await coach(`delete from exercise_library where id = $1`, [ids.exercises.muscleUp])).rowCount).toBe(1);
    });
    expect(await q.value(`select count(*) from exercise_slots where exercise_id = $1`, [ids.exercises.squat])).toBe(1);
  }));
});

// ============================================================
// B9 — the account of a coach
// ============================================================
describe('the profile of a coach is not deleted over their athletes (B9)', () => {
  // An account is deleted in auth.users; profiles follows it, and everything
  // else hangs under profiles.
  const removeAccount = (q, user) => attempt(() => q(`delete from auth.users where id = $1`, [user.id]));

  // What stands in the way of Carla's account: her two athletes, the goals
  // she set, and — as before the migration — the exercises of her library
  // that their sessions and goals use. PostgreSQL names the first one it
  // meets, and that order is not ours to choose (the triggers of the foreign
  // keys fire in the order of their internal names).
  const IN_THE_WAY = ['students_coach_id_fkey', 'goals_coach_id_fkey', 'exercise_slots_exercise_id_fkey', 'goals_exercise_id_fkey'];

  it('a coach with athletes: refused, and every athlete keeps their link, programs, sets, goals and messages', () => scenario(async (q) => {
    const before = await census(q);
    const removal = await removeAccount(q, ids.coach);
    expect(removal.error?.code).toBe('23503');
    expect(IN_THE_WAY).toContain(removal.error.constraint);
    expect(toastOf(removal.error)).toBe('errors.inUse');
    expect(await census(q)).toEqual(before);
    // The sentence of the guard on logged sets — "move it to the trash
    // instead" — is not what comes back any more, logged sets or not.
    await q(`update set_logs set done = true, logged_at = now() where id = $1`, [ids.programA.setLogs[0]]);
    const withHistory = await removeAccount(q, ids.coach);
    expect(withHistory.error?.code).toBe('23503');
    expect(withHistory.error.message).not.toContain('logged set');
    expect(await census(q)).toEqual(before);
  }));

  // The first of the two foreign keys on its own: a coach with one athlete,
  // who has no program yet, no goal and no library — the case in which the
  // account used to go, and the link with it, without a word.
  it('the link holds the profile by itself: a coach whose one athlete has nothing yet', () => scenario(async (q) => {
    const petra = await createUser({ email: 'petra@sl.test', fullName: 'Coach Petra', role: 'coach' });
    const nina = await createUser({ email: 'nina@sl.test', fullName: 'Nina Newcomer', coach: petra });
    const removal = await removeAccount(q, petra);
    expect(removal.error?.message).toBe(FK('profiles', 'students_coach_id_fkey', 'students'));
    expect(await q.value(`select coach_id from students where profile_id = $1`, [nina.id])).toBe(petra.id);
  }));

  it('the service role, on the profile itself, is refused the same way', () => scenario(async (q) => {
    const before = await census(q);
    const removal = await attempt(() => asService((service) => service(`delete from profiles where id = $1`, [ids.coach.id])));
    expect(removal.error?.code).toBe('23503');
    expect(IN_THE_WAY).toContain(removal.error.constraint);
    expect(await census(q)).toEqual(before);
  }));

  // "Delete user" in the dashboard is GoTrue's DELETE.
  it('GoTrue — "Delete user" in the dashboard — is refused, and the account is still there', async () => {
    const removal = await attempt(() => asPlatformRole('supabase_auth_admin', (gotrue) => gotrue(
      `delete from auth.users where id = $1`, [ids.coach.id],
    )));
    expect(removal.error?.code).toBe('23503');
    expect(IN_THE_WAY).toContain(removal.error.constraint);
    expect(await asAdmin((q) => q.one(
      `select (select count(*) from auth.users where id = $1) as account, (select count(*) from students where coach_id = $1) as athletes`,
      [ids.coach.id],
    ))).toEqual({ account: 1, athletes: 2 });
  });

  // The link removed by hand, the goal left behind: its exercise is the
  // coach's, and the library is what the DELETE reaches first.
  it('a coach nobody trains under any more, with a goal left behind: refused, and the goal stays', () => scenario(async (q) => {
    await q(`delete from students where profile_id = $1`, [casey.id]);
    const removal = await removeAccount(q, olga);
    expect(removal.error?.code).toBe('23503');
    expect(['goals_exercise_id_fkey', 'goals_coach_id_fkey']).toContain(removal.error.constraint);
    expect(await q.one(
      `select (select count(*) from profiles where id = $1) as coach,
              (select count(*) from goal_progress where goal_id = $2) as attempts`,
      [olga.id, goals.c],
    )).toEqual({ coach: 1, attempts: 1 });
  }));

  // The second of the two foreign keys on its own: a coach whom a goal names,
  // with no athlete and no library in the way.
  it('a goal that names a coach holds the profile by itself', () => scenario(async (q) => {
    const petra = await createUser({ email: 'petra@sl.test', fullName: 'Coach Petra', role: 'coach' });
    const left = await q.value(
      `insert into goals (student_id, coach_id, exercise_id, kind, target_weight_kg)
       values ($1, $2, $3, 'one_rm', 60) returning id`,
      [una.id, petra.id, ids.exercises.muscleUp],
    );
    const removal = await removeAccount(q, petra);
    expect(removal.error?.message).toBe(FK('profiles', 'goals_coach_id_fkey', 'goals'));
    expect(await q.value(`select count(*) from goals where id = $1`, [left])).toBe(1);
  }));

  it('a coach with no athlete, no goal and a library nothing uses is deleted, library included', () => scenario(async (q) => {
    const petra = await createUser({ email: 'petra@sl.test', fullName: 'Coach Petra', role: 'coach' });
    await q(`insert into exercise_library (coach_id, name, type, difficulty) values ($1, 'Lever', 'pull', 3)`, [petra.id]);
    const removal = await removeAccount(q, petra);
    expect(removal.error?.message).toBeUndefined();
    expect(await q.one(
      `select (select count(*) from profiles where id = $1) as profile,
              (select count(*) from exercise_library where coach_id = $1) as exercises`,
      [petra.id],
    )).toEqual({ profile: 0, exercises: 0 });
  }));

  // The other end of the link is not touched: what is the athlete's goes with
  // the athlete.
  it('an athlete\'s account still goes with what is theirs — link, programs, goals, attempts — and the coach keeps the rest', () => scenario(async (q) => {
    const before = await census(q);
    const removal = await removeAccount(q, casey);
    expect(removal.error?.message).toBeUndefined();
    expect(await census(q)).toEqual({
      ...before,
      profiles: before.profiles - 1,
      links: before.links - 1,
      programs: before.programs - 1,
      sets: before.sets - 3,
      goals: before.goals - 1,
      attempts: before.attempts - 1,
    });
    expect(await q.value(`select count(*) from exercise_library where id = $1`, [row])).toBe(1);
    expect(await asUser(olga, (coach) => coach.value(`select count(*) from students`))).toBe(0);
  }));
});

// ============================================================
// P21 — who reads the progress of a goal
// ============================================================
describe('a coach reads the progress of a goal only while they coach its athlete (P21)', () => {
  const coachOfGoal = (who, goal) => asUser(who, (user) => user.value(`select public.coach_profile_for_goal($1)`, [goal]));
  // The link rewritten by hand, as it was before transfer_student: the goals
  // stay with the former coach.
  const moveByHand = (q, athlete, coach) => q(
    `update students set coach_id = $2 where profile_id = $1`, [athlete.id, coach.id],
  );

  it('while the link stands: a coach reads the attempts of their athletes, an athlete their own, nobody else anything', async () => {
    expect({
      carla: await attemptsRead(ids.coach),
      olga: await attemptsRead(olga),
      alex: await attemptsRead(ids.studentA),
      billie: await attemptsRead(ids.studentB),
      casey: await attemptsRead(casey),
      una: await attemptsRead(una),
    }).toEqual({ carla: 3, olga: 1, alex: 2, billie: 1, casey: 1, una: 0 });
    expect(await coachOfGoal(ids.coach, goals.a)).toBe(ids.coach.id);
    expect(await coachOfGoal(olga, goals.c)).toBe(olga.id);
  });

  it('the deployed app: a goal is set, read with its exercise and its attempts, logged against, marked achieved and deleted', () => scenario(async (q) => {
    // useCreateGoal, as the coach.
    const made = await asUser(ids.coach, (coach) => coach.value(
      `insert into goals (student_id, coach_id, exercise_id, kind, target_weight_kg, target_reps)
       values ($1, $2, $3, 'format', 60, 5) returning id`,
      [ids.studentA.id, ids.coach.id, ids.exercises.dip],
    ));
    await asUser(ids.studentA, async (athlete) => {
      // useAddGoalProgress, useToggleGoalAchieved.
      await athlete(`insert into goal_progress (goal_id, weight_kg, sets, reps, notes) values ($1, 55, 3, 5, null)`, [made]);
      expect((await athlete(`update goals set achieved = true, achieved_at = now() where id = $1`, [made])).rowCount).toBe(1);
      expect(await athlete.value(`select count(*) from goals`)).toBe(2);
    });
    await asUser(ids.coach, async (coach) => {
      // useStudentGoals: goals with exercise:exercise_library(*) and goal_progress(*).
      expect(await coach.rows(
        `select el.name, g.achieved, (select count(*) from goal_progress gp where gp.goal_id = g.id) as attempts
           from goals g join exercise_library el on el.id = g.exercise_id
          where g.student_id = $1 order by el.name`,
        [ids.studentA.id],
      )).toEqual([{ name: 'Dip', achieved: true, attempts: 1 }, { name: 'Squat', achieved: false, attempts: 2 }]);
      // A coach reads the attempts and does not write them.
      expect((await coach(`delete from goal_progress where goal_id = $1`, [made])).rowCount).toBe(0);
      expect((await coach(`delete from goals where id = $1`, [made])).rowCount).toBe(1);
    });
    expect(await q.value(`select count(*) from goal_progress where goal_id = $1`, [made])).toBe(0);
  }));

  it('once the athlete has another coach, the one who set the goal reads none of its attempts — the old ones or the new', () => scenario(async (q) => {
    await moveByHand(q, ids.studentA, olga);
    expect(await attemptsRead(ids.coach)).toBe(1);   // Billie's, still hers
    expect(await coachOfGoal(ids.coach, goals.a)).toBeNull();
    // The athlete keeps the goal, and goes on logging against it.
    await asUser(ids.studentA, (athlete) => athlete(
      `insert into goal_progress (goal_id, weight_kg, reps) values ($1, 90, 1)`, [goals.a],
    ));
    expect(await attemptsRead(ids.studentA)).toBe(3);
    expect(await attemptsRead(ids.coach)).toBe(1);
    // Nor the goal itself, which was already so — and she cannot write her way back to it.
    expect(await goalsRead(ids.coach)).toBe(1);
    expect((await asUser(ids.coach, (coach) => coach(`update goals set notes = 'still mine' where id = $1`, [goals.a]))).rowCount).toBe(0);
    // A goal moved by hand is managed by nobody: the new coach has the link,
    // not the goal. That is what transfer_student is for.
    expect({ goals: await goalsRead(olga), attempts: await attemptsRead(olga) }).toEqual({ goals: 1, attempts: 1 });
  }));

  it('once the athlete has no coach at all, nobody but the athlete reads them', () => scenario(async (q) => {
    await q(`delete from students where profile_id = $1`, [casey.id]);
    expect(await attemptsRead(olga)).toBe(0);
    expect(await coachOfGoal(olga, goals.c)).toBeNull();
    expect(await attemptsRead(casey)).toBe(1);
  }));

  it('the athlete cannot hand their goal to somebody else, nor a coach take one by naming themselves', () => scenario(async (q) => {
    await asUser(ids.studentA, (athlete) => athlete(`update goals set coach_id = $2 where id = $1`, [goals.a, olga.id]));
    const taken = await attempt(() => asUser(olga, (coach) => coach(`update goals set coach_id = $2 where id = $1`, [goals.a, olga.id])));
    expect(taken.ok ? taken.value.rowCount : taken.error.message).toBe(0);
    expect(await q.value(`select coach_id from goals where id = $1`, [goals.a])).toBe(ids.coach.id);
    expect(await attemptsRead(olga)).toBe(1);
  }));

  it('a goal that does not exist has no coach, and a request without a session is not answered', async () => {
    expect(await coachOfGoal(ids.coach, '00000000-0000-4000-8000-00000000dead')).toBeNull();
    const asked = await attempt(() => asAnon((anon) => anon.value(`select public.coach_profile_for_goal($1)`, [goals.a])));
    expect(asked.error?.message).toBe('permission denied for function coach_profile_for_goal');
  });
});

// ============================================================
// transfer_student
// ============================================================
describe('transfer_student moves an athlete and their goals to another coach', () => {
  const linkOf = (q, athlete) => q.value(`select coach_id from students where profile_id = $1`, [athlete.id]);
  const blocksRead = (who) => asUser(who, (user) => user.rows(`select name from programs order by name`))
    .then((rows) => rows.map((program) => program.name));

  it.each(writers)('%s moves Alex to Olga: she reads and manages the block, the goal and its attempts — Carla none of it', (_, as) => scenario(async (q) => {
    expect(await transfer(as, ids.studentA, olga)).toEqual({
      student_id: ids.studentA.id,
      from_coach_id: ids.coach.id,
      to_coach_id: olga.id,
      link_moved: true,
      goals_moved: 1,
    });
    expect(await linkOf(q, ids.studentA)).toBe(olga.id);
    expect(await q.rows(`select id, coach_id from goals where student_id = $1`, [ids.studentA.id]))
      .toEqual([{ id: goals.a, coach_id: olga.id }]);

    expect({ blocks: await blocksRead(olga), goals: await goalsRead(olga), attempts: await attemptsRead(olga) })
      .toEqual({ blocks: ['Block A', 'Block C'], goals: 2, attempts: 3 });
    expect({ blocks: await blocksRead(ids.coach), goals: await goalsRead(ids.coach), attempts: await attemptsRead(ids.coach) })
      .toEqual({ blocks: ['Block B'], goals: 1, attempts: 1 });
    // Nothing of the athlete's was rewritten: same row for the link, same goal, same attempts.
    expect(await q.value(`select id from students where profile_id = $1`, [ids.studentA.id])).toBe(ids.studentA.studentRowId);
    expect(await attemptsRead(ids.studentA)).toBe(2);

    // The new coach manages the goal; the athlete logs, and she reads it.
    await asUser(olga, async (coach) => {
      expect((await coach(`update goals set target_weight_kg = 110 where id = $1`, [goals.a])).rowCount).toBe(1);
    });
    await asUser(ids.studentA, (athlete) => athlete(`insert into goal_progress (goal_id, weight_kg, reps) values ($1, 90, 1)`, [goals.a]));
    expect(await attemptsRead(olga)).toBe(4);
    expect((await asUser(ids.coach, (coach) => coach(`update goals set target_weight_kg = 1 where id = $1`, [goals.a]))).rowCount).toBe(0);
    // The messages follow the link too: the athlete writes to the coach of today.
    await asUser(ids.studentA, (athlete) => athlete(
      `insert into messages (sender_id, recipient_id, body) values ($1, $2, 'Hello coach')`, [ids.studentA.id, olga.id],
    ));
    const toTheFormer = await attempt(() => asUser(ids.studentA, (athlete) => athlete(
      `insert into messages (sender_id, recipient_id, body) values ($1, $2, 'Still there?')`, [ids.studentA.id, ids.coach.id],
    )));
    expect(toTheFormer.error?.code).toBe('42501');
  }));

  it('the other athletes of both coaches are where they were', () => scenario(async (q) => {
    await transfer(asAdmin, ids.studentA, olga);
    expect(await q.rows(
      `select p.full_name as athlete, c.full_name as coach, (select count(*) from goals g where g.student_id = s.profile_id and g.coach_id = s.coach_id) as goals
         from students s join profiles p on p.id = s.profile_id join profiles c on c.id = s.coach_id
        order by 1`,
    )).toEqual([
      { athlete: 'Alex Athlete', coach: 'Coach Olga', goals: 1 },
      { athlete: 'Billie Athlete', coach: 'Coach Carla', goals: 1 },
      { athlete: 'Casey Athlete', coach: 'Coach Olga', goals: 1 },
    ]);
  }));

  // What the function does NOT move, and the page says so: the exercises stay
  // in the library of the coach who wrote them, which only that coach's
  // athletes read. Migration 23 (wave 3) makes an exercise readable through
  // the program that uses it.
  it('it does not move the exercises: neither the athlete nor the new coach reads the former coach\'s library', () => scenario(async (q) => {
    await transfer(asAdmin, ids.studentA, olga);
    const named = `select count(*) from exercise_library where id = any($1)`;
    const theirs = [ids.exercises.pullUp, ids.exercises.dip, ids.exercises.squat];
    expect(await asUser(olga, (coach) => coach.value(named, [theirs]))).toBe(0);
    expect(await asUser(ids.studentA, (athlete) => athlete.value(named, [theirs]))).toBe(0);
    // The slots and the goal still point at them, and the rows are all there.
    expect(await q.value(`select exercise_id from goals where id = $1`, [goals.a])).toBe(ids.exercises.squat);
    expect(await asUser(olga, (coach) => coach.value(
      `select count(*) from exercise_slots es join sessions se on se.id = es.session_id
         join weeks w on w.id = se.week_id where w.program_id = $1`, [ids.programA.id],
    ))).toBe(8);
  }));

  it('moved back, everything is as it was', () => scenario(async (q) => {
    await transfer(asAdmin, ids.studentA, olga);
    expect(await transfer(asAdmin, ids.studentA, ids.coach)).toMatchObject({
      from_coach_id: olga.id, to_coach_id: ids.coach.id, link_moved: true, goals_moved: 1,
    });
    expect(await linkOf(q, ids.studentA)).toBe(ids.coach.id);
    expect({ carla: await attemptsRead(ids.coach), olga: await attemptsRead(olga) }).toEqual({ carla: 3, olga: 1 });
  }));

  // How goals that stayed behind after a link was rewritten by hand are put
  // right: the same call, with the coach the athlete has now.
  it('called with the coach the athlete already has, it moves no link and hands over the goals a former coach still held', () => scenario(async (q) => {
    await q(`update students set coach_id = $2 where profile_id = $1`, [ids.studentA.id, olga.id]);
    expect({ goals: await goalsRead(olga), attempts: await attemptsRead(olga) }).toEqual({ goals: 1, attempts: 1 });

    expect(await transfer(asAdmin, ids.studentA, olga)).toEqual({
      student_id: ids.studentA.id, from_coach_id: olga.id, to_coach_id: olga.id, link_moved: false, goals_moved: 1,
    });
    expect({ goals: await goalsRead(olga), attempts: await attemptsRead(olga) }).toEqual({ goals: 2, attempts: 3 });
    // A second time: nothing left to do.
    expect(await transfer(asAdmin, ids.studentA, olga)).toMatchObject({ link_moved: false, goals_moved: 0 });
  }));

  it('refuses a coach who is not one, an athlete who has no link, the same profile twice, and an id that is nobody — and moves nothing', () => scenario(async (q) => {
    const before = await q.rows(`select id, coach_id from students order by id`);
    const beforeGoals = await q.rows(`select id, coach_id from goals order by id`);
    const tried = (athlete, coach) => attempt(() => transfer(asAdmin, athlete, coach));

    const toAnAthlete = await tried(ids.studentA, ids.studentB);
    expect(toAnAthlete.error?.message).toBe(NOT_A_COACH(ids.studentB.id));
    expect(toAnAthlete.error.code).toBe('23514');
    expect((await tried(ids.studentA, una)).error?.message).toBe(NOT_A_COACH(una.id));
    expect((await tried(ids.studentA, ids.studentA)).error?.message).toBe(OWN_COACH(ids.studentA.id));

    const noLink = await tried(una, olga);
    expect(noLink.error?.message).toBe(NO_LINK(una.id));
    expect(noLink.error.code).toBe('P0002');
    // A coach is nobody's athlete.
    expect((await tried(ids.coach, olga)).error?.message).toBe(NO_LINK(ids.coach.id));

    const nobody = '00000000-0000-4000-8000-00000000dead';
    expect((await tried(nobody, olga)).error?.message).toBe(NO_LINK(nobody));
    const toNobody = await tried(ids.studentA, nobody);
    expect(toNobody.error?.code).toBe('23503');
    expect(toNobody.error.constraint).toBe('students_coach_id_fkey');

    // An e-mail address that is not an account gives no id.
    for (const [athlete, coach] of [[null, olga.id], [ids.studentA.id, null], [null, null]]) {
      const missing = await tried(athlete, coach);
      expect(missing.error?.message).toBe('transfer_student needs the profile id of the athlete and of the new coach');
      expect(missing.error.code).toBe('22004');
    }

    expect(await q.rows(`select id, coach_id from students order by id`)).toEqual(before);
    expect(await q.rows(`select id, coach_id from goals order by id`)).toEqual(beforeGoals);
  }));

  it('no signed-in user may call it, nor a request without a session: no EXECUTE', () => scenario(async (q) => {
    for (const who of [ids.coach, olga, ids.studentA, una]) {
      const tried = await attempt(() => transfer((fn) => asUser(who, fn), ids.studentA, olga));
      expect(tried.error?.message, who.email).toBe(NO_EXECUTE);
      expect(tried.error.code).toBe('42501');
      expect(toastOf(tried.error)).toBe('errors.notAllowed');
    }
    const anonymous = await attempt(() => transfer(asAnon, ids.studentA, olga));
    expect(anonymous.error?.message).toBe(NO_EXECUTE);
    expect(await linkOf(q, ids.studentA)).toBe(ids.coach.id);
    expect(await q.one(
      `select has_function_privilege('authenticated', 'public.transfer_student(uuid, uuid)', 'EXECUTE') as users,
              has_function_privilege('anon', 'public.transfer_student(uuid, uuid)', 'EXECUTE')          as anon,
              has_function_privilege('service_role', 'public.transfer_student(uuid, uuid)', 'EXECUTE')  as service`,
    )).toEqual({ users: false, anon: false, service: true });
  }));

  // The grant is one line of SQL away. Behind it: the function's own first
  // lines, then the gate on the link (migration 05), then row-level security —
  // the function runs with the rights of its caller, and has none of its own.
  it('with EXECUTE granted by mistake, a signed-in user is still refused — the coach who gives, the one who takes, the athlete', () => scenario(async (q) => {
    await q(`grant execute on function public.transfer_student(uuid, uuid) to authenticated`);
    for (const who of [ids.coach, olga, ids.studentA]) {
      const tried = await attempt(() => transfer((fn) => asUser(who, fn), ids.studentA, olga));
      expect(tried.error?.message, who.email).toBe(NOT_FROM_THE_APP);
      expect(tried.error.code).toBe('42501');
      expect(tried.error.hint).toBe('transfer_student is called from the SQL editor or with the service-role key.');
    }
    // A token of the API's role that names no user: the first lines let it
    // through, and it reaches no link — it reads the table as nobody.
    const noUser = await attempt(() => transfer(
      (fn) => asUser(ids.coach, fn, { claims: { sub: undefined } }), ids.studentA, olga,
    ));
    expect(noUser.error?.message).toBe(NO_LINK(ids.studentA.id));
    expect(await linkOf(q, ids.studentA)).toBe(ids.coach.id);
    expect(await q.value(`select coach_id from goals where id = $1`, [goals.a])).toBe(ids.coach.id);
  }));

  it('a function that runs as its owner inside a user\'s request does not get it through either', () => scenario(async (q) => {
    await q(
      `create function public.transfer_probe(p_student uuid, p_coach uuid) returns jsonb
         language sql security definer set search_path = public, pg_temp
         as $$ select public.transfer_student(p_student, p_coach) $$`,
    );
    await q(`grant execute on function public.transfer_probe(uuid, uuid) to authenticated`);
    const tried = await attempt(() => asUser(olga, (coach) => coach.value(
      `select public.transfer_probe($1, $2)`, [ids.studentA.id, olga.id],
    )));
    expect(tried.error?.message).toBe(NOT_FROM_THE_APP);
    expect(await linkOf(q, ids.studentA)).toBe(ids.coach.id);
  }));

  // What the page of migration 07 sends its reader here for: a coach stops
  // being one once their athletes have gone to another coach — not before,
  // and not by deleting their links.
  it('once her athletes have moved, a coach can be made an athlete again — and be given a coach', () => scenario(async (q) => {
    const stepDown = () => attempt(() => q.value(`update profiles set role = 'student' where id = $1 returning role`, [ids.coach.id]));
    expect((await stepDown()).error?.message)
      .toBe(`profile ${ids.coach.id} (Coach Carla) cannot stop being a coach: it has 2 athlete(s)`);
    await transfer(asAdmin, ids.studentA, olga);
    expect((await stepDown()).error?.message)
      .toBe(`profile ${ids.coach.id} (Coach Carla) cannot stop being a coach: it has 1 athlete(s)`);
    await transfer(asAdmin, ids.studentB, olga);
    expect((await stepDown()).value).toBe('student');
    await q(`insert into students (profile_id, coach_id) values ($1, $2)`, [ids.coach.id, olga.id]);
    expect(await asUser(olga, (coach) => coach.value(`select count(*) from students`))).toBe(4);
    // No goal names her any more: they went with the athletes.
    expect(await q.value(`select count(*) from goals where coach_id = $1`, [ids.coach.id])).toBe(0);
  }));

  // "Removing a coach's account", on the page: moving the athletes takes the
  // link and the goals out of the way, not the exercises.
  it('once her athletes have moved, a coach\'s account is still held by the exercises their programs use', () => scenario(async (q) => {
    await transfer(asAdmin, ids.studentA, olga);
    await transfer(asAdmin, ids.studentB, olga);
    const before = await census(q);
    const removal = await attempt(() => q(`delete from auth.users where id = $1`, [ids.coach.id]));
    expect(removal.error?.code).toBe('23503');
    expect(['exercise_slots_exercise_id_fkey', 'goals_exercise_id_fkey']).toContain(removal.error.constraint);
    expect(await census(q)).toEqual(before);
  }));
});

// ============================================================
// The migration file, on what production has
// ============================================================
describe('migration 10 applied to the production baseline', () => {
  const COACH = '00000000-0000-4000-8000-00000000c0ac';
  const OLGA = '00000000-0000-4000-8000-00000000c0b0';
  const ATHLETE = '00000000-0000-4000-8000-0000000000a1';
  const FREE = '00000000-0000-4000-8000-0000000000a2';
  const LINK = '00000000-0000-4000-8000-000000000101';
  const PULL_UP = '00000000-0000-4000-8000-000000000201';
  const SQUAT = '00000000-0000-4000-8000-000000000202';
  const LEVER = '00000000-0000-4000-8000-000000000203';
  const ROW = '00000000-0000-4000-8000-000000000204';
  const PROGRAM = '00000000-0000-4000-8000-000000000301';
  const SESSION = '00000000-0000-4000-8000-000000000451';
  const GOAL = '00000000-0000-4000-8000-000000000601';
  const TO_COME = '2099_01_01_99_a_migration_to_come';

  // Two coaches, an athlete of the first with a block of one session, and an
  // account nobody coaches. The first coach's library: the pull-up of that
  // session, the squat — in no program, with a goal for the athlete and two
  // attempts — and a lever nothing names. The second coach has one exercise,
  // no athlete and no goal. The roles are set the way a dump restore sets
  // them: on the baseline the documented `update profiles set role = 'coach'`
  // is undone for every caller (finding P20, closed by migration 07).
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
    insert into public.students (id, profile_id, coach_id) values ('${LINK}', '${ATHLETE}', '${COACH}');
    insert into public.exercise_library (id, coach_id, name, type, difficulty) values
      ('${PULL_UP}', '${COACH}', 'Pull-up', 'pull', 2),
      ('${SQUAT}',   '${COACH}', 'Squat',   'push', 1),
      ('${LEVER}',   '${COACH}', 'Lever',   'pull', 3),
      ('${ROW}',     '${OLGA}',  'Row',     'pull', 1);
    insert into public.programs (id, student_id, name, is_active)
      values ('${PROGRAM}', '${LINK}', 'Block', true);
    insert into public.weeks (id, program_id, week_number)
      values ('00000000-0000-4000-8000-000000000401', '${PROGRAM}', 1);
    insert into public.sessions (id, week_id, title, sort_order)
      values ('${SESSION}', '00000000-0000-4000-8000-000000000401', 'S1', 0);
    insert into public.exercise_slots (id, session_id, exercise_id, sets, reps, sort_order)
      values ('00000000-0000-4000-8000-000000000501', '${SESSION}', '${PULL_UP}', 3, 5, 0);
    insert into public.goals (id, student_id, coach_id, exercise_id, kind, target_weight_kg)
      values ('${GOAL}', '${ATHLETE}', '${COACH}', '${SQUAT}', 'one_rm', 100);
    insert into public.goal_progress (goal_id, weight_kg, reps) values ('${GOAL}', 80, 1), ('${GOAL}', 85, 1);
    insert into public.messages (sender_id, recipient_id, body) values
      ('${COACH}', '${ATHLETE}', 'Welcome.'), ('${ATHLETE}', '${COACH}', 'Thanks.');
  `;

  /** The frozen baseline with that world in it and the migrations before 10 applied. */
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

  // One transaction, always undone. Each step is a statement, or an actor:
  // from there on the statements are a request of that user of the API, role
  // and claims set the way PostgREST sets them. Before the first actor they
  // are the owner's — the SQL editor. The answer is the first value of the
  // last statement, or the message of the statement that raised.
  const user = (sub) => ({ role: 'authenticated', claims: { role: 'authenticated', sub } });
  const THE_COACH = user(COACH);
  const THE_OTHER_COACH = user(OLGA);
  const THE_ATHLETE = user(ATHLETE);
  const story = async (db, ...steps) => {
    const statements = steps.map((step) => (typeof step === 'string' ? step
      : `select set_config('role', '${step.role}', true), set_config('request.jwt.claims', '${JSON.stringify(step.claims)}', true)`));
    const tried = await attempt(() => db.runSql(`BEGIN;\n${statements.join(';\n')};\nROLLBACK;`, 'request'));
    if (!tried.ok) return (tried.error.cause ?? tried.error).message;
    const [found] = tried.value.at(-2).rows;
    return found ? Object.values(found)[0] : null;
  };

  // The findings.
  const deleteSquat = `delete from public.exercise_library where id = '${SQUAT}'`;
  const attemptsLeft = `select count(*) from public.goal_progress`;
  const linksLeft = `select count(*) from public.students`;
  const goalsLeft = `select count(*) from public.goals`;
  const deleteCoach = `delete from auth.users where id = '${COACH}'`;
  const noSlots = `delete from public.exercise_slots`;
  const moveByHand = `update public.students set coach_id = '${OLGA}' where id = '${LINK}'`;
  const moveProperly = `select public.transfer_student('${ATHLETE}', '${OLGA}')`;

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
  const [moveAthlete] = fences('sql');
  const listLeftBehind = quoted('select athlete.full_name as athlete');
  const inTheWay = quoted('select u.email, (select count(*)');
  const markRead = /`(update public\.messages m set read_at = now\(\)[^`]+)`/.exec(page)?.[1];

  const printedAudit = async (db) => {
    const [result] = await db.readOnly(read(migration.paths.audit), 'audit');
    return Object.fromEntries(result.rows.map((line) => [line.check, line.value]));
  };
  const LINE = {
    exercise: 'a library exercise that a goal is set on cannot be deleted (P18, L7)',
    coachLink: 'the profile of a coach cannot be deleted while an athlete is linked to it (B9)',
    coachGoal: '… nor while a goal names it',
    archive: 'an exercise can be archived',
    progress: 'a coach reads the progress of a goal only while they coach its athlete (P21)',
    transfer: 'an athlete is moved to another coach together with their goals (transfer_student)',
    strangers: 'policies on goal_progress that the migration does not know',
    otherCoach: 'goals whose athlete has another coach today',
    noCoach: 'goals whose athlete has no coach today',
    onlyAGoal: 'library exercises with a goal and in no program',
    archived: 'archived exercises',
    goals: 'goals',
    accounts: 'accounts',
  };
  const untouched = async (db, before) => {
    expect(diffCatalogs(before, await catalogSnapshot(db.query), { left: 'before', right: 'after' })).toEqual([]);
    expect(await db.query.value(`select count(*) from ${LEDGER} where name = $1`, [MIGRATION])).toBe(0);
  };

  it('the three findings are there before, closed after, and back after the rollback', async () => {
    const db = await production();
    const rows = () => db.query.one(
      `select (select count(*) from public.students) as links, (select count(*) from public.exercise_library) as exercises,
              (select count(*) from public.goals) as goals, (select count(*) from public.goal_progress) as attempts,
              (select count(*) from public.profiles) as profiles, (select coach_id from public.goals) as goal_of`,
    );
    const AS_IT_WAS = { links: 1, exercises: 4, goals: 1, attempts: 2, profiles: 4, goal_of: COACH };

    // Before: as the reviews traced them.
    // P18 / L7 — the coach tidies the library, and the athlete's attempts are gone.
    expect(await story(db, THE_COACH, deleteSquat, THE_ATHLETE, attemptsLeft)).toBe(0);
    // B9 — the coach's account goes, and the athlete's link — with the block under it — goes with it.
    // (Told without the slot of the block: an exercise in a session is what
    // could stand in the way before, when the DELETE happened to reach the
    // library first.)
    expect(await story(db, noSlots, deleteCoach, linksLeft)).toBe(0);
    expect(await story(db, noSlots, deleteCoach, `select count(*) from public.programs`)).toBe(0);
    expect(await story(db, noSlots, deleteCoach, THE_ATHLETE, attemptsLeft)).toBe(0);
    // P21 — the athlete has another coach, and the former one reads on.
    expect(await story(db, moveByHand, THE_COACH, attemptsLeft)).toBe(2);
    expect(await story(db, THE_OTHER_COACH, moveProperly)).toBe('function public.transfer_student(unknown, unknown) does not exist');

    await db.runFile(migration.paths.migration);

    expect(await story(db, THE_COACH, deleteSquat, THE_ATHLETE, attemptsLeft))
      .toBe(FK('exercise_library', 'goals_exercise_id_fkey', 'goals'));
    // …which the deployed app shows with the sentence the page quotes.
    const inUse = /\binUse: '([^']+)'/.exec(read('src/lib/i18n/en.js'))?.[1];
    expect(inUse).toBeTruthy();
    expect(page).toContain(`sees *${inUse}*`);
    // The message names the first thing in the way: the link, the goal, or an
    // exercise of the coach's library that a session or a goal uses.
    const REFUSED = /^update or delete on table "(profiles|exercise_library)" violates foreign key constraint "(students_coach_id|goals_coach_id|goals_exercise_id|exercise_slots_exercise_id)_fkey" on table "\w+"$/;
    expect(await story(db, deleteCoach, linksLeft)).toMatch(REFUSED);
    expect(await story(db, noSlots, deleteCoach, linksLeft)).toMatch(REFUSED);
    // Each of the two foreign keys on its own: the link, with nothing else in the way…
    expect(await story(db, noSlots, `delete from public.goals`, deleteCoach, linksLeft))
      .toBe(FK('profiles', 'students_coach_id_fkey', 'students'));
    // …and a goal that names the coach, on another library's exercise, once the link is gone.
    expect(await story(db, `delete from public.students`, `update public.goals set exercise_id = '${ROW}'`, deleteCoach, goalsLeft))
      .toBe(FK('profiles', 'goals_coach_id_fkey', 'goals'));
    expect(await story(db, moveByHand, THE_COACH, attemptsLeft)).toBe(0);
    // Moved properly: the new coach reads them, the former one does not.
    expect(await story(db, moveProperly, THE_COACH, attemptsLeft)).toBe(0);
    expect(await story(db, moveProperly, THE_OTHER_COACH, attemptsLeft)).toBe(2);
    expect(await story(db, moveProperly, THE_ATHLETE, attemptsLeft)).toBe(2);
    expect(await story(db, moveProperly)).toEqual({
      student_id: ATHLETE, from_coach_id: COACH, to_coach_id: OLGA, link_moved: true, goals_moved: 1,
    });
    // …by the owner. Not by the coach who takes, the coach who gives or the athlete.
    for (const actor of [THE_OTHER_COACH, THE_COACH, THE_ATHLETE]) {
      expect(await story(db, actor, moveProperly)).toBe(NO_EXECUTE);
    }

    // The app that is deployed today, as the coach and as the athlete: as before.
    expect(await story(db, THE_COACH, attemptsLeft)).toBe(2);
    expect(await story(db, THE_ATHLETE, attemptsLeft)).toBe(2);
    expect(await story(db, THE_OTHER_COACH, attemptsLeft)).toBe(0);
    expect(await story(db, THE_COACH, `select el.name from public.goals g join public.exercise_library el on el.id = g.exercise_id`)).toBe('Squat');
    expect(await story(db, THE_ATHLETE, `insert into public.goal_progress (goal_id, weight_kg, sets, reps, notes) values ('${GOAL}', 90, null, 1, null)`,
      THE_COACH, attemptsLeft)).toBe(3);
    expect(await story(db, THE_COACH, `insert into public.goals (student_id, coach_id, exercise_id, kind, target_weight_kg) values ('${ATHLETE}', '${COACH}', '${PULL_UP}', 'one_rm', 60) returning kind`))
      .toBe('one_rm');
    expect(await story(db, THE_COACH, `delete from public.goals where id = '${GOAL}'`, deleteSquat, `select count(*) from public.exercise_library`)).toBe(2);
    expect(await story(db, THE_COACH, `delete from public.exercise_library where id = '${LEVER}' returning name`)).toBe('Lever');
    expect(await story(db, THE_COACH, `delete from public.exercise_library where id = '${PULL_UP}'`))
      .toBe(FK('exercise_library', 'exercise_slots_exercise_id_fkey', 'exercise_slots'));
    expect(await story(db, THE_ATHLETE, `select count(*) from public.exercise_library where archived_at is null`)).toBe(3);
    // A coach nobody trains under, with a library nothing uses: deleted as before.
    expect(await story(db, `delete from auth.users where id = '${OLGA}'`, `select count(*) from public.exercise_library`)).toBe(3);
    // Nothing above was kept, and the migration itself touches no row.
    expect(await rows()).toEqual(AS_IT_WAS);

    await db.runFile(migration.paths.rollback);
    expect(await story(db, THE_COACH, deleteSquat, THE_ATHLETE, attemptsLeft)).toBe(0);
    expect(await story(db, noSlots, deleteCoach, linksLeft)).toBe(0);
    expect(await story(db, moveByHand, THE_COACH, attemptsLeft)).toBe(2);
    expect(await rows()).toEqual(AS_IT_WAS);
    await db.drop();
  });

  it('re-creates 3 foreign keys, adds 1 column and 1 function, replaces 1 function body, signs the ledger — no policy, no trigger, no privilege of what was there', async () => {
    const db = await production();
    const before = await catalogSnapshot(db.query);
    await db.runFile(migration.paths.migration);
    const after = await catalogSnapshot(db.query);

    const lines = diffCatalogs(before, after, { left: 'before', right: 'after' });
    const only = (side) => lines.filter((line) => line.endsWith(`: only in ${side}`))
      .map((line) => line.slice(0, -`: only in ${side}`.length));
    const TRANSFER = 'public.transfer_student(p_student uuid, p_new_coach uuid)';
    const HELPER = 'public.coach_profile_for_goal(g uuid)';
    expect(only('after')).toEqual([
      'columns public.exercise_library.archived_at',
      `functions ${TRANSFER}`,
      'comments table column public.exercise_library.archived_at',
    ]);
    expect(only('before')).toEqual([]);
    const changed = lines.filter((line) => !/: only in (before|after)$/.test(line))
      .map((line) => /^(.*?): (\w+): /.exec(line).slice(1, 3).join(' → '));
    expect(changed).toEqual([
      'constraints public.goals.goals_coach_id_fkey → definition',
      'constraints public.goals.goals_exercise_id_fkey → definition',
      'constraints public.students.students_coach_id_fkey → definition',
      `functions ${HELPER} → definition`,
      'data rows of app_private.app_migrations → rows',
    ]);

    // The three foreign keys: the same name, the same columns, validated — and
    // what they do on DELETE.
    for (const [key, columns] of [
      ['public.goals.goals_exercise_id_fkey', 'FOREIGN KEY (exercise_id) REFERENCES exercise_library(id)'],
      ['public.goals.goals_coach_id_fkey', 'FOREIGN KEY (coach_id) REFERENCES profiles(id)'],
      ['public.students.students_coach_id_fkey', 'FOREIGN KEY (coach_id) REFERENCES profiles(id)'],
    ]) {
      expect(before.constraints[key], key).toMatchObject({ definition: `${columns} ON DELETE CASCADE`, validated: true });
      expect(after.constraints[key], key).toMatchObject({ definition: `${columns} ON DELETE RESTRICT`, validated: true });
    }
    // The athlete's end of the link and of a goal, and the attempts under a goal: as they were.
    for (const key of ['public.students.students_profile_id_fkey', 'public.goals.goals_student_id_fkey',
      'public.goal_progress.goal_progress_goal_id_fkey']) {
      expect(after.constraints[key].definition, key).toMatch(/ ON DELETE CASCADE$/);
    }
    expect(after.columns['public.exercise_library.archived_at'])
      .toMatchObject({ type: 'timestamp with time zone', not_null: false, default: null });

    // The helper: up to its body, the function it was — what the policy that
    // calls it and PostgREST know of it.
    const header = (snapshot, key) => snapshot.functions[key].definition.split(/\nAS /)[0];
    expect(header(after, HELPER)).toBe(header(before, HELPER));
    expect(header(after, HELPER)).toContain('SECURITY DEFINER');
    expect(after.functions[HELPER].privileges).toEqual(['authenticated: EXECUTE', 'postgres: EXECUTE', 'service_role: EXECUTE']);
    expect(after.functions[HELPER].privileges).toEqual(before.functions[HELPER].privileges);
    // transfer_student: its owner and the service role, with the rights of whoever calls.
    expect(after.functions[TRANSFER].privileges).toEqual(['postgres: EXECUTE', 'service_role: EXECUTE']);
    expect(after.functions[TRANSFER].owner).toBe('postgres');
    expect(header(after, TRANSFER)).not.toContain('SECURITY DEFINER');
    for (const key of [HELPER, TRANSFER]) {
      expect(header(after, key), key).toContain(`\n SET search_path TO 'public', 'pg_temp'`);
    }
    // The ledger, as the page says it reads.
    expect(await db.query.rows(`select name from ${LEDGER} order by name`)).toHaveLength(10);
    expect(await db.query.value(`select name from ${LEDGER} order by name desc limit 1`)).toBe(MIGRATION);
    expect(page).toContain(`Expected: ten rows, the last one \`${MIGRATION}\`.`);
    expect(page).toContain('| Kind | required · re-creates 3 foreign keys, adds 1 column and 1 function, replaces 1 function body; no policy, no trigger, no row |');
    // The two policies of goal_progress are the ones from before, to the letter.
    for (const key of ['public.goal_progress.Coaches read goal progress for their students',
      'public.goal_progress.Students manage own goal progress']) {
      expect(after.policies[key], key).toBeTruthy();
      expect(after.policies[key], key).toEqual(before.policies[key]);
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
    expect(rows.map((line) => line.n)).toEqual(Array.from({ length: 17 }, (_, i) => i + 1));
    // Written between back-ticks: a value the page gives exactly. The others
    // are sentences about what production holds.
    const exact = rows.filter((line) => /^`.+`$/.test(line.before) && /^`.+`$/.test(line.after))
      .map((line) => ({ ...line, before: line.before.slice(1, -1), after: line.after.slice(1, -1) }));
    expect(rows.filter((line) => !exact.some((e) => e.n === line.n)).map((line) => line.check))
      .toEqual([LINE.onlyAGoal, LINE.goals, LINE.accounts]);
    const onPage = (column) => [
      ...exact.map((line) => [line.n, line.check, line[column]]),
      [14, LINE.onlyAGoal, '1'],
      [16, LINE.goals, '1 goal(s) on 1 exercise(s), with 2 logged attempt(s)'],
      [17, LINE.accounts, '2 coach(es), 1 athlete(s) with a coach'],
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
    await db.runFile(migration.paths.rollback);
    expect(await printed()).toEqual(onPage('before'));
    await db.drop();
  });

  it('the page\'s check answers NOT PROTECTED before and protected after — and writes nothing either way', async () => {
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
              (select count(*) from public.students) as links, (select count(*) from public.exercise_library) as exercises,
              (select count(*) from public.goals) as goals, (select count(*) from public.goal_progress) as attempts,
              (select coach_id from public.students) as coach, current_user::text as role,
              coalesce(current_setting('request.jwt.claims', true), '') as claims`,
    );
    const UNTOUCHED = { accounts: 4, profiles: 4, links: 1, exercises: 4, goals: 1, attempts: 2, coach: COACH, role: 'postgres', claims: '' };
    const PROTECTED = 'check only, nothing was written: protected: an exercise with a goal and a coach with an athlete are not deleted, '
      + 'and after a move the attempts are read by the athlete and the new coach, not by the former one';
    const answer = (said) => `check only, nothing was written: ${said}`;

    expect(await checked()).toBe(answer('NOT PROTECTED: a library exercise was deleted, and the goal set on it with it'));
    expect(await state()).toEqual(UNTOUCHED);

    await db.runFile(migration.paths.migration);
    expect(await checked()).toBe(PROTECTED);
    expect(await state()).toEqual(UNTOUCHED);
    // What the page says the command prints.
    expect(page).toContain(`\`${PROTECTED}\``);
    expect(page).toContain('`… NOT PROTECTED: a library exercise was deleted, and the goal set on it with it`');

    // Each rule taken away by hand, one at a time: the answer nobody wants.
    const coachKeys = (action) => db.query(`alter table public.students drop constraint students_coach_id_fkey,
        add constraint students_coach_id_fkey foreign key (coach_id) references public.profiles(id) on delete ${action};
      alter table public.goals drop constraint goals_coach_id_fkey,
        add constraint goals_coach_id_fkey foreign key (coach_id) references public.profiles(id) on delete ${action}`);
    await coachKeys('cascade');
    expect(await checked()).toBe(answer('NOT PROTECTED: the profile of a coach was deleted while an athlete was linked to it'));
    await coachKeys('restrict');
    expect(await checked()).toBe(PROTECTED);

    // A second policy on the attempts, which shows them to every coach.
    await db.query(`create policy "Coaches read every attempt" on public.goal_progress for select
      using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'coach'))`);
    expect(await checked()).toBe(answer('NOT PROTECTED: the former coach still reads the progress of an athlete who moved'));
    await db.query(`drop policy "Coaches read every attempt" on public.goal_progress`);
    expect(await checked()).toBe(PROTECTED);

    // The helper answering nobody: the new coach reads nothing, and the check says BROKEN.
    await db.query(`create or replace function public.coach_profile_for_goal(g uuid) returns uuid
      language sql security definer stable set search_path = public, pg_temp as $$ select null::uuid $$`);
    expect(await checked()).toBe(answer('BROKEN: after the move the new coach reads 0 attempt(s) and the athlete 1, of 1'));
    expect(page).toContain('- `… BROKEN: …` — after a move, the new coach or the athlete does not read the attempts: **roll back**, and report.');
    expect(await state()).toEqual(UNTOUCHED);
    await db.drop();
  });

  it('where nobody can be made a coach, the page\'s check says NOT TRIED', async () => {
    const db = await production();
    await db.runFile(migration.paths.migration);
    // Migration 07 undone by hand: the role is put back for every caller.
    await db.query(`create or replace function public.profiles_pin_immutable_columns() returns trigger
      language plpgsql set search_path = public, pg_temp as $$ begin NEW.role := OLD.role; return NEW; end $$`);
    const tried = await attempt(() => db.runSql(pageCheck, 'page check'));
    expect((tried.error.cause ?? tried.error).message)
      .toBe('check only, nothing was written: NOT TRIED: the accounts made for the check could not be made coaches');
    expect(page).toContain('- `… NOT TRIED: the accounts made for the check could not be made coaches` — migration 07 is not in the database');
    expect(await db.query.value(`select count(*) from auth.users`)).toBe(4);
    await db.drop();
  });

  // "Moving an athlete to another coach": the statement the page gives and
  // the answers of its table.
  it('from the SQL editor: the page\'s statement moves an athlete with their goals, and answers what the page says otherwise', async () => {
    const db = await production();
    await db.runFile(migration.paths.migration);
    expect(moveAthlete, 'the page no longer gives the statement').toContain('public.transfer_student(athlete.id, coach.id)');
    const run = (athlete, coach) => attempt(() => db.query.rows(
      moveAthlete.replace('<e-mail of the athlete>', athlete).replace('<e-mail of the new coach>', coach),
    ));
    const linkedTo = () => db.query.value(`select coach_id from public.students where id = '${LINK}'`);

    // The answers that move nothing.
    expect((await run('nobody@sl.test', 'olga@sl.test')).value).toEqual([]);
    expect((await run('alex@sl.test', 'nobody@sl.test')).value).toEqual([]);
    expect((await run('alex@sl.test', 'una@sl.test')).error?.message).toBe(NOT_A_COACH(FREE));
    expect(page).toContain('| `students.coach_id … is not a coach: its profile has the role student` |');
    expect((await run('una@sl.test', 'olga@sl.test')).error?.message).toBe(NO_LINK(FREE));
    expect(page).toContain('| `profile … is not the athlete of a coach: there is no link to move` |');
    expect((await run('alex@sl.test', 'alex@sl.test')).error?.message).toBe(OWN_COACH(ATHLETE));
    expect(page).toContain('| `students: profile … cannot be its own coach` |');
    // Run as a user of the app — the editor's role selector — it does not get as far as an account.
    for (const actor of [THE_COACH, THE_OTHER_COACH, THE_ATHLETE]) {
      expect(await story(db, actor, moveAthlete.replace('<e-mail of the athlete>', 'alex@sl.test')
        .replace('<e-mail of the new coach>', 'olga@sl.test').replace(/;\s*$/, ''))).toBe('permission denied for table users');
    }
    expect(page).toContain('| `permission denied for table users` | the SQL editor is not running as `postgres`');
    expect(await linkedTo()).toBe(COACH);

    // One row, with the link moved and the goal with it.
    expect((await run('alex@sl.test', 'olga@sl.test')).value).toEqual([{
      athlete: 'alex@sl.test',
      new_coach: 'olga@sl.test',
      moved: { student_id: ATHLETE, from_coach_id: COACH, to_coach_id: OLGA, link_moved: true, goals_moved: 1 },
    }]);
    expect(page).toContain('Under `moved`: `"link_moved": true`, and under `goals_moved` the number of goals that went to the new coach.');
    expect(await linkedTo()).toBe(OLGA);
    // "The new coach sees the athlete … with their programs, their history
    // and their goals. The former coach no longer sees any of it."
    const sees = (actor) => story(db, actor,
      `select (select count(*) from public.students) || ' athlete, ' || (select count(*) from public.programs) || ' block, '
              || (select count(*) from public.goals) || ' goal, ' || (select count(*) from public.goal_progress) || ' attempts'`);
    expect(await sees(THE_OTHER_COACH)).toBe('1 athlete, 1 block, 1 goal, 2 attempts');
    expect(await sees(THE_COACH)).toBe('0 athlete, 0 block, 0 goal, 0 attempts');
    expect(await sees(THE_ATHLETE)).toBe('1 athlete, 1 block, 1 goal, 2 attempts');

    // A second time: `"link_moved": false`, and nothing left to hand over.
    expect((await run('alex@sl.test', 'olga@sl.test')).value[0].moved).toMatchObject({ link_moved: false, goals_moved: 0 });
    expect(page).toContain('| `"link_moved": false` | the athlete was already with this coach.');

    // "What the move leaves where it was": the exercises, and the conversation.
    expect(await story(db, THE_OTHER_COACH, `select count(*) from public.exercise_library where coach_id = '${COACH}'`)).toBe(0);
    expect(await story(db, THE_ATHLETE, `select count(*) from public.exercise_library where coach_id = '${COACH}'`)).toBe(0);
    expect(page).toContain('**Before Checkpoint C1, move only an athlete who has no program yet.**');
    // The goal keeps its exercise, which the new coach and the athlete read without its name
    // (useStudentGoals and useMyGoals embed it: the embed comes back empty).
    const goalWithExercise = `select g.id::text || ' on ' || coalesce(el.name, '(no name)')
      from public.goals g left join public.exercise_library el on el.id = g.exercise_id`;
    expect(await story(db, THE_OTHER_COACH, goalWithExercise)).toBe(`${GOAL} on (no name)`);
    expect(await story(db, THE_ATHLETE, goalWithExercise)).toBe(`${GOAL} on (no name)`);
    expect(page).toContain('show it without its name to the athlete and to the new coach');
    const unread = () => story(db, THE_ATHLETE, `select count(*) from public.messages where recipient_id = '${ATHLETE}' and read_at is null`);
    expect(await unread()).toBe(1);
    expect(markRead, 'the page no longer gives the statement').toBeTruthy();
    const marked = await db.query(markRead.replace('<e-mail of the athlete>', 'alex@sl.test').replace('<e-mail of the former coach>', 'coach@sl.test'));
    expect(marked.rowCount).toBe(1);
    expect(await unread()).toBe(0);
    // The athlete's own message to the former coach is not touched: it is that coach's to open.
    expect(await db.query.value(`select count(*) from public.messages where recipient_id = '${COACH}' and read_at is null`)).toBe(1);

    // "Removing a coach's account": what is in the way, before and after the move.
    expect(inTheWay, 'the page no longer gives the statement').toBeTruthy();
    const standsInTheWay = (address) => db.query.rows(inTheWay.replace('<e-mail of the coach>', address));
    expect(await standsInTheWay('coach@sl.test')).toEqual([{ email: 'coach@sl.test', athletes: 0, goals: 0, exercises_in_use: 2 }]);
    expect(await standsInTheWay('olga@sl.test')).toEqual([{ email: 'olga@sl.test', athletes: 1, goals: 1, exercises_in_use: 0 }]);
    expect(await story(db, deleteCoach, linksLeft)).toMatch(/violates foreign key constraint "(exercise_slots|goals)_exercise_id_fkey"/);
    expect(await story(db, `delete from auth.users where id = '${OLGA}'`, linksLeft))
      .toMatch(/^update or delete on table "profiles" violates foreign key constraint "(students|goals)_coach_id_fkey"/);
    await db.drop();
  });

  // Lines 12 and 13 of the audit, and "Goals left with a former coach".
  it('goals left with a former coach: counted, hidden from that coach by the migration, handed over with the page\'s statements', async () => {
    const db = await production();
    // A link rewritten by hand before the migration: the goal stays with Carla.
    await db.query(moveByHand);
    expect(await printedAudit(db)).toMatchObject({ [LINE.otherCoach]: '1', [LINE.noCoach]: '0', [LINE.progress]: 'no' });
    expect(await story(db, THE_COACH, attemptsLeft)).toBe(2);

    await db.runFile(migration.paths.migration);
    expect(await printedAudit(db)).toMatchObject({ [LINE.otherCoach]: '1', [LINE.noCoach]: '0', [LINE.progress]: 'yes' });
    // "From the migration on, the athlete still reads them and logs against
    // them, and no coach reads them or their attempts."
    expect(await story(db, THE_COACH, attemptsLeft)).toBe(0);
    expect(await story(db, THE_OTHER_COACH, attemptsLeft)).toBe(0);
    expect(await story(db, THE_ATHLETE, `insert into public.goal_progress (goal_id, weight_kg) values ('${GOAL}', 90)`, attemptsLeft)).toBe(3);
    expect(page).toContain('From the migration on, the athlete still reads them and logs against them, and no coach reads them or their attempts.');

    expect(listLeftBehind, 'the page no longer gives the statement').toBeTruthy();
    expect(await db.query.rows(listLeftBehind)).toEqual([{ athlete: 'Alex', set_by: 'Coach Carla', coach_today: 'Coach Olga', goals: 1 }]);

    // The hand-over: the statement of "Moving an athlete", with the coach of today.
    const handOver = () => db.query.rows(
      moveAthlete.replace('<e-mail of the athlete>', 'alex@sl.test').replace('<e-mail of the new coach>', 'olga@sl.test'),
    );
    expect((await handOver())[0].moved).toMatchObject({ from_coach_id: OLGA, to_coach_id: OLGA, link_moved: false, goals_moved: 1 });
    expect(await story(db, THE_OTHER_COACH, attemptsLeft)).toBe(2);
    expect(await story(db, THE_COACH, attemptsLeft)).toBe(0);
    expect(await db.query.rows(listLeftBehind)).toEqual([]);
    expect(await printedAudit(db)).toMatchObject({ [LINE.otherCoach]: '0', [LINE.noCoach]: '0' });

    // An athlete whose link was removed: line 13, and an empty `coach_today`.
    await db.query(`delete from public.students where id = '${LINK}'`);
    expect(await printedAudit(db)).toMatchObject({ [LINE.otherCoach]: '0', [LINE.noCoach]: '1' });
    expect(await db.query.rows(listLeftBehind)).toEqual([{ athlete: 'Alex', set_by: 'Coach Olga', coach_today: null, goals: 1 }]);
    expect(await story(db, THE_OTHER_COACH, attemptsLeft)).toBe(0);
    expect(await story(db, THE_ATHLETE, attemptsLeft)).toBe(2);
    await db.drop();
  });

  it('without migration 09 it says so (SLM02), and its rollback says there is nothing to undo (SLM03)', async () => {
    const db = await scratchDatabase();
    await db.runFile(manifest.baseline);
    const refusals = async () => {
      const before = await catalogSnapshot(db.query);
      const refused = await attempt(() => db.runFile(migration.paths.migration));
      const undone = await attempt(() => db.runFile(migration.paths.rollback));
      expect(diffCatalogs(before, await catalogSnapshot(db.query), { left: 'before', right: 'after' })).toEqual([]);
      return [refused.error?.code, refused.error?.message, undone.error?.code];
    };
    // Without a ledger at all, then with the ledger and the migrations before 09 only.
    const needs = 'needs 2026_10_13_09_review_lifecycle, which is not applied';
    let [code, message, undone] = await refusals();
    expect([code, undone]).toEqual([REFUSAL.predecessorMissing, REFUSAL.notApplied]);
    expect(message).toContain(needs);
    for (const earlier of manifest.migrations.slice(0, 8)) await db.runFile(earlier.paths.migration);
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
    await untouched(db, before);
    await db.drop();
  });

  it('refuses to run when one of its functions exists with other arguments, and changes nothing', async () => {
    const db = await production();
    const refusal = async () => {
      const before = await catalogSnapshot(db.query);
      const refused = await attempt(() => db.runFile(migration.paths.migration));
      await untouched(db, before);
      return refused.error?.message ?? 'it ran';
    };
    // A transfer_student made by hand, keyed on the students row: it would stay next to the new one.
    await db.query(`create function public.transfer_student(p_row uuid, p_coach uuid, p_note text) returns void language sql as 'select'`);
    expect(await refusal()).toContain(`migration ${MIGRATION} would not replace: transfer_student(uuid,uuid,text)`);
    await db.query(`drop function public.transfer_student(uuid, uuid, text)`);

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

  // The foreign keys are dropped and re-created by name. One that is not
  // there under its name, or a second one on the same column, would leave a
  // CASCADE behind a migration that says it is gone.
  it('refuses to run when a foreign key is not the one it expects, or is not the only one on its column', async () => {
    const db = await production();
    const refusal = async () => {
      const before = await catalogSnapshot(db.query);
      const refused = await attempt(() => db.runFile(migration.paths.migration));
      await untouched(db, before);
      return refused.error?.message ?? 'it ran';
    };
    const says = (what) => `migration ${MIGRATION} does not find the foreign keys it rewrites: ${what}`;

    await db.query(`alter table public.goals rename constraint goals_exercise_id_fkey to goals_exercise_fk`);
    expect(await refusal()).toContain(says('public.goals.exercise_id: its foreign key is goals_exercise_fk, not goals_exercise_id_fkey to public.exercise_library'));
    await db.query(`alter table public.goals rename constraint goals_exercise_fk to goals_exercise_id_fkey`);

    await db.query(`alter table public.students add constraint students_coach_again foreign key (coach_id) references public.profiles(id) on delete cascade`);
    expect(await refusal()).toContain(says('public.students.coach_id: 2 foreign keys (students_coach_again, students_coach_id_fkey)'));
    // The audit sees the second one too: the line reads `no` as long as one of them cascades.
    await db.query(`alter table public.students drop constraint students_coach_id_fkey`);
    expect(await refusal()).toContain(says('public.students.coach_id: its foreign key is students_coach_again, not students_coach_id_fkey to public.profiles'));
    await db.query(`alter table public.students drop constraint students_coach_again`);
    expect(await refusal()).toContain(says('public.students.coach_id: no foreign key'));
    expect(page).toContain('| `does not find the foreign keys it rewrites: …` |');

    await db.query(`alter table public.students add constraint students_coach_id_fkey foreign key (coach_id) references public.profiles(id) on delete cascade`);
    await db.query(`alter table public.exercise_library add column archived_at timestamptz`);
    expect(await refusal()).toContain(`migration ${MIGRATION}: public.exercise_library already has a column archived_at`);
    expect(page).toContain('| `already has a column archived_at` |');
    await db.query(`alter table public.exercise_library drop column archived_at`);

    await db.runFile(migration.paths.migration);
    expect(await printedAudit(db)).toMatchObject({ [LINE.exercise]: 'yes', [LINE.coachLink]: 'yes', [LINE.coachGoal]: 'yes' });
    // After the migration: a foreign key that cascades, added next to the right one, turns the line back to `no`.
    await db.query(`alter table public.students add constraint students_coach_again foreign key (coach_id) references public.profiles(id) on delete cascade`);
    expect(await printedAudit(db)).toMatchObject({ [LINE.exercise]: 'yes', [LINE.coachLink]: 'no', [LINE.coachGoal]: 'yes' });
    await db.drop();
  });

  // Policies add up: one made by hand, under another name, keeps showing the
  // attempts to whoever it names. Line 11 of the audit, and the page.
  it('undoes itself when a policy made by hand would go on showing the attempts', async () => {
    const db = await production();
    await db.query(`create policy "Whoever set the goal reads its progress" on public.goal_progress for select
      using (exists (select 1 from public.goals g where g.id = goal_progress.goal_id and g.coach_id = auth.uid()))`);
    expect(await printedAudit(db)).toMatchObject({ [LINE.strangers]: 'Whoever set the goal reads its progress' });

    const before = await catalogSnapshot(db.query);
    const refused = await attempt(() => db.runFile(migration.paths.migration));
    expect(refused.error?.message).toContain(
      `migration ${MIGRATION} did not get the policies it meant: public.goal_progress has the policy `
      + '"Whoever set the goal reads its progress", which this migration does not know',
    );
    await untouched(db, before);
    expect(page).toContain('- **11** is not `none` — stop and report the line.');

    await db.query(`drop policy "Whoever set the goal reads its progress" on public.goal_progress`);
    // The coach's policy rewritten by hand without the helper: not the one meant either.
    await db.query(`drop policy "Coaches read goal progress for their students" on public.goal_progress`);
    await db.query(`create policy "Coaches read goal progress for their students" on public.goal_progress for select
      using (exists (select 1 from public.goals g where g.id = goal_progress.goal_id and g.coach_id = auth.uid()))`);
    const rewritten = await attempt(() => db.runFile(migration.paths.migration));
    expect(rewritten.error?.message).toContain(
      'did not get the policies it meant: "Coaches read goal progress for their students" does not ask coach_profile_for_goal(…)',
    );
    expect(await printedAudit(db)).toMatchObject({ [LINE.strangers]: 'none', [LINE.progress]: 'no' });
    await db.drop();
  });

  // A grant that `postgres` did not make is one its REVOKE does not remove.
  it('undoes itself when transfer_student would be left open to a signed-in user', async () => {
    const db = await production();
    await db.runSql(
      `BEGIN;
       create function public.transfer_student(p_student uuid, p_new_coach uuid) returns jsonb
         language sql set search_path = public, pg_temp as 'select null::jsonb';
       grant execute on function public.transfer_student(uuid, uuid) to service_role with grant option;
       set local role service_role;
       grant execute on function public.transfer_student(uuid, uuid) to authenticated;
       COMMIT;`,
      'a function opened by another role',
    );
    const before = await catalogSnapshot(db.query);
    const refused = await attempt(() => db.runFile(migration.paths.migration));
    expect(refused.error?.message).toContain(
      `migration ${MIGRATION} did not get the functions it meant: public.transfer_student(uuid, uuid): a signed-in user may execute it`,
    );
    await untouched(db, before);
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
    expect(await story(db, THE_COACH, deleteSquat)).toBe(FK('exercise_library', 'goals_exercise_id_fkey', 'goals'));
    await db.drop();
  });

  // What the rollback page says of what happened while the migration was in
  // place: an archived exercise comes back, a moved athlete stays moved.
  it('rolled back: an exercise archived meanwhile is an ordinary exercise again, and an athlete who was moved stays with their new coach', async () => {
    const db = await production();
    await db.runFile(migration.paths.migration);
    await db.query(`update public.exercise_library set archived_at = now() where id = '${LEVER}'`);
    await db.query(moveProperly);
    expect(await printedAudit(db)).toMatchObject({ [LINE.archived]: '1', [LINE.otherCoach]: '0' });

    await db.runFile(migration.paths.rollback);
    expect(await printedAudit(db)).toMatchObject({ [LINE.archived]: '0', [LINE.archive]: 'no', [LINE.transfer]: 'no', [LINE.otherCoach]: '0' });
    expect(await db.query.rows(`select * from public.exercise_library where id = '${LEVER}'`)).toHaveLength(1);
    expect(await db.query.one(`select s.coach_id as link, g.coach_id as goal from public.students s, public.goals g`))
      .toEqual({ link: OLGA, goal: OLGA });
    expect(page).toContain('an athlete you moved stays with their new coach, and so do their goals');
    expect(page).toContain('**It drops the column `archived_at`**');
    // …and the migration applies again on what the rollback left.
    await db.runFile(migration.paths.migration);
    expect(await story(db, THE_OTHER_COACH, attemptsLeft)).toBe(2);
    await db.drop();
  });
});
