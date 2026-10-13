// The two rules of public.profiles — review findings B10 and P20, closed by
// migration 2026_10_11_07_profile_rules.
//
//   the name   handle_new_user gives every new account a profile whose name is
//              never empty: the name the account was created with, else what
//              stands before the @ of its address, else 'Athlete'
//   the role   profiles_pin_immutable_columns keeps it for a request that
//              carries a user id, and lets the owner of the database write it
//              — which is how a coach is made. A role that changes is held to
//              the rule of migration 05: an athlete with a coach is not made
//              a coach, a coach with athletes does not stop being one
//
// The pin on the role is SILENT (the statement is accepted, the role keeps
// its value), so those tests read the row back. The two refusals of a role
// change RAISE: the caller is the owner, who must know that nothing happened.
//
// The first blocks run against schema.sql, as the callers there are: GoTrue,
// which creates every account; the owner; the service role; a signed-in user.
// The last block applies the migration file itself to the frozen production
// baseline, with the checks and the statements of its runbook page read off
// the page.

import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  asAnon, asPlatformRole, asService, asUser, attempt, createProgram, createUser, enablePush, httpCalls,
  repoRoot, scenario, scratchDatabase, seed,
} from './harness.js';
import { catalogSnapshot, diffCatalogs } from './catalog.js';
import { LEDGER, loadManifest, REFUSAL } from '../migrations/manifest.js';

const MIGRATION = '2026_10_11_07_profile_rules';
const manifest = loadManifest();
const migration = manifest.migrations.find((m) => m.name === MIGRATION);
const read = (file) => fs.readFileSync(path.join(repoRoot, file), 'utf8');

// seed(): coach Carla with athletes Alex (A) and Billie (B). Next to them:
// Una, an account nobody coaches — the one a coach is made of.
let ids;
let una;
beforeAll(async () => {
  ids = await seed();
  una = await createUser({ email: 'una@sl.test', fullName: 'Una Unlinked' });
});

// The sentences of the migration.
const IS_AN_ATHLETE = ({ id }, name) => `profile ${id} (${name}) cannot be made a coach: it is the athlete of a coach`;
const HAS_ATHLETES = ({ id }, name, n) => `profile ${id} (${name}) cannot stop being a coach: it has ${n} athlete(s)`;

const profileOf = (q, user) => q.one(`select role, full_name from profiles where id = $1`, [user.id ?? user]);
const roleOf = (q, user) => q.value(`select role from profiles where id = $1`, [user.id ?? user]);

// ============================================================
// B10 — the name of a new account
// ============================================================
describe('a new account has a name (B10)', () => {
  // GoTrue: the role every account arrives as — a sign-up, an invitation, the
  // dashboard's "Add user" — with the search_path it connects with. `columns`
  // is the row it inserts into auth.users.
  const created = (columns) => asPlatformRole('supabase_auth_admin', async (gotrue, owner) => {
    await gotrue(`set local search_path = auth`);
    const names = Object.keys(columns);
    const id = await gotrue.value(
      `insert into users (${names.join(', ')}) values (${names.map((_, i) => `$${i + 1}`).join(', ')}) returning id`,
      Object.values(columns),
    );
    return owner.one(`select role, full_name from public.profiles where id = $1`, [id]);
  });
  const meta = (value) => JSON.stringify(value);
  const LEA = 'lea.martin@example.com';

  it.each([
    ['the name it was created with', { email: LEA, raw_user_meta_data: meta({ full_name: 'Léa Martin' }) }, 'Léa Martin'],
    ['…without the white space around it, and with the one inside',
      { email: LEA, raw_user_meta_data: meta({ full_name: ' \t Léa  Martin \r\n' }) }, 'Léa  Martin'],
    // "Add user" in the dashboard: an address, a password, nothing else.
    ['no metadata at all: what stands before the @', { email: LEA }, 'lea.martin'],
    ['metadata without a name', { email: LEA, raw_user_meta_data: meta({}) }, 'lea.martin'],
    ['an empty name', { email: LEA, raw_user_meta_data: meta({ full_name: '' }) }, 'lea.martin'],
    ['a name of blanks', { email: LEA, raw_user_meta_data: meta({ full_name: '   ' }) }, 'lea.martin'],
    ['a name of tabs and line ends', { email: LEA, raw_user_meta_data: meta({ full_name: '\t\r\n \n' }) }, 'lea.martin'],
    ['a name that is null', { email: LEA, raw_user_meta_data: meta({ full_name: null }) }, 'lea.martin'],
    // Whatever a client put there: it is never an error — an error here is an
    // account that cannot be created.
    ['metadata that is a list', { email: LEA, raw_user_meta_data: meta(['Léa']) }, 'lea.martin'],
    ['metadata that is a string', { email: LEA, raw_user_meta_data: meta('Léa') }, 'lea.martin'],
    ['metadata that is null', { email: LEA, raw_user_meta_data: meta(null) }, 'lea.martin'],
    ['a name that is a number: its digits', { email: LEA, raw_user_meta_data: meta({ full_name: 42 }) }, '42'],
    ['white space around the address', { email: '  lea@example.com' }, 'lea'],
    ['an address without an @: all of it', { email: 'lea' }, 'lea'],
    // No address: a phone number, an anonymous sign-in. Neither is switched
    // on, and both must still get a profile.
    ['no address and no name', { phone: '+33600000000' }, 'Athlete'],
    ['an empty address', { email: '' }, 'Athlete'],
    ['an address with nothing before the @', { email: '@example.com' }, 'Athlete'],
    ['an address with blanks before the @', { email: '   @example.com', raw_user_meta_data: meta({ full_name: ' ' }) }, 'Athlete'],
    ['no address, and a name', { phone: '+33600000001', raw_user_meta_data: meta({ full_name: 'Léa' }) }, 'Léa'],
  ])('%s', async (_, columns, name) => {
    const profile = await created(columns);
    expect(profile).toEqual({ role: 'student', full_name: name });
    expect(profile.full_name).toMatch(/\S/);
  });

  // The role is not the account's to say (2026_07_12), with or without a name.
  it('is a student, whatever its metadata says of its role', async () => {
    expect(await created({ email: LEA, raw_user_meta_data: meta({ role: 'coach', full_name: ' ' }) }))
      .toEqual({ role: 'student', full_name: 'lea.martin' });
  });

  it('created by the owner of the database (a seed, the SQL editor), it is named the same way', () => scenario(async (q) => {
    const newcomer = await createUser({ email: 'sam.newcomer@sl.test' });
    expect(await profileOf(q, newcomer)).toEqual({ role: 'student', full_name: 'sam.newcomer' });
  }));

  // What the finding was about: COALESCE(name, 'Your athlete') lets an empty
  // name through, and the coach read " completed Session 3".
  it('the push to the coach says who trained', () => scenario(async (q) => {
    await enablePush();
    const newcomer = await createUser({ email: 'sam.newcomer@sl.test', coach: ids.coach });
    const block = await createProgram({ student: newcomer, active: true });
    await asUser(newcomer, (athlete) => athlete(
      `insert into session_confirmations (session_id, student_id, performed_on) values ($1, $2, current_date)`,
      [block.sessions[0], newcomer.id],
    ));

    const [push] = (await httpCalls()).filter((call) => call.body.user_id === ids.coach.id);
    expect(push.body.payload).toMatchObject({ title: 'Session completed', body: 'sam.newcomer completed W1 · S1' });
    expect(await q.value(
      `select payload->>'student_name' from notifications where recipient_id = $1 and kind = 'session_completed'`,
      [ids.coach.id],
    )).toBe('sam.newcomer');
  }));

  // The name is the account's own afterwards (Profile → tap the name): the
  // write of the deployed app, src/hooks/useAuth.jsx.
  it('its owner renames it in the app', () => scenario(async () => {
    const newcomer = await createUser({ email: 'sam.newcomer@sl.test' });
    expect(await asUser(newcomer, (user) => user.one(
      `update profiles set full_name = $1 where id = $2 returning id, role, full_name`, ['Sam Newcomer', newcomer.id],
    ))).toEqual({ id: newcomer.id, role: 'student', full_name: 'Sam Newcomer' });
  }));
});

// ============================================================
// P20 — the role of a profile
// ============================================================
describe('the role of a profile: the owner of the database writes it (P20)', () => {
  // The statement README and INVARIANTS have given since 2026_07_12.
  const MAKE_COACH = `update public.profiles set role = 'coach' where id = $1 returning role`;
  const MAKE_STUDENT = `update public.profiles set role = 'student' where id = $1 returning role`;

  it('the documented statement makes a coach — a coach of their own athletes, library and nothing else', () => scenario(async (q) => {
    expect(await q.value(MAKE_COACH, [una.id])).toBe('coach');
    expect(await roleOf(q, una)).toBe('coach');

    // What being a coach opens: is_coach(), a library, athletes.
    const nina = await createUser({ email: 'nina@sl.test', fullName: 'Nina Athlete' });
    expect(await q.value(
      `insert into students (profile_id, coach_id) values ($1, $2) returning coach_id`, [nina.id, una.id],
    )).toBe(una.id);
    await asUser(una, async (coach) => {
      expect(await coach.value(`select public.is_coach()`)).toBe(true);
      expect(await coach.value(
        `insert into exercise_library (coach_id, name, type, difficulty) values ($1, 'Row', 'pull', 1) returning name`,
        [una.id],
      )).toBe('Row');
      // Her roster is hers, and the first coach's is not.
      expect(await coach.rows(`select full_name from profiles where id <> $1 order by full_name`, [una.id]))
        .toEqual([{ full_name: 'Nina Athlete' }]);
      expect(await coach.value(`select count(*) from students`)).toBe(1);
      expect(await coach.value(`select count(*) from programs`)).toBe(0);
      expect(await coach.value(`select count(*) from exercise_library`)).toBe(1);
    });
    // …and the first coach sees neither the new coach nor her athlete.
    await asUser(ids.coach, async (coach) => {
      expect(await coach.value(`select count(*) from profiles where id in ($1, $2)`, [una.id, nina.id])).toBe(0);
      expect(await coach.value(`select count(*) from students`)).toBe(2);
      expect(await coach.value(`select count(*) from exercise_library where name = 'Row'`)).toBe(0);
    });
  }));

  it('the service-role key does it too: it has no user id either', () => scenario(async (q) => {
    expect(await asService((service) => service.value(MAKE_COACH, [una.id]))).toBe('coach');
    expect(await roleOf(q, una)).toBe('coach');
  }));

  it('a coach nobody trains under can be made an athlete again, and linked to a coach', () => scenario(async (q) => {
    await q(MAKE_COACH, [una.id]);
    expect(await q.value(MAKE_STUDENT, [una.id])).toBe('student');
    expect(await q.value(
      `insert into students (profile_id, coach_id) values ($1, $2) returning profile_id`, [una.id, ids.coach.id],
    )).toBe(una.id);
  }));

  it('id and created_at stay what they were, for the owner too', () => scenario(async (q) => {
    const before = await q.one(`select id, created_at from profiles where id = $1`, [una.id]);
    expect(await q.one(
      `update profiles set id = gen_random_uuid(), created_at = '2000-01-01', full_name = 'Una Again'
        where id = $1 returning id, created_at, full_name`,
      [una.id],
    )).toEqual({ ...before, full_name: 'Una Again' });
  }));
});

describe('the role of a profile: nobody who is signed in writes one', () => {
  it('a signed-in user cannot make themselves a coach: the role is kept, the name saved', () => scenario(async (q) => {
    for (const athlete of [una, ids.studentA]) {
      expect(await asUser(athlete, (user) => user.one(
        `update profiles set role = 'coach', full_name = 'Renamed' where id = $1 returning role, full_name`, [athlete.id],
      ))).toEqual({ role: 'student', full_name: 'Renamed' });
      expect(await profileOf(q, athlete)).toEqual({ role: 'student', full_name: 'Renamed' });
      expect(await asUser(athlete, (user) => user.value(`select public.is_coach()`))).toBe(false);
    }
  }));

  it('nor their id, nor the day the account was created', () => scenario(async (q) => {
    const before = await q.one(`select id, created_at from profiles where id = $1`, [una.id]);
    expect(await asUser(una, (user) => user.one(
      `update profiles set id = gen_random_uuid(), created_at = '2000-01-01' where id = $1 returning id, created_at`,
      [una.id],
    ))).toEqual(before);
  }));

  it('nor can a coach stop being one from the app', () => scenario(async (q) => {
    expect(await asUser(ids.coach, (user) => user.value(
      `update profiles set role = 'student' where id = $1 returning role`, [ids.coach.id],
    ))).toBe('coach');
    expect(await roleOf(q, ids.coach)).toBe('coach');
  }));

  it('nobody reaches the profile of somebody else: a coach their athlete\'s, an athlete their coach\'s', () => scenario(async (q) => {
    const write = (as, target) => asUser(as, (user) => user(
      `update profiles set role = 'coach', full_name = 'Taken' where id = $1`, [target.id],
    ));
    expect((await write(ids.coach, ids.studentA)).rowCount).toBe(0);
    expect((await write(ids.studentA, ids.coach)).rowCount).toBe(0);
    expect((await write(ids.studentA, ids.studentB)).rowCount).toBe(0);
    expect(await q.rows(`select full_name, role from profiles where id = any($1) order by full_name`,
      [[ids.coach.id, ids.studentA.id, ids.studentB.id]])).toEqual([
      { full_name: 'Alex Athlete', role: 'student' },
      { full_name: 'Billie Athlete', role: 'student' },
      { full_name: 'Coach Carla', role: 'coach' },
    ]);
  }));

  // No user id, and not the owner: the pin does not hold the role for such a
  // caller. The privilege does — `anon` holds none on any table since
  // migration 14 — and row-level security behind it, which gives it no row.
  it('a request without a session reaches no profile at all', () => scenario(async (q) => {
    const tried = await attempt(() => asAnon((anon) => anon(`update profiles set role = 'coach'`)));
    expect(tried.error?.message).toBe('permission denied for table profiles');
    expect(await q.value(`select count(*) from profiles where role = 'coach'`)).toBe(1);

    // Were the privilege given back, the policy would still let it reach nothing.
    await q(`grant update, select on public.profiles to anon`);
    expect((await asAnon((anon) => anon(`update profiles set role = 'coach'`))).rowCount).toBe(0);
    expect(await q.value(`select count(*) from profiles where role = 'coach'`)).toBe(1);
  }));

  // "With a user id" is the request, not the role the statement runs as: a
  // SECURITY DEFINER function runs as `postgres`, and is still the user.
  it('a function a signed-in user calls is that user: it writes no role either', () => scenario(async (q) => {
    await q(
      `create function public.make_a_coach(p_profile uuid) returns text
         language sql security definer set search_path = public, pg_temp
         as $$ update public.profiles set role = 'coach' where id = p_profile returning role $$`,
    );
    await q(`grant execute on function public.make_a_coach(uuid) to authenticated`);
    for (const caller of [una, ids.coach]) {
      expect(await asUser(caller, (user) => user.value(`select public.make_a_coach($1)`, [una.id]))).toBe('student');
    }
    expect(await roleOf(q, una)).toBe('student');
    // Called without a user id — an Edge Function with the service-role key —
    // the same function is the owner's statement.
    expect(await asService((service) => service.value(`select public.make_a_coach($1)`, [una.id]))).toBe('coach');
    expect(await roleOf(q, una)).toBe('coach');
  }));
});

describe('a role change never contradicts who coaches whom', () => {
  const setRole = (q, user, role) => attempt(() => q(`update public.profiles set role = $2 where id = $1`, [user.id, role]));
  // Line 11 of the audit of migration 05: the links its gate refuses.
  const refusedLinks = async (q) => (await q.rows(read('supabase/audits/2026_10_11_05_students_role_gate.audit.sql')))
    .find((line) => line.check === 'coach-athlete links the gate refuses').value;

  it('an athlete with a coach is not made a coach', () => scenario(async (q) => {
    for (const run of [(fn) => fn(q), asService]) {
      const tried = await run((caller) => setRole(caller, ids.studentA, 'coach'));
      expect(tried.error?.code).toBe('23514');
      expect(tried.error.message).toBe(IS_AN_ATHLETE(ids.studentA, 'Alex Athlete'));
      expect(tried.error.hint).toContain('Nothing was written.');
    }
    expect(await roleOf(q, ids.studentA)).toBe('student');
    expect(await refusedLinks(q)).toBe('0');
  }));

  it('a coach with athletes does not stop being one', () => scenario(async (q) => {
    for (const run of [(fn) => fn(q), asService]) {
      const tried = await run((caller) => setRole(caller, ids.coach, 'student'));
      expect(tried.error?.code).toBe('23514');
      expect(tried.error.message).toBe(HAS_ATHLETES(ids.coach, 'Coach Carla', 2));
      expect(tried.error.hint).toContain('Nothing was written.');
    }
    expect(await roleOf(q, ids.coach)).toBe('coach');
    expect(await refusedLinks(q)).toBe('0');
  }));

  // One statement over several profiles: refused as a whole.
  it('one profile in the way stops the whole statement', () => scenario(async (q) => {
    const tried = await attempt(() => q(`update public.profiles set role = 'coach' where role = 'student'`));
    expect(tried.error?.code).toBe('23514');
    expect(await q.value(`select count(*) from profiles where role = 'coach'`)).toBe(1);
  }));

  it('once the link is gone, the account can be made a coach', () => scenario(async (q) => {
    const nina = await createUser({ email: 'nina@sl.test', fullName: 'Nina', coach: ids.coach });
    expect((await setRole(q, nina, 'coach')).error?.message).toBe(IS_AN_ATHLETE(nina, 'Nina'));
    await q(`delete from students where id = $1`, [nina.studentRowId]);
    expect((await setRole(q, nina, 'coach')).ok).toBe(true);
    expect(await roleOf(q, nina)).toBe('coach');
    expect(await refusedLinks(q)).toBe('0');
  }));

  // The rule is asked when the role MOVES. A linked profile is written all
  // the time — by its owner, by the owner of the database.
  it('a write that leaves the role as it is asks nothing', () => scenario(async (q) => {
    expect((await q(`update public.profiles set role = role, full_name = full_name || '!'`)).rowCount).toBe(4);
    expect(await q.one(
      `update public.profiles set role = 'student', full_name = 'Alex A.' where id = $1 returning role, full_name`,
      [ids.studentA.id],
    )).toEqual({ role: 'student', full_name: 'Alex A.' });
    expect(await q.value(
      `update public.profiles set role = 'coach' where id = $1 returning role`, [ids.coach.id],
    )).toBe('coach');
  }));

  // The table's own CHECK still says what a role is.
  it('a role that is not one is refused by the table, as before', () => scenario(async (q) => {
    expect((await setRole(q, una, 'admin')).error?.code).toBe('23514');
    expect((await setRole(q, una, null)).error?.code).toBe('23502');
    expect(await roleOf(q, una)).toBe('student');
  }));
});

// ============================================================
// The migration file, on production as it was frozen.
// ============================================================
describe('migration 07 applied to the production baseline', () => {
  const COACH = '00000000-0000-4000-8000-00000000c0ac';
  const ATHLETE = '00000000-0000-4000-8000-0000000000a1';
  const FREE = '00000000-0000-4000-8000-0000000000a2';
  const LINK = '00000000-0000-4000-8000-000000000101';
  const TO_COME = '2099_01_01_99_a_migration_to_come';

  // A coach and their athlete, and an account nobody coaches. The coach's
  // role is set the way a dump restore sets it: on the baseline the
  // documented `update profiles set role = 'coach'` is undone for every
  // caller — the finding.
  const WORLD = `
    insert into auth.users (id, email, aud, role, email_confirmed_at, raw_user_meta_data) values
      ('${COACH}',   'coach@sl.test', 'authenticated', 'authenticated', now(), '{"full_name": "Coach Carla"}'),
      ('${ATHLETE}', 'alex@sl.test',  'authenticated', 'authenticated', now(), '{"full_name": "Alex"}'),
      ('${FREE}',    'una@sl.test',   'authenticated', 'authenticated', now(), '{"full_name": "Una"}');
    BEGIN;
    SET LOCAL session_replication_role = replica;
    update public.profiles set role = 'coach' where id = '${COACH}';
    COMMIT;
    insert into public.students (id, profile_id, coach_id) values ('${LINK}', '${ATHLETE}', '${COACH}');
  `;

  /** The frozen baseline with that world in it and the migrations before 07 applied. */
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

  // One request: for a user of the API, role and claims set the way PostgREST
  // sets them; for the owner (`null`), nothing — the SQL editor. One or two
  // statements, and everything undone: the answer is what is looked at.
  const user = (sub) => ({ role: 'authenticated', claims: { role: 'authenticated', sub } });
  const SERVICE = { role: 'service_role', claims: { role: 'service_role' } };
  const OWNER = null;
  const request = async (db, actor, sql) => {
    const tried = await attempt(() => db.runSql(
      `BEGIN;
       ${actor ? `select set_config('role', '${actor.role}', true),
              set_config('request.jwt.claims', '${JSON.stringify(actor.claims)}', true);` : ''}
       ${sql};
       ROLLBACK;`,
      'request',
    ));
    if (!tried.ok) return (tried.error.cause ?? tried.error).message;
    const [found] = tried.value.at(-2).rows;
    return found ? Object.values(found)[0] : null;
  };

  // The two findings.
  const newAccount = (email) => `insert into auth.users (email, aud, role) values ('${email}', 'authenticated', 'authenticated');
    select p.full_name from public.profiles p join auth.users u on u.id = p.id where u.email = '${email}'`;
  const setRole = (id, role) => `update public.profiles set role = '${role}' where id = '${id}' returning role`;
  const ownRole = (id) => `update public.profiles set role = 'coach', full_name = 'Renamed' where id = '${id}'
                           returning role || ' ' || full_name`;

  // The runbook page, which is what the person applying the file reads.
  const page = read(migration.paths.runbook);
  // Its fenced blocks, without the indent of the list item they stand in.
  const fences = (lang, text = page) => [...text.matchAll(new RegExp(`^( *)\`\`\`${lang}\\n([\\s\\S]*?)\\n\\1\`\`\`$`, 'gm'))]
    .map(([, indent, body]) => body.split('\n').map((line) => line.slice(indent.length)).join('\n'));
  const [pageCheck] = fences('bash')
    .map((command) => /^supabase db query --linked '(do \$check\$[\s\S]+\$check\$)'$/.exec(command)?.[1])
    .filter(Boolean);
  // A statement the page gives for the SQL editor, found by how it starts.
  const statement = (start, text = page) => fences('sql', text).find((sql) => sql.startsWith(start));

  const printedAudit = async (db) => {
    const [result] = await db.readOnly(read(migration.paths.audit), 'audit');
    return Object.fromEntries(result.rows.map((line) => [line.check, line.value]));
  };
  const LINE = {
    profile: 'a new account gets its profile',
    name: 'a new account created without a name is given one (B10)',
    pin: 'a signed-in user cannot change the role of a profile',
    owner: 'the owner of the database can change it (P20)',
    links: 'a role that a coach-athlete link stands against is refused',
    nameless: 'profiles without a name',
    accounts: 'accounts',
  };

  it('the two findings are there before, closed after, and back after the rollback', async () => {
    const db = await production();

    // Before: as the review traced them.
    expect(await request(db, OWNER, newAccount('new.one@sl.test'))).toBe('');
    expect(await request(db, OWNER, setRole(FREE, 'coach'))).toBe('student');
    expect(await request(db, SERVICE, setRole(FREE, 'coach'))).toBe('student');
    expect(await request(db, user(FREE), ownRole(FREE))).toBe('student Renamed');

    await db.runFile(migration.paths.migration);

    expect(await request(db, OWNER, newAccount('new.one@sl.test'))).toBe('new.one');
    expect(await request(db, OWNER, setRole(FREE, 'coach'))).toBe('coach');
    expect(await request(db, SERVICE, setRole(FREE, 'coach'))).toBe('coach');
    // A signed-in user: as before, for the account nobody coaches, the athlete and the coach.
    expect(await request(db, user(FREE), ownRole(FREE))).toBe('student Renamed');
    expect(await request(db, user(ATHLETE), ownRole(ATHLETE))).toBe('student Renamed');
    expect(await request(db, user(COACH), setRole(COACH, 'student'))).toBe('coach');
    expect(await request(db, user(COACH), setRole(ATHLETE, 'coach'))).toBeNull();
    // The role does not move against the link.
    expect(await request(db, OWNER, setRole(ATHLETE, 'coach'))).toBe(IS_AN_ATHLETE({ id: ATHLETE }, 'Alex'));
    expect(await request(db, OWNER, setRole(COACH, 'student'))).toBe(HAS_ATHLETES({ id: COACH }, 'Coach Carla', 1));
    // The app that is deployed today: the name saved in Profile, as before.
    expect(await request(db, user(ATHLETE),
      `update public.profiles set full_name = 'Alex B.' where id = '${ATHLETE}' returning full_name`)).toBe('Alex B.');
    // Nothing above was kept, and the migration itself touches no row.
    expect(await db.query.rows(`select full_name, role from public.profiles order by full_name`)).toEqual([
      { full_name: 'Alex', role: 'student' },
      { full_name: 'Coach Carla', role: 'coach' },
      { full_name: 'Una', role: 'student' },
    ]);

    await db.runFile(migration.paths.rollback);
    expect(await request(db, OWNER, newAccount('new.one@sl.test'))).toBe('');
    expect(await request(db, OWNER, setRole(FREE, 'coach'))).toBe('student');
    expect(await request(db, user(FREE), ownRole(FREE))).toBe('student Renamed');
    await db.drop();
  });

  it('replaces 2 function bodies and signs the ledger — no table, no column, no policy, no trigger, no privilege, no function header', async () => {
    const db = await production();
    const before = await catalogSnapshot(db.query);
    await db.runFile(migration.paths.migration);
    const after = await catalogSnapshot(db.query);

    const lines = diffCatalogs(before, after, { left: 'before', right: 'after' });
    expect(lines.filter((line) => /: only in (before|after)$/.test(line))).toEqual([]);
    expect(lines.map((line) => /^(.*?): (\w+): /.exec(line).slice(1, 3).join(' → '))).toEqual([
      'functions public.handle_new_user() → definition',
      'functions public.profiles_pin_immutable_columns() → definition',
      'data rows of app_private.app_migrations → rows',
    ]);

    const NEW_USER = 'public.handle_new_user()';
    const PIN = 'public.profiles_pin_immutable_columns()';
    // Up to the body, each is the function it was: what PostgREST caches, and
    // what decides as whom it runs.
    const header = (snapshot, key) => snapshot.functions[key].definition.split(/\nAS /)[0];
    for (const key of [NEW_USER, PIN]) {
      expect(header(after, key), key).toBe(header(before, key));
      expect(header(after, key), key).toContain(`\n SET search_path TO 'public', 'pg_temp'`);
      expect(after.functions[key].owner, key).toBe('postgres');
      expect(after.functions[key].privileges, key).toEqual(['postgres: EXECUTE', 'service_role: EXECUTE']);
      expect(before.functions[key].privileges, key).toEqual(after.functions[key].privileges);
    }
    // GoTrue creates the account and holds nothing on public: the profile is
    // written as the owner of the function. The pin runs as whoever writes.
    expect(header(after, NEW_USER)).toContain('SECURITY DEFINER');
    expect(header(after, PIN)).not.toContain('SECURITY DEFINER');
    for (const key of ['auth.users.on_auth_user_created', 'public.profiles.profiles_pin_immutable_columns']) {
      expect(after.triggers[key], key).toBeTruthy();
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
    expect(rows.map((line) => line.n)).toEqual(Array.from({ length: 11 }, (_, i) => i + 1));
    // Written between back-ticks: a value the page gives exactly. The other
    // one is a sentence about production's accounts.
    const exact = rows.filter((line) => /^`.+`$/.test(line.before) && /^`.+`$/.test(line.after))
      .map((line) => ({ ...line, before: line.before.slice(1, -1), after: line.after.slice(1, -1) }));
    expect(rows.filter((line) => !exact.some((e) => e.n === line.n)).map((line) => line.check)).toEqual([LINE.accounts]);
    const onPage = (column) => [
      ...exact.map((line) => [line.n, line.check, line[column]]),
      [11, LINE.accounts, '1 coach(es), 2 athlete(s)'],
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

  it('the page\'s check answers for the name, for the owner and for a signed-in user — and writes nothing', async () => {
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
              (select count(*) from public.profiles where role = 'coach') as coaches, current_user::text as role,
              coalesce(current_setting('request.jwt.claims', true), '') as claims`,
    );
    const UNTOUCHED = { accounts: 3, profiles: 3, coaches: 1, role: 'postgres', claims: '' };
    const answer = (name, owner, signedIn) => 'check only, nothing was written: a new account without a name is called '
      + `"${name}"; you can make it a coach: ${owner}; signed in, it can make itself one: ${signedIn}`;

    expect(await checked()).toBe(answer('', 'NO', 'no'));
    expect(await state()).toEqual(UNTOUCHED);

    await db.runFile(migration.paths.migration);
    expect(await checked()).toBe(answer('sl-check-07', 'yes', 'no'));
    expect(await state()).toEqual(UNTOUCHED);
    // What the page says the command prints.
    expect(page).toContain(`\`${answer('sl-check-07', 'yes', 'no')}\``);
    expect(page).toContain('`… is called ""; you can make it a coach: NO; signed in, it can make itself one: no`');

    // The pin switched off by hand: the answer nobody wants, said in capitals.
    await db.query(`alter table public.profiles disable trigger profiles_pin_immutable_columns`);
    expect(await checked()).toBe(answer('sl-check-07', 'yes', 'YES'));
    expect(page).toContain('`… signed in, it can make itself one: YES`');
    await db.query(`alter table public.profiles enable trigger profiles_pin_immutable_columns`);

    // A rule of later that keeps the account from writing its own profile —
    // here, its UPDATE policy gone. The check has then asked the pin nothing,
    // and says that instead of "no".
    await db.query(`drop policy "Users update own profile" on public.profiles`);
    expect(await checked()).toBe(answer('sl-check-07', 'yes', 'NOT TRIED'));
    expect(page).toContain('`… signed in, it can make itself one: NOT TRIED`');
    expect(await state()).toEqual(UNTOUCHED);

    await db.runFile(migration.paths.rollback);
    expect(await checked()).toBe(answer('', 'NO', 'NOT TRIED'));
    expect(await state()).toEqual(UNTOUCHED);
    await db.drop();
  });

  // "Making a coach": the statement the page gives, the answers of its table,
  // and the page of migration 05 that it sends the reader to for the athletes.
  it('from the SQL editor: the page\'s statement makes a coach, who is then given an athlete with the statement of page 05', async () => {
    const db = await production();
    const makeCoach = statement('update public.profiles p\n   set role = \'coach\'');
    expect(makeCoach, 'the page no longer gives the statement').toContain(`u.email = '<e-mail of the account>'`);
    const run = (sql, address) => attempt(() => db.query.rows(sql.replace('<e-mail of the account>', address)));

    // Without the migration, what the finding described: accepted, and nothing changed.
    expect((await run(makeCoach, 'una@sl.test')).value).toEqual([{ email: 'una@sl.test', full_name: 'Una', role: 'student' }]);
    expect(page).toContain('| one row, with `student` under `role` | the statement was accepted and changed nothing: migration 07 is not in the database');

    await db.runFile(migration.paths.migration);
    // One row, with `coach` under `role`.
    expect((await run(makeCoach, 'una@sl.test')).value).toEqual([{ email: 'una@sl.test', full_name: 'Una', role: 'coach' }]);
    // The other answers of the page's table.
    expect((await run(makeCoach, 'nobody@sl.test')).value).toEqual([]);
    expect((await run(makeCoach, 'alex@sl.test')).error?.message).toBe(IS_AN_ATHLETE({ id: ATHLETE }, 'Alex'));
    expect(page).toContain('| `profile … cannot be made a coach: it is the athlete of a coach` |');
    // Run as a user of the app — the editor's role selector — it does not get as far as a profile.
    for (const actor of [user(COACH), user(ATHLETE)]) {
      expect(await request(db, actor, makeCoach.replace('<e-mail of the account>', 'alex@sl.test').replace(/;\s*$/, '')))
        .toBe('permission denied for table users');
    }
    expect(page).toContain('| `permission denied for table users` | the SQL editor is not running as `postgres`');
    expect(await db.query.rows(`select full_name from public.profiles where role = 'coach' order by 1`))
      .toEqual([{ full_name: 'Coach Carla' }, { full_name: 'Una' }]);

    // "Taking the role back is the same statement with 'student' in place of 'coach'."
    expect(page).toContain('**Taking the role back** is the same statement with `\'student\'` in place of `\'coach\'`.');
    const takeBack = makeCoach.replace(`set role = 'coach'`, `set role = 'student'`);
    expect(takeBack).not.toBe(makeCoach);
    expect((await run(takeBack, 'coach@sl.test')).error?.message).toBe(HAS_ATHLETES({ id: COACH }, 'Coach Carla', 1));
    expect(page).toContain('`profile … cannot stop being a coach: it has N athlete(s)`');

    // The new coach gets an athlete: an account made now — named after its
    // address — and the statement of "Linking an athlete to a coach".
    const page05 = read(manifest.migrations.find((m) => m.order === 5).paths.runbook);
    expect(page).toContain('(05-students-role-gate.md#linking-an-athlete-to-a-coach)');
    expect(page05).toContain('## Linking an athlete to a coach');
    const link = statement('insert into public.students (profile_id, coach_id)', page05);
    await db.query(`insert into auth.users (email, aud, role) values ('nina@sl.test', 'authenticated', 'authenticated')`);
    const linked = await db.query.rows(link.replace('<e-mail of the athlete>', 'nina@sl.test').replace('<e-mail of the coach>', 'una@sl.test'));
    expect(linked).toHaveLength(1);
    expect(linked[0].coach_id).toBe(FREE);

    // "Each coach has a roster … of their own."
    const others = `select string_agg(full_name, ', ' order by full_name) from public.profiles where id <> auth.uid()`;
    expect(await request(db, user(FREE), others)).toBe('nina');
    expect(await request(db, user(COACH), others)).toBe('Alex');
    // …and with an athlete, the new coach does not stop being one either.
    expect((await run(takeBack, 'una@sl.test')).error?.message).toBe(HAS_ATHLETES({ id: FREE }, 'Una', 1));
    await db.query(`delete from public.students where coach_id = '${FREE}'`);
    expect((await run(takeBack, 'una@sl.test')).value).toEqual([{ email: 'una@sl.test', full_name: 'Una', role: 'student' }]);
    await db.drop();
  });

  // Line 10 of the audit, and "Accounts without a name": the accounts made
  // before the migration keep their empty name until somebody names them.
  it('accounts without a name: counted, left alone by the migration, named with the statements of the page', async () => {
    const db = await production();
    // As the dashboard made them before the migration: no name. One of them a
    // name of blanks, one without an address.
    await db.runSql(
      `insert into auth.users (email, aud, role) values ('old.one@sl.test', 'authenticated', 'authenticated');
       insert into auth.users (email, aud, role) values ('old.two@sl.test', 'authenticated', 'authenticated');
       insert into auth.users (email, aud, role, raw_user_meta_data)
         values ('  blank@sl.test', 'authenticated', 'authenticated', '{"full_name": "  "}');
       insert into auth.users (phone, aud, role) values ('+33600000000', 'authenticated', 'authenticated');`,
      'accounts without a name',
    );
    expect(await printedAudit(db)).toMatchObject({ [LINE.nameless]: '4', [LINE.accounts]: '1 coach(es), 6 athlete(s)' });

    await db.runFile(migration.paths.migration);
    expect(await printedAudit(db)).toMatchObject({ [LINE.nameless]: '4', [LINE.name]: 'yes' });
    expect(page).toContain('The migration changes none of those profiles');

    const list = statement('select u.email, p.role, p.created_at::date as since');
    const nameOne = statement('update public.profiles p\n   set full_name = \'<name>\'');
    const nameAll = statement('update public.profiles p\n   set full_name = coalesce(');
    for (const sql of [list, nameOne, nameAll]) expect(sql, 'the page no longer gives the statement').toBeTruthy();

    expect((await db.query.rows(list)).map((line) => `${line.email} ${line.role}`))
      .toEqual(['  blank@sl.test student', 'old.one@sl.test student', 'old.two@sl.test student', 'null student']);

    // One, with the name its owner chose.
    expect(await db.query.rows(nameOne.replace('<name>', 'Old One').replace('<e-mail of the account>', 'old.one@sl.test')))
      .toEqual([{ email: 'old.one@sl.test', full_name: 'Old One' }]);
    expect((await printedAudit(db))[LINE.nameless]).toBe('3');

    // The others at once, the way a new account is named.
    const named = await db.query.rows(nameAll);
    expect(named.sort((a, b) => a.full_name.localeCompare(b.full_name))).toEqual([
      { email: null, full_name: 'Athlete' },
      { email: '  blank@sl.test', full_name: 'blank' },
      { email: 'old.two@sl.test', full_name: 'old.two' },
    ]);
    expect((await printedAudit(db))[LINE.nameless]).toBe('0');
    expect(await db.query.rows(list)).toEqual([]);
    // Exactly what the trigger gives an account made now with the same address.
    expect(await request(db, OWNER, newAccount('old.three@sl.test'))).toBe('old.three');
    // The names that were there are the ones from before.
    expect(await db.query.rows(`select full_name from public.profiles where id in ('${COACH}', '${ATHLETE}', '${FREE}') order by 1`))
      .toEqual([{ full_name: 'Alex' }, { full_name: 'Coach Carla' }, { full_name: 'Una' }]);
    await db.drop();
  });

  it('without migration 06 it says so (SLM02), and its rollback says there is nothing to undo (SLM03)', async () => {
    const db = await scratchDatabase();
    await db.runFile(manifest.baseline);
    const refusals = async () => {
      const before = await catalogSnapshot(db.query);
      const refused = await attempt(() => db.runFile(migration.paths.migration));
      const undone = await attempt(() => db.runFile(migration.paths.rollback));
      expect(diffCatalogs(before, await catalogSnapshot(db.query), { left: 'before', right: 'after' })).toEqual([]);
      return [refused.error?.code, refused.error?.message, undone.error?.code];
    };
    // Without a ledger at all, then with the ledger and the migrations before 06 only.
    const needs = 'needs 2026_10_11_06_pin_student_writes, which is not applied';
    let [code, message, undone] = await refusals();
    expect([code, undone]).toEqual([REFUSAL.predecessorMissing, REFUSAL.notApplied]);
    expect(message).toContain(needs);
    for (const earlier of manifest.migrations.slice(0, 5)) await db.runFile(earlier.paths.migration);
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
    // A handle_new_user made by hand, with an argument: it would keep its body.
    await db.query(`create function public.handle_new_user(p_note text) returns text language sql as 'select p_note'`);
    expect(await refusal()).toContain(`migration ${MIGRATION} would not replace: handle_new_user(text)`);
    await db.query(`drop function public.handle_new_user(text)`);

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
       grant execute on function public.profiles_pin_immutable_columns() to service_role with grant option;
       set local role service_role;
       grant execute on function public.profiles_pin_immutable_columns() to anon;
       COMMIT;`,
      'a function opened by another role',
    );
    const before = await catalogSnapshot(db.query);
    const refused = await attempt(() => db.runFile(migration.paths.migration));
    expect(refused.error?.message).toContain(
      `migration ${MIGRATION} did not get the functions it meant: public.profiles_pin_immutable_columns(): anon may execute it`,
    );
    expect(diffCatalogs(before, await catalogSnapshot(db.query), { left: 'before', right: 'after' })).toEqual([]);
    expect(await db.query.value(`select count(*) from ${LEDGER} where name = $1`, [MIGRATION])).toBe(0);
    await db.drop();
  });

  // Line 4 of the audit, and what the page says of it: "the migration puts
  // it back".
  it('the pin on the role, dropped or switched off by hand, reads "missing" — and the migration puts it back', async () => {
    for (const byHand of [
      `drop trigger profiles_pin_immutable_columns on public.profiles`,
      `alter table public.profiles disable trigger profiles_pin_immutable_columns`,
    ]) {
      const db = await production();
      await db.query(byHand);
      expect(await printedAudit(db), byHand).toMatchObject({ [LINE.pin]: 'missing', [LINE.owner]: 'no' });
      // What "missing" means: any signed-in user makes themselves a coach.
      expect(await request(db, user(FREE), ownRole(FREE)), byHand).toBe('coach Renamed');

      await db.runFile(migration.paths.migration);
      expect(await printedAudit(db), byHand).toMatchObject({ [LINE.pin]: 'in place', [LINE.owner]: 'yes' });
      expect(await request(db, user(FREE), ownRole(FREE)), byHand).toBe('student Renamed');

      // Switched off after the migration, it is not "in place" either.
      await db.query(`alter table public.profiles disable trigger profiles_pin_immutable_columns`);
      expect(await printedAudit(db), byHand).toMatchObject({ [LINE.pin]: 'missing', [LINE.owner]: 'yes', [LINE.links]: 'yes' });
      await db.drop();
    }
    expect(page).toContain('was dropped or switched off by hand, and until now any signed-in user could have made themselves a coach; the migration puts it back');
  });

  // Line 2 of the audit. The trigger on auth.users is the platform's table:
  // the migration does not write it, and says so instead of running where a
  // new body would be called by nothing.
  it('where nothing gives a new account its profile, the audit says "missing" and the migration refuses', async () => {
    const db = await production();
    // `postgres` does not own auth.users and cannot drop a trigger on it; the
    // function it owns takes the trigger with it.
    const direct = await attempt(() => db.query(`drop trigger on_auth_user_created on auth.users`));
    expect(direct.error?.message).toBe('must be owner of relation users');
    const body = await db.query.value(`select pg_get_functiondef('public.handle_new_user()'::regprocedure)`);
    await db.query(`drop function public.handle_new_user() cascade`);
    await db.query(body);
    await db.query(`revoke all on function public.handle_new_user() from public, anon, authenticated`);
    expect(await db.query.value(`select count(*) from pg_trigger where tgrelid = 'auth.users'::regclass and not tgisinternal`)).toBe(0);
    expect(await printedAudit(db)).toMatchObject({ [LINE.profile]: 'missing', [LINE.name]: 'no' });

    const before = await catalogSnapshot(db.query);
    const refused = await attempt(() => db.runFile(migration.paths.migration));
    expect(refused.error?.message).toContain(
      `migration ${MIGRATION}: no trigger on auth.users calls public.handle_new_user(), or it is switched off`,
    );
    expect(diffCatalogs(before, await catalogSnapshot(db.query), { left: 'before', right: 'after' })).toEqual([]);
    expect(await db.query.value(`select count(*) from ${LEDGER} where name = $1`, [MIGRATION])).toBe(0);
    // What the page says of both.
    expect(page).toContain('- **2** reads `missing` — stop and report.');
    expect(page).toContain('| `no trigger on auth.users calls public.handle_new_user()` | line 2 of the audit | stop and report |');

    // …and the page's check, there: the account it makes gets no profile.
    const tried = await attempt(() => db.runSql(pageCheck, 'page check'));
    expect((tried.error.cause ?? tried.error).message)
      .toBe('check only, nothing was written: NOT TRIED: the account made for the check got no profile');
    expect(page).toContain('`… NOT TRIED: the account made for the check got no profile`');
    expect(await db.query.value(`select count(*) from auth.users`)).toBe(3);
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
    expect(await request(db, OWNER, setRole(FREE, 'coach'))).toBe('coach');
    await db.drop();
  });

  // What the rollback page says of a coach made while the migration was in
  // place: the role stays, and nobody can change it any more.
  it('rolled back, a coach made meanwhile stays a coach — and no statement takes the role back', async () => {
    const db = await production();
    await db.runFile(migration.paths.migration);
    await db.query(setRole(FREE, 'coach'));
    await db.runFile(migration.paths.rollback);
    expect(await db.query.value(setRole(FREE, 'student'))).toBe('coach');
    expect(page).toContain('a profile you made a coach while the migration was in place stays a coach');
    await db.drop();
  });
});
