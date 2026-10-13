// Smoke test of the database: supabase/schema.sql loads UNMODIFIED on a bare
// PostgreSQL 17 + shim.sql, and the baseline tenancy rules hold.
// Everything here passes today and must keep passing.

import { beforeAll, describe, expect, it } from 'vitest';
import {
  asAdmin, asAnon, asPlatformRole, asService, asUser, attempt, createUser, enablePush, httpCalls,
  scenario, scratchDatabase, seed,
} from './harness.js';

let ids;
beforeAll(async () => {
  ids = await seed();
});

const publicTables = () => asAdmin(async (q) => (await q.rows(
  `select c.relname as name, c.relrowsecurity as rls
     from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
    order by c.relname`,
)));

// ------------------------------------------------------------
describe('schema.sql on PostgreSQL 17 + shim.sql', () => {
  it('runs on the production major version', async () => {
    const version = await asAdmin((q) => q.value(`select current_setting('server_version_num')::int`));
    expect(Math.floor(version / 10000)).toBe(17);
  });

  it('creates the application tables', async () => {
    const names = (await publicTables()).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining([
      'profiles', 'students', 'programs', 'weeks', 'sessions', 'exercise_library',
      'exercise_slots', 'set_logs', 'session_confirmations', 'goals', 'goal_progress',
      'slot_comments', 'slot_deviations', 'set_log_videos', 'messages', 'notifications',
      'push_subscriptions', 'scheduled_pushes', 'client_errors', 'bodyweight_logs',
    ]));
  });

  it('has RLS enabled on every public table', async () => {
    const tables = await publicTables();
    expect(tables.length).toBeGreaterThan(0);
    expect(tables.filter((t) => !t.rls).map((t) => t.name)).toEqual([]);
  });

  it('seed() builds the baseline world', async () => {
    const counts = await asAdmin((q) => q.one(
      `select (select count(*) from profiles)       as profiles,
              (select count(*) from students)       as students,
              (select count(*) from programs)       as programs,
              (select count(*) from weeks)          as weeks,
              (select count(*) from sessions)       as sessions,
              (select count(*) from exercise_slots) as slots,
              (select count(*) from set_logs)       as set_logs,
              (select count(*) from messages)       as messages`,
    ));
    // A: 2 weeks × 2 sessions × 2 slots × 3 sets. B: 1 × 1 × 2 × 3.
    expect(counts).toEqual({
      profiles: 3, students: 2, programs: 2, weeks: 3, sessions: 5, slots: 10, set_logs: 30, messages: 3,
    });
    expect(ids.programA.sessions).toHaveLength(4);
    expect(ids.programA.slots).toHaveLength(8);
    expect(ids.programA.setLogs).toHaveLength(24);
  });
});

// ------------------------------------------------------------
describe('anon — the public anon key, no user JWT', () => {
  // Refused outright, on every table of public: since migration 14 anon holds
  // no privilege on any (42501, "permission denied for table …"). The tables
  // of the platform (storage) are not ours: there, row-level security answers.
  const REFUSED = '42501';

  it('reads no table of public', async () => {
    const tables = await publicTables();
    const seen = await asAnon(async (q) => {
      const out = {};
      for (const { name } of tables) {
        const read = await attempt(() => q.value(`select count(*) from public."${name}"`));
        out[name] = read.ok ? read.value : read.error.code;
      }
      return out;
    });
    expect(Object.entries(seen).filter(([, n]) => n !== REFUSED)).toEqual([]);

    // Not vacuous: the same tables do hold rows.
    const truth = await asAdmin((q) => q.value(`select count(*) from public.set_logs`));
    expect(truth).toBe(30);
  });

  it('reads 0 rows from storage', async () => {
    await scenario(async (q) => {
      await q(
        `insert into storage.objects (bucket_id, name) values ('set-videos', $1)`,
        [`${ids.studentA.id}/${ids.programA.slots[0]}/1-clip.mp4`],
      );
      const seen = await asAnon(async (anon) => ({
        buckets: await anon.value(`select count(*) from storage.buckets`),
        objects: await anon.value(`select count(*) from storage.objects`),
      }));
      expect(seen).toEqual({ buckets: 0, objects: 0 });
    });
  });

  it('deletes nothing, whatever the table', async () => {
    const tables = await publicTables();
    await scenario(async (q) => {
      for (const { name } of tables) {
        const tried = await attempt(() => asAnon((anon) => anon(`delete from public."${name}"`)));
        expect(tried.ok ? tried.value.rowCount : tried.error.code, name).toBe(REFUSED);
      }
      expect(await q.value(`select count(*) from public.set_logs`)).toBe(30);
    });
  });
});

// ------------------------------------------------------------
describe('tenant isolation — student A against student B', () => {
  it('A reads its own programs, sessions, set_logs and messages only', async () => {
    const seen = await asUser(ids.studentA, async (q) => ({
      programs: (await q.rows(`select id from programs`)).map((r) => r.id),
      sessions: await q.value(`select count(*) from sessions`),
      setLogs: await q.value(`select count(*) from set_logs`),
      messages: (await q.rows(`select id from messages`)).map((r) => r.id).sort(),
      bProgram: await q.value(`select count(*) from programs where id = $1`, [ids.programB.id]),
      bSession: await q.value(`select count(*) from sessions where id = $1`, [ids.programB.sessions[0]]),
      bSetLog: await q.value(`select count(*) from set_logs where id = $1`, [ids.programB.setLogs[0]]),
      bMessage: await q.value(`select count(*) from messages where id = $1`, [ids.messages.coachToB]),
    }));
    expect(seen).toEqual({
      programs: [ids.programA.id],
      sessions: 4,
      setLogs: 24,
      messages: [ids.messages.coachToA, ids.messages.aToCoach].sort(),
      bProgram: 0,
      bSession: 0,
      bSetLog: 0,
      bMessage: 0,
    });
  });

  it("A's updates and deletes on B's programs, sessions and set_logs touch no row", async () => {
    await scenario(async (q) => {
      const touched = await asUser(ids.studentA, async (a) => ({
        programUpdate: (await a(`update programs set name = 'hacked' where id = $1`, [ids.programB.id])).rowCount,
        programDelete: (await a(`delete from programs where id = $1`, [ids.programB.id])).rowCount,
        sessionUpdate: (await a(`update sessions set title = 'hacked' where id = $1`, [ids.programB.sessions[0]])).rowCount,
        sessionDelete: (await a(`delete from sessions where id = $1`, [ids.programB.sessions[0]])).rowCount,
        setLogUpdate: (await a(`update set_logs set done = true, rpe = 10 where id = $1`, [ids.programB.setLogs[0]])).rowCount,
        setLogDelete: (await a(`delete from set_logs where id = $1`, [ids.programB.setLogs[0]])).rowCount,
      }));
      expect(touched).toEqual({
        programUpdate: 0, programDelete: 0, sessionUpdate: 0, sessionDelete: 0, setLogUpdate: 0, setLogDelete: 0,
      });

      const truth = await q.one(
        `select (select name from programs where id = $1)  as program,
                (select title from sessions where id = $2) as session,
                (select done from set_logs where id = $3)  as done`,
        [ids.programB.id, ids.programB.sessions[0], ids.programB.setLogs[0]],
      );
      expect(truth).toEqual({ program: 'Block B', session: 'W1 · S1', done: false });
    });
  });

  it("A's inserts into B's tree are rejected by RLS", async () => {
    await asUser(ids.studentA, async (q) => {
      const program = await attempt(() => q(
        `insert into programs (student_id, name, status, created_by) values ($1, 'mine now', 'draft', $2)`,
        [ids.studentB.studentRowId, ids.studentA.id],
      ));
      const session = await attempt(() => q(
        `insert into sessions (week_id, title, sort_order) values ($1, 'injected', 9)`,
        [ids.programB.weeks[0]],
      ));
      const setLog = await attempt(() => q(
        `insert into set_logs (exercise_slot_id, set_number, is_student_added) values ($1, 9, true)`,
        [ids.programB.slots[0]],
      ));
      expect([program, session, setLog].map((r) => r.error?.code)).toEqual(['42501', '42501', '42501']);
    });
  });

  it("A cannot read, forge, mark read or delete B's messages", async () => {
    await scenario(async (q) => {
      await asUser(ids.studentA, async (a) => {
        // Forge a message "from B", and write to someone who is not A's coach.
        const forged = await attempt(() => a(
          `insert into messages (sender_id, recipient_id, body) values ($1, $2, 'forged')`,
          [ids.studentB.id, ids.coach.id],
        ));
        const toStranger = await attempt(() => a(
          `insert into messages (sender_id, recipient_id, body) values ($1, $2, 'hello B')`,
          [ids.studentA.id, ids.studentB.id],
        ));
        expect([forged.error?.code, toStranger.error?.code]).toEqual(['42501', '42501']);

        const marked = await a(`update messages set read_at = now() where id = $1`, [ids.messages.coachToB]);
        const deleted = await a(`delete from messages where id = $1`, [ids.messages.coachToB]);
        expect([marked.rowCount, deleted.rowCount]).toEqual([0, 0]);
      });

      const truth = await q.one(`select body, read_at from messages where id = $1`, [ids.messages.coachToB]);
      expect(truth).toEqual({ body: 'Welcome to the block, Billie.', read_at: null });
    });
  });

  it('the coach reads both students', async () => {
    const seen = await asUser(ids.coach, async (q) => ({
      students: await q.value(`select count(*) from students`),
      programs: (await q.rows(`select id from programs`)).map((r) => r.id).sort(),
      sessions: await q.value(`select count(*) from sessions`),
      setLogs: await q.value(`select count(*) from set_logs`),
      messages: await q.value(`select count(*) from messages`),
      profiles: await q.value(`select count(*) from profiles`),
    }));
    expect(seen).toEqual({
      students: 2,
      programs: [ids.programA.id, ids.programB.id].sort(),
      sessions: 5,
      setLogs: 30,
      messages: 3,
      profiles: 3,
    });
  });

  it('a coach with no athlete sees nobody', async () => {
    await scenario(async () => {
      const other = await createUser({ fullName: 'Other Coach', role: 'coach' });
      const seen = await asUser(other, async (q) => ({
        students: await q.value(`select count(*) from students`),
        programs: await q.value(`select count(*) from programs`),
        setLogs: await q.value(`select count(*) from set_logs`),
        messages: await q.value(`select count(*) from messages`),
      }));
      expect(seen).toEqual({ students: 0, programs: 0, setLogs: 0, messages: 0 });
    });
  });
});

// ------------------------------------------------------------
describe('set_logs — the student owns the actuals, the coach owns the targets', () => {
  it('a student toggles done / rpe on its own set_log', async () => {
    const row = await asUser(ids.studentA, (q) => q.one(
      `update set_logs set done = true, rpe = 8, logged_at = now() where id = $1 returning done, rpe`,
      [ids.programA.setLogs[0]],
    ));
    expect(row).toEqual({ done: true, rpe: 8 });
  });

  it('a student cannot change target_*: the pin trigger keeps the prescription', async () => {
    const row = await asUser(ids.studentA, (q) => q.one(
      `update set_logs
          set done = true, target_reps = 99, target_weight_kg = 999, target_rest_seconds = 1,
              target_duration_seconds = null
        where id = $1
        returning done, target_reps, target_weight_kg, target_rest_seconds`,
      [ids.programA.setLogs[0]],
    ));
    expect(row).toEqual({ done: true, target_reps: 5, target_weight_kg: 20, target_rest_seconds: 120 });
  });

  it('the coach changes target_*', async () => {
    const row = await asUser(ids.coach, (q) => q.one(
      `update set_logs set target_reps = 6, target_weight_kg = 22.5 where id = $1
       returning target_reps, target_weight_kg`,
      [ids.programA.setLogs[0]],
    ));
    expect(row).toEqual({ target_reps: 6, target_weight_kg: 22.5 });
  });
});

// ------------------------------------------------------------
describe('profiles', () => {
  it('a signup is always a student, whatever role the signup metadata claims', async () => {
    await scenario(async (q) => {
      const id = await q.value(
        `insert into auth.users (email, raw_user_meta_data)
         values ('mallory@sl.test', '{"full_name": "Mallory", "role": "coach"}') returning id`,
      );
      expect(await q.one(`select role, full_name from profiles where id = $1`, [id]))
        .toEqual({ role: 'student', full_name: 'Mallory' });
    });
  });

  it('a student renames itself but cannot promote itself to coach', async () => {
    const row = await asUser(ids.studentA, (q) => q.one(
      `update profiles set full_name = 'Alex Renamed', role = 'coach' where id = $1 returning full_name, role`,
      [ids.studentA.id],
    ));
    expect(row).toEqual({ full_name: 'Alex Renamed', role: 'student' });
  });
});

// ------------------------------------------------------------
// The harness itself: these pin what shim.sql and harness.js promise, so a
// red test elsewhere can be trusted to be about schema.sql.
describe('harness', () => {
  it('impersonates each role the way PostgREST does', async () => {
    const whoami = `select current_user::text as role, auth.uid() as uid, auth.role() as claim`;
    expect(await asAnon((q) => q.one(whoami))).toEqual({ role: 'anon', uid: null, claim: 'anon' });
    expect(await asUser(ids.studentA, (q) => q.one(whoami)))
      .toEqual({ role: 'authenticated', uid: ids.studentA.id, claim: 'authenticated' });
    expect(await asService((q) => q.one(whoami)))
      .toEqual({ role: 'service_role', uid: null, claim: 'service_role' });
    expect(await asAdmin((q) => q.one(`${whoami}, current_setting('is_superuser') as superuser`)))
      .toEqual({ role: 'postgres', uid: null, claim: null, superuser: 'off' });
  });

  it('service_role bypasses RLS', async () => {
    expect(await asService((q) => q.value(`select count(*) from set_logs`))).toBe(30);
  });

  it('rolls back a top-level helper call', async () => {
    await asUser(ids.studentA, (q) => q(`update set_logs set done = true where id = $1`, [ids.programA.setLogs[0]]));
    expect(await asAdmin((q) => q.value(`select done from set_logs where id = $1`, [ids.programA.setLogs[0]])))
      .toBe(false);
  });

  it('shares one transaction between nested helpers, and survives a failed statement', async () => {
    await scenario(async (q) => {
      await asUser(ids.studentA, async (a) => {
        await a(`update set_logs set done = true where id = $1`, [ids.programA.setLogs[0]]);
        const refused = await attempt(() => a(
          `insert into set_logs (exercise_slot_id, set_number) values ($1, 9)`, [ids.programB.slots[0]],
        ));
        expect(refused.error?.code).toBe('42501');
        // The transaction is still usable, as the same user.
        expect(await a.value(`select auth.uid()`)).toBe(ids.studentA.id);
      });
      // Back to the outer actor, and the student's write is visible.
      expect(await q.one(`select current_user::text as role, auth.uid() as uid`))
        .toEqual({ role: 'postgres', uid: null });
      expect(await q.value(`select done from set_logs where id = $1`, [ids.programA.setLogs[0]])).toBe(true);
    });
  });

  it('propagates an error thrown inside a helper, and rolls back', async () => {
    await expect(asUser(ids.studentA, (q) => q(`select * from no_such_table`)))
      .rejects.toMatchObject({ code: '42P01' });
    await expect(scenario(async (q) => {
      await q(`delete from messages`);
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(await asAdmin((q) => q.value(`select count(*) from messages`))).toBe(3);
  });

  // What shim.sql promises: the starting point of a Supabase project. Asked of
  // an EMPTY project, not of schema.sql — which now closes the part about
  // functions (migration 03; function-acl.test.js holds what it leaves) and
  // the part about tables (migration 14; table-acl.test.js).
  it('reproduces the Supabase default privileges on schema public', async () => {
    const db = await scratchDatabase();
    const q = db.query;
    await q(`create function public.harness_probe() returns int language sql as 'select 1'`);
    await q(`create table public.harness_probe_table (id int)`);
    const canExecute = () => q.one(
      `select has_function_privilege('anon', 'public.harness_probe()', 'EXECUTE')          as anon,
              has_function_privilege('authenticated', 'public.harness_probe()', 'EXECUTE') as authenticated`,
    );

    // A new function is executable by the API roles from the start…
    expect(await canExecute()).toEqual({ anon: true, authenticated: true });
    // …REVOKE … FROM public does not take that away (the trap behind P1)…
    await q(`revoke all on function public.harness_probe() from public`);
    expect(await canExecute()).toEqual({ anon: true, authenticated: true });
    // …only a revoke by name does.
    await q(`revoke execute on function public.harness_probe() from anon`);
    expect(await canExecute()).toEqual({ anon: false, authenticated: true });

    // And a new table is fully granted: without RLS it is world-writable.
    expect(await q.rows(
      `select privilege
         from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) as privilege
        where not has_table_privilege('anon', 'public.harness_probe_table', privilege)`,
    )).toEqual([]);
    await db.drop();
  });

  it('becomes a platform role that postgres is not a member of, and rolls back what it did as one', async () => {
    const refused = await attempt(() => asAdmin((q) => q(`set local role supabase_auth_admin`)));
    expect(refused.error?.code).toBe('42501');

    const accounts = () => asAdmin((q) => q.value(`select count(*) from auth.users`));
    const before = await accounts();
    await asPlatformRole('supabase_auth_admin', async (gotrue, owner) => {
      expect(await gotrue.value(`select current_user::text`)).toBe('supabase_auth_admin');
      expect(await owner.value(`select current_user::text`)).toBe('postgres');
      // Committed fixtures are visible, and GoTrue writes its own table.
      await gotrue(`insert into auth.users (email) values ('passing@sl.test')`);
      expect(await owner.value(`select count(*) from auth.users`)).toBe(before + 1);
    });
    expect(await accounts()).toBe(before);
  });

  // A file drops its database as `postgres`, with DROP DATABASE … WITH
  // (FORCE), which ends the other sessions of that database first. `postgres`
  // is not a superuser: it may end its own sessions, not an autovacuum
  // worker. With one in the database the drop is refused ("permission denied
  // to terminate process") and the file is reported as failed after its last
  // green test — which happened in about one run out of two once a run was
  // longer than autovacuum_naptime. postgres.js starts the server without
  // autovacuum for that reason.
  it('runs on a server without autovacuum, whose worker a file could not end when it drops its database', async () => {
    expect(await asAdmin((q) => q.one(
      `select current_setting('autovacuum') as autovacuum,
              (select count(*) from pg_stat_activity
                where backend_type in ('autovacuum launcher', 'autovacuum worker')) as backends`,
    ))).toEqual({ autovacuum: 'off', backends: 0 });
  });

  it('queues a Web Push through the pg_net stub once the Vault secrets exist', async () => {
    const confirm = (q) => q(
      `insert into session_confirmations (session_id, student_id) values ($1, $2)`,
      [ids.programA.sessions[0], ids.studentA.id],
    );

    // Not configured (the default): in-app notification, no HTTP call.
    await scenario(async (q) => {
      await asUser(ids.studentA, confirm);
      expect(await q.value(`select count(*) from notifications where kind = 'session_completed'`)).toBe(1);
      expect(await httpCalls()).toEqual([]);
    });

    await scenario(async () => {
      await enablePush();
      await asUser(ids.studentA, confirm);
      const calls = await httpCalls();
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        method: 'POST',
        url: 'https://functions.sl.test/functions/v1/send-push',
        headers: { Authorization: 'Bearer test-internal-bearer' },
        body: { user_id: ids.coach.id, payload: { title: 'Session completed' } },
      });
    });
  });

  it('lets a test make net.http_post fail — the write must survive it', async () => {
    await scenario(async (q) => {
      await enablePush();
      await q(`select set_config('shim.http_post_fails', 'on', true)`);
      await asUser(ids.studentA, (a) => a(
        `insert into session_confirmations (session_id, student_id) values ($1, $2)`,
        [ids.programA.sessions[0], ids.studentA.id],
      ));
      expect(await q.value(`select count(*) from session_confirmations`)).toBe(1);
      expect(await q.value(`select count(*) from notifications where kind = 'session_completed'`)).toBe(1);
      expect(await httpCalls()).toEqual([]);
    });
  });
});
