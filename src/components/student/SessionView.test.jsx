import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { IsRestoringProvider } from '@tanstack/react-query';

// The session screen on its hook layer, stubbed: what the page shows for each
// state of its reads, and what each gesture asks the hooks to write. The real
// hooks are under it in SessionView.offline.test.jsx, SessionView.confirm.test.jsx
// and SessionView.reviewedLock.test.jsx.

let mockSessionData = { data: null, isLoading: false };
let mockSetLogsData = { data: [], isLoading: false };

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ sessionId: 'sess-1' }) };
});

// The page asks for the session row again at a few moments (see "a session the
// coach has reviewed" below), so the query's `refetch` is part of what it reads.
const mockRefetchSession = vi.fn();

vi.mock('../../hooks/useSession', () => ({
  useSession: () => ({ refetch: mockRefetchSession, ...mockSessionData }),
}));

// The page hands the completion of the session's sets over to this hook, with
// what it shows and whether it may ask (see "missing set rows" below); what
// the hook does with it is in hooks/useSetLogs.ensure.test.jsx.
const mockEnsureSetLogs = vi.fn();
const mockRefetchLogs = vi.fn();
// The writes of a set. One stub per hook, shared by every set of the page: a
// test asks which set a write was for by its `logId`.
const mockToggleDone = vi.fn();
const mockSetFailed = vi.fn();
const mockSetRpe = vi.fn();
const mockLogActual = vi.fn();
const mockSetSkipped = vi.fn();
const mockAddSet = vi.fn();
const mockRemoveSet = vi.fn(() => Promise.resolve({ removed: null }));

vi.mock('../../hooks/useSetLogs', () => ({
  useSetLogs: () => ({ refetch: mockRefetchLogs, ...mockSetLogsData }),
  useEnsureSetLogs: (...args) => mockEnsureSetLogs(...args),
  useToggleSetDone: () => ({ mutate: mockToggleDone }),
  useSetFailed: () => ({ mutate: mockSetFailed }),
  useSetRpe: () => ({ mutate: mockSetRpe }),
  useLogActual: () => ({ mutate: mockLogActual }),
  useSetSkipped: () => ({ mutate: mockSetSkipped }),
  useAddStudentSet: () => ({ mutate: mockAddSet, isPending: false }),
  useRemoveStudentSet: () => ({ mutate: vi.fn(), mutateAsync: mockRemoveSet, isPending: false }),
}));

let mockDeviations = { data: [], isLoading: false };

vi.mock('../../hooks/useSlotDeviations', () => ({
  useSlotDeviations: () => mockDeviations,
  useSaveSlotDeviation: () => ({ mutate: vi.fn(), isPending: false }),
  useRequestPromote: () => ({ mutate: vi.fn(), isPending: false }),
}));

let mockLastPerformance = { data: {} };

vi.mock('../../hooks/useLastPerformance', () => ({
  useLastPerformance: () => mockLastPerformance,
}));

// The real isActiveExercise: the swap picker filters with it.
let mockLibrary = [];

vi.mock('../../hooks/useExerciseLibrary', async () => {
  const actual = await vi.importActual('../../hooks/useExerciseLibrary');
  return { ...actual, useExerciseLibrary: () => ({ data: mockLibrary, isLoading: false }) };
});

let mockOnline = true;

vi.mock('../../hooks/useOnlineStatus', () => ({
  useOnlineStatus: () => mockOnline,
}));

let mockConfirmation = { data: null, isLoading: false };
const mockConfirm = { mutate: vi.fn(), isPending: false };
const mockUnconfirm = { mutate: vi.fn(), isPending: false };

let mockSlotComments = [];
const mockSaveComment = vi.fn();

vi.mock('../../hooks/useSlotComments', () => ({
  useSlotComments: () => ({ data: mockSlotComments, isLoading: false }),
  useSaveSlotComment: () => ({ mutate: mockSaveComment, isPending: false }),
}));

let mockVideos = { data: [], isLoading: false };

vi.mock('../../hooks/useSetVideo', () => ({
  useSetVideos: () => mockVideos,
  useUploadSetVideo: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteSetVideo: () => ({ mutate: vi.fn(), isPending: false }),
  useSetVideoSignedUrl: () => ({ data: null, isLoading: false }),
}));

// Whether the confirmation of the session is kept on the device until a
// network returns — read from the queue of writes by the real hook.
let mockConfirmWaiting = false;

vi.mock('../../hooks/useSessionConfirmation', () => ({
  useSessionConfirmation: () => mockConfirmation,
  useConfirmSession: () => mockConfirm,
  useUnconfirmSession: () => mockUnconfirm,
  useConfirmationWaiting: () => mockConfirmWaiting,
}));

let mockFeedback = { data: null };

vi.mock('../../hooks/useMessages', () => ({
  useSessionFeedback: () => mockFeedback,
  formatMessageStamp: () => 'stamp',
}));

import SessionView from './SessionView';
import { resetRestTimer, startRestTimer } from '../../hooks/useRestTimer';
import { getToasts, dismissToast } from '../../lib/toast';

// ── Fixtures ──────────────────────────────────────────────────────────────

// An exercise of the session, with its library row.
function slot(id, name, fields = {}) {
  return {
    id,
    sets: 1,
    reps: 5,
    weight_kg: 50,
    sort_order: 0,
    exercise: { id: `ex-${id}`, name, type: 'push', difficulty: 1, volume_weight: 1 },
    ...fields,
  };
}

// A set row as useSetLogs gives it: pending unless told otherwise, 5 × 50 kg.
function setLog(id, slotId, n, fields = {}) {
  return {
    id,
    exercise_slot_id: slotId,
    set_number: n,
    done: false,
    failed: false,
    skipped: false,
    rpe: null,
    target_reps: 5,
    target_weight_kg: 50,
    ...fields,
  };
}

// The two reads, as useQuery reports them once they hold data.
function loaded(slots, fields = {}) {
  return {
    data: { title: 'Day 1', exercise_slots: slots, program_is_active: true, ...fields },
    isLoading: false,
    fetchStatus: 'idle',
  };
}

function logsRead(logs, fields = {}) {
  return { data: logs, isLoading: false, fetchStatus: 'idle', ...fields };
}

const CONFIRMED = {
  id: 'c-1',
  session_id: 'sess-1',
  student_id: 'u-1',
  notes: null,
  confirmed_at: '2026-04-14T10:00:00Z',
};

function page() {
  return (
    <MemoryRouter>
      <SessionView />
    </MemoryRouter>
  );
}

function renderSessionView() {
  return render(page());
}

function rerenderSessionView(view) {
  view.rerender(page());
}

// The sets as the cache holds them after a write: the hooks write the cache at
// the tap (useSetLogs), and the page is drawn again from it.
function settle(view, logs) {
  mockSetLogsData = logsRead(logs);
  rerenderSessionView(view);
}

// ── What the screen is made of ───────────────────────────────────────────

const panel = () => screen.getByRole('region', { name: 'Set in progress' });
const shownExercise = () => within(panel()).getByRole('heading', { level: 2 }).textContent;
// The row over the ActionBar's main action: the exercise before at its left
// and the one after at its right, each a button named for it — none on the
// side where the session ends —, and the dots between them.
const previousArrow = () => screen.queryByRole('button', { name: /^Previous exercise/ });
const nextArrow = () => screen.queryByRole('button', { name: /^Next exercise/ });
const steps = () => screen.queryByRole('img', { name: /^Exercise \d+ of \d+/ });
// Steps back to the first exercise unless `name` comes first, then forward
// to it.
async function goToExercise(user, name) {
  while (shownExercise() !== name && previousArrow() && !previousArrow().disabled) {
    await user.click(previousArrow());
  }
  while (shownExercise() !== name && nextArrow() && !nextArrow().disabled) {
    await user.click(nextArrow());
  }
  expect(shownExercise()).toBe(name);
}
// The switch of a superset's panel, and a choice in it by its exercise.
const supersetSwitch = () => screen.queryByRole('group', { name: 'Exercises of the superset' });
async function pickInSuperset(user, name) {
  await user.click(within(supersetSwitch()).getByRole('button', { name: new RegExp(`^[A-Z]\\d ${name}$`) }));
  expect(shownExercise()).toBe(name);
}
// The exercises in the order the arrows go through them, from the first.
async function exerciseOrder(user) {
  while (previousArrow() && !previousArrow().disabled) await user.click(previousArrow());
  const names = [shownExercise()];
  while (nextArrow() && !nextArrow().disabled) {
    await user.click(nextArrow());
    names.push(shownExercise());
  }
  return names;
}
const setList = () => screen.queryByRole('list', { name: 'Sets' });
// The row of set n, found by its title (« Set 2 », « Set 2, failed »): jsdom
// joins the title and the caption of a row without a space in its name. A row
// that can be touched is a button; one that cannot is no button.
const setRow = (n) =>
  setList() ? within(setList()).queryByText(new RegExp(`^Set ${n}(, \\w+)?$`))?.closest('li') ?? null : null;
const setRowButton = (n) => setRow(n)?.querySelector('button') ?? null;
const holdHint = () => screen.queryByText('Press and hold a set to mark it failed.');
const actionBar = () => document.querySelector('.pk-actionbar');
const inBar = () => within(actionBar());
const validateButton = () => screen.queryByRole('button', { name: /^validate set \d+$/i });
const confirmButtons = () => screen.queryAllByRole('button', { name: /^confirm session$/i });
const confirmButton = () => screen.queryByRole('button', { name: /^confirm session$/i });
// While sets are left, confirming is « Finish the session now » in the « ⋯ »
// of the title; once every set is dealt with, the ActionBar's « Confirm
// session ».
const sessionMenu = () => screen.queryByRole('button', { name: 'Session options' });
const finishNowItem = () =>
  within(sheet('Session options')).getByRole('button', { name: /^Finish the session now/ });
const confirmOffered = () => Boolean(confirmButton() || sessionMenu());
const exerciseMenu = () => screen.queryByRole('button', { name: 'Exercise options' });
async function openExerciseMenu(user) {
  const name = shownExercise();
  await user.click(exerciseMenu());
  return sheet(name);
}
async function openSessionMenu(user) {
  await user.click(sessionMenu());
  return sheet('Session options');
}
async function openConfirm(user) {
  if (confirmButton()) return user.click(confirmButton());
  await openSessionMenu(user);
  return user.click(finishNowItem());
}
// An open sheet, by its title. A closed one is not on screen (`display: none`).
const sheet = (name) => screen.queryByRole('dialog', { name });
const rpeSheet = () => screen.queryByRole('dialog', { name: /^RPE of set \d+$/ });

beforeEach(() => {
  vi.clearAllMocks();
  resetRestTimer();
  for (const toast of getToasts()) dismissToast(toast.id);
  mockOnline = true;
  mockSessionData = loaded([]);
  mockSetLogsData = logsRead([]);
  mockConfirmation = { data: null, isLoading: false };
  mockConfirmWaiting = false;
  Object.assign(mockConfirm, { isPending: false, isPaused: false });
  Object.assign(mockUnconfirm, { isPending: false, isPaused: false });
  mockFeedback = { data: null };
  mockDeviations = { data: [], isLoading: false };
  mockLastPerformance = { data: {} };
  mockLibrary = [];
  mockSlotComments = [];
  mockVideos = { data: [], isLoading: false };
});

afterEach(() => {
  vi.useRealTimers();
  resetRestTimer();
});

describe('SessionView', () => {
  it('renders loading spinner', () => {
    mockSessionData = { data: undefined, isLoading: true, fetchStatus: 'fetching' };
    mockSetLogsData = { data: undefined, isLoading: false, fetchStatus: 'idle' };
    renderSessionView();
    expect(screen.getByRole('status')).toHaveAccessibleName(/loading/i);
  });

  it('shows the exercise, the set in progress with its figures, and its sets', () => {
    mockSessionData = loaded([slot('slot-1', 'Dip', { sets: 3, reps: 10, weight_kg: 20 })], { title: 'Push Day' });
    mockSetLogsData = logsRead([
      setLog('log-1', 'slot-1', 1, { target_reps: 10, target_weight_kg: 20 }),
      setLog('log-2', 'slot-1', 2, { target_reps: 10, target_weight_kg: 20 }),
    ]);
    renderSessionView();

    expect(shownExercise()).toBe('Dip');
    const figures = within(panel());
    expect(figures.getByText('Set 1 of 2')).toBeInTheDocument();
    // The two figures of the set in progress, each over its unit.
    expect(figures.getByText('10')).toBeInTheDocument();
    expect(figures.getByText('reps')).toBeInTheDocument();
    expect(figures.getByText('20')).toBeInTheDocument();
    expect(figures.getByText('kg added')).toBeInTheDocument();

    // Two rows, each a button that says its set and its target.
    expect(within(setList()).getAllByRole('listitem')).toHaveLength(2);
    expect(setRowButton(1)).toHaveTextContent('10 reps, 20 kg');
    expect(setRowButton(1)).toHaveTextContent('In progress');
    expect(setRowButton(2)).toHaveTextContent('10 reps, 20 kg');
    expect(setRowButton(2)).not.toHaveTextContent('In progress');
    expect(holdHint()).toBeInTheDocument();
  });

  // B8, the athlete's half: the library row of an exercise of a former
  // coach's library is hidden by row-level security, and the embed is null.
  // The page used to throw on its name and go down whole.
  it('opens a session whose exercise cannot be read, and names it as unavailable', () => {
    mockSessionData = loaded([slot('slot-1', null, { sets: 2, exercise: null })], { title: 'Push Day' });
    mockSetLogsData = logsRead([setLog('log-1', 'slot-1', 1), setLog('log-2', 'slot-1', 2)]);
    renderSessionView();

    expect(shownExercise()).toBe('Exercise unavailable');
    expect(within(setList()).getAllByRole('listitem')).toHaveLength(2);
    expect(inBar().getByRole('button', { name: 'Validate set 1' })).toBeEnabled();
    expect(confirmOffered()).toBe(true);
  });

  it('renders header with session title', () => {
    mockSessionData = loaded([], { title: 'Pull Day' });
    renderSessionView();
    expect(screen.getByRole('heading', { level: 1, name: 'Pull Day' })).toBeInTheDocument();
  });

  // The progress bar is gone: what it counted is said under the title, as
  // facts — the day, the exercises, the sets done.
  it('says the day, the exercises and the sets done under the title', () => {
    mockSessionData = loaded([slot('slot-a', 'Squat'), slot('slot-b', 'Bench', { sort_order: 1 })], {
      scheduled_date: '2026-10-12',
    });
    mockSetLogsData = logsRead([
      setLog('a-1', 'slot-a', 1, { done: true, rpe: 8 }),
      setLog('a-2', 'slot-a', 2, { failed: true }),
      setLog('b-1', 'slot-b', 1),
    ]);
    renderSessionView();
    expect(screen.getByText('Monday, 2 exercises, 1 of 3 sets done')).toBeInTheDocument();
  });

  // Failed sets count as dealt with in the confirm sheet (the athlete worked
  // through them) but NOT among the sets done, which say what was completed.
  it('counts only done sets under the title, and failed ones as logged in the confirm sheet', async () => {
    const user = userEvent.setup();
    mockSessionData = loaded([slot('slot-1', 'Squat', { sets: 4 })]);
    mockSetLogsData = logsRead([
      setLog('l-1', 'slot-1', 1, { done: true, rpe: 7 }),
      setLog('l-2', 'slot-1', 2, { done: true, rpe: 8 }),
      setLog('l-3', 'slot-1', 3, { failed: true }),
      setLog('l-4', 'slot-1', 4),
    ]);
    renderSessionView();

    expect(screen.getByText('1 exercise, 2 of 4 sets done')).toBeInTheDocument();
    await openConfirm(user);
    expect(within(sheet('Confirm the session')).getByText('3 of 4 sets logged')).toBeInTheDocument();
  });

  it('shows "Confirm session" button when not yet confirmed', () => {
    renderSessionView();
    expect(screen.getByRole('button', { name: /confirm session/i })).toBeInTheDocument();
  });

  it('opens confirm dialog, types notes, and calls useConfirmSession', async () => {
    const user = userEvent.setup();
    renderSessionView();

    // Notes textarea is hidden until the athlete opens the confirm sheet.
    expect(screen.queryByLabelText(/note for your coach/i)).toBeNull();

    await openConfirm(user);
    await user.type(screen.getByLabelText(/note for your coach/i), 'felt strong');
    await user.click(screen.getByRole('button', { name: /^confirm$/i }));

    expect(mockConfirm.mutate).toHaveBeenCalledWith(
      {
        sessionId: 'sess-1',
        notes: 'felt strong',
        // No set was ticked in this fixture, so the date falls back to today.
        performedOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      },
      expect.any(Object)
    );
  });

  // The training date is pinned from the set logs at confirm time, not left to
  // the server's confirmed_at default — an offline confirm can replay days later.
  it('confirm sends the date of the earliest logged set, not today', async () => {
    const user = userEvent.setup();
    mockSetLogsData = logsRead([
      { id: 'l-2', done: true, logged_at: new Date(2026, 7, 18, 19, 30).toISOString() },
      { id: 'l-1', done: true, logged_at: new Date(2026, 7, 18, 18, 0).toISOString() },
    ]);
    renderSessionView();

    await openConfirm(user);
    await user.click(screen.getByRole('button', { name: /^confirm$/i }));

    expect(mockConfirm.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ performedOn: '2026-08-18' }),
      expect.any(Object)
    );
  });

  it('cancel in confirm dialog closes it without calling useConfirmSession', async () => {
    const user = userEvent.setup();
    renderSessionView();

    await openConfirm(user);
    expect(screen.getByLabelText(/note for your coach/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(mockConfirm.mutate).not.toHaveBeenCalled();
    expect(screen.queryByLabelText(/note for your coach/i)).toBeNull();
    expect(sheet('Confirm the session')).toBeNull();
  });

  // P25. The answer to a confirmation can be hours away — the write is parked
  // without a network, which is neither a success nor a failure — and the
  // page behind the sheet shows the session as confirmed from the tap. The
  // dialog used to wait for the answer, on "Confirming…" with Cancel off.
  describe('the confirm dialog closes at the tap', () => {
    const notesField = () => screen.queryByLabelText(/note for your coach/i);

    function openDialog(user) {
      renderSessionView();
      return openConfirm(user);
    }

    it('without waiting for the answer of the write', async () => {
      const user = userEvent.setup();
      await openDialog(user);
      await user.type(notesField(), 'felt strong');

      await user.click(screen.getByRole('button', { name: /^confirm$/i }));

      // `mutate` is a stub: nothing has answered, and nothing will.
      expect(mockConfirm.mutate).toHaveBeenCalledTimes(1);
      expect(notesField()).toBeNull();
      expect(sheet('Confirm the session')).toBeNull();
    });

    it('the note leaves the field when the database has it, not before', async () => {
      const user = userEvent.setup();
      await openDialog(user);
      await user.type(notesField(), 'felt strong');
      await user.click(screen.getByRole('button', { name: /^confirm$/i }));

      // The confirmation was refused (the hook put the page back): the sheet
      // opens on what was written.
      await openConfirm(user);
      expect(notesField()).toHaveValue('felt strong');
      await user.click(screen.getByRole('button', { name: /^cancel$/i }));

      // It landed.
      const { onSuccess } = mockConfirm.mutate.mock.calls[0][1];
      act(() => onSuccess());
      await openConfirm(user);
      expect(notesField()).toHaveValue('');
    });

    it('its buttons are never switched off by a write that is waiting', async () => {
      const user = userEvent.setup();
      Object.assign(mockConfirm, { isPending: true, isPaused: true });
      await openDialog(user);

      expect(screen.getByRole('button', { name: /^confirm$/i })).toBeEnabled();
      expect(screen.getByRole('button', { name: /^cancel$/i })).toBeEnabled();
      expect(screen.queryByText(/confirming…/i)).toBeNull();
    });
  });

  // A parked write is `isPending` for as long as the device has no network.
  // Keyed on that alone the buttons stayed off, and "Confirm session" on
  // "Confirming…", for a session confirmed and un-confirmed in the gym.
  describe('a write that waits for a network does not hold its button', () => {
    it('"Confirm session" stays available while a confirmation is parked (confirm, then undo, offline)', () => {
      Object.assign(mockConfirm, { isPending: true, isPaused: true });
      renderSessionView();
      expect(confirmButton()).toBeEnabled();
      expect(screen.queryByText(/confirming…/i)).toBeNull();
    });

    it('…and is held, as "Confirming…", by one that is being sent', () => {
      Object.assign(mockConfirm, { isPending: true, isPaused: false });
      renderSessionView();
      expect(screen.getByRole('button', { name: /^confirming…$/i })).toBeDisabled();
    });

    it('…in the « ⋯ » of the title as in the ActionBar, whichever carries it', async () => {
      const user = userEvent.setup();
      // Sets still to do: the « ⋯ » of the title carries it.
      Object.assign(mockConfirm, { isPending: true, isPaused: false });
      mockSessionData = loaded([slot('slot-1', 'Squat')]);
      mockSetLogsData = logsRead([setLog('l-1', 'slot-1', 1)]);
      renderSessionView();
      const menu = await openSessionMenu(user);
      const held = within(menu).getByRole('button', { name: /^confirming…/i });
      expect(held).toBeDisabled();
      expect(actionBar()).not.toContainElement(held);
    });

    it('"Undo confirmation" stays available while an undo is parked (undo, then confirm again, offline)', () => {
      mockConfirmation = { data: CONFIRMED, isLoading: false };
      Object.assign(mockUnconfirm, { isPending: true, isPaused: true });
      renderSessionView();
      expect(screen.getByRole('button', { name: /undo confirmation/i })).toBeEnabled();
    });

    it('…and is held by one that is being sent', () => {
      mockConfirmation = { data: CONFIRMED, isLoading: false };
      Object.assign(mockUnconfirm, { isPending: true, isPaused: false });
      renderSessionView();
      expect(screen.getByRole('button', { name: /undo confirmation/i })).toBeDisabled();
    });

    it('the confirmed card says that the confirmation is kept on the device, while it is', () => {
      mockConfirmation = { data: CONFIRMED, isLoading: false };
      mockConfirmWaiting = true;
      const view = renderSessionView();

      const line = screen.getByText(/saved on this device\. it will be sent as soon as you are back online/i);
      expect(line).toHaveAttribute('role', 'status');
      expect(line.closest('section')).toHaveTextContent(/session confirmed/i);

      mockConfirmWaiting = false;
      rerenderSessionView(view);
      expect(screen.queryByText(/saved on this device/i)).toBeNull();
      expect(screen.getByText(/session confirmed/i)).toBeInTheDocument();
    });

    it('…and nothing of the kind on a session that is not confirmed', () => {
      // Confirmed and un-confirmed offline: the confirmation is still in the
      // queue, in front of its undo.
      mockConfirmWaiting = true;
      renderSessionView();
      expect(screen.queryByText(/saved on this device/i)).toBeNull();
    });
  });

  // Live item N8: "Confirm session" was offered at 0 of 12 sets, and the
  // dialog said nothing about what was being confirmed.
  describe('the confirm dialog says what is confirmed', () => {
    const SLOT = slot('slot-1', 'Dip', { sets: 3 });
    const nthSet = (n, fields = {}) => setLog(`log-${n}`, 'slot-1', n, fields);
    const inDialog = () => within(sheet('Confirm the session'));

    function openOn(user, logs) {
      mockSessionData = loaded([SLOT], { title: 'Push Day' });
      mockSetLogsData = logsRead(logs);
      renderSessionView();
      return openConfirm(user);
    }

    it('how many sets are logged, counted as dealt with: done, failed and skipped', async () => {
      const user = userEvent.setup();
      await openOn(user, [
        nthSet(1, { done: true }),
        nthSet(2, { failed: true }),
        nthSet(3, { skipped: true }),
        nthSet(4),
      ]);

      expect(inDialog().getByText('3 of 4 sets logged')).toBeInTheDocument();
      // Something is logged: one tap confirms.
      await user.click(inDialog().getByRole('button', { name: /^confirm$/i }));
      expect(mockConfirm.mutate).toHaveBeenCalledTimes(1);
    });

    it('the sets of an exercise the athlete skipped count as dealt with', async () => {
      const user = userEvent.setup();
      mockDeviations = { data: [{ exercise_slot_id: 'slot-1', kind: 'skip' }], isLoading: false };
      await openOn(user, [nthSet(1), nthSet(2), nthSet(3)]);

      expect(inDialog().getByText('3 of 3 sets logged')).toBeInTheDocument();
      await user.click(inDialog().getByRole('button', { name: /^confirm$/i }));
      expect(mockConfirm.mutate).toHaveBeenCalledTimes(1);
    });

    it('with nothing logged it asks a second time before it confirms', async () => {
      const user = userEvent.setup();
      await openOn(user, [nthSet(1), nthSet(2), nthSet(3)]);
      expect(inDialog().getByText('0 of 3 sets logged')).toBeInTheDocument();
      expect(inDialog().queryByRole('alert')).toBeNull();
      await user.type(screen.getByLabelText(/note for your coach/i), 'did it at home');

      await user.click(inDialog().getByRole('button', { name: /^confirm$/i }));

      // Asked, not sent — and the sheet is still there, with the note.
      expect(mockConfirm.mutate).not.toHaveBeenCalled();
      expect(inDialog().getByRole('alert')).toHaveTextContent(
        /you logged no set of this session\. confirm it anyway\?/i,
      );
      expect(screen.getByLabelText(/note for your coach/i)).toHaveValue('did it at home');
      expect(inDialog().queryByRole('button', { name: /^confirm$/i })).toBeNull();

      await user.click(inDialog().getByRole('button', { name: /^confirm anyway$/i }));
      expect(mockConfirm.mutate).toHaveBeenCalledTimes(1);
      expect(mockConfirm.mutate).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'sess-1', notes: 'did it at home' }),
        expect.any(Object),
      );
      expect(screen.queryByLabelText(/note for your coach/i)).toBeNull();
    });

    it('a dialog that was closed asks again from the start', async () => {
      const user = userEvent.setup();
      await openOn(user, [nthSet(1), nthSet(2), nthSet(3)]);
      await user.click(inDialog().getByRole('button', { name: /^confirm$/i }));
      expect(inDialog().getByRole('alert')).toBeInTheDocument();
      await user.click(inDialog().getByRole('button', { name: /^cancel$/i }));

      await openConfirm(user);

      expect(inDialog().queryByRole('alert')).toBeNull();
      await user.click(inDialog().getByRole('button', { name: /^confirm$/i }));
      expect(mockConfirm.mutate).not.toHaveBeenCalled();
    });

    it('a session without a set has nothing to count, and is confirmed in one tap', async () => {
      const user = userEvent.setup();
      mockSessionData = loaded([], { title: 'Mobility' });
      renderSessionView();
      await openConfirm(user);

      expect(inDialog().queryByText(/sets logged/i)).toBeNull();
      await user.click(inDialog().getByRole('button', { name: /^confirm$/i }));
      expect(mockConfirm.mutate).toHaveBeenCalledTimes(1);
    });
  });

  it('displays coach note when slot has notes', () => {
    mockSessionData = loaded([slot('slot-1', 'Dip', { notes: 'Keep elbows tucked throughout' })]);
    mockSetLogsData = logsRead([setLog('l-1', 'slot-1', 1)]);
    renderSessionView();
    const note = screen.getByRole('region', { name: 'Coach’s note' });
    expect(note).toHaveTextContent('Keep elbows tucked throughout');
  });

  it('shows confirmed banner and undo button when already confirmed', async () => {
    const user = userEvent.setup();
    mockConfirmation = { data: { ...CONFIRMED, notes: 'great session' }, isLoading: false };
    renderSessionView();

    expect(screen.getByText(/session confirmed/i)).toBeInTheDocument();
    expect(screen.getByText('great session')).toBeInTheDocument();

    // Undo asks first, in a sheet: the click opens it and the mutation waits
    // for its button.
    await user.click(screen.getByRole('button', { name: /undo confirmation/i }));
    expect(mockUnconfirm.mutate).not.toHaveBeenCalled();

    const dialog = sheet('Undo the confirmation?');
    await user.click(within(dialog).getByRole('button', { name: /undo confirmation/i }));
    expect(mockUnconfirm.mutate).toHaveBeenCalledWith({ sessionId: 'sess-1' });
    expect(sheet('Undo the confirmation?')).toBeNull();
  });

  it('dismissing the undo dialog leaves the confirmation in place', async () => {
    const user = userEvent.setup();
    mockConfirmation = { data: CONFIRMED, isLoading: false };
    renderSessionView();

    await user.click(screen.getByRole('button', { name: /undo confirmation/i }));
    const dialog = sheet('Undo the confirmation?');
    await user.click(within(dialog).getByRole('button', { name: 'Keep the confirmation' }));
    expect(mockUnconfirm.mutate).not.toHaveBeenCalled();
    expect(sheet('Undo the confirmation?')).toBeNull();
  });

  // A confirmed session has its sets locked: nothing is left to validate, so
  // there is no ActionBar, and no rest runs in it.
  it('a confirmed session has no ActionBar: nothing to validate, nothing to confirm', () => {
    mockConfirmation = { data: CONFIRMED, isLoading: false };
    mockSessionData = loaded([slot('slot-1', 'Squat')]);
    mockSetLogsData = logsRead([setLog('l-1', 'slot-1', 1, { done: true, rpe: 8 })]);
    renderSessionView();

    expect(actionBar()).toBeNull();
    expect(validateButton()).toBeNull();
    expect(confirmOffered()).toBe(false);
    // The set is shown, and cannot be touched.
    expect(within(setList()).getAllByRole('listitem')).toHaveLength(1);
    expect(setRow(1)).toHaveTextContent('5 reps, 50 kg');
    expect(setRowButton(1)).toBeNull();
  });

  // Past-program sessions reach SessionView via the stats calendar history
  // overlay. They must be read-only — no Confirm, no Undo, locked sets — so
  // historical training data can't be retroactively rewritten.
  it('past-program session: hides Confirm and shows read-only banner when unconfirmed', () => {
    mockSessionData = loaded([], { title: 'Old Day', program_is_active: false });
    renderSessionView();

    expect(confirmOffered()).toBe(false);
    expect(screen.getByText('From a past block, read only.')).toBeInTheDocument();
  });

  it('past-program session: hides Undo and shows confirmation-locked banner when confirmed', () => {
    mockConfirmation = { data: CONFIRMED, isLoading: false };
    mockSessionData = loaded([], { title: 'Old Day', program_is_active: false });
    renderSessionView();

    expect(screen.queryByRole('button', { name: /undo confirmation/i })).toBeNull();
    expect(screen.getByText('From a past block. The confirmation can no longer change.')).toBeInTheDocument();
  });

  it('past-program session: no set can be validated, touched or held', () => {
    mockSessionData = loaded([slot('slot-1', 'Squat')], { title: 'Old Day', program_is_active: false });
    mockSetLogsData = logsRead([setLog('l-1', 'slot-1', 1)]);
    renderSessionView();

    // The set is shown as it is…
    expect(within(setList()).getAllByRole('listitem')).toHaveLength(1);
    // …as a plain row: no sheet to open, no press to hold, no hint about one.
    expect(setRow(1)).toHaveTextContent('5 reps, 50 kg');
    expect(setRowButton(1)).toBeNull();
    expect(holdHint()).toBeNull();
    // Nothing to validate and nothing to confirm: no ActionBar at all.
    expect(actionBar()).toBeNull();
    expect(validateButton()).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add a set' })).toBeNull();
    expect(exerciseMenu()).toBeNull();
  });

  it("shows the coach's feedback section when feedback exists for the session", () => {
    mockFeedback = {
      data: {
        id: 'msg-1',
        body: 'Great work — push the bar harder next week.',
        created_at: '2026-04-15T10:00:00Z',
      },
    };
    renderSessionView();

    const card = screen.getByRole('region', { name: 'Coach’s feedback' });
    expect(card).toHaveTextContent('Great work — push the bar harder next week.');
    expect(card).toHaveTextContent('stamp');
    expect(within(card).getByRole('link', { name: /reply in messages/i })).toHaveAttribute(
      'href',
      '/student/messages',
    );
  });

  // P68. jsdom lays nothing out: the 44 px are read from the classes, which
  // the Parc stylesheet sizes at --target-min (44px) and more.
  it('draws its controls at 44 px: the way back, the menus, the arrows, the rows, the main action and "Reply in messages"', () => {
    mockFeedback = {
      data: { id: 'msg-1', body: 'Good.', created_at: '2026-04-15T10:00:00Z' },
    };
    mockSessionData = loaded([slot('slot-a', 'Squat'), slot('slot-b', 'Bench', { sort_order: 1 })]);
    mockSetLogsData = logsRead([setLog('a-1', 'slot-a', 1), setLog('b-1', 'slot-b', 1)]);
    renderSessionView();

    expect(screen.getByRole('button', { name: 'Back to training' })).toHaveClass('pk-icon-btn');
    expect(nextArrow()).toHaveClass('pk-btn');
    expect(setRowButton(1)).toHaveClass('pk-row');
    expect(inBar().getByRole('button', { name: 'Validate set 1' })).toHaveClass('pk-btn', 'pk-btn-lg');
    expect(sessionMenu()).toHaveClass('pk-icon-btn');
    expect(exerciseMenu()).toHaveClass('pk-icon-btn');
    expect(screen.getByRole('button', { name: 'Add a set' })).toHaveClass('pk-row');
    expect(screen.getByRole('link', { name: /reply in messages/i })).toHaveClass('pk-btn');
  });

  it('hides the feedback section when no feedback exists', () => {
    renderSessionView();
    expect(screen.queryByRole('region', { name: 'Coach’s feedback' })).toBeNull();
    expect(screen.queryByText('Coach’s feedback')).toBeNull();
  });

  it('coach-archived unconfirmed session: hides Confirm and shows archive read-only banner', () => {
    mockSessionData = loaded([], { archived_at: '2026-04-20T10:00:00Z' });
    renderSessionView();

    expect(confirmOffered()).toBe(false);
    expect(screen.getByText('Archived by your coach, read only.')).toBeInTheDocument();
  });
});

// The accordion is gone: the screen shows one exercise at a time, picked by a
// row of chips, and opens on the one the athlete has to do next.
describe('SessionView: one exercise at a time', () => {
  const SQUAT = slot('slot-a', 'Squat');
  const BENCH = slot('slot-b', 'Bench', { sort_order: 1 });
  const ROW = slot('slot-c', 'Row', { sort_order: 2 });

  it('opens on the first exercise with a set to do, and shows only its sets', () => {
    mockSessionData = loaded([slot('slot-done', 'Dip', { sets: 2 }), slot('slot-open', 'Pullup', { sets: 2, sort_order: 1 })]);
    mockSetLogsData = logsRead([
      setLog('l-1', 'slot-done', 1, { done: true, rpe: 7 }),
      setLog('l-2', 'slot-done', 2, { done: true, rpe: 8 }),
      setLog('l-3', 'slot-open', 1),
      setLog('l-4', 'slot-open', 2),
    ]);
    renderSessionView();

    // The second of two is shown: the dots say so, and the arrow back names
    // the first.
    expect(shownExercise()).toBe('Pullup');
    expect(steps()).toHaveAccessibleName('Exercise 2 of 2, 1 done');
    expect(previousArrow()).toHaveAccessibleName('Previous exercise: Dip');
    expect(nextArrow()).toBeNull();
    // Pullup's two pending sets, and none of Dip's done ones.
    expect(within(setList()).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.queryByText(/^Set \d+, done$/)).toBeNull();
    expect(inBar().getByRole('button', { name: 'Validate set 1' })).toBeInTheDocument();
  });

  it('opens on the first exercise when several have sets to do', () => {
    mockSessionData = loaded([SQUAT, BENCH, ROW]);
    mockSetLogsData = logsRead([setLog('l-a', 'slot-a', 1), setLog('l-b', 'slot-b', 1), setLog('l-c', 'slot-c', 1)]);
    renderSessionView();

    expect(shownExercise()).toBe('Squat');
    expect(steps()).toHaveAccessibleName('Exercise 1 of 3, 0 done');
    expect(previousArrow()).toBeNull();
    expect(nextArrow()).toHaveAccessibleName('Next exercise: Bench');
    // Only the exercise shown has its sets on screen.
    expect(within(setList()).getAllByRole('listitem')).toHaveLength(1);
  });

  it('opens on the first exercise of a session whose every set is dealt with', () => {
    mockSessionData = loaded([SQUAT, BENCH]);
    mockSetLogsData = logsRead([
      setLog('l-a', 'slot-a', 1, { done: true, rpe: 8 }),
      setLog('l-b', 'slot-b', 1, { failed: true }),
    ]);
    renderSessionView();
    expect(shownExercise()).toBe('Squat');
    expect(within(panel()).getByText('Exercise done')).toBeInTheDocument();
  });

  // The RPE is asked in a sheet right after a set is validated: the screen no
  // longer waits on the exercise for it, as the accordion did.
  it('a set done without its RPE does not hold the screen on its exercise', () => {
    mockSessionData = loaded([SQUAT, BENCH]);
    mockSetLogsData = logsRead([setLog('l-1', 'slot-a', 1, { done: true }), setLog('l-2', 'slot-b', 1)]);
    renderSessionView();
    expect(shownExercise()).toBe('Bench');
  });

  it('a failed set is dealt with: the screen opens on the next exercise', () => {
    mockSessionData = loaded([SQUAT, BENCH]);
    mockSetLogsData = logsRead([setLog('l-1', 'slot-a', 1, { failed: true }), setLog('l-2', 'slot-b', 1)]);
    renderSessionView();
    expect(shownExercise()).toBe('Bench');
    expect(steps()).toHaveAccessibleName('Exercise 2 of 2, 1 done');
  });

  // Squat's only set is skipped (neither done nor failed, per the DB CHECK).
  // Before the fix it stayed "unresolved" forever: the page pinned to Squat
  // and its count stayed short of the sets the athlete had dealt with.
  it('a skipped set is dealt with: the screen opens on the next exercise, and the count has it', async () => {
    const user = userEvent.setup();
    mockSessionData = loaded([SQUAT, BENCH]);
    mockSetLogsData = logsRead([setLog('l-1', 'slot-a', 1, { skipped: true }), setLog('l-2', 'slot-b', 1)]);
    renderSessionView();

    expect(shownExercise()).toBe('Bench');
    await openConfirm(user);
    expect(within(sheet('Confirm the session')).getByText('1 of 2 sets logged')).toBeInTheDocument();
  });

  // The whole Squat exercise is skip-deviated; its sets stay pending in the
  // database and are not shown, so without the skipped exercises counted as
  // dealt with they would pin the screen and the count for the whole session.
  it('an exercise the athlete skipped is dealt with, though its sets stay pending', async () => {
    const user = userEvent.setup();
    mockDeviations = {
      data: [{ exercise_slot_id: 'slot-a', student_id: 'u-1', kind: 'skip' }],
      isLoading: false,
    };
    mockSessionData = loaded([SQUAT, BENCH]);
    mockSetLogsData = logsRead([setLog('l-1', 'slot-a', 1), setLog('l-2', 'slot-b', 1)]);
    renderSessionView();

    expect(shownExercise()).toBe('Bench');

    // Its own screen says it was skipped, with no set to do.
    expect(steps()).toHaveAccessibleName('Exercise 2 of 2, 1 done');
    await goToExercise(user, 'Squat');
    expect(within(panel()).getByText('Exercise skipped')).toBeInTheDocument();
    expect(screen.getByText('You skipped this exercise.')).toBeInTheDocument();
    expect(setList()).toBeNull();

    await openConfirm(user);
    expect(within(sheet('Confirm the session')).getByText('1 of 2 sets logged')).toBeInTheDocument();
  });

  it('the neighbours over the main action step through the exercises, and the one pressed keeps the focus', async () => {
    const user = userEvent.setup();
    mockSessionData = loaded([SQUAT, BENCH, ROW]);
    mockSetLogsData = logsRead([setLog('l-a', 'slot-a', 1), setLog('l-b', 'slot-b', 1), setLog('l-c', 'slot-c', 1)]);
    renderSessionView();
    expect(shownExercise()).toBe('Squat');
    // The first exercise has nothing before it; the one after is named.
    expect(previousArrow()).toBeNull();
    expect(nextArrow()).toHaveTextContent('Bench');
    expect(actionBar()).toContainElement(nextArrow());
    expect(actionBar()).toContainElement(steps());

    await user.click(nextArrow());
    expect(shownExercise()).toBe('Bench');
    expect(steps()).toHaveAccessibleName('Exercise 2 of 3, 0 done');
    expect(previousArrow()).toHaveTextContent('Squat');
    expect(nextArrow()).toHaveTextContent('Row');
    expect(nextArrow()).toHaveFocus();

    await user.click(nextArrow());
    expect(shownExercise()).toBe('Row');
    // The session ends on that side: its button goes, and the other one has
    // the focus.
    expect(nextArrow()).toBeNull();
    expect(previousArrow()).toHaveFocus();

    await user.click(previousArrow());
    expect(shownExercise()).toBe('Bench');
    expect(previousArrow()).toHaveFocus();
    // The ActionBar follows the exercise shown.
    expect(inBar().getByRole('button', { name: 'Validate set 1' })).toBeInTheDocument();
  });

  // The neighbours replace the chips, which replaced the numbered headers of
  // the accordion: the steps in the session's order, a superset one step,
  // named by its exercises and entered on its first.
  it("steps through the session's order, a superset as one step", async () => {
    const user = userEvent.setup();
    mockSessionData = loaded([
      slot('slot-1', 'Dips'),
      slot('slot-2a', 'Pull-up', { sort_order: 1, superset_group: 1 }),
      slot('slot-2b', 'Push-up', { sort_order: 2, superset_group: 1 }),
      slot('slot-3', 'Bench Press', { sort_order: 3 }),
    ]);
    mockSetLogsData = logsRead([
      setLog('l-1', 'slot-1', 1),
      setLog('l-2a', 'slot-2a', 1),
      setLog('l-2b', 'slot-2b', 1),
      setLog('l-3', 'slot-3', 1),
    ]);
    renderSessionView();

    expect(steps()).toHaveAccessibleName('Exercise 1 of 3, 0 done');
    expect(nextArrow()).toHaveAccessibleName('Next exercise: superset Pull-up + Push-up');
    expect(nextArrow()).toHaveTextContent('Pull-up + Push-up');
    expect(await exerciseOrder(user)).toEqual(['Dips', 'Pull-up', 'Bench Press']);
  });

  it('a session of one exercise has no arrows and no dots', () => {
    mockSessionData = loaded([SQUAT]);
    mockSetLogsData = logsRead([setLog('l-a', 'slot-a', 1)]);
    renderSessionView();
    expect(previousArrow()).toBeNull();
    expect(nextArrow()).toBeNull();
    expect(steps()).toBeNull();
    expect(shownExercise()).toBe('Squat');
  });

  it('a superset is one panel: its exercises in a switch, its sets in rounds, one note for the coach', async () => {
    const user = userEvent.setup();
    mockSessionData = loaded([
      slot('slot-a', 'Curl', { superset_group: 1 }),
      slot('slot-b', 'Skullcrusher', { sort_order: 1, superset_group: 1 }),
    ]);
    mockSetLogsData = logsRead([setLog('l-a1', 'slot-a', 1), setLog('l-b1', 'slot-b', 1)]);
    renderSessionView();

    // The panel says « Superset » and the round; the switch names both
    // exercises, the one shown pressed.
    expect(shownExercise()).toBe('Curl');
    expect(within(panel()).getByText('Superset')).toBeInTheDocument();
    expect(within(panel()).getByText('Round 1 of 1')).toBeInTheDocument();
    expect(within(supersetSwitch()).getByRole('button', { name: 'A1 Curl' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(supersetSwitch()).getByRole('button', { name: 'A2 Skullcrusher' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    // The sets in rounds, both exercises in each, named.
    const round = screen.getByRole('list', { name: 'Round 1' });
    expect(within(round).getAllByRole('listitem')).toHaveLength(2);
    expect(within(round).getByText('Curl')).toBeInTheDocument();
    expect(within(round).getByText('Skullcrusher')).toBeInTheDocument();
    expect(inBar().getByRole('button', { name: 'Validate A1' })).toBeInTheDocument();

    // The other exercise, from the switch, which keeps the focus.
    await pickInSuperset(user, 'Skullcrusher');
    expect(within(supersetSwitch()).getByRole('button', { name: 'A2 Skullcrusher' })).toHaveFocus();
    expect(inBar().getByRole('button', { name: 'Validate A2' })).toBeInTheDocument();

    // Without one note per superset, the athlete would be asked for a note
    // once per exercise of it: the note of the second exercise is the first's.
    const menu = await openExerciseMenu(user);
    await user.click(within(menu).getByRole('button', { name: 'Add a note for the coach' }));
    await user.type(screen.getByLabelText('Note for your coach'), 'Elbows hurt');
    await user.tab();
    expect(mockSaveComment).toHaveBeenCalledWith(
      { sessionId: 'sess-1', slotId: 'slot-a', body: 'Elbows hurt' },
      expect.any(Object),
    );
  });

  it('shows the note of a superset on each of its exercises', async () => {
    const user = userEvent.setup();
    mockSlotComments = [{ id: 'c-1', exercise_slot_id: 'slot-a', body: 'Elbows hurt' }];
    mockSessionData = loaded([
      slot('slot-a', 'Curl', { superset_group: 1 }),
      slot('slot-b', 'Skullcrusher', { sort_order: 1, superset_group: 1 }),
    ]);
    mockSetLogsData = logsRead([setLog('l-a1', 'slot-a', 1), setLog('l-b1', 'slot-b', 1)]);
    renderSessionView();

    expect(screen.getByRole('region', { name: 'Your note for the coach' })).toHaveTextContent('Elbows hurt');
    await pickInSuperset(user, 'Skullcrusher');
    expect(screen.getByRole('region', { name: 'Your note for the coach' })).toHaveTextContent('Elbows hurt');
  });

  // The header's grouped summary is gone: each row says its own target, and
  // the panel the figures of the set in progress.
  it('heterogeneous sets: each row says its own target, the panel the set in progress', () => {
    mockSessionData = loaded([slot('slot-1', 'Squat', { sets: 3, reps: 6, weight_kg: 100 })], { title: 'Drop Set Day' });
    const logs = [
      setLog('log-1', 'slot-1', 1, { target_reps: 6, target_weight_kg: 100 }),
      setLog('log-2', 'slot-1', 2, { target_reps: 6, target_weight_kg: 100 }),
      setLog('log-3', 'slot-1', 3, { target_reps: 8, target_weight_kg: 80 }),
    ];
    mockSetLogsData = logsRead(logs);
    const view = renderSessionView();

    expect(setRowButton(1)).toHaveTextContent('6 reps, 100 kg');
    expect(setRowButton(2)).toHaveTextContent('6 reps, 100 kg');
    expect(setRowButton(3)).toHaveTextContent('8 reps, 80 kg');
    expect(within(panel()).getByText('6')).toBeInTheDocument();
    expect(within(panel()).getByText('100')).toBeInTheDocument();

    settle(view, [
      { ...logs[0], done: true, rpe: 8 },
      { ...logs[1], done: true, rpe: 9 },
      logs[2],
    ]);
    expect(within(panel()).getByText('Set 3 of 3')).toBeInTheDocument();
    expect(within(panel()).getByText('8')).toBeInTheDocument();
    expect(within(panel()).getByText('80')).toBeInTheDocument();
  });

  it('an exercise the athlete replaced is named by its substitute, on its panel and the arrow to it', async () => {
    const user = userEvent.setup();
    mockLibrary = [{ id: 'ex-ring', name: 'Ring dip', type: 'push' }];
    mockDeviations = {
      data: [{ exercise_slot_id: 'slot-a', kind: 'swap', substitute_exercise_id: 'ex-ring' }],
      isLoading: false,
    };
    mockSessionData = loaded([SQUAT, BENCH]);
    mockSetLogsData = logsRead([setLog('l-a', 'slot-a', 1), setLog('l-b', 'slot-b', 1)]);
    renderSessionView();

    expect(shownExercise()).toBe('Ring dip');
    expect(screen.getByText('You do Ring dip instead.')).toBeInTheDocument();
    await user.click(nextArrow());
    expect(previousArrow()).toHaveAccessibleName('Previous exercise: Ring dip');
  });
});

// The ActionBar carries the one action that moves the session on: validate the
// set in progress, go to the next exercise, or confirm the session.
describe('SessionView: the main action', () => {
  const SQUAT = slot('slot-a', 'Squat');
  const BENCH = slot('slot-b', 'Bench', { sort_order: 1 });

  // A tap on « Validate set n », then the cache written as the hook writes it,
  // then the RPE sheet answered with `answer` — a rating, or its close button.
  async function validateAndAnswer(user, view, logsAfter, answer) {
    await user.click(inBar().getByRole('button', { name: /^validate (set \d+|[A-Z]\d)$/i }));
    settle(view, logsAfter);
    await user.click(within(rpeSheet()).getByRole('button', { name: answer }));
  }

  it('validates the set in progress — the first set of the exercise with no outcome — and asks its RPE', async () => {
    const user = userEvent.setup();
    mockSessionData = loaded([slot('slot-1', 'Squat', { sets: 4 })]);
    mockSetLogsData = logsRead([
      setLog('l-1', 'slot-1', 1, { done: true, rpe: 8 }),
      setLog('l-2', 'slot-1', 2, { failed: true }),
      setLog('l-3', 'slot-1', 3, { skipped: true }),
      setLog('l-4', 'slot-1', 4),
    ]);
    renderSessionView();

    expect(within(panel()).getByText('Set 4 of 4')).toBeInTheDocument();
    expect(setRowButton(4)).toHaveTextContent('In progress');
    await user.click(inBar().getByRole('button', { name: 'Validate set 4' }));

    expect(mockToggleDone).toHaveBeenCalledTimes(1);
    expect(mockToggleDone).toHaveBeenCalledWith({ logId: 'l-4', done: true });
    // The RPE sheet opens on the set just validated: 6 to 10 in half steps,
    // none chosen yet.
    const sheetOfSet = rpeSheet();
    expect(sheetOfSet).toHaveAccessibleName('RPE of set 4');
    const ratings = within(sheetOfSet).getAllByRole('button', { name: /^RPE / });
    expect(ratings.map((b) => b.textContent)).toEqual(['6', '6.5', '7', '7.5', '8', '8.5', '9', '9.5', '10']);
    for (const rating of ratings) expect(rating).toHaveAttribute('aria-pressed', 'false');
    expect(within(sheetOfSet).getByRole('button', { name: 'Close without RPE' })).toBeInTheDocument();
  });

  it('a rating is written, closes the sheet, and the screen moves on to the next exercise', async () => {
    const user = userEvent.setup();
    mockSessionData = loaded([SQUAT, BENCH]);
    mockSetLogsData = logsRead([setLog('l-1', 'slot-a', 1), setLog('l-2', 'slot-b', 1)]);
    const view = renderSessionView();

    await validateAndAnswer(
      user,
      view,
      [setLog('l-1', 'slot-a', 1, { done: true }), setLog('l-2', 'slot-b', 1)],
      'RPE 7.5',
    );

    // The set was done at the tap; the rating is a write of its own.
    expect(mockSetRpe).toHaveBeenCalledWith({ logId: 'l-1', rpe: 7.5 });
    expect(rpeSheet()).toBeNull();
    expect(shownExercise()).toBe('Bench');
    expect(steps()).toHaveAccessibleName('Exercise 2 of 2, 1 done');
    expect(inBar().getByRole('button', { name: 'Validate set 1' })).toBeInTheDocument();
  });

  it('closing the RPE sheet writes no rating, and moves on too', async () => {
    const user = userEvent.setup();
    mockSessionData = loaded([SQUAT, BENCH]);
    mockSetLogsData = logsRead([setLog('l-1', 'slot-a', 1), setLog('l-2', 'slot-b', 1)]);
    const view = renderSessionView();

    await validateAndAnswer(
      user,
      view,
      [setLog('l-1', 'slot-a', 1, { done: true }), setLog('l-2', 'slot-b', 1)],
      'Close without RPE',
    );

    expect(mockSetRpe).not.toHaveBeenCalled();
    expect(rpeSheet()).toBeNull();
    expect(shownExercise()).toBe('Bench');
  });

  it('stays on an exercise that still has sets to do', async () => {
    const user = userEvent.setup();
    mockSessionData = loaded([slot('slot-a', 'Squat', { sets: 2 }), BENCH]);
    mockSetLogsData = logsRead([setLog('a-1', 'slot-a', 1), setLog('a-2', 'slot-a', 2), setLog('b-1', 'slot-b', 1)]);
    const view = renderSessionView();

    await validateAndAnswer(
      user,
      view,
      [setLog('a-1', 'slot-a', 1, { done: true }), setLog('a-2', 'slot-a', 2), setLog('b-1', 'slot-b', 1)],
      'RPE 8',
    );

    expect(shownExercise()).toBe('Squat');
    expect(within(panel()).getByText('Set 2 of 2')).toBeInTheDocument();
    expect(inBar().getByRole('button', { name: 'Validate set 2' })).toBeInTheDocument();
  });

  // The exercises of a superset are done in turn: a set of one, then a set of
  // the other. The screen goes to the partner after each RPE, and leaves the
  // superset once both are finished.
  it('alternates between the exercises of a superset, then leaves it', async () => {
    const user = userEvent.setup();
    mockSessionData = loaded([
      slot('slot-a', 'Curl', { sets: 2, superset_group: 1 }),
      slot('slot-b', 'Skullcrusher', { sets: 2, sort_order: 1, superset_group: 1 }),
      slot('slot-c', 'Row', { sort_order: 2 }),
    ]);
    const a1 = setLog('a-1', 'slot-a', 1);
    const a2 = setLog('a-2', 'slot-a', 2);
    const b1 = setLog('b-1', 'slot-b', 1);
    const b2 = setLog('b-2', 'slot-b', 2);
    const c1 = setLog('c-1', 'slot-c', 1);
    const done = (log) => ({ ...log, done: true });
    mockSetLogsData = logsRead([a1, a2, b1, b2, c1]);
    const view = renderSessionView();
    expect(shownExercise()).toBe('Curl');

    await validateAndAnswer(user, view, [done(a1), a2, b1, b2, c1], 'RPE 8');
    expect(mockToggleDone).toHaveBeenLastCalledWith({ logId: 'a-1', done: true });
    expect(shownExercise()).toBe('Skullcrusher');
    expect(within(panel()).getByText('Round 1 of 2')).toBeInTheDocument();
    expect(inBar().getByRole('button', { name: 'Validate A2' })).toBeInTheDocument();

    await validateAndAnswer(user, view, [done(a1), a2, done(b1), b2, c1], 'Close without RPE');
    expect(mockToggleDone).toHaveBeenLastCalledWith({ logId: 'b-1', done: true });
    expect(shownExercise()).toBe('Curl');
    expect(within(panel()).getByText('Round 2 of 2')).toBeInTheDocument();
    expect(inBar().getByRole('button', { name: 'Validate A1' })).toBeInTheDocument();

    await validateAndAnswer(user, view, [done(a1), done(a2), done(b1), b2, c1], 'RPE 8');
    expect(shownExercise()).toBe('Skullcrusher');
    expect(inBar().getByRole('button', { name: 'Validate A2' })).toBeInTheDocument();

    await validateAndAnswer(user, view, [done(a1), done(a2), done(b1), done(b2), c1], 'RPE 9');
    expect(shownExercise()).toBe('Row');
    expect(inBar().getByRole('button', { name: 'Validate set 1' })).toBeInTheDocument();
  });

  it('a finished exercise offers to go to the next one with a set to do', async () => {
    const user = userEvent.setup();
    mockSessionData = loaded([SQUAT, BENCH]);
    mockSetLogsData = logsRead([setLog('l-1', 'slot-a', 1, { done: true, rpe: 8 }), setLog('l-2', 'slot-b', 1)]);
    renderSessionView();
    expect(shownExercise()).toBe('Bench');

    await goToExercise(user, 'Squat');
    expect(within(panel()).getByText('Exercise done')).toBeInTheDocument();
    expect(validateButton()).toBeNull();

    await user.click(inBar().getByRole('button', { name: 'Go to Bench' }));
    expect(shownExercise()).toBe('Bench');
    expect(inBar().getByRole('button', { name: 'Validate set 1' })).toBeInTheDocument();
  });

  // One way to confirm at a time: « Finish the session now » in the « ⋯ » of
  // the title while sets are left — confirming early is possible, not the next
  // step — and the ActionBar's « Confirm session » once every set is dealt
  // with.
  it('while sets are left, the « ⋯ » of the title offers to finish now, and the ActionBar validates', async () => {
    const user = userEvent.setup();
    mockSessionData = loaded([slot('slot-a', 'Squat', { sets: 2 })]);
    mockSetLogsData = logsRead([setLog('a-1', 'slot-a', 1, { done: true, rpe: 8 }), setLog('a-2', 'slot-a', 2)]);
    renderSessionView();

    expect(confirmButtons()).toHaveLength(0);
    expect(inBar().getByRole('button', { name: 'Validate set 2' })).toBeInTheDocument();

    await openSessionMenu(user);
    expect(finishNowItem()).toHaveTextContent('1 set left');
    await user.click(finishNowItem());
    expect(sheet('Session options')).toBeNull();
    expect(within(sheet('Confirm the session')).getByText('1 of 2 sets logged')).toBeInTheDocument();
  });

  it('once every set is dealt with, the ActionBar carries "Confirm session", and only the ActionBar', async () => {
    const user = userEvent.setup();
    mockSessionData = loaded([SQUAT, BENCH]);
    mockSetLogsData = logsRead([
      setLog('l-1', 'slot-a', 1, { done: true, rpe: 8 }),
      setLog('l-2', 'slot-b', 1, { skipped: true }),
    ]);
    renderSessionView();

    expect(confirmButtons()).toHaveLength(1);
    expect(actionBar()).toContainElement(confirmButton());
    expect(sessionMenu()).toBeNull();
    expect(validateButton()).toBeNull();
    expect(screen.queryByRole('button', { name: /^go to/i })).toBeNull();

    await openConfirm(user);
    expect(sheet('Confirm the session')).toBeInTheDocument();
  });

  // The main action follows the sets: a set put back to pending (an Undo) is
  // to validate again, and a session whose last set is dealt with is to
  // confirm — whichever way the cache changed.
  it('follows the sets as they change', () => {
    mockSessionData = loaded([SQUAT]);
    mockSetLogsData = logsRead([setLog('l-1', 'slot-a', 1, { done: true, rpe: 8 })]);
    const view = renderSessionView();
    expect(inBar().getByRole('button', { name: /^confirm session$/i })).toBeInTheDocument();

    settle(view, [setLog('l-1', 'slot-a', 1)]);
    expect(inBar().getByRole('button', { name: 'Validate set 1' })).toBeInTheDocument();
    expect(actionBar()).not.toContainElement(confirmButton());

    settle(view, [setLog('l-1', 'slot-a', 1, { done: true, rpe: 8 })]);
    expect(inBar().getByRole('button', { name: /^confirm session$/i })).toBeInTheDocument();
    expect(validateButton()).toBeNull();
  });

  // P61. An extra set has no prescription: it says what was done, or it is
  // not done. « Validate » opens its sheet instead of writing anything, with
  // its fields seeded by the set before it, as it was done.
  it('an extra set that does not say what was done opens its sheet instead of being validated', async () => {
    const user = userEvent.setup();
    mockSessionData = loaded([slot('slot-1', 'Squat')]);
    mockSetLogsData = logsRead([
      setLog('l-1', 'slot-1', 1, { done: true, rpe: 8, target_reps: 5, target_weight_kg: 60 }),
      setLog('l-2', 'slot-1', 2, { is_student_added: true, target_reps: null, target_weight_kg: null }),
    ]);
    renderSessionView();

    expect(setRowButton(2)).toHaveTextContent('Set 2, added');
    expect(setRowButton(2)).toHaveTextContent('Say what you did');
    await user.click(inBar().getByRole('button', { name: 'Validate set 2' }));

    expect(mockToggleDone).not.toHaveBeenCalled();
    expect(rpeSheet()).toBeNull();
    const sheetOfSet = within(sheet('Set 2, added'));
    expect(sheetOfSet.getByRole('textbox', { name: 'Reps' })).toHaveValue('5');
    expect(sheetOfSet.getByRole('textbox', { name: 'Load in kg' })).toHaveValue('60');

    // Saved, it is done in the same write, and its RPE is asked.
    await user.click(sheetOfSet.getByRole('button', { name: 'Validate set 2' }));
    expect(mockLogActual).toHaveBeenCalledWith({ logId: 'l-2', actualReps: 5, actualWeightKg: 60, done: true });
    expect(sheet('Set 2, added')).toBeNull();
    expect(rpeSheet()).toHaveAccessibleName('RPE of set 2');
  });

  it('a tap on a row opens the sheet of that set', async () => {
    const user = userEvent.setup();
    mockSessionData = loaded([slot('slot-1', 'Squat', { sets: 2 })]);
    mockSetLogsData = logsRead([
      setLog('l-1', 'slot-1', 1, { done: true, rpe: 7.5, target_reps: 5, target_weight_kg: 20 }),
      setLog('l-2', 'slot-1', 2),
    ]);
    renderSessionView();

    expect(setRowButton(1)).toHaveTextContent('RPE 7.5');
    await user.click(setRowButton(1));
    const sheetOfSet = within(sheet('Set 1, done'));
    expect(sheetOfSet.getByRole('textbox', { name: 'Reps' })).toHaveValue('5');
    expect(sheetOfSet.getByRole('textbox', { name: 'Load in kg' })).toHaveValue('20');
    expect(sheetOfSet.getByRole('button', { name: 'RPE 7.5' })).toHaveAttribute('aria-pressed', 'true');
    // A done set is saved, not validated again.
    expect(sheetOfSet.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  // A long press marks a set failed — never a tap — with an Undo in a toast.
  // The exercise stays on the screen: following "the first exercise with a set
  // to do" would take it away, and the set its Undo brings back with it.
  it('a long press marks the set failed, offers Undo, and keeps its exercise on the screen', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-17T10:00:00Z') });
    mockSessionData = loaded([SQUAT, BENCH]);
    mockSetLogsData = logsRead([setLog('l-1', 'slot-a', 1, { target_rest_seconds: 90 }), setLog('l-2', 'slot-b', 1)]);
    const view = renderSessionView();

    // The context menu is the long press for those who cannot hold.
    fireEvent.contextMenu(setRowButton(1));
    expect(mockSetFailed).toHaveBeenCalledWith({ logId: 'l-1', failed: true });
    expect(mockToggleDone).not.toHaveBeenCalled();
    // A failed set is rested like a done one.
    expect(screen.getByRole('timer', { name: 'Rest, 1:30 left' })).toBeInTheDocument();
    const toast = getToasts().at(-1);
    expect(toast.message).toBe('Set 1 marked failed.');
    expect(toast.action.label).toBe('uiSharedHelpers.undo');

    settle(view, [setLog('l-1', 'slot-a', 1, { failed: true, target_rest_seconds: 90 }), setLog('l-2', 'slot-b', 1)]);
    expect(shownExercise()).toBe('Squat');
    expect(setRowButton(1)).toHaveTextContent('Set 1, failed');
    expect(inBar().getByRole('button', { name: 'Go to Bench' })).toBeInTheDocument();

    // Undo: the set is pending again, and the rest it started is over.
    act(() => toast.action.onClick());
    expect(mockSetFailed).toHaveBeenLastCalledWith({ logId: 'l-1', failed: false });
    expect(mockToggleDone).not.toHaveBeenCalled();
    expect(screen.queryByRole('timer')).toBeNull();
  });

  it('"Add a set" adds the set after the last one of the exercise shown', async () => {
    const user = userEvent.setup();
    mockSessionData = loaded([SQUAT, slot('slot-b', 'Bench', { sets: 2, sort_order: 1 })]);
    mockSetLogsData = logsRead([
      setLog('a-1', 'slot-a', 1, { done: true, rpe: 8 }),
      setLog('b-1', 'slot-b', 1),
      setLog('b-2', 'slot-b', 2),
    ]);
    renderSessionView();
    expect(shownExercise()).toBe('Bench');

    await user.click(screen.getByRole('button', { name: 'Add a set' }));
    expect(mockAddSet).toHaveBeenCalledWith({ slotId: 'slot-b', setNumber: 3 });
  });

  // The insert is online-only: a set added without a network would wait,
  // stored nowhere.
  it('offline, says that adding a set needs a connection', () => {
    mockOnline = false;
    mockSessionData = loaded([SQUAT]);
    mockSetLogsData = logsRead([setLog('a-1', 'slot-a', 1)]);
    renderSessionView();
    expect(screen.queryByRole('button', { name: 'Add a set' })).toBeNull();
    expect(screen.getByText('Connect to add a set.')).toBeInTheDocument();
  });
});

// The rest that is running is in the ActionBar, at the left of the main
// action: the time left, and « +30 s ». The clock is frozen, so the time left
// is the time the rest was started for.
describe('SessionView: the rest in the ActionBar', () => {
  const SQUAT = slot('slot-a', 'Squat', { sets: 2 });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-17T10:00:00Z') });
    mockSessionData = loaded([SQUAT]);
    mockSetLogsData = logsRead([
      setLog('l-1', 'slot-a', 1, { target_rest_seconds: 90 }),
      setLog('l-2', 'slot-a', 2, { target_rest_seconds: 90 }),
    ]);
  });

  it('validating a set starts the rest prescribed after it, shown in the ActionBar', () => {
    renderSessionView();
    expect(screen.queryByRole('timer')).toBeNull();

    fireEvent.click(inBar().getByRole('button', { name: 'Validate set 1' }));

    const timer = inBar().getByRole('timer');
    expect(timer).toHaveAccessibleName('Rest, 1:30 left');
    expect(timer).toHaveTextContent('1:30');
    expect(inBar().getByRole('button', { name: 'Add 30 seconds of rest' })).toHaveTextContent('+30 s');
  });

  it('shows a rest that runs, whoever started it, and "+30 s" adds 30 seconds to it', () => {
    startRestTimer('l-1', 45);
    renderSessionView();
    expect(inBar().getByRole('timer')).toHaveAccessibleName('Rest, 0:45 left');

    fireEvent.click(inBar().getByRole('button', { name: 'Add 30 seconds of rest' }));
    expect(inBar().getByRole('timer')).toHaveAccessibleName('Rest, 1:15 left');

    fireEvent.click(inBar().getByRole('button', { name: 'Add 30 seconds of rest' }));
    expect(inBar().getByRole('timer')).toHaveAccessibleName('Rest, 1:45 left');
  });

  it('shows nothing once the rest is over', () => {
    startRestTimer('l-1', 45);
    vi.setSystemTime(new Date('2026-10-17T10:01:00Z'));
    renderSessionView();
    expect(screen.queryByRole('timer')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add 30 seconds of rest' })).toBeNull();
    // The main action stays.
    expect(inBar().getByRole('button', { name: 'Validate set 1' })).toBeInTheDocument();
  });

  it('is not shown on a session whose sets are locked', () => {
    startRestTimer('l-1', 45);
    mockConfirmation = { data: CONFIRMED, isLoading: false };
    renderSessionView();
    expect(screen.queryByRole('timer')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add 30 seconds of rest' })).toBeNull();
  });
});

// Lock after review (review finding P57, the athlete's half). Once
// `sessions.reviewed_at` is set, what the athlete logged has to stay what the
// coach read: the session is read-only and its confirmation can no longer be
// undone. There is no reopening in the app, so the page says why and links to
// the thread with the coach.
describe('SessionView: a session the coach has reviewed', () => {
  const REVIEWED_AT = '2026-04-15T09:00:00Z';
  const CONFIRMATION = CONFIRMED;
  const SLOT = slot('slot-1', 'Squat');
  // Pending, so its exercise is the one the page opens by itself.
  const PENDING_LOG = setLog('l-1', 'slot-1', 1);

  function session(fields = {}) {
    return loaded([], fields);
  }

  const lockLine = () => screen.queryByText(/reviewed by your coach/i);
  const coachLink = () => screen.queryByRole('link', { name: /message your coach/i });
  const undoButton = () => screen.queryByRole('button', { name: /undo confirmation/i });

  describe('confirmed', () => {
    beforeEach(() => {
      mockConfirmation = { data: CONFIRMATION, isLoading: false };
    });

    it('says the coach has reviewed it and links to the thread, where Undo was', () => {
      mockSessionData = session({ reviewed_at: REVIEWED_AT });
      renderSessionView();

      expect(screen.getByText(/session confirmed/i)).toBeInTheDocument();
      expect(undoButton()).toBeNull();
      expect(lockLine()).toHaveTextContent(/this session can no longer change/i);
      expect(coachLink()).toHaveAttribute('href', '/student/messages');
      // Nothing to confirm a second time.
      expect(confirmOffered()).toBe(false);
    });

    it('still offers Undo while the session is not reviewed', () => {
      mockSessionData = session({ reviewed_at: null });
      renderSessionView();

      expect(undoButton()).toBeInTheDocument();
      expect(lockLine()).toBeNull();
      expect(coachLink()).toBeNull();
    });

    // A confirmed session already has its sets locked; the note for the coach
    // is what a review closes on top of that.
    it('closes the note for the coach, which a confirmation alone leaves open', async () => {
      const user = userEvent.setup();
      mockSetLogsData = logsRead([PENDING_LOG]);

      mockSessionData = session({ exercise_slots: [SLOT], reviewed_at: null });
      const open = renderSessionView();
      const menu = await openExerciseMenu(user);
      expect(within(menu).getByRole('button', { name: /add a note for the coach/i })).toBeInTheDocument();
      open.unmount();

      // Nothing left in the exercise's menu: no « ⋯ » at all.
      mockSessionData = session({ exercise_slots: [SLOT], reviewed_at: REVIEWED_AT });
      renderSessionView();
      expect(exerciseMenu()).toBeNull();
    });

    it('keeps the line of a past program or an archived session, which no coach can lift', () => {
      mockSessionData = session({ reviewed_at: REVIEWED_AT, program_is_active: false });
      const past = renderSessionView();
      expect(screen.getByText('From a past block. The confirmation can no longer change.')).toBeInTheDocument();
      expect(lockLine()).toBeNull();
      expect(coachLink()).toBeNull();
      expect(undoButton()).toBeNull();
      past.unmount();

      mockSessionData = session({ reviewed_at: REVIEWED_AT, archived_at: '2026-04-20T10:00:00Z' });
      renderSessionView();
      expect(screen.getByText('Archived by your coach. The confirmation can no longer change.')).toBeInTheDocument();
      expect(lockLine()).toBeNull();
      expect(coachLink()).toBeNull();
      expect(undoButton()).toBeNull();
    });
  });

  // Sessions reviewed without a confirmation, or whose confirmation was undone
  // after the review, exist from before the two were tied together.
  describe('not confirmed', () => {
    it('is read-only: no set, RPE, extra set, swap, skip or note can be written', () => {
      mockSetLogsData = logsRead([PENDING_LOG]);
      mockSessionData = session({ exercise_slots: [SLOT], reviewed_at: REVIEWED_AT });
      renderSessionView();

      // The set is shown, as a row that opens nothing and holds nothing: no
      // sheet, so no actual value and no RPE.
      expect(within(setList()).getAllByRole('listitem')).toHaveLength(1);
      expect(setRow(1)).toHaveTextContent('5 reps, 50 kg');
      expect(setRowButton(1)).toBeNull();
      expect(holdHint()).toBeNull();
      expect(validateButton()).toBeNull();
      expect(screen.queryByRole('button', { name: 'Add a set' })).toBeNull();
      // No swap, skip or note: the exercise's menu has nothing to offer.
      expect(exerciseMenu()).toBeNull();
    });

    it('the same session, not reviewed, offers all of them', async () => {
      const user = userEvent.setup();
      mockSetLogsData = logsRead([PENDING_LOG]);
      mockSessionData = session({ exercise_slots: [SLOT], reviewed_at: null });
      renderSessionView();

      expect(inBar().getByRole('button', { name: 'Validate set 1' })).toBeEnabled();
      expect(setRowButton(1)).toBeEnabled();
      expect(holdHint()).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Add a set' })).toBeInTheDocument();
      expect(lockLine()).toBeNull();
      const menu = await openExerciseMenu(user);
      for (const name of ['Replace the exercise', 'Skip the exercise', 'Add a note for the coach']) {
        expect(within(menu).getByRole('button', { name })).toBeInTheDocument();
      }
      await user.keyboard('{Escape}');

      // The row opens the set's sheet: what was actually done, and the RPE.
      await user.click(setRowButton(1));
      const sheetOfSet = within(sheet('Set 1'));
      expect(sheetOfSet.getByRole('textbox', { name: 'Reps' })).toBeEnabled();
      expect(sheetOfSet.getByRole('button', { name: 'RPE 8' })).toBeEnabled();
    });

    // The video of a set is part of what the coach read. Its row still opens
    // the set's sheet — the one thing left to do is to watch it.
    it('keeps the video the coach saw: it plays, and cannot be replaced or deleted', async () => {
      const user = userEvent.setup();
      const slotWithVideo = { ...SLOT, record_video_set_numbers: [1] };
      mockSetLogsData = logsRead([PENDING_LOG]);
      mockVideos = {
        data: [{ id: 'v-1', set_log_id: 'l-1', storage_path: 'u-1/slot-1/1.mp4' }],
        isLoading: false,
      };

      mockSessionData = session({ exercise_slots: [slotWithVideo], reviewed_at: null });
      const open = renderSessionView();
      expect(setRowButton(1)).toHaveTextContent('video sent');
      await user.click(setRowButton(1));
      let sheetOfSet = within(sheet('Set 1'));
      expect(sheetOfSet.getByRole('button', { name: 'Replace the video' })).toBeEnabled();
      expect(sheetOfSet.getByRole('button', { name: 'Delete the video' })).toBeEnabled();
      open.unmount();

      mockSessionData = session({ exercise_slots: [slotWithVideo], reviewed_at: REVIEWED_AT });
      renderSessionView();
      await user.click(setRowButton(1));
      sheetOfSet = within(sheet('Set 1'));
      expect(sheetOfSet.getByRole('button', { name: 'Watch the video' })).toBeEnabled();
      expect(sheetOfSet.getByRole('button', { name: 'Replace the video' })).toBeDisabled();
      expect(sheetOfSet.getByRole('button', { name: 'Delete the video' })).toBeDisabled();
      // Nothing else of the set is offered.
      expect(sheetOfSet.queryByRole('textbox')).toBeNull();
      expect(sheetOfSet.queryByRole('button', { name: /^RPE / })).toBeNull();
    });

    // Confirming is the one thing left: without it the session would stay
    // "Next" in the training list for good.
    it('says why, links to the thread, and can still be confirmed', async () => {
      const user = userEvent.setup();
      mockSessionData = session({ reviewed_at: REVIEWED_AT });
      renderSessionView();

      expect(lockLine()).toHaveTextContent(/your sets can no longer change/i);
      expect(lockLine()).toHaveTextContent(/you can still confirm the session/i);
      expect(coachLink()).toHaveAttribute('href', '/student/messages');

      await openConfirm(user);
      await user.click(screen.getByRole('button', { name: /^confirm$/i }));
      expect(mockConfirm.mutate).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'sess-1' }),
        expect.any(Object)
      );
    });

    it('keeps the read-only line of an archived session, and offers no confirmation there', () => {
      mockSessionData = session({ reviewed_at: REVIEWED_AT, archived_at: '2026-04-20T10:00:00Z' });
      renderSessionView();

      expect(screen.getByText('Archived by your coach, read only.')).toBeInTheDocument();
      expect(lockLine()).toBeNull();
      expect(coachLink()).toBeNull();
      expect(confirmOffered()).toBe(false);
    });
  });

  // A prescribed set without its row is added by the database, through
  // useEnsureSetLogs. The page hands the hook what it shows and says whether
  // it may ask: on a reviewed session those would be sets the coach never
  // read, and the function refuses a session that is closed.
  describe('missing set rows', () => {
    const handedOver = () => mockEnsureSetLogs.mock.calls.at(-1);

    it('are left to the hook, with the session, its exercises and the sets the page has read', () => {
      mockSetLogsData = logsRead([PENDING_LOG]);
      mockSessionData = session({ exercise_slots: [SLOT], reviewed_at: null });
      renderSessionView();
      expect(handedOver()).toEqual(['sess-1', [SLOT], [PENDING_LOG], { enabled: true }]);
    });

    it('are not asked for on a reviewed session', () => {
      mockSetLogsData = logsRead([PENDING_LOG]);
      mockSessionData = session({ exercise_slots: [SLOT], reviewed_at: REVIEWED_AT });
      renderSessionView();
      expect(handedOver()[3]).toEqual({ enabled: false });
    });

    it('nor on a session of a past program, nor on an archived one', () => {
      mockSetLogsData = logsRead([PENDING_LOG]);
      mockSessionData = session({ exercise_slots: [SLOT], program_is_active: false });
      renderSessionView().unmount();
      expect(handedOver()[3]).toEqual({ enabled: false });

      mockSessionData = session({ exercise_slots: [SLOT], archived_at: '2026-04-20T10:00:00Z' });
      renderSessionView();
      expect(handedOver()[3]).toEqual({ enabled: false });
    });

    // "Missing" is counted on the session and its sets: while one of the two
    // is being read again, the other may be the older copy.
    it('nor while the session or its sets are being read again', () => {
      mockSetLogsData = logsRead([PENDING_LOG]);
      mockSessionData = { ...session({ exercise_slots: [SLOT] }), isFetching: true };
      renderSessionView().unmount();
      expect(handedOver()[3]).toEqual({ enabled: false });

      mockSessionData = session({ exercise_slots: [SLOT] });
      mockSetLogsData = logsRead([PENDING_LOG], { isFetching: true });
      const view = renderSessionView();
      expect(handedOver()[3]).toEqual({ enabled: false });

      // Both have answered.
      mockSetLogsData = logsRead([PENDING_LOG], { isFetching: false });
      rerenderSessionView(view);
      expect(handedOver()[3]).toEqual({ enabled: true });
    });
  });

  // `reviewed_at` comes from a cached row and nothing pushes a review to the
  // athlete's device, so "not reviewed" is only as true as the row is recent.
  // The page asks for the row again when a review may have happened behind it.
  describe('how the page learns of a review', () => {
    it('asks for the row again when it opens on a confirmed session', () => {
      mockConfirmation = { data: CONFIRMATION, isLoading: false };
      mockSessionData = session({ reviewed_at: null });
      const view = renderSessionView();

      expect(mockRefetchSession).toHaveBeenCalledTimes(1);
      // Joins a request already on its way instead of cancelling it.
      expect(mockRefetchSession).toHaveBeenCalledWith({ cancelRefetch: false });

      // An answer that still says "not reviewed" stands: no second request.
      rerenderSessionView(view);
      expect(mockRefetchSession).toHaveBeenCalledTimes(1);
    });

    it("asks again when the coach's feedback arrives", () => {
      mockSessionData = session({ reviewed_at: null });
      const view = renderSessionView();
      expect(mockRefetchSession).not.toHaveBeenCalled();

      mockFeedback = {
        data: { id: 'msg-1', body: 'Good work.', created_at: REVIEWED_AT },
      };
      rerenderSessionView(view);
      expect(mockRefetchSession).toHaveBeenCalledTimes(1);

      // The answer: the feedback reviewed the session.
      mockSessionData = session({ reviewed_at: REVIEWED_AT });
      rerenderSessionView(view);
      expect(lockLine()).toBeInTheDocument();
      expect(mockRefetchSession).toHaveBeenCalledTimes(1);
    });

    it('does not ask for a session in progress', () => {
      mockSetLogsData = logsRead([PENDING_LOG]);
      mockSessionData = session({ exercise_slots: [SLOT], reviewed_at: null });
      renderSessionView();
      expect(mockRefetchSession).not.toHaveBeenCalled();
    });

    it('does not ask once the session is reviewed, or closed for another reason', () => {
      mockConfirmation = { data: CONFIRMATION, isLoading: false };
      mockFeedback = {
        data: { id: 'msg-1', body: 'Good work.', created_at: REVIEWED_AT },
      };

      mockSessionData = session({ reviewed_at: REVIEWED_AT });
      renderSessionView().unmount();
      mockSessionData = session({ reviewed_at: null, program_is_active: false });
      renderSessionView().unmount();
      mockSessionData = session({ reviewed_at: null, archived_at: '2026-04-20T10:00:00Z' });
      renderSessionView().unmount();

      expect(mockRefetchSession).not.toHaveBeenCalled();
    });

    // A review without feedback sends nothing that would refresh the row, so
    // the tap on Undo asks too — and the sheet does not outlive the answer.
    it('asks once more on a tap on Undo, and a "reviewed" answer takes the sheet away', async () => {
      const user = userEvent.setup();
      mockConfirmation = { data: CONFIRMATION, isLoading: false };
      mockSessionData = session({ reviewed_at: null });
      const view = renderSessionView();
      expect(mockRefetchSession).toHaveBeenCalledTimes(1);

      await user.click(undoButton());
      expect(mockRefetchSession).toHaveBeenCalledTimes(2);
      expect(mockRefetchSession).toHaveBeenLastCalledWith({ cancelRefetch: false });
      const dialog = sheet('Undo the confirmation?');
      expect(within(dialog).getByRole('button', { name: /undo confirmation/i })).toBeInTheDocument();

      mockSessionData = session({ reviewed_at: REVIEWED_AT });
      rerenderSessionView(view);

      expect(dialog.open).toBe(false);
      expect(within(dialog).queryByRole('button', { name: /undo confirmation/i, hidden: true })).toBeNull();
      expect(undoButton()).toBeNull();
      expect(lockLine()).toBeInTheDocument();
      expect(mockUnconfirm.mutate).not.toHaveBeenCalled();
    });
  });
});

// The page is made of two reads — the session, and its sets — and both reach
// it through a cache the device keeps. Opened in a gym on a session that is not
// on the device, neither answers. That used to be rendered as an empty
// session: a page titled "Session", no exercise, and a live "Confirm session"
// (live item N1). What each state of the two reads looks like is here; that
// the real reads get into those states is in SessionView.offline.test.jsx.
describe('SessionView: a session whose reads did not answer', () => {
  const SLOT = slot('slot-1', 'Squat');
  const LOG = setLog('l-1', 'slot-1', 1);

  // A read as useQuery reports it, without data.
  const waiting = { data: undefined, isLoading: false, fetchStatus: 'paused', isPaused: true };
  const failed = { data: undefined, isLoading: false, fetchStatus: 'idle', isError: true };
  const onItsWay = { data: undefined, isLoading: true, fetchStatus: 'fetching' };
  // The sets are not asked for while the session has no exercise to show.
  const notAsked = { data: undefined, isLoading: false, fetchStatus: 'idle' };
  const loadedPullA = (fields = {}) => loaded([SLOT], { title: 'Pull A', ...fields });

  const retryButton = () => screen.queryByRole('button', { name: /try again/i });
  const notOnDevice = () => screen.queryByText(/this session isn’t on this device yet/i);
  const notLoaded = () => screen.queryByText(/this session couldn’t be loaded/i);

  beforeEach(() => {
    mockSessionData = loadedPullA();
    mockSetLogsData = logsRead([LOG]);
  });

  it('without a network and with nothing on the device: says so, and offers nothing to confirm', () => {
    mockOnline = false;
    mockSessionData = waiting;
    mockSetLogsData = notAsked;
    // The confirmation was never read either, and waits like the rest.
    mockConfirmation = { data: undefined, isLoading: false };
    renderSessionView();

    expect(notOnDevice()).toBeInTheDocument();
    expect(screen.getByText('It will show as soon as you are online.')).toBeInTheDocument();
    expect(retryButton()).toBeInTheDocument();
    // The page keeps its title and its way back…
    expect(screen.getByRole('heading', { level: 1, name: 'Session' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back to training' })).toBeInTheDocument();
    // …and nothing that speaks for a session it does not have.
    expect(confirmOffered()).toBe(false);
    expect(actionBar()).toBeNull();
    expect(screen.queryByText(/of \d+ sets done/i)).toBeNull();
    expect(screen.queryByRole('status', { name: /loading/i })).toBeNull();
  });

  // A client that pauses its reads without a network says "paused" before the
  // device says "offline", and one that attempted the read ends on an error
  // while the device is offline: both are the same thing to the athlete.
  it('is the same message whether the read waits or was attempted and failed', () => {
    mockSessionData = waiting;
    mockSetLogsData = notAsked;
    const paused = renderSessionView();
    expect(notOnDevice()).toBeInTheDocument();
    expect(confirmOffered()).toBe(false);
    paused.unmount();

    mockOnline = false;
    mockSessionData = failed;
    renderSessionView();
    expect(notOnDevice()).toBeInTheDocument();
    expect(notLoaded()).toBeNull();
    expect(confirmOffered()).toBe(false);
  });

  it('on a network, a read that failed: says it could not be loaded, and "Try again" asks for it', async () => {
    const user = userEvent.setup();
    mockSessionData = failed;
    mockSetLogsData = notAsked;
    renderSessionView();

    expect(notLoaded()).toBeInTheDocument();
    expect(screen.getByText('Check your connection and try again.')).toBeInTheDocument();
    expect(notOnDevice()).toBeNull();
    expect(confirmOffered()).toBe(false);

    await user.click(retryButton());
    // Joins a request already on its way instead of starting a second one.
    expect(mockRefetchSession).toHaveBeenCalledTimes(1);
    expect(mockRefetchSession).toHaveBeenCalledWith({ cancelRefetch: false });
    // No exercise is known: there are no sets to ask for.
    expect(mockRefetchLogs).not.toHaveBeenCalled();
  });

  // The session row is there and its sets are not: the exercises with no set
  // under them, and a confirmation of nothing, are not the session either.
  it('the session without its sets is not shown as exercises without sets', async () => {
    const user = userEvent.setup();
    mockOnline = false;
    mockSetLogsData = waiting;
    renderSessionView();

    expect(notOnDevice()).toBeInTheDocument();
    // What is known is said: the title of the session.
    expect(screen.getByRole('heading', { level: 1, name: 'Pull A' })).toBeInTheDocument();
    expect(screen.queryByText('Squat')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Set in progress' })).toBeNull();
    expect(confirmOffered()).toBe(false);

    await user.click(retryButton());
    expect(mockRefetchSession).toHaveBeenCalledWith({ cancelRefetch: false });
    expect(mockRefetchLogs).toHaveBeenCalledWith({ cancelRefetch: false });
  });

  it('holds its spinner while a read is on its way, and while the cache is read back from the device', () => {
    mockSessionData = onItsWay;
    mockSetLogsData = notAsked;
    const session = renderSessionView();
    expect(screen.getByRole('status')).toHaveAccessibleName(/loading/i);
    session.unmount();

    mockSessionData = loadedPullA();
    mockSetLogsData = onItsWay;
    const sets = renderSessionView();
    expect(screen.getByRole('status')).toHaveAccessibleName(/loading/i);
    expect(retryButton()).toBeNull();
    sets.unmount();

    // At launch, before IndexedDB has answered: no read holds data and none
    // was sent, on a device that may hold the whole session.
    mockOnline = false;
    mockSessionData = notAsked;
    mockSetLogsData = notAsked;
    render(
      <IsRestoringProvider value={true}>
        <MemoryRouter>
          <SessionView />
        </MemoryRouter>
      </IsRestoringProvider>
    );
    expect(screen.getByRole('status')).toHaveAccessibleName(/loading/i);
    expect(notOnDevice()).toBeNull();
    expect(retryButton()).toBeNull();
  });

  // A refresh that failed leaves an error next to the last good answer, and
  // the device being offline changes nothing to what it holds.
  it('data wins: the workout the device holds is shown, offline and after a refresh that failed', () => {
    mockOnline = false;
    mockSessionData = { ...loadedPullA(), isError: true, isPaused: true, fetchStatus: 'paused' };
    mockSetLogsData = { data: [LOG], isLoading: false, isError: true, fetchStatus: 'idle' };
    renderSessionView();

    expect(shownExercise()).toBe('Squat');
    expect(screen.getByText(/0 of 1 sets done/i)).toBeInTheDocument();
    expect(inBar().getByRole('button', { name: 'Validate set 1' })).toBeInTheDocument();
    expect(confirmOffered()).toBe(true);
    expect(notOnDevice()).toBeNull();
    expect(notLoaded()).toBeNull();
  });

  it('a session without an exercise waits for no sets', () => {
    mockSessionData = loadedPullA({ exercise_slots: [] });
    mockSetLogsData = notAsked;
    renderSessionView();

    expect(screen.getByRole('heading', { level: 1, name: 'Pull A' })).toBeInTheDocument();
    expect(confirmOffered()).toBe(true);
    expect(retryButton()).toBeNull();
  });

  it('asks again by itself when the network returns — once, not for as long as it fails', () => {
    mockOnline = false;
    mockSessionData = failed;
    mockSetLogsData = notAsked;
    const view = renderSessionView();
    expect(mockRefetchSession).not.toHaveBeenCalled();

    mockOnline = true;
    rerenderSessionView(view);
    expect(mockRefetchSession).toHaveBeenCalledTimes(1);
    expect(mockRefetchSession).toHaveBeenCalledWith({ cancelRefetch: false });

    // Still failing, still online: the message and its button, no loop.
    rerenderSessionView(view);
    rerenderSessionView(view);
    expect(mockRefetchSession).toHaveBeenCalledTimes(1);
    expect(notLoaded()).toBeInTheDocument();
  });

  it('asks for nothing when the network returns on a page that has its session', () => {
    mockOnline = false;
    const view = renderSessionView();
    mockOnline = true;
    rerenderSessionView(view);

    expect(mockRefetchSession).not.toHaveBeenCalled();
    expect(mockRefetchLogs).not.toHaveBeenCalled();
  });
});

// N6. The "Last time" line is read after the sets and pushed everything under
// it down when it arrived. The page tells the panel when it is on its way, and
// only then: a read paused without a network, or that failed, keeps no place.
describe('SessionView: the place of the "Last time" line', () => {
  // The place kept: an ellipsis, hidden from assistive technology, where the
  // line will be.
  const placeholder = () => {
    const mark = within(panel()).queryByText('…');
    return mark && mark.getAttribute('aria-hidden') === 'true' ? mark : null;
  };
  const lastTime = () => within(panel()).queryByText(/5 at 60 kg\.$/);

  beforeEach(() => {
    mockDeviations = { data: [], isLoading: false, isFetched: true, fetchStatus: 'idle' };
    mockSessionData = loaded([slot('slot-1', 'Squat')]);
    mockSetLogsData = logsRead([setLog('l-1', 'slot-1', 1)]);
  });

  it('is kept while the read is in flight', () => {
    mockLastPerformance = { data: undefined, isPending: true, fetchStatus: 'fetching' };
    renderSessionView();
    expect(placeholder()).not.toBeNull();
  });

  it('and while it waits for the swaps it is keyed on, which are being read', () => {
    mockDeviations = { data: undefined, isLoading: true, isFetched: false, fetchStatus: 'fetching' };
    mockLastPerformance = { data: undefined, isPending: true, fetchStatus: 'idle' };
    renderSessionView();
    expect(placeholder()).not.toBeNull();
  });

  it('is not kept for a read paused without a network — nor for swaps that are', () => {
    mockLastPerformance = { data: undefined, isPending: true, fetchStatus: 'paused' };
    const view = renderSessionView();
    expect(placeholder()).toBeNull();
    expect(within(panel()).queryByText('…')).toBeNull();
    view.unmount();

    mockDeviations = { data: undefined, isLoading: false, isFetched: false, fetchStatus: 'paused' };
    mockLastPerformance = { data: undefined, isPending: true, fetchStatus: 'idle' };
    renderSessionView();
    expect(within(panel()).queryByText('…')).toBeNull();
  });

  it('is not kept for a read that failed', () => {
    mockLastPerformance = { data: undefined, isPending: false, isError: true, fetchStatus: 'idle' };
    renderSessionView();
    expect(within(panel()).queryByText('…')).toBeNull();
  });

  it('gives way to the line', () => {
    mockLastPerformance = {
      data: { 'ex-slot-1': { performedAt: '2026-10-08T18:00:00Z', scheduledDate: null, sets: [{ weight: 60, reps: 5 }] } },
      isPending: false,
      fetchStatus: 'idle',
    };
    renderSessionView();
    expect(lastTime()).toBeInTheDocument();
    expect(placeholder()).toBeNull();
  });
});

// L31. A session is opened from a push notification, a pasted link or a cold
// start of the installed app as often as from the list. On that first entry of
// the tab `navigate(-1)` has nowhere to go: the installed app does nothing and
// a browser leaves the app. Back then goes to the athlete's list.
describe('SessionView: the way back', () => {
  function Where() {
    const location = useLocation();
    return <p data-testid="where">{location.pathname}</p>;
  }

  // `entries`: the tab's history, the session last.
  function renderAt(entries) {
    return render(
      <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
        <Routes>
          <Route path="/student/session/:sessionId" element={<SessionView />} />
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>
    );
  }

  const where = () => screen.getByTestId('where').textContent;
  const back = () => fireEvent.click(screen.getByRole('button', { name: 'Back to training' }));

  it('goes to the list from a session opened on the first entry of the tab', () => {
    renderAt(['/student/session/sess-1']);
    back();
    expect(where()).toBe('/student');
  });

  it('goes one step back, to the page the session was opened from, when there is one', () => {
    renderAt(['/student/stats', '/student/session/sess-1']);
    back();
    expect(where()).toBe('/student/stats');
  });

  it('works from the page that says the session could not be loaded', () => {
    mockSessionData = { data: undefined, isLoading: false, fetchStatus: 'idle', isError: true };
    mockSetLogsData = { data: undefined, isLoading: false, fetchStatus: 'idle' };
    renderAt(['/student/session/sess-1']);
    expect(screen.getByText(/this session couldn’t be loaded/i)).toBeInTheDocument();
    back();
    expect(where()).toBe('/student');
  });
});
