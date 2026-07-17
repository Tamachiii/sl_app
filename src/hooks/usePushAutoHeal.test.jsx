import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const reconcile = vi.fn();
vi.mock('../lib/pushNotifications', () => ({
  reconcilePushSubscription: (...args) => reconcile(...args),
}));

let mockUser = { id: 'u-1' };
vi.mock('./useAuth', () => ({
  useAuth: () => ({ user: mockUser }),
}));

import { usePushAutoHeal } from './usePushAutoHeal';

beforeEach(() => {
  reconcile.mockReset();
  reconcile.mockResolvedValue(true);
  mockUser = { id: 'u-1' };
});

describe('usePushAutoHeal', () => {
  it('reconciles once on mount for the signed-in user', () => {
    renderHook(() => usePushAutoHeal());
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledWith('u-1');
  });

  it('reconciles again when the tab becomes visible', () => {
    renderHook(() => usePushAutoHeal());
    reconcile.mockClear();

    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(reconcile).toHaveBeenCalledWith('u-1');
  });

  it('does not reconcile while the tab is hidden', () => {
    renderHook(() => usePushAutoHeal());
    reconcile.mockClear();

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('no-ops when there is no signed-in user', () => {
    mockUser = null;
    renderHook(() => usePushAutoHeal());
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('swallows a rejected reconcile (best-effort)', async () => {
    reconcile.mockRejectedValue(new Error('network'));
    // Should not throw during render/effect.
    expect(() => renderHook(() => usePushAutoHeal())).not.toThrow();
  });

  it('removes the visibility listener on unmount', () => {
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    const { unmount } = renderHook(() => usePushAutoHeal());
    unmount();
    expect(removeSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    removeSpy.mockRestore();
  });
});
