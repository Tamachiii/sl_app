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
vi.mock('./SlotCommentBox', () => ({ default: () => null }));

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

function renderCard({ logs, deviations = [], lastPerformance = {} }) {
  return render(
    <SlotGroupCard
      group={{ key: slot.id, slots: [slot] }}
      slotOffset={0}
      open
      onToggle={() => {}}
      getLogsForSlot={() => logs}
      slotComments={[]}
      slotDeviations={deviations}
      lastPerformance={lastPerformance}
      exerciseLibrary={[]}
      sessionId="sess-1"
      isConfirmed={false}
      isReadOnly={false}
    />,
  );
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
    expect(first.getByLabelText(/actual reps performed/i)).toHaveValue(10);
    expect(first.getByLabelText(/actual weight in kilograms/i)).toHaveValue(20);

    const second = await openEditorOf(user, 2);
    expect(second.getByLabelText(/actual reps performed/i)).toHaveValue(8);
    expect(second.getByLabelText(/actual weight in kilograms/i)).toHaveValue(22.5);

    // Beyond the sets of last time: the last of them.
    const third = await openEditorOf(user, 3);
    expect(third.getByLabelText(/actual reps performed/i)).toHaveValue(8);
    expect(third.getByLabelText(/actual weight in kilograms/i)).toHaveValue(22.5);
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
    expect(first.getByLabelText(/actual reps performed/i)).toHaveValue(12);

    const second = await openEditorOf(user, 2);
    expect(second.getByLabelText(/actual reps performed/i)).toHaveValue(12);
    expect(second.getByLabelText(/actual weight in kilograms/i)).toHaveValue(0);
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
    expect(first.getByLabelText(/actual reps performed/i)).toHaveValue(8);
    expect(first.getByLabelText(/actual weight in kilograms/i)).toHaveValue(100);
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
    expect(added.getByLabelText(/actual reps performed/i)).toHaveValue(8);
    expect(added.getByLabelText(/actual weight in kilograms/i)).toHaveValue(100);
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
    expect(third.getByLabelText(/actual reps performed/i)).toHaveValue(6);
    expect(third.getByLabelText(/actual weight in kilograms/i)).toHaveValue(95);

    const fourth = await openEditorOf(user, 4);
    expect(fourth.getByLabelText(/actual reps performed/i)).toHaveValue(6);
    expect(fourth.getByLabelText(/actual weight in kilograms/i)).toHaveValue(95);
  });

  it('after a bodyweight set, the load it opens on is 0 — none added — and it can be saved as it is', async () => {
    const user = userEvent.setup();
    renderCard({
      logs: [prescribed(1, { done: true, target_reps: 12, target_weight_kg: null }), extra(2)],
    });

    const added = await openEditorOf(user, 2);
    expect(added.getByLabelText(/actual reps performed/i)).toHaveValue(12);
    expect(added.getByLabelText(/actual weight in kilograms/i)).toHaveValue(0);
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
    expect(added.getByLabelText(/actual weight in kilograms/i)).toHaveValue(10);
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

    expect(row(2).getByLabelText(/actual weight in kilograms/i)).toHaveValue(100);
  });
});
