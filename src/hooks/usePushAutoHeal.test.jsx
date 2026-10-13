import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

// The device: what the browser holds, without a request.
const device = { supported: true, permission: 'granted', endpoint: 'https://push.example/first' };
// The one call that reaches the database.
const reconcile = vi.fn();
vi.mock('../lib/pushNotifications', () => ({
  reconcilePushSubscription: (...args) => reconcile(...args),
  isPushSupported: () => device.supported,
  pushPermission: () => device.permission,
  getActivePushSubscription: async () => (device.endpoint ? { endpoint: device.endpoint } : null),
}));

let mockUser = { id: 'u-1' };
vi.mock('./useAuth', () => ({
  useAuth: () => ({ user: mockUser }),
}));

import {
  usePushAutoHeal,
  lastHeal,
  noteHealed,
  HEAL_EVERY_MS,
  HEAL_RETRY_MS,
  HEAL_STAMP_KEY,
} from './usePushAutoHeal';

const MINUTE = 60_000;
const NOW = Date.parse('2026-10-13T18:00:00.000Z');

// The heal reads the browser and the stamp before it decides: let it finish.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function deviceIs(online) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => online });
}

function pageBecomes(state) {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

// The phone is unlocked `ms` later.
async function unlockAfter(ms) {
  pageBecomes('hidden');
  vi.setSystemTime(Date.now() + ms);
  pageBecomes('visible');
  await settle();
}

// The app opened on the device.
async function openApp() {
  const app = renderHook(() => usePushAutoHeal());
  await settle();
  return app;
}

const stamp = () => JSON.parse(localStorage.getItem(HEAL_STAMP_KEY));

// What lib/pushNotifications.js throws: an error with a code of that file.
function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

beforeEach(() => {
  localStorage.removeItem(HEAL_STAMP_KEY);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  reconcile.mockReset();
  reconcile.mockResolvedValue(true);
  mockUser = { id: 'u-1' };
  Object.assign(device, { supported: true, permission: 'granted', endpoint: 'https://push.example/first' });
  deviceIs(true);
});

afterEach(() => {
  vi.useRealTimers();
  delete navigator.onLine;
  localStorage.removeItem(HEAL_STAMP_KEY);
});

describe('usePushAutoHeal', () => {
  it('reconciles on load for the signed-in user, and notes it on the device', async () => {
    await openApp();

    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledWith('u-1');
    expect(stamp()).toEqual({ userId: 'u-1', endpoint: 'https://push.example/first', at: NOW, ok: true });
  });

  it('does not look while the tab is hidden', async () => {
    await openApp();
    reconcile.mockClear();
    localStorage.removeItem(HEAL_STAMP_KEY);

    pageBecomes('hidden');
    await settle();

    expect(reconcile).not.toHaveBeenCalled();
  });

  it('no-ops when there is no signed-in user', async () => {
    mockUser = null;
    await openApp();
    pageBecomes('visible');
    await settle();

    expect(reconcile).not.toHaveBeenCalled();
    expect(stamp()).toBeNull();
  });

  it('removes the visibility listener on unmount', async () => {
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    const { unmount } = await openApp();
    unmount();
    expect(removeSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    removeSpy.mockRestore();
  });
});

// P33. Each unlock of a workout was an upsert of push_subscriptions.
describe('at most one write an hour', () => {
  it('twenty rests of a workout send nothing more', async () => {
    await openApp();
    expect(reconcile).toHaveBeenCalledTimes(1);

    // 20 × 2 min 55 s: just under the hour.
    for (let rest = 0; rest < 20; rest += 1) await unlockAfter(175_000);

    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('the first return to the app after the hour does, and the hour starts again', async () => {
    await openApp();

    await unlockAfter(HEAL_EVERY_MS - MINUTE);
    expect(reconcile).toHaveBeenCalledTimes(1);

    await unlockAfter(MINUTE);
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(stamp().at).toBe(NOW + HEAL_EVERY_MS);

    await unlockAfter(HEAL_EVERY_MS - MINUTE);
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  it('an app that iOS closed and that is opened again does not start over', async () => {
    const first = await openApp();
    first.unmount();

    vi.setSystemTime(NOW + 10 * MINUTE);
    await openApp();
    expect(reconcile).toHaveBeenCalledTimes(1);

    vi.setSystemTime(NOW + HEAL_EVERY_MS);
    await openApp();
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  it('the load and the page becoming visible in the same moment are one write', async () => {
    renderHook(() => usePushAutoHeal());
    pageBecomes('visible');
    pageBecomes('visible');
    await settle();

    expect(reconcile).toHaveBeenCalledTimes(1);
  });
});

describe('what does not wait for the hour', () => {
  it('a new address from the push service: delivery is dead until the row has it', async () => {
    await openApp();

    // The worker re-subscribed on pushsubscriptionchange; nobody told the database.
    device.endpoint = 'https://push.example/rotated';
    await unlockAfter(MINUTE);

    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(stamp()).toMatchObject({ endpoint: 'https://push.example/rotated', ok: true });

    await unlockAfter(MINUTE);
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  // P15: this look is what moves the device to the account that is signed in.
  it('another account on this device', async () => {
    const first = await openApp();
    first.unmount();

    mockUser = { id: 'u-2' };
    vi.setSystemTime(NOW + MINUTE);
    await openApp();

    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(reconcile).toHaveBeenLastCalledWith('u-2');
    expect(stamp().userId).toBe('u-2');
  });

  it('the account that comes back to a device somebody else used in between', async () => {
    const first = await openApp();
    first.unmount();

    mockUser = { id: 'u-2' };
    vi.setSystemTime(NOW + MINUTE);
    const second = await openApp();
    second.unmount();

    mockUser = { id: 'u-1' };
    vi.setSystemTime(NOW + 2 * MINUTE);
    await openApp();

    expect(reconcile).toHaveBeenCalledTimes(3);
    expect(reconcile).toHaveBeenLastCalledWith('u-1');
  });

  it('a note on the device that cannot be read, or that is dated in the future', async () => {
    localStorage.setItem(HEAL_STAMP_KEY, '{not json');
    const first = await openApp();
    expect(reconcile).toHaveBeenCalledTimes(1);
    first.unmount();

    // The clock of the phone was set back a day.
    vi.setSystemTime(NOW - 24 * 60 * MINUTE);
    await openApp();
    expect(reconcile).toHaveBeenCalledTimes(2);
  });
});

describe('a write that failed', () => {
  it('is swallowed, and tried again after five minutes — not at every unlock', async () => {
    reconcile.mockRejectedValue(new Error('network'));
    await openApp();
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(stamp()).toEqual({
      userId: 'u-1',
      endpoint: 'https://push.example/first',
      at: NOW,
      ok: false,
      code: 'generic',
    });

    await unlockAfter(HEAL_RETRY_MS - MINUTE);
    expect(reconcile).toHaveBeenCalledTimes(1);

    reconcile.mockResolvedValue(true);
    await unlockAfter(MINUTE);
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(stamp()).toMatchObject({ ok: true, at: NOW + HEAL_RETRY_MS });
  });

  it('a device without a network is not counted as one: nothing is tried, nothing is noted', async () => {
    deviceIs(false);
    await openApp();
    await unlockAfter(MINUTE);

    expect(reconcile).not.toHaveBeenCalled();
    expect(stamp()).toBeNull();

    deviceIs(true);
    await unlockAfter(MINUTE);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });
});

// B37 / P15. The failure was caught and forgotten: nothing could say why a
// device had stopped receiving.
describe('a look that failed is written down, with what failed', () => {
  it('the code of the library, and the address it was about', async () => {
    reconcile.mockRejectedValue(coded('endpoint_refused'));
    await openApp();

    expect(stamp()).toEqual({
      userId: 'u-1',
      endpoint: 'https://push.example/first',
      at: NOW,
      ok: false,
      code: 'endpoint_refused',
    });
    await expect(lastHeal('u-1')).resolves.toEqual({ ok: false, code: 'endpoint_refused' });
  });

  it('nothing is thrown, and nothing is asked again before the five minutes', async () => {
    reconcile.mockRejectedValue(coded('keys_mismatch'));
    await openApp();
    await unlockAfter(MINUTE);

    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(stamp()).toMatchObject({ ok: false, code: 'keys_mismatch' });
  });

  it('the next look that succeeds takes it back', async () => {
    reconcile.mockRejectedValueOnce(coded('offline'));
    await openApp();
    await expect(lastHeal('u-1')).resolves.toEqual({ ok: false, code: 'offline' });

    await unlockAfter(HEAL_RETRY_MS);

    expect(stamp()).toEqual({ userId: 'u-1', endpoint: 'https://push.example/first', at: NOW + HEAL_RETRY_MS, ok: true });
    await expect(lastHeal('u-1')).resolves.toEqual({ ok: true, code: '' });
  });
});

describe('lastHeal: what this device last told the database about the subscription it holds now', () => {
  it('nothing, before any look', async () => {
    await expect(lastHeal('u-1')).resolves.toBeNull();
  });

  it('a look that the database took', async () => {
    await openApp();
    await expect(lastHeal('u-1')).resolves.toEqual({ ok: true, code: '' });
  });

  it('says nothing about another account', async () => {
    await openApp();
    await expect(lastHeal('u-2')).resolves.toBeNull();
    await expect(lastHeal(undefined)).resolves.toBeNull();
  });

  it('nor about another address: the device has a new one, or none any more', async () => {
    reconcile.mockRejectedValue(coded('endpoint_refused'));
    await openApp();

    device.endpoint = 'https://push.example/rotated';
    await expect(lastHeal('u-1')).resolves.toBeNull();

    // Notifications switched off, or the account signed out of the device.
    device.endpoint = null;
    await expect(lastHeal('u-1')).resolves.toBeNull();
  });

  it('a failure noted by the app as it was before — no code, no address — is not one of this device\'s subscription', async () => {
    localStorage.setItem(HEAL_STAMP_KEY, JSON.stringify({ userId: 'u-1', endpoint: null, at: NOW, ok: false }));
    await expect(lastHeal('u-1')).resolves.toBeNull();

    localStorage.setItem(
      HEAL_STAMP_KEY,
      JSON.stringify({ userId: 'u-1', endpoint: 'https://push.example/first', at: NOW, ok: false }),
    );
    await expect(lastHeal('u-1')).resolves.toEqual({ ok: false, code: 'generic' });
  });
});

describe('noteHealed: the toggle registered the device itself', () => {
  it('is a look that succeeded: the next return to the app sends nothing', async () => {
    await noteHealed('u-1');

    expect(stamp()).toEqual({ userId: 'u-1', endpoint: 'https://push.example/first', at: NOW, ok: true });
    await openApp();
    await unlockAfter(MINUTE);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('takes back a failure that was noted', async () => {
    reconcile.mockRejectedValue(coded('keys_mismatch'));
    await openApp();

    // The toggle renewed the subscription: a new address, registered.
    device.endpoint = 'https://push.example/renewed';
    await noteHealed('u-1');

    await expect(lastHeal('u-1')).resolves.toEqual({ ok: true, code: '' });
  });

  it('notes nothing for a device without a subscription', async () => {
    device.endpoint = null;
    await noteHealed('u-1');
    expect(stamp()).toBeNull();
  });
});

describe('a device where notifications are off', () => {
  it('notes nothing: there was no write to space out', async () => {
    // What reconcilePushSubscription answers when it sent nothing.
    reconcile.mockResolvedValue(false);
    device.permission = 'default';
    await openApp();
    await unlockAfter(MINUTE);

    expect(stamp()).toBeNull();

    // Turned on from the profile a minute later: the next return writes.
    device.permission = 'granted';
    reconcile.mockResolvedValue(true);
    await unlockAfter(MINUTE);
    expect(stamp()).toMatchObject({ userId: 'u-1', ok: true });
  });
});
