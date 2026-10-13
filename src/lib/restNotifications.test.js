import { describe, it, expect, vi } from 'vitest';
import { closeRestNotifications, createRestNotificationSweep } from './restNotifications';
import { REST_TIMER_TAG } from './swHandlers';

// A registration with what the device shows right now.
function registrationWith(tags) {
  const shown = tags.map((tag) => {
    const notification = { tag };
    notification.close = vi.fn(() => shown.splice(shown.indexOf(notification), 1));
    return notification;
  });
  return {
    shown,
    getNotifications: vi.fn(async ({ tag } = {}) => shown.filter((n) => tag === undefined || n.tag === tag)),
  };
}

const containerOf = (registration) => ({ getRegistration: vi.fn(async () => registration) });

describe('closeRestNotifications — the page closes a "Rest done" that is over', () => {
  it('closes the notifications of the rest timer and no other', async () => {
    const registration = registrationWith([REST_TIMER_TAG, 'chat-c1']);
    const container = containerOf(registration);

    expect(await closeRestNotifications({ container, permission: 'granted' })).toBe(1);

    expect(registration.getNotifications).toHaveBeenCalledWith({ tag: REST_TIMER_TAG });
    expect(registration.shown.map((n) => n.tag)).toEqual(['chat-c1']);
  });

  it.each([['default'], ['denied'], ['unsupported']])(
    'asks nothing where notifications are not allowed (%s)',
    async (permission) => {
      const container = containerOf(registrationWith([REST_TIMER_TAG]));
      expect(await closeRestNotifications({ container, permission })).toBe(0);
      expect(container.getRegistration).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['a browser without service workers', undefined],
    ['a page no worker is registered for', containerOf(undefined)],
    [
      'a registration that cannot be read',
      {
        getRegistration: async () => {
          throw new Error('SecurityError');
        },
      },
    ],
    ['a registration that cannot list its notifications', containerOf({})],
  ])('answers 0 for %s, and does not throw', async (_name, container) => {
    expect(await closeRestNotifications({ container, permission: 'granted' })).toBe(0);
  });

  it('works with what this environment has (no service worker, no Notification)', async () => {
    await expect(closeRestNotifications()).resolves.toBe(0);
  });
});

// A document and a window, as far as the watcher goes.
function page(visibilityState = 'visible') {
  const doc = new EventTarget();
  doc.visibilityState = visibilityState;
  const win = new EventTarget();
  return {
    doc,
    win,
    show() {
      doc.visibilityState = 'visible';
      doc.dispatchEvent(new Event('visibilitychange'));
    },
    hide() {
      doc.visibilityState = 'hidden';
      doc.dispatchEvent(new Event('visibilitychange'));
    },
    focus() {
      win.dispatchEvent(new Event('focus'));
    },
  };
}

// Let a sweep that was started finish.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the watcher — each time the app comes back in front', () => {
  it('sweeps once when it is installed on a page that is visible: the app was just opened', async () => {
    const close = vi.fn(async () => 1);
    const { doc, win } = page('visible');
    createRestNotificationSweep({ close }).install(doc, win);
    await settle();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('does nothing on a page that is loaded in the background, until it is shown', async () => {
    const close = vi.fn(async () => 0);
    const p = page('hidden');
    createRestNotificationSweep({ close }).install(p.doc, p.win);
    await settle();
    expect(close).not.toHaveBeenCalled();

    p.show();
    await settle();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('sweeps when the app returns, not when it leaves', async () => {
    const close = vi.fn(async () => 0);
    const p = page('visible');
    createRestNotificationSweep({ close }).install(p.doc, p.win);
    await settle();
    close.mockClear();

    p.hide();
    await settle();
    expect(close).not.toHaveBeenCalled();

    p.show();
    await settle();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('sweeps when a window that stayed visible gets the focus back', async () => {
    const close = vi.fn(async () => 0);
    const p = page('visible');
    createRestNotificationSweep({ close }).install(p.doc, p.win);
    await settle();
    close.mockClear();

    p.focus();
    await settle();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('one return that fires both events is one sweep', async () => {
    const close = vi.fn(async () => 0);
    const p = page('hidden');
    createRestNotificationSweep({ close }).install(p.doc, p.win);

    p.show();
    p.focus();
    await settle();
    expect(close).toHaveBeenCalledTimes(1);

    // And the next return sweeps again.
    p.hide();
    p.show();
    await settle();
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('a sweep that fails is not the last one', async () => {
    const close = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(0);
    const p = page('visible');
    createRestNotificationSweep({ close }).install(p.doc, p.win);
    await settle();

    p.focus();
    await settle();
    expect(close).toHaveBeenCalledTimes(2);
  });

  it('is installed once, and stops listening when it is removed', async () => {
    const close = vi.fn(async () => 0);
    const p = page('visible');
    const sweep = createRestNotificationSweep({ close });
    sweep.install(p.doc, p.win);
    sweep.install(p.doc, p.win);
    await settle();
    expect(close).toHaveBeenCalledTimes(1);

    sweep.uninstall();
    p.hide();
    p.show();
    p.focus();
    await settle();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
