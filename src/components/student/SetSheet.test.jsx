// The sheet of one set — what was done, its rating, and the other things a set
// can be: skipped, not failed after all, removed, filmed — on the real
// `useSetActions` of that set, as SessionView mounts the two together. The
// writes are doubles (the hooks of useSetLogs), and so are the rest timer's two
// entry points. A change of `log` is a `rerender`: it is what a replayed write,
// a read or a rollback is to the sheet, and never a gesture.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { onlineManager } from '@tanstack/react-query';
import { getToasts, dismissToast } from '../../lib/toast';

const mockToggleDone = { mutate: vi.fn() };
const mockSetFailed = { mutate: vi.fn() };
const mockSetRpe = { mutate: vi.fn() };
const mockLogActual = { mutate: vi.fn() };
const mockSetSkipped = { mutate: vi.fn() };
// The removal answers the row as the database deleted it (see the Undo tests).
const mockRemoveStudentSet = {
  mutate: vi.fn(),
  mutateAsync: vi.fn(async ({ logId }) => ({ logId, removed: { id: logId } })),
  isPending: false,
};
const mockAddStudentSet = { mutate: vi.fn(), isPending: false };

vi.mock('../../hooks/useSetLogs', () => ({
  useToggleSetDone: () => mockToggleDone,
  useSetFailed: () => mockSetFailed,
  useSetRpe: () => mockSetRpe,
  useLogActual: () => mockLogActual,
  useSetSkipped: () => mockSetSkipped,
  useAddStudentSet: () => mockAddStudentSet,
  useRemoveStudentSet: () => mockRemoveStudentSet,
}));

vi.mock('../../hooks/useRestTimer', async () => {
  const actual = await vi.importActual('../../hooks/useRestTimer');
  return { ...actual, startRestTimer: vi.fn(), clearRestTimer: vi.fn() };
});

// The video control has its own hooks and its own tests: here, a marker of
// what the sheet hands it.
vi.mock('./VideoUploadButton', () => ({
  default: ({ setLogId, existingVideo, disabled = false }) => (
    <div
      data-testid="video"
      data-set={setLogId}
      data-video={existingVideo?.id ?? ''}
      data-disabled={disabled ? 'yes' : 'no'}
    />
  ),
}));

import SetSheet from './SetSheet';
import { useSetActions } from './useSetActions';
import { startRestTimer, clearRestTimer } from '../../hooks/useRestTimer';

const baseLog = {
  id: 'log-1',
  set_number: 1,
  done: false,
  failed: false,
  skipped: false,
  rpe: null,
  exercise_slot_id: 'slot-1',
};

/**
 * The set's sheet as SessionView mounts it: one `useSetActions` per set
 * (`exercise` is what the page works out for the set's exercise: swapped, the
 * seeds, the unit), the sheet open, and a button that opens it again — the
 * same set's hooks, as the page keeps them while the set is the one opened.
 * `onNeedRpe` is the page's « the RPE sheet next »; it closes this one.
 *
 * A sheet closed by what is inside it tells its close twice — once from the
 * body, once as `open` turns false (parc/Sheet) — and the page's `closeSet` is
 * written for that. So the tests ask whether the sheet is open, never how many
 * times it said it closed.
 */
function Harness({ log, exercise, title = 'Set 1', locked = false, online = true, recordVideo = false, video = null, onClose, onNeedRpe }) {
  const actions = useSetActions(log, exercise);
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open the set
      </button>
      <SetSheet
        open={open}
        log={log}
        title={title}
        actions={actions}
        locked={locked}
        online={online}
        recordVideo={recordVideo}
        video={video}
        onClose={() => {
          setOpen(false);
          onClose?.();
        }}
        onNeedRpe={() => {
          setOpen(false);
          onNeedRpe?.();
        }}
      />
    </>
  );
}

function renderSheet(log = baseLog, props = {}) {
  const onClose = vi.fn();
  const onNeedRpe = vi.fn();
  const view = render(<Harness log={log} onClose={onClose} onNeedRpe={onNeedRpe} {...props} />);
  return {
    ...view,
    onClose,
    onNeedRpe,
    rerenderWith: (next, nextProps = props) =>
      view.rerender(<Harness log={next} onClose={onClose} onNeedRpe={onNeedRpe} {...nextProps} />),
  };
}

const dialog = () => document.querySelector('dialog');
const isOpen = () => dialog().open === true;
const sheet = () => within(dialog());
const reps = () => sheet().getByRole('textbox', { name: 'Reps' });
const load = () => sheet().getByRole('textbox', { name: 'Load in kg' });
const queryReps = () => sheet().queryByRole('textbox', { name: 'Reps' });
const queryLoad = () => sheet().queryByRole('textbox', { name: 'Load in kg' });
// The button that writes the fields: « Validate set n » on a set to do, « Save » otherwise.
const save = () => sheet().getByRole('button', { name: /^(Save|Validate set \d+)$/ });
const rpe = (value) => sheet().getByRole('button', { name: `RPE ${value}` });
const rpeGrid = () => sheet().queryByRole('button', { name: 'RPE 6.5' });

beforeEach(() => {
  vi.clearAllMocks();
  for (const toast of getToasts()) dismissToast(toast.id);
});

describe('the sheet of a set', () => {
  it('is a dialog named by the set, with the fields of what was done and the ratings', () => {
    renderSheet({ ...baseLog, target_reps: 10, target_weight_kg: 80 }, { title: 'Set 1, done' });
    expect(isOpen()).toBe(true);
    expect(sheet().getByRole('heading', { level: 2, name: 'Set 1, done' })).toBeInTheDocument();
    expect(reps()).toBeInTheDocument();
    expect(load()).toBeInTheDocument();
    expect(sheet().getByText('RPE')).toBeInTheDocument();
    // Half steps from 6 to 10 (L34).
    expect(sheet().getAllByRole('button', { name: /^RPE \d/ }).map((b) => b.textContent)).toEqual([
      '6', '6.5', '7', '7.5', '8', '8.5', '9', '9.5', '10',
    ]);
  });

  it('a failed set offers no rating: RPE is locked there', () => {
    renderSheet({ ...baseLog, failed: true });
    expect(sheet().queryByText('RPE')).toBeNull();
    expect(rpeGrid()).toBeNull();
  });

  it('its fields are tall enough to tap, and its buttons are Parc buttons, 44 px at least', () => {
    renderSheet({ ...baseLog, target_reps: 10, target_weight_kg: 80 });
    // `.pk-field` and `.pk-btn` carry the size (test/hitTargets.test.js).
    expect(reps()).toHaveClass('pk-field', 'min-h-button-lg');
    expect(load()).toHaveClass('pk-field', 'min-h-button-lg');
    expect(save()).toHaveClass('pk-btn');
    expect(sheet().getByRole('button', { name: 'Skip the set' })).toHaveClass('pk-btn');
  });

  it('closes on its round button and on Escape, writing nothing', async () => {
    const user = userEvent.setup();
    const { onClose } = renderSheet({ ...baseLog, target_reps: 10, target_weight_kg: 80 });

    await user.click(sheet().getByRole('button', { name: 'Close' }));
    expect(isOpen()).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Open the set' }));
    await user.keyboard('{Escape}');
    expect(isOpen()).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(2);

    expect(mockLogActual.mutate).not.toHaveBeenCalled();
    expect(mockSetRpe.mutate).not.toHaveBeenCalled();
  });
});

describe('what was done (the actual values)', () => {
  const repLog = { ...baseLog, target_reps: 10, target_weight_kg: 80 };

  it('the fields open on the prescribed target', () => {
    renderSheet(repLog);
    expect(reps()).toHaveValue('10');
    expect(load()).toHaveValue('80');
  });

  it('only the dimension that differs is stored; a value equal to its target is stored as null', async () => {
    const user = userEvent.setup();
    renderSheet({ ...repLog, done: true });
    // Reps down to 8, the load left at the prescribed 80.
    await user.clear(reps());
    await user.type(reps(), '8');
    await user.click(save());
    expect(mockLogActual.mutate).toHaveBeenCalledWith({
      logId: 'log-1',
      actualReps: 8,
      actualWeightKg: null,
    });
    expect(isOpen()).toBe(false);
  });

  it('an added load against a bodyweight prescription is stored', async () => {
    const user = userEvent.setup();
    renderSheet({ ...baseLog, done: true, target_reps: 12, target_weight_kg: null });
    await user.type(load(), '20');
    await user.click(save());
    expect(mockLogActual.mutate).toHaveBeenCalledWith({
      logId: 'log-1',
      actualReps: null,
      actualWeightKg: 20,
    });
  });

  it('the fields open on the logged actual, and « Back to the target » clears it', async () => {
    const user = userEvent.setup();
    renderSheet({ ...repLog, done: true, actual_reps: 8, actual_weight_kg: 100 });
    expect(reps()).toHaveValue('8');
    expect(load()).toHaveValue('100');

    await user.click(sheet().getByRole('button', { name: 'Back to the target' }));
    expect(mockLogActual.mutate).toHaveBeenCalledWith({
      logId: 'log-1',
      actualReps: null,
      actualWeightKg: null,
    });
    expect(isOpen()).toBe(false);
  });

  it('a set without a logged actual has nothing to clear', () => {
    renderSheet({ ...repLog, done: true });
    expect(sheet().queryByRole('button', { name: 'Back to the target' })).toBeNull();
  });

  it('a set held for a time has no reps to give: the load only', () => {
    renderSheet({ ...baseLog, target_reps: null, target_duration_seconds: 30 });
    expect(queryReps()).toBeNull();
    expect(load()).toBeInTheDocument();
  });

  // A set of a session confirmed or read-only is what was logged: the sheet
  // writes nothing. The row is pressable there only to watch a video.
  it('locked, the sheet holds no field and no write: the video only, which cannot be replaced', () => {
    const video = { id: 'vid-1', storage_path: 'u-1/slot-1/a.mp4' };
    const { rerenderWith } = renderSheet(
      { ...repLog, done: true, actual_reps: 8, actual_weight_kg: 100 },
      { locked: true, recordVideo: true, video },
    );
    expect(queryReps()).toBeNull();
    expect(queryLoad()).toBeNull();
    expect(rpeGrid()).toBeNull();
    expect(sheet().queryByRole('button', { name: /Back to the target|Skip the set|Save/ })).toBeNull();
    expect(sheet().getByTestId('video')).toHaveAttribute('data-video', 'vid-1');
    expect(sheet().getByTestId('video')).toHaveAttribute('data-disabled', 'yes');

    rerenderWith({ ...repLog }, { locked: true });
    expect(sheet().queryByTestId('video')).toBeNull();
    expect(queryLoad()).toBeNull();
  });
});

describe('the video of a set the coach asked to film', () => {
  it('is in the sheet of that set, and only there', () => {
    const video = { id: 'vid-2', storage_path: 'x' };
    const { rerenderWith } = renderSheet({ ...baseLog, done: true }, { recordVideo: true, video });
    expect(sheet().getByText('Video')).toBeInTheDocument();
    expect(sheet().getByTestId('video')).toHaveAttribute('data-set', 'log-1');
    expect(sheet().getByTestId('video')).toHaveAttribute('data-video', 'vid-2');
    expect(sheet().getByTestId('video')).toHaveAttribute('data-disabled', 'no');

    rerenderWith({ ...baseLog, done: true }, { recordVideo: false });
    expect(sheet().queryByTestId('video')).toBeNull();
  });
});

// P27. A set rated or given its actual values without being validated stayed
// to do: the session was confirmed with no set done, and Stats, the records,
// "Last time" and the coach all saw it as not done. On a set to do, a rating
// and the sheet's « Validate set n » ARE the set done: one write with the
// value and `done: true`, which the hook dates at the tap.
describe('a rating or the values given on a set to do mark it done, in the same write', () => {
  const log = { ...baseLog, target_reps: 10, target_weight_kg: 80, target_rest_seconds: 90 };

  it('a rating on a set to do is one write: the rating and the set done, and the sheet closes', async () => {
    const user = userEvent.setup();
    renderSheet(log);

    await user.click(rpe(8));

    expect(mockSetRpe.mutate).toHaveBeenCalledTimes(1);
    expect(mockSetRpe.mutate).toHaveBeenCalledWith({ logId: 'log-1', rpe: 8, done: true });
    expect(mockToggleDone.mutate).not.toHaveBeenCalled();
    expect(isOpen()).toBe(false);
  });

  it('it is the gesture that marks the set done: the rest of the set starts, once', async () => {
    const user = userEvent.setup();
    const { rerenderWith } = renderSheet(log);

    await user.click(rpe(8));
    // The optimistic write, a read that comes back without it, the write landing.
    rerenderWith({ ...log, done: true, rpe: 8 });
    rerenderWith(log);
    rerenderWith({ ...log, done: true, rpe: 8, logged_at: '2026-10-09T18:02:11+00:00' });

    expect(startRestTimer).toHaveBeenCalledTimes(1);
    expect(startRestTimer).toHaveBeenCalledWith('log-1', 90);
    expect(clearRestTimer).not.toHaveBeenCalled();
  });

  it('a rating changed on a done set is the rating alone: the set is not dated again', async () => {
    const user = userEvent.setup();
    renderSheet({ ...log, done: true, rpe: 7 });

    expect(rpe(7)).toHaveAttribute('aria-pressed', 'true');
    await user.click(rpe(9));

    expect(mockSetRpe.mutate).toHaveBeenCalledWith({ logId: 'log-1', rpe: 9 });
    expect(startRestTimer).not.toHaveBeenCalled();
  });

  // L34. Half steps from 6 to 10: the rating is sent as the number it is.
  it('a half-step rating on a set to do is sent as it is, with the set done', async () => {
    const user = userEvent.setup();
    renderSheet(log);

    await user.click(rpe(7.5));

    expect(mockSetRpe.mutate).toHaveBeenCalledTimes(1);
    expect(mockSetRpe.mutate).toHaveBeenCalledWith({ logId: 'log-1', rpe: 7.5, done: true });
  });

  it('a set rated 7.5 has 7.5 pressed, and only it', () => {
    renderSheet({ ...log, done: true, rpe: 7.5 });
    expect(rpe(7.5)).toHaveAttribute('aria-pressed', 'true');
    expect(rpe(7)).toHaveAttribute('aria-pressed', 'false');
    expect(rpe(8)).toHaveAttribute('aria-pressed', 'false');
  });

  // A rating below 6 — logged before half steps, or by an older build — is
  // not offered any more; it stays on screen and can still be taken back.
  it('a rating that is not offered any more is shown first, pressed, and can be taken back', async () => {
    const user = userEvent.setup();
    renderSheet({ ...log, done: true, rpe: 4 });

    const ratings = sheet().getAllByRole('button', { name: /^RPE \d/ });
    expect(ratings[0]).toHaveAccessibleName('RPE 4');
    expect(ratings[0]).toHaveAttribute('aria-pressed', 'true');
    await user.click(ratings[0]);
    expect(mockSetRpe.mutate).toHaveBeenCalledWith({ logId: 'log-1', rpe: null });
  });

  it('a rating taken back marks nothing done', async () => {
    const user = userEvent.setup();
    // A rating left on a set that was never validated, by a build before this rule.
    renderSheet({ ...log, rpe: 6 });

    await user.click(rpe(6));

    expect(mockSetRpe.mutate).toHaveBeenCalledWith({ logId: 'log-1', rpe: null });
    expect(startRestTimer).not.toHaveBeenCalled();
  });

  it('values saved on a set to do are one write: the values and the set done, then the RPE sheet', async () => {
    const user = userEvent.setup();
    const { onNeedRpe } = renderSheet(log);

    await user.clear(reps());
    await user.type(reps(), '8');
    await user.click(sheet().getByRole('button', { name: 'Validate set 1' }));

    expect(mockLogActual.mutate).toHaveBeenCalledTimes(1);
    expect(mockLogActual.mutate).toHaveBeenCalledWith({
      logId: 'log-1',
      actualReps: 8,
      actualWeightKg: null,
      done: true,
    });
    expect(mockToggleDone.mutate).not.toHaveBeenCalled();
    // The gesture that marked it done: its rest, and the sheet for its rating.
    expect(startRestTimer).toHaveBeenCalledTimes(1);
    expect(startRestTimer).toHaveBeenCalledWith('log-1', 90);
    expect(onNeedRpe).toHaveBeenCalledTimes(1);
    expect(isOpen()).toBe(false);
  });

  it('"did it as written" on a set to do (open, Validate) is the set done', async () => {
    const user = userEvent.setup();
    renderSheet(log);

    await user.click(sheet().getByRole('button', { name: 'Validate set 1' }));

    expect(mockLogActual.mutate).toHaveBeenCalledWith({
      logId: 'log-1',
      actualReps: null,
      actualWeightKg: null,
      done: true,
    });
  });

  it('values saved on a done set are the values alone: no rest, no RPE sheet', async () => {
    const user = userEvent.setup();
    const { onNeedRpe } = renderSheet({ ...log, done: true });

    await user.click(sheet().getByRole('button', { name: 'Save' }));

    expect(mockLogActual.mutate).toHaveBeenCalledWith({
      logId: 'log-1',
      actualReps: null,
      actualWeightKg: null,
    });
    expect(startRestTimer).not.toHaveBeenCalled();
    expect(onNeedRpe).not.toHaveBeenCalled();
    expect(isOpen()).toBe(false);
  });

  it('values saved on a failed set leave it failed', async () => {
    const user = userEvent.setup();
    renderSheet({ ...log, failed: true });

    await user.clear(load());
    await user.type(load(), '75');
    await user.click(sheet().getByRole('button', { name: 'Save' }));

    expect(mockLogActual.mutate).toHaveBeenCalledWith({
      logId: 'log-1',
      actualReps: null,
      actualWeightKg: 75,
    });
    expect(mockToggleDone.mutate).not.toHaveBeenCalled();
    expect(startRestTimer).not.toHaveBeenCalled();
  });

  it('clearing the actual of a set to do marks nothing done', async () => {
    const user = userEvent.setup();
    renderSheet({ ...log, actual_reps: 8 });

    await user.click(sheet().getByRole('button', { name: 'Back to the target' }));

    expect(mockLogActual.mutate).toHaveBeenCalledWith({
      logId: 'log-1',
      actualReps: null,
      actualWeightKg: null,
    });
    expect(startRestTimer).not.toHaveBeenCalled();
  });
});

// P59. On a swapped exercise the pinned targets are the ORIGINAL exercise's.
// The editor collapsed a value equal to one of them to null, so a swap done
// with the same scheme stored nothing — and the substitute's records and
// "Last time", which only read logged actuals, never had a set.
describe('a swapped exercise stores what was done, as entered', () => {
  // Prescribed 8 × 100 kg on the original exercise.
  const log = { ...baseLog, done: true, target_reps: 8, target_weight_kg: 100 };
  const swapped = (seeds = {}) => ({ exercise: { swapped: true, ...seeds } });

  it('values equal to the original targets are stored, both of them', async () => {
    const user = userEvent.setup();
    renderSheet(log, swapped({ seedReps: 8, seedWeightKg: 100 }));

    await user.click(save());

    expect(mockLogActual.mutate).toHaveBeenCalledWith({
      logId: 'log-1',
      actualReps: 8,
      actualWeightKg: 100,
    });
  });

  it("the fields open on the seeds they are given: the substitute's last performance", () => {
    renderSheet(log, swapped({ seedReps: 6, seedWeightKg: 32.5 }));
    expect(reps()).toHaveValue('6');
    expect(load()).toHaveValue('32.5');
  });

  it('without seeds, the reps start from the prescribed ones and the load from nothing', () => {
    renderSheet(log, swapped());
    expect(reps()).toHaveValue('8');
    expect(load()).toHaveValue('');
  });

  it('what the set already holds comes before the seeds', () => {
    renderSheet({ ...log, actual_reps: 7, actual_weight_kg: 40 }, swapped({ seedReps: 6, seedWeightKg: 32.5 }));
    expect(reps()).toHaveValue('7');
    expect(load()).toHaveValue('40');
  });

  it("a load left empty is no load, not the original exercise's", async () => {
    const user = userEvent.setup();
    renderSheet(log, swapped());

    await user.click(save());

    expect(mockLogActual.mutate).toHaveBeenCalledWith({
      logId: 'log-1',
      actualReps: 8,
      actualWeightKg: 0,
    });
  });

  it('on a set to do, the same button marks it done (P27)', async () => {
    const user = userEvent.setup();
    renderSheet({ ...log, done: false }, swapped({ seedReps: 8, seedWeightKg: 100 }));

    await user.click(sheet().getByRole('button', { name: 'Validate set 1' }));

    expect(mockLogActual.mutate).toHaveBeenCalledWith({
      logId: 'log-1',
      actualReps: 8,
      actualWeightKg: 100,
      done: true,
    });
  });

  it('the exercise as the coach wrote it keeps the rule: a value equal to its target is stored as null', async () => {
    const user = userEvent.setup();
    renderSheet(log, { exercise: { seedReps: 6, seedWeightKg: 32.5 } });

    // Seeds are for a swap: this sheet opens on the targets.
    expect(reps()).toHaveValue('8');
    expect(load()).toHaveValue('100');
    await user.click(save());

    expect(mockLogActual.mutate).toHaveBeenCalledWith({
      logId: 'log-1',
      actualReps: null,
      actualWeightKg: null,
    });
  });
});

describe('the rest of the set follows what the athlete does in the sheet', () => {
  const log = { ...baseLog, target_reps: 10, target_rest_seconds: 90 };

  // Back to to do: the rest this set started is over.
  it('« Not failed after all » puts a failed set back to do, and clears its rest', async () => {
    const user = userEvent.setup();
    renderSheet({ ...log, failed: true });

    await user.click(sheet().getByRole('button', { name: 'Not failed after all' }));

    expect(mockSetFailed.mutate).toHaveBeenCalledWith({ logId: 'log-1', failed: false });
    expect(clearRestTimer).toHaveBeenCalledTimes(1);
    expect(clearRestTimer).toHaveBeenCalledWith('log-1');
    expect(isOpen()).toBe(false);
  });

  it('« Not failed after all » is on a failed set only', () => {
    renderSheet({ ...log, done: true });
    expect(sheet().queryByRole('button', { name: 'Not failed after all' })).toBeNull();
  });

  it('a set that goes back to do without a gesture clears nothing', () => {
    // A write that was taken back, or a read that does not have it yet.
    const { rerenderWith } = renderSheet({ ...log, failed: true });
    rerenderWith(log);
    rerenderWith({ ...log, done: true });
    expect(clearRestTimer).not.toHaveBeenCalled();
    expect(startRestTimer).not.toHaveBeenCalled();
  });

  it('skipping the set clears its rest', async () => {
    const user = userEvent.setup();
    renderSheet({ ...log, done: true });

    await user.click(sheet().getByRole('button', { name: 'Skip the set' }));

    expect(mockSetSkipped.mutate).toHaveBeenCalledWith({ logId: 'log-1', skipped: true });
    expect(clearRestTimer).toHaveBeenCalledWith('log-1');
  });

  it('a set without a prescribed rest starts none', async () => {
    const user = userEvent.setup();
    renderSheet({ ...log, target_rest_seconds: null });
    await user.click(rpe(8));
    expect(mockSetRpe.mutate).toHaveBeenCalledTimes(1);
    expect(startRestTimer).not.toHaveBeenCalled();
  });
});

describe('a skipped set', () => {
  const repLog = { ...baseLog, target_reps: 10, target_weight_kg: 80 };

  it('says so, and offers no field and no rating', () => {
    renderSheet({ ...repLog, skipped: true });
    expect(sheet().getByText('You skipped this set.')).toBeInTheDocument();
    expect(queryReps()).toBeNull();
    expect(queryLoad()).toBeNull();
    expect(rpeGrid()).toBeNull();
  });

  it('a set skipped before comes back to do with « Bring the set back »', async () => {
    const user = userEvent.setup();
    renderSheet({ ...repLog, skipped: true });
    await user.click(sheet().getByRole('button', { name: 'Bring the set back' }));
    expect(mockSetSkipped.mutate).toHaveBeenCalledTimes(1);
    expect(mockSetSkipped.mutate).toHaveBeenCalledWith({ logId: 'log-1', skipped: false });
    expect(isOpen()).toBe(false);
  });

  it('a set is skipped from its sheet', async () => {
    const user = userEvent.setup();
    renderSheet(repLog);
    await user.click(sheet().getByRole('button', { name: 'Skip the set' }));
    expect(mockSetSkipped.mutate).toHaveBeenCalledWith({ logId: 'log-1', skipped: true });
    expect(isOpen()).toBe(false);
  });

  it('an extra set is not skipped: it is removed', () => {
    renderSheet({ ...baseLog, is_student_added: true });
    expect(sheet().queryByRole('button', { name: 'Skip the set' })).toBeNull();
    expect(sheet().getByRole('button', { name: 'Remove the set' })).toBeInTheDocument();
  });
});

// P68. Skipping a set clears its outcome, its RPE and its actual values
// (`patchForSkipped`): an Undo that only dropped the flag brought the set back
// to do. The skip is followed by a toast whose Undo writes all of it back; the
// sheet's « Bring the set back » does the same after a skip made in it.
describe('a skipped set comes back as it was with Undo', () => {
  const doneLog = {
    ...baseLog,
    target_reps: 10,
    target_weight_kg: 80,
    target_rest_seconds: 90,
    done: true,
    rpe: 8,
    logged_at: '2026-10-15T18:02:11+00:00',
    actual_reps: 8,
    actual_weight_kg: null,
  };

  async function skip(user) {
    await user.click(sheet().getByRole('button', { name: 'Skip the set' }));
  }

  const order = (mock) => mock.mock.invocationCallOrder;

  it('the skip says so, and its Undo writes back the outcome dated as it was, the RPE and the actual values', async () => {
    const user = userEvent.setup();
    renderSheet(doneLog);
    await skip(user);

    expect(mockSetSkipped.mutate).toHaveBeenCalledWith({ logId: 'log-1', skipped: true });
    const [toast] = getToasts();
    expect(toast).toMatchObject({
      kind: 'info',
      message: 'parcSession.toastSkipped',
      action: { label: 'uiSharedHelpers.undo' },
    });

    toast.action.onClick();

    expect(mockSetSkipped.mutate).toHaveBeenLastCalledWith({ logId: 'log-1', skipped: false });
    expect(mockToggleDone.mutate).toHaveBeenCalledWith({
      logId: 'log-1',
      done: true,
      at: '2026-10-15T18:02:11+00:00',
    });
    expect(mockSetRpe.mutate).toHaveBeenCalledWith({ logId: 'log-1', rpe: 8 });
    expect(mockLogActual.mutate).toHaveBeenCalledWith({ logId: 'log-1', actualReps: 8, actualWeightKg: null });
    // In this order, on the row's queue.
    expect(order(mockSetSkipped.mutate)[1]).toBeLessThan(order(mockToggleDone.mutate)[0]);
    expect(order(mockToggleDone.mutate)[0]).toBeLessThan(order(mockSetRpe.mutate)[0]);
    expect(order(mockSetRpe.mutate)[0]).toBeLessThan(order(mockLogActual.mutate)[0]);
    expect(mockSetFailed.mutate).not.toHaveBeenCalled();
    // The rest the skip cleared is not started again.
    expect(startRestTimer).not.toHaveBeenCalled();
  });

  it('a failed set comes back failed, dated as it was', async () => {
    const user = userEvent.setup();
    renderSheet({
      ...doneLog,
      done: false,
      rpe: null,
      logged_at: null,
      failed: true,
      failed_at: '2026-10-15T18:05:00+00:00',
      actual_reps: null,
    });
    await skip(user);

    getToasts()[0].action.onClick();

    expect(mockSetFailed.mutate).toHaveBeenCalledWith({ logId: 'log-1', failed: true, at: '2026-10-15T18:05:00+00:00' });
    expect(mockToggleDone.mutate).not.toHaveBeenCalled();
    expect(mockSetRpe.mutate).not.toHaveBeenCalled();
    expect(mockLogActual.mutate).not.toHaveBeenCalled();
  });

  it('a set to do comes back to do: one write', async () => {
    const user = userEvent.setup();
    renderSheet({ ...baseLog, target_reps: 10, target_weight_kg: 80 });
    await skip(user);

    getToasts()[0].action.onClick();

    expect(mockSetSkipped.mutate).toHaveBeenCalledTimes(2);
    expect(mockSetSkipped.mutate).toHaveBeenLastCalledWith({ logId: 'log-1', skipped: false });
    expect(mockToggleDone.mutate).not.toHaveBeenCalled();
    expect(mockSetFailed.mutate).not.toHaveBeenCalled();
    expect(mockSetRpe.mutate).not.toHaveBeenCalled();
    expect(mockLogActual.mutate).not.toHaveBeenCalled();
  });

  it("the sheet's « Bring the set back » is the same way back, closes the toast, and the toast's Undo does nothing more", async () => {
    const user = userEvent.setup();
    const { rerenderWith } = renderSheet(doneLog);
    await skip(user);
    const [toast] = getToasts();
    // The optimistic skip on screen, and the set's sheet opened again.
    rerenderWith({ ...doneLog, skipped: true, done: false, rpe: null, logged_at: null, actual_reps: null });
    await user.click(screen.getByRole('button', { name: 'Open the set' }));

    await user.click(sheet().getByRole('button', { name: 'Bring the set back' }));

    expect(getToasts()).toEqual([]);
    expect(mockToggleDone.mutate).toHaveBeenCalledWith({
      logId: 'log-1',
      done: true,
      at: '2026-10-15T18:02:11+00:00',
    });
    expect(mockSetRpe.mutate).toHaveBeenCalledWith({ logId: 'log-1', rpe: 8 });

    toast.action.onClick();
    expect(mockSetSkipped.mutate).toHaveBeenCalledTimes(2);
    expect(mockToggleDone.mutate).toHaveBeenCalledTimes(1);
  });
});

// P68. One tap on "Extra ✕" deleted the set, its outcome, its RPE and what it
// said was done. The removal is now followed by a toast whose Undo puts the
// row back as the database answered it.
describe('a removed extra set comes back with Undo', () => {
  const removed = {
    id: 'log-4',
    exercise_slot_id: 'slot-1',
    set_number: 4,
    is_student_added: true,
    done: true,
    failed: false,
    rpe: 8,
    logged_at: '2026-10-15T18:02:11+00:00',
    failed_at: null,
    actual_reps: 8,
    actual_weight_kg: 100,
  };
  const extraLog = { ...baseLog, ...removed };
  const remove = (user) => user.click(sheet().getByRole('button', { name: 'Remove the set' }));

  afterEach(() => {
    onlineManager.setOnline(true);
  });

  it('the removal says so, and its Undo inserts the set again — the row gone or not', async () => {
    const user = userEvent.setup();
    mockRemoveStudentSet.mutateAsync.mockResolvedValueOnce({ logId: 'log-4', removed });
    const { unmount } = renderSheet(extraLog);

    await remove(user);

    expect(mockRemoveStudentSet.mutateAsync).toHaveBeenCalledWith({ logId: 'log-4' });
    expect(isOpen()).toBe(false);
    await waitFor(() => expect(getToasts()).toHaveLength(1));
    const [toast] = getToasts();
    expect(toast).toMatchObject({
      kind: 'info',
      message: 'parcSession.toastRemoved',
      action: { label: 'uiSharedHelpers.undo' },
    });
    expect(mockAddStudentSet.mutate).not.toHaveBeenCalled();

    // The list read again without the set: its sheet is gone.
    unmount();
    toast.action.onClick();

    expect(mockAddStudentSet.mutate).toHaveBeenCalledTimes(1);
    expect(mockAddStudentSet.mutate).toHaveBeenCalledWith({
      slotId: 'slot-1',
      setNumber: 4,
      restore: removed,
    });
  });

  it('nothing removed — a session closed meanwhile — offers nothing to undo', async () => {
    const user = userEvent.setup();
    mockRemoveStudentSet.mutateAsync.mockResolvedValueOnce({ logId: 'log-4', removed: null });
    renderSheet(extraLog);

    await remove(user);
    await act(async () => {});

    expect(getToasts()).toEqual([]);
  });

  it('a refused removal offers nothing to undo either (its error has its own toast)', async () => {
    const user = userEvent.setup();
    mockRemoveStudentSet.mutateAsync.mockRejectedValueOnce(new Error('refused'));
    renderSheet(extraLog);

    await remove(user);
    await act(async () => {});

    expect(getToasts()).toEqual([]);
  });

  it('without a network, Undo inserts nothing and says why', async () => {
    const user = userEvent.setup();
    mockRemoveStudentSet.mutateAsync.mockResolvedValueOnce({ logId: 'log-4', removed });
    renderSheet(extraLog);
    await remove(user);
    await waitFor(() => expect(getToasts()).toHaveLength(1));

    onlineManager.setOnline(false);
    getToasts()[0].action.onClick();

    expect(mockAddStudentSet.mutate).not.toHaveBeenCalled();
    expect(getToasts().at(-1)).toMatchObject({ kind: 'error', message: 'parcSession.undoNeedsNetwork' });
  });

  // The removal is a delete of a row, online-only like the insert that would
  // bring it back.
  it('without a network, an extra set cannot be removed', () => {
    renderSheet(extraLog, { online: false });
    expect(sheet().queryByRole('button', { name: 'Remove the set' })).toBeNull();
  });

  it('a removal on its way holds the button', () => {
    mockRemoveStudentSet.isPending = true;
    try {
      renderSheet(extraLog);
      expect(sheet().getByRole('button', { name: 'Remove the set' })).toBeDisabled();
    } finally {
      mockRemoveStudentSet.isPending = false;
    }
  });
});

// P61. An extra set has no targets. Validated as it was, it counted as a set
// with no volume, or as 1 kg a rep, or added reps to an exercise measured in
// seconds. It now says what was done before it can be done: its sheet opens
// on the set before it (`seedReps` / `seedWeightKg`, worked out by
// sessionModel `editorSeeds`), and validates only once its fields say it.
describe('an extra set is done once it says what was done', () => {
  const extra = {
    ...baseLog,
    id: 'log-4',
    set_number: 4,
    is_student_added: true,
    target_rest_seconds: 90,
    actual_reps: null,
    actual_weight_kg: null,
  };
  const seeds = { exercise: { seedReps: 8, seedWeightKg: 100 } };
  const hint = () => sheet().queryByText(/to validate this set/i);
  const validate = () => sheet().getByRole('button', { name: 'Validate set 4' });

  it('its sheet opens on the set before it, and validating writes the values and the set done in one write', async () => {
    const user = userEvent.setup();
    const { onNeedRpe } = renderSheet(extra, seeds);
    expect(reps()).toHaveValue('8');
    expect(load()).toHaveValue('100');
    expect(hint()).toBeNull();

    await user.click(validate());

    expect(mockLogActual.mutate).toHaveBeenCalledTimes(1);
    expect(mockLogActual.mutate).toHaveBeenCalledWith({
      logId: 'log-4',
      actualReps: 8,
      actualWeightKg: 100,
      done: true,
    });
    expect(mockToggleDone.mutate).not.toHaveBeenCalled();
    expect(startRestTimer).toHaveBeenCalledTimes(1);
    expect(startRestTimer).toHaveBeenCalledWith('log-4', 90);
    expect(onNeedRpe).toHaveBeenCalledTimes(1);
  });

  it('after a bodyweight set, it opens on 0 kg — none added — and validates as it is', async () => {
    const user = userEvent.setup();
    renderSheet(extra, { exercise: { seedReps: 12, seedWeightKg: 0 } });
    expect(load()).toHaveValue('0');

    await user.click(validate());

    expect(mockLogActual.mutate).toHaveBeenCalledWith({
      logId: 'log-4',
      actualReps: 12,
      actualWeightKg: 0,
      done: true,
    });
  });

  it('a rating does not mark an empty extra set done: the sheet stays, and says what it needs', async () => {
    const user = userEvent.setup();
    renderSheet(extra);

    await user.click(rpe(8));

    expect(mockSetRpe.mutate).not.toHaveBeenCalled();
    expect(isOpen()).toBe(true);
    expect(hint()).toHaveTextContent('Enter the reps and the load (0 at bodyweight) to validate this set.');
  });

  it('a sheet left open when the set went back to empty rates nothing either', async () => {
    const user = userEvent.setup();
    const done = { ...extra, done: true, actual_reps: 8, actual_weight_kg: 100 };
    const { rerenderWith } = renderSheet(done, seeds);
    // A write taken back, a read without it.
    rerenderWith(extra, seeds);

    await user.click(rpe(8));

    expect(mockSetRpe.mutate).not.toHaveBeenCalled();
    expect(isOpen()).toBe(true);
  });

  it('without a set before it the fields are empty, and Validate waits for reps and a load', async () => {
    const user = userEvent.setup();
    renderSheet(extra);

    expect(reps()).toHaveValue('');
    expect(validate()).toBeDisabled();
    expect(hint()).toHaveTextContent('Enter the reps and the load (0 at bodyweight) to validate this set.');
    expect(hint()).toHaveAttribute('role', 'status');

    await user.type(reps(), '10');
    expect(validate()).toBeDisabled();
    await user.click(validate());
    expect(mockLogActual.mutate).not.toHaveBeenCalled();

    // 0 is a load: no load added, at bodyweight.
    await user.type(load(), '0');
    expect(validate()).toBeEnabled();
    expect(hint()).toBeNull();
    await user.click(validate());

    expect(mockLogActual.mutate).toHaveBeenCalledWith({
      logId: 'log-4',
      actualReps: 10,
      actualWeightKg: 0,
      done: true,
    });
  });

  it('0 reps is not a set done', () => {
    renderSheet(extra, { exercise: { seedReps: 0, seedWeightKg: 20 } });
    expect(validate()).toBeDisabled();
  });

  it('on an exercise measured in seconds it asks for the load only, and stores no reps', async () => {
    const user = userEvent.setup();
    renderSheet(extra, { exercise: { durationBased: true, seedReps: 12 } });

    expect(queryReps()).toBeNull();
    expect(hint()).toHaveTextContent('Enter the load (0 at bodyweight) to validate this set.');
    await user.type(load(), '20');
    await user.click(validate());

    expect(mockLogActual.mutate).toHaveBeenCalledWith({
      logId: 'log-4',
      actualReps: null,
      actualWeightKg: 20,
      done: true,
    });
  });

  it('a done extra set keeps its values: no « Back to the target », and no Save without them', async () => {
    const user = userEvent.setup();
    renderSheet({ ...extra, done: true, actual_reps: 8, actual_weight_kg: 100 });

    expect(sheet().queryByRole('button', { name: 'Back to the target' })).toBeNull();
    await user.clear(load());
    expect(sheet().getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});

// P31 (live N3, L9). The two fields were `type="number"`, which reads "82,5" by
// the language of the browser: 825 in a Chromium whose UI is English, "" in
// WebKit — and "" was read as null, which on a set written as prescribed erased
// the actual it held and on a swapped or extra set stored 0 kg. They are text
// fields now, read by lib/number: a comma or a point is a decimal separator,
// and text that is not a number is refused, never saved.
describe('a decimal comma is read, and text that is not a number is refused (P31)', () => {
  // Prescribed 10 × 80 kg, done.
  const log = { ...baseLog, done: true, target_reps: 10, target_weight_kg: 80 };

  async function typeLoad(user, text) {
    await user.clear(load());
    if (text) await user.type(load(), text);
  }

  it('the fields are text with a numeric keypad, not number fields', () => {
    renderSheet(log);
    expect(reps()).toHaveAttribute('type', 'text');
    expect(reps()).toHaveAttribute('inputmode', 'numeric');
    expect(load()).toHaveAttribute('type', 'text');
    expect(load()).toHaveAttribute('inputmode', 'decimal');
  });

  it.each(['82,5', '82.5'])('"%s" is 82.5 kg, whatever the browser', async (text) => {
    const user = userEvent.setup();
    renderSheet(log);

    await typeLoad(user, text);
    expect(sheet().queryByRole('alert')).toBeNull();
    await user.click(save());

    expect(mockLogActual.mutate).toHaveBeenCalledWith({
      logId: 'log-1',
      actualReps: null,
      actualWeightKg: 82.5,
    });
  });

  it('a load that is not a number is not saved, and the actual the set holds stays', async () => {
    const user = userEvent.setup();
    renderSheet({ ...log, actual_reps: 8, actual_weight_kg: 100 });

    await typeLoad(user, 'abc');

    const alert = sheet().getByRole('alert');
    expect(alert).toHaveTextContent('Enter a number, like 82.5');
    expect(load()).toHaveAttribute('aria-invalid', 'true');
    expect(load()).toHaveAttribute('aria-describedby', alert.id);
    expect(save()).toBeDisabled();
    await user.click(save());
    expect(mockLogActual.mutate).not.toHaveBeenCalled();
    // The sheet stays open on what was typed.
    expect(isOpen()).toBe(true);
    expect(load()).toHaveValue('abc');
  });

  it('reps that are not a whole number are refused with their own message', async () => {
    const user = userEvent.setup();
    renderSheet(log);

    await user.clear(reps());
    await user.type(reps(), '8,5');

    expect(sheet().getByRole('alert')).toHaveTextContent('Enter a whole number');
    expect(reps()).toHaveAttribute('aria-invalid', 'true');
    await user.click(save());
    expect(mockLogActual.mutate).not.toHaveBeenCalled();
  });

  it('a load past what the column holds is refused here, not by the server on replay', async () => {
    const user = userEvent.setup();
    renderSheet(log);

    await typeLoad(user, '10000');

    expect(sheet().getByRole('alert')).toBeInTheDocument();
    await user.click(save());
    expect(mockLogActual.mutate).not.toHaveBeenCalled();
  });

  it('a field left empty is still "as prescribed", and a corrected text clears the alert', async () => {
    const user = userEvent.setup();
    renderSheet({ ...log, actual_reps: 8, actual_weight_kg: 100 });

    await typeLoad(user, '9o');
    expect(sheet().getByRole('alert')).toBeInTheDocument();
    await typeLoad(user, '');
    expect(sheet().queryByRole('alert')).toBeNull();
    expect(load()).not.toHaveAttribute('aria-invalid');
    await user.click(save());

    expect(mockLogActual.mutate).toHaveBeenCalledWith({
      logId: 'log-1',
      actualReps: 8,
      actualWeightKg: null,
    });
  });

  it('on a swapped exercise, text that is not a number is not stored as no load', async () => {
    const user = userEvent.setup();
    renderSheet(log, { exercise: { swapped: true, seedReps: 8, seedWeightKg: 30 } });

    await typeLoad(user, 'abc');
    await user.click(save());

    expect(mockLogActual.mutate).not.toHaveBeenCalled();
    expect(sheet().getByRole('alert')).toHaveTextContent('Enter a number, like 82.5');

    await typeLoad(user, '32,5');
    await user.click(save());
    expect(mockLogActual.mutate).toHaveBeenCalledWith({
      logId: 'log-1',
      actualReps: 8,
      actualWeightKg: 32.5,
    });
  });

  describe('on an extra set', () => {
    const extra = {
      ...baseLog,
      id: 'log-4',
      set_number: 4,
      is_student_added: true,
      actual_reps: null,
      actual_weight_kg: null,
    };
    const seeds = { exercise: { seedReps: 8, seedWeightKg: 80 } };

    it('"82,5" is saved as 82.5 and marks the set done', async () => {
      const user = userEvent.setup();
      renderSheet(extra, seeds);

      await typeLoad(user, '82,5');
      await user.click(save());

      expect(mockLogActual.mutate).toHaveBeenCalledWith({
        logId: 'log-4',
        actualReps: 8,
        actualWeightKg: 82.5,
        done: true,
      });
    });

    it('text that is not a number shows the alert, not the "needs reps and load" sentence, and saves nothing', async () => {
      const user = userEvent.setup();
      renderSheet(extra, seeds);

      await typeLoad(user, 'abc');

      expect(sheet().getByRole('alert')).toHaveTextContent('Enter a number, like 82.5');
      expect(sheet().queryByText(/to validate this set/i)).toBeNull();
      await user.click(save());
      expect(mockLogActual.mutate).not.toHaveBeenCalled();
    });
  });
});
