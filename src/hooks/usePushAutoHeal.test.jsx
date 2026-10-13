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

import { usePushAutoHeal, HEAL_EVERY_MS, HEAL_RETRY_MS, HEAL_STAMP_KEY } from './usePushAutoHeal';

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
    expect(stamp()).toEqual({ userId: 'u-1', endpoint: null, at: NOW, ok: false });

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
