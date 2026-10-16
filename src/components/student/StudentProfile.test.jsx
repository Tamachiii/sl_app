import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
const mockSignIn = vi.fn(async () => ({ error: null }));
const mockSignOut = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'u-1', email: 'ada@example.com' },
    profile: { id: 'u-1', role: 'student', full_name: 'Ada Lovelace' },
    signIn: mockSignIn,
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

// NotificationBell isn't mounted on Profile (no UserMenu), but the
// LanguageSelect and ThemeToggle pull from the i18n + theme contexts,
// which are wrapped by renderProfile below.

import StudentProfile from './StudentProfile';
import recheck from '../../lib/i18n/fragments/profile-password-recheck.en';

// `entries`: the tab's history, the profile last. Left out, the profile is the
// first entry of the tab — a link, a cold start of the installed app.
function renderProfile({ entries } = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ThemeProvider>
        <MemoryRouter
          initialEntries={entries}
          initialIndex={entries ? entries.length - 1 : undefined}
        >
          <StudentProfile />
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSignIn.mockImplementation(async () => ({ error: null }));
  mockUpdatePassword.mockImplementation(async () => ({ error: null }));
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

  it('shows a count of in-progress goals (not a single featured goal)', () => {
    // Mock has one non-achieved goal; with another non-achieved goal added,
    // the tile reads "2".
    mockGoals = {
      data: [
        { id: 'g-1', achieved: false, exercise: { name: 'Front Lever' } },
        { id: 'g-2', achieved: false, exercise: { name: 'Pull Up' } },
        { id: 'g-3', achieved: true, exercise: { name: 'Muscle Up' } },
      ],
    };
    renderProfile();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText(/2 in progress/i)).toBeInTheDocument();
    // The tile is a tap-through to the Goals page.
    const link = screen.getByRole('link', { name: /VIEW ALL/i });
    expect(link).toHaveAttribute('href', '/student/goals');
    // No specific goal name should be surfaced — the tile is a summary.
    expect(screen.queryByText('Front Lever')).not.toBeInTheDocument();
    expect(screen.queryByText('Pull Up')).not.toBeInTheDocument();
  });

  it('shows the empty-goals copy when there are no goals at all', () => {
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

  // L31. `navigate(-1)` on the first entry of the tab does nothing in the
  // installed app and leaves the app in a browser.
  it('back button goes one step back when the app has a page behind it', async () => {
    const user = userEvent.setup();
    renderProfile({ entries: ['/student/stats', '/student/profile'] });
    await user.click(screen.getByRole('button', { name: /back/i }));
    expect(mockNavigate).toHaveBeenCalledWith(-1);
  });

  it('back button on the first entry of the tab goes to the athlete\'s home, in place of the profile', async () => {
    const user = userEvent.setup();
    renderProfile({ entries: ['/student/profile'] });
    await user.click(screen.getByRole('button', { name: /back/i }));
    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('/student', { replace: true });
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

  // The three fields by their labels, any of them left out stays empty.
  async function fillPasswordForm(user, dlg, { current, next, confirm }) {
    if (current) await user.type(dlg.getByLabelText('Current password', { selector: 'input' }), current);
    if (next) await user.type(dlg.getByLabelText('New password', { selector: 'input' }), next);
    if (confirm) await user.type(dlg.getByLabelText('Confirm new password', { selector: 'input' }), confirm);
  }

  function saveButton(dlg) {
    return dlg.getByRole('button', { name: /^(save|saving…?)$/i, hidden: true });
  }

  // What auth-js hands back for a wrong password (GoTrue's `invalid_credentials`).
  const wrongPassword = () =>
    Object.assign(new Error('Invalid login credentials'), {
      name: 'AuthApiError',
      status: 400,
      code: 'invalid_credentials',
    });

  it('change-password dialog: asks for the current password first, as a current-password field', async () => {
    const user = userEvent.setup();
    renderProfile();
    const dlg = await openPasswordDialog(user);
    const inputs = dlg.getAllByLabelText(/password/i, { selector: 'input' });
    expect(inputs).toHaveLength(3);
    expect(inputs[0]).toBe(dlg.getByLabelText('Current password', { selector: 'input' }));
    expect(inputs[0]).toHaveAttribute('type', 'password');
    expect(inputs[0]).toHaveAttribute('autocomplete', 'current-password');
  });

  it('change-password dialog: rejects passwords shorter than 8 characters, without a sign-in', async () => {
    const user = userEvent.setup();
    renderProfile();
    const dlg = await openPasswordDialog(user);
    await fillPasswordForm(user, dlg, { current: 'oldpassword1', next: 'short', confirm: 'short' });
    await user.click(saveButton(dlg));
    expect(await dlg.findByText(/at least 8 characters/i)).toBeInTheDocument();
    expect(mockSignIn).not.toHaveBeenCalled();
    expect(mockUpdatePassword).not.toHaveBeenCalled();
  });

  it('change-password dialog: rejects mismatched passwords, without a sign-in', async () => {
    const user = userEvent.setup();
    renderProfile();
    const dlg = await openPasswordDialog(user);
    await fillPasswordForm(user, dlg, { current: 'oldpassword1', next: 'longenough1', confirm: 'differentpw1' });
    await user.click(saveButton(dlg));
    expect(await dlg.findByText(/don.?t match/i)).toBeInTheDocument();
    expect(mockSignIn).not.toHaveBeenCalled();
    expect(mockUpdatePassword).not.toHaveBeenCalled();
  });

  it('change-password dialog: without the current password nothing is sent', async () => {
    const user = userEvent.setup();
    renderProfile();
    const dlg = await openPasswordDialog(user);
    await fillPasswordForm(user, dlg, { next: 'longenough1', confirm: 'longenough1' });
    await user.click(saveButton(dlg));
    // The field is `required`: a browser stops the submit itself, the dialog
    // says so when one does not.
    expect(mockSignIn).not.toHaveBeenCalled();
    expect(mockUpdatePassword).not.toHaveBeenCalled();
  });

  it('change-password dialog: a wrong current password is refused and the password is not changed', async () => {
    mockSignIn.mockImplementation(async () => ({ error: wrongPassword() }));
    const user = userEvent.setup();
    renderProfile();
    const dlg = await openPasswordDialog(user);
    await fillPasswordForm(user, dlg, { current: 'notmypassword', next: 'longenough1', confirm: 'longenough1' });
    await user.click(saveButton(dlg));
    expect(await dlg.findByText(recheck.profilePasswordRecheck.currentWrong)).toBeInTheDocument();
    expect(mockSignIn).toHaveBeenCalledWith('ada@example.com', 'notmypassword');
    expect(mockUpdatePassword).not.toHaveBeenCalled();
    // The form stays, ready for another try.
    expect(dlg.queryByText(/password updated/i)).not.toBeInTheDocument();
    expect(saveButton(dlg)).toBeEnabled();
    expect(dlg.getByLabelText('New password', { selector: 'input' })).toHaveValue('longenough1');
  });

  it('change-password dialog: the right current password is checked first, then the new one is set', async () => {
    const user = userEvent.setup();
    renderProfile();
    const dlg = await openPasswordDialog(user);
    await fillPasswordForm(user, dlg, { current: 'oldpassword1', next: 'longenough1', confirm: 'longenough1' });
    await user.click(saveButton(dlg));
    expect(await dlg.findByText(/password updated/i)).toBeInTheDocument();
    expect(mockSignIn).toHaveBeenCalledTimes(1);
    expect(mockSignIn).toHaveBeenCalledWith('ada@example.com', 'oldpassword1');
    expect(mockUpdatePassword).toHaveBeenCalledTimes(1);
    expect(mockUpdatePassword).toHaveBeenCalledWith('longenough1');
    expect(mockSignIn.mock.invocationCallOrder[0]).toBeLessThan(
      mockUpdatePassword.mock.invocationCallOrder[0],
    );
  });

  it.each([
    ['no network', () => Object.assign(new Error('Failed to fetch'), { name: 'AuthRetryableFetchError', status: 0 })],
    ['a rate limit', () => Object.assign(new Error('Request rate limit reached'), {
      name: 'AuthApiError', status: 429, code: 'over_request_rate_limit',
    })],
    ['a refusal of another kind', () => Object.assign(new Error('Email not confirmed'), {
      name: 'AuthApiError', status: 400, code: 'email_not_confirmed',
    })],
  ])('change-password dialog: a check that fails on %s is not called a wrong password, and changes nothing', async (_label, makeError) => {
    mockSignIn.mockImplementation(async () => ({ error: makeError() }));
    const user = userEvent.setup();
    renderProfile();
    const dlg = await openPasswordDialog(user);
    await fillPasswordForm(user, dlg, { current: 'oldpassword1', next: 'longenough1', confirm: 'longenough1' });
    await user.click(saveButton(dlg));
    expect(await dlg.findByText(recheck.profilePasswordRecheck.checkFailed)).toBeInTheDocument();
    expect(dlg.queryByText(recheck.profilePasswordRecheck.currentWrong)).not.toBeInTheDocument();
    expect(mockUpdatePassword).not.toHaveBeenCalled();
    expect(saveButton(dlg)).toBeEnabled();
  });

  it('change-password dialog: a check that throws leaves the form usable', async () => {
    mockSignIn.mockImplementation(async () => {
      throw new Error('boom');
    });
    const user = userEvent.setup();
    renderProfile();
    const dlg = await openPasswordDialog(user);
    await fillPasswordForm(user, dlg, { current: 'oldpassword1', next: 'longenough1', confirm: 'longenough1' });
    await user.click(saveButton(dlg));
    expect(await dlg.findByText(recheck.profilePasswordRecheck.checkFailed)).toBeInTheDocument();
    expect(mockUpdatePassword).not.toHaveBeenCalled();
    expect(saveButton(dlg)).toBeEnabled();
  });

  it('change-password dialog: a refused update after a good check says so and keeps the dialog open', async () => {
    mockUpdatePassword.mockImplementation(async () => ({
      error: Object.assign(new Error('New password should be different from the old password.'), {
        status: 422, code: 'same_password',
      }),
    }));
    const user = userEvent.setup();
    renderProfile();
    const dlg = await openPasswordDialog(user);
    await fillPasswordForm(user, dlg, { current: 'oldpassword1', next: 'oldpassword1', confirm: 'oldpassword1' });
    await user.click(saveButton(dlg));
    expect(await dlg.findByText(/should be different/i)).toBeInTheDocument();
    expect(mockSignIn).toHaveBeenCalledTimes(1);
    expect(dlg.queryByText(/password updated/i)).not.toBeInTheDocument();
    expect(saveButton(dlg)).toBeEnabled();
  });

  it('change-password dialog: one check at a time, however many taps', async () => {
    let answer;
    mockSignIn.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    const user = userEvent.setup();
    renderProfile();
    const dlg = await openPasswordDialog(user);
    await fillPasswordForm(user, dlg, { current: 'oldpassword1', next: 'longenough1', confirm: 'longenough1' });
    const form = dlg.getByLabelText('Current password', { selector: 'input' }).closest('form');
    await user.click(saveButton(dlg));
    // The button is disabled while the check runs; a submit by the keyboard
    // is held as well.
    expect(saveButton(dlg)).toBeDisabled();
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(mockSignIn).toHaveBeenCalledTimes(1);
    answer({ error: null });
    expect(await dlg.findByText(/password updated/i)).toBeInTheDocument();
    expect(mockUpdatePassword).toHaveBeenCalledTimes(1);
  });

  it('change-password dialog: Cancel while the current password is being checked changes nothing', async () => {
    let answer;
    mockSignIn.mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    const user = userEvent.setup();
    renderProfile();
    let dlg = await openPasswordDialog(user);
    await fillPasswordForm(user, dlg, { current: 'oldpassword1', next: 'longenough1', confirm: 'longenough1' });
    await user.click(saveButton(dlg));
    await user.click(dlg.getByRole('button', { name: /^cancel$/i, hidden: true }));
    await act(async () => {
      answer({ error: null });
    });
    expect(mockUpdatePassword).not.toHaveBeenCalled();
    // Opened again, the form is the empty one, not a late "Password updated."
    dlg = await openPasswordDialog(user);
    expect(dlg.queryByText(/password updated/i)).not.toBeInTheDocument();
    expect(dlg.getByLabelText('Current password', { selector: 'input' })).toHaveValue('');
    expect(saveButton(dlg)).toBeEnabled();
  });

  it('change-password dialog: closed and opened again, every field is empty', async () => {
    mockSignIn.mockImplementation(async () => ({ error: wrongPassword() }));
    const user = userEvent.setup();
    renderProfile();
    let dlg = await openPasswordDialog(user);
    await fillPasswordForm(user, dlg, { current: 'notmypassword', next: 'longenough1', confirm: 'longenough1' });
    await user.click(saveButton(dlg));
    await dlg.findByText(recheck.profilePasswordRecheck.currentWrong);
    await user.click(dlg.getByRole('button', { name: /^cancel$/i, hidden: true }));
    dlg = await openPasswordDialog(user);
    expect(dlg.getByLabelText('Current password', { selector: 'input' })).toHaveValue('');
    expect(dlg.getByLabelText('New password', { selector: 'input' })).toHaveValue('');
    expect(dlg.getByLabelText('Confirm new password', { selector: 'input' })).toHaveValue('');
    expect(dlg.queryByText(recheck.profilePasswordRecheck.currentWrong)).not.toBeInTheDocument();
  });
});
