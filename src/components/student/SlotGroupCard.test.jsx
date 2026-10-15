// What SlotGroupCard tells each SetRow about its exercise: whether it was
// swapped, and what the Actual editor of each set opens with. The card and the
// rows are the real ones; the writes are doubles, and so are the two sibling
// controls (the swap bar and the note box), which have hooks of their own.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockLogActual = { mutate: vi.fn() };
const mockAddSet = { mutate: vi.fn(), isPending: false };
const idle = () => ({ mutate: vi.fn(), isPending: false });

vi.mock('../../hooks/useSetLogs', () => ({
  useToggleSetDone: () => idle(),
  useSetFailed: () => idle(),
  useSetRpe: () => idle(),
  useLogActual: () => mockLogActual,
  useSetSkipped: () => idle(),
  useRemoveStudentSet: () => idle(),
  useAddStudentSet: () => mockAddSet,
}));

vi.mock('../../hooks/useOnlineStatus', () => ({ useOnlineStatus: () => true }));

vi.mock('./SlotDeviationBar', () => ({ default: () => null }));
// The note box draws a marker: which slot, in which form (B29).
vi.mock('./SlotCommentBox', () => ({
  default: ({ slotId, compact = false, exerciseName = '', locked = false }) => (
    <div
      data-testid="note-box"
      data-slot={slotId}
      data-form={compact ? 'compact' : 'body'}
      data-name={exerciseName}
      data-locked={locked ? 'yes' : 'no'}
    />
  ),
}));

import SlotGroupCard from './SlotGroupCard';

const ORIGINAL = { id: 'ex-bench', name: 'Bench press' };
const SUBSTITUTE = 'ex-dips';

const slot = { id: 'slot-1', exercise: ORIGINAL, sets: 3, reps: 8, weight_kg: 100 };

// Prescribed 3 × 8 @ 100 kg on the original exercise.
const prescribed = (n, extra = {}) => ({
  id: `log-${n}`,
  exercise_slot_id: 'slot-1',
  set_number: n,
  target_reps: 8,
  target_weight_kg: 100,
  target_rest_seconds: null,
  done: false,
  failed: false,
  skipped: false,
  rpe: null,
  actual_reps: null,
  actual_weight_kg: null,
  ...extra,
});

const SWAP = { exercise_slot_id: 'slot-1', kind: 'swap', substitute_exercise_id: SUBSTITUTE };

function card({ logs, deviations = [], lastPerformance = {}, lastPerformanceLoading = false, slots = [slot] }) {
  return (
    <SlotGroupCard
      group={{ key: slots[0].id, slots }}
      slotOffset={0}
      open
      onToggle={() => {}}
      getLogsForSlot={() => logs}
      slotComments={[]}
      slotDeviations={deviations}
      lastPerformance={lastPerformance}
      lastPerformanceLoading={lastPerformanceLoading}
      exerciseLibrary={[]}
      sessionId="sess-1"
      isConfirmed={false}
      isReadOnly={false}
    />
  );
}

function renderCard(props) {
  return render(card(props));
}

// The row of the n-th set shown, in set order (the root of a SetRow).
function row(n) {
  const rows = document.querySelectorAll('div.relative.rounded-xl');
  return within(rows[n - 1]);
}

async function openEditorOf(user, n) {
  const r = row(n);
  await user.click(r.getByRole('button', { name: /log what you actually did|logged actual/i }));
  return r;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('a swapped exercise (P59)', () => {
  it("each set's editor opens on the substitute's last performance, set by set", async () => {
    const user = userEvent.setup();
    renderCard({
      logs: [prescribed(1), prescribed(2), prescribed(3)],
      deviations: [SWAP],
      lastPerformance: {
        [SUBSTITUTE]: {
          performedAt: '2026-10-08T18:00:00Z',
          scheduledDate: null,
          sets: [
            { weight: 20, reps: 10 },
            { weight: 22.5, reps: 8 },
          ],
        },
        // The original exercise's own history is not the substitute's.
        [ORIGINAL.id]: { performedAt: null, scheduledDate: null, sets: [{ weight: 100, reps: 8 }] },
      },
    });

    const first = await openEditorOf(user, 1);
    expect(first.getByLabelText(/actual reps performed/i)).toHaveValue('10');
    expect(first.getByLabelText(/actual weight in kilograms/i)).toHaveValue('20');

    const second = await openEditorOf(user, 2);
    expect(second.getByLabelText(/actual reps performed/i)).toHaveValue('8');
    expect(second.getByLabelText(/actual weight in kilograms/i)).toHaveValue('22.5');

    // Beyond the sets of last time: the last of them.
    const third = await openEditorOf(user, 3);
    expect(third.getByLabelText(/actual reps performed/i)).toHaveValue('8');
    expect(third.getByLabelText(/actual weight in kilograms/i)).toHaveValue('22.5');
  });

  it('a Save stores both values even when they equal the original targets', async () => {
    const user = userEvent.setup();
    renderCard({
      logs: [prescribed(1)],
      deviations: [SWAP],
      lastPerformance: {
        [SUBSTITUTE]: { performedAt: null, scheduledDate: null, sets: [{ weight: 100, reps: 8 }] },
      },
    });

    const first = await openEditorOf(user, 1);
    await user.click(first.getByRole('button', { name: /^save$/i }));

    expect(mockLogActual.mutate).toHaveBeenCalledWith({
      logId: 'log-1',
      actualReps: 8,
      actualWeightKg: 100,
      done: true,
    });
  });

  it('done for the first time: the first set starts from the prescribed reps, the next from what was logged before it', async () => {
    const user = userEvent.setup();
    renderCard({
      logs: [prescribed(1, { done: true, actual_reps: 12, actual_weight_kg: 0 }), prescribed(2)],
      deviations: [SWAP],
    });

    const first = await openEditorOf(user, 1);
    expect(first.getByLabelText(/actual reps performed/i)).toHaveValue('12');

    const second = await openEditorOf(user, 2);
    expect(second.getByLabelText(/actual reps performed/i)).toHaveValue('12');
    expect(second.getByLabelText(/actual weight in kilograms/i)).toHaveValue('0');
  });

  it('a skip deviation is not a swap', async () => {
    renderCard({
      logs: [prescribed(1)],
      deviations: [{ exercise_slot_id: 'slot-1', kind: 'skip', substitute_exercise_id: null }],
    });
    // The sets of a skipped exercise are not shown at all.
    expect(screen.queryByRole('button', { name: /mark set done/i })).not.toBeInTheDocument();
  });
});

describe('the exercise as the coach wrote it', () => {
  it("opens on the set's targets and keeps nulling a value equal to them", async () => {
    const user = userEvent.setup();
    renderCard({
      logs: [prescribed(1, { done: true })],
      lastPerformance: {
        [ORIGINAL.id]: { performedAt: null, scheduledDate: null, sets: [{ weight: 90, reps: 10 }] },
      },
    });

    const first = await openEditorOf(user, 1);
    expect(first.getByLabelText(/actual reps performed/i)).toHaveValue('8');
    expect(first.getByLabelText(/actual weight in kilograms/i)).toHaveValue('100');
    await user.click(first.getByRole('button', { name: /^save$/i }));

    expect(mockLogActual.mutate).toHaveBeenCalledWith({
      logId: 'log-1',
      actualReps: null,
      actualWeightKg: null,
    });
  });
});

// P61 — an extra set has no targets: its editor opens on the set before it, as
// that set was done, and the exercise's unit says whether it has reps.
describe('an extra set', () => {
  const extra = (n, values = {}) =>
    prescribed(n, {
      is_student_added: true,
      target_reps: null,
      target_weight_kg: null,
      ...values,
    });

  it('opens on the set before it: its targets when it was done as written', async () => {
    const user = userEvent.setup();
    renderCard({ logs: [prescribed(1, { done: true }), prescribed(2, { done: true }), extra(3)] });

    const added = await openEditorOf(user, 3);
    expect(added.getByLabelText(/actual reps performed/i)).toHaveValue('8');
    expect(added.getByLabelText(/actual weight in kilograms/i)).toHaveValue('100');
    expect(added.getByRole('button', { name: /^save$/i })).toBeEnabled();
  });

  it('its actual values when it was not, and an extra after an extra carries them on', async () => {
    const user = userEvent.setup();
    renderCard({
      logs: [
        prescribed(1, { done: true }),
        prescribed(2, { done: true, actual_reps: 6, actual_weight_kg: 95 }),
        extra(3),
        extra(4),
      ],
    });

    const third = await openEditorOf(user, 3);
    expect(third.getByLabelText(/actual reps performed/i)).toHaveValue('6');
    expect(third.getByLabelText(/actual weight in kilograms/i)).toHaveValue('95');

    const fourth = await openEditorOf(user, 4);
    expect(fourth.getByLabelText(/actual reps performed/i)).toHaveValue('6');
    expect(fourth.getByLabelText(/actual weight in kilograms/i)).toHaveValue('95');
  });

  it('after a bodyweight set, the load it opens on is 0 — none added — and it can be saved as it is', async () => {
    const user = userEvent.setup();
    renderCard({
      logs: [prescribed(1, { done: true, target_reps: 12, target_weight_kg: null }), extra(2)],
    });

    const added = await openEditorOf(user, 2);
    expect(added.getByLabelText(/actual reps performed/i)).toHaveValue('12');
    expect(added.getByLabelText(/actual weight in kilograms/i)).toHaveValue('0');
    await user.click(added.getByRole('button', { name: /^save$/i }));

    expect(mockLogActual.mutate).toHaveBeenCalledWith({
      logId: 'log-2',
      actualReps: 12,
      actualWeightKg: 0,
      done: true,
    });
  });

  it('on an exercise measured in seconds, it has no reps to give', async () => {
    const user = userEvent.setup();
    renderCard({
      logs: [
        prescribed(1, { done: true, target_reps: null, target_duration_seconds: 45, target_weight_kg: 10 }),
        extra(2),
      ],
    });

    const added = await openEditorOf(user, 2);
    expect(added.queryByLabelText(/actual reps performed/i)).not.toBeInTheDocument();
    expect(added.getByLabelText(/actual weight in kilograms/i)).toHaveValue('10');
    await user.click(added.getByRole('button', { name: /^save$/i }));

    expect(mockLogActual.mutate).toHaveBeenCalledWith({
      logId: 'log-2',
      actualReps: null,
      actualWeightKg: 10,
      done: true,
    });
  });

  it('a tap on it opens that editor rather than marking it done', async () => {
    const user = userEvent.setup();
    renderCard({ logs: [prescribed(1, { done: true }), extra(2)] });

    await user.click(row(2).getByRole('button', { name: /mark set done/i }));

    expect(row(2).getByLabelText(/actual weight in kilograms/i)).toHaveValue('100');
  });
});

// P68: a pill that is a button is 44 px tall (`sl-pill-btn`), not 23.
describe('the sizes of its controls', () => {
  it('"+ Add set" is 44 px tall', () => {
    renderCard({ logs: [prescribed(1)] });
    expect(screen.getByRole('button', { name: /add set/i })).toHaveClass('sl-pill', 'sl-pill-btn');
  });
});

// N6. The hint arrives after the sets (it reads the athlete's whole history):
// it pushed every row down by its height under a finger on its way to set 1.
// While it is on its way, a box of its size keeps its place. jsdom lays
// nothing out: the box is the hint's own (`HINT_BOX`), with the same two lines.
describe('the place of the "Last time" hint', () => {
  const benchLastTime = {
    [ORIGINAL.id]: { performedAt: '2026-10-08T18:00:00Z', scheduledDate: null, sets: [{ weight: 100, reps: 8 }] },
  };
  const box = () => screen.getByText('Last time').parentElement;
  const firstRow = () => document.querySelector('div.relative.rounded-xl');

  it('is kept while the hint is on its way, and the hint takes it, above the same rows', () => {
    const logs = [prescribed(1), prescribed(2)];
    const { rerender } = renderCard({ logs, lastPerformance: undefined, lastPerformanceLoading: true });

    const placeholder = box();
    expect(placeholder).toHaveAttribute('aria-hidden', 'true');
    expect(placeholder.compareDocumentPosition(firstRow()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const kept = placeholder.className;

    rerender(card({ logs, lastPerformance: benchLastTime, lastPerformanceLoading: false }));

    const hint = box();
    expect(hint).not.toHaveAttribute('aria-hidden');
    expect(hint).toHaveTextContent(/100/);
    expect(hint.className).toBe(kept);
    expect(hint.compareDocumentPosition(firstRow()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getAllByText('Last time')).toHaveLength(1);
  });

  it('is not kept once the read is over: no history for the exercise, or no answer', () => {
    const logs = [prescribed(1)];
    const { rerender } = renderCard({ logs, lastPerformance: undefined, lastPerformanceLoading: true });
    expect(screen.getByText('Last time')).toBeInTheDocument();

    // Answered, without this exercise.
    rerender(card({ logs, lastPerformance: {}, lastPerformanceLoading: false }));
    expect(screen.queryByText('Last time')).not.toBeInTheDocument();

    // Failed, or paused without a network: no data, and not on its way.
    rerender(card({ logs, lastPerformance: undefined, lastPerformanceLoading: false }));
    expect(screen.queryByText('Last time')).not.toBeInTheDocument();
  });

  it('is kept in each exercise of a superset too', () => {
    const second = { id: 'slot-2', exercise: { id: 'ex-row', name: 'Row' }, sets: 1 };
    renderCard({
      logs: [prescribed(1)],
      slots: [slot, second],
      lastPerformance: undefined,
      lastPerformanceLoading: true,
    });
    expect(screen.getAllByText('Last time')).toHaveLength(2);
  });

  it('a skipped exercise keeps none: its sets are hidden', () => {
    renderCard({
      logs: [prescribed(1)],
      deviations: [{ exercise_slot_id: 'slot-1', kind: 'skip', substitute_exercise_id: null }],
      lastPerformance: undefined,
      lastPerformanceLoading: true,
    });
    expect(screen.queryByText('Last time')).not.toBeInTheDocument();
  });
});

// B29. "Add note" was in the body of an exercise, out of reach while it was
// collapsed. One note control per exercise (per superset), whatever the state.
describe('the note for the coach', () => {
  const pending = [prescribed(1), prescribed(2)];
  const NOTE = { id: 'sc-1', exercise_slot_id: 'slot-1', body: 'felt heavy' };
  const SECOND = { id: 'slot-2', exercise: { id: 'ex-row', name: 'Row' }, sets: 3, reps: 8 };

  function renderGroup({ open, slots = [slot], isReadOnly = false, slotComments = [] }) {
    return render(
      <SlotGroupCard
        group={{ key: slots[0].id, slots }}
        slotOffset={0}
        open={open}
        onToggle={() => {}}
        getLogsForSlot={() => pending}
        slotComments={slotComments}
        slotDeviations={[]}
        lastPerformance={{}}
        exerciseLibrary={[]}
        sessionId="sess-1"
        isConfirmed={false}
        isReadOnly={isReadOnly}
      />,
    );
  }
  const boxes = () => screen.queryAllByTestId('note-box');

  it('is reachable on a collapsed exercise, beside its header and not inside it', () => {
    renderGroup({ open: false });
    expect(boxes()).toHaveLength(1);
    const [box] = boxes();
    expect(box).toHaveAttribute('data-form', 'compact');
    expect(box).toHaveAttribute('data-slot', 'slot-1');
    expect(box).toHaveAttribute('data-name', 'Bench press');
    // A button inside the header's button would be no button at all.
    expect(box.closest('button')).toBeNull();
    expect(screen.getByRole('button', { expanded: false })).toBeInTheDocument();
  });

  it('is in the body of an open exercise, and only there', () => {
    renderGroup({ open: true });
    expect(boxes()).toHaveLength(1);
    expect(boxes()[0]).toHaveAttribute('data-form', 'body');
  });

  it('a collapsed superset has one, on its lead exercise, named after both', () => {
    renderGroup({ open: false, slots: [slot, SECOND] });
    expect(boxes()).toHaveLength(1);
    expect(boxes()[0]).toHaveAttribute('data-form', 'compact');
    expect(boxes()[0]).toHaveAttribute('data-slot', 'slot-1');
    expect(boxes()[0]).toHaveAttribute('data-name', 'Bench press + Row');
  });

  it('an open superset keeps its one box under the exercises', () => {
    renderGroup({ open: true, slots: [slot, SECOND] });
    expect(boxes()).toHaveLength(1);
    expect(boxes()[0]).toHaveAttribute('data-form', 'body');
  });

  it('a read-only session offers none on a collapsed exercise, and shows a note it has as a badge', () => {
    renderGroup({ open: false, isReadOnly: true, slotComments: [NOTE] });
    expect(boxes()).toHaveLength(0);
    expect(screen.getByLabelText('Note attached')).toBeInTheDocument();
  });

  it('a collapsed exercise with a note shows it on its control, not twice', () => {
    renderGroup({ open: false, slotComments: [NOTE] });
    expect(boxes()).toHaveLength(1);
    expect(screen.queryByLabelText('Note attached')).toBeNull();
  });
});
