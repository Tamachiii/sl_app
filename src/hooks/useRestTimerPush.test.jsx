import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider, IsRestoringProvider } from '@tanstack/react-query';

// The device: whether it can receive a push, and the subscription it holds.
const device = { supported: true, permission: 'granted', endpoint: 'https://push.example/this-phone' };
vi.mock('../lib/pushNotifications', () => ({
  isPushSupported: () => device.supported,
  pushPermission: () => device.permission,
  getActivePushSubscription: async () => (device.endpoint ? { endpoint: device.endpoint } : null),
}));

let mockUser = { id: 'athlete-1' };
vi.mock('./useAuth', () => ({ useAuth: () => ({ user: mockUser }) }));

// The database and the Edge Function, as supabase-js reaches them: rpc and
// invoke answer { data, error }; the table requests are written down with
// what each one carried.
const rpc = vi.fn();
const invoke = vi.fn();
const tableRequests = [];
let legacyInsertAnswer = { data: { id: 'old-row-1' }, error: null };
function table(name) {
  const request = { table: name };
  const chain = {
    insert(row) {
      request.insert = row;
      return chain;
    },
    update(fields) {
      request.update = fields;
      return chain;
    },
    select(columns) {
      request.select = columns;
      return chain;
    },
    eq(column, value) {
      (request.eq ||= []).push([column, value]);
      return chain;
    },
    maybeSingle() {
      tableRequests.push(request);
      return Promise.resolve(legacyInsertAnswer);
    },
    then(resolve, reject) {
      tableRequests.push(request);
      return Promise.resolve({ data: null, error: null }).then(resolve, reject);
    },
  };
  return chain;
}
vi.mock('../lib/supabase', () => ({
  supabase: {
    rpc: (...args) => rpc(...args),
    from: (name) => table(name),
    functions: { invoke: (...args) => invoke(...args) },
  },
}));

import { I18nProvider, useI18n } from './useI18n';
import { startRestTimer, clearRestTimer, resetRestTimer } from './useRestTimer';
import { useRestTimerPush, MAX_REST_PUSH_SECONDS, PREVIOUS_REQUEST_WAIT_MS } from './useRestTimerPush';

const NOW = Date.parse('2026-10-16T18:00:00.000Z');
const BASE = import.meta.env.BASE_URL || '/';

// The scheduling reads the browser, then asks the database: let it finish.
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

// What schedule_rest_push answers, one call after the other.
let scheduleAnswers = [];
let cancelAnswer = { data: { canceled: true }, error: null };
const pgError = (code, message) => ({ data: null, error: { code, message, details: null, hint: null } });

const scheduleCalls = () => rpc.mock.calls.filter(([name]) => name === 'schedule_rest_push');
const cancelCalls = () => rpc.mock.calls.filter(([name]) => name === 'cancel_rest_push');
const lastPayload = () => scheduleCalls().at(-1)[1].p_payload;

let queryClient;
let restoring = false;

function Providers({ children }) {
  return (
    <QueryClientProvider client={queryClient}>
      <IsRestoringProvider value={restoring}>
        <I18nProvider>{children}</I18nProvider>
      </IsRestoringProvider>
    </QueryClientProvider>
  );
}

// The student shell: the hook, and the language switch of the profile page.
// `strict` mounts the root under StrictMode the way testing-library does it
// (`reactStrictMode`): a <StrictMode> inside the wrapper does not make React
// run the effects twice.
function mountShell({ strict = false } = {}) {
  return renderHook(
    () => {
      useRestTimerPush();
      return useI18n();
    },
    { wrapper: Providers, reactStrictMode: strict },
  );
}

// The sets of one session as the device holds them (hooks/useSetLogs).
function sessionOnDevice(sessionId, logIds) {
  queryClient.setQueryData(
    ['set-logs', sessionId, ['slot-a']],
    logIds.map((id, index) => ({ id, exercise_slot_id: 'slot-a', set_number: index + 1 })),
  );
}

function deviceIs(online) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  resetRestTimer();
  localStorage.removeItem('sl_app_lang');
  Object.assign(device, { supported: true, permission: 'granted', endpoint: 'https://push.example/this-phone' });
  mockUser = { id: 'athlete-1' };
  restoring = false;
  deviceIs(true);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  tableRequests.length = 0;
  legacyInsertAnswer = { data: { id: 'old-row-1' }, error: null };
  scheduleAnswers = [];
  cancelAnswer = { data: { canceled: true }, error: null };
  let next = 0;
  rpc.mockReset();
  rpc.mockImplementation(async (name) => {
    if (name === 'cancel_rest_push') return cancelAnswer;
    next += 1;
    return scheduleAnswers.shift() ?? { data: { id: `push-${next}`, fire_at: 'later', mode: 'cron' }, error: null };
  });
  invoke.mockReset();
  invoke.mockResolvedValue({ data: { accepted: true }, error: null });
});

afterEach(() => {
  resetRestTimer();
  vi.useRealTimers();
});

describe('useRestTimerPush: one request to the database, for this device', () => {
  it('mode cron: schedule_rest_push with whole seconds, the payload and this device, and nothing else', async () => {
    startRestTimer('log-1', 90);
    // The hook runs 300 ms after the tap: 89.7 s are left, asked as 90.
    vi.setSystemTime(NOW + 300);
    mountShell();
    await settle();

    expect(scheduleCalls()).toHaveLength(1);
    const [, args] = scheduleCalls()[0];
    expect(args).toEqual({
      p_seconds: 90,
      p_payload: expect.objectContaining({ tag: 'rest-timer' }),
      p_endpoint: 'https://push.example/this-phone',
    });
    expect(Number.isInteger(args.p_seconds)).toBe(true);
    expect(invoke).not.toHaveBeenCalled();
    expect(tableRequests).toEqual([]);
  });

  it('mode edge: the Edge Function is asked to send the row it was answered', async () => {
    scheduleAnswers.push({ data: { id: 'push-edge', fire_at: 'later', mode: 'edge' }, error: null });
    startRestTimer('log-1', 120);
    mountShell();
    await settle();

    expect(scheduleCalls()).toHaveLength(1);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('dispatch-rest-push', { body: { scheduleId: 'push-edge' } });
    expect(tableRequests).toEqual([]);
  });

  it('an answer without a mode is taken as edge: one call too many, never a push too few', async () => {
    scheduleAnswers.push({ data: { id: 'push-nomode' }, error: null });
    startRestTimer('log-1', 120);
    mountShell();
    await settle();

    expect(invoke).toHaveBeenCalledWith('dispatch-rest-push', { body: { scheduleId: 'push-nomode' } });
  });

  it('a rest of 600 s gets its push: the 350 s cap is gone', async () => {
    startRestTimer('log-1', 600);
    mountShell();
    await settle();

    expect(scheduleCalls()).toHaveLength(1);
    expect(scheduleCalls()[0][1].p_seconds).toBe(600);
  });

  it(`a rest of ${MAX_REST_PUSH_SECONDS} s is scheduled, one of ${MAX_REST_PUSH_SECONDS + 1} s is not`, async () => {
    startRestTimer('log-1', MAX_REST_PUSH_SECONDS);
    const app = mountShell();
    await settle();
    expect(scheduleCalls()).toHaveLength(1);
    expect(scheduleCalls()[0][1].p_seconds).toBe(MAX_REST_PUSH_SECONDS);
    app.unmount();
    await settle();

    rpc.mockClear();
    startRestTimer('log-2', MAX_REST_PUSH_SECONDS + 1);
    mountShell();
    await settle();
    expect(rpc).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(tableRequests).toEqual([]);
  });
});

describe('useRestTimerPush: a database without migration 16', () => {
  it('PGRST202: the row is inserted the old way, with no endpoint, and the Edge Function invoked', async () => {
    scheduleAnswers.push(pgError('PGRST202', 'Could not find the function public.schedule_rest_push'));
    startRestTimer('log-1', 90);
    mountShell();
    await settle();

    expect(tableRequests).toHaveLength(1);
    const [insert] = tableRequests;
    expect(insert.table).toBe('scheduled_pushes');
    expect(insert.insert).toEqual({
      user_id: 'athlete-1',
      fire_at: new Date(NOW + 90_000).toISOString(),
      payload: expect.objectContaining({ tag: 'rest-timer' }),
    });
    expect(insert.insert).not.toHaveProperty('endpoint');
    expect(invoke).toHaveBeenCalledWith('dispatch-rest-push', { body: { scheduleId: 'old-row-1' } });
  });

  it('PGRST202 on cancel_rest_push: the row is stamped canceled_at while it is pending', async () => {
    scheduleAnswers.push(pgError('PGRST202', 'Could not find the function public.schedule_rest_push'));
    cancelAnswer = pgError('PGRST202', 'Could not find the function public.cancel_rest_push');
    startRestTimer('log-1', 90);
    mountShell();
    await settle();
    tableRequests.length = 0;

    act(() => clearRestTimer('log-1'));
    await settle();

    expect(cancelCalls()).toEqual([['cancel_rest_push', { p_id: 'old-row-1' }]]);
    expect(tableRequests).toEqual([
      {
        table: 'scheduled_pushes',
        update: { canceled_at: new Date(NOW).toISOString() },
        eq: [
          ['id', 'old-row-1'],
          ['status', 'pending'],
        ],
      },
    ]);
  });

  it('a cancel the database knows writes nothing to the table itself', async () => {
    startRestTimer('log-1', 90);
    mountShell();
    await settle();

    act(() => clearRestTimer('log-1'));
    await settle();

    expect(cancelCalls()).toEqual([['cancel_rest_push', { p_id: 'push-1' }]]);
    expect(tableRequests).toEqual([]);
  });
});

describe('useRestTimerPush: a refusal schedules nothing, and never rings every device', () => {
  it.each([
    ['device_not_registered', pgError('P0001', 'device_not_registered')],
    ['rest_seconds_out_of_range', pgError('P0001', 'rest_seconds_out_of_range')],
    ['payload_invalid', pgError('P0001', 'payload_invalid')],
    ['not authorized', pgError('42501', 'not authorized')],
    ['no answer', { data: null, error: { message: 'TypeError: Failed to fetch', code: '' } }],
  ])('%s: no insert, no invoke, nothing thrown, nothing to cancel', async (_, answer) => {
    scheduleAnswers.push(answer);
    startRestTimer('log-1', 90);
    mountShell();
    await settle();

    expect(scheduleCalls()).toHaveLength(1);
    expect(tableRequests).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();

    act(() => clearRestTimer('log-1'));
    await settle();
    expect(cancelCalls()).toEqual([]);
  });

  it('a request that throws is swallowed', async () => {
    rpc.mockImplementationOnce(async () => {
      throw new TypeError('Failed to fetch');
    });
    startRestTimer('log-1', 90);
    mountShell();
    await settle();

    expect(tableRequests).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('useRestTimerPush: what the notification says, and where a tap leads', () => {
  it.each([
    ['en', 'Rest done', 'Time for your next set.'],
    ['fr', 'Repos terminé', 'C’est l’heure de ta prochaine série.'],
    ['de', 'Pause vorbei', 'Zeit für deinen nächsten Satz.'],
  ])('in %s, tagged rest-timer, back to the session of the set', async (lang, title, body) => {
    localStorage.setItem('sl_app_lang', lang);
    sessionOnDevice('session-7', ['log-0', 'log-1']);
    startRestTimer('log-1', 90);
    mountShell();
    await settle();

    expect(lastPayload()).toEqual({
      title,
      body,
      tag: 'rest-timer',
      data: { url: `${BASE}#/student/session/session-7` },
    });
  });

  it('a set whose session the device does not hold: no address — never the training list', async () => {
    sessionOnDevice('session-7', ['log-0']);
    startRestTimer('log-unknown', 90);
    mountShell();
    await settle();

    expect(lastPayload()).not.toHaveProperty('data');
  });

  it('a rest taken back after a relaunch waits for the stored cache, then leads to its session', async () => {
    restoring = true;
    startRestTimer('log-1', 90);
    const app = mountShell();
    await settle();
    expect(rpc).not.toHaveBeenCalled();

    // The cache is back from the device.
    sessionOnDevice('session-7', ['log-1']);
    restoring = false;
    app.rerender();
    await settle();

    expect(scheduleCalls()).toHaveLength(1);
    expect(lastPayload().data).toEqual({ url: `${BASE}#/student/session/session-7` });
  });

  it('a change of language in the middle of a rest neither cancels nor reschedules it', async () => {
    startRestTimer('log-1', 90);
    const app = mountShell();
    await settle();
    expect(scheduleCalls()).toHaveLength(1);

    act(() => app.result.current.setLang('fr'));
    await settle();

    expect(scheduleCalls()).toHaveLength(1);
    expect(cancelCalls()).toEqual([]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('the language is the one of the moment the rest is scheduled', async () => {
    startRestTimer('log-1', 90);
    const app = mountShell();
    await settle();
    act(() => app.result.current.setLang('de'));
    await settle();

    startRestTimer('log-2', 90);
    await settle();
    expect(lastPayload().title).toBe('Pause vorbei');
  });
});

describe('useRestTimerPush: a rest that ends early takes its push back', () => {
  it('clearing the rest cancels its push', async () => {
    startRestTimer('log-1', 90);
    mountShell();
    await settle();

    act(() => clearRestTimer('log-1'));
    await settle();

    expect(cancelCalls()).toEqual([['cancel_rest_push', { p_id: 'push-1' }]]);
  });

  it('the next set cancels the old push and schedules the new one', async () => {
    startRestTimer('log-1', 90);
    mountShell();
    await settle();

    act(() => startRestTimer('log-2', 120));
    await settle();

    expect(cancelCalls()).toEqual([['cancel_rest_push', { p_id: 'push-1' }]]);
    expect(scheduleCalls()).toHaveLength(2);
    expect(scheduleCalls()[1][1].p_seconds).toBe(120);
  });

  it('a rest that ends while its push is being scheduled cancels it as soon as the id is known, and never dispatches it', async () => {
    let answer;
    scheduleAnswers.push(new Promise((resolve) => (answer = resolve)));
    startRestTimer('log-1', 90);
    mountShell();
    await settle();
    expect(scheduleCalls()).toHaveLength(1);

    act(() => clearRestTimer('log-1'));
    await settle();
    expect(cancelCalls()).toEqual([]);

    answer({ data: { id: 'push-late', fire_at: 'later', mode: 'edge' }, error: null });
    await settle();

    expect(cancelCalls()).toEqual([['cancel_rest_push', { p_id: 'push-late' }]]);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('the next rest asks once the request of the rest before is answered: crossed, the old one would close the new row', async () => {
    let answer;
    scheduleAnswers.push(new Promise((resolve) => (answer = resolve)));
    startRestTimer('log-1', 90);
    mountShell();
    await settle();

    act(() => startRestTimer('log-2', 120));
    await settle();
    expect(scheduleCalls()).toHaveLength(1);

    answer({ data: { id: 'push-old', fire_at: 'later', mode: 'edge' }, error: null });
    await settle();

    expect(cancelCalls()).toEqual([['cancel_rest_push', { p_id: 'push-old' }]]);
    expect(scheduleCalls()).toHaveLength(2);
    expect(scheduleCalls()[1][1].p_seconds).toBe(120);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('a rest that changes again while it waits for its turn asks for nothing', async () => {
    let answer;
    scheduleAnswers.push(new Promise((resolve) => (answer = resolve)));
    startRestTimer('log-1', 90);
    mountShell();
    await settle();

    act(() => startRestTimer('log-2', 120));
    await settle();
    act(() => startRestTimer('log-3', 150));
    await settle();

    answer({ data: { id: 'push-old', fire_at: 'later', mode: 'edge' }, error: null });
    await settle();

    expect(scheduleCalls().map(([, args]) => args.p_seconds)).toEqual([90, 150]);
    expect(cancelCalls()).toEqual([['cancel_rest_push', { p_id: 'push-old' }]]);
  });

  it(`a request with no answer holds the next one back ${PREVIOUS_REQUEST_WAIT_MS} ms at most, and the seconds are counted when it leaves`, async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(NOW);
    const flush = () => act(() => vi.advanceTimersByTimeAsync(0));
    let answer;
    scheduleAnswers.push(new Promise((resolve) => (answer = resolve)));
    startRestTimer('log-1', 90);
    mountShell();
    await flush();
    expect(scheduleCalls()).toHaveLength(1);

    act(() => startRestTimer('log-2', 120));
    await act(() => vi.advanceTimersByTimeAsync(PREVIOUS_REQUEST_WAIT_MS - 1));
    expect(scheduleCalls()).toHaveLength(1);

    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(scheduleCalls()).toHaveLength(2);
    expect(scheduleCalls()[1][1].p_seconds).toBe(120 - PREVIOUS_REQUEST_WAIT_MS / 1000);

    // The first answer comes at last: its rest is over, its row taken back.
    answer({ data: { id: 'push-stuck', fire_at: 'later', mode: 'edge' }, error: null });
    await flush();
    expect(cancelCalls()).toEqual([['cancel_rest_push', { p_id: 'push-stuck' }]]);
  });

  it('leaving the shell (sign-out) cancels the push', async () => {
    startRestTimer('log-1', 90);
    const app = mountShell();
    await settle();

    app.unmount();
    await settle();

    expect(cancelCalls()).toEqual([['cancel_rest_push', { p_id: 'push-1' }]]);
  });

  it('under StrictMode the rest keeps exactly one push, not cancelled', async () => {
    startRestTimer('log-1', 90);
    mountShell({ strict: true });
    await settle();

    expect(scheduleCalls()).toHaveLength(1);
    expect(cancelCalls()).toEqual([]);
  });
});

describe('useRestTimerPush: when nothing is asked', () => {
  it.each([
    ['nobody is signed in', () => (mockUser = null)],
    ['the browser has no push', () => (device.supported = false)],
    ['notifications are not allowed', () => (device.permission = 'default')],
    ['this device has no subscription', () => (device.endpoint = null)],
    ['the device is offline', () => deviceIs(false)],
  ])('%s', async (_, arrange) => {
    arrange();
    startRestTimer('log-1', 90);
    mountShell();
    await settle();

    expect(rpc).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(tableRequests).toEqual([]);
  });

  it('a rest that is already over', async () => {
    startRestTimer('log-1', 30);
    vi.setSystemTime(NOW + 31_000);
    mountShell();
    await settle();

    expect(rpc).not.toHaveBeenCalled();
  });
});
