import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// The library: what the browser and the database say. `pushErrorKey` and the
// list of codes are the real ones — which sentence a code reads is the point.
const lib = vi.hoisted(() => ({
  supported: true,
  permission: 'granted',
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
import { getMessage } from '../lib/i18n';

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
  mockUser = { id: 'u-1' };
  Object.assign(lib, {
    supported: true,
    permission: 'granted',
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

    expect(view.result.current).toMatchObject({ pending: false, errorKey: 'pushIdentity.offline' });
  });
});
