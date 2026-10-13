import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

// The coach's notification toggle, in the avatar menu: what it prints when
// the hook says something stopped it.
let mockPush;
vi.mock('../../hooks/usePushSubscription', () => ({
  usePushSubscription: () => mockPush,
}));
vi.mock('../notifications/NotificationBell', () => ({ default: () => null }));

import UserMenu from './UserMenu';
import en from '../../lib/i18n/fragments/core-push-identity.en';

const toggle = (state = {}) => ({
  supported: true,
  enabled: false,
  permission: 'granted',
  pending: false,
  errorCode: '',
  errorKey: '',
  enable: vi.fn(),
  disable: vi.fn(),
  ...state,
});

async function openMenu() {
  render(
    <MemoryRouter>
      <UserMenu fullName="Alan Turing" onSignOut={() => {}} />
    </MemoryRouter>,
  );
  await userEvent.click(screen.getByRole('button', { name: /open user menu/i }));
}

beforeEach(() => {
  mockPush = toggle();
});

describe('the notification toggle of the avatar menu', () => {
  it('prints the sentence of the key the hook hands it — a push service the database refuses', async () => {
    mockPush = toggle({ errorCode: 'endpoint_refused', errorKey: 'pushIdentity.endpoint_refused' });
    await openMenu();

    expect(screen.getByText(en.pushIdentity.endpoint_refused)).toBeInTheDocument();
  });

  it('a device without a network', async () => {
    mockPush = toggle({ errorCode: 'offline', errorKey: 'pushIdentity.offline' });
    await openMenu();

    expect(screen.getByText(en.pushIdentity.offline)).toBeInTheDocument();
  });

  it('never a key: the code alone is not what it reads', async () => {
    // What the hook returns for an SQLSTATE: the key of "generic".
    mockPush = toggle({ errorCode: '42501', errorKey: 'common.pushError.generic' });
    await openMenu();

    expect(screen.getByText('Couldn’t update notifications. Try again.')).toBeInTheDocument();
    expect(screen.queryByText(/pushError/)).not.toBeInTheDocument();
  });

  it('without an error, the hint of the state it is in', async () => {
    await openMenu();

    expect(screen.queryByText(en.pushIdentity.offline)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /enable/i })).toHaveAttribute('aria-pressed', 'false');
  });
});
