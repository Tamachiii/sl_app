// Who reads the files of the bucket set-videos — migration
// 2026_10_16_25_storage_video_policies (review B7).
//
// A video is two things: a file of storage.objects under its athlete's folder,
// and a row of set_log_videos that names it. Nothing ties the two together in
// the database, so a file can outlive its row: the old file of a replace, the
// file of a deleted video, an upload that was cancelled or refused, each left
// behind when the app's clean-up failed. The athlete reads every file of
// their folder; a coach reads a file of the folder of one of their athletes
// only when a video of that athlete names it.
//
// The first block runs against schema.sql, as the callers the Storage API
// has — the requests written out as the app that is deployed sends them; the
// second applies the migration file itself to the frozen production
// baseline, with the statements of its runbook page read off the page.

import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  asAnon, asService, asUser, attempt, createProgram, createUser, repoRoot, scenario, scratchDatabase, seed,
} from './harness.js';
import { catalogSnapshot, diffCatalogs } from './catalog.js';
import { LEDGER, loadManifest, migrationsBefore, REFUSAL } from '../migrations/manifest.js';

const manifest = loadManifest();
const migration = manifest.migrations.find((m) => m.name === '2026_10_16_25_storage_video_policies');
const read = (file) => fs.readFileSync(path.join(repoRoot, file), 'utf8');
const page = read(migration.paths.runbook);

let ids;
beforeAll(async () => {
  ids = await seed();
});

// ============================================================
// The policies, as the Storage API meets them
// ============================================================
const fileOf = (athlete, slotId, file) => `${athlete.id}/${slotId}/${file}`;

// hooks/useSetVideo.js. The Storage API inserts and deletes the row of
// storage.objects as the caller, under its policies; the app writes the row
// of set_log_videos itself. The deployed app replaces a video in three
// steps — the new file, the row pointed at it, the old file — and the last
// one may fail (removeUnreferenced): the old file stays.
const app = {
  upload: (q, name) => q(`insert into storage.objects (bucket_id, name, owner) values ('set-videos', $1, auth.uid())`, [name]),
  removeFile: (q, name) => q(`delete from storage.objects where bucket_id = 'set-videos' and name = $1`, [name]),
  addVideo: (q, set, storagePath) => q(
    `insert into set_log_videos (set_log_id, storage_path, mime_type, size_bytes) values ($1, $2, 'video/mp4', 1000) returning id`,
    [set, storagePath],
  ),
  moveVideo: (q, set, storagePath) => q(`update set_log_videos set storage_path = $2 where set_log_id = $1`, [set, storagePath]),
  removeVideo: (q, set) => q(`delete from set_log_videos where set_log_id = $1 returning id`, [set]),
};

// What a caller reads of the bucket: the list of the Storage API, and the one
// row createSignedUrl looks for before it signs a link.
const LIST = `select name from storage.objects where bucket_id = 'set-videos' order by name`;
const SIGN = `select count(*) from storage.objects where bucket_id = 'set-videos' and name = $1`;
const as = (who) => (fn) => asUser(who, fn);
const listed = (caller) => caller(async (q) => (await q.rows(LIST)).map((row) => row.name));
const signs = (caller, name) => caller((q) => q.value(SIGN, [name]));

describe('B7 — a coach reads a file of set-videos when a video of their athlete names it', () => {
  it('the file a video names, and not the other files of the folder: a cancelled upload stays the athlete\'s', () => scenario(async () => {
    const [slot] = ids.programA.slots;
    const [set] = ids.programA.setLogs;
    const clip = fileOf(ids.studentA, slot, '1-clip.mp4');
    const cancelled = fileOf(ids.studentA, slot, '2-cancelled.mp4');
    await asUser(ids.studentA, async (a) => {
      await app.upload(a, clip);
      await app.addVideo(a, set, clip);
      // Cancelled after its last byte; the removal of the file failed.
      await app.upload(a, cancelled);
    });

    expect(await listed(as(ids.coach))).toEqual([clip]);
    expect([await signs(as(ids.coach), clip), await signs(as(ids.coach), cancelled)]).toEqual([1, 0]);
    expect(await listed(as(ids.studentA))).toEqual([clip, cancelled]);
    expect([await signs(as(ids.studentA), clip), await signs(as(ids.studentA), cancelled)]).toEqual([1, 1]);

    // The athlete removes it, as migration 08 lets them: the session is in progress.
    expect((await asUser(ids.studentA, (a) => app.removeFile(a, cancelled))).rowCount).toBe(1);
    expect(await listed(as(ids.studentA))).toEqual([clip]);
  }));

  it('the old file of a replace and the file of a deleted video are no longer the coach\'s; the athlete still reads them', () => scenario(async () => {
    const [slot] = ids.programA.slots;
    const [set] = ids.programA.setLogs;
    const clip = fileOf(ids.studentA, slot, '1-clip.mp4');
    const newer = fileOf(ids.studentA, slot, '1-newer.mp4');
    await asUser(ids.studentA, async (a) => {
      await app.upload(a, clip);
      await app.addVideo(a, set, clip);
    });
    expect(await listed(as(ids.coach))).toEqual([clip]);

    // The replace: the new file, the row pointed at it — and the old file, whose removal failed.
    await asUser(ids.studentA, async (a) => {
      await app.upload(a, newer);
      expect((await app.moveVideo(a, set, newer)).rowCount).toBe(1);
    });
    expect(await listed(as(ids.coach))).toEqual([newer]);
    expect(await signs(as(ids.coach), clip)).toBe(0);

    // The delete: the row, and the file whose removal failed.
    expect((await asUser(ids.studentA, (a) => app.removeVideo(a, set))).rowCount).toBe(1);
    expect(await listed(as(ids.coach))).toEqual([]);
    expect(await listed(as(ids.studentA))).toEqual([clip, newer]);
  }));

  it('nobody else reads a file of the athlete: another athlete of the coach, another coach and their athlete, a coach with none, a request without a session; the service role reads them all', () => scenario(async (q) => {
    const olga = await createUser({ email: 'olga@sl.test', fullName: 'Olga Coach', role: 'coach' });
    const dana = await createUser({ email: 'dana@sl.test', fullName: 'Dana Athlete', coach: olga });
    const stranger = await createUser({ email: 'stranger@sl.test', fullName: 'Stranger', role: 'coach' });
    const press = await q.value(`insert into exercise_library (coach_id, name, type, difficulty) values ($1, 'Press', 'push', 1) returning id`, [olga.id]);
    const danaBlock = await createProgram({ student: dana, exercises: [press], active: true });

    const alexClip = fileOf(ids.studentA, ids.programA.slots[0], '1-clip.mp4');
    const alexLeft = fileOf(ids.studentA, ids.programA.slots[0], '2-left.mp4');
    const danaClip = fileOf(dana, danaBlock.slots[0], '1-clip.mp4');
    await asUser(ids.studentA, async (a) => {
      await app.upload(a, alexClip);
      await app.addVideo(a, ids.programA.setLogs[0], alexClip);
      await app.upload(a, alexLeft);
    });
    await asUser(dana, async (d) => {
      await app.upload(d, danaClip);
      await app.addVideo(d, danaBlock.setLogs[0], danaClip);
    });

    expect({
      carla: await listed(as(ids.coach)),
      alex: await listed(as(ids.studentA)),
      billie: await listed(as(ids.studentB)),
      olga: await listed(as(olga)),
      dana: await listed(as(dana)),
      stranger: await listed(as(stranger)),
      anon: await listed(asAnon),
    }).toEqual({
      carla: [alexClip],
      alex: [alexClip, alexLeft],
      billie: [],
      olga: [danaClip],
      dana: [danaClip],
      stranger: [],
      anon: [],
    });
    expect(await listed(asService)).toEqual([alexClip, alexLeft, danaClip].sort());
  }));

  it('after a change of coach the new coach reads the files the videos of the athlete name, and the former coach none', () => scenario(async (q) => {
    const olga = await createUser({ email: 'olga@sl.test', fullName: 'Olga Coach', role: 'coach' });
    const clip = fileOf(ids.studentA, ids.programA.slots[0], '1-clip.mp4');
    const left = fileOf(ids.studentA, ids.programA.slots[0], '2-left.mp4');
    await asUser(ids.studentA, async (a) => {
      await app.upload(a, clip);
      await app.addVideo(a, ids.programA.setLogs[0], clip);
      await app.upload(a, left);
    });
    expect([await listed(as(ids.coach)), await listed(as(olga))]).toEqual([[clip], []]);

    await q(`select public.transfer_student($1, $2)`, [ids.studentA.id, olga.id]);
    expect([await listed(as(ids.coach)), await listed(as(olga))]).toEqual([[], [clip]]);
    expect(await listed(as(ids.studentA))).toEqual([clip, left]);
  }));

  it('a video cannot lend a coach a file of another folder — written by the owner, whom no policy asks', () => scenario(async (q) => {
    const olga = await createUser({ email: 'olga@sl.test', fullName: 'Olga Coach', role: 'coach' });
    const dana = await createUser({ email: 'dana@sl.test', fullName: 'Dana Athlete', coach: olga });
    const press = await q.value(`insert into exercise_library (coach_id, name, type, difficulty) values ($1, 'Press', 'push', 1) returning id`, [olga.id]);
    const danaBlock = await createProgram({ student: dana, exercises: [press], active: true });
    const alexFile = fileOf(ids.studentA, ids.programA.slots[0], '2-left.mp4');
    await asUser(ids.studentA, (a) => app.upload(a, alexFile));

    // A video of Dana — Olga's athlete — that names a file of Alex's folder.
    await app.addVideo(q, danaBlock.setLogs[0], alexFile);
    expect([await listed(as(olga)), await listed(as(ids.coach))]).toEqual([[], []]);
    // A video of Billie — Carla's athlete too — that names it: the file is Alex's, and no video of Alex names it.
    await q(`delete from set_log_videos where set_log_id = $1`, [danaBlock.setLogs[0]]);
    await app.addVideo(q, ids.programB.setLogs[0], alexFile);
    expect(await listed(as(ids.coach))).toEqual([]);
    // A video of Alex that names it: Carla reads it.
    await app.addVideo(q, ids.programA.setLogs[0], alexFile);
    expect(await listed(as(ids.coach))).toEqual([alexFile]);
  }));

  it('a file of another shape is not read and not an error: no folder, a folder that is not an id', () => scenario(async (q) => {
    await q(`insert into storage.objects (bucket_id, name) values ('set-videos', 'loose.mp4'), ('set-videos', 'nobody/x/1-clip.mp4')`);
    await app.addVideo(q, ids.programA.setLogs[0], 'loose.mp4');
    expect([await listed(as(ids.coach)), await listed(as(ids.studentA))]).toEqual([[], []]);
    expect(await listed(asService)).toEqual(['loose.mp4', 'nobody/x/1-clip.mp4']);
  }));

  it('storage.objects keeps its four policies under their names; the coach\'s asks set_log_videos', () => scenario(async (q) => {
    const policies = await q.rows(
      `select polname, polcmd, polroles::regrole[]::text[] as roles, pg_get_expr(polqual, polrelid) as qual
         from pg_policy where polrelid = 'storage.objects'::regclass order by polname`,
    );
    expect(policies.map(({ polname, polcmd, roles }) => [polname, polcmd, roles])).toEqual([
      ['Coaches read student set videos', 'r', ['authenticated']],
      ['Students delete own set videos', 'd', ['authenticated']],
      ['Students read own set videos', 'r', ['authenticated']],
      ['Students upload own set videos', 'a', ['authenticated']],
    ]);
    expect(policies[0].qual).toContain('FROM set_log_videos v');
    expect(policies[0].qual).toContain('(v.storage_path = objects.name)');
    expect(policies[2].qual).toBe("((bucket_id = 'set-videos'::text) AND ((storage.foldername(name))[1] = (auth.uid())::text))");
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
/** A statement the page quotes between double quotes, by its first words. */
const quotedOf = (text, start) => fencesOf(text, 'bash')
  .map((command) => /^supabase db query --linked "(.+)"$/.exec(command)?.[1])
  .find((sql) => sql?.startsWith(start));
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
  expect(await db.query.value(`select count(*) from ${LEDGER} where name = $1`, [migration.name])).toBe(0);
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

describe('migration 2026_10_16_25_storage_video_policies', () => {
  const CARLA = '00000000-0000-4000-8000-00000000c0ac';
  const OLGA = '00000000-0000-4000-8000-00000000c0ad';
  const ALEX = '00000000-0000-4000-8000-0000000000a1';
  const DANA = '00000000-0000-4000-8000-0000000000a4';
  const LINK_ALEX = '00000000-0000-4000-8000-000000000101';
  const LINK_DANA = '00000000-0000-4000-8000-000000000104';
  const SLOT_ALEX = '00000000-0000-4000-8000-000000000501';
  const SLOT_DANA = '00000000-0000-4000-8000-000000000504';
  const SET_ALEX = '00000000-0000-4000-8000-000000000601';
  const SET_DANA = '00000000-0000-4000-8000-000000000604';
  const file = (athlete, slot, name) => `${athlete}/${slot}/${name}`;
  const CLIP = file(ALEX, SLOT_ALEX, '1-clip.mp4');
  const REPLACED = file(ALEX, SLOT_ALEX, '2-replaced.mp4');
  const UPLOADING = file(ALEX, SLOT_ALEX, '3-uploading.mp4');

  // Carla coaches Alex, Olga coaches Dana; each athlete trains a block of one
  // set. Alex's set has a video and its file, the file the video named before
  // a replace (three days old) and an upload under way; Dana's set has a
  // video whose file is gone.
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
    insert into public.exercise_library (id, coach_id, name, type, difficulty) values
      ('00000000-0000-4000-8000-000000000201', '${CARLA}', 'Pull-up', 'pull', 2),
      ('00000000-0000-4000-8000-000000000204', '${OLGA}', 'Press', 'push', 1);
    insert into public.programs (id, student_id, name, is_active) values
      ('00000000-0000-4000-8000-000000000301', '${LINK_ALEX}', 'Block', true),
      ('00000000-0000-4000-8000-000000000304', '${LINK_DANA}', 'Block', true);
    insert into public.weeks (id, program_id, week_number) values
      ('00000000-0000-4000-8000-000000000401', '00000000-0000-4000-8000-000000000301', 1),
      ('00000000-0000-4000-8000-000000000404', '00000000-0000-4000-8000-000000000304', 1);
    insert into public.sessions (id, week_id, title, sort_order) values
      ('00000000-0000-4000-8000-000000000451', '00000000-0000-4000-8000-000000000401', 'Pull', 0),
      ('00000000-0000-4000-8000-000000000454', '00000000-0000-4000-8000-000000000404', 'Push', 0);
    insert into public.exercise_slots (id, session_id, exercise_id, sets, reps, sort_order) values
      ('${SLOT_ALEX}', '00000000-0000-4000-8000-000000000451', '00000000-0000-4000-8000-000000000201', 1, 5, 0),
      ('${SLOT_DANA}', '00000000-0000-4000-8000-000000000454', '00000000-0000-4000-8000-000000000204', 1, 5, 0);
    insert into public.set_logs (id, exercise_slot_id, set_number, done) values ('${SET_ALEX}', '${SLOT_ALEX}', 1, true), ('${SET_DANA}', '${SLOT_DANA}', 1, true);
    insert into public.set_log_videos (set_log_id, storage_path, mime_type, size_bytes) values
      ('${SET_ALEX}', '${CLIP}', 'video/mp4', 1000),
      ('${SET_DANA}', '${file(DANA, SLOT_DANA, '1-gone.mp4')}', 'video/mp4', 1000);
    insert into storage.objects (bucket_id, name, created_at) values
      ('set-videos', '${CLIP}', now() - interval '3 days'),
      ('set-videos', '${REPLACED}', now() - interval '3 days'),
      ('set-videos', '${UPLOADING}', now());
  `;
  const production = () => productionBefore(migration.name, WORLD);
  const FILES = `select coalesce(string_agg(split_part(name, '/', 3), ', ' order by name), 'nothing') from storage.objects where bucket_id = 'set-videos'`;
  const finding = async (db) => ({
    carla: await story(db, user(CARLA), FILES),
    alex: await story(db, user(ALEX), FILES),
    olga: await story(db, user(OLGA), FILES),
    dana: await story(db, user(DANA), FILES),
  });
  const ALL_OF_ALEX = '1-clip.mp4, 2-replaced.mp4, 3-uploading.mp4';
  const OPEN = { carla: ALL_OF_ALEX, alex: ALL_OF_ALEX, olga: 'nothing', dana: 'nothing' };
  const CLOSED = { carla: '1-clip.mp4', alex: ALL_OF_ALEX, olga: 'nothing', dana: 'nothing' };

  it('the coach reads the files no video names before, only the one the video names after, and all of them again after the rollback', async () => {
    const db = await production();
    expect(await finding(db)).toEqual(OPEN);
    await db.runFile(migration.paths.migration);
    expect(await finding(db)).toEqual(CLOSED);
    // The athlete still removes one, as migration 08 lets them.
    expect(await story(db, user(ALEX), `delete from storage.objects where name = '${UPLOADING}' returning 'removed'`)).toBe('removed');
    await db.runFile(migration.paths.rollback);
    expect(await finding(db)).toEqual(OPEN);
    await db.drop();
  });

  it('rewrites one policy under its name and signs the ledger — nothing else', async () => {
    const db = await production();
    const before = await catalogSnapshot(db.query);
    await db.runFile(migration.paths.migration);
    const after = await catalogSnapshot(db.query);
    const { before: gone, after: added, changed } = changesOf(before, after);
    expect({ gone, added }).toEqual({ gone: [], added: [] });
    expect(changed.map((line) => line.split(' → ')[0])).toEqual([
      'data rows of app_private.app_migrations',
      'policies storage.objects.Coaches read student set videos',
    ]);
    expect(await db.query.rows(`select name from ${LEDGER} order by name`)).toHaveLength(24);
    expect(page).toContain(`Expected: twenty-four rows, the last one \`${migration.name}\` — twenty-five where the optional migration 19 was applied at Checkpoint B.`);
    expect(page).toContain('| Kind | required · rewrites 1 policy of `storage.objects` under its name; no table, no column, no row, no file |');
    await db.drop();
  });

  it('its audit prints the "before" and "after" columns of the runbook page, and the page lists the files no video names', async () => {
    const db = await production();
    const table = auditTableOf(page);
    expect(table.map((line) => line.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // Three files of Alex, two no video names, one of them three days old; Dana's video has no file.
    const counted = { 4: '3', 5: '2', 6: '1', 7: '1' };
    const column = (side) => table.map((line) => [line.check, literal(line[side]) ?? counted[line.n]]);
    expect(await printedAudit(db)).toEqual(column('before'));
    const list = quotedOf(page, 'select o.name as file, pa.full_name as athlete');
    expect(list, 'the page no longer lists the files').toBeTruthy();
    const listed = async () => (await db.query.rows(list)).map((row) => [row.file, row.athlete, row.coach_today, row.older_than_a_day]);
    const AS_LISTED = [[REPLACED, 'Alex', 'Coach Carla', true], [UPLOADING, 'Alex', 'Coach Carla', false]];
    expect(await listed()).toEqual(AS_LISTED);
    await db.runFile(migration.paths.migration);
    expect(await printedAudit(db)).toEqual(column('after'));
    expect(await listed()).toEqual(AS_LISTED);
    const header = read(migration.paths.audit).split('\n').filter((line) => line.startsWith('--')).join('\n');
    for (const { check } of table) expect(header).toContain(check);

    // What it says of a policy made by hand, and of a video stored in another athlete's folder.
    await db.query(`create policy "Everyone reads the videos" on storage.objects for select to authenticated using (bucket_id = 'set-videos')`);
    await db.query(`update public.set_log_videos set storage_path = $1 where set_log_id = $2`, [REPLACED, SET_DANA]);
    expect(Object.fromEntries(await printedAudit(db))).toMatchObject({
      'policies that read the files of set-videos and that this migration does not know': '"Everyone reads the videos"',
      '… that no video names': '1',
      'videos whose file is not in set-videos': '0',
      'videos stored outside the folder of their athlete': '1',
    });
    await db.query(`alter policy "Coaches read student set videos" on storage.objects using (bucket_id = 'set-videos')`);
    expect(Object.fromEntries(await printedAudit(db))).toMatchObject({
      'which files of set-videos a coach reads (B7)': "SOMETHING ELSE: (bucket_id = 'set-videos'::text)",
    });
    await db.drop();
  });

  it('the page\'s check answers NOT THERE before and "in place" after, names what is wrong when something is — and writes nothing', async () => {
    const db = await production();
    const check = checkOf(page);
    expect(check, 'the page no longer gives the check').toBeTruthy();
    expect(check).not.toContain("'");
    const state = () => db.query.one(
      `select (select count(*) from auth.users) as accounts, (select count(*) from public.students) as links,
              (select count(*) from public.programs) as blocks, (select count(*) from public.set_logs) as sets,
              (select count(*) from public.set_log_videos) as videos, (select count(*) from storage.objects) as files,
              current_user::text as role, coalesce(current_setting('request.jwt.claims', true), '') as claims`,
    );
    const UNTOUCHED = { accounts: 4, links: 2, blocks: 2, sets: 2, videos: 2, files: 3, role: 'postgres', claims: '' };
    const answer = (said) => `check only, nothing was written: ${said}`;
    const IN_PLACE = answer('in place: a coach reads the file a video of their athlete names, and not the one no video names; '
      + 'the athlete reads both, and another coach neither');

    expect(await runCheck(db, check)).toBe(answer('NOT THERE: a coach reads every file in the folder of one of their athletes'));
    expect(await state()).toEqual(UNTOUCHED);
    await db.runFile(migration.paths.migration);
    expect(await runCheck(db, check)).toBe(IN_PLACE);
    expect(await state()).toEqual(UNTOUCHED);
    expect(page).toContain(`\`${IN_PLACE}\``);
    expect(page).toContain('`… NOT THERE: a coach reads every file in the folder of one of their athletes`');

    // A policy that lets every signed-in user read the bucket.
    await db.query(`create policy "Everyone reads the videos" on storage.objects for select to authenticated using (bucket_id = 'set-videos')`);
    expect(await runCheck(db, check)).toBe(answer('NOT PROTECTED: another coach read named+orphan'));
    await db.query(`drop policy "Everyone reads the videos" on storage.objects`);
    // One that gives the coach back the folder.
    await db.query(`create policy "Coaches read by folder" on storage.objects for select to authenticated
                    using (bucket_id = 'set-videos' and (storage.foldername(name))[1] in (select profile_id::text from public.students where coach_id = auth.uid()))`);
    expect(await runCheck(db, check)).toBe(answer('NOT PROTECTED: the coach read a file that no video names'));
    await db.query(`drop policy "Coaches read by folder" on storage.objects`);
    // A coach's policy that reads nothing; an athlete's that reads nothing.
    const coachRule = await db.query.value(`select pg_get_expr(polqual, polrelid) from pg_policy where polrelid = 'storage.objects'::regclass and polname = 'Coaches read student set videos'`);
    await db.query(`alter policy "Coaches read student set videos" on storage.objects using (false)`);
    expect(await runCheck(db, check)).toBe(answer('NOT THERE: a coach reads every file in the folder of one of their athletes'));
    await db.query(`alter policy "Coaches read student set videos" on storage.objects using (${coachRule} and false)`);
    expect(await runCheck(db, check)).toBe(answer('BROKEN: the coach does not read the file the video of their athlete names'));
    await db.query(`alter policy "Coaches read student set videos" on storage.objects using (${coachRule})`);
    await db.query(`alter policy "Students read own set videos" on storage.objects using (false)`);
    expect(await runCheck(db, check)).toBe(answer('BROKEN: the athlete read none of the two files of their folder, not named+orphan'));
    await db.query(`alter policy "Students read own set videos" on storage.objects using (bucket_id = 'set-videos' and (storage.foldername(name))[1] = auth.uid()::text)`);
    // A project whose files' table refuses a row the SQL editor writes.
    await db.query(`create function public.no_new_files() returns trigger language plpgsql as $$ begin raise exception 'no new files today'; end $$`);
    await db.query(`create trigger no_new_files before insert on storage.objects for each row execute function public.no_new_files()`);
    expect(await runCheck(db, check)).toBe(answer('NOT TRIED: the two files of the check could not be written into storage.objects (no new files today)'));
    expect(page).toContain('`… NOT TRIED: the two files of the check could not be written into storage.objects (…)`');
    await db.query(`drop trigger no_new_files on storage.objects`);
    await db.query(`drop function public.no_new_files()`);

    expect(await runCheck(db, check)).toBe(IN_PLACE);
    expect(await state()).toEqual(UNTOUCHED);
    await db.drop();
  });

  it('without migration 24 it says so (SLM02), and its rollback says there is nothing to undo (SLM03)', async () => {
    const db = await scratchDatabase();
    await db.runFile(manifest.baseline);
    for (const earlier of migrationsBefore(manifest.migrations, '2026_10_16_24_indexes_cleanup')) await db.runFile(earlier.paths.migration);
    const before = await catalogSnapshot(db.query);
    const refused = await attempt(() => db.runFile(migration.paths.migration));
    const undone = await attempt(() => db.runFile(migration.paths.rollback));
    expect(diffCatalogs(before, await catalogSnapshot(db.query), { left: 'before', right: 'after' })).toEqual([]);
    expect([refused.error?.code, undone.error?.code]).toEqual([REFUSAL.predecessorMissing, REFUSAL.notApplied]);
    expect(page).toContain('| `needs 2026_10_16_24_indexes_cleanup, which is not applied` (code `SLM02`) |');
    await db.drop();
  });

  it('refuses to run as another role, next to a policy that reads the bucket and that it does not know, or on a policy changed by hand — and changes nothing', async () => {
    const db = await production();
    const text = read(migration.paths.migration);
    const asServiceRole = text.replace(`SET LOCAL lock_timeout = '5s';`, `SET LOCAL lock_timeout = '5s';\nSET LOCAL ROLE service_role;`);
    expect(await refusalOf(db, () => db.runSql(asServiceRole, 'migration')))
      .toContain(`migration ${migration.name} must be run as postgres, not as service_role`);

    const unknown = `found a policy that reads the files of set-videos and that it does not know:`;
    await db.query(`create policy "Everyone reads the videos" on storage.objects for select to authenticated using (bucket_id = 'set-videos')`);
    expect(await refusalOf(db)).toContain(`${unknown} "Everyone reads the videos"`);
    await db.query(`drop policy "Everyone reads the videos" on storage.objects`);
    // One that names no bucket reads this one too; one of another bucket does not.
    await db.query(`create policy "Signed-in users read every file" on storage.objects for all to authenticated using (true)`);
    await db.query(`create policy "Avatars" on storage.objects for select to authenticated using (bucket_id = 'avatars')`);
    expect(await refusalOf(db)).toContain(`${unknown} "Signed-in users read every file"`);
    await db.query(`drop policy "Signed-in users read every file" on storage.objects`);
    // The athlete's own policy, widened.
    await db.query(`alter policy "Students read own set videos" on storage.objects using (bucket_id = 'set-videos')`);
    expect(await refusalOf(db)).toContain(`${unknown} "Students read own set videos"`);
    await db.query(`alter policy "Students read own set videos" on storage.objects using (bucket_id = 'set-videos' and (storage.foldername(name))[1] = auth.uid()::text)`);

    const asLeft = 'does not find the policy "Coaches read student set videos" of storage.objects as migration 08 left it:';
    await db.query(`alter policy "Coaches read student set videos" on storage.objects using (bucket_id = 'set-videos')`);
    expect(await refusalOf(db)).toContain(`${asLeft} it reads (bucket_id = 'set-videos'::text)`);
    await db.query(`alter policy "Coaches read student set videos" on storage.objects
                    using (bucket_id = 'set-videos' and exists (select 1 from public.set_log_videos v where v.storage_path = objects.name))`);
    expect(await refusalOf(db)).toContain(`${asLeft} it already asks set_log_videos`);
    await db.query(`alter policy "Coaches read student set videos" on storage.objects rename to "Coaches read videos"`);
    expect(await refusalOf(db)).toContain(`${asLeft} it is not there`);
    await db.query(`drop policy "Coaches read videos" on storage.objects`);
    await db.query(`create policy "Coaches read student set videos" on storage.objects for select to authenticated
                    using (bucket_id = 'set-videos' and (storage.foldername(name))[1] in (select profile_id::text from public.students where coach_id = auth.uid()))`);

    for (const said of [
      '| `must be run as postgres` |',
      '| `does not find the policy "Coaches read student set videos" of storage.objects as migration 08 left it: …` |',
      '| `found a policy that reads the files of set-videos and that it does not know: …` |',
    ]) expect(page).toContain(said);
    await db.runFile(migration.paths.migration);
    expect(await db.query.value(`select count(*) from ${LEDGER} where name = $1`, [migration.name])).toBe(1);
    expect(await finding(db)).toEqual(CLOSED);
    await db.drop();
  });

  it('its rollback is refused while the ledger records a later migration, and changes nothing', async () => {
    const db = await production();
    await db.runFile(migration.paths.migration);
    await db.query(`insert into ${LEDGER} (name) values ($1)`, [TO_COME]);
    const before = await catalogSnapshot(db.query);
    const refused = await attempt(() => db.runFile(migration.paths.rollback));
    expect(refused.error?.code).toBe(REFUSAL.stillNeeded);
    expect(diffCatalogs(before, await catalogSnapshot(db.query), { left: 'before', right: 'after' })).toEqual([]);
    await db.drop();
  });
});
