import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

// The bell's popover inside the real UserMenu: what it is positioned
// against. jsdom lays nothing out, so the test holds the classes the
// position comes from — review L30: anchored to the bell, the 320px popover
// ran off the left edge of a phone below about 390px.
vi.mock('../../hooks/useNotifications', async () => {
  const actual = await vi.importActual('../../hooks/useNotifications');
  return {
    ...actual,
    useNotifications: () => ({ data: [], isLoading: false }),
    useUnreadNotificationCount: () => ({ data: 0 }),
    useMarkNotificationRead: () => ({ mutate: vi.fn(), isPending: false }),
    useMarkAllNotificationsRead: () => ({ mutate: vi.fn(), isPending: false }),
  };
});
vi.mock('../../hooks/usePushSubscription', () => ({
  usePushSubscription: () => ({ supported: false }),
}));
vi.mock('../../lib/preload', () => ({ preloadLogin: () => {} }));

import UserMenu from './UserMenu';

const modes = [
  ['an athlete, whose avatar is a link', { profileHref: '/student/profile' }, () => screen.getByRole('link', { name: /open your profile/i })],
  ['a coach, whose avatar opens a menu', { onSignOut: () => {} }, () => screen.getByRole('button', { name: /open user menu/i })],
];

describe.each(modes)('the notification popover of %s', (_, props, avatar) => {
  async function openBell() {
    const view = render(
      <MemoryRouter>
        <UserMenu fullName="Alan Turing" {...props} />
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByRole('button', { name: /open notifications/i }));
    return { group: view.container.firstChild, menu: screen.getByRole('menu', { name: /notifications/i }) };
  }

  it('is positioned against the group of the bell and the avatar, whose right edge is the page padding', async () => {
    const { group, menu } = await openBell();

    expect(menu.closest('.relative')).toBe(group);
    expect(group).toContainElement(screen.getByRole('button', { name: /open notifications/i }));
    expect(group).toContainElement(avatar());
  });

  it('hangs from that right edge and is never wider than the screen less its padding', async () => {
    const { menu } = await openBell();

    expect(menu).toHaveClass('absolute', 'right-0', 'w-[320px]', 'max-w-[calc(100vw-2rem)]');
  });
});
