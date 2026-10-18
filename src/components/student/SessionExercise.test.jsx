// The exercise shown on the session screen: the panel of the set in progress,
// the list of its sets, the line of last time, and the athlete's own controls
// on it. The component and the rows are the real ones, and so is each row's
// `useSetActions` — the long press that marks a set failed goes through it.
// The writes are doubles, and so are the three sibling controls (the swap bar,
// the note box and the exercise's menu), which have hooks of their own and
// their own tests.
//
// What the screen hands the component — the seeds of each set's editor, the
// unit, the deviation — is worked out here by the same functions SessionView
// calls (sessionModel), so a case is built the way the page builds it.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { getToasts, dismissToast } from '../../lib/toast';

const mockToggleDone = { mutate: vi.fn() };
const mockSetFailed = { mutate: vi.fn() };
const mockSetRpe = { mutate: vi.fn() };
const mockLogActual = { mutate: vi.fn() };
const mockSetSkipped = { mutate: vi.fn() };
const idle = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });

vi.mock('../../hooks/useSetLogs', () => ({
  useToggleSetDone: () => mockToggleDone,
  useSetFailed: () => mockSetFailed,
  useSetRpe: () => mockSetRpe,
  useLogActual: () => mockLogActual,
  useSetSkipped: () => mockSetSkipped,
  useAddStudentSet: () => idle(),
  useRemoveStudentSet: () => idle(),
}));

vi.mock('../../hooks/useRestTimer', async () => {
  const actual = await vi.importActual('../../hooks/useRestTimer');
  return { ...actual, startRestTimer: vi.fn(), clearRestTimer: vi.fn() };
});

// The siblings draw a marker: which slot, locked or not. The note box says
// whether it was opened, and the menu what it offers, with its note item.
vi.mock('./SlotDeviationBar', () => ({
  default: ({ slot, deviation, locked = false }) => (
    <div
      data-testid="deviation-bar"
      data-slot={slot.id}
      data-deviation={deviation?.kind ?? 'none'}
      data-locked={locked ? 'yes' : 'no'}
    />
  ),
}));
vi.mock('./SlotCommentBox', async () => {
  const { useImperativeHandle, useState } = await import('react');
  return {
    default: function NoteBox({ slotId, comment, locked = false, ref }) {
      const [open, setOpen] = useState(false);
      useImperativeHandle(ref, () => ({ open: () => setOpen(true) }));
      return (
        <div
          data-testid="note-box"
          data-slot={slotId}
          data-comment={comment?.body ?? ''}
          data-locked={locked ? 'yes' : 'no'}
          data-open={open ? 'yes' : 'no'}
        />
      );
    },
  };
});
vi.mock('./ExerciseMenu', () => ({
  default: ({ slot, name, canDeviate, canNote, hasNote, onNote }) => (
    <div
      data-testid="exercise-menu"
      data-slot={slot.id}
      data-name={name}
      data-deviate={canDeviate ? 'yes' : 'no'}
      data-note={canNote ? (hasNote ? 'edit' : 'add') : 'no'}
    >
      {canNote && (
        <button type="button" onClick={onNote}>
          Note item
        </button>
      )}
    </div>
  ),
}));

import SessionExercise from './SessionExercise';
import { startRestTimer, clearRestTimer } from '../../hooks/useRestTimer';
import { deviationOf, editorSeeds, isDurationBased } from './sessionModel';

const BENCH = { id: 'ex-bench', name: 'Bench press', load_mode: 'added' };
const DIPS = { id: 'ex-dips', name: 'Weighted dip', load_mode: 'full' };
const SLOT = { id: 'slot-1', exercise: BENCH, sets: 3, reps: 8, weight_kg: 100, notes: null, record_video_set_numbers: null };

// Prescribed 8 × 100 kg.
const prescribed = (n, extra = {}) => ({
  id: `log-${n}`,
  exercise_slot_id: 'slot-1',
  set_number: n,
  target_reps: 8,
  target_weight_kg: 100,
  target_duration_seconds: null,
  target_rest_seconds: null,
  done: false,
  failed: false,
  skipped: false,
  rpe: null,
  logged_at: null,
  failed_at: null,
  actual_reps: null,
  actual_weight_kg: null,
  ...extra,
});

const extra = (n, values = {}) =>
  prescribed(n, { is_student_added: true, target_reps: null, target_weight_kg: null, ...values });

// The props SessionView passes for one exercise, from what it read.
function propsFor({ slot = SLOT, logs, deviations = [], lastPerf = null, ...rest }) {
  const { deviation, swapped, skipped } = deviationOf(slot, deviations);
  return {
    slot,
    slotLogs: logs,
    seeds: editorSeeds(logs, { swapped, lastPerf }),
    deviation,
    swapped,
    skipped,
    durationBased: isDurationBased(slot, logs),
    partners: [],
    noteSlotId: slot.id,
    slotComment: null,
    lastPerf,
    lastPerfLoading: false,
    exerciseLibrary: [BENCH, DIPS],
    sessionId: 'sess-1',
    setsLocked: false,
    isReadOnly: false,
    online: true,
    getVideoForLog: () => null,
    onOpenSet: vi.fn(),
    onGesture: vi.fn(),
    onAddSet: vi.fn(),
    addingSet: false,
    ...rest,
  };
}

function renderExercise(options) {
  const props = propsFor(options);
  const view = render(<SessionExercise {...props} />);
  return {
    ...view,
    props,
    rerenderWith: (next) => view.rerender(<SessionExercise {...propsFor({ ...options, ...next })} />),
  };
}

const panel = () => screen.getByRole('region', { name: 'Set in progress' });
const setList = () => screen.getByRole('list', { name: 'Sets' });
const items = () => within(setList()).getAllByRole('listitem');
// The row of the n-th set shown, in set order: its button, or its plain row
// when it cannot be pressed.
const row = (n) => within(items()[n - 1]);
const rowButton = (n) => row(n).getByRole('button');
const hint = () => screen.queryByText('Press and hold a set to mark it failed.');

beforeEach(() => {
  vi.clearAllMocks();
  for (const toast of getToasts()) dismissToast(toast.id);
});

describe('the rows of the sets', () => {
  // Prescribed 5 × 20 kg; set 4 is the one in progress.
  const five = (n, more = {}) => prescribed(n, { target_reps: 5, target_weight_kg: 20, ...more });
  const logs = [
    five(1, { done: true, rpe: 7.5 }),
    five(2, { failed: true, actual_reps: 3 }),
    five(3, { skipped: true }),
    five(4),
    five(5),
  ];

  it('each says its state in words, with what it asks for or what was done', () => {
    renderExercise({ logs });

    expect(rowButton(1)).toHaveAccessibleName(/^Set 1, done/);
    expect(row(1).getByText('5 reps, 20 kg')).toBeInTheDocument();
    expect(row(1).getByText('RPE 7.5')).toBeInTheDocument();

    expect(rowButton(2)).toHaveAccessibleName(/^Set 2, failed/);
    expect(row(2).getByText('3 of 5 reps, 20 kg')).toBeInTheDocument();
    expect(items()[1]).toHaveClass('bg-red-soft');

    expect(rowButton(3)).toHaveAccessibleName(/^Set 3, skipped/);
    expect(row(3).getByText('5 reps, 20 kg')).toBeInTheDocument();

    // The first set with no outcome is the one in progress, and only it.
    expect(row(4).getByText('Set 4')).toBeInTheDocument();
    expect(row(4).getByText('In progress')).toBeInTheDocument();
    expect(row(5).getByText('Set 5')).toBeInTheDocument();
    expect(row(5).queryByText('In progress')).toBeNull();
  });

  it('the indicator holds the number of a set to do, and is never the only carrier of a state', () => {
    const { container } = renderExercise({ logs });
    const dots = container.querySelectorAll('.pk-set-dot');
    expect(dots[3]).toHaveTextContent('4');
    expect(dots[3]).toHaveClass('pk-set-dot-current');
    expect(dots[4]).toHaveClass('pk-set-dot-pending');
    for (const dot of dots) expect(dot).toHaveAttribute('aria-hidden', 'true');
  });

  it('a set done off the plan says what was done, on amber', () => {
    renderExercise({ logs: [five(1, { done: true, actual_reps: 4, actual_weight_kg: 22.5 }), five(2)] });
    expect(row(1).getByText('Off plan, 4 reps, 22.5 kg')).toBeInTheDocument();
    expect(items()[0]).toHaveClass('bg-amber-soft');
  });

  it('a failed set without its reps shows its target', () => {
    renderExercise({ logs: [five(1, { failed: true })] });
    expect(row(1).getByText('5 reps, 20 kg')).toBeInTheDocument();
  });

  // P61. An extra set has no target: until it says what was done, its row asks.
  it('an extra set is "added", and asks what was done until it says so', () => {
    renderExercise({
      logs: [
        prescribed(1, { done: true }),
        extra(2, { done: true, actual_reps: 8, actual_weight_kg: 100 }),
        extra(3, { actual_reps: 6, actual_weight_kg: 90 }),
        extra(4),
      ],
    });
    expect(rowButton(2)).toHaveAccessibleName(/^Set 2, added/);
    expect(row(2).getByText('Off plan, 8 reps, 100 kg')).toBeInTheDocument();
    expect(rowButton(3)).toHaveAccessibleName(/^Set 3, added/);
    expect(row(3).getByText('6 reps, 90 kg')).toBeInTheDocument();
    expect(rowButton(4)).toHaveAccessibleName(/^Set 4, added/);
    expect(row(4).getByText('Say what you did')).toBeInTheDocument();
  });

  // P68: a tap on a done set marked it failed — and dropped its RPE. A tap
  // now opens the set's sheet, whatever the set; it writes nothing.
  it('a tap on a row opens the sheet of its set and writes nothing', () => {
    const { props } = renderExercise({ logs });
    fireEvent.click(rowButton(1));
    fireEvent.click(rowButton(4));

    expect(props.onOpenSet.mock.calls).toEqual([['log-1'], ['log-4']]);
    expect(mockSetFailed.mutate).not.toHaveBeenCalled();
    expect(mockToggleDone.mutate).not.toHaveBeenCalled();
  });

  it('the sentence that says how to fail a set describes every row that can be failed', () => {
    renderExercise({ logs });
    const sentence = hint();
    expect(sentence).toBeInTheDocument();
    expect(sentence.id).not.toBe('');
    expect(rowButton(1)).toHaveAttribute('aria-describedby', sentence.id);
    expect(rowButton(4)).toHaveAttribute('aria-describedby', sentence.id);
    // A failed or skipped set has no long press.
    expect(rowButton(2)).not.toHaveAttribute('aria-describedby');
    expect(rowButton(3)).not.toHaveAttribute('aria-describedby');
  });

  // The session is confirmed or read-only: the rows are what was logged, and
  // nothing is in progress any more.
  it('locked, the rows are plain rows: nothing to press, no set in progress, no sentence, no way to add a set', () => {
    renderExercise({ logs, setsLocked: true });
    expect(within(setList()).queryAllByRole('button')).toEqual([]);
    expect(screen.queryByText('In progress')).toBeNull();
    expect(within(panel()).getByText('Exercise done')).toBeInTheDocument();
    expect(within(panel()).queryByText(/^Set \d of/)).toBeNull();
    expect(hint()).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add a set' })).toBeNull();
    expect(screen.queryByText('Connect to add a set.')).toBeNull();
    // What was logged is still said.
    expect(row(1).getByText('RPE 7.5')).toBeInTheDocument();
    expect(row(2).getByText('3 of 5 reps, 20 kg')).toBeInTheDocument();
  });

  it('locked, a set with its video stays a button — to watch it — and fails nothing', () => {
    vi.useFakeTimers();
    try {
      const filmed = { ...SLOT, record_video_set_numbers: [1, 2] };
      const video = { id: 'vid-1', storage_path: 'u-1/slot-1/a.mp4' };
      const { props } = renderExercise({
        slot: filmed,
        logs: [five(1, { done: true }), five(2, { done: true })],
        setsLocked: true,
        getVideoForLog: (id) => (id === 'log-1' ? video : null),
      });
      const buttons = within(setList()).getAllByRole('button');
      expect(buttons).toHaveLength(1);
      expect(buttons[0]).toHaveAccessibleName(/^Set 1, done/);
      expect(buttons[0]).not.toHaveAttribute('aria-describedby');

      fireEvent.click(buttons[0]);
      expect(props.onOpenSet).toHaveBeenCalledWith('log-1');
      fireEvent.pointerDown(buttons[0], { clientX: 0, clientY: 0, button: 0, isPrimary: true });
      act(() => vi.advanceTimersByTime(600));
      fireEvent.contextMenu(buttons[0]);
      expect(mockSetFailed.mutate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a set the coach asked to film says whether its video is sent', () => {
    const filmed = { ...SLOT, record_video_set_numbers: [2, 3] };
    renderExercise({
      slot: filmed,
      logs: [five(1, { done: true }), five(2, { done: true }), five(3)],
      getVideoForLog: (id) => (id === 'log-2' ? { id: 'vid-2', storage_path: 'x' } : null),
    });
    expect(row(1).getByText('5 reps, 20 kg')).toBeInTheDocument();
    expect(row(2).getByText('5 reps, 20 kg, video sent')).toBeInTheDocument();
    expect(row(3).getByText('5 reps, 20 kg, video asked')).toBeInTheDocument();
  });
});

// P68. Failed is a press held 500 ms, no longer a tap: the tap turned a set
// done a moment ago into a failure at the brush of a thumb. jsdom has
// PointerEvent; the clock is a fake one.
describe('a press held on a row marks the set failed', () => {
  const doneLog = prescribed(1, { done: true, rpe: 8, target_rest_seconds: 90, logged_at: '2026-10-15T18:02:11+00:00' });
  const press = (el, at = { clientX: 10, clientY: 10 }) =>
    fireEvent.pointerDown(el, { ...at, button: 0, isPrimary: true, pointerType: 'touch' });
  const wait = (ms) => act(() => vi.advanceTimersByTime(ms));

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('held 500 ms, a done set is marked failed, once, and its rest goes on', () => {
    const { props } = renderExercise({ logs: [doneLog, prescribed(2)] });
    const el = rowButton(1);

    press(el);
    wait(499);
    expect(mockSetFailed.mutate).not.toHaveBeenCalled();
    wait(1);

    expect(mockSetFailed.mutate).toHaveBeenCalledTimes(1);
    expect(mockSetFailed.mutate).toHaveBeenCalledWith({ logId: 'log-1', failed: true });
    expect(mockToggleDone.mutate).not.toHaveBeenCalled();
    // Done → failed: the rest of that set is already running.
    expect(startRestTimer).not.toHaveBeenCalled();
    expect(clearRestTimer).not.toHaveBeenCalled();
    // The screen keeps this exercise: the set's Undo must find it there.
    expect(props.onGesture).toHaveBeenCalledTimes(1);
  });

  it('says so in a toast whose Undo puts back what the set was', () => {
    renderExercise({ logs: [doneLog] });
    press(rowButton(1));
    wait(500);

    const [toast] = getToasts();
    expect(toast).toMatchObject({
      kind: 'info',
      message: 'Set 1 marked failed.',
      action: { label: 'uiSharedHelpers.undo' },
    });

    toast.action.onClick();

    expect(mockSetFailed.mutate).toHaveBeenLastCalledWith({ logId: 'log-1', failed: false });
    expect(mockToggleDone.mutate).toHaveBeenCalledWith({ logId: 'log-1', done: true, at: '2026-10-15T18:02:11+00:00' });
    expect(mockSetRpe.mutate).toHaveBeenCalledWith({ logId: 'log-1', rpe: 8 });
    // In this order, on the row's queue.
    const order = (mock, i = 0) => mock.mock.invocationCallOrder[i];
    expect(order(mockSetFailed.mutate, 1)).toBeLessThan(order(mockToggleDone.mutate));
    expect(order(mockToggleDone.mutate)).toBeLessThan(order(mockSetRpe.mutate));
    // The rest of the set done earlier is not touched.
    expect(clearRestTimer).not.toHaveBeenCalled();
  });

  it('the Undo of a set that was to do puts it back to do, and its rest is over', () => {
    renderExercise({ logs: [prescribed(1, { target_rest_seconds: 90 })] });
    press(rowButton(1));
    wait(500);

    getToasts()[0].action.onClick();

    expect(mockSetFailed.mutate.mock.calls).toEqual([
      [{ logId: 'log-1', failed: true }],
      [{ logId: 'log-1', failed: false }],
    ]);
    expect(mockToggleDone.mutate).not.toHaveBeenCalled();
    expect(mockSetRpe.mutate).not.toHaveBeenCalled();
    expect(clearRestTimer).toHaveBeenCalledWith('log-1');
  });

  it('the Undo of a done set without a rating writes no rating', () => {
    renderExercise({ logs: [{ ...doneLog, rpe: null }] });
    press(rowButton(1));
    wait(500);
    getToasts()[0].action.onClick();
    expect(mockToggleDone.mutate).toHaveBeenCalledTimes(1);
    expect(mockSetRpe.mutate).not.toHaveBeenCalled();
  });

  it('the click that ends the hold is not a tap, and a set to do starts its rest', () => {
    const { props } = renderExercise({ logs: [prescribed(1, { target_rest_seconds: 90 })] });
    const el = rowButton(1);

    press(el);
    wait(500);
    fireEvent.pointerUp(el);
    fireEvent.click(el);

    expect(mockSetFailed.mutate).toHaveBeenCalledTimes(1);
    expect(props.onOpenSet).not.toHaveBeenCalled();
    // To do → failed: the athlete recovers whatever the outcome.
    expect(startRestTimer).toHaveBeenCalledTimes(1);
    expect(startRestTimer).toHaveBeenCalledWith('log-1', 90);
    // The next tap is a tap again.
    press(el);
    fireEvent.pointerUp(el);
    fireEvent.click(el);
    expect(props.onOpenSet).toHaveBeenCalledWith('log-1');
  });

  it('a set without a prescribed rest starts none', () => {
    renderExercise({ logs: [prescribed(1)] });
    press(rowButton(1));
    wait(500);
    expect(mockSetFailed.mutate).toHaveBeenCalledTimes(1);
    expect(startRestTimer).not.toHaveBeenCalled();
  });

  it('a finger lifted before 500 ms holds nothing: it is a tap', () => {
    const { props } = renderExercise({ logs: [doneLog] });
    const el = rowButton(1);

    press(el);
    wait(300);
    fireEvent.pointerUp(el);
    fireEvent.click(el);
    wait(1000);

    expect(mockSetFailed.mutate).not.toHaveBeenCalled();
    expect(props.onOpenSet).toHaveBeenCalledWith('log-1');
  });

  it('a finger that travels — a scroll — holds nothing', () => {
    renderExercise({ logs: [doneLog] });
    const el = rowButton(1);

    press(el, { clientX: 10, clientY: 10 });
    fireEvent.pointerMove(el, { clientX: 30, clientY: 12, isPrimary: true });
    wait(600);
    expect(mockSetFailed.mutate).not.toHaveBeenCalled();

    // The browser takes a vertical pan for itself and cancels the pointer.
    press(el);
    fireEvent.pointerCancel(el);
    wait(600);
    expect(mockSetFailed.mutate).not.toHaveBeenCalled();
  });

  it('a finger that trembles a few pixels still holds', () => {
    renderExercise({ logs: [doneLog] });
    const el = rowButton(1);

    press(el, { clientX: 10, clientY: 10 });
    fireEvent.pointerMove(el, { clientX: 15, clientY: 14, isPrimary: true });
    wait(500);

    expect(mockSetFailed.mutate).toHaveBeenCalledTimes(1);
  });

  it('Android opens the context menu on the same hold: one write, no menu, no sheet', () => {
    const { props } = renderExercise({ logs: [doneLog] });
    const el = rowButton(1);

    press(el);
    wait(500);
    const shown = fireEvent.contextMenu(el);
    fireEvent.pointerUp(el);
    fireEvent.click(el);

    expect(shown).toBe(false);
    expect(mockSetFailed.mutate).toHaveBeenCalledTimes(1);
    expect(props.onOpenSet).not.toHaveBeenCalled();
  });

  it('the menu key or a right click marks it failed too, and the next tap is a tap (WCAG 2.1.1)', () => {
    const { props } = renderExercise({ logs: [doneLog] });
    const el = rowButton(1);

    const shown = fireEvent.contextMenu(el);
    expect(shown).toBe(false);
    expect(mockSetFailed.mutate).toHaveBeenCalledTimes(1);
    expect(getToasts()).toHaveLength(1);

    // No click follows a menu key: the next one is the athlete's.
    fireEvent.click(el);
    expect(props.onOpenSet).toHaveBeenCalledWith('log-1');
  });

  it('a failed set, a skipped set, a locked row and a second finger hold nothing', () => {
    const { rerenderWith } = renderExercise({ logs: [prescribed(1, { failed: true }), prescribed(2, { skipped: true })] });
    for (const n of [1, 2]) {
      press(rowButton(n));
      wait(600);
      fireEvent.contextMenu(rowButton(n));
    }
    expect(mockSetFailed.mutate).not.toHaveBeenCalled();

    // A locked row with a video to watch is the only locked row with a button.
    rerenderWith({
      logs: [doneLog],
      slot: { ...SLOT, record_video_set_numbers: [1] },
      setsLocked: true,
      getVideoForLog: () => ({ id: 'vid-1', storage_path: 'x' }),
    });
    press(rowButton(1));
    wait(600);
    fireEvent.contextMenu(rowButton(1));
    expect(mockSetFailed.mutate).not.toHaveBeenCalled();

    rerenderWith({ logs: [doneLog], setsLocked: false });
    fireEvent.pointerDown(rowButton(1), { clientX: 0, clientY: 0, button: 0, isPrimary: false });
    wait(600);
    expect(mockSetFailed.mutate).not.toHaveBeenCalled();
  });

  it('a row that goes away while held marks nothing', () => {
    const { unmount } = renderExercise({ logs: [doneLog] });
    press(rowButton(1));
    unmount();
    wait(600);
    expect(mockSetFailed.mutate).not.toHaveBeenCalled();
    expect(getToasts()).toEqual([]);
  });
});

describe('the panel of the set in progress', () => {
  it('names the exercise and the set, with its reps and its load added', () => {
    renderExercise({ logs: [prescribed(1, { done: true }), prescribed(2), prescribed(3)] });
    const p = within(panel());
    expect(p.getByRole('heading', { level: 2, name: 'Bench press' })).toBeInTheDocument();
    expect(p.getByText('Set 2 of 3')).toBeInTheDocument();
    expect(p.getByText('8')).toBeInTheDocument();
    expect(p.getByText('reps')).toBeInTheDocument();
    expect(p.getByText('100')).toBeInTheDocument();
    expect(p.getByText('kg added')).toBeInTheDocument();
  });

  it('a load that is the whole load is in kg; no load is bodyweight; one rep is a rep', () => {
    const { rerenderWith } = renderExercise({
      slot: { ...SLOT, exercise: { ...BENCH, load_mode: 'full' } },
      logs: [prescribed(1)],
    });
    expect(within(panel()).getByText('kg')).toBeInTheDocument();

    rerenderWith({ slot: SLOT, logs: [prescribed(1, { target_reps: 1, target_weight_kg: null })] });
    const p = within(panel());
    expect(p.getByText('BW')).toBeInTheDocument();
    expect(p.getByText('bodyweight')).toBeInTheDocument();
    expect(p.getByText('rep')).toBeInTheDocument();
  });

  it('an exercise held for a time shows its seconds', () => {
    const hold = (n, seconds) => prescribed(n, { target_reps: null, target_duration_seconds: seconds, target_weight_kg: null });
    const { rerenderWith } = renderExercise({ logs: [hold(1, 45)] });
    expect(within(panel()).getByText('45')).toBeInTheDocument();
    expect(within(panel()).getByText('seconds held')).toBeInTheDocument();
    rerenderWith({ logs: [hold(1, 1)] });
    expect(within(panel()).getByText('second held')).toBeInTheDocument();
  });

  it('once every set is dealt with, the exercise is done, on the figures of its last set', () => {
    renderExercise({ logs: [prescribed(1, { done: true }), prescribed(2, { failed: true, target_weight_kg: 90 })] });
    const p = within(panel());
    expect(p.getByText('Exercise done')).toBeInTheDocument();
    expect(p.getByText('90')).toBeInTheDocument();
    expect(screen.queryByText('In progress')).toBeNull();
  });

  // P59. A swapped exercise is another exercise: its name, its load mode, and
  // the figures its sets' editors open with — the substitute's last time.
  it('a swapped exercise shows the substitute, on what its editor opens with', () => {
    renderExercise({
      logs: [prescribed(1), prescribed(2)],
      deviations: [{ exercise_slot_id: 'slot-1', kind: 'swap', substitute_exercise_id: DIPS.id }],
      lastPerf: { performedAt: null, sets: [{ weight: 20, reps: 10 }] },
    });
    const p = within(panel());
    expect(p.getByRole('heading', { level: 2, name: 'Weighted dip' })).toBeInTheDocument();
    expect(p.getByText('10')).toBeInTheDocument();
    expect(p.getByText('20')).toBeInTheDocument();
    expect(p.getByText('kg')).toBeInTheDocument();
    expect(p.queryByText('100')).toBeNull();
  });

  it('a skipped exercise says so: no figures, no sets, no way to add one, no last time', () => {
    renderExercise({
      logs: [prescribed(1), prescribed(2)],
      deviations: [{ exercise_slot_id: 'slot-1', kind: 'skip', substitute_exercise_id: null }],
      lastPerf: { performedAt: null, sets: [{ weight: 90, reps: 8 }] },
      lastPerfLoading: true,
    });
    const p = within(panel());
    expect(p.getByText('Exercise skipped')).toBeInTheDocument();
    expect(p.queryByText('8')).toBeNull();
    expect(screen.queryByRole('list', { name: 'Sets' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add a set' })).toBeNull();
    expect(p.queryByText(/at 90 kg/)).toBeNull();
    expect(p.queryByText('…')).toBeNull();
  });

  it('a superset names its partners, with the rest when it is one', () => {
    const rested = [prescribed(1, { target_rest_seconds: 120 }), prescribed(2, { target_rest_seconds: 120 })];
    const { rerenderWith } = renderExercise({
      logs: rested,
      partners: [{ id: 'slot-2', exercise: { id: 'ex-row', name: 'Row' } }],
    });
    expect(within(panel()).getByText('In a superset with Row, rest 2:00')).toBeInTheDocument();

    rerenderWith({ logs: [prescribed(1)], partners: [{ id: 'slot-2', exercise: { id: 'ex-row', name: 'Row' } }] });
    expect(within(panel()).getByText('In a superset with Row')).toBeInTheDocument();
  });

  it("the coach's note on the exercise is shown under the panel", () => {
    renderExercise({ slot: { ...SLOT, notes: 'Pause at the chest.' }, logs: [prescribed(1)] });
    const note = screen.getByRole('region', { name: 'Coach’s note' });
    expect(note).toHaveTextContent('Pause at the chest.');
  });
});

// B8, the athlete's half. The session read embeds the exercise's library row,
// and row-level security hides a row the athlete may not read — an exercise of
// a former coach's library. `exercise` is then null, and `.name` on it threw:
// the whole session page went down.
describe('an exercise the athlete cannot read', () => {
  const HIDDEN = { ...SLOT, exercise: null };

  it('is named as unavailable, and keeps its sets', () => {
    renderExercise({ slot: HIDDEN, logs: [prescribed(1), prescribed(2)] });
    expect(within(panel()).getByRole('heading', { level: 2, name: 'Exercise unavailable' })).toBeInTheDocument();
    expect(items()).toHaveLength(2);
  });

  it('as a partner in a superset, beside an exercise that can be read', () => {
    renderExercise({ logs: [prescribed(1)], partners: [{ id: 'slot-2', exercise: null }] });
    expect(within(panel()).getByText('In a superset with Exercise unavailable')).toBeInTheDocument();
  });
});

// N6. The line arrives after the sets (it reads the athlete's whole history):
// it pushed every row down by its height under a finger on its way to set 1.
// While it is on its way, its place in the panel is kept.
describe('the line of last time', () => {
  // Seven days ago, at this time of day: seven calendar days in any zone.
  const sevenDaysAgo = () => {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return d.toISOString();
  };
  const benchLastTime = () => ({
    performedAt: sevenDaysAgo(),
    sets: Array.from({ length: 5 }, () => ({ weight: 17.5, reps: 5 })),
  });
  const footer = () => panel().querySelector('.border-t');

  it('says when the exercise was last trained, and how', () => {
    renderExercise({ logs: [prescribed(1)], lastPerf: benchLastTime() });
    expect(within(panel()).getByText('7 days ago, 5 × 5 at 17.5 kg.')).toBeInTheDocument();
  });

  it('is kept while it is on its way, and the line takes its place, above the same rows', () => {
    const logs = [prescribed(1), prescribed(2)];
    const { rerenderWith } = renderExercise({ logs, lastPerf: undefined, lastPerfLoading: true });

    const placeholder = footer();
    expect(placeholder).not.toBeNull();
    expect(within(placeholder).getByText('…')).toHaveAttribute('aria-hidden', 'true');
    expect(placeholder.compareDocumentPosition(setList()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const kept = placeholder.className;

    rerenderWith({ lastPerf: benchLastTime(), lastPerfLoading: false });

    const line = footer();
    expect(line).toHaveTextContent('7 days ago, 5 × 5 at 17.5 kg.');
    expect(line.className).toBe(kept);
    expect(within(line).queryByText('…')).toBeNull();
    expect(line.compareDocumentPosition(setList()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('is not kept once the read is over: no history for the exercise, or no answer', () => {
    const logs = [prescribed(1)];
    const { rerenderWith } = renderExercise({ logs, lastPerf: undefined, lastPerfLoading: true });
    expect(footer()).not.toBeNull();

    // Answered, without this exercise.
    rerenderWith({ lastPerf: null, lastPerfLoading: false });
    expect(footer()).toBeNull();

    // Failed, or paused without a network: no data, and not on its way.
    rerenderWith({ lastPerf: undefined, lastPerfLoading: false });
    expect(footer()).toBeNull();
  });
});

// N5. The header showed the rest only when every set of the exercise was the
// same, and no row showed one: Dips rested 3:00 after sets 1 to 3 and 2:00
// after 4 to 6 showed no rest anywhere.
describe('the prescribed rest', () => {
  const rested = (n, seconds, more = {}) => prescribed(n, { target_rest_seconds: seconds, ...more });

  it('is on each row when the sets of the exercise are not rested alike', () => {
    renderExercise({
      logs: [rested(1, 180), rested(2, 180), rested(3, 180), rested(4, 120), rested(5, 120), rested(6, 120)],
    });
    expect(screen.getAllByText('8 reps, 100 kg, rest 3:00')).toHaveLength(3);
    expect(screen.getAllByText('8 reps, 100 kg, rest 2:00')).toHaveLength(3);
    expect(row(1).getByText('8 reps, 100 kg, rest 3:00')).toBeInTheDocument();
    expect(row(4).getByText('8 reps, 100 kg, rest 2:00')).toBeInTheDocument();
    // Not once for the whole exercise: there is no one value to give.
    expect(within(panel()).queryByText(/rest/i)).toBeNull();
  });

  it('is in the panel once when every set has the same, and on no row', () => {
    renderExercise({ logs: [rested(1, 120), rested(2, 120), rested(3, 120)] });
    expect(within(panel()).getByText('Rest 2:00')).toBeInTheDocument();
    expect(within(setList()).queryByText(/rest/)).toBeNull();
  });

  it('is in the panel once when the loads differ but the rest does not', () => {
    renderExercise({
      logs: [rested(1, 120), rested(2, 120, { target_weight_kg: 90 }), rested(3, 120, { target_weight_kg: 80 })],
    });
    expect(within(panel()).getByText('Rest 2:00')).toBeInTheDocument();
    expect(within(setList()).queryByText(/rest/)).toBeNull();
  });

  it('a set without a prescribed rest says nothing on its row', () => {
    renderExercise({ logs: [rested(1, 180), rested(2, null), rested(3, 120)] });
    expect(row(1).getByText('8 reps, 100 kg, rest 3:00')).toBeInTheDocument();
    expect(row(2).getByText('8 reps, 100 kg')).toBeInTheDocument();
    expect(row(3).getByText('8 reps, 100 kg, rest 2:00')).toBeInTheDocument();
  });
});

// An extra set is a new row: the insert is online-only (useAddStudentSet).
describe('adding a set', () => {
  it('online, "Add a set" asks the screen for one, and is held while it is added', () => {
    const { props, rerenderWith } = renderExercise({ logs: [prescribed(1)] });
    const add = screen.getByRole('button', { name: 'Add a set' });
    // P68: a row is 44 px at least (`.pk-row`, held by test/hitTargets).
    expect(add).toHaveClass('pk-row');
    fireEvent.click(add);
    expect(props.onAddSet).toHaveBeenCalledTimes(1);

    rerenderWith({ addingSet: true });
    expect(screen.getByRole('button', { name: 'Add a set' })).toBeDisabled();
  });

  it('is the last row of the sets, outside their list', () => {
    renderExercise({ logs: [prescribed(1), prescribed(2)] });
    const add = screen.getByRole('button', { name: 'Add a set' });
    expect(within(setList()).queryByRole('button', { name: 'Add a set' })).toBeNull();
    expect(within(setList()).getAllByRole('listitem')).toHaveLength(2);
    expect(add.parentElement).toBe(setList().parentElement);
    expect(add.parentElement).toHaveClass('pk-group');
    expect(add.previousElementSibling).toBe(setList());
  });

  it('with no set yet, it is the group alone', () => {
    renderExercise({ logs: [] });
    expect(screen.queryByRole('list', { name: 'Sets' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Add a set' }).parentElement).toHaveClass('pk-group');
  });

  it('offline, it says a network is needed, and offers nothing to tap', () => {
    renderExercise({ logs: [prescribed(1)], online: false });
    expect(screen.queryByRole('button', { name: 'Add a set' })).toBeNull();
    expect(screen.getByText('Connect to add a set.')).toBeInTheDocument();
  });
});

describe('what stands beside the sets', () => {
  const bar = () => screen.getByTestId('deviation-bar');
  const noteBox = () => screen.getByTestId('note-box');
  const menu = () => screen.getByTestId('exercise-menu');

  it('the way off the plan is in the menu of the panel; a swap or a skip is said under the panel', () => {
    const { rerenderWith } = renderExercise({ logs: [prescribed(1)] });
    expect(within(panel()).getByTestId('exercise-menu')).toBe(menu());
    expect(menu()).toHaveAttribute('data-deviate', 'yes');
    expect(menu()).toHaveAttribute('data-name', 'Bench press');
    expect(bar()).toHaveAttribute('data-deviation', 'none');

    rerenderWith({ deviations: [{ exercise_slot_id: 'slot-1', kind: 'swap', substitute_exercise_id: DIPS.id }] });
    expect(screen.getAllByTestId('deviation-bar')).toHaveLength(1);
    expect(bar()).toHaveAttribute('data-deviation', 'swap');
    expect(bar().compareDocumentPosition(setList()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(panel().compareDocumentPosition(bar()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The bar holds the way back; the menu names the substitute and offers no
    // second swap.
    expect(menu()).toHaveAttribute('data-deviate', 'no');
    expect(menu()).toHaveAttribute('data-name', 'Weighted dip');
  });

  it('the way off the plan locks with the sets', () => {
    const { rerenderWith } = renderExercise({ logs: [prescribed(1)] });
    expect(bar()).toHaveAttribute('data-locked', 'no');
    rerenderWith({ setsLocked: true });
    expect(bar()).toHaveAttribute('data-locked', 'yes');
    expect(menu()).toHaveAttribute('data-deviate', 'no');
  });

  it('the note item of the menu opens the note box', () => {
    renderExercise({ logs: [prescribed(1)] });
    expect(menu()).toHaveAttribute('data-note', 'add');
    expect(noteBox()).toHaveAttribute('data-open', 'no');
    fireEvent.click(screen.getByRole('button', { name: 'Note item' }));
    expect(noteBox()).toHaveAttribute('data-open', 'yes');
  });

  // A superset shares one note, anchored to its first exercise: the screen
  // says which (`noteSlotId`). A confirmed session still takes a note; only a
  // read-only one does not.
  it('the note for the coach is the one of the slot the screen names, and locks on read-only only', () => {
    const NOTE = { id: 'sc-1', exercise_slot_id: 'slot-0', body: 'felt heavy' };
    const { rerenderWith } = renderExercise({ logs: [prescribed(1)], noteSlotId: 'slot-0', slotComment: NOTE, setsLocked: true });
    expect(screen.getAllByTestId('note-box')).toHaveLength(1);
    expect(noteBox()).toHaveAttribute('data-slot', 'slot-0');
    expect(noteBox()).toHaveAttribute('data-comment', 'felt heavy');
    expect(noteBox()).toHaveAttribute('data-locked', 'no');
    expect(menu()).toHaveAttribute('data-note', 'edit');

    rerenderWith({ isReadOnly: true });
    expect(noteBox()).toHaveAttribute('data-locked', 'yes');
    expect(menu()).toHaveAttribute('data-note', 'no');
  });
});

// The exercise shown is one of a superset: the panel says so and switches
// between its exercises, and the sets are listed in rounds, named.
describe('an exercise of a superset', () => {
  const PRESS = { id: 'slot-2', exercise: DIPS, sets: 2, reps: 8, weight_kg: 20, notes: null, record_video_set_numbers: null };
  const partnerSet = (n, extra = {}) =>
    prescribed(n, { id: `p-${n}`, exercise_slot_id: 'slot-2', target_reps: 10, target_weight_kg: 20, ...extra });

  function renderSuperset({ logs, partnerLogs, onSelect = vi.fn(), ...rest }) {
    const superset = {
      members: [
        { slot: SLOT, logs, name: 'Bench press', code: 'A1', durationBased: false, skipped: false },
        { slot: PRESS, logs: partnerLogs, name: 'Weighted dip', code: 'A2', durationBased: false, skipped: false },
      ],
      onSelect,
    };
    return { ...renderExercise({ logs, superset, partners: [PRESS], ...rest }), onSelect };
  }

  it('says « Superset » and the round, with its exercises in a switch, the one shown pressed', () => {
    const { onSelect } = renderSuperset({
      logs: [prescribed(1, { done: true, rpe: 8 }), prescribed(2)],
      partnerLogs: [partnerSet(1), partnerSet(2)],
    });
    expect(within(panel()).getByText('Superset')).toBeInTheDocument();
    expect(within(panel()).getByText('Round 2 of 2')).toBeInTheDocument();
    // The heading still names the exercise shown, for a screen reader.
    expect(within(panel()).getByRole('heading', { level: 2, name: 'Bench press' })).toHaveClass('sr-only');
    // The partner is in the switch, not in a sentence.
    expect(screen.queryByText(/In a superset with/)).toBeNull();

    const switcher = screen.getByRole('group', { name: 'Exercises of the superset' });
    expect(within(switcher).getByRole('button', { name: 'A1 Bench press' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(switcher).getByRole('button', { name: 'A2 Weighted dip' }));
    expect(onSelect).toHaveBeenCalledWith('slot-2');
  });

  it('lists the sets in rounds, each row named for its exercise and coded in its indicator', () => {
    renderSuperset({
      logs: [prescribed(1, { done: true, rpe: 8 }), prescribed(2)],
      partnerLogs: [partnerSet(1), partnerSet(2), partnerSet(3)],
    });
    const list = setList();
    const rounds = within(list).getAllByRole('list');
    expect(rounds.map((round) => round.getAttribute('aria-label'))).toEqual(['Round 1', 'Round 2', 'Round 3']);
    expect(within(rounds[0]).getAllByRole('listitem')).toHaveLength(2);
    expect(within(rounds[2]).getAllByRole('listitem')).toHaveLength(1);
    // A done set says so with its exercise; a set to do shows its code.
    expect(within(rounds[0]).getByText('Bench press, set done')).toBeInTheDocument();
    const partnerRow = within(rounds[0]).getByText('Weighted dip').closest('li');
    expect(partnerRow.querySelector('.pk-set-dot')).toHaveTextContent('A2');
    // The set in progress is the shown exercise's, in round 2.
    expect(within(rounds[1]).getByText('In progress')).toBeInTheDocument();
  });

  it('a tap on a set of the partner asks the screen for that set', () => {
    const { props } = renderSuperset({ logs: [prescribed(1)], partnerLogs: [partnerSet(1)] });
    fireEvent.click(within(setList()).getByText('Weighted dip').closest('button'));
    expect(props.onOpenSet).toHaveBeenCalledWith('p-1');
  });

  it('adds a set to the exercise shown, and says which', () => {
    const { props } = renderSuperset({ logs: [prescribed(1)], partnerLogs: [partnerSet(1)] });
    fireEvent.click(screen.getByRole('button', { name: 'Add a set to Bench press' }));
    expect(props.onAddSet).toHaveBeenCalledTimes(1);
  });

  it('leaves the sets of a skipped exercise out of the rounds', () => {
    const superset = {
      members: [
        { slot: SLOT, logs: [prescribed(1)], name: 'Bench press', code: 'A1', durationBased: false, skipped: false },
        { slot: PRESS, logs: [partnerSet(1)], name: 'Weighted dip', code: 'A2', durationBased: false, skipped: true },
      ],
      onSelect: vi.fn(),
    };
    renderExercise({ logs: [prescribed(1)], superset });
    expect(within(setList()).queryByText('Weighted dip')).toBeNull();
    expect(within(setList()).getByText('Bench press')).toBeInTheDocument();
  });
});
