import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// The athlete's notification toggle, on the profile page: what it prints when
// the hook says something stopped it. The page around it is the one of
// StudentProfile.test.jsx.
let mockPush;
vi.mock('../../hooks/usePushSubscription', () => ({
  usePushSubscription: () => mockPush,
}));

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'u-1', email: 'ada@example.com' },
    profile: { id: 'u-1', role: 'student', full_name: 'Ada Lovelace' },
    signIn: vi.fn(async () => ({ error: null })),
    signOut: vi.fn(),
    updateProfile: vi.fn(async () => ({ error: null })),
    updatePassword: vi.fn(async () => ({ error: null })),
  }),
}));
vi.mock('../../hooks/useStudents', () => ({
  useMyCoach: () => ({ data: { id: 'c-1', full_name: 'Alan Turing' } }),
}));
vi.mock('../../hooks/useGoals', () => ({
  useMyGoals: () => ({ data: [] }),
}));
vi.mock('../../hooks/useStudentLifetimeStats', () => ({
  useStudentLifetimeStats: () => ({ data: { sessionsCompleted: 0, setsDone: 0, totalVolumeKg: 0 }, isLoading: false }),
}));
vi.mock('../../hooks/useBodyweight', () => ({
  useBodyweightLogs: () => ({ data: [], isLoading: false }),
  useLogBodyweight: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('../../hooks/useStudentRecords', () => ({
  useStudentRecords: () => ({ data: [], isLoading: false }),
}));
vi.mock('../../hooks/useOnlineStatus', () => ({
  useOnlineStatus: () => true,
}));

import StudentProfile from './StudentProfile';
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

// The "Notifications" section of the page.
function notifications() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <StudentProfile />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return within(screen.getByRole('region', { name: 'Notifications' }));
}

beforeEach(() => {
  mockPush = toggle();
});

describe('the notification toggle of the profile page', () => {
  it('prints the sentence of the key the hook hands it — a push service the database refuses', () => {
    mockPush = toggle({ errorCode: 'endpoint_refused', errorKey: 'pushIdentity.endpoint_refused' });

    expect(notifications().getByText(en.pushIdentity.endpoint_refused)).toBeInTheDocument();
  });

  it('a device without a network — and the toggle still says what the device is: on', () => {
    mockPush = toggle({ enabled: true, errorCode: 'offline', errorKey: 'pushIdentity.offline' });
    const section = notifications();

    expect(section.getByText(en.pushIdentity.offline)).toBeInTheDocument();
    expect(section.getByRole('button', { name: 'Disable' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('never a key: the code alone is not what it reads', () => {
    // What the hook returns for an SQLSTATE: the key of "generic".
    mockPush = toggle({ errorCode: '42501', errorKey: 'common.pushError.generic' });
    const section = notifications();

    expect(section.getByText('Couldn’t update notifications. Try again.')).toBeInTheDocument();
    expect(section.queryByText(/pushError/)).not.toBeInTheDocument();
  });

  it('without an error, the hint of the state it is in', () => {
    const section = notifications();

    expect(section.getByText(/Get a push when your rest timer finishes/)).toBeInTheDocument();
  });
});
