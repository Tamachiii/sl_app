import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// supabase mock: from('push_subscriptions').upsert(row, opts).select().maybeSingle()
vi.mock('./supabase', () => {
  const maybeSingle = vi.fn().mockResolvedValue({ data: { id: 'row-1' }, error: null });
  const select = vi.fn(() => ({ maybeSingle }));
  const upsert = vi.fn(() => ({ select }));
  const from = vi.fn(() => ({ upsert }));
  return { supabase: { from } };
});

// VAPID must be truthy for isPushSupported(); stub BEFORE importing the module
// (which reads import.meta.env at eval time), then dynamic-import it.
vi.stubEnv('VITE_VAPID_PUBLIC_KEY', 'test-vapid-key');
const { reconcilePushSubscription, enablePush } = await import('./pushNotifications');
const { supabase } = await import('./supabase');

function makeSub(endpoint = 'https://push.example/ep-1') {
  return {
    endpoint,
    toJSON: () => ({ endpoint, keys: { p256dh: 'p256', auth: 'authkey' } }),
  };
}

// Make isPushSupported() pass and drive permission + the active subscription.
function setEnv({ permission = 'granted', sub = makeSub() } = {}) {
  global.Notification = { permission };
  global.window.PushManager = function PushManager() {};
  const registration = {
    pushManager: { getSubscription: vi.fn().mockResolvedValue(sub) },
  };
  Object.defineProperty(global.navigator, 'serviceWorker', {
    value: { ready: Promise.resolve(registration) },
    configurable: true,
  });
}

function clearEnv() {
  delete global.Notification;
  delete global.window.PushManager;
}

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  clearEnv();
});

describe('reconcilePushSubscription', () => {
  it('returns false without a userId', async () => {
    setEnv();
    expect(await reconcilePushSubscription(null)).toBe(false);
  });

  it('returns false when push is unsupported', async () => {
    clearEnv(); // no Notification / PushManager
    expect(await reconcilePushSubscription('u-1')).toBe(false);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('returns false (and never writes) when permission is not granted', async () => {
    setEnv({ permission: 'default' });
    expect(await reconcilePushSubscription('u-1')).toBe(false);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('returns false when there is no active subscription', async () => {
    setEnv({ sub: null });
    expect(await reconcilePushSubscription('u-1')).toBe(false);
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('upserts the CURRENT endpoint and returns true when granted + subscribed', async () => {
    setEnv({ sub: makeSub('https://push.example/rotated') });
    const ok = await reconcilePushSubscription('u-1');
    expect(ok).toBe(true);
    expect(supabase.from).toHaveBeenCalledWith('push_subscriptions');
    const upsert = supabase.from.mock.results[0].value.upsert;
    const [row, opts] = upsert.mock.calls[0];
    expect(row).toMatchObject({
      user_id: 'u-1',
      endpoint: 'https://push.example/rotated',
      p256dh: 'p256',
      auth: 'authkey',
    });
    expect(opts).toEqual({ onConflict: 'endpoint' });
  });
});

describe('enablePush error codes', () => {
  // The toggles localize errors off these stable codes (common.pushError.*),
  // so the codes are a contract the i18n depends on.
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
});
