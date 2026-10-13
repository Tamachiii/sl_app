// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { dismissToast, getToasts, pushToast, subscribeToasts } from './toast';

// The store is module state: every test starts from an empty one.
beforeEach(() => {
  for (const toast of getToasts()) dismissToast(toast.id);
});

describe('toast store', () => {
  it('shows a toast as an error unless told otherwise', () => {
    const id = pushToast('errors.generic');
    expect(getToasts()).toEqual([{ id, message: 'errors.generic', kind: 'error' }]);
    const info = pushToast('Saved', { kind: 'info' });
    expect(getToasts()).toEqual([
      { id, message: 'errors.generic', kind: 'error' },
      { id: info, message: 'Saved', kind: 'info' },
    ]);
  });

  it('ignores an empty message', () => {
    expect(pushToast('')).toBeNull();
    expect(pushToast(null)).toBeNull();
    expect(getToasts()).toEqual([]);
  });

  it('shows the same message of the same kind once', () => {
    const first = pushToast('errors.generic');
    expect(pushToast('errors.generic')).toBe(first);
    expect(pushToast('errors.generic', { kind: 'error' })).toBe(first);
    expect(getToasts()).toHaveLength(1);
    // Another kind is another toast.
    expect(pushToast('errors.generic', { kind: 'info' })).not.toBe(first);
    expect(getToasts()).toHaveLength(2);
  });

  it('removes a toast by id and leaves the others', () => {
    const a = pushToast('a');
    const b = pushToast('b');
    dismissToast(a);
    expect(getToasts().map((toast) => toast.id)).toEqual([b]);
    dismissToast(a);
    dismissToast(9999);
    expect(getToasts().map((toast) => toast.id)).toEqual([b]);
  });

  it('tells its subscribers, with a new list each time', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToasts(listener);
    const before = getToasts();
    const id = pushToast('a');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(getToasts()).not.toBe(before);
    // A merged toast and an unknown id change nothing, and say nothing.
    pushToast('a');
    dismissToast(9999);
    expect(listener).toHaveBeenCalledTimes(1);
    dismissToast(id);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    pushToast('b');
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('a toast with an action', () => {
  it('carries the label and the callback', () => {
    const onClick = vi.fn();
    const id = pushToast('Set removed', { kind: 'info', action: { label: 'uiSharedHelpers.undo', onClick } });
    expect(getToasts()).toEqual([
      { id, message: 'Set removed', kind: 'info', action: { label: 'uiSharedHelpers.undo', onClick } },
    ]);
    // Pushing calls nothing: the action is the person's to take.
    expect(onClick).not.toHaveBeenCalled();
  });

  it('is never merged with a toast that says the same', () => {
    // Two sets removed in a row: one message, two different ways back.
    const undoFirst = vi.fn();
    const undoSecond = vi.fn();
    const first = pushToast('Set removed', { kind: 'info', action: { label: 'Undo', onClick: undoFirst } });
    const second = pushToast('Set removed', { kind: 'info', action: { label: 'Undo', onClick: undoSecond } });
    expect(second).not.toBe(first);
    expect(getToasts().map((toast) => toast.action.onClick)).toEqual([undoFirst, undoSecond]);
  });

  it('is not merged into a plain toast, nor a plain toast into it', () => {
    const plain = pushToast('Set removed', { kind: 'info' });
    const withAction = pushToast('Set removed', { kind: 'info', action: { label: 'Undo', onClick: () => {} } });
    expect(withAction).not.toBe(plain);
    // The plain one still merges with the plain one, not with the other.
    expect(pushToast('Set removed', { kind: 'info' })).toBe(plain);
    expect(getToasts()).toHaveLength(2);
    dismissToast(plain);
    const again = pushToast('Set removed', { kind: 'info' });
    expect(again).not.toBe(withAction);
    expect(getToasts()).toHaveLength(2);
  });

  it('is a plain toast when the action has no label or nothing to call', () => {
    const first = pushToast('a', { action: { label: 'Undo' } });
    pushToast('b', { action: { onClick: () => {} } });
    pushToast('c', { action: null });
    expect(getToasts().every((toast) => !('action' in toast))).toBe(true);
    // …and merges like one.
    expect(pushToast('a', { action: { label: 'Undo', onClick: 'not a function' } })).toBe(first);
  });

  it('keeps the three newest on screen', () => {
    const ids = [1, 2, 3, 4, 5].map((n) =>
      pushToast('Set removed', { kind: 'info', action: { label: 'Undo', onClick: () => n } }),
    );
    expect(getToasts().map((toast) => toast.id)).toEqual(ids.slice(-3));
    expect(getToasts().map((toast) => toast.action.onClick())).toEqual([3, 4, 5]);
  });
});
