// One way out of the database for a push, and what a device's endpoint may
// hold — review findings P35 (the database's half) and B3, and the vault name
// L25 asks for; migration 2026_10_13_15_push_plumbing.
//
// THE HOLES
//   P35  Eleven functions — six notification triggers, five RPCs of the
//        coach — each carried its own copy of the block that reads two
//        secrets from the vault and calls the send-push Edge Function through
//        pg_net. None passed a time limit, so pg_net used its own (2 or 5
//        seconds, depending on its version): a cold start of the function
//        was a push that never left, and nothing said so.
//   L25  The bearer of send-push is stored as `app_service_role_key`, which
//        it is not; eleven functions read that name, so it could not change.
//   B3   An account writes the endpoint of its own device, and the Edge
//        Functions POST to whatever the column holds.
//
// THE RULES, each held below:
//   send_push_event(p_user, p_payload, p_options)
//                     the ONLY function of public that reads the vault or
//                     calls pg_net: the address, the bearer (under
//                     app_internal_bearer, else app_service_role_key), ten
//                     seconds, and a body that is the recipient, the payload,
//                     a ttl of one day and the caller's options. NULL, and no
//                     request, while the vault is not configured. For its
//                     owner and the service role; SECURITY INVOKER.
//   the eleven        ask it for their push inside their own EXCEPTION net,
//                     and send what they sent before: a push that cannot be
//                     queued never fails the write that caused it.
//   the endpoint      https, at one of four push services, then a path —
//                     supabase/tests/fixtures/push-endpoints.json. Validated
//                     by the migration when no row breaks it; otherwise for
//                     new and changed rows only.
//
// The first blocks are PERMANENT: they run against schema.sql, so they hold
// for every function a later migration adds. A NEW FUNCTION THAT SENDS A
// PUSH joins LATER_SENDERS below — the test names what it must look like.
// Then the migration file itself, on the frozen production baseline: the
// eleven pushes before and after, the checks of its runbook page read off the
// page, its refusals, its rollback.
//
// SHIM LIMIT: pg_net is a stub (shim.sql, section 6) that records a request
// and never sends it. What is asserted is what is handed to pg_net — the
// time limit included — not what a push service receives.

import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  asAdmin, asAnon, asService, asUser, attempt, createDraftProgram, enablePush, httpCalls,
  repoRoot, scenario, scratchDatabase, seed,
} from './harness.js';
import { catalogSnapshot, diffCatalogs } from './catalog.js';
import { LEDGER, loadManifest, REFUSAL } from '../migrations/manifest.js';

const MIGRATION = '2026_10_13_15_push_plumbing';
const manifest = loadManifest();
const migration = manifest.migrations.find((m) => m.name === MIGRATION);
const read = (file) => fs.readFileSync(path.join(repoRoot, file), 'utf8');

const HELPER = 'public.send_push_event(uuid, jsonb, jsonb)';
const RULE = 'push_subscriptions_endpoint_known_push_service';
const ENDPOINTS = JSON.parse(read('supabase/tests/fixtures/push-endpoints.json'));

/**
 * The functions that tell somebody that something happened, with the sentence
 * each writes to the log when its push cannot be queued. A function that
 * joins this list calls send_push_event inside a block of its own:
 *
 *     BEGIN
 *       PERFORM public.send_push_event(…);
 *     EXCEPTION WHEN OTHERS THEN
 *       RAISE WARNING '… failed: %', SQLERRM;
 *     END;
 *
 * and is SECURITY DEFINER — send_push_event has no right of its own.
 */
const THE_ELEVEN = {
  adopt_skip: 'send-push fan-out (skip adopted) failed: %',
  adopt_swap: 'send-push fan-out (swap adopted) failed: %',
  approve_program: 'send-push fan-out (program approved) failed: %',
  decline_promote_request: 'send-push fan-out (promote declined) failed: %',
  notify_coach_on_program_submit: 'send-push fan-out (program submitted) failed: %',
  notify_coach_on_promote_request: 'send-push fan-out (promote request) failed: %',
  notify_coach_on_session_confirm: 'send-push fan-out (session confirm) failed: %',
  notify_coach_on_slot_deviation: 'send-push fan-out (slot deviation) failed: %',
  notify_recipient_on_chat_message: 'chat push fan-out failed: %',
  notify_student_on_session_feedback: 'send-push fan-out failed: %',
  send_back_program: 'send-push fan-out (program sent back) failed: %',
};
const ELEVEN_NAMES = Object.keys(THE_ELEVEN).join(', ');
/**
 * The functions that send a push and came after migration 15, which
 * re-created the eleven above and no other: the same block, the same
 * SECURITY DEFINER, the sentence of its own warning.
 */
const LATER_SENDERS = {
  // 2026_10_13_16_rest_push_scheduling: what the pg_cron job runs — a rest
  // push that is due is handed to send-push with the time not to send before.
  dispatch_due_rest_pushes: 'send-push hand-over (rest push) failed: %',
};
/** Every function of public that asks send_push_event for a push, by name. */
const EVERY_SENDER = { ...THE_ELEVEN, ...LATER_SENDERS };

const URL = 'https://functions.sl.test/functions/v1';
const BEARER = 'test-internal-bearer';
const TEN_SECONDS = 10000;
const ONE_DAY = 86400;

let ids;
beforeAll(async () => { ids = await seed(); });

const denied = (error) => error?.code === '42501' && /^permission denied for /.test(error.message);

// ============================================================
// PERMANENT — send_push_event, against schema.sql
// ============================================================
describe('send_push_event', () => {
  const PAYLOAD = { title: 'Session completed', body: 'Alex completed Pull', tag: 'session-confirm-1', data: { url: '/sl_app/#/coach' } };
  const send = (q, ...args) => q.value(
    `select public.send_push_event(${args.map((_, i) => `$${i + 1}`).join(', ')})`,
    args.map((arg) => (arg !== null && typeof arg === 'object' ? JSON.stringify(arg) : arg)),
  );

  it('queues one request: the address, the bearer, ten seconds, and a body that is the recipient, the payload and a day to deliver it', () => scenario(async (q) => {
    await enablePush();
    const id = await send(q, ids.studentA.id, PAYLOAD);
    expect(await httpCalls()).toEqual([{
      id,
      method: 'POST',
      url: `${URL}/send-push`,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${BEARER}` },
      body: { user_id: ids.studentA.id, payload: PAYLOAD, ttl: ONE_DAY },
      timeout_milliseconds: TEN_SECONDS,
    }]);
    // What it answers is the id pg_net gave the request.
    expect(typeof id).toBe('number');
  }));

  it('writes the options of its caller next to the recipient and the payload, which they cannot replace', () => scenario(async (q) => {
    await enablePush();
    await send(q, ids.studentA.id, PAYLOAD, {
      ttl: 60, urgency: 'high', schedule_id: 'a-row', not_before: '2026-10-13T08:00:00Z',
      // Not options: the two arguments are who is told and what.
      user_id: ids.coach.id, payload: { title: 'Forged' },
    });
    // Left out, NULL, or empty: no option.
    await send(q, ids.studentA.id, PAYLOAD, null);
    await send(q, ids.studentA.id, PAYLOAD, {});
    const [withOptions, ...without] = (await httpCalls()).map((call) => call.body);
    expect(withOptions).toEqual({
      user_id: ids.studentA.id, payload: PAYLOAD, ttl: 60, urgency: 'high', schedule_id: 'a-row', not_before: '2026-10-13T08:00:00Z',
    });
    expect(without).toEqual([
      { user_id: ids.studentA.id, payload: PAYLOAD, ttl: ONE_DAY },
      { user_id: ids.studentA.id, payload: PAYLOAD, ttl: ONE_DAY },
    ]);
    for (const call of await httpCalls()) expect(call.timeout_milliseconds).toBe(TEN_SECONDS);
  }));

  it('reads the bearer under app_internal_bearer, and under app_service_role_key while the vault has none of that name', () => scenario(async (q) => {
    const sentWith = async () => {
      await q(`delete from net.http_request_queue`);
      await send(q, ids.studentA.id, PAYLOAD);
      return (await httpCalls()).map((call) => call.headers.Authorization);
    };
    // As production holds it today.
    await enablePush({ bearer: 'stored-under-the-old-name' });
    expect(await sentWith()).toEqual(['Bearer stored-under-the-old-name']);
    // Renamed.
    await enablePush({ bearer: 'stored-under-its-own-name', bearerName: 'app_internal_bearer' });
    expect(await sentWith()).toEqual(['Bearer stored-under-its-own-name']);
    // Both: its own name is the one that is sent.
    await q(`select vault.create_secret('a-leftover', 'app_service_role_key')`);
    expect(await sentWith()).toEqual(['Bearer stored-under-its-own-name']);
    // An empty one under the new name is no bearer: the old name still serves.
    await q(`delete from vault.secrets where name = 'app_internal_bearer'`);
    await q(`select vault.create_secret('', 'app_internal_bearer')`);
    expect(await sentWith()).toEqual(['Bearer a-leftover']);
  }));

  it('queues nothing, and answers NULL, while the vault lacks the address or the bearer', () => scenario(async (q) => {
    const tried = async () => {
      const answer = await send(q, ids.studentA.id, PAYLOAD);
      return [answer, (await httpCalls()).length];
    };
    // Nothing at all: a project that does not send pushes.
    expect(await tried()).toEqual([null, 0]);
    await q(`select vault.create_secret($1, 'app_functions_url')`, [URL]);
    expect(await tried()).toEqual([null, 0]);
    await q(`select vault.create_secret('', 'app_service_role_key')`);
    expect(await tried()).toEqual([null, 0]);
    await q(`delete from vault.secrets`);
    await q(`select vault.create_secret($1, 'app_internal_bearer')`, [BEARER]);
    expect(await tried()).toEqual([null, 0]);
    await q(`select vault.create_secret('', 'app_functions_url')`);
    expect(await tried()).toEqual([null, 0]);
    // …and with both, it goes.
    await q(`delete from vault.secrets where name = 'app_functions_url'`);
    await q(`select vault.create_secret($1, 'app_functions_url')`, [`${URL}/`]);
    const [answer, queued] = await tried();
    expect([typeof answer, queued]).toEqual(['number', 1]);
    // An address stored with its last slash is the same address.
    expect((await httpCalls())[0].url).toBe(`${URL}/send-push`);
  }));

  it('refuses a call without a recipient, and a payload or options that are not a JSON object — and queues nothing', () => scenario(async (q) => {
    await enablePush();
    const NEEDS = 'send_push_event needs a recipient and a payload that is a JSON object';
    const OPTIONS = 'send_push_event takes its options as a JSON object';
    const cases = [
      [[null, PAYLOAD], NEEDS],
      [[ids.studentA.id, null], NEEDS],
      [[ids.studentA.id, [PAYLOAD]], NEEDS],
      [[ids.studentA.id, '"a title"'], NEEDS],
      [[ids.studentA.id, 'null'], NEEDS],
      [[ids.studentA.id, PAYLOAD, [{ ttl: 60 }]], OPTIONS],
      [[ids.studentA.id, PAYLOAD, '60'], OPTIONS],
      [[ids.studentA.id, PAYLOAD, 'null'], OPTIONS],
    ];
    for (const [args, message] of cases) {
      const tried = await attempt(() => send(q, ...args));
      expect(tried.error?.message, JSON.stringify(args)).toBe(message);
      expect(tried.error.code).toBe('22023');
      expect(tried.error.hint).toBe('Nothing was queued.');
    }
    expect(await httpCalls()).toEqual([]);
  }));

  it('is for its owner and the service role: a signed-in user and a request without a session are refused before it is entered', () => scenario(async () => {
    await enablePush();
    for (const [who, as] of [
      ['an athlete', (fn) => asUser(ids.studentA, fn)],
      ['the coach', (fn) => asUser(ids.coach, fn)],
      ['nobody', asAnon],
    ]) {
      const tried = await attempt(() => as((caller) => send(caller, ids.studentB.id, PAYLOAD)));
      expect(tried.error?.message, who).toBe('permission denied for function send_push_event');
      expect(tried.error.code, who).toBe('42501');
    }
    expect(await httpCalls()).toEqual([]);

    // The service role: an Edge Function, a job.
    const id = await asService((service) => send(service, ids.studentB.id, PAYLOAD));
    expect((await httpCalls()).map((call) => [call.id, call.body.user_id])).toEqual([[id, ids.studentB.id]]);
  }));

  it('has no right of its own: handed to a signed-in user by mistake, it still reaches neither the vault nor a request', () => scenario(async (q) => {
    await enablePush();
    expect(await q.one(
      `select p.prosecdef as runs_as_owner, p.provolatile::text as volatility, p.proconfig as settings,
              pg_get_userbyid(p.proowner) as owner, format_type(p.prorettype, null) as answers,
              (select array_agg(g.name order by g.name collate "C")
                 from (select case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee)::text end as name
                         from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a) g) as grantees
         from pg_proc p where p.oid = $1::regprocedure`, [HELPER],
    )).toEqual({
      runs_as_owner: false,
      volatility: 'v',
      settings: ['search_path=public, pg_temp'],
      owner: 'postgres',
      answers: 'bigint',
      grantees: ['postgres', 'service_role'],
    });

    await q(`grant execute on function ${HELPER} to authenticated`);
    const tried = await attempt(() => asUser(ids.studentA, (athlete) => send(athlete, ids.studentB.id, PAYLOAD)));
    expect(denied(tried.error), tried.error?.message ?? 'it ran').toBe(true);
    expect(tried.error.message).toMatch(/^permission denied for (schema|view|table) vault/);
    expect(await httpCalls()).toEqual([]);
  }));
});

// ============================================================
// PERMANENT — the functions that send a push, against schema.sql
// ============================================================
describe('the functions that send a push', () => {
  const bodies = () => asAdmin((q) => q.rows(
    `select p.proname::text as name, p.prosrc as body, p.prosecdef as runs_as_owner
       from pg_proc p
      where p.pronamespace = 'public'::regnamespace
      order by p.proname::text collate "C"`,
  ));
  const withoutComments = (body) => body.replace(/--.*$/gm, '');

  it('one function of public reads the vault or calls pg_net, and it is send_push_event', async () => {
    const onItsOwn = (await bodies()).filter(({ body }) => /\bnet\s*\.\s*http_|\bvault\s*\./.test(withoutComments(body)));
    expect(
      onItsOwn.map((f) => f.name),
      'a function that reads a secret or calls pg_net itself: it sends its push without the time limit, and with a '
      + 'bearer it reads under a name of its own. Ask public.send_push_event() instead — see THE_ELEVEN at the top '
      + 'of supabase/tests/push-plumbing.test.js',
    ).toEqual(['send_push_event']);
    // What makes it worth having: the limit, and the two names of the bearer.
    const [{ body }] = onItsOwn;
    expect(body).toContain('timeout_milliseconds := 10000');
    expect(body.indexOf(`'app_internal_bearer'`)).toBeGreaterThan(0);
    expect(body.indexOf(`'app_service_role_key'`)).toBeGreaterThan(body.indexOf(`'app_internal_bearer'`));
  });

  it('the functions that ask it for their push are the eleven and the ones listed since, each runs as its owner, and each keeps the call inside its own net', async () => {
    const callers = (await bodies()).filter(({ body }) => withoutComments(body).includes('send_push_event('));
    expect(
      callers.map((f) => f.name),
      'a function that sends a push and is not in LATER_SENDERS of supabase/tests/push-plumbing.test.js (or the reverse)',
    ).toEqual(Object.keys(EVERY_SENDER).sort());

    // BEGIN … PERFORM public.send_push_event(…); EXCEPTION WHEN OTHERS THEN
    // RAISE WARNING '<sentence>', SQLERRM; END; — nothing between the call and
    // the net, and no other block opened or closed in between.
    const NET = /\bBEGIN\b(?:(?!\bBEGIN\b|\bEND;)[\s\S])*?PERFORM public\.send_push_event\((?:(?!\bBEGIN\b|\bEND;)[\s\S])*?\);\s*EXCEPTION WHEN OTHERS THEN\s*RAISE WARNING '([^']+)', SQLERRM;\s*END;/g;
    for (const { name, body, runs_as_owner } of callers) {
      const code = withoutComments(body);
      // send_push_event is SECURITY INVOKER: called with the rights of a
      // signed-in user it is refused, and the net would hide the refusal.
      expect(runs_as_owner, `${name} must be SECURITY DEFINER`).toBe(true);
      expect(code.match(/send_push_event\(/g), name).toHaveLength(1);
      expect([...code.matchAll(NET)].map((match) => match[1]), `${name}: the call is not inside a BEGIN … EXCEPTION WHEN OTHERS net of its own`)
        .toEqual([EVERY_SENDER[name]]);
    }
  });

  // The eleven events, each by the statement the app sends, in one
  // transaction. `q` is the owner's.
  const theElevenEvents = async () => {
    const A = ids.studentA;
    const { coach } = ids;
    const [session] = ids.programA.sessions;
    const [pullUp, dip] = ids.programA.slots;
    const draft = await createDraftProgram(A);
    const athlete = (sql, params) => asUser(A, (user) => user(sql, params));
    const theCoach = (sql, params) => asUser(coach, (user) => user.value(sql, params));

    await athlete(`insert into session_confirmations (session_id, student_id) values ($1, $2)`, [session, A.id]);
    await athlete(`insert into slot_deviations (exercise_slot_id, student_id, kind) values ($1, $2, 'skip')`, [pullUp, A.id]);
    await athlete(`update slot_deviations set promote_requested_at = now() where exercise_slot_id = $1`, [pullUp]);
    const answers = {
      decline_promote_request: await theCoach(`select public.decline_promote_request($1)`, [pullUp]),
      adopt_swap: await theCoach(`select public.adopt_swap($1, $2)`, [pullUp, ids.exercises.squat]),
      adopt_skip: await theCoach(`select public.adopt_skip($1)`, [dip]),
    };
    await athlete(`update programs set submitted_at = now() where id = $1`, [draft.id]);
    answers.send_back_program = await theCoach(`select public.send_back_program($1)`, [draft.id]);
    answers.approve_program = await theCoach(`select public.approve_program($1)`, [draft.id]);
    await theCoach(
      `insert into messages (sender_id, recipient_id, body, session_id) values ($1, $2, 'Solid session.', $3) returning id`,
      [coach.id, A.id, session],
    );
    await athlete(`insert into messages (sender_id, recipient_id, body) values ($1, $2, 'Thanks!')`, [A.id, coach.id]);
    return answers;
  };
  const ANSWERS = {
    decline_promote_request: { declined: true },
    adopt_swap: { applied: 3, dry_run: false },
    adopt_skip: { applied: 3, dry_run: false },
    send_back_program: { sent_back: true },
    approve_program: { approved: true, set_logs_created: 6 },
  };
  // What each of them leaves in the bell — the chat message leaves nothing.
  const bell = (q) => q.rows(
    `select n.kind, case when n.recipient_id = $1 then 'coach' else 'athlete' end as "to"
       from notifications n order by n.kind`, [ids.coach.id],
  );
  const BELL = [
    { kind: 'program_approved', to: 'athlete' },
    { kind: 'program_sent_back', to: 'athlete' },
    { kind: 'program_submitted', to: 'coach' },
    { kind: 'promote_declined', to: 'athlete' },
    { kind: 'promote_requested', to: 'coach' },
    { kind: 'session_completed', to: 'coach' },
    { kind: 'session_deviation', to: 'coach' },
    { kind: 'session_feedback', to: 'athlete' },
    { kind: 'skip_adopted', to: 'athlete' },
    { kind: 'swap_adopted', to: 'athlete' },
  ];
  const written = (q) => q.one(
    `select (select count(*) from session_confirmations) as confirmations,
            (select count(*) from slot_deviations) as deviations,
            (select count(*) from messages where body in ('Solid session.', 'Thanks!')) as messages,
            (select count(*) from programs where status = 'approved' and name = 'My draft') as approved`,
  );
  const WRITTEN = { confirmations: 1, deviations: 1, messages: 2, approved: 1 };

  it('each of the eleven writes its bell row and queues exactly one push, with the time limit', () => scenario(async (q) => {
    await enablePush();
    expect(await theElevenEvents()).toEqual(ANSWERS);
    expect(await bell(q)).toEqual(BELL);
    expect(await written(q)).toEqual(WRITTEN);

    const pushes = await httpCalls();
    const coach = ids.coach.id;
    const A = ids.studentA.id;
    expect(pushes.map((call) => [call.body.user_id === coach ? 'coach' : 'athlete', call.body.payload.title])).toEqual([
      ['coach', 'Session completed'],
      ['coach', 'Off-plan session'],
      ['coach', 'Program change requested'],
      ['athlete', 'Coach kept your plan'],
      ['athlete', 'Program updated'],
      ['athlete', 'Program updated'],
      ['coach', 'Program submitted'],
      ['athlete', 'Program sent back'],
      ['athlete', 'Program approved'],
      ['athlete', 'Feedback from Coach Carla'],
      ['coach', 'Message from Alex Athlete'],
    ]);
    for (const call of pushes) {
      expect(call, call.body.payload.title).toMatchObject({
        method: 'POST',
        url: `${URL}/send-push`,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${BEARER}` },
        timeout_milliseconds: TEN_SECONDS,
      });
      // The recipient, what the service worker shows, and a day to deliver it.
      expect(Object.keys(call.body).sort()).toEqual(['payload', 'ttl', 'user_id']);
      expect(call.body.ttl).toBe(ONE_DAY);
      expect([coach, A]).toContain(call.body.user_id);
      expect(Object.keys(call.body.payload).sort()).toEqual(['body', 'data', 'tag', 'title']);
      expect(call.body.payload.data.url).toMatch(/^\/sl_app\/#\//);
    }
  }));

  it('without the secrets nothing is queued, and every write and every bell row is there all the same', () => scenario(async (q) => {
    expect(await theElevenEvents()).toEqual(ANSWERS);
    expect(await bell(q)).toEqual(BELL);
    expect(await written(q)).toEqual(WRITTEN);
    expect(await httpCalls()).toEqual([]);
  }));

  // "A failing helper never fails the trigger": pg_net that raises, a
  // send_push_event that raises, one that is not there at all.
  it.each([
    ['pg_net raises', `select set_config('shim.http_post_fails', 'on', true)`],
    ['send_push_event raises', `create or replace function public.send_push_event(p_user uuid, p_payload jsonb, p_options jsonb default '{}'::jsonb)
       returns bigint language plpgsql set search_path = public, pg_temp as $$ begin raise exception 'no push today'; end $$`],
    ['send_push_event is gone', `drop function ${HELPER}`],
  ])('a push that cannot be queued never fails the write that caused it: %s', (_, sabotage) => scenario(async (q) => {
    await enablePush();
    await q(sabotage);
    expect(await theElevenEvents()).toEqual(ANSWERS);
    expect(await bell(q)).toEqual(BELL);
    expect(await written(q)).toEqual(WRITTEN);
    expect(await httpCalls()).toEqual([]);
  }));
});

// ============================================================
// PERMANENT — the endpoint of a device, against schema.sql
// ============================================================
describe('the endpoint of a device', () => {
  // The app deployed before wave 2: its own upsert (lib/pushNotifications.js).
  const ownUpsert = (as, user, endpoint) => as((q) => q(
    `insert into push_subscriptions (user_id, endpoint, p256dh, auth, user_agent, last_seen_at) values ($1, $2, 'key', 'secret', 'A browser', now())
     on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, last_seen_at = excluded.last_seen_at`,
    [user.id, endpoint],
  ));
  // The app of wave 2.
  const claim = (as, endpoint) => as((q) => q.value(`select public.claim_push_subscription($1, 'key', 'secret')`, [endpoint]));
  const asAthlete = (fn) => asUser(ids.studentA, fn);
  const refusedByTheRule = (tried, what) => {
    expect(tried.ok, `${JSON.stringify(what)} was accepted`).toBe(false);
    expect(tried.error.code, what).toBe('23514');
    expect(tried.error.constraint, what).toBe(RULE);
    expect(tried.error.message, what).toBe(`new row for relation "push_subscriptions" violates check constraint "${RULE}"`);
  };

  it('the lists of the fixture are what a browser hands over, and what somebody could write instead', () => {
    expect(ENDPOINTS.accepted.length).toBeGreaterThanOrEqual(6);
    expect(ENDPOINTS.refused.length).toBeGreaterThanOrEqual(20);
    const all = [...ENDPOINTS.accepted, ...ENDPOINTS.refused, ...ENDPOINTS.refused_by_the_database_only];
    expect(all.filter((endpoint, i) => all.indexOf(endpoint) !== i), 'listed twice').toEqual([]);
    // Each of the four push services is in the first list.
    for (const host of ['fcm.googleapis.com', 'updates.push.services.mozilla.com', '.push.apple.com', '.notify.windows.com']) {
      expect(ENDPOINTS.accepted.some((endpoint) => endpoint.includes(`${host}/`)), host).toBe(true);
    }
  });

  it('an address at one of the four push services is registered, by the app\'s own request and through claim_push_subscription', () => scenario(async (q) => {
    for (const endpoint of ENDPOINTS.accepted) {
      await ownUpsert(asAthlete, ids.studentA, endpoint);
      expect(await claim(asAthlete, endpoint), endpoint).toMatchObject({ outcome: 'refreshed' });
      expect(await claim((fn) => asUser(ids.studentB, fn), `${endpoint}/another-device`), endpoint).toMatchObject({ outcome: 'created' });
    }
    expect(await q.value(`select count(*) from push_subscriptions`)).toBe(2 * ENDPOINTS.accepted.length);
  }));

  it('any other address is refused — whoever writes it, and whichever way', () => scenario(async (q) => {
    for (const endpoint of [...ENDPOINTS.refused, ...ENDPOINTS.refused_by_the_database_only]) {
      refusedByTheRule(await attempt(() => ownUpsert(asAthlete, ids.studentA, endpoint)), endpoint);
      refusedByTheRule(await attempt(() => claim(asAthlete, endpoint)), endpoint);
      // Row-level security does not hold the service role or the owner. The rule does.
      refusedByTheRule(await attempt(() => ownUpsert(asService, ids.studentA, endpoint)), endpoint);
      refusedByTheRule(await attempt(() => ownUpsert(asAdmin, ids.studentA, endpoint)), endpoint);
    }
    expect(await q.value(`select count(*) from push_subscriptions`)).toBe(0);
  }));

  it('a device that is registered cannot be moved to another address by an UPDATE either', () => scenario(async (q) => {
    const [phone] = ENDPOINTS.accepted;
    await ownUpsert(asAthlete, ids.studentA, phone);
    const moved = await attempt(() => asAthlete((athlete) => athlete(
      `update push_subscriptions set endpoint = 'https://example.org/collect' where endpoint = $1`, [phone],
    )));
    refusedByTheRule(moved, 'an UPDATE of the endpoint');
    expect(await q.value(`select endpoint from push_subscriptions`)).toBe(phone);
    // …and to another address at a push service, as before: its own row.
    await asAthlete((athlete) => athlete(`update push_subscriptions set endpoint = $2 where endpoint = $1`, [phone, ENDPOINTS.accepted[3]]));
    expect(await q.value(`select endpoint from push_subscriptions`)).toBe(ENDPOINTS.accepted[3]);
  }));

  it('the rule is validated in schema.sql, and written with the pattern the audit and the runbook page count with', async () => {
    const rule = await asAdmin((q) => q.one(
      `select c.convalidated as validated, pg_get_constraintdef(c.oid) as definition
         from pg_constraint c
        where c.conrelid = 'public.push_subscriptions'::regclass and c.conname = $1`, [RULE],
    ));
    expect(rule.validated).toBe(true);
    const [, pattern] = /^CHECK \(\(endpoint ~ '(.+)'::text\)\)$/.exec(rule.definition) ?? [];
    expect(pattern, rule.definition).toBeTruthy();
    // Letter for letter, wherever it is written: the migration (twice: the
    // rule, and the count that decides whether it is validated), its audit,
    // and the statement of the page that lists the rows in the way.
    for (const [file, times] of [
      [migration.paths.migration, 2], [migration.paths.audit, 1], [migration.paths.runbook, 1], ['supabase/schema.sql', 1],
    ]) {
      expect(read(file).split(`'${pattern}'`).length - 1, file).toBe(times);
    }
    // No backslash, so that it reads the same inside a shell's double quotes.
    expect(pattern).not.toMatch(/[\\$`!"]/);
  });
});

// ============================================================
// The migration file, on production as it was frozen.
//
// Everything above runs against schema.sql; parity.test.js proves that the
// baseline plus the migrations IS schema.sql. This is the direct proof for
// the file: eleven functions replaced whole must send what they sent.
// ============================================================
describe('migration 15 applied to the production baseline', () => {
  const COACH = '00000000-0000-4000-8000-00000000c0ac';
  const ATHLETE = '00000000-0000-4000-8000-0000000000a1';
  const LINK = '00000000-0000-4000-8000-000000000101';
  const PULL_UP = '00000000-0000-4000-8000-000000000201';
  const DIP = '00000000-0000-4000-8000-000000000202';
  const SQUAT = '00000000-0000-4000-8000-000000000203';
  const BLOCK = '00000000-0000-4000-8000-000000000301';
  const DRAFT = '00000000-0000-4000-8000-000000000302';
  const W1 = '00000000-0000-4000-8000-000000000401';
  const WD = '00000000-0000-4000-8000-000000000409';
  const S1 = '00000000-0000-4000-8000-000000000451';
  const S2 = '00000000-0000-4000-8000-000000000452';
  const SD = '00000000-0000-4000-8000-000000000459';
  const SLOT11 = '00000000-0000-4000-8000-000000000511';
  const SLOT12 = '00000000-0000-4000-8000-000000000512';
  const SLOT21 = '00000000-0000-4000-8000-000000000521';
  const SLOT22 = '00000000-0000-4000-8000-000000000522';
  const SLOTD = '00000000-0000-4000-8000-000000000591';
  const CONFIRMATION = '00000000-0000-4000-8000-000000000601';
  const DEVIATION = '00000000-0000-4000-8000-000000000701';
  const SWAP = '00000000-0000-4000-8000-000000000702';
  const FEEDBACK = '00000000-0000-4000-8000-000000000801';
  const CHAT = '00000000-0000-4000-8000-000000000802';
  const JUNK = '00000000-0000-4000-8000-000000000999';
  const FUNCTIONS = 'https://abcdefghijklmnopqrst.supabase.co/functions/v1';
  const SECRET = 'the-internal-bearer-of-production';
  const TO_COME = '2099_01_01_99_a_migration_to_come';

  // A coach and an athlete. Alex trains "Block": one phase, two sessions,
  // each with a pull-up and a dip of one set. He is writing "My draft". Both
  // have switched notifications on — three devices, at three push services —
  // and the vault holds the two secrets, as production does: the bearer under
  // the name it was first stored with.
  // The role is set the way a dump restore sets it: on the baseline the
  // documented `update profiles set role = 'coach'` is undone for every
  // caller (finding P20, closed by migration 07).
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
      ('${PULL_UP}', '${COACH}', 'Pull-up', 'pull', 2), ('${DIP}', '${COACH}', 'Dip', 'push', 2), ('${SQUAT}', '${COACH}', 'Squat', 'push', 1);
    insert into public.programs (id, student_id, name, is_active) values ('${BLOCK}', '${LINK}', 'Block', true);
    insert into public.programs (id, student_id, name, is_active, status, created_by) values
      ('${DRAFT}', '${LINK}', 'My draft', false, 'draft', '${ATHLETE}');
    insert into public.weeks (id, program_id, week_number) values ('${W1}', '${BLOCK}', 1), ('${WD}', '${DRAFT}', 1);
    insert into public.sessions (id, week_id, title, sort_order) values
      ('${S1}', '${W1}', 'Pull', 0), ('${S2}', '${W1}', 'Pull again', 1), ('${SD}', '${WD}', 'Mine', 0);
    insert into public.exercise_slots (id, session_id, exercise_id, sets, reps, sort_order) values
      ('${SLOT11}', '${S1}', '${PULL_UP}', 1, 5, 0), ('${SLOT12}', '${S1}', '${DIP}', 1, 5, 1),
      ('${SLOT21}', '${S2}', '${PULL_UP}', 1, 5, 0), ('${SLOT22}', '${S2}', '${DIP}', 1, 5, 1),
      ('${SLOTD}',  '${SD}', '${PULL_UP}', 2, 5, 0);
    insert into public.set_logs (exercise_slot_id, set_number, target_reps) values
      ('${SLOT11}', 1, 5), ('${SLOT12}', 1, 5), ('${SLOT21}', 1, 5), ('${SLOT22}', 1, 5);
    insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent) values
      ('${COACH}',   'https://web.push.apple.com/the-coach-s-phone', 'k', 's', 'Safari on a phone'),
      ('${ATHLETE}', 'https://fcm.googleapis.com/fcm/send/alex-s-phone', 'k', 's', 'Chrome on a phone'),
      ('${ATHLETE}', 'https://updates.push.services.mozilla.com/wpush/v2/alex-s-laptop', 'k', 's', 'Firefox on a laptop');
    select vault.create_secret('${FUNCTIONS}', 'app_functions_url');
    select vault.create_secret('${SECRET}', 'app_service_role_key');
  `;

  /** The frozen baseline with that world in it and the migrations before 15 applied. */
  const production = async ({ also = '' } = {}) => {
    const db = await scratchDatabase();
    await db.runFile(manifest.baseline);
    await db.runSql(WORLD, 'world');
    if (also) await db.runSql(also, 'world');
    for (const earlier of manifest.migrations) {
      if (earlier.name === MIGRATION) break;
      await db.runFile(earlier.paths.migration);
    }
    return db;
  };

  // One transaction, always undone. Each step is a statement, or an actor:
  // from there on the statements are a request of that user of the API, role
  // and claims set the way PostgREST sets them. The answer is the first value
  // of the last statement, or the message of the statement that raised.
  const user = (sub) => ({ role: 'authenticated', claims: { role: 'authenticated', sub } });
  const THE_COACH = user(COACH);
  const THE_ATHLETE = user(ATHLETE);
  const NOBODY = { role: 'anon', claims: { role: 'anon' } };
  const THE_SERVICE_ROLE = { role: 'service_role', claims: { role: 'service_role' } };
  const THE_OWNER = { role: 'postgres', claims: null };
  const actor = (step) => `select set_config('role', '${step.role}', true), set_config('request.jwt.claims', '${step.claims ? JSON.stringify(step.claims) : ''}', true)`;
  const story = async (db, ...steps) => {
    const statements = steps.map((step) => (typeof step === 'string' ? step : actor(step)));
    const tried = await attempt(() => db.runSql(`BEGIN;\n${statements.join(';\n')};\nROLLBACK;`, 'request'));
    if (!tried.ok) return (tried.error.cause ?? tried.error).message;
    const [found] = tried.value.at(-2).rows;
    return found ? Object.values(found)[0] : null;
  };

  // Every push the eleven functions can send, by the statements the app
  // sends — with the ids a push or a bell row carries given, so that two runs
  // can be compared — and then what they left: the requests handed to pg_net,
  // and the bell. Thirteen pushes: the two triggers on a deviation word a
  // skip and a swap differently.
  const THE_EVENTS = [
    THE_ATHLETE,
    `insert into public.session_confirmations (id, session_id, student_id) values ('${CONFIRMATION}', '${S1}', '${ATHLETE}')`,
    `insert into public.slot_deviations (id, exercise_slot_id, student_id, kind) values ('${DEVIATION}', '${SLOT11}', '${ATHLETE}', 'skip')`,
    `update public.slot_deviations set promote_requested_at = now() where id = '${DEVIATION}'`,
    THE_COACH,
    `select public.decline_promote_request('${SLOT11}')`,
    `select public.adopt_swap('${SLOT11}', '${SQUAT}')`,
    `select public.adopt_skip('${SLOT12}')`,
    THE_ATHLETE,
    // The pull-up of the second session is a squat by now: Alex does dips instead.
    `insert into public.slot_deviations (id, exercise_slot_id, student_id, kind, substitute_exercise_id) values ('${SWAP}', '${SLOT21}', '${ATHLETE}', 'swap', '${DIP}')`,
    `update public.slot_deviations set promote_requested_at = now() where id = '${SWAP}'`,
    `update public.programs set submitted_at = now() where id = '${DRAFT}'`,
    THE_COACH,
    `select public.send_back_program('${DRAFT}')`,
    `select public.approve_program('${DRAFT}')`,
    `insert into public.messages (id, sender_id, recipient_id, body, session_id) values ('${FEEDBACK}', '${COACH}', '${ATHLETE}', 'Good session.', '${S1}')`,
    THE_ATHLETE,
    `insert into public.messages (id, sender_id, recipient_id, body) values ('${CHAT}', '${ATHLETE}', '${COACH}', 'Thanks coach!')`,
    THE_OWNER,
    `select jsonb_build_object(
       'pushes', (select coalesce(jsonb_agg(jsonb_build_object('method', method, 'url', url, 'headers', headers, 'body', body,
                                                               'limit', timeout_milliseconds) order by id), '[]')
                    from net.http_request_queue),
       'bell',   (select coalesce(jsonb_agg(jsonb_build_object('to', recipient_id, 'kind', kind, 'payload', payload)
                                            order by kind, payload::text), '[]')
                    from public.notifications),
       'kept',   jsonb_build_object(
                   'confirmations', (select count(*) from public.session_confirmations),
                   'messages', (select count(*) from public.messages),
                   'pull_ups_left', (select count(*) from public.exercise_slots where exercise_id = '${PULL_UP}'),
                   'dips_left', (select count(*) from public.exercise_slots where exercise_id = '${DIP}'),
                   'approved', (select count(*) from public.programs where status = 'approved'),
                   'reviewed', (select count(*) from public.sessions where reviewed_at is not null)))`,
  ];
  const KEPT = { confirmations: 1, messages: 2, pull_ups_left: 2, dips_left: 1, approved: 2, reviewed: 1 };
  // What each push says, and to whom: the text of the eleven functions, which the migration must not change.
  const SAID = [
    ['coach', 'Session completed', 'Alex completed Pull'],
    ['coach', 'Off-plan session', 'Alex skipped Pull-up in Pull'],
    ['coach', 'Program change requested', 'Alex wants to drop Pull-up going forward'],
    ['athlete', 'Coach kept your plan', 'Coach Carla is keeping Pull-up in your program'],
    ['athlete', 'Program updated', 'Coach Carla adopted your swap: Pull-up → Squat'],
    ['athlete', 'Program updated', 'Coach Carla dropped Dip from your upcoming sessions'],
    ['coach', 'Off-plan session', 'Alex swapped Squat → Dip in Pull again'],
    ['coach', 'Program change requested', 'Alex wants to keep Dip instead of Squat'],
    ['coach', 'Program submitted', 'Alex submitted a program for approval: My draft'],
    ['athlete', 'Program sent back', 'Your coach sent your program back for changes: My draft'],
    ['athlete', 'Program approved', 'Your coach approved your program: My draft'],
    ['athlete', 'Feedback from Coach Carla', 'Good session.'],
    ['coach', 'Message from Alex', 'Thanks coach!'],
  ];
  const BELL_ROWS = 12;

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
  const listElsewhere = quoted('select pr.role, pr.full_name as account, coalesce(nullif(substring(ps.endpoint');
  const deleteOne = quoted('delete from public.push_subscriptions where id =');
  const validate = quoted('alter table public.push_subscriptions validate constraint');
  const rename = quoted(`select vault.update_secret(id, null, 'app_internal_bearer')`);
  const renameBack = quoted(`select vault.update_secret(id, null, 'app_service_role_key')`);

  const printedAudit = async (db) => {
    const [result] = await db.readOnly(read(migration.paths.audit), 'audit');
    return Object.fromEntries(result.rows.map((line) => [line.check, line.value]));
  };
  const LINE = {
    oneWay: 'every push leaves through one function, with a time limit of 10 seconds (send_push_event, P35)',
    onTheirOwn: 'functions that read the vault or call pg_net themselves',
    throughIt: 'functions that ask send_push_event for their push',
    strangers: 'functions of these names that the migration does not know',
    who: 'who may execute send_push_event',
    rule: 'an endpoint must be an address at a known push service (B3)',
    devices: 'devices registered for notifications',
    elsewhere: 'devices whose endpoint is NOT at a known push service',
    address: 'vault: the address of the functions (app_functions_url)',
    bearer: 'vault: the bearer of send-push',
    pgNet: 'pg_net takes a time limit (net.http_post … timeout_milliseconds)',
  };
  const NOT_VALIDATED = 'yes, for new and changed rows only (NOT validated)';
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
  const devices = (db) => db.query.value(
    `select string_agg(pr.full_name || ': ' || ps.user_agent, '; ' order by pr.full_name, ps.user_agent)
       from public.push_subscriptions ps join public.profiles pr on pr.id = ps.user_id`,
  );
  const THREE_DEVICES = 'Alex: Chrome on a phone; Alex: Firefox on a laptop; Coach Carla: Safari on a phone';

  it('the eleven send the push they sent before — now through one function, with ten seconds — and the rollback gives the old ones back', async () => {
    const db = await production();

    const before = await story(db, ...THE_EVENTS);
    expect(before.kept).toEqual(KEPT);
    expect(before.pushes.map((push) => [push.body.user_id === COACH ? 'coach' : 'athlete', push.body.payload.title, push.body.payload.body]))
      .toEqual(SAID);
    expect(before.bell).toHaveLength(BELL_ROWS);
    for (const push of before.pushes) {
      expect(push.method).toBe('POST');
      expect(push.url).toBe(`${FUNCTIONS}/send-push`);
      expect(push.headers).toEqual({ 'Content-Type': 'application/json', Authorization: `Bearer ${SECRET}` });
      expect(Object.keys(push.body).sort()).toEqual(['payload', 'user_id']);
      // No time limit of its own: the default of pg_net, which the stub has at 5 seconds.
      expect(push.limit).toBe(5000);
    }

    await db.runFile(migration.paths.migration);
    const after = await story(db, ...THE_EVENTS);
    expect(after.kept).toEqual(KEPT);
    // The same bell, to the letter.
    expect(after.bell).toEqual(before.bell);
    // The same requests, each with the limit and a day to deliver it.
    expect(after.pushes).toEqual(before.pushes.map((push) => ({
      ...push, limit: TEN_SECONDS, body: { ...push.body, ttl: ONE_DAY },
    })));

    await db.runFile(migration.paths.rollback);
    expect(await story(db, ...THE_EVENTS)).toEqual(before);
    // No row was written by either file.
    expect(await devices(db)).toBe(THREE_DEVICES);
    expect(await db.query.value(`select count(*) from public.notifications`)).toBe(0);
    await db.drop();
  });

  it('adds 1 function and 1 rule, re-creates 11 functions and signs the ledger — no table, no column, no policy, no trigger, no privilege of what was there', async () => {
    const db = await production();
    const before = await catalogSnapshot(db.query);
    await db.runFile(migration.paths.migration);
    const after = await catalogSnapshot(db.query);

    const lines = diffCatalogs(before, after, { left: 'before', right: 'after' });
    const only = (side) => lines.filter((line) => line.endsWith(`: only in ${side}`))
      .map((line) => line.slice(0, -`: only in ${side}`.length));
    const SEND = 'public.send_push_event(p_user uuid, p_payload jsonb, p_options jsonb)';
    expect(only('after').sort()).toEqual([`constraints public.push_subscriptions.${RULE}`, `functions ${SEND}`]);
    expect(only('before')).toEqual([]);
    // What changed in what was there: the TEXT of the eleven, and nothing else
    // about them — not their owner, not who may execute them.
    const changed = lines.filter((line) => !/: only in (before|after)$/.test(line))
      .map((line) => /^(\w+) (.*?): (\w+): /.exec(line).slice(1, 4));
    expect(changed.filter(([section]) => section !== 'functions')).toEqual([['data', 'rows of app_private.app_migrations', 'rows']]);
    expect(changed.filter(([section]) => section === 'functions').map(([, key, field]) => `${key.replace(/^public\.|\(.*$/g, '')}: ${field}`))
      .toEqual(Object.keys(THE_ELEVEN).map((name) => `${name}: definition`));
    // …and of that text, the header is what it was: arguments, what it
    // answers, SECURITY DEFINER, the search_path.
    const header = (snapshot, key) => snapshot.functions[key].definition.split(/\nAS /)[0];
    for (const key of Object.keys(after.functions).filter((k) => Object.keys(THE_ELEVEN).includes(k.replace(/^public\.|\(.*$/g, '')))) {
      expect(header(after, key), key).toBe(header(before, key));
      expect(header(after, key), key).toContain('\n SECURITY DEFINER\n');
    }

    // send_push_event: its owner and the service role; the rights of its caller.
    expect(after.functions[SEND].privileges).toEqual(['postgres: EXECUTE', 'service_role: EXECUTE']);
    expect(after.functions[SEND].owner).toBe('postgres');
    expect(header(after, SEND)).not.toContain('SECURITY DEFINER');
    expect(header(after, SEND)).toContain('\n RETURNS bigint\n');
    expect(header(after, SEND)).toContain(`\n SET search_path TO 'public', 'pg_temp'`);
    expect(header(after, SEND)).toContain(`p_options jsonb DEFAULT '{}'::jsonb`);
    // The rule: validated, since no device of this world breaks it.
    expect(after.constraints[`public.push_subscriptions.${RULE}`]).toMatchObject({ kind: 'check', validated: true });

    // The ledger, as the page says it reads.
    expect(await db.query.rows(`select name from ${LEDGER} order by name`)).toHaveLength(15);
    expect(await db.query.value(`select name from ${LEDGER} order by name desc limit 1`)).toBe(MIGRATION);
    expect(page).toContain(`Expected: fifteen rows, the last one \`${MIGRATION}\`.`);
    expect(page).toContain('| Kind | required · adds 1 function and 1 rule on a column, re-creates 11 functions; no table, no column, no policy, no trigger, no row |');
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
    const table = page.split('\n')
      .map((line) => /^\| (\d+) \| (.+?) \| (.+?) \| (.+?) \|$/.exec(line))
      .filter(Boolean)
      .map(([, n, check, before, after]) => ({ n: Number(n), check, before, after }));
    expect(table.map((line) => line.n)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    // Written between back-ticks: a value the page gives exactly. The other
    // one is a sentence about what production holds.
    const exact = table.filter((line) => /^`.+`$/.test(line.before) && /^`.+`$/.test(line.after))
      .map((line) => ({ ...line, before: line.before.slice(1, -1), after: line.after.slice(1, -1) }));
    expect(table.filter((line) => !exact.some((e) => e.n === line.n)).map((line) => line.check)).toEqual([LINE.devices]);
    const onPage = (column) => [
      ...exact.map((line) => [line.n, line.check, line[column]]),
      [8, LINE.devices, '3'],
    ].sort((x, y) => x[0] - y[0]).map(([, check, value]) => [check, value]);

    expect(await printed()).toEqual(onPage('before'));
    expect(Object.fromEntries(await printed())).toMatchObject({ [LINE.onTheirOwn]: ELEVEN_NAMES, [LINE.throughIt]: 'none' });
    await db.runFile(migration.paths.migration);
    expect(await printed()).toEqual(onPage('after'));
    expect(Object.fromEntries(await printed())).toMatchObject({ [LINE.onTheirOwn]: 'send_push_event', [LINE.throughIt]: ELEVEN_NAMES });
    // …and the header of the audit file names every line, and the eleven.
    const header = audit.split('\n').filter((line) => line.startsWith('--')).join('\n');
    for (const { check } of table) expect(header, check).toContain(check);
    expect(header.replace(/\n-- /g, ' ')).toContain(`The eleven: ${ELEVEN_NAMES}.`);
    await db.runFile(migration.paths.rollback);
    expect(await printed()).toEqual(onPage('before'));
    await db.drop();
  });

  it('the page\'s check answers NOT THERE before and "in place" after — and writes nothing either way', async () => {
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
              (select count(*) from public.students) as links, (select count(*) from public.messages) as messages,
              (select count(*) from public.push_subscriptions) as devices,
              (select count(*) from net.http_request_queue) as requests,
              current_user::text as role, coalesce(current_setting('request.jwt.claims', true), '') as claims`,
    );
    const UNTOUCHED = { accounts: 2, profiles: 2, links: 1, messages: 0, devices: 3, requests: 0, role: 'postgres', claims: '' };
    const answer = (said) => `check only, nothing was written: ${said}`;
    const IN_PLACE = answer('in place: send_push_event queues a notification for the owner of the database and is refused to a '
      + 'signed-in user, and a device is registered at a push service and nowhere else');
    const NOT_CONFIGURED = answer('in place, and NOT CONFIGURED: send_push_event is refused to a signed-in user and a device is '
      + 'registered at a push service only — and no notification is sent, because the vault lacks the address of the functions or the bearer');

    expect(await checked()).toBe(answer('NOT THERE: send_push_event is not in the database'));
    expect(await state()).toEqual(UNTOUCHED);

    await db.runFile(migration.paths.migration);
    expect(await checked()).toBe(IN_PLACE);
    expect(await state()).toEqual(UNTOUCHED);
    // What the page says the command prints.
    expect(page).toContain(`\`${IN_PLACE}\``);
    expect(page).toContain('`… NOT THERE: send_push_event is not in the database`');

    // A vault without the bearer, then without anything: said, not hidden.
    const [{ id, secret }] = await db.query.rows(`select id, secret from vault.secrets where name = 'app_service_role_key'`);
    await db.query(`delete from vault.secrets where id = $1`, [id]);
    expect(await checked()).toBe(NOT_CONFIGURED);
    expect(page).toContain('- `… in place, and NOT CONFIGURED: …` —');
    // Stored under its own name instead: configured again.
    await db.query(`select vault.create_secret($1, 'app_internal_bearer')`, [secret]);
    expect(await checked()).toBe(IN_PLACE);
    await db.query(`delete from vault.secrets where name = 'app_internal_bearer'`);
    await db.query(`select vault.create_secret($1, 'app_service_role_key')`, [secret]);

    // Each thing made wrong by hand, one at a time: the answer nobody wants.
    const replaceHelper = async (rewrite) => {
      const was = await db.query.value(`select pg_get_functiondef($1::regprocedure)`, [HELPER]);
      const wrong = rewrite(was);
      expect(wrong, 'the text to make wrong is no longer in the function').not.toBe(was);
      await db.query(wrong);
      const said = await checked();
      await db.query(was);
      expect(await checked(), 'put back').toBe(IN_PLACE);
      return said;
    };
    // One that a signed-in user may call, with the rights of its owner.
    await db.query(`grant execute on function ${HELPER} to authenticated`);
    // (With the rights of its caller the vault still refuses, and the answer stands.)
    expect(await checked()).toBe(IN_PLACE);
    await db.query(`alter function ${HELPER} security definer`);
    expect(await checked()).toBe(answer('NOT PROTECTED: a signed-in user sent a notification to another account'));
    await db.query(`alter function ${HELPER} security invoker`);
    await db.query(`revoke execute on function ${HELPER} from authenticated`);
    expect(await checked()).toBe(IN_PLACE);
    // One that does not find the secrets it is given.
    expect(await replaceHelper((was) => was.replace(`WHERE ds.name = 'app_functions_url'`, `WHERE ds.name = 'app_function_url'`)))
      .toBe(answer('BROKEN: send_push_event queued nothing although the vault holds the address and the bearer'));
    // A rule that is not there.
    await db.query(`alter table public.push_subscriptions drop constraint ${RULE}`);
    expect(await checked()).toBe(answer('NOT PROTECTED: a device was registered at an address that is not at a push service'));
    await db.query(`alter table public.push_subscriptions add constraint ${RULE} check (endpoint ~ '^https://web[.]push[.]apple[.]com/') not valid`);
    // …and one that refuses a real push service: the device of the check is Chrome's.
    expect(await checked()).toMatch(/violates check constraint/);
    expect(page).toContain('- `… NOT PROTECTED: …` or `… BROKEN: …` — something does not do what this page says: **roll back**, and report the full message.');
    // A pg_net that does not take the request the way the function writes it.
    await db.platform(`alter function net.http_post(text, jsonb, jsonb, jsonb, integer) rename to http_post_as_it_was`);
    expect(await checked()).toMatch(/function net\.http_post\(.*\) does not exist/);
    expect(page).toContain('`function net.http_post(…) does not exist`, or any other that names `net.http_post`');
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
      .toBe('check only, nothing was written: NOT TRIED: the account made for the check could not be made a coach');
    expect(page).toContain('- `… NOT TRIED: the account made for the check could not be made a coach` — migration 07 is not in the database');
    expect(await db.query.value(`select count(*) from auth.users`)).toBe(2);
    await db.drop();
  });

  // Line 9 of the audit, and the section of the page that answers it.
  it('a device at an address that is no push service: counted, listed by host, left as it is, and in the way of the validation until it is deleted', async () => {
    // Registered before the rule existed: a test of one day, and a browser
    // whose push service the list does not have.
    const db = await production({ also: `
      insert into public.push_subscriptions (id, user_id, endpoint, p256dh, auth, user_agent, created_at, last_seen_at) values
        ('${JUNK}', '${ATHLETE}', 'https://example.org/collect?secret-of-the-device', 'k', 's', 'curl', '2026-05-12', '2026-05-12');
      insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent, created_at, last_seen_at) values
        ('${COACH}', 'https://push.vendor.example/v1/secret-of-the-device', 'k', 's', 'Another browser', '2026-09-01', '2026-10-12'),
        ('${COACH}', 'not an address at all', 'k', 's', null, '2026-05-12', '2026-05-12');
    ` });
    for (const statement of [listElsewhere, deleteOne, validate]) {
      expect(statement, 'the page no longer gives one of its statements').toBeTruthy();
      // Pasted between double quotes in a shell.
      expect(statement).not.toMatch(/["$`!\\]/);
    }
    const IN_THE_WAY = '3: example.org (1), not a URL (1), push.vendor.example (1)';
    expect(await printedAudit(db)).toMatchObject({ [LINE.devices]: '6', [LINE.elsewhere]: IN_THE_WAY, [LINE.rule]: 'no' });
    const listed = async () => (await db.query.rows(listElsewhere))
      .map((row) => `${row.role} ${row.account}: ${row.host} (${row.user_agent}), last seen ${row.last_seen}`);
    const THREE = [
      'coach Coach Carla: not a URL (null), last seen 2026-05-12',
      'coach Coach Carla: push.vendor.example (Another browser), last seen 2026-10-12',
      'student Alex: example.org (curl), last seen 2026-05-12',
    ];
    expect(await listed()).toEqual(THREE);
    // The list never shows an endpoint: it is the secret of its device.
    expect(JSON.stringify(await db.query.rows(listElsewhere))).not.toContain('secret-of-the-device');
    expect(JSON.stringify(await printedAudit(db))).not.toContain('secret-of-the-device');

    // They do not stop the migration, which leaves every row as it is…
    await db.runFile(migration.paths.migration);
    expect(await db.query.value(`select count(*) from public.push_subscriptions`)).toBe(6);
    expect(await listed()).toEqual(THREE);
    expect(await printedAudit(db)).toMatchObject({ [LINE.devices]: '6', [LINE.elsewhere]: IN_THE_WAY, [LINE.rule]: NOT_VALIDATED });
    expect(page).toContain(`Line 7 reads \`${NOT_VALIDATED}\` when line 9 is not \`0\`.`);
    // …and judges every row that is written from then on.
    const junk = `'https://example.org/another', 'k', 's'`;
    expect(await story(db, THE_ATHLETE, `insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values ('${ATHLETE}', ${junk})`))
      .toBe(`new row for relation "push_subscriptions" violates check constraint "${RULE}"`);
    expect(await story(db, THE_ATHLETE, `select public.claim_push_subscription(${junk})`))
      .toBe(`new row for relation "push_subscriptions" violates check constraint "${RULE}"`);
    expect(await story(db, THE_ATHLETE, `select public.claim_push_subscription('https://fcm.googleapis.com/fcm/send/a-new-phone', 'k', 's')`))
      .toMatchObject({ outcome: 'created' });
    // A row in the way can no longer be refreshed — the app's upsert of a
    // device it already holds, send-push stamping last_seen_at — and can go.
    expect(await story(db, THE_ATHLETE, `update public.push_subscriptions set last_seen_at = now() where id = '${JUNK}' returning id`))
      .toBe(`new row for relation "push_subscriptions" violates check constraint "${RULE}"`);
    expect(await story(db, THE_SERVICE_ROLE, `update public.push_subscriptions set last_seen_at = now() where id = '${JUNK}' returning id`))
      .toBe(`new row for relation "push_subscriptions" violates check constraint "${RULE}"`);
    expect(await story(db, THE_ATHLETE, `delete from public.push_subscriptions where id = '${JUNK}' returning id`)).toBe(JUNK);
    expect(page).toContain('but the device can no longer be refreshed');

    // The validation waits for them, and changes nothing while it does.
    const tooEarly = await attempt(() => db.runSql(validate, 'validate'));
    expect(tooEarly.error?.code).toBe('23514');
    expect((tooEarly.error.cause ?? tooEarly.error).message).toMatch(/check constraint "push_subscriptions_endpoint_known_push_service" of relation "push_subscriptions" is violated by some row/);
    expect(page).toContain('(code `23514`, `check constraint … is violated by some row`)');
    expect(await printedAudit(db)).toMatchObject({ [LINE.rule]: NOT_VALIDATED });

    // One row at a time, with the id of the list.
    const ids = (await db.query.rows(listElsewhere)).map((row) => row.id);
    expect(ids).toHaveLength(3);
    expect(deleteOne).toContain(`'<id of the row>'`);
    for (const id of ids) {
      const [{ rowCount }] = [await db.runSql(deleteOne.replace('<id of the row>', id), 'delete one')].flat();
      expect(rowCount).toBe(1);
    }
    expect(await listed()).toEqual([]);
    expect(await devices(db)).toBe(THREE_DEVICES);
    await db.runSql(validate, 'validate');
    expect(await printedAudit(db)).toMatchObject({ [LINE.devices]: '3', [LINE.elsewhere]: '0', [LINE.rule]: 'yes' });

    // The database is then the one of a production that had nothing in the way.
    const clean = await production();
    await clean.runFile(migration.paths.migration);
    expect(diffCatalogs(await catalogSnapshot(clean.query), await catalogSnapshot(db.query), { left: 'clean', right: 'cleaned' }))
      .toEqual([]);
    await clean.drop();
    await db.drop();
  });

  // "Renaming the secret", and the one case in which the rollback waits for it.
  it('the secret can be renamed once the migration is applied: the same bearer is sent, and the rollback asks for the old name back', async () => {
    const db = await production();
    for (const statement of [rename, renameBack]) {
      expect(statement, 'the page no longer gives one of its statements').toBeTruthy();
      expect(statement).not.toMatch(/["$`!\\]/);
    }
    const bearerSent = async () => {
      const told = await story(db, THE_ATHLETE,
        `insert into public.messages (sender_id, recipient_id, body) values ('${ATHLETE}', '${COACH}', 'Hello')`,
        THE_OWNER, `select coalesce(jsonb_agg(headers->>'Authorization'), '[]') from net.http_request_queue`);
      return told;
    };
    const names = () => db.query.value(`select string_agg(name, ', ' order by name) from vault.secrets`);
    const renamed = async (statement) => [await db.runSql(statement, 'rename')].flat()[0].rowCount;

    // Before the migration the functions read the old name and no other:
    // renamed too early, no push leaves — which is why the page says "after".
    expect(await bearerSent()).toEqual([`Bearer ${SECRET}`]);
    expect(await renamed(rename)).toBe(1);
    expect(await bearerSent()).toEqual([]);
    expect(await printedAudit(db)).toMatchObject({ [LINE.bearer]: 'app_internal_bearer' });
    expect(page).toContain('the database sends no notification today, because the functions that are there read the other name; the migration puts that right');
    expect(await renamed(renameBack)).toBe(1);
    expect(await bearerSent()).toEqual([`Bearer ${SECRET}`]);

    await db.runFile(migration.paths.migration);
    expect(await printedAudit(db)).toMatchObject({ [LINE.address]: 'set', [LINE.bearer]: 'app_service_role_key' });
    expect(await bearerSent()).toEqual([`Bearer ${SECRET}`]);

    // Renamed: one row, the same value, the same request.
    expect(await renamed(rename)).toBe(1);
    expect(await names()).toBe('app_functions_url, app_internal_bearer');
    expect(await db.query.value(`select decrypted_secret from vault.decrypted_secrets where name = 'app_internal_bearer'`)).toBe(SECRET);
    expect(await bearerSent()).toEqual([`Bearer ${SECRET}`]);
    expect(await printedAudit(db)).toMatchObject({ [LINE.bearer]: 'app_internal_bearer' });
    // A second time: nothing to rename, nothing changed.
    expect(await renamed(rename)).toBe(0);
    expect(await names()).toBe('app_functions_url, app_internal_bearer');

    // The rollback would put back functions that read the old name only.
    const before = await catalogSnapshot(db.query);
    const refused = await attempt(() => db.runFile(migration.paths.rollback));
    expect(refused.error?.message).toContain('the vault holds the bearer of send-push as app_internal_bearer only');
    expect(page).toContain('`the vault holds the bearer of send-push as app_internal_bearer only`');
    expect(diffCatalogs(before, await catalogSnapshot(db.query), { left: 'before', right: 'after' })).toEqual([]);
    expect(await bearerSent()).toEqual([`Bearer ${SECRET}`]);

    // Renamed back with the statement of the page, it goes — and the old functions find their bearer.
    expect(await renamed(renameBack)).toBe(1);
    expect(await names()).toBe('app_functions_url, app_service_role_key');
    await db.runFile(migration.paths.rollback);
    expect(await bearerSent()).toEqual([`Bearer ${SECRET}`]);

    // Stored a second time instead of renamed: the audit says which one is sent, and whether they agree.
    await db.runFile(migration.paths.migration);
    await db.query(`select vault.create_secret($1, 'app_internal_bearer')`, [SECRET]);
    expect(await printedAudit(db)).toMatchObject({ [LINE.bearer]: 'app_internal_bearer, and app_service_role_key with the same value' });
    await db.query(`select vault.update_secret(id, 'a-new-bearer') from vault.secrets where name = 'app_service_role_key'`);
    expect(await printedAudit(db)).toMatchObject({ [LINE.bearer]: 'app_internal_bearer, and app_service_role_key with ANOTHER value' });
    expect(await bearerSent()).toEqual([`Bearer ${SECRET}`]);
    expect(page).toContain('`app_internal_bearer, and app_service_role_key with ANOTHER value`');
    // With both, each rename finds the other name taken and touches no row.
    expect(await renamed(rename)).toBe(0);
    expect(await renamed(renameBack)).toBe(0);
    // No audit line ever prints a secret.
    expect(JSON.stringify(await printedAudit(db))).not.toMatch(new RegExp(`${SECRET}|a-new-bearer|${FUNCTIONS}`));
    await db.drop();
  });

  it('a vault without the secrets does not stop it: the audit says that no push is sent, before and after', async () => {
    const db = await production();
    await db.query(`delete from vault.secrets`);
    const MISSING = { [LINE.address]: 'MISSING: no push is sent', [LINE.bearer]: 'MISSING: no push is sent' };
    expect(await printedAudit(db)).toMatchObject(MISSING);
    expect((await story(db, ...THE_EVENTS)).pushes).toEqual([]);
    await db.runFile(migration.paths.migration);
    expect(await printedAudit(db)).toMatchObject({ ...MISSING, [LINE.oneWay]: 'yes' });
    const told = await story(db, ...THE_EVENTS);
    expect([told.pushes, told.bell.length, told.kept]).toEqual([[], BELL_ROWS, KEPT]);
    expect(page).toContain('- **10** reads `MISSING: no push is sent`, or **11** does —');
    await db.drop();
  });

  it('without migration 14 it says so (SLM02), and its rollback says there is nothing to undo (SLM03)', async () => {
    const db = await scratchDatabase();
    await db.runFile(manifest.baseline);
    const refusals = async () => {
      const before = await catalogSnapshot(db.query);
      const refused = await attempt(() => db.runFile(migration.paths.migration));
      const undone = await attempt(() => db.runFile(migration.paths.rollback));
      expect(diffCatalogs(before, await catalogSnapshot(db.query), { left: 'before', right: 'after' })).toEqual([]);
      return [refused.error?.code, refused.error?.message, undone.error?.code];
    };
    // Without a ledger at all, then with the ledger and the migrations before 14 only.
    const needs = 'needs 2026_10_13_14_table_grants_lockdown, which is not applied';
    let [code, message, undone] = await refusals();
    expect([code, undone]).toEqual([REFUSAL.predecessorMissing, REFUSAL.notApplied]);
    expect(message).toContain(needs);
    for (const earlier of manifest.migrations.slice(0, 13)) await db.runFile(earlier.paths.migration);
    expect(await db.query.value(`select name from ${LEDGER} order by name desc limit 1`)).toBe('2026_10_13_13_ensure_claim_rpcs');
    [code, message, undone] = await refusals();
    expect([code, undone]).toEqual([REFUSAL.predecessorMissing, REFUSAL.notApplied]);
    expect(message).toContain(needs);
    expect(page).toContain(`| \`${needs}\` (code \`SLM02\`) |`);
    await db.drop();
  });

  it('refuses to run as another role than postgres', async () => {
    const db = await production();
    const text = read(migration.paths.migration);
    const asServiceRole = text.replace(`SET LOCAL lock_timeout = '5s';`, `SET LOCAL lock_timeout = '5s';\nSET LOCAL ROLE service_role;`);
    expect(asServiceRole).not.toBe(text);
    expect(await refusalOf(db, () => db.runSql(asServiceRole, 'migration')))
      .toContain(`migration ${MIGRATION} must be run as postgres, not as service_role`);
    expect(await db.query.value(`select current_user::text`)).toBe('postgres');
    await db.drop();
  });

  it('refuses to run next to a function it does not know, or without one of the eleven, and changes nothing', async () => {
    const db = await production();

    // send_push_event is created: one that is there was made by hand.
    await db.query(`create function public.send_push_event(p_user uuid) returns void language sql as 'select'`);
    expect(await refusalOf(db)).toContain(`migration ${MIGRATION} would not create: send_push_event(uuid) is already there`);
    expect(await printedAudit(db)).toMatchObject({ [LINE.strangers]: 'send_push_event(uuid)', [LINE.who]: 'no such function' });
    await db.query(`drop function public.send_push_event(uuid)`);
    await db.query(`create function public.send_push_event(p_user uuid, p_payload jsonb, p_options jsonb) returns bigint language sql as 'select 1::bigint'`);
    expect(await refusalOf(db)).toContain(`migration ${MIGRATION} would not create: send_push_event(uuid,jsonb,jsonb) is already there`);
    expect(await printedAudit(db)).toMatchObject({ [LINE.strangers]: 'none', [LINE.who]: 'postgres, service_role', [LINE.oneWay]: 'no' });
    expect(page).toContain('| `would not create: … is already there` |');
    await db.query(`drop function public.send_push_event(uuid, jsonb, jsonb)`);

    // The eleven are replaced: a copy with other arguments would go on sending its push the old way.
    await db.query(`create function public.adopt_skip(p_slot_id uuid) returns jsonb language sql as 'select null::jsonb'`);
    expect(await refusalOf(db)).toContain(
      `migration ${MIGRATION} would not replace the eleven functions it means: adopt_skip(uuid) stands next to the one this file replaces`,
    );
    expect(await printedAudit(db)).toMatchObject({ [LINE.strangers]: 'adopt_skip(uuid)' });
    await db.query(`drop function public.adopt_skip(uuid)`);
    // …and one that is not there would be created with nothing that calls it.
    await db.query(`alter function public.notify_recipient_on_chat_message() rename to notify_on_chat`);
    expect(await refusalOf(db)).toContain(
      `migration ${MIGRATION} would not replace the eleven functions it means: public.notify_recipient_on_chat_message() is not there`,
    );
    expect((await printedAudit(db))[LINE.onTheirOwn])
      .toBe(ELEVEN_NAMES.replace('notify_recipient_on_chat_message', 'notify_on_chat').split(', ').sort().join(', '));
    expect(page).toContain('| `would not replace the eleven functions it means: …` |');
    expect(page).toContain('- **3** lists another function than the eleven, or lacks one of them — stop and report the line.');
    await db.query(`alter function public.notify_on_chat() rename to notify_recipient_on_chat_message`);

    // A rule of that name, made by hand: it may say something else.
    await db.query(`alter table public.push_subscriptions add constraint ${RULE} check (endpoint like 'https://%')`);
    expect(await refusalOf(db)).toContain(`migration ${MIGRATION} would not add: the constraint ${RULE} is already there`);
    expect(await printedAudit(db)).toMatchObject({ [LINE.rule]: 'yes' });
    expect(page).toContain('| `would not add: the constraint … is already there` |');
    await db.query(`alter table public.push_subscriptions drop constraint ${RULE}`);

    // A twelfth function that sends a push, which the repository does not
    // know: the file reads its own result back, and undoes itself.
    await db.query(`create function public.notify_by_hand() returns void language plpgsql set search_path = public, pg_temp as
      $$ begin perform net.http_post(url := 'https://example.org/'); end $$`);
    expect(await refusalOf(db)).toContain(
      `migration ${MIGRATION} left a function that reads the vault or calls pg_net itself: notify_by_hand()`,
    );
    expect((await printedAudit(db))[LINE.onTheirOwn]).toBe([...Object.keys(THE_ELEVEN), 'notify_by_hand'].sort().join(', '));
    expect(page).toContain('`left a function that reads the vault or calls pg_net itself: …`');
    await db.query(`drop function public.notify_by_hand()`);

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
    expect((await story(db, ...THE_EVENTS)).pushes).toHaveLength(SAID.length);
    await other.drop();
    await db.drop();
  });

  // The body of a function is not checked against the database when it is
  // created, and the call stands in a net that turns every error into a
  // warning: a pg_net without the time limit would be eleven pushes that are
  // never sent, and no error anywhere.
  it('refuses to run where pg_net does not take a time limit, or the vault is not where the function reads it', async () => {
    const db = await production();

    // An older pg_net: the same function, four arguments.
    await db.platform(`alter function net.http_post(text, jsonb, jsonb, jsonb, integer) rename to http_post_with_a_limit`);
    await db.platform(`create function net.http_post(url text, body jsonb default '{}', params jsonb default '{}', headers jsonb default '{}')
      returns bigint language sql as 'select net.http_post_with_a_limit(url, body, params, headers, 2000)'`);
    expect(await refusalOf(db)).toContain(
      `migration ${MIGRATION} does not find what its functions are written with: net.http_post(url, body, params, headers, timeout_milliseconds) is not there`,
    );
    expect(await printedAudit(db)).toMatchObject({ [LINE.pgNet]: 'no' });
    expect(page).toContain('- **12** reads `no` — stop and report.');
    expect(page).toContain('| `does not find what its functions are written with: …` |');
    await db.platform(`drop function net.http_post(text, jsonb, jsonb, jsonb)`);
    // The five arguments under other names: a call by name would not find them.
    await db.platform(`create function net.http_post(target text, body jsonb, params jsonb, headers jsonb, timeout_ms integer)
      returns bigint language sql as 'select net.http_post_with_a_limit(target, body, params, headers, timeout_ms)'`);
    expect(await refusalOf(db)).toContain('net.http_post(url, body, params, headers, timeout_milliseconds) is not there');
    await db.platform(`drop function net.http_post(text, jsonb, jsonb, jsonb, integer)`);
    await db.platform(`alter function net.http_post_with_a_limit(text, jsonb, jsonb, jsonb, integer) rename to http_post`);
    expect(await printedAudit(db)).toMatchObject({ [LINE.pgNet]: 'yes' });

    await db.platform(`alter view vault.decrypted_secrets rename column decrypted_secret to plain`);
    expect(await refusalOf(db)).toContain(
      `migration ${MIGRATION} does not find what its functions are written with: vault.decrypted_secrets (name, decrypted_secret) is not there`,
    );
    await db.platform(`alter view vault.decrypted_secrets rename column plain to decrypted_secret`);

    await db.runFile(migration.paths.migration);
    expect((await story(db, ...THE_EVENTS)).pushes).toHaveLength(SAID.length);
    await db.drop();
  });

  // The privileges stand next to each function: what a new function is born
  // with is not this file's to rely on.
  it('applied where a new function is born open to everybody, send_push_event is still closed to everybody the API serves', async () => {
    const db = await production();
    // Supabase's own defaults, as they were before migration 03.
    await db.query(`alter default privileges for role postgres grant execute on functions to public`);
    await db.query(`alter default privileges for role postgres in schema public grant execute on functions to anon, authenticated`);
    await db.runFile(migration.paths.migration);
    expect(await printedAudit(db)).toMatchObject({ [LINE.who]: 'postgres, service_role' });
    const send = `select public.send_push_event('${ATHLETE}', '{"title": "Hello"}')`;
    for (const who of [NOBODY, THE_ATHLETE, THE_COACH]) {
      expect(await story(db, who, send)).toBe('permission denied for function send_push_event');
    }
    expect(typeof await story(db, THE_SERVICE_ROLE, send)).toBe('number');
    expect(page).toContain('| anybody, signed in or not, `send_push_event` | `permission denied for function send_push_event` |');
    // The five RPCs are the coach's, as before; the six trigger functions nobody's.
    expect(await story(db, THE_COACH, `select public.adopt_skip('${SLOT12}', true)`)).toEqual({ applied: 1, dry_run: true });
    expect(await story(db, THE_ATHLETE, `select public.adopt_skip('${SLOT12}', true)`)).toBe('not authorized');
    expect(await story(db, NOBODY, `select public.adopt_skip('${SLOT12}', true)`)).toBe('permission denied for function adopt_skip');
    expect(await story(db, THE_ATHLETE, `select public.notify_recipient_on_chat_message()`))
      .toBe('permission denied for function notify_recipient_on_chat_message');
    await db.runFile(migration.paths.rollback);

    // … and a file that forgot the line, or that gave the function the rights
    // of its owner, reads its own result back and undoes itself.
    const text = read(migration.paths.migration);
    const wrong = async (changed) => {
      expect(changed).not.toBe(text);
      return refusalOf(db, () => db.runSql(changed, 'migration'));
    };
    expect(await wrong(text.replace(`REVOKE ALL ON FUNCTION ${HELPER} FROM PUBLIC, anon, authenticated;\n`, ''))).toContain(
      `migration ${MIGRATION} did not get the functions it meant: ${HELPER}: anon may execute it, PUBLIC may execute it, a signed-in user may execute it`,
    );
    expect(await wrong(text.replace('RETURNS bigint\nLANGUAGE plpgsql\nSECURITY INVOKER', 'RETURNS bigint\nLANGUAGE plpgsql\nSECURITY DEFINER')))
      .toContain(`migration ${MIGRATION} did not get the functions it meant: ${HELPER}: it runs as its owner`);
    // One of the eleven left with its old block, or without its call.
    expect(await wrong(text.replace(
      `  BEGIN\n    PERFORM public.send_push_event(\n      v_coach_id,\n      jsonb_build_object(\n        'title', 'Session completed',`,
      `  BEGIN\n    PERFORM net.http_post(url := 'https://example.org/');\n    PERFORM public.send_push_event(\n      v_coach_id,\n      jsonb_build_object(\n        'title', 'Session completed',`,
    ))).toContain('public.notify_coach_on_session_confirm(): it still reads the vault or calls pg_net itself');
    expect(await wrong(text.replace(
      `GRANT EXECUTE ON FUNCTION public.adopt_swap(uuid, uuid, boolean) TO authenticated;\n`, '',
    ))).toContain('public.adopt_swap(uuid, uuid, boolean): a signed-in user may NOT execute it');
    expect(page).toContain('| `did not get the functions it meant: …`,');
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
    expect((await story(db, ...THE_EVENTS)).pushes.map((push) => push.limit)).toEqual(SAID.map(() => TEN_SECONDS));
    await db.drop();
  });

  // What the rollback page says of what happened while the migration was in place.
  it('rolled back: every device stays registered, an address anywhere is accepted again, and a function made afterwards is not its to drop', async () => {
    const db = await production();
    await db.runFile(migration.paths.migration);
    await db.runSql(`BEGIN;\n${actor(THE_ATHLETE)};\nselect public.claim_push_subscription('https://web.push.apple.com/alex-s-tablet', 'k', 's', 'Safari on a tablet');\nCOMMIT;`, 'request');
    const FOUR = `Alex: Chrome on a phone; Alex: Firefox on a laptop; Alex: Safari on a tablet; Coach Carla: Safari on a phone`;
    expect(await devices(db)).toBe(FOUR);

    await db.query(`create function public.send_push_event(p_user uuid) returns void language sql set search_path = public, pg_temp as 'select'`);
    await db.runFile(migration.paths.rollback);
    expect(await devices(db)).toBe(FOUR);
    expect(page).toContain('No row is touched: every device stays registered, whatever its address.');
    expect(await printedAudit(db)).toMatchObject({ [LINE.oneWay]: 'no', [LINE.rule]: 'no', [LINE.onTheirOwn]: ELEVEN_NAMES, [LINE.who]: 'no such function' });
    expect(await db.query.value(`select to_regprocedure('public.send_push_event(uuid)') is not null`)).toBe(true);
    await db.query(`drop function public.send_push_event(uuid)`);
    // The hole of B3 is open again, as the file says.
    expect(await story(db, THE_ATHLETE,
      `insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values ('${ATHLETE}', 'https://example.org/collect', 'k', 's') returning endpoint`))
      .toBe('https://example.org/collect');
    expect(read(migration.paths.rollback)).toContain('!! IT REOPENS FINDING B3 AND THE DATABASE\'S HALF OF P35.');

    // …and the migration applies again on what the rollback left.
    await db.runFile(migration.paths.migration);
    expect((await story(db, ...THE_EVENTS)).pushes).toHaveLength(SAID.length);
    await db.drop();
  });
});
