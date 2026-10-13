// Where pg_cron is switched on, four jobs run on a timer — the scheduled
// halves of review findings P10, L27 and P35; the OPTIONAL migration
// 2026_10_13_19_pg_cron_jobs.
//
// THE CHOICE
//   pg_cron is an extension the owner of the project switches on, or does
//   not. Production does not have it, and neither has the database the rest
//   of the suite runs on. Without it a rest push is sent through the
//   dispatch-rest-push Edge Function, run_retention() is run by hand, and a
//   push request that failed is in the log of a function. Migrations 15 to 18
//   are complete without this one.
//
// THE RULES, each held below:
//   the four jobs       sl-rest-push (every 10 seconds, the dispatcher of
//                       migration 16), sl-retention (every night, the
//                       function of migration 18), sl-push-failures (every
//                       hour, the function of this migration), sl-cron-history
//                       (every night, three days of pg_cron's own runs). Each
//                       once, switched on, of postgres, in this database —
//                       and one text in the migration, schema.sql, the audit,
//                       the rollback and the two pages.
//   the name is a contract
//                       schedule_rest_push answers mode 'cron' while a job
//                       named sl-rest-push is there and switched on, and
//                       'edge' otherwise.
//   record_push_failures()
//                       one line per hour that is over and in which a request
//                       of pg_net was not answered with a status from 200 to
//                       299: role 'database', how many of how many, what
//                       kind. Each hour once. For the owner and the service
//                       role; SECURITY INVOKER.
//   without the extension
//                       the migration refuses (SLM06) and changes nothing;
//                       schema.sql leaves the whole block out, and does not
//                       sign the ledger for it.
//   the rollback        is the way out of a choice: never refused for a later
//                       migration, and it works where the extension was
//                       switched off first.
//
// WHERE THE TESTS RUN. Not in the database of this file: that one is
// production as it is, and the first block says so. A project that has
// pg_cron is a scratchDatabase() with the stub switched on — `home`, installed
// from schema.sql, for the jobs and the function; the frozen baseline with
// migrations 01 to 18, for the file itself. A request of a user of the API is
// a transaction that sets the role and the claims the way PostgREST does.
//
// SHIM LIMITS: pg_cron is a stub (shim-pg-cron.sql) in which NOTHING RUNS A
// JOB — a test runs the command of a job itself, as postgres, which is the
// role the job runs as, and writes the row of a run itself. pg_net is a stub
// that never answers: a test writes into net._http_response what a request
// would have been answered.

import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  asAdmin, asUser, attempt, createUser, repoRoot, scenario, scratchDatabase,
} from './harness.js';
import { catalogSnapshot, diffCatalogs } from './catalog.js';
import {
  installedBySchemaSql, LEDGER, loadManifest, migrationsBefore, REFUSAL,
} from '../migrations/manifest.js';

const MIGRATION = '2026_10_13_19_pg_cron_jobs';
const manifest = loadManifest();
const migration = manifest.migrations.find((m) => m.name === MIGRATION);
const read = (file) => fs.readFileSync(path.join(repoRoot, file), 'utf8');

const SCHEMA_SQL = 'supabase/schema.sql';
const DECISION_PAGE = 'docs/runbook/50-pg-cron.md';
const ADMIN_PAGE = 'docs/runbook/70-admin-procedures.md';
const RECORD = 'public.record_push_failures()';

// ------------------------------------------------------------
// The four jobs, by name. THIS IS THE LIST: the migration, schema.sql, the
// audit, the rollback and the two pages are held to it below.
// ------------------------------------------------------------
const HISTORY = `delete from cron.job_run_details where runid < (select coalesce(min(runid), 0) from cron.job_run_details where end_time >= now() - interval '3 days')`;
const JOBS = [
  { jobname: 'sl-cron-history', schedule: '47 3 * * *', command: HISTORY },
  { jobname: 'sl-push-failures', schedule: '7 * * * *', command: 'select public.record_push_failures()' },
  { jobname: 'sl-rest-push', schedule: '10 seconds', command: 'select public.dispatch_due_rest_pushes()' },
  { jobname: 'sl-retention', schedule: '17 3 * * *', command: 'select public.run_retention()' },
];
const NAMES = JOBS.map((job) => job.jobname);
const AS_MADE = JOBS.map((job) => ({ ...job, active: true, username: 'postgres', here: true }));

const jobsOf = (db) => db.query.rows(
  `select jobname, schedule, command, active, username, database = current_database() as here
     from cron.job order by jobname, username`,
);
/** What pg_cron does at the time of a job: its command, as the role of the job. The answer of a function, or how many rows went. */
const runJob = async (db, jobname) => {
  const command = await db.query.value(`select command from cron.job where jobname = $1 and username = 'postgres'`, [jobname]);
  if (!command) throw new Error(`runJob: there is no job named ${jobname}`);
  const result = await db.runSql(command, jobname);
  return result.command === 'SELECT' ? Object.values(result.rows[0])[0] : result.rowCount;
};

// ------------------------------------------------------------
// A world, as SQL: a coach and two athletes. Alex has switched notifications
// on, on a phone; Billie has not. The role is set the way a dump restore sets
// it — on the baseline the documented `update profiles set role = 'coach'` is
// undone for every caller (finding P20, closed by migration 07).
// ------------------------------------------------------------
const COACH = '00000000-0000-4000-8000-00000000c0ac';
const ATHLETE = '00000000-0000-4000-8000-0000000000a1';
const SECOND = '00000000-0000-4000-8000-0000000000a2';
const ALEX_PHONE = 'https://fcm.googleapis.com/fcm/send/alex-s-phone';
const FUNCTIONS = 'https://functions.sl.test/functions/v1';
const WORLD = `
  insert into auth.users (id, email, aud, role, email_confirmed_at, raw_user_meta_data) values
    ('${COACH}',   'coach@sl.test',  'authenticated', 'authenticated', now(), '{"full_name": "Coach Carla"}'),
    ('${ATHLETE}', 'alex@sl.test',   'authenticated', 'authenticated', now(), '{"full_name": "Alex"}'),
    ('${SECOND}',  'billie@sl.test', 'authenticated', 'authenticated', now(), '{"full_name": "Billie"}');
  BEGIN;
  SET LOCAL session_replication_role = replica;
  update public.profiles set role = 'coach' where id = '${COACH}';
  COMMIT;
  insert into public.students (profile_id, coach_id) values ('${ATHLETE}', '${COACH}'), ('${SECOND}', '${COACH}');
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
    values ('${ATHLETE}', '${ALEX_PHONE}', 'k', 's', 'Chrome on a phone');
  select vault.create_secret('${FUNCTIONS}', 'app_functions_url');
  select vault.create_secret('a-bearer-made-for-the-test', 'app_service_role_key');
`;

// One transaction, always undone. Each step is a statement, or an actor: from
// there on the statements are a request of that user of the API, role and
// claims set the way PostgREST sets them. Before the first actor they are the
// owner's — the SQL editor, and a job. The answer is the first value of the
// last statement, or the message of the statement that raised.
const user = (sub) => ({ role: 'authenticated', claims: { role: 'authenticated', sub } });
const THE_ATHLETE = user(ATHLETE);
const THE_COACH = user(COACH);
const NOBODY = { role: 'anon', claims: { role: 'anon' } };
const THE_SERVICE_ROLE = { role: 'service_role', claims: { role: 'service_role' } };
const actor = (step) => `select set_config('role', '${step.role}', true), set_config('request.jwt.claims', '${step.claims ? JSON.stringify(step.claims) : ''}', true)`;
const story = async (db, ...steps) => {
  const statements = steps.map((step) => (typeof step === 'string' ? step : actor(step)));
  const tried = await attempt(() => db.runSql(`BEGIN;\n${statements.join(';\n')};\nROLLBACK;`, 'request'));
  if (!tried.ok) return (tried.error.cause ?? tried.error).message;
  const [found] = tried.value.at(-2).rows;
  return found ? Object.values(found)[0] : null;
};
/** The same, kept: a request of that user that is committed. Its answer, or it throws. */
const request = async (db, who, sql) => {
  const results = await db.runSql(`BEGIN;\n${actor(who)};\n${sql};\nCOMMIT;`, 'request');
  const [found] = results.at(-2).rows;
  return found ? Object.values(found)[0] : null;
};

const scheduleRest = (seconds = 90) => `select public.schedule_rest_push(${seconds}, '{"title": "Rest done", "tag": "rest-timer"}', '${ALEX_PHONE}')`;
const modeOf = `(${scheduleRest().replace(/^select /, '')})->>'mode'`;
const askMode = `select ${modeOf}`;
const pause = (jobname, active = false) => `select cron.alter_job(jobid, active := ${active}) from cron.job where jobname = '${jobname}'`;

// The pages, which are what the person who runs the commands reads.
const fencesOf = (text, lang) => [...text.matchAll(new RegExp(`^( *)\`\`\`${lang}\\n([\\s\\S]*?)\\n\\1\`\`\`$`, 'gm'))]
  .map(([, indent, body]) => body.split('\n').map((row) => row.slice(indent.length)).join('\n'));
const quotedIn = (commands, start) => commands
  .map((command) => /^supabase db query --linked "(.+)"$/.exec(command)?.[1])
  .find((sql) => sql?.startsWith(start));
const page = read(migration.paths.runbook);
const decisionPage = read(DECISION_PAGE);
const pageCommands = fencesOf(page, 'bash');
const decisionCommands = fencesOf(decisionPage, 'bash');
const [pageCheck] = pageCommands
  .map((command) => /^supabase db query --linked '(do \$check\$[\s\S]+\$check\$)'$/.exec(command)?.[1])
  .filter(Boolean);

const printedAudit = async (db) => {
  const [result] = await db.readOnly(read(migration.paths.audit), 'audit');
  return Object.fromEntries(result.rows.map((row) => [row.check, row.value]));
};
const LINE = {
  pgCron: 'pg_cron, the extension the jobs need',
  runs16And18: 'what the jobs run is there (dispatch_due_rest_pushes, run_retention: migrations 16 and 18)',
  there: 'the push requests that failed are written down (record_push_failures, P35)',
  strangers: 'functions of that name that the migration does not know',
  who: 'who may execute it, besides its owner',
  rights: 'it runs with the rights of',
  path: 'its search_path',
  jobs: 'the jobs of this migration',
  asMade: '… each as the migration makes it: its schedule, its command, switched on, of postgres, in this database',
  others: 'other jobs of pg_cron in this project',
  sender: 'who sends a rest push',
  lastRuns: 'the last run of each job',
  waiting: 'rest pushes that are waiting for their time',
  runs: 'runs pg_cron remembers',
  oldRuns: '… of which older than the three days sl-cron-history keeps',
  answers: 'what the push requests of the last hours were answered',
};
const BY_THE_APP_NO_CRON = 'the app, by calling dispatch-rest-push (pg_cron is not installed: schedule_rest_push answers mode edge)';
const BY_THE_APP = 'the app, by calling dispatch-rest-push (no job named sl-rest-push is switched on: schedule_rest_push answers mode edge)';
const BY_THE_JOB = 'the job sl-rest-push, every ten seconds (schedule_rest_push answers mode cron)';
const NO_RUN_YET = NAMES.map((name) => `${name}: no run yet`).join('; ');

// ============================================================
// Production as it is: no pg_cron. The database of this file.
// ============================================================
describe('a project without pg_cron — production, and the database the suite runs on', () => {
  it('has no extension, no schema of it, none of the function, and no line in the ledger for migration 19', async () => {
    expect(await asAdmin((q) => q.one(
      `select (select count(*) from pg_extension where extname = 'pg_cron') as extension,
              to_regnamespace('cron') is null as no_schema,
              to_regprocedure('${RECORD}') is null as no_function,
              (select count(*) from ${LEDGER} where name = $1) as on_record,
              (select count(*) from ${LEDGER}) as migrations`, [MIGRATION],
    ))).toEqual({
      extension: 0,
      no_schema: true,
      no_function: true,
      on_record: 0,
      migrations: manifest.migrations.filter((m) => installedBySchemaSql(m)).length,
    });
  });

  it('a rest push is sent through the Edge Function: schedule_rest_push answers mode edge', () => scenario(async (q) => {
    const una = await createUser({ email: 'una@sl.test', fullName: 'Una' });
    await q(`insert into push_subscriptions (user_id, endpoint, p256dh, auth) values ($1, $2, 'k', 's')`, [una.id, ALEX_PHONE]);
    const answer = await asUser(una, (c) => c.value(
      `select public.schedule_rest_push(60, '{"title": "Rest done"}', $1)`, [ALEX_PHONE],
    ));
    expect(answer).toMatchObject({ mode: 'edge' });
  }));

  it('schema.sql keeps everything of migration 19 inside one block that asks for the extension first, and signs the ledger under the same condition', () => {
    const schema = read(SCHEMA_SQL);
    const ASKS = `EXISTS (SELECT 1 FROM pg_extension e WHERE e.extname = 'pg_cron')`;
    const [block] = /^DO \$pg_cron_jobs\$[\s\S]*?^\$pg_cron_jobs\$;$/m.exec(schema) ?? [];
    expect(block, 'schema.sql no longer has the block').toBeTruthy();
    expect(block).toContain(`IF NOT ${ASKS} THEN`);
    // Outside the block nothing calls pg_cron or creates the function.
    const outside = schema.replace(block, '').replace(/--.*$/gm, '');
    expect(outside).not.toMatch(/cron\.(schedule|unschedule|alter_job)\s*\(/);
    expect(outside).not.toContain('record_push_failures');
    // The one mention of the migration that is left is its line of the ledger.
    expect(outside.match(new RegExp(`'${MIGRATION}'`, 'g'))).toHaveLength(1);
    expect(outside).toMatch(new RegExp(
      `INSERT INTO app_private\\.app_migrations \\(name\\)\\s+SELECT '${MIGRATION}'\\s+WHERE ${ASKS.replace(/[()]/g, '\\$&')};`,
    ));
  });
});

// ============================================================
// The stub: what the tests below rest on.
// ============================================================
describe('the stub of pg_cron', () => {
  it('gives postgres what a Supabase project gives it: the functions, and cron.job to read — not to write', async () => {
    const db = await scratchDatabase();
    expect(await db.query.value(`select to_regnamespace('cron') is null`)).toBe(true);
    await db.enableExtension('pg_cron');
    expect(await db.query.one(`select extversion, extnamespace::regnamespace::text as schema from pg_extension where extname = 'pg_cron'`))
      .toEqual({ extversion: '1.6.4', schema: 'pg_catalog' });

    // A name is a job: scheduled twice, it is one job with the second schedule.
    const id = await db.query.value(`select cron.schedule('a-job', '*/5 * * * *', 'select 1')`);
    expect(await db.query.value(`select cron.schedule('a-job', '30 seconds', 'select 2')`)).toBe(id);
    expect(await jobsOf(db)).toEqual([
      { jobname: 'a-job', schedule: '30 seconds', command: 'select 2', active: true, username: 'postgres', here: true },
    ]);
    // …and one that was switched off stays switched off, as with pg_cron.
    await db.query(`select cron.alter_job($1, active := false)`, [id]);
    await db.query(`select cron.schedule('a-job', '30 seconds', 'select 3')`);
    expect((await jobsOf(db))[0]).toMatchObject({ command: 'select 3', active: false });

    // The table itself is not postgres's to write: a job is made, changed and
    // removed through the functions.
    for (const statement of [
      `insert into cron.job (schedule, command, jobname) values ('* * * * *', 'select 1', 'by-hand')`,
      `update cron.job set active = true`,
      `delete from cron.job`,
    ]) {
      expect((await attempt(() => db.query(statement))).error?.message, statement).toBe('permission denied for table job');
    }
    // The runs are: that is how their history is kept short.
    await db.query(`insert into cron.job_run_details (jobid, status) values ($1, 'succeeded')`, [id]);
    expect((await db.query(`delete from cron.job_run_details`)).rowCount).toBe(1);

    for (const schedule of ['60 seconds', '0 seconds', '10 minutes', 'every night', '* * * *']) {
      expect((await attempt(() => db.query(`select cron.schedule('b-job', $1, 'select 1')`, [schedule]))).error?.message, schedule)
        .toBe(`invalid schedule: ${schedule}`);
    }
    expect((await attempt(() => db.query(`select cron.unschedule('no-such-job')`))).error?.message)
      .toBe(`could not find valid entry for job 'no-such-job'`);
    expect(await db.query.value(`select cron.unschedule('a-job')`)).toBe(true);
    expect(await jobsOf(db)).toEqual([]);

    // Nobody who comes through the API gets into the schema.
    for (const who of [NOBODY, THE_SERVICE_ROLE, user(ATHLETE)]) {
      expect(await story(db, who, `select cron.schedule('theirs', '* * * * *', 'select 1')`)).toBe('permission denied for schema cron');
      expect(await story(db, who, `select count(*) from cron.job`)).toBe('permission denied for schema cron');
    }
    // Switched on once.
    expect((await attempt(() => db.enableExtension('pg_cron'))).error?.message).toMatch(/schema "cron" already exists/);
    expect((await attempt(() => db.enableExtension('pg_partman'))).error?.message).toMatch(/there is no stub for the extension "pg_partman"/);
    await db.drop();
  });
});

// ============================================================
// A project that has pg_cron, installed from schema.sql.
// ============================================================
describe('a project with pg_cron', () => {
  let home;
  let installed;   // its catalog, before anybody is in it
  beforeAll(async () => {
    home = await scratchDatabase();
    await home.enableExtension('pg_cron');
    await home.runFile(SCHEMA_SQL);
    installed = await catalogSnapshot(home.query);
    await home.runSql(WORLD, 'world');
  });
  afterEach(async () => {
    for (const table of [
      'net._http_response', 'net.http_request_queue', 'public.client_errors', 'public.scheduled_pushes',
      'public.notifications', 'cron.job_run_details',
    ]) await home.query(`delete from ${table}`);
  });

  // What pg_net was answered for a request, in the hour `hoursAgo` whole hours
  // before the one that is running (0: the one that is running). The hours are
  // those of the clock when each statement runs: a test that is under way at
  // the very second an hour ends counts one hour off, once in tens of
  // thousands of runs.
  let requests = 0;
  const answered = async (hoursAgo, more = {}, times = 1) => {
    for (let n = 0; n < times; n += 1) {
      requests += 1;
      await home.query(
        `insert into net._http_response (id, status_code, timed_out, error_msg, content, created)
         values ($1, $2, $3, $4, '{"a device": "is named here"}',
                 date_trunc('hour', now(), 'UTC') - make_interval(hours => $5) + make_interval(mins => $6))`,
        [requests, more.status ?? null, more.timedOut ?? false, more.error ?? null, hoursAgo, 5 + (requests % 50)],
      );
    }
  };
  /** How the function writes an hour: its two ends, and the key of its line. */
  const hour = (hoursAgo) => home.query.one(
    `select to_char(h at time zone 'UTC', 'YYYY-MM-DD HH24:MI') as start,
            to_char((h + interval '1 hour') at time zone 'UTC', 'HH24:MI') as "end",
            'pg_net ' || to_char(h at time zone 'UTC', 'YYYY-MM-DD"T"HH24":00Z"') as key
       from (select date_trunc('hour', now(), 'UTC') - make_interval(hours => $1) as h) t`, [hoursAgo],
  );
  const sentence = (h, failed, sent, kinds) => `Push: ${failed} of ${sent} requests the database sent to send-push failed between ${h.start} and ${h.end} UTC — ${kinds}`;
  const lines = () => home.query.rows(`select message, url from public.client_errors where role = 'database' order by url`);
  const record = () => home.query.value(`select ${RECORD}`);

  it('schema.sql makes the four jobs — each once, switched on, of postgres, in this database — and signs the ledger for migration 19', async () => {
    expect(await jobsOf(home)).toEqual(AS_MADE);
    expect(await home.query.value(`select count(*) from ${LEDGER} where name = $1`, [MIGRATION])).toBe(1);
    expect(await home.query.value(`select count(*) from ${LEDGER}`))
      .toBe(manifest.migrations.filter((m) => installedBySchemaSql(m, ['pg_cron'])).length);
    // Loaded where the jobs are there already — the block is CREATE OR REPLACE
    // and cron.schedule — nothing is there twice.
    const [block] = /^DO \$pg_cron_jobs\$[\s\S]*?^\$pg_cron_jobs\$;$/m.exec(read(SCHEMA_SQL));
    await home.runSql(block, 'the block of schema.sql');
    expect(await jobsOf(home)).toEqual(AS_MADE);
  });

  // Every other test file runs on a project without pg_cron. What it holds
  // there — who may execute what, what a signed-in user reaches, which
  // function sends a push — holds here for everything but the one function
  // more, which the tests below hold themselves.
  it('is the project without pg_cron plus exactly this: the extension and its schema, one function, four jobs, one line of the ledger', async () => {
    const plain = await asAdmin((q) => catalogSnapshot(q));
    const diff = diffCatalogs(plain, installed, { left: 'without', right: 'with' });
    expect(diff.filter((row) => !row.endsWith(': only in with') && !row.startsWith('data rows of '))).toEqual([]);
    const more = diff.filter((row) => row.endsWith(': only in with')).map((row) => row.slice(0, -': only in with'.length));
    // What pg_cron brought: its schema, and nothing outside it but its name.
    const ofPgCron = more.filter((row) => /^\w+ cron\b/.test(row) || /^comments .* cron\./.test(row));
    expect(ofPgCron).toContain('schemas cron');
    expect(ofPgCron).toContain('tables cron.job');
    expect(more.filter((row) => !ofPgCron.includes(row))).toEqual(['functions public.record_push_failures()', 'extensions pg_cron']);
    expect(diff.filter((row) => row.startsWith('data rows of ')).map((row) => /^data rows of (\S+): /.exec(row)[1]))
      .toEqual(['app_private.app_migrations', 'cron.job']);
  });

  it('the four jobs are one text: in the migration, schema.sql, the audit, the rollback and the two pages', () => {
    const unquoted = (text) => text.replace(/''/g, `'`);
    const listed = (text) => [...text.matchAll(/\('(sl-[a-z-]+)',\s+'([^']+)',\s+(?:'((?:[^']|'')+)'|\$c\$([\s\S]+?)\$c\$)\)/g)]
      .map(([, jobname, schedule, quoted, dollar]) => ({ jobname, schedule, command: dollar ?? unquoted(quoted) }))
      .sort((a, b) => (a.jobname < b.jobname ? -1 : 1));
    for (const file of [migration.paths.migration, SCHEMA_SQL, migration.paths.audit]) {
      expect(listed(read(file)), file).toEqual(JOBS);
    }
    // Where only the names are written: the guard of the migration, the two
    // statements of the rollback.
    const namesIn = (text) => [...text.matchAll(/IN \(('sl-[a-z-]+'(?:, 'sl-[a-z-]+')*)\)/g)]
      .map(([, list]) => list.split(', ').map((name) => name.slice(1, -1)).sort());
    expect(namesIn(read(migration.paths.migration))).toEqual([NAMES]);
    expect(namesIn(read(migration.paths.rollback))).toEqual([NAMES, NAMES]);
    // The page of the migration, the page of the decision, and the check.
    const rowsOf = (text, pattern) => [...text.matchAll(pattern)].map(([, jobname, schedule]) => `${jobname} ${schedule}`).sort();
    expect(rowsOf(decisionPage, /^\| `(sl-[a-z-]+)` \| `([^`]+)` \| /gm)).toEqual(JOBS.map((job) => `${job.jobname} ${job.schedule}`));
    expect([...page.matchAll(/^\| `(sl-[a-z-]+)` \| [^|]+ \| (?:`([^`]+)`|one `delete` on `cron\.job_run_details`) \|/gm)]
      .map(([, jobname, command]) => `${jobname} ${command ?? 'delete'}`).sort())
      .toEqual(JOBS.map((job) => `${job.jobname} ${job.command.startsWith('delete') ? 'delete' : job.command}`));
    expect(rowsOf(pageCheck, /\(\$m\$(sl-[a-z-]+)\$m\$, \$m\$([^$]+)\$m\$, /g)).toEqual(JOBS.map((job) => `${job.jobname} ${job.schedule}`));
    for (const [, jobname, start] of pageCheck.matchAll(/\(\$m\$(sl-[a-z-]+)\$m\$, \$m\$[^$]+\$m\$, \$m\$([^$]+)\$m\$\)/g)) {
      expect(JOBS.find((job) => job.jobname === jobname).command.startsWith(start), jobname).toBe(true);
    }
  });

  // "schedule_rest_push returns mode 'cron' once the job exists."
  it('the name of the job is the contract: mode cron while sl-rest-push is there and switched on, edge once it is switched off or removed', async () => {
    expect(await story(home, THE_ATHLETE, askMode)).toBe('cron');
    expect(await story(home, pause('sl-rest-push'), THE_ATHLETE, askMode)).toBe('edge');
    expect(await story(home, pause('sl-rest-push'), pause('sl-rest-push', true), THE_ATHLETE, askMode)).toBe('cron');
    expect(await story(home, `select cron.unschedule('sl-rest-push')`, THE_ATHLETE, askMode)).toBe('edge');
    // The three others are not asked.
    expect(await story(home,
      pause('sl-retention'), `select cron.unschedule('sl-push-failures')`, `select cron.unschedule('sl-cron-history')`,
      THE_ATHLETE, askMode)).toBe('cron');
    // Nothing above was kept.
    expect(await jobsOf(home)).toEqual(AS_MADE);
  });

  // The app that is deployed writes its row itself and calls the Edge
  // Function whatever the mode: with the job there are two senders for one
  // row, and one notification.
  it('sl-rest-push hands a rest that is about to end to send-push, once — and the row is still sent once, whoever else was asked to send it', async () => {
    // A rest of five minutes, scheduled the way the app of wave 3 does: the answer says nobody else is to be called.
    const long = await request(home, THE_ATHLETE, scheduleRest(300));
    expect(long.mode).toBe('cron');
    // hooks/useRestTimerPush.js, as deployed: its own INSERT, the time of the phone.
    const rest = await request(home, THE_ATHLETE,
      `insert into public.scheduled_pushes (user_id, fire_at, payload) values ('${ATHLETE}', now() + interval '8 seconds', '{"title": "Rest done"}') returning id`);
    // One nobody sent, five minutes late.
    const late = await home.query.value(
      `insert into public.scheduled_pushes (user_id, fire_at, payload) values ($1, now() - interval '5 minutes', '{}') returning id`, [SECOND],
    );

    expect(await runJob(home, 'sl-rest-push')).toEqual({ handed_over: 1, expired: 1 });
    const queued = await home.query.rows(`select url, body, timeout_milliseconds from net.http_request_queue order by id`);
    expect(queued).toEqual([{
      url: `${FUNCTIONS}/send-push`,
      body: {
        user_id: ATHLETE, payload: { title: 'Rest done' }, schedule_id: rest, not_before: expect.any(String), ttl: 60, urgency: 'high',
      },
      timeout_milliseconds: 10000,
    }]);
    // Ten seconds later, and ten seconds after that: the row is not handed over again.
    expect(await runJob(home, 'sl-rest-push')).toEqual({ handed_over: 0, expired: 0 });
    expect(await home.query.value(`select count(*) from net.http_request_queue`)).toBe(1);
    expect(await home.query.rows(`select id, status from public.scheduled_pushes where id = any($1) order by fire_at`, [[rest, long.id, late]]))
      .toEqual([{ id: late, status: 'expired' }, { id: rest, status: 'pending' }, { id: long.id, status: 'pending' }]);

    // At the time: send-push, which the job told, and dispatch-rest-push,
    // which the app called. Each asks before it sends.
    const claim = `select public.claim_rest_push('${rest}')`;
    expect(await request(home, THE_SERVICE_ROLE, claim)).toMatchObject({ id: rest, user_id: ATHLETE });
    expect(await request(home, THE_SERVICE_ROLE, claim)).toBeNull();
  });

  it('sl-retention deletes, every night, what run_retention deletes: by its age, and nothing that is not past its time', async () => {
    await home.runSql(`
      insert into public.scheduled_pushes (user_id, created_at, fire_at, status) values
        ('${ATHLETE}', now() - interval '8 days', now() - interval '8 days', 'sent'),
        ('${ATHLETE}', now() - interval '2 days', now() - interval '2 days', 'sent');
      insert into public.notifications (recipient_id, kind, created_at, read_at) values
        ('${ATHLETE}', 'session_feedback', now() - interval '200 days', now() - interval '100 days'),
        ('${COACH}',   'program_submitted', now() - interval '300 days', null);
      insert into public.client_errors (user_id, role, message, url, created_at) values
        ('${ATHLETE}', 'student', 'TypeError: x is undefined', null, now() - interval '100 days'),
        (null, 'database', 'Push: 1 of 1 requests …', 'pg_net 2026-01-01T00:00Z', now() - interval '100 days'),
        (null, 'database', 'Push: 2 of 9 requests …', 'pg_net 2026-10-10T00:00Z', now() - interval '3 days');
    `, 'rows of every age');
    expect(await runJob(home, 'sl-retention')).toEqual({ scheduled_pushes: 1, notifications: 1, client_errors: 2 });
    expect(await home.query.one(
      `select (select count(*) from public.scheduled_pushes) as pushes, (select count(*) from public.notifications) as lines,
              (select string_agg(url, ', ') from public.client_errors) as errors`,
    )).toEqual({ pushes: 1, lines: 1, errors: 'pg_net 2026-10-10T00:00Z' });
  });

  // ----------------------------------------------------------
  // record_push_failures — P35: "Un balayage pg_cron de net._http_response."
  // ----------------------------------------------------------
  describe('record_push_failures, what sl-push-failures runs every hour', () => {
    it('writes one line for each hour that is over and in which a request failed: how many of how many, and what kind', async () => {
      // Three hours ago: one request, refused.
      await answered(3, { status: 401 });
      // Two hours ago: eight requests, six of which nobody got.
      await answered(2, { status: 200 });
      await answered(2, { status: 202 });
      await answered(2, { status: 502 }, 3);
      await answered(2, { timedOut: true, error: 'Timeout was reached' }, 2);
      await answered(2, { error: 'Could not resolve host: functions.sl.test' });
      // The hour before this one: all answered.
      await answered(1, { status: 200 }, 4);
      // The hour that is running: not over.
      await answered(0, { status: 500 });

      expect(await runJob(home, 'sl-push-failures')).toEqual({ hours: 2, failed: 7 });
      const [three, two] = [await hour(3), await hour(2)];
      expect(await lines()).toEqual([
        { message: sentence(three, 1, 1, '1 × HTTP 401'), url: three.key },
        {
          message: sentence(two, 6, 8, '3 × HTTP 502, 2 × no answer in time, 1 × no answer (Could not resolve host: functions.sl.test)'),
          url: two.key,
        },
      ]);
      // The line is nobody's, says where it comes from, and holds nothing of what was answered.
      expect(await home.query.rows(
        `select distinct user_id, role, user_agent, stack, position('a device' in message || coalesce(stack, '')) as copied
           from public.client_errors`,
      )).toEqual([{
        user_id: null,
        role: 'database',
        user_agent: 'public.record_push_failures()',
        stack: 'What each request was answered is in net._http_response for six hours, and in the log of the send-push Edge Function.',
        copied: 0,
      }]);
      // As the page of the migration and the page of the decision show it.
      const shown = '> Push: 3 of 41 requests the database sent to send-push failed between 2026-10-13 14:00 and 15:00 UTC — 2 × HTTP 502, 1 × no answer in time';
      expect(decisionPage).toContain(shown);
      expect(page).toContain(shown.replace('> ', '> **DATABASE** — '));
    });

    it('writes an hour once: a second run adds nothing, and an hour is written when it is over, not before', async () => {
      await answered(2, { status: 503 });
      await answered(0, { status: 500 });
      expect(await record()).toEqual({ hours: 1, failed: 1 });
      expect(await record()).toEqual({ hours: 0, failed: 0 });
      // A request of the hour that is running, once that hour is over: here,
      // the same answer an hour earlier.
      await answered(1, { status: 500 });
      expect(await record()).toEqual({ hours: 1, failed: 1 });
      expect((await lines()).map((line) => line.url)).toEqual([(await hour(2)).key, (await hour(1)).key]);
      expect(await record()).toEqual({ hours: 0, failed: 0 });
      // A run that was missed is caught up: every hour pg_net still holds.
      await home.query(`delete from public.client_errors`);
      expect(await record()).toEqual({ hours: 2, failed: 2 });
    });

    it('a request failed when it was not answered with a status from 200 to 299 — whatever else is said of it', async () => {
      const kindOf = async (more) => {
        await home.query(`delete from net._http_response`);
        await home.query(`delete from public.client_errors`);
        await answered(1, more);
        const ran = await record();
        const [line] = await lines();
        return ran.failed === 0 ? 'answered' : line.message.split(' — ')[1];
      };
      expect(await kindOf({ status: 200 })).toBe('answered');
      expect(await kindOf({ status: 202 })).toBe('answered');
      expect(await kindOf({ status: 299 })).toBe('answered');
      expect(await kindOf({ status: 199 })).toBe('1 × HTTP 199');
      expect(await kindOf({ status: 300 })).toBe('1 × HTTP 300');
      expect(await kindOf({ status: 404 })).toBe('1 × HTTP 404');
      expect(await kindOf({ status: 502 })).toBe('1 × HTTP 502');
      // A status, and pg_net says something went wrong all the same.
      expect(await kindOf({ status: 200, error: 'the answer was cut short' })).toBe('1 × HTTP 200');
      expect(await kindOf({ timedOut: true })).toBe('1 × no answer in time');
      expect(await kindOf({ timedOut: true, status: 200 })).toBe('1 × no answer in time');
      expect(await kindOf({})).toBe('1 × no answer');
      expect(await kindOf({ error: 'Could not connect to server' })).toBe('1 × no answer (Could not connect to server)');
      // What pg_net says is kept short…
      expect(await kindOf({ error: 'x'.repeat(200) })).toBe(`1 × no answer (${'x'.repeat(80)})`);
    });

    // The condition is written three times: in the function, in line 17 of
    // the audit, and in the statement of page 50 that lists the failed answers.
    it('what "failed" means is the same in the function, in the audit and in the statement of the page', async () => {
      const failedAnswers = quotedIn(decisionCommands, 'select created, status_code, timed_out, error_msg');
      const all = [
        { status: 200 }, { status: 204 }, { status: 299 }, { status: 199 }, { status: 300 }, { status: 404 }, { status: 502 },
        { status: 200, error: 'the answer was cut short' }, { timedOut: true }, { timedOut: true, status: 200 }, {},
        { error: 'Could not connect to server' },
      ];
      for (const more of all) await answered(1, more);
      const FAILED = 9;
      expect((await home.query.rows(failedAnswers.replace('limit 20', 'limit 200'))).length).toBe(FAILED);
      expect((await printedAudit(home))[LINE.answers]).toBe(`${all.length} requests, ${FAILED} of them failed`);
      expect(await record()).toEqual({ hours: 1, failed: FAILED });
      expect((await lines())[0].message).toMatch(new RegExp(`^Push: ${FAILED} of ${all.length} requests `));
    });

    it('a line is never longer than the list takes, however many kinds of failure an hour had', async () => {
      for (let n = 0; n < 60; n += 1) await answered(1, { error: `${String(n).padStart(2, '0')} ${'y'.repeat(70)}` });
      expect(await record()).toEqual({ hours: 1, failed: 60 });
      const [line] = await lines();
      expect(line.message).toHaveLength(2000);
      expect(line.message).toMatch(/^Push: 60 of 60 requests /);
    });

    it('is for the owner and the service role: SECURITY INVOKER, refused to everybody who is signed in or not', async () => {
      expect(await home.query.one(
        `select p.prosecdef as runs_as_owner, p.proconfig as settings, pg_get_userbyid(p.proowner) as owner,
                format_type(p.prorettype, null) as answers,
                (select array_agg(g.name order by g.name collate "C")
                   from (select case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee)::text end as name
                           from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a) g) as grantees
           from pg_proc p where p.oid = '${RECORD}'::regprocedure`,
      )).toEqual({
        runs_as_owner: false,
        settings: ['search_path=public, pg_temp'],
        owner: 'postgres',
        answers: 'jsonb',
        grantees: ['postgres', 'service_role'],
      });
      await answered(1, { status: 500 });
      for (const who of [NOBODY, THE_ATHLETE, THE_COACH]) {
        expect(await story(home, who, `select ${RECORD}`)).toBe('permission denied for function record_push_failures');
      }
      // Handed to a signed-in user by mistake, it has no right of its own: the table of pg_net is not theirs to read.
      expect(await story(home, `grant execute on function ${RECORD} to authenticated`, THE_COACH, `select ${RECORD}`))
        .toBe('permission denied for table _http_response');
      expect(await lines()).toEqual([]);
      expect(page).toContain('| nobody signed in, or any account | `permission denied for function record_push_failures` |');
    });

    // hooks/useClientErrors.js, as deployed: the 20 most recent lines, for a coach.
    it('its line is in the list the coach reads, next to what the app reported — and an athlete reads neither', async () => {
      await answered(1, { status: 502 });
      await request(home, THE_ATHLETE,
        `insert into public.client_errors (user_id, role, message, url) values ('${ATHLETE}', 'student', 'TypeError: x is undefined', 'https://app.sl.test/#/student')`);
      await record();
      const APP = `select coalesce(jsonb_agg(jsonb_build_object('role', role, 'user_id', user_id, 'url', url) order by role), '[]')
                     from (select id, user_id, role, message, url, created_at from public.client_errors order by created_at desc limit 20) list`;
      expect(await story(home, THE_COACH, APP)).toEqual([
        { role: 'database', user_id: null, url: (await hour(1)).key },
        { role: 'student', user_id: ATHLETE, url: 'https://app.sl.test/#/student' },
      ]);
      expect(await story(home, THE_ATHLETE, APP)).toEqual([]);
      // Nobody who is signed in can write such a line: the role of a report is the role of its account.
      expect(await story(home, THE_COACH,
        `insert into public.client_errors (user_id, role, message, url) values (null, 'database', 'Push: forged', 'pg_net 2026-10-13T14:00Z')`))
        .toBe('new row violates row-level security policy for table "client_errors"');
      expect(await story(home, THE_COACH,
        `insert into public.client_errors (user_id, role, message, url) values ('${COACH}', 'database', 'Push: forged', 'pg_net 2026-10-13T14:00Z')`))
        .toBe('new row violates row-level security policy for table "client_errors"');
    });

    // The job and a run by hand in the same instant. The second waits for the
    // first — it is shown waiting — and then finds its line.
    it('two runs at once write one line: the second waits for the first, and adds nothing', async () => {
      await answered(1, { status: 502 });
      const waiting = () => home.query.value(
        `select count(*) from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
      );
      const first = home.runSql(`BEGIN;\nselect ${RECORD};\nselect pg_sleep(1.5);\nCOMMIT;`, 'the first run');
      await new Promise((resolve) => { setTimeout(resolve, 200); });
      const second = record();
      for (let tries = 0; await waiting() === 0; tries += 1) {
        if (tries === 300) throw new Error('the second run never waited for the first');
        await new Promise((resolve) => { setTimeout(resolve, 10); });
      }
      const [, ran] = await first;
      expect(ran.rows[0].record_push_failures).toEqual({ hours: 1, failed: 1 });
      expect(await second).toEqual({ hours: 0, failed: 0 });
      expect(await lines()).toHaveLength(1);
    });
  });

  // ----------------------------------------------------------
  // sl-cron-history
  // ----------------------------------------------------------
  describe('sl-cron-history, which keeps three days of the runs pg_cron remembers', () => {
    // A run of sl-rest-push that ended `ago`; without `ago`, one that never
    // started: pg_cron could not connect, and noted no time.
    const ran = (ago, status = 'succeeded') => home.query.value(
      `insert into cron.job_run_details (jobid, status, start_time, end_time, username)
       select jobid, $2, now() - $1::interval, now() - $1::interval, 'postgres' from cron.job where jobname = 'sl-rest-push'
       returning runid`, [ago ?? null, ago ? status : 'failed'],
    );
    const left = async () => (await home.query.rows(`select runid from cron.job_run_details order by runid`)).map((row) => row.runid);

    it('deletes every run numbered before the first one that ended within three days — one that never started included', async () => {
      const old = [await ran('9 days'), await ran('5 days'), await ran(null), await ran('4 days', 'failed'), await ran('3 days 1 minute')];
      const kept = [await ran('2 days 23 hours'), await ran(null), await ran('1 hour'), await ran('3 seconds'), await ran(null)];
      // What the audit says tonight's run deletes.
      expect(await printedAudit(home)).toMatchObject({ [LINE.runs]: '10', [LINE.oldRuns]: '5' });

      expect(await runJob(home, 'sl-cron-history')).toBe(old.length);
      expect(await left()).toEqual(kept);
      expect(await runJob(home, 'sl-cron-history')).toBe(0);
      expect(await printedAudit(home)).toMatchObject({ [LINE.runs]: '5', [LINE.oldRuns]: '0' });
    });

    it('deletes nothing while no run has ended for three days: there is nothing to count from', async () => {
      const all = [await ran('9 days'), await ran(null), await ran('4 days')];
      expect(await runJob(home, 'sl-cron-history')).toBe(0);
      expect(await left()).toEqual(all);
      // The jobs run again: the next night everything before goes.
      const again = await ran('1 minute');
      expect(await runJob(home, 'sl-cron-history')).toBe(3);
      expect(await left()).toEqual([again]);
    });
  });

  // ----------------------------------------------------------
  // docs/runbook/50-pg-cron.md: its statements, read off the page.
  // ----------------------------------------------------------
  describe('the statements of docs/runbook/50-pg-cron.md', () => {
    const isOn = quotedIn(decisionCommands, 'select extname, extversion from pg_extension');
    const listJobs = quotedIn(decisionCommands, 'select jobname, schedule, active, command from cron.job');
    const lastRuns = quotedIn(decisionCommands, 'select j.jobname, d.status, d.return_message, d.start_time, d.end_time from cron.job j left join lateral');
    const failedRuns = quotedIn(decisionCommands, 'select j.jobname, d.status, d.return_message, d.start_time from cron.job_run_details d');
    const switchOff = quotedIn(decisionCommands, 'select jobname, cron.alter_job(jobid, active := false)');
    const switchOn = quotedIn(decisionCommands, 'select jobname, cron.alter_job(jobid, active := true)');
    const failedAnswers = quotedIn(decisionCommands, 'select created, status_code, timed_out, error_msg');

    it('are all there, and can be pasted between double quotes', () => {
      for (const statement of [isOn, listJobs, lastRuns, failedRuns, switchOff, switchOn, failedAnswers]) {
        expect(statement, 'the page no longer gives one of its statements').toBeTruthy();
        expect(statement).not.toMatch(/["$`!\\]/);
      }
      // The files it sends to are the files of the migration, and the audit of migration 18.
      for (const command of [
        `supabase db query --linked --file ${migration.paths.audit}`,
        `supabase db query --linked --file ${migration.paths.rollback}`,
        'supabase db query --linked --file supabase/audits/2026_10_13_18_retention.audit.sql',
      ]) expect(decisionCommands).toContain(command);
      // It never gives the file that applies: that one is run from the page of the migration, after its audit.
      expect(decisionCommands.filter((command) => command.includes(migration.paths.migration))).toEqual([]);
      expect(pageCommands).toContain(`supabase db query --linked --file ${migration.paths.migration}`);
    });

    it('whether the extension is on, the four jobs as the table of the page shows them, and their runs', async () => {
      expect(await home.query.rows(isOn)).toEqual([{ extname: 'pg_cron', extversion: '1.6.4' }]);
      expect(await asAdmin((q) => q.rows(isOn))).toEqual([]);

      expect(await home.query.rows(listJobs)).toEqual(JOBS.map((job) => ({ ...job, active: true })));

      // A job that has not run yet has one line with nothing in it.
      expect(await home.query.rows(lastRuns)).toEqual(NAMES.map((jobname) => ({
        jobname, status: null, return_message: null, start_time: null, end_time: null,
      })));
      expect(await home.query.rows(failedRuns)).toEqual([]);
      const jobid = await home.query.value(`select jobid from cron.job where jobname = 'sl-retention'`);
      for (const [status, message, ago] of [
        ['succeeded', '1 row', '3 days'], ['succeeded', '1 row', '2 days'], ['failed', 'ERROR: canceling statement due to lock timeout', '1 day'],
        ['succeeded', '1 row', '1 hour'],
      ]) {
        await home.query(
          `insert into cron.job_run_details (jobid, status, return_message, start_time, end_time) values ($1, $2, $3, now() - $4::interval, now() - $4::interval)`,
          [jobid, status, message, ago],
        );
      }
      expect((await home.query.rows(lastRuns)).filter((row) => row.jobname === 'sl-retention').map((row) => row.status))
        .toEqual(['succeeded', 'failed', 'succeeded']);
      expect((await home.query.rows(failedRuns)).map((row) => [row.jobname, row.return_message]))
        .toEqual([['sl-retention', 'ERROR: canceling statement due to lock timeout']]);
    });

    it('a job is switched off and on again with the two statements of the page — and through nothing else', async () => {
      const forRestPush = (statement) => statement.replace(`'sl-retention'`, `'sl-rest-push'`);
      const activeOf = (jobname) => `select active from cron.job where jobname = '${jobname}'`;
      expect(await story(home, switchOff, activeOf('sl-retention'))).toBe(false);
      expect(await story(home, switchOff, switchOn, activeOf('sl-retention'))).toBe(true);
      // The one that has a price: the page says what it is.
      expect(await story(home, forRestPush(switchOff), THE_ATHLETE, askMode)).toBe('edge');
      expect(decisionPage).toContain('| `sl-rest-push` | **the database sends no rest push.** `schedule_rest_push` answers `mode: edge` from the next rest on');
      expect(await story(home, `update cron.job set active = false where jobname = 'sl-retention'`)).toBe('permission denied for table job');
      expect(decisionPage).toContain('an `update` or a `delete` on it answers `permission denied for table job`');
      expect(await jobsOf(home)).toEqual(AS_MADE);
    });

    it('what the failed requests were answered, for the six hours the database holds it', async () => {
      await answered(1, { status: 200 });
      await answered(1, { status: 502 });
      await answered(0, { timedOut: true, error: 'Timeout was reached' });
      const listed = await home.query.rows(failedAnswers);
      expect(listed.map((row) => [row.status_code, row.timed_out, row.error_msg, row.answered])).toEqual([
        [null, true, 'Timeout was reached', '{"a device": "is named here"}'],
        [502, false, null, '{"a device": "is named here"}'],
      ]);
      // The same two the audit counts, and the same one the function writes down once its hour is over.
      expect(await printedAudit(home)).toMatchObject({ [LINE.answers]: '3 requests, 2 of them failed' });
      expect(await record()).toEqual({ hours: 1, failed: 1 });
    });
  });
});

// ============================================================
// The pages lead somewhere
// ============================================================
describe('docs/runbook/50-pg-cron.md and the page of migration 19', () => {
  // The anchor GitHub gives a heading.
  const anchorOf = (heading) => heading.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
  const linksOf = (file) => [...read(file).matchAll(/\]\(([^)#\s]*)(?:#([^)\s]+))?\)/g)].map(([, to, anchor]) => ({
    file: to ? path.join(path.dirname(file), to) : file, anchor: anchor ?? null,
  }));
  const anchorsOf = (file) => read(file).split('\n').filter((row) => /^#{1,6} /.test(row)).map((row) => anchorOf(row.replace(/^#+ /, '')));

  it.each([DECISION_PAGE, migration.paths.runbook])('every link of %s leads to a page, and to a heading of it', (file) => {
    const links = linksOf(file);
    expect(links.length).toBeGreaterThan(8);
    const broken = links.filter((link) => !fs.existsSync(path.join(repoRoot, link.file))
      || (link.anchor && !anchorsOf(link.file).includes(link.anchor)));
    expect(broken).toEqual([]);
  });

  it('each sends to the other, and page 70 sends to the decision', () => {
    expect(linksOf(DECISION_PAGE).map((link) => link.file)).toContain(migration.paths.runbook);
    expect(linksOf(migration.paths.runbook).map((link) => link.file)).toContain(DECISION_PAGE);
    expect(linksOf(ADMIN_PAGE).map((link) => link.file)).toContain(DECISION_PAGE);
  });

  // What a night deletes is in the backup of that night: the backup first.
  it('the nightly backup starts before sl-retention runs, as page 50 says', () => {
    const minutes = (schedule) => {
      const [minute, hour, ...rest] = schedule.split(' ');
      expect(rest, schedule).toEqual(['*', '*', '*']);
      return Number(hour) * 60 + Number(minute);
    };
    const [, backup] = /^\s*- cron: '([^']+)'$/m.exec(read('.github/workflows/backup.yml'));
    const retention = JOBS.find((job) => job.jobname === 'sl-retention').schedule;
    expect([backup, retention]).toEqual(['30 2 * * *', '17 3 * * *']);
    expect(minutes(backup)).toBeLessThan(minutes(retention));
    expect(decisionPage).toContain('The nightly backup on GitHub starts at 02:30 UTC and `sl-retention` runs at 03:17 UTC: what a night deletes is in the backup of that night.');
  });

  it('say in plain words what a project has without pg_cron, what the order is, and what the first night deletes', () => {
    // The answer of the owner was "I do not know": the page must be enough to decide.
    expect(decisionPage).toContain('**Each of them works without it**');
    expect(decisionPage).toContain('**The recommendation is to switch it on.**');
    expect(decisionPage).toContain('**To stay without it: do nothing.**');
    for (const text of [decisionPage, page, read(migration.paths.migration)]) {
      // The order: the Edge Functions of wave 2 first.
      expect(text).toMatch(/ten seconds early/);
      // The first night.
      expect(text).toMatch(/from the first night on|the first time on the night after/i);
    }
    expect(page).toContain('| Kind | optional · needs the extension pg_cron · adds 1 function and 4 jobs of pg_cron; no table, no column, no policy, no trigger |');
  });
});

// ============================================================
// The migration file, on production as it was frozen.
// ============================================================
describe('migration 19 applied to the production baseline', () => {
  const R_RUNNING = '00000000-0000-4000-8000-000000000901';
  const TO_COME = '2099_01_01_99_a_migration_to_come';
  // What production holds on the day: a rest that is running, one that rang
  // a month ago, and what the push requests of the last hours were answered —
  // two hours ago three of them were not.
  const ROWS = `
    insert into public.scheduled_pushes (id, user_id, fire_at, status, created_at) values
      ('${R_RUNNING}', '${ATHLETE}', now() + interval '5 minutes', 'pending', now());
    insert into public.scheduled_pushes (user_id, fire_at, status, sent_at, created_at) values
      ('${ATHLETE}', now() - interval '30 days', 'sent', now() - interval '30 days', now() - interval '30 days');
    insert into net._http_response (id, status_code, timed_out, error_msg, created) values
      (1, 200, false, null, date_trunc('hour', now(), 'UTC') - interval '110 minutes'),
      (2, 502, false, null, date_trunc('hour', now(), 'UTC') - interval '100 minutes'),
      (3, 502, false, null, date_trunc('hour', now(), 'UTC') - interval '95 minutes'),
      (4, null, true, 'Timeout was reached', date_trunc('hour', now(), 'UTC') - interval '90 minutes'),
      (5, 200, false, null, date_trunc('hour', now(), 'UTC') - interval '30 minutes');
  `;

  /**
   * The frozen baseline with that world in it and the migrations before 19
   * applied — and pg_cron switched on, unless the owner chose not to.
   */
  const production = async ({ pgCron = true, upTo = MIGRATION } = {}) => {
    const db = await scratchDatabase();
    await db.runFile(manifest.baseline);
    await db.runSql(WORLD, 'world');
    await db.runSql(ROWS, 'rows');
    for (const earlier of migrationsBefore(manifest.migrations, upTo)) await db.runFile(earlier.paths.migration);
    if (pgCron) await db.enableExtension('pg_cron');
    return db;
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
  const checked = async (db) => {
    const tried = await attempt(() => db.runSql(pageCheck, 'page check'));
    expect(tried.ok, 'the check must always fail: that is what undoes it').toBe(false);
    return (tried.error.cause ?? tried.error).message;
  };
  const answer = (said) => `check only, nothing was written: ${said}`;
  const IN_PLACE = answer('in place: sl-rest-push hands the rest pushes over every ten seconds and schedule_rest_push answers mode cron; '
    + 'run_retention runs every night; the push requests that failed are written down every hour, by a function a signed-in user cannot run; '
    + 'pg_cron keeps three days of its runs');
  const NOT_THERE = answer('NOT THERE: the function record_push_failures is not in the database');
  const NO_PG_CRON = answer('NOT THERE: pg_cron is not in this database, and neither are the jobs');
  const state = (db) => db.query.one(
    `select (select count(*) from auth.users) as accounts, (select count(*) from public.push_subscriptions) as devices,
            (select count(*) from public.scheduled_pushes) as rest_pushes, (select count(*) from public.client_errors) as errors,
            (select count(*) from net.http_request_queue) as requests,
            current_user::text as role, coalesce(current_setting('request.jwt.claims', true), '') as claims`,
  );
  const UNTOUCHED = { accounts: 3, devices: 1, rest_pushes: 2, errors: 0, requests: 0, role: 'postgres', claims: '' };

  // ----------------------------------------------------------
  // The choice not to
  // ----------------------------------------------------------
  it('without pg_cron it refuses (SLM06), says what the project does without it, and changes nothing — the audit and the check say the same', async () => {
    const db = await production({ pgCron: false });
    const before = await catalogSnapshot(db.query);
    const refused = await attempt(() => db.runFile(migration.paths.migration));
    expect(refused.error?.code).toBe(REFUSAL.extensionMissing);
    expect(refused.error.cause.message).toBe(`migration ${MIGRATION} needs the extension pg_cron, which is not switched on in this project`);
    expect(refused.error.cause.hint).toBe(
      'This migration is optional, and nothing is missing without it: a rest push is sent through the dispatch-rest-push Edge Function, '
      + 'and run_retention() is run by hand once a month. To use it, switch pg_cron on (Dashboard, Database, Extensions) and run this file again. '
      + 'Nothing was changed.',
    );
    await untouched(db, before);
    expect(page).toContain('| `needs the extension pg_cron, which is not switched on in this project` (code `SLM06`) |');

    // The audit runs there too, and says what is the case.
    const printed = await printedAudit(db);
    expect(printed).toMatchObject({
      [LINE.pgCron]: 'not installed',
      [LINE.runs16And18]: 'yes',
      [LINE.there]: 'no',
      [LINE.jobs]: 'none',
      [LINE.asMade]: 'there is none',
      [LINE.others]: 'none',
      [LINE.sender]: BY_THE_APP_NO_CRON,
      [LINE.lastRuns]: 'there is no job',
      [LINE.waiting]: '1',
      [LINE.runs]: 'pg_cron is not installed',
      [LINE.oldRuns]: 'pg_cron is not installed',
      [LINE.answers]: '5 requests, 3 of them failed',
    });
    expect(page).toContain('- **2** reads `not installed` — pg_cron is not switched on in this project. That is not an error');
    expect(page).toContain(`line 12 reads \`${BY_THE_APP_NO_CRON.replace(/pg_cron is not installed: .*\)$/, 'pg_cron is not installed: …)')}\``);
    // The sentence of the audit of migration 16, word for word.
    const sixteen = manifest.migrations.find((m) => m.name === '2026_10_13_16_rest_push_scheduling');
    const [of16] = await db.readOnly(read(sixteen.paths.audit), 'audit');
    expect(of16.rows.find((row) => row.check === LINE.sender).value).toBe(BY_THE_APP_NO_CRON);

    expect(await checked(db)).toBe(NO_PG_CRON);
    expect(page).toContain('`… NOT THERE: pg_cron is not in this database, and neither are the jobs`');
    expect((await attempt(() => db.runFile(migration.paths.rollback))).error?.code).toBe(REFUSAL.notApplied);
    // A rest is sent as it was.
    expect(await story(db, THE_ATHLETE, askMode)).toBe('edge');
    expect(await state(db)).toEqual(UNTOUCHED);
    await db.drop();
  });

  // ----------------------------------------------------------
  // The choice to
  // ----------------------------------------------------------
  it('with pg_cron: no job and mode edge before; four jobs, the function and mode cron after; no job and mode edge again after the rollback — and no row of the app is written by either file', async () => {
    const db = await production();
    expect(await jobsOf(db)).toEqual([]);
    expect(await story(db, THE_ATHLETE, askMode)).toBe('edge');
    const MISSING = 'function public.record_push_failures() does not exist';
    expect(await story(db, `select ${RECORD}`)).toBe(MISSING);

    await db.runFile(migration.paths.migration);
    expect(await jobsOf(db)).toEqual(AS_MADE);
    expect(await story(db, THE_ATHLETE, askMode)).toBe('cron');
    // The file runs no job and no function: what the jobs will do, they have not done.
    expect(await state(db)).toEqual(UNTOUCHED);
    // The first run of sl-push-failures: the hour that is over and had failures — one line.
    expect(await runJob(db, 'sl-push-failures')).toEqual({ hours: 1, failed: 3 });
    expect(await db.query.value(`select message from public.client_errors`)).toMatch(
      /^Push: 3 of 4 requests the database sent to send-push failed between .+ UTC — 2 × HTTP 502, 1 × no answer in time$/,
    );
    // The first night of sl-retention: the rest push of a month ago goes, the one that is running stays.
    expect(await runJob(db, 'sl-retention')).toEqual({ scheduled_pushes: 1, notifications: 0, client_errors: 0 });
    expect(await db.query.rows(`select id from public.scheduled_pushes`)).toEqual([{ id: R_RUNNING }]);

    await db.runFile(migration.paths.rollback);
    expect(await jobsOf(db)).toEqual([]);
    expect(await story(db, THE_ATHLETE, askMode)).toBe('edge');
    expect(await story(db, `select ${RECORD}`)).toBe(MISSING);
    // What the jobs did does not come back, and the line stays in the coach's list.
    expect(await state(db)).toEqual({ ...UNTOUCHED, rest_pushes: 1, errors: 1 });
    expect(page).toContain('**What the jobs did does not come back**');

    // Applied again: four jobs, not eight — and the hour that was written is not written again.
    await db.runFile(migration.paths.migration);
    expect(await jobsOf(db)).toEqual(AS_MADE);
    expect(await runJob(db, 'sl-push-failures')).toEqual({ hours: 0, failed: 0 });
    await db.drop();
  });

  // "Old client keeps inserting rows directly": the requests of the app and
  // the statements of the dispatch-rest-push that are deployed.
  it('the app and the Edge Function that are deployed do what they did: before, after, and after the rollback', async () => {
    const db = await production();
    const NEW = '00000000-0000-4000-8000-000000000999';
    const deployed = () => story(db,
      THE_ATHLETE,
      `insert into public.scheduled_pushes (id, user_id, fire_at, payload) values ('${NEW}', '${ATHLETE}', now() + interval '45 seconds', '{"title": "Rest done"}') returning id`,
      THE_SERVICE_ROLE,
      `select public.claim_rest_push('${NEW}')`,
      `update public.scheduled_pushes set status = 'sent', sent_at = now(), error = null where id = '${NEW}'`,
      // The next rest, taken back by the app before its time.
      THE_ATHLETE,
      `update public.scheduled_pushes set canceled_at = now() where id = '${R_RUNNING}' and status = 'pending'`,
      THE_SERVICE_ROLE,
      `select public.claim_rest_push('${R_RUNNING}')`,
      THE_ATHLETE,
      `select string_agg(status, ' ' order by fire_at) from public.scheduled_pushes where id in ('${NEW}', '${R_RUNNING}')`);
    // The one that was taken back is closed by the sender that asks for it.
    const AS_BEFORE = 'sent canceled';

    expect(await deployed()).toBe(AS_BEFORE);
    await db.runFile(migration.paths.migration);
    expect(await deployed()).toBe(AS_BEFORE);
    await db.runFile(migration.paths.rollback);
    expect(await deployed()).toBe(AS_BEFORE);
    await db.drop();
  });

  it('adds 1 function, 4 jobs and its line of the ledger — no table, no column, no policy, no trigger, no privilege of what was there', async () => {
    const db = await production();
    const before = await catalogSnapshot(db.query);
    await db.runFile(migration.paths.migration);
    const after = await catalogSnapshot(db.query);

    const diff = diffCatalogs(before, after, { left: 'before', right: 'after' });
    const only = (side) => diff.filter((row) => row.endsWith(`: only in ${side}`)).map((row) => row.slice(0, -`: only in ${side}`.length));
    expect(only('after')).toEqual([`functions ${RECORD}`]);
    expect(only('before')).toEqual([]);
    expect(diff.filter((row) => !/: only in (before|after)$/.test(row)).map((row) => /^(.*?): (\w+): /.exec(row).slice(1, 3).join(' → ')))
      .toEqual(['data rows of app_private.app_migrations → rows', 'data rows of cron.job → rows']);
    expect(after.data['rows of cron.job'].rows.map((row) => JSON.parse(row)).sort((a, b) => (a.jobname < b.jobname ? -1 : 1))).toEqual(
      JOBS.map((job) => ({ ...job, username: 'postgres', active: true })),
    );

    // Its owner and the service role, nobody else; the rights of its caller; the search_path pinned.
    expect(after.functions[RECORD].privileges).toEqual(['postgres: EXECUTE', 'service_role: EXECUTE']);
    expect(after.functions[RECORD].owner).toBe('postgres');
    const header = after.functions[RECORD].definition.split(/\nAS /)[0];
    expect(header).toContain('\n RETURNS jsonb\n');
    expect(header).not.toContain('SECURITY DEFINER');
    expect(header).toContain(`\n SET search_path TO 'public', 'pg_temp'`);

    // The ledger, as the page says it reads.
    expect(await db.query.rows(`select name from ${LEDGER}`)).toHaveLength(19);
    expect(await db.query.value(`select name from ${LEDGER} order by applied_at desc, name desc limit 1`)).toBe(MIGRATION);
    expect(page).toContain(`Expected: one row more than before, and the last one is \`${MIGRATION}\` — nineteen rows when the file is applied at Checkpoint B.`);
    await db.drop();
  });

  // The runbook page tells the person applying the file what the audit prints
  // before and after. This is that table, read off the page.
  it('its audit prints the "before" and "after" columns of the runbook page', async () => {
    const db = await production();
    const audit = read(migration.paths.audit);
    const printed = async () => {
      const [result] = await db.readOnly(audit, 'audit');
      return result.rows.map((row) => [row.check, row.value]);
    };
    const table = page.split('\n')
      .map((row) => /^\| (\d+) \| (.+?) \| (.+?) \| (.+?) \|$/.exec(row))
      .filter(Boolean)
      .map(([, n, check, before, after]) => ({ n: Number(n), check, before, after }));
    expect(table.map((row) => row.n)).toEqual(Array.from({ length: 17 }, (_, i) => i + 1));
    expect(table.map((row) => row.check)).toEqual(['running as', ...Object.values(LINE)]);
    // Written between back-ticks: a value the page gives exactly. The others
    // are what the project holds on the day.
    const exact = table.filter((row) => /^`.+`$/.test(row.before) && /^`.+`$/.test(row.after))
      .map((row) => ({ ...row, before: row.before.slice(1, -1), after: row.after.slice(1, -1) }));
    expect(exact.map((row) => row.n)).toEqual([1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    expect(Object.fromEntries(exact.map((row) => [row.check, [row.before, row.after]]))).toMatchObject({
      [LINE.sender]: [BY_THE_APP, BY_THE_JOB],
      [LINE.lastRuns]: ['there is no job', NO_RUN_YET],
      [LINE.jobs]: ['none', NAMES.join(', ')],
    });
    const ON_THE_DAY = {
      [LINE.pgCron]: '1.6.4',
      [LINE.waiting]: '1',
      [LINE.runs]: '0',
      [LINE.oldRuns]: '0',
      [LINE.answers]: '5 requests, 3 of them failed',
    };
    const onPage = (column) => table.map((row) => [row.check, exact.find((e) => e.n === row.n)?.[column] ?? ON_THE_DAY[row.check]]);

    expect(await printed()).toEqual(onPage('before'));
    await db.runFile(migration.paths.migration);
    expect(await printed()).toEqual(onPage('after'));
    // …and the header of the audit file says the same.
    const header = audit.split('\n').filter((row) => row.startsWith('--')).join('\n');
    for (const { check, before, after } of exact) {
      expect(header, check).toContain(check);
      expect(header, check).toContain(before);
      expect(header, check).toContain(after);
    }
    for (const { check } of table) expect(header, check).toContain(check);
    await db.runFile(migration.paths.rollback);
    expect(await printed()).toEqual(onPage('before'));
    await db.drop();
  });

  it('line 13 of the audit is the proof that pg_cron runs the jobs: the last run of each, and what a failed one was told', async () => {
    const db = await production();
    await db.runFile(migration.paths.migration);
    const lastRuns = async () => (await printedAudit(db))[LINE.lastRuns];
    const ran = (jobname, status, ago, message = null) => db.query(
      `insert into cron.job_run_details (jobid, status, return_message, start_time, end_time, username)
       select jobid, $2, $4, now() - $3::interval, now() - $3::interval, 'postgres' from cron.job where jobname = $1`,
      [jobname, status, ago, message],
    );
    expect(await lastRuns()).toBe(NO_RUN_YET);
    expect(page).toContain('**A minute later, run the audit once more: line 13 is the proof that pg_cron runs the jobs.**');

    await ran('sl-rest-push', 'failed', '1 minute', 'ERROR: something that was repaired since');
    await ran('sl-rest-push', 'succeeded', '4 seconds', '1 row');
    await ran('sl-retention', 'succeeded', '5 hours', '1 row');
    await ran('sl-push-failures', 'failed', '50 minutes', 'ERROR: permission denied for table _http_response');
    expect(await lastRuns()).toMatch(new RegExp(
      '^sl-cron-history: no run yet; '
      + 'sl-push-failures: failed 50 min ago \\(ERROR: permission denied for table _http_response\\); '
      + 'sl-rest-push: succeeded [4-9] s ago; '
      + 'sl-retention: succeeded 5 h ago$',
    ));
    // A run that never started: pg_cron noted no time.
    await ran('sl-cron-history', 'failed', null, 'connection failed');
    await ran('sl-retention', 'succeeded', '3 days', '1 row');
    expect(await lastRuns()).toMatch(/^sl-cron-history: failed at a time pg_cron did not note \(connection failed\); .*; sl-retention: succeeded 3 days ago$/);
    expect(await printedAudit(db)).toMatchObject({ [LINE.runs]: '6', [LINE.asMade]: 'yes' });
    await db.drop();
  });

  it('the audit names a job that is not as the migration made it, and a job that is not the migration\'s', async () => {
    const db = await production();
    await db.runFile(migration.paths.migration);
    await db.query(pause('sl-rest-push'));
    await db.query(`select cron.schedule('sl-retention', '0 4 * * *', 'select public.run_retention()')`);
    await db.query(`select cron.unschedule('sl-cron-history')`);
    await db.query(`select cron.schedule('my-own-job', '0 0 * * 0', 'select 1')`);
    await db.query(`select cron.schedule('0 0 1 * *', 'select 2')`);
    const unnamed = await db.query.value(`select jobid from cron.job where jobname is null`);
    expect(await printedAudit(db)).toMatchObject({
      [LINE.jobs]: 'sl-push-failures, sl-rest-push, sl-retention',
      [LINE.asMade]: 'sl-cron-history: missing; sl-rest-push: switched off; sl-retention: another schedule (0 4 * * *)',
      [LINE.others]: `job ${unnamed}, my-own-job`,
      [LINE.sender]: BY_THE_APP,
    });
    // The check of the page sees the same three.
    expect(await checked(db)).toBe(answer('BROKEN: not there as the migration makes it, once, switched on: sl-cron-history, sl-rest-push, sl-retention'));
    // The rollback takes the three that are left, and leaves the two that are not the migration's.
    await db.runFile(migration.paths.rollback);
    expect((await jobsOf(db)).map((job) => job.jobname)).toEqual(['my-own-job', null]);
    expect(page).toContain('It leaves a job of another name alone.');
    await db.drop();
  });

  it('the audit runs where postgres may not look: it says so instead of failing', async () => {
    const db = await production();
    await db.platform(`revoke select on net._http_response from postgres`);
    expect(await printedAudit(db)).toMatchObject({ [LINE.answers]: 'net._http_response cannot be read by this role', [LINE.pgCron]: '1.6.4' });
    expect(page).toContain('`net._http_response cannot be read by this role` does: the migration refuses, stop and report.');
    await db.platform(`revoke select on cron.job_run_details from postgres`);
    expect(await printedAudit(db)).toMatchObject({ [LINE.runs]: 'pg_cron is not installed', [LINE.jobs]: 'none', [LINE.sender]: BY_THE_APP });
    await db.platform(`revoke usage on schema cron from postgres`);
    expect(await printedAudit(db)).toMatchObject({ [LINE.pgCron]: '1.6.4', [LINE.sender]: BY_THE_APP_NO_CRON, [LINE.lastRuns]: 'there is no job' });
    await db.drop();
  });

  it('the page\'s check answers NOT THERE before and "in place" after — and writes nothing either way', async () => {
    const db = await production();
    expect(pageCheck, 'the page no longer gives the check').toBeTruthy();
    // Pasted between single quotes in a shell: it may not hold one.
    expect(pageCheck).not.toContain("'");

    expect(await checked(db)).toBe(NOT_THERE);
    expect(await state(db)).toEqual(UNTOUCHED);

    await db.runFile(migration.paths.migration);
    expect(await checked(db)).toBe(IN_PLACE);
    // It ran the function for real — an hour with three failed requests was there to write — and undid it.
    expect(await state(db)).toEqual(UNTOUCHED);
    expect(await jobsOf(db)).toEqual(AS_MADE);
    // What the page says the command prints.
    expect(page).toContain(`\`${IN_PLACE}\``);
    expect(page).toContain(`\`${NOT_THERE.replace('check only, nothing was written:', '…')}\``);

    // A job made wrong by hand, one way at a time.
    expect(await story(db, pause('sl-rest-push'), pageCheck))
      .toBe(answer('BROKEN: not there as the migration makes it, once, switched on: sl-rest-push'));
    expect(await story(db, `select cron.schedule('sl-push-failures', '7 * * * *', 'select 1')`, pageCheck))
      .toBe(answer('BROKEN: not there as the migration makes it, once, switched on: sl-push-failures'));
    await db.platform(`select cron.schedule('sl-retention', '17 3 * * *', 'select public.run_retention()')`);
    expect(await checked(db)).toBe(answer('BROKEN: not there as the migration makes it, once, switched on: sl-retention'));
    expect((await printedAudit(db))[LINE.asMade]).toBe('sl-retention: 2 jobs of that name, of supabase_admin');
    await db.platform(`select cron.unschedule('sl-retention')`);
    expect(await checked(db)).toBe(IN_PLACE);

    // The function, made wrong by hand.
    const was = await db.query.value(`select pg_get_functiondef('${RECORD}'::regprocedure)`);
    const broken = was.replace(`RETURN jsonb_build_object('hours', v_hours, 'failed', v_failed);`, `RETURN jsonb_build_object('hours', 0, 'failed', 0);`);
    expect(broken).not.toBe(was);
    await db.query(broken);
    expect(await checked(db)).toBe(answer('BROKEN: record_push_failures did not answer how many hours it wrote a line for'));
    await db.query(was);
    // Handed to a signed-in user: stopped further in, at a table that is not theirs — and that is not "refused".
    await db.query(`grant execute on function ${RECORD} to authenticated`);
    expect(await checked(db)).toBe(answer('NOT PROTECTED: a signed-in user got into record_push_failures'));
    // …and with the table of pg_net as well, all the way: the line itself is what the policy of client_errors refuses.
    await db.platform(`grant select on net._http_response to authenticated`);
    expect(await checked(db)).toBe(answer('NOT PROTECTED: a signed-in user got into record_push_failures'));
    await db.platform(`revoke select on net._http_response from authenticated`);
    await db.query(`revoke execute on function ${RECORD} from authenticated`);
    expect(await checked(db)).toBe(IN_PLACE);
    expect(page).toContain('- `… NOT PROTECTED: …` or `… BROKEN: …` — **roll back**, and report the full message.');

    expect(await state(db)).toEqual(UNTOUCHED);
    await db.drop();
  });

  // ----------------------------------------------------------
  // Refusals
  // ----------------------------------------------------------
  it('without migration 18 it says so (SLM02) — before it asks for the extension — and its rollback says there is nothing to undo (SLM03)', async () => {
    const refusals = async (db) => {
      const before = await catalogSnapshot(db.query);
      const refused = await attempt(() => db.runFile(migration.paths.migration));
      const undone = await attempt(() => db.runFile(migration.paths.rollback));
      expect(diffCatalogs(before, await catalogSnapshot(db.query), { left: 'before', right: 'after' })).toEqual([]);
      return [refused.error?.code, refused.error?.message, undone.error?.code];
    };
    const needs = 'needs 2026_10_13_18_retention, which is not applied';
    // Without a ledger at all, and without pg_cron.
    const bare = await scratchDatabase();
    await bare.runFile(manifest.baseline);
    let [code, message, undone] = await refusals(bare);
    expect([code, undone]).toEqual([REFUSAL.predecessorMissing, REFUSAL.notApplied]);
    expect(message).toContain(needs);
    await bare.drop();
    // With the migrations before 18, and pg_cron.
    const db = await production({ upTo: '2026_10_13_18_retention' });
    [code, message, undone] = await refusals(db);
    expect([code, undone]).toEqual([REFUSAL.predecessorMissing, REFUSAL.notApplied]);
    expect(message).toContain(needs);
    expect(page).toContain(`| \`${needs}\` (code \`SLM02\`) |`);
    await db.drop();
  });

  it('refuses to run as another role than postgres — the migration and its rollback', async () => {
    const db = await production();
    const asServiceRole = (text) => {
      const changed = text.replace(`SET LOCAL lock_timeout = '5s';`, `SET LOCAL lock_timeout = '5s';\nSET LOCAL ROLE service_role;`);
      expect(changed).not.toBe(text);
      return changed;
    };
    expect(await refusalOf(db, () => db.runSql(asServiceRole(read(migration.paths.migration)), 'migration')))
      .toContain(`migration ${MIGRATION} must be run as postgres, not as service_role`);
    await db.runFile(migration.paths.migration);
    // A job is removed by the role it belongs to. The ledger itself is not the service role's to read.
    expect((await attempt(() => db.runSql(asServiceRole(read(migration.paths.rollback)), 'rollback'))).error?.message)
      .toMatch(/permission denied for schema app_private|must be run as postgres/);
    expect(await jobsOf(db)).toEqual(AS_MADE);
    expect(await db.query.value(`select current_user::text`)).toBe('postgres');
    await db.drop();
  });

  it('refuses a pg_cron that does not run a job every ten seconds', async () => {
    const db = await production();
    for (const [version, refused] of [['1.4', true], ['1.4-1', true], ['1.3.1', true], ['0.9', true], ['1.5', false], ['1.10.2', false]]) {
      await db.platform(`update pg_extension set extversion = '${version}' where extname = 'pg_cron'`);
      if (refused) {
        expect(await refusalOf(db), version).toContain(`migration ${MIGRATION} needs pg_cron 1.5 or later, and this project has ${version}`);
        expect((await printedAudit(db))[LINE.pgCron]).toBe(version);
      } else {
        await db.runFile(migration.paths.migration);
        await db.runFile(migration.paths.rollback);
      }
    }
    expect(page).toContain('| `needs pg_cron 1.5 or later` |');
    await db.drop();
  });

  // The schema is pg_cron's, its tables and functions are given to postgres
  // by the platform, and the table of answers is pg_net's.
  it('refuses to run when something its jobs are made of is not there, or not postgres\'s to use — and changes nothing', async () => {
    const db = await production();
    const doesNotFind = `migration ${MIGRATION} does not find what its jobs are made of, or may not use it as postgres: `;

    await db.platform(`revoke select on net._http_response from postgres`);
    await db.platform(`revoke delete on cron.job_run_details from postgres`);
    expect(await refusalOf(db)).toContain(`${doesNotFind}cron.job_run_details, to read and to delete from, net._http_response, to read`);
    await db.platform(`grant select on net._http_response to postgres`);
    await db.platform(`grant delete on cron.job_run_details to postgres`);

    await db.platform(`alter function cron.schedule(text, text, text) rename to schedule_by_name`);
    await db.platform(`alter function cron.unschedule(text) rename to unschedule_by_name`);
    expect(await refusalOf(db)).toContain(`${doesNotFind}cron.schedule(text, text, text), to execute, cron.unschedule(text), to execute`);
    await db.platform(`alter function cron.schedule_by_name(text, text, text) rename to schedule`);
    await db.platform(`alter function cron.unschedule_by_name(text) rename to unschedule`);

    await db.query(`alter function public.run_retention() rename to run_the_retention`);
    expect(await refusalOf(db)).toContain(`${doesNotFind}public.run_retention() (migration 18)`);
    expect(await printedAudit(db)).toMatchObject({ [LINE.runs16And18]: 'NO: run_retention is not there' });
    await db.query(`alter function public.run_the_retention() rename to run_retention`);
    expect(page).toContain('| `does not find what its jobs are made of, or may not use it as postgres: …` |');

    await db.platform(`alter table net._http_response rename column created to created_at`);
    await db.query(`alter table public.client_errors rename column url to page`);
    expect(await refusalOf(db)).toContain(
      `migration ${MIGRATION} does not find the columns its function and its jobs are written with: net._http_response.created, public.client_errors.url`,
    );
    await db.platform(`alter table net._http_response rename column created_at to created`);
    await db.query(`alter table public.client_errors rename column page to url`);
    expect(page).toContain('| `does not find the columns its function and its jobs are written with: …` |');

    // A schema postgres was not given. The catalog cannot even be read then: asked of the ledger and of the function alone.
    // (The schema of pg_net is given to the API roles too, and postgres is a member of each.)
    for (const [schema, extension, holders] of [['cron', 'pg_cron', 'postgres'], ['net', 'pg_net', 'postgres, anon, authenticated, service_role']]) {
      await db.platform(`revoke usage on schema ${schema} from ${holders}`);
      const refused = await attempt(() => db.runFile(migration.paths.migration));
      expect(refused.error?.message, schema).toContain(`migration ${MIGRATION} may not use the schema ${schema} of ${extension} as postgres`);
      await db.platform(`grant usage on schema ${schema} to ${holders}`);
      expect(await db.query.one(
        `select (select count(*) from ${LEDGER} where name = $1) as signed, to_regprocedure('${RECORD}') is null as no_function,
                (select count(*) from cron.job) as jobs`, [MIGRATION],
      )).toEqual({ signed: 0, no_function: true, jobs: 0 });
    }
    expect(page).toContain('| `may not use the schema cron of pg_cron` or `may not use the schema net of pg_net` |');

    await db.runFile(migration.paths.migration);
    expect(await jobsOf(db)).toEqual(AS_MADE);
    await db.drop();
  });

  it('refuses to run next to a function or a job of its names, and changes nothing', async () => {
    const db = await production();

    // A function with arguments: it would stay next to the new one.
    await db.query(`create function public.record_push_failures(p_hours integer) returns void language sql as 'select'`);
    expect(await refusalOf(db)).toContain(`migration ${MIGRATION} would not create: record_push_failures(integer) is already there`);
    expect(await printedAudit(db)).toMatchObject({ [LINE.strangers]: 'record_push_failures(integer)', [LINE.there]: 'no' });
    expect(page).toContain('- **5** is not `none` — **stop and report the line.**');
    await db.query(`drop function public.record_push_failures(integer)`);
    // Without: the audit reads `yes`, and the ledger does not know why.
    await db.query(`create function public.record_push_failures() returns jsonb language sql as 'select null::jsonb'`);
    expect(await refusalOf(db)).toContain(`migration ${MIGRATION} would not create: record_push_failures() is already there`);
    expect(await printedAudit(db)).toMatchObject({ [LINE.strangers]: 'none', [LINE.there]: 'yes' });
    expect(page).toContain('| `would not create: … is already there` |');
    await db.query(`drop function public.record_push_failures()`);

    // A job of one of the names, made by hand: schedule_rest_push answers mode cron for the name alone.
    await db.query(`select cron.schedule('sl-rest-push', '30 seconds', 'select public.dispatch_due_rest_pushes()')`);
    expect(await story(db, THE_ATHLETE, askMode)).toBe('cron');
    expect(await refusalOf(db)).toContain(`migration ${MIGRATION} would not schedule: a job named sl-rest-push (of postgres) is already there`);
    expect(await printedAudit(db)).toMatchObject({ [LINE.jobs]: 'sl-rest-push', [LINE.sender]: BY_THE_JOB });
    expect(page).toContain('- **9** is not `none` — **stop and report the line.**');
    // Switched off, and one of another role next to it.
    await db.query(pause('sl-rest-push'));
    await db.platform(`select cron.schedule('sl-retention', '17 3 * * *', 'select public.run_retention()')`);
    expect(await refusalOf(db)).toContain(
      `would not schedule: a job named sl-rest-push (of postgres, switched off), sl-retention (of supabase_admin) is already there`,
    );
    expect(page).toContain('| `would not schedule: a job named … is already there` |');
    await db.query(`select cron.unschedule('sl-rest-push')`);
    await db.platform(`select cron.unschedule('sl-retention')`);

    // Whoever runs it, and with whatever search_path: applied that way, it is
    // the same database as applied the usual way.
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

  // The privileges stand next to the function, and each job is read back.
  it('undoes itself when the result is not the one it meant: a function that is open, a job that is not switched on or not postgres\'s', async () => {
    const db = await production();
    const text = read(migration.paths.migration);
    // Supabase's own defaults, as they were before migration 03.
    await db.query(`alter default privileges for role postgres grant execute on functions to public`);
    await db.query(`alter default privileges for role postgres in schema public grant execute on functions to anon, authenticated`);
    await db.runFile(migration.paths.migration);
    expect(await printedAudit(db)).toMatchObject({ [LINE.who]: 'service_role' });
    expect(await story(db, NOBODY, `select ${RECORD}`)).toBe('permission denied for function record_push_failures');
    await db.runFile(migration.paths.rollback);

    const forgot = text.replace(`REVOKE ALL ON FUNCTION ${RECORD} FROM PUBLIC, anon, authenticated;\n`, '');
    expect(forgot).not.toBe(text);
    expect(await refusalOf(db, () => db.runSql(forgot, 'migration'))).toContain(
      `migration ${MIGRATION} did not get the function it meant: ${RECORD}: anon may execute it, PUBLIC may execute it, a signed-in user may execute it`,
    );
    const asOwner = text.replace('RETURNS jsonb\nLANGUAGE plpgsql\nSECURITY INVOKER', 'RETURNS jsonb\nLANGUAGE plpgsql\nSECURITY DEFINER');
    expect(asOwner).not.toBe(text);
    expect(await refusalOf(db, () => db.runSql(asOwner, 'migration')))
      .toContain(`migration ${MIGRATION} did not get the function it meant: ${RECORD}: it runs as its owner`);

    // A pg_cron that makes a job switched off, then one that makes it for another role.
    const stub = await db.query.value(`select pg_get_functiondef('cron.schedule(text, text, text)'::regprocedure)`);
    for (const [how, replaced] of [
      ['switched off', stub.replace('(schedule, command, username, jobname)\n  VALUES ($2, $3, v_user, $1)', '(schedule, command, username, jobname, active)\n  VALUES ($2, $3, v_user, $1, false)')],
      ['of another role', stub.replace('VALUES ($2, $3, v_user, $1)', `VALUES ($2, $3, 'supabase_admin', $1)`)],
    ]) {
      expect(replaced, how).not.toBe(stub);
      await db.platform(replaced);
      expect(await refusalOf(db), how).toContain(
        `migration ${MIGRATION} did not get the jobs it meant: sl-rest-push, sl-retention, sl-push-failures, sl-cron-history`,
      );
      expect(await jobsOf(db), how).toEqual([]);
    }
    await db.platform(stub);
    expect(page).toContain('| `did not get the jobs it meant: …` or `did not get the function it meant: …` |');
    await db.runFile(migration.paths.migration);
    expect(await jobsOf(db)).toEqual(AS_MADE);
    await db.drop();
  });

  // ----------------------------------------------------------
  // The rollback: the way out of a choice
  // ----------------------------------------------------------
  it('its rollback is NOT refused while the ledger records a later migration — and the migration is applied as well after them as before', async () => {
    const db = await production();
    // Months later: the checkpoints after B are in the database.
    await db.query(`insert into ${LEDGER} (name) values ($1)`, [TO_COME]);
    await db.runFile(migration.paths.migration);
    expect(await jobsOf(db)).toEqual(AS_MADE);
    await db.runFile(migration.paths.rollback);
    expect(await jobsOf(db)).toEqual([]);
    expect(await db.query.rows(`select name from ${LEDGER} where name in ($1, $2)`, [MIGRATION, TO_COME])).toEqual([{ name: TO_COME }]);
    expect(page).toContain('It is **not** refused while a later migration is in the ledger, unlike the other rollbacks');
    // …while what it is made of cannot go from under it.
    await db.runFile(migration.paths.migration);
    await db.query(`delete from ${LEDGER} where name = $1`, [TO_COME]);
    for (const name of ['2026_10_13_18_retention', '2026_10_13_16_rest_push_scheduling']) {
      const earlier = manifest.migrations.find((m) => m.name === name);
      const refused = await attempt(() => db.runFile(earlier.paths.rollback));
      expect(refused.error?.code, name).toBe(REFUSAL.stillNeeded);
      expect(refused.error.message, name).toContain(MIGRATION);
    }
    expect(await jobsOf(db)).toEqual(AS_MADE);
    await db.drop();
  });

  it('its rollback removes what is left of the four jobs, and stops for one that belongs to another role', async () => {
    const db = await production();
    await db.runFile(migration.paths.migration);
    // One removed by hand since, one switched off.
    await db.query(`select cron.unschedule('sl-cron-history')`);
    await db.query(pause('sl-rest-push'));
    await db.runFile(migration.paths.rollback);
    expect(await jobsOf(db)).toEqual([]);
    expect(await db.query.value(`select to_regprocedure('${RECORD}') is null`)).toBe(true);

    // A function of the same name made AFTERWARDS, with arguments, is not the rollback's to drop.
    await db.runFile(migration.paths.migration);
    await db.query(`create function public.record_push_failures(p_hours integer) returns void language sql as 'select'`);
    await db.runFile(migration.paths.rollback);
    expect(await db.query.value(`select to_regprocedure('public.record_push_failures(integer)') is not null`)).toBe(true);
    await db.query(`drop function public.record_push_failures(integer)`);

    // A job of one of the names that is somebody else's: schedule_rest_push would go on answering mode cron for it.
    await db.runFile(migration.paths.migration);
    await db.query(`select cron.unschedule('sl-rest-push')`);
    await db.platform(`select cron.schedule('sl-rest-push', '10 seconds', 'select 1')`);
    const before = await catalogSnapshot(db.query);
    const refused = await attempt(() => db.runFile(migration.paths.rollback));
    expect(refused.error?.message).toContain(`the rollback of ${MIGRATION} could not remove: sl-rest-push (of supabase_admin)`);
    expect(diffCatalogs(before, await catalogSnapshot(db.query), { left: 'before', right: 'after' })).toEqual([]);
    expect((await jobsOf(db)).map((job) => `${job.jobname} of ${job.username}`)).toEqual([
      'sl-cron-history of postgres', 'sl-push-failures of postgres', 'sl-rest-push of supabase_admin', 'sl-retention of postgres',
    ]);
    expect(page).toContain('`could not remove: …` — stop and report');
    await db.drop();
  });

  // "Never switch the extension off before the rollback" — and what to do when it happened.
  it('where the extension was switched off first, the jobs are gone with it and a rest is sent through the function again; the rollback still runs, and the migration applies again once pg_cron is back', async () => {
    const db = await production();
    await db.runFile(migration.paths.migration);
    expect(await story(db, THE_ATHLETE, askMode)).toBe('cron');

    // Database → Extensions → pg_cron, off: DROP EXTENSION takes the schema with it.
    await db.platform(`drop schema cron cascade; delete from pg_extension where extname = 'pg_cron'`);
    expect(await story(db, THE_ATHLETE, askMode)).toBe('edge');
    // The ledger still says the migration is applied, and the function is there with nothing to call it.
    expect(await db.query.one(
      `select (select count(*) from ${LEDGER} where name = $1) as signed, to_regprocedure('${RECORD}') is not null as function`, [MIGRATION],
    )).toEqual({ signed: 1, function: true });
    expect(await printedAudit(db)).toMatchObject({
      [LINE.pgCron]: 'not installed', [LINE.there]: 'yes', [LINE.jobs]: 'none', [LINE.sender]: BY_THE_APP_NO_CRON,
    });
    expect(await checked(db)).toBe(NO_PG_CRON);
    expect((await attempt(() => db.runFile(migration.paths.migration))).error?.code).toBe(REFUSAL.alreadyApplied);

    await db.runFile(migration.paths.rollback);
    expect(await db.query.one(
      `select (select count(*) from ${LEDGER} where name = $1) as signed, to_regprocedure('${RECORD}') is not null as function`, [MIGRATION],
    )).toEqual({ signed: 0, function: false });
    expect(decisionPage).toContain('**Run the rollback all the same**: it finds no job to remove, drops the function and takes the migration off the ledger.');
    // Without the extension the file refuses as it does for a project that never had it…
    expect((await attempt(() => db.runFile(migration.paths.migration))).error?.code).toBe(REFUSAL.extensionMissing);
    // …and applies once it is back.
    await db.enableExtension('pg_cron');
    await db.runFile(migration.paths.migration);
    expect(await jobsOf(db)).toEqual(AS_MADE);
    expect(await story(db, THE_ATHLETE, askMode)).toBe('cron');
    await db.drop();
  });
});
