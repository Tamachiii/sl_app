import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
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

    expect(menu).toHaveClass('absolute', 'right-0', 'w-[340px]', 'max-w-[calc(100vw-2rem)]');
  });

  it('the avatar is a 44px target, like the bell beside it', () => {
    render(
      <MemoryRouter>
        <UserMenu fullName="Alan Turing" {...props} />
      </MemoryRouter>,
    );
    // The Parc round icon button, held to 44px by src/test/hitTargets.test.js;
    // the bell is one too. No size utility beside it shrinks it again.
    expect(avatar()).toHaveClass('pk-icon-btn');
    expect(screen.getByRole('button', { name: /open notifications/i })).toHaveClass('pk-icon-btn');
    expect(avatar().className).not.toMatch(/(^|\s)(w|h|size)-\d/);
    // It shows the initials.
    expect(avatar()).toHaveTextContent('AT');
  });
});

// The coach's avatar opens the account menu: the language, then "Sign out" in
// red. The athlete's avatar is a link to the profile, where both live.
describe('the account menu of a coach', () => {
  function openMenu(onSignOut = vi.fn()) {
    render(
      <MemoryRouter>
        <UserMenu fullName="Alan Turing" onSignOut={onSignOut} />
      </MemoryRouter>,
    );
    return userEvent.click(screen.getByRole('button', { name: /open user menu/i }));
  }

  it('offers the language as a group named "Language", the one in use pressed', async () => {
    await openMenu();
    const menu = screen.getByRole('menu', { name: /open user menu/i });
    const language = within(menu).getByRole('group', { name: 'Language' });
    expect(within(language).getAllByRole('button').map((b) => b.textContent)).toEqual(['English', 'Français', 'Deutsch']);
    expect(within(language).getByRole('button', { name: 'English' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('signs out from the menu, in red, and closes it', async () => {
    const onSignOut = vi.fn();
    await openMenu(onSignOut);
    const signOut = screen.getByRole('menuitem', { name: 'Sign out' });
    expect(signOut).toHaveClass('text-red');
    await userEvent.click(signOut);
    expect(onSignOut).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu', { name: /open user menu/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /open user menu/i })).toHaveAttribute('aria-expanded', 'false');
  });

  it('closes on Escape', async () => {
    await openMenu();
    expect(screen.getByRole('button', { name: /open user menu/i })).toHaveAttribute('aria-expanded', 'true');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu', { name: /open user menu/i })).not.toBeInTheDocument();
  });

  it('is not drawn for an athlete, whose avatar leads to the profile', () => {
    render(
      <MemoryRouter>
        <UserMenu fullName="Alan Turing" profileHref="/student/profile" />
      </MemoryRouter>,
    );
    expect(screen.getByRole('link', { name: /open your profile/i })).toHaveAttribute('href', '/student/profile');
    expect(screen.queryByRole('button', { name: /open user menu/i })).not.toBeInTheDocument();
  });
});
