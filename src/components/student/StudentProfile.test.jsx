import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '../../hooks/useTheme';

// jsdom doesn't implement HTMLDialogElement.showModal/close natively;
// without these stubs, RTL treats the dialog body as hidden so its labels
// fail to match. Same polyfill the Dialog component's own test uses.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal =
    HTMLDialogElement.prototype.showModal || vi.fn();
  HTMLDialogElement.prototype.close =
    HTMLDialogElement.prototype.close || vi.fn();
});

const mockNavigate = vi.fn();
const mockUpdateProfile = vi.fn(async () => ({ error: null }));
const mockUpdatePassword = vi.fn(async () => ({ error: null }));
const mockSignOut = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'u-1', email: 'ada@example.com' },
    profile: { id: 'u-1', role: 'student', full_name: 'Ada Lovelace' },
    signOut: mockSignOut,
    updateProfile: mockUpdateProfile,
    updatePassword: mockUpdatePassword,
  }),
}));

let mockCoach = { data: { id: 'c-1', full_name: 'Alan Turing' } };
let mockGoals = { data: [{ id: 'g-1', achieved: false, exercise: { name: 'Front Lever' }, notes: 'Hold 5s clean' }] };
let mockStats = { data: { sessionsCompleted: 12, setsDone: 87, totalVolumeKg: 4250 }, isLoading: false };

vi.mock('../../hooks/useStudents', () => ({
  useMyCoach: () => mockCoach,
}));

vi.mock('../../hooks/useGoals', () => ({
  useMyGoals: () => mockGoals,
}));

vi.mock('../../hooks/useStudentLifetimeStats', () => ({
  useStudentLifetimeStats: () => mockStats,
}));

// NotificationBell isn't mounted on Profile (no UserMenu), but the
// LanguageSelect and ThemeToggle pull from the i18n + theme contexts,
// which are wrapped by renderProfile below.

import StudentProfile from './StudentProfile';

function renderProfile() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ThemeProvider>
        <MemoryRouter>
          <StudentProfile />
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCoach = { data: { id: 'c-1', full_name: 'Alan Turing' } };
  mockGoals = { data: [{ id: 'g-1', achieved: false, exercise: { name: 'Front Lever' }, notes: 'Hold 5s clean' }] };
  mockStats = { data: { sessionsCompleted: 12, setsDone: 87, totalVolumeKg: 4250 }, isLoading: false };
});

describe('StudentProfile', () => {
  it('renders the display name', () => {
    renderProfile();
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
  });

  it('renders the coach card with name + Message link', () => {
    renderProfile();
    expect(screen.getByText('Your coach')).toBeInTheDocument();
    expect(screen.getByText('Alan Turing')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /^Message$/i });
    expect(link).toHaveAttribute('href', '/student/messages');
  });

  it('renders the lifetime totals from the stats hook', () => {
    renderProfile();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('87')).toBeInTheDocument();
    // 4250 -> 4,250 via toLocaleString
    expect(screen.getByText('4,250')).toBeInTheDocument();
  });

  it('shows a spinner while lifetime stats are loading', () => {
    mockStats = { data: undefined, isLoading: true };
    renderProfile();
    // Three stat tile values would be 0; instead we render a Spinner via role=status.
    expect(screen.queryByText('Sessions')).not.toBeInTheDocument();
  });

  it('surfaces the first non-achieved goal', () => {
    renderProfile();
    expect(screen.getByText('Front Lever')).toBeInTheDocument();
    expect(screen.getByText('Hold 5s clean')).toBeInTheDocument();
  });

  it('shows the empty-goal copy when goals are empty', () => {
    mockGoals = { data: [] };
    renderProfile();
    expect(screen.getByText(/no goals yet/i)).toBeInTheDocument();
  });

  it('renders the email and surfaces sign-out / change-password actions', () => {
    renderProfile();
    expect(screen.getByText('ada@example.com')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /change password/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument();
  });

  it('clicking sign out calls the auth signOut', async () => {
    const user = userEvent.setup();
    renderProfile();
    await user.click(screen.getByRole('button', { name: /sign out/i }));
    expect(mockSignOut).toHaveBeenCalled();
  });

  it('back button calls navigate(-1)', async () => {
    const user = userEvent.setup();
    renderProfile();
    await user.click(screen.getByRole('button', { name: /back/i }));
    expect(mockNavigate).toHaveBeenCalledWith(-1);
  });

  it('renaming via EditableText calls updateProfile with the new full_name', async () => {
    const user = userEvent.setup();
    renderProfile();
    // EditableText renders the value as a button until clicked.
    await user.click(screen.getByRole('button', { name: /edit your name/i }));
    const input = screen.getByRole('textbox');
    await user.clear(input);
    await user.type(input, 'Grace Hopper');
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(mockUpdateProfile).toHaveBeenCalledWith({ full_name: 'Grace Hopper' });
    });
  });

  // jsdom doesn't actually open the <dialog> via showModal (it's stubbed), so
  // RTL marks dialog descendants as inaccessible. Pass `{ hidden: true }` and
  // scope queries to the dialog itself.
  async function openPasswordDialog(user) {
    await user.click(screen.getByRole('button', { name: /change password/i }));
    const dialog = await screen.findByRole('dialog', { hidden: true });
    return within(dialog);
  }

  it('change-password dialog: rejects passwords shorter than 8 characters', async () => {
    const user = userEvent.setup();
    renderProfile();
    const dlg = await openPasswordDialog(user);
    const inputs = dlg.getAllByLabelText(/password/i, { selector: 'input' });
    await user.type(inputs[0], 'short');
    await user.type(inputs[1], 'short');
    await user.click(dlg.getByRole('button', { name: /^save$/i, hidden: true }));
    expect(await dlg.findByText(/at least 8 characters/i)).toBeInTheDocument();
    expect(mockUpdatePassword).not.toHaveBeenCalled();
  });

  it('change-password dialog: rejects mismatched passwords', async () => {
    const user = userEvent.setup();
    renderProfile();
    const dlg = await openPasswordDialog(user);
    const inputs = dlg.getAllByLabelText(/password/i, { selector: 'input' });
    await user.type(inputs[0], 'longenough1');
    await user.type(inputs[1], 'differentpw1');
    await user.click(dlg.getByRole('button', { name: /^save$/i, hidden: true }));
    expect(await dlg.findByText(/don.?t match/i)).toBeInTheDocument();
    expect(mockUpdatePassword).not.toHaveBeenCalled();
  });

  it('change-password dialog: success path calls updatePassword and shows confirmation', async () => {
    const user = userEvent.setup();
    renderProfile();
    const dlg = await openPasswordDialog(user);
    const inputs = dlg.getAllByLabelText(/password/i, { selector: 'input' });
    await user.type(inputs[0], 'longenough1');
    await user.type(inputs[1], 'longenough1');
    await user.click(dlg.getByRole('button', { name: /^save$/i, hidden: true }));
    await waitFor(() => {
      expect(mockUpdatePassword).toHaveBeenCalledWith('longenough1');
    });
    expect(await dlg.findByText(/password updated/i)).toBeInTheDocument();
  });
});
