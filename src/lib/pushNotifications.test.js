import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The database, as lib/pushNotifications.js talks to it: one function
// (`claim_push_subscription`) and requests on the table `push_subscriptions`.
// Every request is written down, and answered by `db.answer`.
const db = vi.hoisted(() => ({
  rpc: null,
  requests: [],
  answer: null,
}));

vi.mock('./supabase', () => {
  function request(op, more = {}) {
    const made = { op, filters: {}, ...more };
    db.requests.push(made);
    const builder = {
      eq(column, value) {
        made.filters[column] = value;
        return builder;
      },
      select: () => builder,
      maybeSingle: () => Promise.resolve(db.answer(made)),
      // A request that is awaited as it is (a delete).
      then: (resolve, reject) => Promise.resolve(db.answer(made)).then(resolve, reject),
    };
    return builder;
  }
  return {
    supabase: {
      rpc: (...args) => db.rpc(...args),
      from: (table) => ({
        upsert: (row, opts) => request('upsert', { table, row, opts }),
        delete: () => request('delete', { table }),
        select: (columns) => request('select', { table, columns }),
      }),
    },
  };
});

// VAPID must be truthy for isPushSupported(); stub BEFORE importing the module
// (which reads import.meta.env at eval time), then dynamic-import it.
vi.stubEnv('VITE_VAPID_PUBLIC_KEY', 'dGVzdC1rZXk');
const {
  reconcilePushSubscription,
  enablePush,
  disablePush,
  isPushEnabled,
  releasePushSubscription,
  resumePushSubscription,
  isPushResumable,
  pushErrorKey,
  PUSH_ERROR_KEYS,
  PUSH_RESUME_KEY,
} = await import('./pushNotifications');
const { messages, getMessage, LANGUAGES } = await import('./i18n');

const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/ep-1';
const CREATED = { subscription_id: 'row-1', outcome: 'created' };

// --- the device --------------------------------------------------------------
// The browser's one push subscription for the app, and the service worker
// registration that holds it.
let pushManager;

function makeSub(endpoint = ENDPOINT, keys = { p256dh: 'p256', auth: 'authkey' }) {
  const sub = {
    endpoint,
    toJSON: () => ({ endpoint, keys }),
    unsubscribe: vi.fn(async () => {
      if (pushManager?.held === sub) pushManager.held = null;
      return true;
    }),
  };
  return sub;
}

// Make isPushSupported() pass and drive permission + the active subscription.
// `fresh` is what the push service hands out at the next subscribe().
function setEnv({ permission = 'granted', sub = makeSub(), fresh = makeSub('https://fcm.googleapis.com/fcm/send/fresh', { p256dh: 'p256-fresh', auth: 'auth-fresh' }) } = {}) {
  global.Notification = { permission };
  global.window.PushManager = function PushManager() {};
  pushManager = {
    held: sub,
    getSubscription: vi.fn(async () => pushManager.held),
    subscribe: vi.fn(async () => {
      pushManager.held = fresh;
      return fresh;
    }),
  };
  const registration = { pushManager };
  Object.defineProperty(global.navigator, 'serviceWorker', {
    value: { ready: Promise.resolve(registration), getRegistration: vi.fn(async () => registration) },
    configurable: true,
  });
  return pushManager;
}

function clearEnv() {
  delete global.Notification;
  delete global.window.PushManager;
}

function deviceIs(online) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
}

// --- what the database answers ------------------------------------------------
// The shapes are the ones supabase-js hands back.
const NO_ANSWER = { message: 'TypeError: Failed to fetch', details: '', hint: '', code: '' };
const ENDPOINT_REFUSED = {
  code: '23514',
  message:
    'new row for relation "push_subscriptions" violates check constraint "push_subscriptions_endpoint_known_push_service"',
  details: 'Failing row contains (…).',
  hint: null,
};
const KEYS_MISMATCH = {
  code: 'P0001',
  message: 'endpoint_keys_mismatch',
  details: 'Another account holds this endpoint, and the keys sent are not the ones stored with it.',
  hint: 'A device takes a subscription over by presenting the keys it was registered with. Nothing was changed.',
};
const NOT_AUTHORIZED = { code: '42501', message: 'not authorized', details: 'The request carries no user id.', hint: null };
const refused = (error) => ({ data: null, error });

const claims = () => db.rpc.mock.calls.filter(([name]) => name === 'claim_push_subscription').map(([, args]) => args);
const requestsOf = (op) => db.requests.filter((made) => made.op === op);

// The accounts the device remembers as having left it with notifications on.
const remembered = () => JSON.parse(localStorage.getItem(PUSH_RESUME_KEY)) ?? [];
const remember = (...ids) => localStorage.setItem(PUSH_RESUME_KEY, JSON.stringify(ids));

beforeEach(() => {
  localStorage.removeItem(PUSH_RESUME_KEY);
  db.requests.length = 0;
  db.rpc = vi.fn().mockResolvedValue({ data: CREATED, error: null });
  db.answer = () => ({ data: { id: 'row-1' }, error: null });
  deviceIs(true);
});
afterEach(() => {
  clearEnv();
  delete navigator.onLine;
});

describe('reconcilePushSubscription', () => {
  it('returns false without a userId', async () => {
    setEnv();
    expect(await reconcilePushSubscription(null)).toBe(false);
  });

  it('returns false when push is unsupported', async () => {
    clearEnv(); // no Notification / PushManager
    expect(await reconcilePushSubscription('u-1')).toBe(false);
    expect(db.requests).toEqual([]);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it('returns false (and never writes) when permission is not granted', async () => {
    setEnv({ permission: 'default' });
    expect(await reconcilePushSubscription('u-1')).toBe(false);
    expect(db.requests).toEqual([]);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it('returns false when there is no active subscription', async () => {
    setEnv({ sub: null });
    expect(await reconcilePushSubscription('u-1')).toBe(false);
    expect(db.requests).toEqual([]);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  // B37. The worker re-subscribes when the push service rotates the address
  // (where the browser tells it), and writes nothing: it has no session.
  it('registers the CURRENT endpoint through claim_push_subscription and returns true when granted + subscribed', async () => {
    setEnv({ sub: makeSub('https://fcm.googleapis.com/fcm/send/rotated', { p256dh: 'p256-rotated', auth: 'auth-rotated' }) });

    const ok = await reconcilePushSubscription('u-1');

    expect(ok).toBe(true);
    expect(claims()).toEqual([
      {
        p_endpoint: 'https://fcm.googleapis.com/fcm/send/rotated',
        p_p256dh: 'p256-rotated',
        p_auth: 'auth-rotated',
        p_user_agent: navigator.userAgent,
      },
    ]);
    expect(requestsOf('upsert')).toEqual([]);
  });

  // P15. The owner-only upsert was refused here, and the refusal swallowed.
  it('a subscription the previous account left on this device moves to the one that is signed in', async () => {
    const device = setEnv();
    db.rpc.mockResolvedValue({ data: { subscription_id: 'row-1', outcome: 'rehomed' }, error: null });

    await expect(reconcilePushSubscription('u-2')).resolves.toBe(true);

    expect(claims()).toHaveLength(1);
    expect(device.subscribe).not.toHaveBeenCalled();
  });

  it('throws what the database answered, with a code — the caller decides what a failed look is', async () => {
    setEnv();
    db.rpc.mockResolvedValue(refused(ENDPOINT_REFUSED));
    await expect(reconcilePushSubscription('u-1')).rejects.toMatchObject({ code: 'endpoint_refused' });

    db.rpc.mockResolvedValue(refused(NO_ANSWER));
    await expect(reconcilePushSubscription('u-1')).rejects.toMatchObject({ code: 'offline' });
  });

  it('never renews the subscription: an address held under other keys is a failure here, and the browser is left alone', async () => {
    const sub = makeSub();
    const device = setEnv({ sub });
    db.rpc.mockResolvedValue(refused(KEYS_MISMATCH));

    await expect(reconcilePushSubscription('u-1')).rejects.toMatchObject({ code: 'keys_mismatch' });

    expect(sub.unsubscribe).not.toHaveBeenCalled();
    expect(device.subscribe).not.toHaveBeenCalled();
    expect(claims()).toHaveLength(1);
  });

  it('never subscribes: a device without a subscription is left without one', async () => {
    const device = setEnv({ sub: null });

    await expect(reconcilePushSubscription('u-1')).resolves.toBe(false);

    expect(device.subscribe).not.toHaveBeenCalled();
    expect(db.rpc).not.toHaveBeenCalled();
  });
});

// P15. The app upserted the row itself, under policies that let an account
// write its own rows only: on a shared device the second account was refused.
describe('enablePush registers the device through claim_push_subscription', () => {
  it('sends the endpoint and the two keys of the browser subscription — and no user id: the function asks who calls', async () => {
    setEnv();

    const answer = await enablePush('u-1');

    expect(claims()).toEqual([
      { p_endpoint: ENDPOINT, p_p256dh: 'p256', p_auth: 'authkey', p_user_agent: navigator.userAgent },
    ]);
    expect(answer).toEqual(CREATED);
    // The owner-only upsert is gone: it is what refused the second account.
    expect(requestsOf('upsert')).toEqual([]);
  });

  it('subscribes first on a device that holds no subscription, with the app\'s VAPID key', async () => {
    const device = setEnv({ sub: null });

    await enablePush('u-1');

    expect(device.subscribe).toHaveBeenCalledTimes(1);
    const [options] = device.subscribe.mock.calls[0];
    expect(options.userVisibleOnly).toBe(true);
    expect(new TextDecoder().decode(options.applicationServerKey)).toBe('test-key');
    expect(claims()[0]).toMatchObject({
      p_endpoint: 'https://fcm.googleapis.com/fcm/send/fresh',
      p_p256dh: 'p256-fresh',
      p_auth: 'auth-fresh',
    });
  });

  it('a device the previous account left its subscription on is handed over: the same subscription, claimed with its keys', async () => {
    const device = setEnv();
    db.rpc.mockResolvedValue({ data: { subscription_id: 'row-1', outcome: 'rehomed' }, error: null });

    await expect(enablePush('u-2')).resolves.toEqual({ subscription_id: 'row-1', outcome: 'rehomed' });

    // Nothing new is asked of the push service: the keys this browser holds
    // are the proof.
    expect(device.subscribe).not.toHaveBeenCalled();
    expect(claims()).toHaveLength(1);
  });

  it('asks for the permission when the browser has not been asked yet', async () => {
    setEnv({ permission: 'default' });
    global.Notification.requestPermission = vi.fn().mockResolvedValue('granted');

    await enablePush('u-1');

    expect(global.Notification.requestPermission).toHaveBeenCalledTimes(1);
    expect(claims()).toHaveLength(1);
  });
});

describe('what stops enablePush, as a code the toggle has words for', () => {
  // The toggles localize errors off these stable codes (PUSH_ERROR_KEYS), so
  // the codes are a contract the i18n depends on.
  it('throws code "not_signed_in" without a userId', async () => {
    setEnv();
    await expect(enablePush(null)).rejects.toMatchObject({ code: 'not_signed_in' });
  });

  it('throws code "permission_denied" when the prompt is declined', async () => {
    setEnv({ permission: 'default' });
    global.Notification.requestPermission = vi.fn().mockResolvedValue('denied');
    await expect(enablePush('u-1')).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('throws code "permission_denied" when notifications are blocked', async () => {
    setEnv({ permission: 'denied' });
    await expect(enablePush('u-1')).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('"offline" on a device without a network — before the permission is asked for, and nothing is sent', async () => {
    const device = setEnv({ permission: 'default', sub: null });
    global.Notification.requestPermission = vi.fn().mockResolvedValue('granted');
    deviceIs(false);

    await expect(enablePush('u-1')).rejects.toMatchObject({ code: 'offline' });

    expect(global.Notification.requestPermission).not.toHaveBeenCalled();
    expect(device.subscribe).not.toHaveBeenCalled();
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it('"offline" when the request got no answer', async () => {
    setEnv();
    db.rpc.mockResolvedValue(refused(NO_ANSWER));
    await expect(enablePush('u-1')).rejects.toMatchObject({ code: 'offline', cause: NO_ANSWER });
  });

  it('"offline" when supabase-js throws instead of answering', async () => {
    setEnv();
    db.rpc.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(enablePush('u-1')).rejects.toMatchObject({ code: 'offline' });
  });

  // B3: the database holds an endpoint to the known push services.
  it('"endpoint_refused" when the push service of the browser is not one the database accepts', async () => {
    setEnv({ sub: makeSub('https://push.example.org/ep-1') });
    db.rpc.mockResolvedValue(refused(ENDPOINT_REFUSED));
    await expect(enablePush('u-1')).rejects.toMatchObject({ code: 'endpoint_refused' });
  });

  it('another check that fails is not said to be about the push service', async () => {
    setEnv();
    db.rpc.mockResolvedValue(
      refused({ code: '23514', message: 'new row for relation "push_subscriptions" violates check constraint "something_else"' }),
    );
    await expect(enablePush('u-1')).rejects.toMatchObject({ code: 'generic' });
  });

  it('"not_signed_in" when the request left without a session', async () => {
    setEnv();
    db.rpc.mockResolvedValue(refused(NOT_AUTHORIZED));
    await expect(enablePush('u-1')).rejects.toMatchObject({ code: 'not_signed_in' });

    db.rpc.mockResolvedValue(
      refused({ code: '42501', message: 'permission denied for function claim_push_subscription' }),
    );
    await expect(enablePush('u-1')).rejects.toMatchObject({ code: 'not_signed_in' });
  });

  it('"generic" for an answer nobody planned for — never an SQLSTATE', async () => {
    setEnv();
    db.rpc.mockResolvedValue(
      refused({ code: 'PGRST202', message: 'Could not find the function public.claim_push_subscription' }),
    );
    await expect(enablePush('u-1')).rejects.toMatchObject({ code: 'generic' });
  });

  it('a browser that gives no subscription: a code of this file, not the number of a DOMException', async () => {
    const device = setEnv({ sub: null });
    device.subscribe.mockRejectedValue(new DOMException('Registration failed - push service error', 'AbortError'));
    await expect(enablePush('u-1')).rejects.toMatchObject({ code: 'generic' });

    device.subscribe.mockRejectedValue(new DOMException('Permission denied', 'NotAllowedError'));
    await expect(enablePush('u-1')).rejects.toMatchObject({ code: 'permission_denied' });

    expect(db.rpc).not.toHaveBeenCalled();
  });
});

// "A push subscription changes hands only with its keys": a row that holds
// this device's address under OTHER keys was not written by this browser.
describe('another account holds this address under other keys', () => {
  it('the browser takes a new address from the push service, and that one is registered', async () => {
    const stale = makeSub();
    const device = setEnv({ sub: stale });
    db.rpc.mockResolvedValueOnce(refused(KEYS_MISMATCH));

    await expect(enablePush('u-1')).resolves.toEqual(CREATED);

    expect(stale.unsubscribe).toHaveBeenCalledTimes(1);
    expect(device.subscribe).toHaveBeenCalledTimes(1);
    expect(claims().map((claim) => claim.p_endpoint)).toEqual([
      ENDPOINT,
      'https://fcm.googleapis.com/fcm/send/fresh',
    ]);
    expect(claims()[1]).toMatchObject({ p_p256dh: 'p256-fresh', p_auth: 'auth-fresh' });
  });

  it('once: a second refusal is an error for the toggle, with words', async () => {
    const device = setEnv();
    db.rpc.mockResolvedValue(refused(KEYS_MISMATCH));

    const failure = await enablePush('u-1').catch((error) => error);

    expect(failure.code).toBe('keys_mismatch');
    expect(pushErrorKey(failure.code)).toBe(PUSH_ERROR_KEYS.generic);
    expect(device.subscribe).toHaveBeenCalledTimes(1);
    expect(claims()).toHaveLength(2);
  });

  it('a browser that will not give its subscription up is not asked for another one', async () => {
    const stuck = makeSub();
    stuck.unsubscribe.mockRejectedValue(new DOMException('no', 'NetworkError'));
    const device = setEnv({ sub: stuck });
    db.rpc.mockResolvedValueOnce(refused(KEYS_MISMATCH));

    await expect(enablePush('u-1')).rejects.toMatchObject({ code: 'generic' });
    expect(device.subscribe).not.toHaveBeenCalled();
  });
});

describe('isPushEnabled', () => {
  it('asks for the row of THIS account and THIS device', async () => {
    setEnv();
    await expect(isPushEnabled('u-1')).resolves.toBe(true);
    expect(requestsOf('select')).toEqual([
      expect.objectContaining({ table: 'push_subscriptions', filters: { user_id: 'u-1', endpoint: ENDPOINT } }),
    ]);

    db.answer = () => ({ data: null, error: null });
    await expect(isPushEnabled('u-1')).resolves.toBe(false);
  });

  it('is false without a request when the browser holds no subscription', async () => {
    setEnv({ sub: null });
    await expect(isPushEnabled('u-1')).resolves.toBe(false);
    expect(db.requests).toEqual([]);
  });

  // It answered `false` — "off" — for a device that may well be registered.
  it('a read that gets no answer is not "off": it throws, with a code', async () => {
    setEnv();
    db.answer = () => refused(NO_ANSWER);
    await expect(isPushEnabled('u-1')).rejects.toMatchObject({ code: 'offline' });
  });

  it('nor is a device without a network: nothing is sent', async () => {
    setEnv();
    deviceIs(false);
    await expect(isPushEnabled('u-1')).rejects.toMatchObject({ code: 'offline' });
    expect(db.requests).toEqual([]);
  });
});

describe('disablePush', () => {
  it('removes the row of this account for this device, then the browser gives its subscription up', async () => {
    const sub = makeSub();
    setEnv({ sub });

    await disablePush('u-1');

    expect(requestsOf('delete')).toEqual([
      expect.objectContaining({ table: 'push_subscriptions', filters: { user_id: 'u-1', endpoint: ENDPOINT } }),
    ]);
    expect(sub.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('a row that could not be removed is no failure when the browser gave the subscription up: nothing arrives any more', async () => {
    const sub = makeSub();
    setEnv({ sub });
    db.answer = () => refused(NO_ANSWER);

    await expect(disablePush('u-1')).resolves.toBeUndefined();
    expect(sub.unsubscribe).toHaveBeenCalledTimes(1);
  });

  // The error of the delete was never read: the toggle said "off".
  it('throws when the row is still there AND the browser still holds the subscription', async () => {
    const sub = makeSub();
    sub.unsubscribe.mockRejectedValue(new Error('push service unreachable'));
    setEnv({ sub });
    db.answer = () => refused(NO_ANSWER);

    await expect(disablePush('u-1')).rejects.toMatchObject({ code: 'offline' });
  });

  it('without a network the row is not asked for, and the browser still gives the subscription up', async () => {
    const sub = makeSub();
    setEnv({ sub });
    deviceIs(false);

    await expect(disablePush('u-1')).resolves.toBeUndefined();

    expect(db.requests).toEqual([]);
    expect(sub.unsubscribe).toHaveBeenCalledTimes(1);
  });
});

// P15: what a sign-out does first (hooks/useAuth.push.test.jsx holds the
// order, on the provider).
describe('releasePushSubscription', () => {
  it('removes the row of this device and the browser gives its subscription up', async () => {
    const sub = makeSub();
    setEnv({ sub });

    await releasePushSubscription();

    expect(requestsOf('delete')).toEqual([
      expect.objectContaining({ table: 'push_subscriptions', filters: { endpoint: ENDPOINT } }),
    ]);
    expect(sub.unsubscribe).toHaveBeenCalledTimes(1);
    expect(pushManager.held).toBeNull();
  });

  it('asks nothing on a device that holds no subscription', async () => {
    setEnv({ sub: null });

    await releasePushSubscription();

    expect(db.requests).toEqual([]);
  });

  it('needs neither the permission nor the VAPID key of this build: a subscription that is there is released', async () => {
    const sub = makeSub();
    setEnv({ sub, permission: 'default' });
    delete global.window.PushManager;

    await releasePushSubscription();

    expect(sub.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('does not wait for a service worker to be ready: in a browser where none took control, that never comes', async () => {
    const sub = makeSub();
    setEnv({ sub });
    const registration = await navigator.serviceWorker.getRegistration();
    Object.defineProperty(global.navigator, 'serviceWorker', {
      value: { ready: new Promise(() => {}), getRegistration: async () => registration },
      configurable: true,
    });

    await releasePushSubscription();

    expect(sub.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('without a network the row is not asked for; the browser still gives the subscription up', async () => {
    const sub = makeSub();
    setEnv({ sub });
    deviceIs(false);

    await releasePushSubscription();

    expect(db.requests).toEqual([]);
    expect(sub.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('a row that is not removed does not keep the browser from giving the subscription up, and the other way round', async () => {
    const sub = makeSub();
    setEnv({ sub });
    db.answer = () => {
      throw new Error('client gone');
    };
    await expect(releasePushSubscription()).resolves.toBeUndefined();
    expect(sub.unsubscribe).toHaveBeenCalledTimes(1);

    const stuck = makeSub();
    stuck.unsubscribe.mockRejectedValue(new Error('push service unreachable'));
    setEnv({ sub: stuck });
    db.requests.length = 0;
    db.answer = () => ({ data: null, error: null });
    await expect(releasePushSubscription()).resolves.toBeUndefined();
    expect(requestsOf('delete')).toHaveLength(1);
  });

  it('gives up after the time it is given, and says nothing', async () => {
    const sub = makeSub();
    sub.unsubscribe.mockImplementation(() => new Promise(() => {}));
    setEnv({ sub });
    db.answer = () => new Promise(() => {});

    await expect(releasePushSubscription({ timeoutMs: 20 })).resolves.toBeUndefined();
  });

  it('never throws: a browser whose registration cannot be read', async () => {
    Object.defineProperty(global.navigator, 'serviceWorker', {
      value: { getRegistration: () => Promise.reject(new Error('SecurityError')) },
      configurable: true,
    });
    await expect(releasePushSubscription()).resolves.toBeUndefined();

    Object.defineProperty(global.navigator, 'serviceWorker', { value: {}, configurable: true });
    await expect(releasePushSubscription()).resolves.toBeUndefined();
  });
});

// A sign-out releases the device. Without more, the account that signs in
// again — the same athlete, or the owner of a phone two accounts share, at
// every switch — has lost its notifications without a word.
describe('notifications come back with the account that had them on', () => {
  describe('what the device remembers', () => {
    it('the account that leaves a device it received on', async () => {
      setEnv();

      await releasePushSubscription({ userId: 'u-1' });

      expect(remembered()).toEqual(['u-1']);
      expect(isPushResumable('u-1')).toBe(true);
      expect(isPushResumable('u-2')).toBe(false);
    });

    it('not one that leaves a device without a subscription: it never asked for them here, or switched them off', async () => {
      setEnv({ sub: null });

      await releasePushSubscription({ userId: 'u-1' });

      expect(remembered()).toEqual([]);
      expect(isPushResumable('u-1')).toBe(false);
    });

    it('each account once, the last to leave last — two accounts that share a phone are both there', async () => {
      for (const userId of ['u-1', 'u-2', 'u-1']) {
        setEnv();
        await releasePushSubscription({ userId });
      }
      expect(remembered()).toEqual(['u-2', 'u-1']);
    });

    it('a handful at most', async () => {
      for (let n = 1; n <= 12; n += 1) {
        setEnv();
        await releasePushSubscription({ userId: `u-${n}` });
      }
      expect(remembered()).toHaveLength(8);
      expect(remembered().at(-1)).toBe('u-12');
      expect(isPushResumable('u-1')).toBe(false);
    });

    it('nothing that is not a list of ids is taken for one', () => {
      for (const junk of ['{not json', '"u-1"', '{"u-1":true}', '[1,null,""]']) {
        localStorage.setItem(PUSH_RESUME_KEY, junk);
        expect(isPushResumable('u-1')).toBe(false);
      }
      expect(isPushResumable(undefined)).toBe(false);
    });

    it('switching them off takes the account off the list, and so does having them back', async () => {
      remember('u-1', 'u-2');
      setEnv();
      await disablePush('u-1');
      expect(remembered()).toEqual(['u-2']);

      setEnv();
      await enablePush('u-2');
      expect(remembered()).toEqual([]);

      remember('u-1');
      setEnv();
      await reconcilePushSubscription('u-1');
      expect(remembered()).toEqual([]);
    });
  });

  describe('resumePushSubscription', () => {
    it('the account that is back: the browser takes a subscription, it is registered, and the account is off the list', async () => {
      remember('u-1');
      const device = setEnv({ sub: null });

      await expect(resumePushSubscription('u-1')).resolves.toBe(true);

      expect(device.subscribe).toHaveBeenCalledTimes(1);
      expect(claims()).toEqual([
        {
          p_endpoint: 'https://fcm.googleapis.com/fcm/send/fresh',
          p_p256dh: 'p256-fresh',
          p_auth: 'auth-fresh',
          p_user_agent: navigator.userAgent,
        },
      ]);
      expect(remembered()).toEqual([]);
    });

    // The point of the list: a look never enrolls an account that did not ask.
    it('another account is never enrolled: nothing is asked of the browser or the database', async () => {
      remember('u-1');
      const device = setEnv({ sub: null });

      await expect(resumePushSubscription('u-2')).resolves.toBe(false);

      expect(device.subscribe).not.toHaveBeenCalled();
      expect(db.rpc).not.toHaveBeenCalled();
      expect(remembered()).toEqual(['u-1']);
    });

    it('never prompts: without the permission nothing happens, and the account stays on the list', async () => {
      remember('u-1');
      const device = setEnv({ sub: null, permission: 'default' });
      global.Notification.requestPermission = vi.fn();

      await expect(resumePushSubscription('u-1')).resolves.toBe(false);

      expect(global.Notification.requestPermission).not.toHaveBeenCalled();
      expect(device.subscribe).not.toHaveBeenCalled();
      expect(remembered()).toEqual(['u-1']);
    });

    it('a subscription that is there is left to reconcilePushSubscription', async () => {
      remember('u-1');
      const device = setEnv();

      await expect(resumePushSubscription('u-1')).resolves.toBe(false);

      expect(device.subscribe).not.toHaveBeenCalled();
      expect(db.rpc).not.toHaveBeenCalled();
    });

    it('a browser that wants the user\'s own tap is not asked twice: the toggle is the way', async () => {
      remember('u-1');
      const device = setEnv({ sub: null });
      device.subscribe.mockRejectedValue(new DOMException('needs a user gesture', 'NotAllowedError'));

      await expect(resumePushSubscription('u-1')).rejects.toMatchObject({ code: 'permission_denied' });

      expect(remembered()).toEqual([]);
      await expect(resumePushSubscription('u-1')).resolves.toBe(false);
      expect(device.subscribe).toHaveBeenCalledTimes(1);
    });

    it('what else fails is thrown with a code, and the account stays on the list for the next look', async () => {
      remember('u-1');
      const device = setEnv({ sub: null });
      device.subscribe.mockRejectedValueOnce(new DOMException('push service error', 'AbortError'));
      await expect(resumePushSubscription('u-1')).rejects.toMatchObject({ code: 'generic' });
      expect(remembered()).toEqual(['u-1']);

      deviceIs(false);
      await expect(resumePushSubscription('u-1')).rejects.toMatchObject({ code: 'offline' });
      expect(remembered()).toEqual(['u-1']);
    });

    it('a subscription the database did not take is registered by the next look, and the list is cleared then', async () => {
      remember('u-1');
      setEnv({ sub: null });
      db.rpc.mockResolvedValueOnce(refused(NO_ANSWER));
      await expect(resumePushSubscription('u-1')).rejects.toMatchObject({ code: 'offline' });
      expect(remembered()).toEqual(['u-1']);

      // The browser holds the subscription now.
      await expect(reconcilePushSubscription('u-1')).resolves.toBe(true);
      expect(remembered()).toEqual([]);
    });
  });
});

describe('the words of the codes', () => {
  it('every code has a sentence in the three languages', () => {
    const missing = [];
    for (const [code, key] of Object.entries(PUSH_ERROR_KEYS)) {
      for (const lang of LANGUAGES) {
        const node = key.split('.').reduce((at, part) => at?.[part], messages[lang]);
        if (typeof node !== 'string' || node === '') missing.push(`${lang}: ${code} → ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('a code without a sentence of its own, and anything that is not a code, reads as "generic"', () => {
    expect(pushErrorKey('')).toBe('');
    expect(pushErrorKey(undefined)).toBe('');
    expect(pushErrorKey('offline')).toBe('pushIdentity.offline');
    expect(pushErrorKey('endpoint_refused')).toBe('pushIdentity.endpoint_refused');
    expect(pushErrorKey('permission_denied')).toBe('common.pushError.permission_denied');
    // What the toggles printed before: `common.pushError.42501`, `…20`.
    for (const stray of ['keys_mismatch', '42501', '23514', 20, 'toString', '__proto__']) {
      expect(pushErrorKey(stray)).toBe('common.pushError.generic');
    }
    expect(getMessage('en', pushErrorKey('42501'))).toBe(messages.en.common.pushError.generic);
  });
});
