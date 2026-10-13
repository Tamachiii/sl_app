import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// The library: what the browser and the database say. `pushErrorKey` and the
// list of codes are the real ones — which sentence a code reads is the point.
const lib = vi.hoisted(() => ({
  supported: true,
  permission: 'granted',
  // The address of the subscription the browser holds; null for none.
  endpoint: 'https://fcm.googleapis.com/fcm/send/ep-1',
  isPushEnabled: null,
  enablePush: null,
  disablePush: null,
}));
// The real library is loaded for its codes only: it never reaches a client.
vi.mock('../lib/supabase', () => ({ supabase: {} }));
vi.mock('../lib/pushNotifications', async () => {
  const actual = await vi.importActual('../lib/pushNotifications');
  return {
    pushErrorKey: actual.pushErrorKey,
    PUSH_ERROR_KEYS: actual.PUSH_ERROR_KEYS,
    isPushSupported: () => lib.supported,
    pushPermission: () => lib.permission,
    getActivePushSubscription: async () => (lib.endpoint ? { endpoint: lib.endpoint } : null),
    // usePushAutoHeal's own requests: the hook under test never makes them.
    reconcilePushSubscription: vi.fn(),
    resumePushSubscription: vi.fn(),
    isPushResumable: () => false,
    isPushEnabled: (...args) => lib.isPushEnabled(...args),
    enablePush: (...args) => lib.enablePush(...args),
    disablePush: (...args) => lib.disablePush(...args),
  };
});

let mockUser = { id: 'u-1' };
vi.mock('./useAuth', () => ({
  useAuth: () => ({ user: mockUser }),
}));

import { usePushSubscription } from './usePushSubscription';
import { HEAL_STAMP_KEY } from './usePushAutoHeal';
import { getMessage } from '../lib/i18n';

const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/ep-1';
// The note `usePushAutoHeal` leaves on the device after each look.
const lookNoted = (note) =>
  localStorage.setItem(HEAL_STAMP_KEY, JSON.stringify({ userId: 'u-1', endpoint: ENDPOINT, at: Date.now(), ...note }));
const noteOnDevice = () => JSON.parse(localStorage.getItem(HEAL_STAMP_KEY));

// An error of lib/pushNotifications.js.
function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

// The toggle on screen, once it has asked whether this device is registered.
async function openToggle() {
  const view = renderHook(() => usePushSubscription());
  await waitFor(() => expect(view.result.current.pending).toBe(false));
  return view;
}
const tap = (view, action) =>
  act(async () => {
    await view.result.current[action]();
  });

beforeEach(() => {
  localStorage.removeItem(HEAL_STAMP_KEY);
  mockUser = { id: 'u-1' };
  Object.assign(lib, {
    supported: true,
    permission: 'granted',
    endpoint: ENDPOINT,
    isPushEnabled: vi.fn().mockResolvedValue(false),
    enablePush: vi.fn().mockResolvedValue({ subscription_id: 'row-1', outcome: 'created' }),
    disablePush: vi.fn().mockResolvedValue(undefined),
  });
});

describe('usePushSubscription', () => {
  it('says whether this device is registered for the signed-in account', async () => {
    lib.isPushEnabled.mockResolvedValue(true);
    const view = await openToggle();

    expect(lib.isPushEnabled).toHaveBeenCalledWith('u-1');
    expect(view.result.current).toMatchObject({ supported: true, enabled: true, errorCode: '', errorKey: '' });
  });

  it('switches on, and off', async () => {
    const view = await openToggle();

    await tap(view, 'enable');
    expect(lib.enablePush).toHaveBeenCalledWith('u-1');
    expect(view.result.current).toMatchObject({ enabled: true, errorKey: '' });

    await tap(view, 'disable');
    expect(lib.disablePush).toHaveBeenCalledWith('u-1');
    expect(view.result.current).toMatchObject({ enabled: false, errorKey: '' });
  });

  it('asks nothing on a device without push', async () => {
    lib.supported = false;
    const view = await openToggle();

    expect(lib.isPushEnabled).not.toHaveBeenCalled();
    expect(view.result.current).toMatchObject({ supported: false, enabled: false, permission: 'denied' });
  });
});

// The toggles printed `common.pushError.<whatever was thrown>`: the SQLSTATE of
// a refusal by the database has no sentence, and the key itself was on screen.
describe('what stopped the toggle is said, in words the dictionaries have', () => {
  it('a push service the database does not accept', async () => {
    lib.enablePush.mockRejectedValue(coded('endpoint_refused'));
    const view = await openToggle();

    await tap(view, 'enable');

    expect(view.result.current).toMatchObject({
      enabled: false,
      errorCode: 'endpoint_refused',
      errorKey: 'pushIdentity.endpoint_refused',
    });
    expect(getMessage('en', view.result.current.errorKey)).toMatch(/isn’t supported/);
  });

  it('a request that got no answer', async () => {
    lib.enablePush.mockRejectedValue(coded('offline'));
    const view = await openToggle();

    await tap(view, 'enable');

    expect(view.result.current).toMatchObject({ enabled: false, errorKey: 'pushIdentity.offline' });
  });

  it('a code of before keeps its sentence', async () => {
    lib.enablePush.mockRejectedValue(coded('permission_denied'));
    const view = await openToggle();

    await tap(view, 'enable');

    expect(view.result.current.errorKey).toBe('common.pushError.permission_denied');
  });

  it('something that is not a code of the library — an SQLSTATE, the number of a DOMException, nothing at all', async () => {
    const view = await openToggle();

    for (const thrown of [coded('42501'), coded(20), new Error('boom'), null]) {
      lib.enablePush.mockRejectedValue(thrown);
      await tap(view, 'enable');
      expect(view.result.current.errorKey).toBe('common.pushError.generic');
    }
  });

  it('the next tap starts from no error', async () => {
    lib.enablePush.mockRejectedValueOnce(coded('offline'));
    const view = await openToggle();
    await tap(view, 'enable');
    expect(view.result.current.errorKey).not.toBe('');

    await tap(view, 'enable');

    expect(view.result.current).toMatchObject({ enabled: true, errorCode: '', errorKey: '' });
  });

  it('a switch-off that failed leaves the toggle on: the device still receives', async () => {
    lib.isPushEnabled.mockResolvedValue(true);
    lib.disablePush.mockRejectedValue(coded('offline'));
    const view = await openToggle();

    await tap(view, 'disable');

    expect(view.result.current).toMatchObject({ enabled: true, errorKey: 'pushIdentity.offline' });
  });

  it('a database that could not be asked whether the device is registered: the toggle says so', async () => {
    lib.isPushEnabled.mockRejectedValue(coded('offline'));
    const view = await openToggle();

    expect(view.result.current).toMatchObject({ pending: false, enabled: false, errorKey: 'pushIdentity.offline' });
  });
});

// The look of usePushAutoHeal runs in the background, at launch and at each
// return to the app. What it found is on the device (`sl_push_heal`).
describe('what the last look in the background found', () => {
  it('a device the database refuses for good: the toggle prints why, whatever it says of the row', async () => {
    lookNoted({ ok: false, code: 'endpoint_refused' });
    // A row written before the database held addresses to the push services.
    lib.isPushEnabled.mockResolvedValue(true);

    const view = await openToggle();

    expect(view.result.current).toMatchObject({ enabled: true, errorKey: 'pushIdentity.endpoint_refused' });
  });

  it('a look that merely got no answer is not news: it is made again', async () => {
    lookNoted({ ok: false, code: 'offline' });
    lib.isPushEnabled.mockResolvedValue(true);

    const view = await openToggle();

    expect(view.result.current).toMatchObject({ enabled: true, errorKey: '' });
  });

  it('nor is a failure about another account, or about an address the device no longer holds', async () => {
    lookNoted({ ok: false, code: 'endpoint_refused', userId: 'u-2' });
    expect((await openToggle()).result.current.errorKey).toBe('');

    lookNoted({ ok: false, code: 'endpoint_refused', endpoint: 'https://fcm.googleapis.com/fcm/send/before' });
    expect((await openToggle()).result.current.errorKey).toBe('');
  });

  // An athlete opens the profile page in a gym without signal.
  it('the database cannot be asked: a device that registered itself is shown as on, with the reason nothing can be changed', async () => {
    lookNoted({ ok: true });
    lib.isPushEnabled.mockRejectedValue(coded('offline'));

    const view = await openToggle();

    expect(view.result.current).toMatchObject({ enabled: true, errorKey: 'pushIdentity.offline' });
  });

  it('… and one whose last look failed is not', async () => {
    lookNoted({ ok: false, code: 'keys_mismatch' });
    lib.isPushEnabled.mockRejectedValue(coded('offline'));

    const view = await openToggle();

    expect(view.result.current).toMatchObject({ enabled: false, errorKey: 'pushIdentity.offline' });
  });

  it('the database answers: its answer is the toggle, whatever the device remembers', async () => {
    lookNoted({ ok: true });
    lib.isPushEnabled.mockResolvedValue(false);

    const view = await openToggle();

    expect(view.result.current).toMatchObject({ enabled: false, errorKey: '' });
  });

  it('switching on is written down as a look that succeeded', async () => {
    lookNoted({ ok: false, code: 'keys_mismatch' });
    const view = await openToggle();

    await tap(view, 'enable');

    expect(noteOnDevice()).toMatchObject({ userId: 'u-1', endpoint: ENDPOINT, ok: true });
    expect(noteOnDevice().code).toBeUndefined();
  });

  it('a switch-on that failed is not', async () => {
    lib.enablePush.mockRejectedValue(coded('offline'));
    const view = await openToggle();

    await tap(view, 'enable');

    expect(noteOnDevice()).toBeNull();
  });
});
