// Who has an account — the query of docs/runbook/20-auth-config.md.
//
// Public sign-up was open in production until Checkpoint A0 (finding L5).
// Closing it is a dashboard setting; it does not remove an account somebody
// made while it was open. So the page asks the owner to read the list of
// accounts once, and says what each kind of line means.
//
// The query lives on the page, not in supabase/audits/ (those files belong to
// the migrations of the manifest). It is read off the page here: what is tested
// is the statement the owner will run, on the accounts the review worried
// about, against what the page says each of them looks like.

import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  asAdmin, asAnon, asUser, attempt, createUser, repoRoot, scenario, scratchDatabase, seed,
} from './harness.js';

const PAGE = 'docs/runbook/20-auth-config.md';
const page = fs.readFileSync(path.join(repoRoot, PAGE), 'utf8');
// On the page the statement is the argument of the CLI, between double quotes.
const [, accounts] = /^supabase db query --linked "\n(select u\.email[^"]+)\n"$/m.exec(page) ?? [];

let ids;
beforeAll(async () => { ids = await seed(); });

const byEmail = (rows) => Object.fromEntries(rows.map(({ email, ...rest }) => [email, rest]));
const today = () => asAdmin((q) => q.value(`select current_date::text`));

// An account as the open sign-up made it: a row in auth.users and the profile
// the trigger gave it. No name (the API call carried no metadata), no coach.
// Sign-up was open BEFORE migration 07, which names every new account after
// its address: the profile is given the empty name those accounts have.
const signUp = async (q, email, { confirmed = true } = {}) => {
  const id = await q.value(
    `insert into auth.users (email, aud, role, email_confirmed_at, raw_user_meta_data)
     values ($1, 'authenticated', 'authenticated', $2, '{}')
     returning id`,
    [email, confirmed ? new Date() : null],
  );
  await q(`update public.profiles set full_name = '' where id = $1`, [id]);
  return id;
};

// A `students` row nobody should have been able to write (finding L2). The
// triggers are stepped around, as a dump restore does: the row stands for one
// that was written while the hole was open, whatever guards exist by now.
const forgeLink = async (q, { coach, athlete }) => {
  await q(`select set_config('session_replication_role', 'replica', true)`);
  await q(`insert into public.students (coach_id, profile_id) values ($1, $2)`, [coach, athlete]);
  await q(`select set_config('session_replication_role', 'origin', true)`);
};

describe(`${PAGE}: who has an account`, () => {
  it('is on the page, as one statement the shell quotes around it leave alone', () => {
    expect(accounts, `${PAGE} has no \`supabase db query --linked "select u.email …"\` block`).toBeTruthy();
    expect(accounts).toMatch(/^select /);
    expect(accounts).not.toContain(';');
    // Inside double quotes, bash still reads these.
    expect(accounts).not.toMatch(/[$`\\!]/);
  });

  // The way an audit file of a migration is run: BEGIN TRANSACTION READ ONLY,
  // where any write raises (sql.test.js holds that for db.readOnly itself).
  it('runs in a read-only transaction', async () => {
    const db = await scratchDatabase({ from: 'schema' });
    await db.query(
      `insert into auth.users (email, aud, role) values ('someone@sl.test', 'authenticated', 'authenticated')`,
    );
    const [result] = await db.readOnly(accounts, 'the account list');
    expect(result.rows).toEqual([{
      email: 'someone@sl.test',
      created: await db.query.value(`select current_date::text`),
      confirmed: false,
      last_sign_in: null,
      role: 'student',
      coach: '-',
      athletes: 0,
    }]);
    await db.drop();
  });

  it('on a clean project: the coach, and each athlete under the name of their coach', async () => {
    const day = await today();
    expect(byEmail(await asAdmin((q) => q.rows(accounts)))).toEqual({
      'coach@sl.test': {
        created: day, confirmed: true, last_sign_in: null, role: 'coach', coach: '-', athletes: 2,
      },
      'alex@sl.test': {
        created: day, confirmed: true, last_sign_in: null, role: 'student', coach: 'Coach Carla', athletes: 0,
      },
      'billie@sl.test': {
        created: day, confirmed: true, last_sign_in: null, role: 'student', coach: 'Coach Carla', athletes: 0,
      },
    });
  });

  it('shows an account made through the open sign-up, confirmed or not', () => scenario(async (q) => {
    await signUp(q, 'stranger@elsewhere.test');
    await signUp(q, 'never-confirmed@elsewhere.test', { confirmed: false });
    await q(
      `update auth.users set last_sign_in_at = '2026-08-30 21:15+00' where email = 'stranger@elsewhere.test'`,
    );

    const rows = byEmail(await q.rows(accounts));
    expect(Object.keys(rows)).toHaveLength(5);
    // `student`, `-` under `coach`: no coach.
    expect(rows['stranger@elsewhere.test']).toMatchObject({
      confirmed: true, last_sign_in: '2026-08-30', role: 'student', coach: '-', athletes: 0,
    });
    expect(rows['never-confirmed@elsewhere.test']).toMatchObject({
      confirmed: false, last_sign_in: null, role: 'student', coach: '-', athletes: 0,
    });
  }));

  it('shows a forged coach link on both of its lines', () => scenario(async (q) => {
    // The attack of finding L2: an account names itself the coach of the coach.
    const stranger = await signUp(q, 'stranger@elsewhere.test');
    await forgeLink(q, { coach: stranger, athlete: ids.coach.id });

    const rows = byEmail(await q.rows(accounts));
    // `student`, `athletes` above 0.
    expect(rows['stranger@elsewhere.test']).toMatchObject({ role: 'student', coach: '-', athletes: 1 });
    // `coach`, something under `coach` — the id, because that account has no name.
    expect(rows['coach@sl.test']).toMatchObject({ role: 'coach', coach: stranger, athletes: 2 });
    // The real athletes read as before.
    expect(rows['alex@sl.test']).toMatchObject({ role: 'student', coach: 'Coach Carla', athletes: 0 });
  }));

  it('names the coach of an athlete linked by hand, and counts them for that coach', () => scenario(async (q) => {
    const other = await createUser({ email: 'second-coach@sl.test', fullName: 'Coach Dana', role: 'coach' });
    await createUser({ email: 'casey@sl.test', fullName: 'Casey Athlete', coach: other });

    const rows = byEmail(await q.rows(accounts));
    expect(rows['second-coach@sl.test']).toMatchObject({ role: 'coach', coach: '-', athletes: 1 });
    expect(rows['casey@sl.test']).toMatchObject({ role: 'student', coach: 'Coach Dana', athletes: 0 });
    expect(rows['coach@sl.test']).toMatchObject({ athletes: 2 });
  }));

  it('says when an account has no profile', () => scenario(async (q) => {
    const orphan = await signUp(q, 'orphan@elsewhere.test');
    await q(`delete from public.profiles where id = $1`, [orphan]);

    expect(byEmail(await q.rows(accounts))['orphan@elsewhere.test']).toMatchObject({
      role: 'no profile', coach: '-', athletes: 0,
    });
  }));

  it('lists the oldest account first', () => scenario(async (q) => {
    await signUp(q, 'stranger@elsewhere.test');
    await q(`update auth.users set created_at = '2026-09-12 08:00+00' where email = 'stranger@elsewhere.test'`);
    await q(`update auth.users set created_at = '2025-11-02 08:00+00' where email = 'coach@sl.test'`);
    await q(`update auth.users set created_at = '2026-01-20 08:00+00' where email = 'billie@sl.test'`);
    await q(`update auth.users set created_at = '2026-01-20 08:00+00' where email = 'alex@sl.test'`);

    expect((await q.rows(accounts)).map(({ email, created }) => `${created} ${email}`)).toEqual([
      '2025-11-02 coach@sl.test',
      '2026-01-20 alex@sl.test',
      '2026-01-20 billie@sl.test',
      '2026-09-12 stranger@elsewhere.test',
    ]);
  }));

  // The list of e-mail addresses is for the owner: it needs the SQL editor or
  // the CLI, and no key of the API reads it.
  it('is out of reach of the API: anon and a signed-in user are refused', async () => {
    for (const run of [asAnon, (fn) => asUser(ids.coach, fn), (fn) => asUser(ids.studentA, fn)]) {
      const tried = await attempt(() => run((q) => q.rows(accounts)));
      expect(tried.ok).toBe(false);
      expect(tried.error.code).toBe('42501');
    }
  });
});
