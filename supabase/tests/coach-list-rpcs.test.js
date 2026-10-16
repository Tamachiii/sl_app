// Two lists of the coach answered by the database — migration
// 2026_10_16_26_coach_list_rpcs (optional; the database's half of review
// L18 and P9).
//
// The app folds both lists from the whole history, read row by row, and the
// API answers 1000 rows at most:
//
//   the sessions to review   useAllConfirmations reads every confirmation of
//                            every athlete of the coach; reviewCountsByStudent
//                            counts them per athlete (src/lib/coachRoster.js)
//   the conversations        useConversations reads every message of the
//                            account and folds them per counterpart
//                            (src/hooks/useMessages.js)
//
// The migration adds one function for each, STABLE and SECURITY INVOKER, that
// names its caller:
//
//   coach_review_counts()    (student_id = students.id, to_review), one row
//                            per athlete with sessions to review
//   my_conversations()       one row per counterpart, the newest first: the
//                            plan's five columns (counterpart_id, full_name,
//                            last_body, last_at, unread), then the rest of the
//                            newest message
//
// The first blocks run against schema.sql: on the same rows each function
// answers what the app's fold answers — the folds are copied below, since no
// test of this suite imports src/ — and goes on answering past the 1000 rows
// the app's read is cut at. The last block applies the migration file itself
// to the frozen production baseline, with the audit table and the check of
// its runbook page read off the page.

import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  asAnon, asService, asUser, attempt, createProgram, createUser, repoRoot, scenario, scratchDatabase, seed,
} from './harness.js';
import { catalogSnapshot, diffCatalogs } from './catalog.js';
import { LEDGER, loadManifest, migrationsBefore, REFUSAL } from '../migrations/manifest.js';

const MIGRATION = '2026_10_16_26_coach_list_rpcs';
const manifest = loadManifest();
const migration = manifest.migrations.find((m) => m.name === MIGRATION);
const read = (file) => fs.readFileSync(path.join(repoRoot, file), 'utf8');
const page = read(migration.paths.runbook);

let ids;
beforeAll(async () => {
  ids = await seed();
});

// ============================================================
// What the app folds today, written again here: the reads as the hooks send
// them — under the caller's rights, cut where the API cuts — and the folds
// over them.
// ============================================================
/** The most rows the API answers (PostgREST's db-max-rows). */
const API_ROWS = 1000;

// src/hooks/useSessionConfirmation.js, useAllConfirmations: session → week →
// program → student, every embed !inner, filtered on the coach and on the
// trash, the newest confirmation first.
const confirmationsAsTheAppReads = (q, coach) => q.rows(
  `select c.id, c.session_id, s.reviewed_at, s.archived_at, st.id as student_id
     from public.session_confirmations c
     join public.sessions s  on s.id = c.session_id
     join public.weeks w     on w.id = s.week_id
     join public.programs p  on p.id = w.program_id
     join public.students st on st.id = p.student_id
    where st.coach_id = $1 and p.deleted_at is null
    order by c.confirmed_at desc
    limit ${API_ROWS}`,
  [coach],
);

// src/lib/coachRoster.js:17, reviewCountsByStudent — as it is.
function reviewCountsByStudent(confirmations) {
  const counts = new Map();
  for (const c of confirmations || []) {
    if (c.reviewed_at || c.archived_at) continue;
    if (!c.student_id) continue;
    counts.set(c.student_id, (counts.get(c.student_id) || 0) + 1);
  }
  return counts;
}

const rosterCountsAsTheAppMakesThem = async (q, coach) => (
  Object.fromEntries(reviewCountsByStudent(await confirmationsAsTheAppReads(q, coach)))
);

// src/hooks/useMessages.js:58, useConversations: every message of the
// account, the newest first (`.limit(2000)`, which the API makes 1000),
// folded per counterpart, then the profiles of the counterparts and the order
// of compareConversations (src/lib/messageCache.js). `otherRole` is left out:
// nothing reads it.
async function conversationsAsTheAppFoldsThem(q, me) {
  const rows = await q.rows(
    `select id, sender_id, recipient_id, body, session_id, read_at, created_at
       from public.messages
      where sender_id = $1 or recipient_id = $1
      order by created_at desc
      limit ${API_ROWS}`,
    [me],
  );
  const byOther = new Map();
  for (const m of rows) {
    const other = m.sender_id === me ? m.recipient_id : m.sender_id;
    let conv = byOther.get(other);
    if (!conv) {
      conv = { otherProfileId: other, lastMessage: m, unreadCount: 0 };
      byOther.set(other, conv);
    }
    if (m.recipient_id === me && !m.read_at) conv.unreadCount += 1;
  }
  const otherIds = [...byOther.keys()];
  if (otherIds.length === 0) return [];
  const profiles = await q.rows(`select id, full_name, role from public.profiles where id = any($1::uuid[])`, [otherIds]);
  const byProfile = new Map(profiles.map((p) => [p.id, p]));
  return [...byOther.values()]
    .map((c) => ({ ...c, otherFullName: byProfile.get(c.otherProfileId)?.full_name || null }))
    .sort((a, b) => b.lastMessage.created_at.getTime() - a.lastMessage.created_at.getTime());
}

// ============================================================
// What the two functions answer, in the app's shapes
// ============================================================
const reviewCounts = async (q) => Object.fromEntries(
  (await q.rows(`select student_id, to_review from public.coach_review_counts()`)).map((row) => [row.student_id, row.to_review]),
);
const conversationRows = (q) => q.rows(`select * from public.my_conversations()`);
// A row as the app holds a conversation: the seven columns of a message
// (MESSAGE_COLUMNS in src/lib/messageCache.js) are all there.
const asTheAppHoldsIt = (row) => ({
  otherProfileId: row.counterpart_id,
  otherFullName: row.full_name,
  lastMessage: {
    id: row.last_id,
    sender_id: row.last_sender_id,
    recipient_id: row.last_recipient_id,
    body: row.last_body,
    session_id: row.last_session_id,
    read_at: row.last_read_at,
    created_at: row.last_at,
  },
  unreadCount: row.unread,
});
const conversations = async (q) => (await conversationRows(q)).map(asTheAppHoldsIt);

/** The two answers of one caller: the function's and the app's fold. */
const bothFor = (who) => asUser(who, async (q) => ({
  counts: { db: await reviewCounts(q), app: await rosterCountsAsTheAppMakesThem(q, who.id) },
  conversations: { db: await conversations(q), app: await conversationsAsTheAppFoldsThem(q, who.id) },
}));

const confirm = (q, session, athlete, at = null) => q(
  `insert into public.session_confirmations (session_id, student_id, confirmed_at)
   values ($1, $2, coalesce($3::timestamptz, now()))`,
  [session, athlete.id, at],
);
const T = (minutes) => new Date(Date.UTC(2026, 9, 1, 10, minutes));
const message = (q, from, to, body, { at, read = false, session = null, id = null } = {}) => q.value(
  `insert into public.messages (id, sender_id, recipient_id, body, session_id, read_at, created_at)
   values (coalesce($1::uuid, gen_random_uuid()), $2, $3, $4, $5, case when $6 then $7::timestamptz + interval '1 minute' end, $7)
   returning id`,
  [id, from.id, to.id, body, session, read, at],
);

/** Olga, a second coach, with her athlete Dana and a block of one session. */
async function secondCoach(q) {
  const olga = await createUser({ email: 'olga@sl.test', fullName: 'Olga Coach', role: 'coach' });
  const dana = await createUser({ email: 'dana@sl.test', fullName: 'Dana Athlete', coach: olga });
  const press = await q.value(
    `insert into public.exercise_library (coach_id, name, type, difficulty) values ($1, 'Press', 'push', 1) returning id`,
    [olga.id],
  );
  const block = await createProgram({ student: dana, exercises: [press], active: true });
  return { olga, dana, press, block };
}

// ============================================================
// coach_review_counts()
// ============================================================
describe('coach_review_counts() — the sessions to review of each athlete', () => {
  it('counts what the roster counts: confirmed, neither reviewed nor archived, in a block out of the trash; an athlete with none has no row', () => scenario(async (q) => {
    const A = ids.programA.sessions;
    const [b0] = ids.programB.sessions;
    for (const session of A) await confirm(q, session, ids.studentA);
    await confirm(q, b0, ids.studentB);
    await q(`update public.sessions set reviewed_at = now() where id = $1`, [A[1]]);
    await q(`update public.sessions set archived_at = now() where id = $1`, [A[2]]);
    // A past block in the trash, two sessions confirmed and never reviewed.
    const old = await createProgram({ student: ids.studentA, name: 'Old block', sessions: 2 });
    for (const session of old.sessions) await confirm(q, session, ids.studentA);
    await q(`update public.programs set deleted_at = now() where id = $1`, [old.id]);
    // A block waiting, not active, one session confirmed by hand: counted, as the app counts it.
    const next = await createProgram({ student: ids.studentB, name: 'Next block' });
    await confirm(q, next.sessions[0], ids.studentB);
    // An athlete of the coach with a block and nothing confirmed.
    const casey = await createUser({ email: 'casey@sl.test', fullName: 'Casey Athlete', coach: ids.coach });
    await createProgram({ student: casey, exercises: [ids.exercises.pullUp], active: true });
    // Another coach, and one session of her athlete to review.
    const { olga, dana, block } = await secondCoach(q);
    await confirm(q, block.sessions[0], dana);

    const carla = await bothFor(ids.coach);
    expect(carla.counts.db).toEqual(carla.counts.app);
    expect(carla.counts.db).toEqual({ [ids.studentA.studentRowId]: 2, [ids.studentB.studentRowId]: 2 });
    const theOther = await bothFor(olga);
    expect(theOther.counts.db).toEqual(theOther.counts.app);
    expect(theOther.counts.db).toEqual({ [dana.studentRowId]: 1 });

    // The key is the link (students.id), never the athlete's profile.
    expect(Object.keys(carla.counts.db)).not.toContain(ids.studentA.id);
  }));

  it('an account that coaches and is somebody\'s athlete: its own sessions are not in its counts — the function names the coach, row-level security alone would not', () => scenario(async (q) => {
    const { olga, press } = await secondCoach(q);
    // A link nobody can write any more (migrations 05 and 07), as a dump restore would bring it back.
    await q(`select set_config('session_replication_role', 'replica', true)`);
    const carlaAsAthlete = await q.value(
      `insert into public.students (profile_id, coach_id) values ($1, $2) returning id`, [ids.coach.id, olga.id],
    );
    await q(`select set_config('session_replication_role', 'origin', true)`);
    const own = await createProgram({ student: ids.coach, exercises: [press], active: true });
    await confirm(q, own.sessions[0], ids.coach);
    await confirm(q, ids.programA.sessions[0], ids.studentA);

    const carla = await bothFor(ids.coach);
    expect(carla.counts.db).toEqual(carla.counts.app);
    expect(carla.counts.db).toEqual({ [ids.studentA.studentRowId]: 1 });
    // What row-level security alone lets her read: her own block too.
    const unfiltered = await asUser(ids.coach, (c) => c.rows(
      `select distinct st.id
         from public.session_confirmations sc
         join public.sessions s on s.id = sc.session_id
         join public.weeks w on w.id = s.week_id
         join public.programs p on p.id = w.program_id
         join public.students st on st.id = p.student_id`,
    ));
    expect(unfiltered.map((row) => row.id).sort()).toEqual([carlaAsAthlete, ids.studentA.studentRowId].sort());
    // Her coach counts it.
    expect((await bothFor(olga)).counts.db).toEqual({ [carlaAsAthlete]: 1 });
  }));

  it('another coach, an athlete, the service role and a request without a session get nothing of the coach\'s', () => scenario(async (q) => {
    await confirm(q, ids.programA.sessions[0], ids.studentA);
    await confirm(q, ids.programB.sessions[0], ids.studentB);
    const { olga } = await secondCoach(q);

    expect(await asUser(ids.coach, reviewCounts)).toEqual({ [ids.studentA.studentRowId]: 1, [ids.studentB.studentRowId]: 1 });
    expect(await asUser(olga, reviewCounts)).toEqual({});
    expect(await asUser(ids.studentA, reviewCounts)).toEqual({});
    expect(await asService(reviewCounts)).toEqual({});
    expect(await q.rows(`select * from public.coach_review_counts()`)).toEqual([]);
    const refused = await attempt(() => asAnon(reviewCounts));
    expect(refused.error?.message).toBe('permission denied for function coach_review_counts');
    expect(refused.error.code).toBe('42501');
  }));

  it('past 1000 confirmations, an old session to review is still counted — the app\'s read, cut at 1000, drops it', () => scenario(async (q) => {
    // A thousand sessions of Billie's block, confirmed and reviewed since…
    const [week] = ids.programB.weeks;
    await q(
      `insert into public.sessions (week_id, title, sort_order)
       select $1, 'Session ' || n, 100 + n from generate_series(1, 1000) as n`,
      [week],
    );
    await q(
      `insert into public.session_confirmations (session_id, student_id)
       select s.id, $2 from public.sessions s where s.week_id = $1 and s.sort_order >= 100`,
      [week, ids.studentB.id],
    );
    await q(`update public.sessions set reviewed_at = now() where week_id = $1 and sort_order >= 100`, [week]);
    // … and one of Alex's, confirmed a month ago, never reviewed.
    await confirm(q, ids.programA.sessions[0], ids.studentA, new Date(Date.now() - 30 * 86400e3));

    const carla = await bothFor(ids.coach);
    expect(carla.counts.app).toEqual({});
    expect(carla.counts.db).toEqual({ [ids.studentA.studentRowId]: 1 });
  }));
});

// ============================================================
// my_conversations()
// ============================================================
describe('my_conversations() — the conversations of the caller', () => {
  it('lists what the app folds: the newest message of each pair in its seven columns, the unread ones, both ways, feedback included', () => scenario(async (q) => {
    await q(`delete from public.messages`);
    const { olga, dana } = await secondCoach(q);
    const [session] = ids.programA.sessions;
    await confirm(q, session, ids.studentA);
    const carla = ids.coach;
    const alex = ids.studentA;
    const billie = ids.studentB;
    await message(q, carla, alex, 'Welcome, Alex.', { at: T(1), read: true });
    await message(q, alex, carla, 'Thanks!', { at: T(2) });
    await message(q, alex, carla, 'A question about Monday.', { at: T(3) });
    await message(q, carla, billie, 'Hi Billie.', { at: T(4) });
    await message(q, billie, carla, 'Hello coach.', { at: T(5), read: true });
    // The coach's feedback on a session Alex confirmed (it also marks the session reviewed).
    const feedback = await message(q, carla, alex, 'Good session.', { at: T(6), session });
    await message(q, olga, dana, 'Hi Dana.', { at: T(7) });
    // A profile without a name: the app shows no name, and so does the function.
    await q(`update public.profiles set full_name = '' where id = $1`, [billie.id]);

    for (const who of [carla, alex, billie, olga, dana]) {
      const both = await bothFor(who);
      expect(both.conversations.db, who.email).toEqual(both.conversations.app);
    }

    const rows = await asUser(carla, conversationRows);
    expect(rows.map(({ counterpart_id, full_name, last_body, last_at, unread, last_id, last_sender_id, last_recipient_id, last_session_id, last_read_at }) => ({
      counterpart_id, full_name, last_body, last_at, unread, last_id, last_sender_id, last_recipient_id, last_session_id, read: last_read_at !== null,
    }))).toEqual([
      {
        counterpart_id: alex.id, full_name: 'Alex Athlete', last_body: 'Good session.', last_at: T(6), unread: 2,
        last_id: feedback, last_sender_id: carla.id, last_recipient_id: alex.id, last_session_id: session, read: false,
      },
      {
        counterpart_id: billie.id, full_name: null, last_body: 'Hello coach.', last_at: T(5), unread: 0,
        last_id: expect.any(String), last_sender_id: billie.id, last_recipient_id: carla.id, last_session_id: null, read: true,
      },
    ]);
    // The athlete: one conversation, the coach's feedback not opened yet.
    expect((await asUser(alex, conversationRows)).map((r) => [r.counterpart_id, r.full_name, r.unread, r.last_body]))
      .toEqual([[carla.id, 'Coach Carla', 1, 'Good session.']]);
    // The plan's five columns come first, in its order; the rest of the message after them.
    expect(Object.keys(rows[0])).toEqual([
      'counterpart_id', 'full_name', 'last_body', 'last_at', 'unread',
      'last_id', 'last_sender_id', 'last_recipient_id', 'last_session_id', 'last_read_at',
    ]);
  }));

  it('a counterpart whose profile the caller no longer reads stays in the list, without a name — a change of coach', () => scenario(async (q) => {
    await q(`delete from public.messages`);
    const { olga } = await secondCoach(q);
    await message(q, ids.coach, ids.studentA, 'See you Monday.', { at: T(1) });
    await message(q, ids.studentA, ids.coach, 'See you.', { at: T(2) });
    await q(`select public.transfer_student($1, $2)`, [ids.studentA.id, olga.id]);

    for (const who of [ids.coach, ids.studentA, olga]) {
      const both = await bothFor(who);
      expect(both.conversations.db, who.email).toEqual(both.conversations.app);
    }
    const said = (who) => asUser(who, async (c) => (await conversationRows(c)).map((r) => [r.counterpart_id, r.full_name, r.unread]));
    expect(await said(ids.coach)).toEqual([[ids.studentA.id, null, 1]]);
    expect(await said(ids.studentA)).toEqual([[ids.coach.id, null, 1]]);
    expect(await said(olga)).toEqual([]);
  }));

  it('two messages of a pair at the same time: the one with the greater id is the newest — the app\'s read has no order there', () => scenario(async (q) => {
    await q(`delete from public.messages`);
    const first = '00000000-0000-4000-8000-0000000e0001';
    const second = '00000000-0000-4000-8000-0000000e0002';
    await message(q, ids.studentA, ids.coach, 'One.', { at: T(1), id: second });
    await message(q, ids.coach, ids.studentA, 'Two.', { at: T(1), id: first });
    const [row] = await asUser(ids.coach, conversationRows);
    expect([row.last_id, row.last_body, row.unread]).toEqual([second, 'One.', 1]);
    // Two conversations at the same time: the same rule orders them.
    await message(q, ids.coach, ids.studentB, 'Three.', { at: T(1), id: '00000000-0000-4000-8000-0000000e0003' });
    expect((await asUser(ids.coach, conversationRows)).map((r) => r.last_body)).toEqual(['Three.', 'One.']);
  }));

  it('another coach, an athlete, the service role and a request without a session: their own, or nothing', () => scenario(async (q) => {
    const { olga, dana } = await secondCoach(q);
    await message(q, olga, dana, 'Hi Dana.', { at: T(9) });
    const counterparts = (who) => asUser(who, async (c) => (await conversationRows(c)).map((r) => r.counterpart_id).sort());

    // seed(): coach → A, A → coach, coach → B.
    expect(await counterparts(ids.coach)).toEqual([ids.studentA.id, ids.studentB.id].sort());
    expect(await counterparts(ids.studentA)).toEqual([ids.coach.id]);
    expect(await counterparts(ids.studentB)).toEqual([ids.coach.id]);
    expect(await counterparts(olga)).toEqual([dana.id]);
    expect(await counterparts(dana)).toEqual([olga.id]);
    expect(await asService(conversationRows)).toEqual([]);
    expect(await q.rows(`select * from public.my_conversations()`)).toEqual([]);
    const refused = await attempt(() => asAnon(conversationRows));
    expect(refused.error?.message).toBe('permission denied for function my_conversations');
    expect(refused.error.code).toBe('42501');
  }));

  it('past 1000 messages, an old conversation is still listed with its unread message — the app\'s read, cut at 1000, drops it', () => scenario(async (q) => {
    await q(`delete from public.messages`);
    // A thousand messages with Billie, all opened, in the last hour…
    await q(
      `insert into public.messages (sender_id, recipient_id, body, read_at, created_at)
       select case when n % 2 = 0 then $1::uuid else $2::uuid end,
              case when n % 2 = 0 then $2::uuid else $1::uuid end,
              'Message ' || n, now(), now() - n * interval '1 second'
         from generate_series(1, 1000) as n`,
      [ids.coach.id, ids.studentB.id],
    );
    // … and one of Alex's, a month old, never opened.
    await message(q, ids.studentA, ids.coach, 'Are you there?', { at: new Date(Date.now() - 30 * 86400e3) });

    const carla = await bothFor(ids.coach);
    expect(carla.conversations.app.map((c) => c.otherProfileId)).toEqual([ids.studentB.id]);
    expect(carla.conversations.db.map((c) => [c.otherProfileId, c.unreadCount, c.lastMessage.body])).toEqual([
      [ids.studentB.id, 0, 'Message 1'],
      [ids.studentA.id, 1, 'Are you there?'],
    ]);
  }));
});

// ============================================================
// The two functions in the catalog
// ============================================================
describe('the two functions', () => {
  it('are STABLE, run with the rights of their caller with the search_path pinned, are executable by a signed-in user only — and answer one row per athlete or counterpart', () => scenario(async (q) => {
    const found = await q.rows(
      `select p.proname::text as name, p.provolatile as volatility, p.prosecdef as as_owner, p.proconfig as config,
              pg_get_function_result(p.oid) as answers,
              has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') as users,
              has_function_privilege('service_role', p.oid, 'EXECUTE') as service
         from pg_proc p
        where p.pronamespace = 'public'::regnamespace and p.proname in ('coach_review_counts', 'my_conversations')
        order by p.proname`,
    );
    const same = { volatility: 's', as_owner: false, config: ['search_path=public, pg_temp'], anon: false, users: true, service: true };
    expect(found).toEqual([
      { name: 'coach_review_counts', answers: 'TABLE(student_id uuid, to_review integer)', ...same },
      {
        name: 'my_conversations',
        answers: 'TABLE(counterpart_id uuid, full_name text, last_body text, last_at timestamp with time zone, unread integer, '
          + 'last_id uuid, last_sender_id uuid, last_recipient_id uuid, last_session_id uuid, last_read_at timestamp with time zone)',
        ...same,
      },
    ]);
  }));
});

// ============================================================
// The migration file, on the frozen production baseline
// ============================================================
/** The frozen baseline, `world` written into it, and the migrations before `name` applied. */
const productionBefore = async (name, world) => {
  const db = await scratchDatabase();
  await db.runFile(manifest.baseline);
  await db.runSql(world, 'world');
  for (const earlier of migrationsBefore(manifest.migrations, name)) await db.runFile(earlier.paths.migration);
  return db;
};

// One transaction, always undone (replay-grace.test.js): each step is a
// statement or an actor; the answer is the first value of the last
// statement, or the message of the statement that raised.
const user = (sub) => ({ role: 'authenticated', claims: JSON.stringify({ role: 'authenticated', sub }) });
const NOBODY = { role: 'anon', claims: JSON.stringify({ role: 'anon' }) };
const actor = ({ role, claims }) => `select set_config('role', '${role}', true), set_config('request.jwt.claims', '${claims}', true)`;
const statements = (steps) => steps.map((step) => (typeof step === 'string' ? step : actor(step))).join(';\n');
const story = async (db, ...steps) => {
  const tried = await attempt(() => db.runSql(`BEGIN;\n${statements(steps)};\nROLLBACK;`, 'request'));
  if (!tried.ok) return (tried.error.cause ?? tried.error).message;
  const [found] = tried.value.at(-2).rows;
  return found ? Object.values(found)[0] : null;
};

/** The fenced blocks of a page in a language, without the indent of a list. */
const fencesOf = (text, lang) => [...text.matchAll(new RegExp(`^( *)\`\`\`${lang}\\n([\\s\\S]*?)\\n\\1\`\`\`$`, 'gm'))]
  .map(([, indent, body]) => body.split('\n').map((line) => line.slice(indent.length)).join('\n'));
/** The page's `do $check$` block, pasted between single quotes. */
const checkOf = (text) => fencesOf(text, 'bash')
  .map((command) => /^supabase db query --linked '(do \$check\$[\s\S]+\$check\$)'$/.exec(command)?.[1])
  .find(Boolean);
/** The table of the audit on the page: `{ n, check, before, after }`, back-ticks kept. */
const auditTableOf = (text) => text.split('\n')
  .map((line) => /^\| (\d+) \| (.+?) \| (.+?) \| (.+?) \|$/.exec(line))
  .filter(Boolean)
  .map(([, n, check, before, after]) => ({ n: Number(n), check, before, after }));
const literal = (cell) => (/^`[^`]+`$/.test(cell) ? cell.slice(1, -1) : null);

const printedAudit = async (db) => {
  const [result] = await db.readOnly(read(migration.paths.audit), 'audit');
  return result.rows.map((line) => [line.check, line.value]);
};

/** The page's check: it always fails, and its message is the answer. */
const runCheck = async (db, check) => {
  const tried = await attempt(() => db.runSql(check, 'page check'));
  expect(tried.ok, 'the check must always fail: that is what undoes it').toBe(false);
  return (tried.error.cause ?? tried.error).message;
};

/** What the file says when it refuses — the catalog and the ledger as they were. */
const refusalOf = async (db, run = () => db.runFile(migration.paths.migration)) => {
  const before = await catalogSnapshot(db.query);
  const refused = await attempt(run);
  expect(diffCatalogs(before, await catalogSnapshot(db.query), { left: 'before', right: 'after' })).toEqual([]);
  expect(await db.query.value(`select count(*) from ${LEDGER} where name = $1`, [MIGRATION])).toBe(0);
  return refused.error?.message ?? 'it ran';
};

/** The lines of a catalog diff: `[only before, only after, changed as 'key → what']`. */
const changesOf = (before, after) => {
  const lines = diffCatalogs(before, after, { left: 'before', right: 'after' });
  const only = (side) => lines.filter((line) => line.endsWith(`: only in ${side}`))
    .map((line) => line.slice(0, -`: only in ${side}`.length)).sort();
  const changed = lines.filter((line) => !/: only in (before|after)$/.test(line))
    .map((line) => /^(.*?): (\w+): /.exec(line).slice(1, 3).join(' → ')).sort();
  return { before: only('before'), after: only('after'), changed };
};

const TO_COME = '2099_01_01_99_a_migration_to_come';

describe('migration 2026_10_16_26_coach_list_rpcs', () => {
  const CARLA = '00000000-0000-4000-8000-00000000c0ac';
  const OLGA = '00000000-0000-4000-8000-00000000c0ad';
  const ALEX = '00000000-0000-4000-8000-0000000000a1';
  const DANA = '00000000-0000-4000-8000-0000000000a4';
  const LINK_ALEX = '00000000-0000-4000-8000-000000000101';
  const LINK_DANA = '00000000-0000-4000-8000-000000000104';

  // Carla coaches Alex, Olga coaches Dana. Alex confirmed three sessions of
  // his block — one to review, one reviewed, one archived — and Dana one, to
  // review. Carla wrote to Alex, who opened it and answered; Alex's answer is
  // not opened yet. Olga wrote to Dana.
  const WORLD = `
    insert into auth.users (id, email, aud, role, email_confirmed_at, raw_user_meta_data) values
      ('${CARLA}', 'coach@sl.test', 'authenticated', 'authenticated', now(), '{"full_name": "Coach Carla"}'),
      ('${OLGA}',  'olga@sl.test',  'authenticated', 'authenticated', now(), '{"full_name": "Olga"}'),
      ('${ALEX}',  'alex@sl.test',  'authenticated', 'authenticated', now(), '{"full_name": "Alex"}'),
      ('${DANA}',  'dana@sl.test',  'authenticated', 'authenticated', now(), '{"full_name": "Dana"}');
    BEGIN;
    SET LOCAL session_replication_role = replica;
    update public.profiles set role = 'coach' where id in ('${CARLA}', '${OLGA}');
    COMMIT;
    insert into public.students (id, profile_id, coach_id) values ('${LINK_ALEX}', '${ALEX}', '${CARLA}'), ('${LINK_DANA}', '${DANA}', '${OLGA}');
    insert into public.programs (id, student_id, name, is_active) values
      ('00000000-0000-4000-8000-000000000301', '${LINK_ALEX}', 'Block', true),
      ('00000000-0000-4000-8000-000000000304', '${LINK_DANA}', 'Block', true);
    insert into public.weeks (id, program_id, week_number) values
      ('00000000-0000-4000-8000-000000000401', '00000000-0000-4000-8000-000000000301', 1),
      ('00000000-0000-4000-8000-000000000404', '00000000-0000-4000-8000-000000000304', 1);
    insert into public.sessions (id, week_id, title, sort_order, reviewed_at, archived_at) values
      ('00000000-0000-4000-8000-000000000451', '00000000-0000-4000-8000-000000000401', 'Open', 0, null, null),
      ('00000000-0000-4000-8000-000000000452', '00000000-0000-4000-8000-000000000401', 'Reviewed', 1, now(), null),
      ('00000000-0000-4000-8000-000000000453', '00000000-0000-4000-8000-000000000401', 'Archived', 2, null, now()),
      ('00000000-0000-4000-8000-000000000454', '00000000-0000-4000-8000-000000000404', 'Open', 0, null, null);
    insert into public.session_confirmations (session_id, student_id) values
      ('00000000-0000-4000-8000-000000000451', '${ALEX}'),
      ('00000000-0000-4000-8000-000000000452', '${ALEX}'),
      ('00000000-0000-4000-8000-000000000453', '${ALEX}'),
      ('00000000-0000-4000-8000-000000000454', '${DANA}');
    insert into public.messages (sender_id, recipient_id, body, read_at, created_at) values
      ('${CARLA}', '${ALEX}', 'Welcome', now() - interval '1 hour', now() - interval '2 hours'),
      ('${ALEX}', '${CARLA}', 'Thanks', null, now() - interval '1 hour'),
      ('${OLGA}', '${DANA}', 'Hi Dana', null, now() - interval '3 hours');
  `;
  const production = () => productionBefore(MIGRATION, WORLD);

  const COUNTS = `select string_agg(student_id || '=' || to_review, ', ' order by student_id) from public.coach_review_counts()`;
  const LIST = `select string_agg(counterpart_id || ':' || coalesce(full_name, '-') || ':' || unread || ':' || last_body, ', ' order by last_at desc)
                  from public.my_conversations()`;
  const missing = (name) => `function public.${name}() does not exist`;
  // What the app that is deployed reads, as Carla: the same before and after.
  const APP_READS = `select (select count(*) from public.session_confirmations) || ' confirmations, '
                         || (select count(*) from public.messages) || ' messages'`;
  const rows = (db) => db.query.one(
    `select (select count(*) from public.session_confirmations) as confirmations, (select count(*) from public.messages) as messages,
            (select count(*) from public.sessions where reviewed_at is null and archived_at is null) as open_sessions,
            (select count(*) from public.notifications) as notifications`,
  );

  it('the two functions are not there before, answer the coach, the athlete and the other coach after, and are gone after the rollback — no row is written', async () => {
    const db = await production();
    const before = await rows(db);
    expect(await story(db, user(CARLA), COUNTS)).toBe(missing('coach_review_counts'));
    expect(await story(db, user(CARLA), LIST)).toBe(missing('my_conversations'));
    expect(await story(db, user(CARLA), APP_READS)).toBe('3 confirmations, 2 messages');

    await db.runFile(migration.paths.migration);
    expect(await story(db, user(CARLA), COUNTS)).toBe(`${LINK_ALEX}=1`);
    expect(await story(db, user(CARLA), LIST)).toBe(`${ALEX}:Alex:1:Thanks`);
    expect(await story(db, user(OLGA), COUNTS)).toBe(`${LINK_DANA}=1`);
    expect(await story(db, user(OLGA), LIST)).toBe(`${DANA}:Dana:0:Hi Dana`);
    expect(await story(db, user(ALEX), COUNTS)).toBe(null);
    expect(await story(db, user(ALEX), LIST)).toBe(`${CARLA}:Coach Carla:0:Thanks`);
    expect(await story(db, COUNTS)).toBe(null);
    expect(await story(db, NOBODY, COUNTS)).toBe('permission denied for function coach_review_counts');
    expect(await story(db, NOBODY, LIST)).toBe('permission denied for function my_conversations');
    expect(await story(db, user(CARLA), APP_READS)).toBe('3 confirmations, 2 messages');
    for (const said of [
      '| nobody signed in | `permission denied for function coach_review_counts` | `permission denied for function my_conversations` |',
      '| an athlete | no row |',
      '| the service role, the SQL editor | no row | no row |',
    ]) expect(page).toContain(said);
    expect(await rows(db)).toEqual(before);

    await db.runFile(migration.paths.rollback);
    expect(await story(db, user(CARLA), COUNTS)).toBe(missing('coach_review_counts'));
    expect(await story(db, user(CARLA), LIST)).toBe(missing('my_conversations'));
    expect(await rows(db)).toEqual(before);
    await db.drop();
  });

  it('adds 2 functions and signs the ledger — no table, no column, no policy, no trigger, no privilege of what was there', async () => {
    const db = await production();
    const before = await catalogSnapshot(db.query);
    await db.runFile(migration.paths.migration);
    const after = await catalogSnapshot(db.query);
    const { before: gone, after: added, changed } = changesOf(before, after);
    expect({ gone, added }).toEqual({
      gone: [],
      added: ['functions public.coach_review_counts()', 'functions public.my_conversations()'],
    });
    expect(changed).toEqual(['data rows of app_private.app_migrations → rows']);
    for (const key of ['public.coach_review_counts()', 'public.my_conversations()']) {
      expect(after.functions[key].privileges, key).toEqual(['authenticated: EXECUTE', 'postgres: EXECUTE', 'service_role: EXECUTE']);
      expect(after.functions[key].owner, key).toBe('postgres');
    }

    // The ledger, as the page says it reads: production at Checkpoint C1 has migration 19 too.
    expect(await db.query.rows(`select name from ${LEDGER} order by name`)).toHaveLength(25);
    expect(await db.query.value(`select name from ${LEDGER} order by applied_at desc, name desc limit 1`)).toBe(MIGRATION);
    expect(page).toContain(`Expected: twenty-five rows, the last one \`${MIGRATION}\` — twenty-six where the optional migration 19 was applied at Checkpoint B.`);
    expect(page).toContain('| Kind | optional · expand: adds 2 functions; no table, no column, no policy, no trigger, no row |');
    await db.drop();
  });

  it('its audit prints the "before" and "after" columns of the runbook page, and says which lists the app cuts', async () => {
    const db = await production();
    const table = auditTableOf(page);
    expect(table.map((line) => line.n)).toEqual(Array.from({ length: 14 }, (_, i) => i + 1));
    // Four confirmations, two to review (Alex's open one, Dana's); three
    // messages in two conversations; nobody past 1000.
    const counted = { 9: '4', 10: '2', 11: '0', 12: '3', 13: '2', 14: '0' };
    const column = (side) => table.map((line) => [line.check, literal(line[side]) ?? counted[line.n]]);
    expect(await printedAudit(db)).toEqual(column('before'));
    await db.runFile(migration.paths.migration);
    expect(await printedAudit(db)).toEqual(column('after'));
    const header = read(migration.paths.audit).split('\n').filter((line) => line.startsWith('--')).join('\n');
    for (const { check } of table) expect(header).toContain(check);
    await db.runFile(migration.paths.rollback);
    expect(await printedAudit(db)).toEqual(column('before'));

    // A coach whose roster the app reads cut, an account whose list it reads cut.
    await db.query(
      `insert into public.sessions (week_id, title, sort_order)
       select '00000000-0000-4000-8000-000000000401', 'Session ' || n, 100 + n from generate_series(1, 1000) as n`,
    );
    await db.query(
      `insert into public.session_confirmations (session_id, student_id)
       select id, '${ALEX}' from public.sessions where sort_order >= 100`,
    );
    await db.query(
      `insert into public.messages (sender_id, recipient_id, body, created_at)
       select '${DANA}', '${OLGA}', 'Message ' || n, now() - n * interval '1 second' from generate_series(1, 1000) as n`,
    );
    expect(Object.fromEntries(await printedAudit(db))).toMatchObject({
      'session confirmations': '1004',
      '… of sessions still to review, in a block out of the trash': '1002',
      'coaches whose sessions to review the app counts from more than 1000 confirmations (L18)': '1',
      messages: '1003',
      conversations: '2',
      'accounts whose conversations the app folds from more than 1000 messages (L18)': '2',
    });
    expect(page).toContain('**Line 11 or 14 above `0`** is a coach whose counts, or an account whose list of conversations, the app that is deployed reads cut');
    await db.drop();
  });

  it('the page\'s check answers NOT THERE before and "in place" after, names what is wrong when something is — and writes nothing', async () => {
    const db = await production();
    const check = checkOf(page);
    expect(check, 'the page no longer gives the check').toBeTruthy();
    // Pasted between single quotes in a shell: it may not hold one.
    expect(check).not.toContain("'");
    const state = () => db.query.one(
      `select (select count(*) from auth.users) as accounts, (select count(*) from public.students) as links,
              (select count(*) from public.programs) as blocks, (select count(*) from public.sessions) as sessions,
              (select count(*) from public.session_confirmations) as confirmations, (select count(*) from public.messages) as messages,
              (select count(*) from public.notifications) as notifications,
              current_user::text as role, coalesce(current_setting('request.jwt.claims', true), '') as claims`,
    );
    const UNTOUCHED = {
      accounts: 4, links: 2, blocks: 2, sessions: 4, confirmations: 4, messages: 3, notifications: await db.query.value(`select count(*) from public.notifications`),
      role: 'postgres', claims: '',
    };
    const answer = (said) => `check only, nothing was written: ${said}`;
    const IN_PLACE = answer('in place: a coach reads the sessions to review of each athlete and their conversations in one request each; '
      + 'the athlete reads their own conversation, and another coach nothing');

    expect(await runCheck(db, check)).toBe(answer('NOT THERE: the two functions are not in the database'));
    expect(await state()).toEqual(UNTOUCHED);
    await db.runFile(migration.paths.migration);
    expect(await runCheck(db, check)).toBe(IN_PLACE);
    expect(await state()).toEqual(UNTOUCHED);
    expect(page).toContain(`\`${IN_PLACE}\``);
    expect(page).toContain('`… NOT THERE: the two functions are not in the database`');

    // Each function made wrong by hand, one at a time, then put back.
    const replace = async (signature, body) => {
      const was = await db.query.value(`select pg_get_functiondef($1::regprocedure)`, [signature]);
      await db.query(body);
      const said = await runCheck(db, check);
      await db.query(was);
      expect(await runCheck(db, check), `${signature} put back`).toBe(IN_PLACE);
      return said;
    };
    const COUNTS_HEAD = `create or replace function public.coach_review_counts() returns table (student_id uuid, to_review integer)
       language sql stable set search_path = public, pg_temp`;
    const LIST_HEAD = `create or replace function public.my_conversations() returns table (counterpart_id uuid, full_name text,
       last_body text, last_at timestamptz, unread integer, last_id uuid, last_sender_id uuid, last_recipient_id uuid,
       last_session_id uuid, last_read_at timestamptz) language sql stable set search_path = public, pg_temp`;
    // Run as their owner and without naming the caller: every coach's athletes.
    expect(await replace('public.coach_review_counts()', `${COUNTS_HEAD} security definer as $$
       select st.id, count(*)::integer from public.session_confirmations c join public.sessions s on s.id = c.session_id
         join public.weeks w on w.id = s.week_id join public.programs p on p.id = w.program_id
         join public.students st on st.id = p.student_id group by st.id $$`))
      .toBe(answer('NOT PROTECTED: another coach read sessions to review or conversations that are not theirs'));
    // Counting the reviewed and the archived sessions too.
    expect(await replace('public.coach_review_counts()', `${COUNTS_HEAD} as $$
       select st.id, count(*)::integer from public.session_confirmations c join public.sessions s on s.id = c.session_id
         join public.weeks w on w.id = s.week_id join public.programs p on p.id = w.program_id
         join public.students st on st.id = p.student_id where st.coach_id = auth.uid() group by st.id $$`))
      .toBe(answer('BROKEN: the coach counts athlete:3, not athlete:1'));
    // Every message counted as opened.
    const was = await db.query.value(`select pg_get_functiondef('public.my_conversations()'::regprocedure)`);
    expect(await replace('public.my_conversations()', was.replace('AS unread', 'AS unread_was').replace('k.unread,', '0,')))
      .toBe(answer('BROKEN: the coach lists athlete:0:sl-check-26 thanks, not athlete:1:sl-check-26 thanks'));
    // The oldest message as the last one.
    expect(await replace('public.my_conversations()', `${LIST_HEAD} as $$
       select distinct on (c) c, null::text, m.body, m.created_at, 0, m.id, m.sender_id, m.recipient_id, m.session_id, m.read_at
         from public.messages m cross join lateral (select case when m.sender_id = auth.uid() then m.recipient_id else m.sender_id end) x (c)
        where auth.uid() in (m.sender_id, m.recipient_id) order by c, m.created_at $$`))
      .toBe(answer('BROKEN: the coach lists athlete:0:sl-check-26 welcome, not athlete:1:sl-check-26 thanks'));
    expect(page).toContain('- `… NOT PROTECTED: …` or `… BROKEN: …` — a function does not do what this page says: **roll back**, and report the full message.');

    // Where nobody can be made a coach (migration 07 undone by hand).
    const pin = await db.query.value(`select pg_get_functiondef('public.profiles_pin_immutable_columns()'::regprocedure)`);
    await db.query(`create or replace function public.profiles_pin_immutable_columns() returns trigger
      language plpgsql set search_path = public, pg_temp as $$ begin NEW.role := OLD.role; return NEW; end $$`);
    expect(await runCheck(db, check)).toBe(answer('NOT TRIED: the accounts made for the check could not be made coaches'));
    expect(page).toContain('- `… NOT TRIED: the accounts made for the check could not be made coaches` — migration 07 is not in the database');
    await db.query(pin);

    expect(await runCheck(db, check)).toBe(IN_PLACE);
    expect(await state()).toEqual(UNTOUCHED);
    await db.drop();
  });

  it('without migration 25 it says so (SLM02), and its rollback says there is nothing to undo (SLM03)', async () => {
    const db = await scratchDatabase();
    await db.runFile(manifest.baseline);
    const refusals = async () => {
      const before = await catalogSnapshot(db.query);
      const refused = await attempt(() => db.runFile(migration.paths.migration));
      const undone = await attempt(() => db.runFile(migration.paths.rollback));
      expect(diffCatalogs(before, await catalogSnapshot(db.query), { left: 'before', right: 'after' })).toEqual([]);
      return [refused.error?.code, refused.error?.message, undone.error?.code];
    };
    // Without a ledger at all, then with the ledger and the migrations before 25 only.
    const needs = 'needs 2026_10_16_25_storage_video_policies, which is not applied';
    let [code, message, undone] = await refusals();
    expect([code, undone]).toEqual([REFUSAL.predecessorMissing, REFUSAL.notApplied]);
    expect(message).toContain(needs);
    for (const earlier of migrationsBefore(manifest.migrations, '2026_10_16_25_storage_video_policies')) await db.runFile(earlier.paths.migration);
    [code, message, undone] = await refusals();
    expect([code, undone]).toEqual([REFUSAL.predecessorMissing, REFUSAL.notApplied]);
    expect(message).toContain(needs);
    expect(page).toContain(`| \`${needs}\` (code \`SLM02\`) |`);
    await db.drop();
  });

  it('refuses to run as another role, next to a function of one of its names, or without a column it reads — and changes nothing', async () => {
    const db = await production();
    const text = read(migration.paths.migration);
    const asServiceRole = text.replace(`SET LOCAL lock_timeout = '5s';`, `SET LOCAL lock_timeout = '5s';\nSET LOCAL ROLE service_role;`);
    expect(asServiceRole).not.toBe(text);
    expect(await refusalOf(db, () => db.runSql(asServiceRole, 'migration')))
      .toContain(`migration ${MIGRATION} must be run as postgres, not as service_role`);
    expect(page).toContain('| `must be run as postgres` |');

    // With other arguments: it would stay next to the new one, and the audit says so.
    await db.query(`create function public.my_conversations(p_limit integer) returns setof uuid language sql as 'select null::uuid'`);
    expect(await refusalOf(db)).toContain(`migration ${MIGRATION} would not create: my_conversations(integer) is already there`);
    expect(Object.fromEntries(await printedAudit(db))).toMatchObject({
      'functions of these names that the migration does not know': 'my_conversations(integer)',
      'the conversations of an account are listed by the database (my_conversations, L18)': 'no',
    });
    await db.query(`drop function public.my_conversations(integer)`);
    // With the same arguments: the audit reads `yes`, and the ledger does not know why.
    await db.query(`create function public.coach_review_counts() returns setof uuid language sql as 'select null::uuid'`);
    expect(await refusalOf(db)).toContain(`migration ${MIGRATION} would not create: coach_review_counts() is already there`);
    expect(Object.fromEntries(await printedAudit(db))).toMatchObject({
      'functions of these names that the migration does not know': 'none',
      'the sessions to review of each athlete are counted by the database (coach_review_counts, L18)': 'yes',
    });
    await db.query(`drop function public.coach_review_counts()`);
    expect(page).toContain('| `would not create: … is already there` |');
    expect(page).toContain('If it is not, a function of that name was made by hand: stop and report.');

    // A column it reads, renamed by hand.
    await db.query(`alter table public.sessions rename column archived_at to archived`);
    await db.query(`alter table public.messages rename column read_at to opened_at`);
    expect(await refusalOf(db)).toContain(
      `migration ${MIGRATION} does not find the columns its functions are written with: public.messages.read_at, public.sessions.archived_at`,
    );
    await db.query(`alter table public.sessions rename column archived to archived_at`);
    await db.query(`alter table public.messages rename column opened_at to read_at`);
    expect(page).toContain('| `does not find the columns its functions are written with: …` |');

    // Whoever runs it, and with whatever search_path: the same database as applied the usual way.
    const elsewhere = text.replace(`SET LOCAL lock_timeout = '5s';`, `SET LOCAL lock_timeout = '5s';\nSET LOCAL search_path = pg_catalog;`);
    await db.runSql(elsewhere, 'migration');
    const other = await production();
    await other.runFile(migration.paths.migration);
    expect(diffCatalogs(await catalogSnapshot(other.query), await catalogSnapshot(db.query), { left: 'usual', right: 'pg_catalog' }))
      .toEqual([]);
    await other.drop();
    await db.drop();
  });

  // The privileges stand next to each function: what a new function is born
  // with is not this file's to rely on.
  it('applied where a new function is born open to everybody, the two are still closed to a request without a session', async () => {
    const db = await production();
    // Supabase's own defaults, as they were before migration 03.
    await db.query(`alter default privileges for role postgres grant execute on functions to public`);
    await db.query(`alter default privileges for role postgres in schema public grant execute on functions to anon, authenticated`);
    await db.runFile(migration.paths.migration);
    expect(Object.fromEntries(await printedAudit(db))).toMatchObject({
      'functions of this migration a request without a session may execute': 'none',
      'functions of this migration a signed-in user may execute': 'coach_review_counts(); my_conversations()',
    });
    expect(await story(db, NOBODY, COUNTS)).toBe('permission denied for function coach_review_counts');
    await db.runFile(migration.paths.rollback);

    // … and a file that forgot one of them reads its own result back, and undoes itself.
    const text = read(migration.paths.migration);
    const forgot = text.replace('REVOKE ALL ON FUNCTION public.my_conversations() FROM PUBLIC, anon, authenticated;\n', '');
    expect(forgot).not.toBe(text);
    expect(await refusalOf(db, () => db.runSql(forgot, 'migration'))).toContain(
      `migration ${MIGRATION} did not get the functions it meant: public.my_conversations(): anon may execute it, PUBLIC may execute it`,
    );
    // One that runs as its owner, one that is not STABLE.
    const definer = text.replace(/(CREATE FUNCTION public\.coach_review_counts\(\)\n[^$]*?)SECURITY INVOKER/, '$1SECURITY DEFINER');
    expect(definer).not.toBe(text);
    expect(await refusalOf(db, () => db.runSql(definer, 'migration'))).toContain(
      `migration ${MIGRATION} did not get the functions it meant: public.coach_review_counts(): it runs as its owner`,
    );
    const volatile = text.replace(/(CREATE FUNCTION public\.my_conversations\(\)\n[^$]*?)STABLE\n/, '$1VOLATILE\n');
    expect(volatile).not.toBe(text);
    expect(await refusalOf(db, () => db.runSql(volatile, 'migration'))).toContain(
      `migration ${MIGRATION} did not get the functions it meant: public.my_conversations(): it is not STABLE`,
    );
    expect(page).toContain('| `did not get the functions it meant: …` |');
    await db.drop();
  });

  // Optional: nothing may need it, and its rollback is the way out of a choice.
  it('its rollback is not refused while the ledger records a later migration, and the migration applies again on what it left', async () => {
    const db = await production();
    await db.runFile(migration.paths.migration);
    await db.query(`insert into ${LEDGER} (name) values ($1)`, [TO_COME]);
    await db.runFile(migration.paths.rollback);
    expect(await db.query.rows(`select name from ${LEDGER} where name in ($1, $2) order by name`, [MIGRATION, TO_COME]))
      .toEqual([{ name: TO_COME }]);
    expect(await story(db, user(CARLA), COUNTS)).toBe(missing('coach_review_counts'));
    expect(page).toContain('It is **not** refused while a later migration is in the ledger');
    expect(read(migration.paths.rollback)).not.toContain('SLM04');

    // A function of one of the names made AFTERWARDS, with other arguments, is not the rollback's to drop.
    await db.query(`delete from ${LEDGER} where name = $1`, [TO_COME]);
    await db.runFile(migration.paths.migration);
    await db.query(`create function public.coach_review_counts(p_coach uuid) returns integer language sql as 'select 0'`);
    await db.runFile(migration.paths.rollback);
    expect(await db.query.value(`select to_regprocedure('public.coach_review_counts(uuid)') is not null`)).toBe(true);
    await db.query(`drop function public.coach_review_counts(uuid)`);
    // …and the migration applies again on what the rollback left.
    await db.runFile(migration.paths.migration);
    expect(await story(db, user(CARLA), COUNTS)).toBe(`${LINK_ALEX}=1`);
    await db.drop();
  });
});
