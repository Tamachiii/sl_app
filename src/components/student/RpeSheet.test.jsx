// The sheet that asks the RPE of the set just validated, on the real
// `useSetActions` of that set. The writes are doubles; the sheet is open while
// the page says so (`open`), so a change of the set — a write landing, a read
// that comes back — reopens nothing: only the page's « Validate set n » does.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { render, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockToggleDone = { mutate: vi.fn() };
const mockSetRpe = { mutate: vi.fn() };
const idle = () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false });

vi.mock('../../hooks/useSetLogs', () => ({
  useToggleSetDone: () => mockToggleDone,
  useSetFailed: () => idle(),
  useSetRpe: () => mockSetRpe,
  useLogActual: () => idle(),
  useSetSkipped: () => idle(),
  useAddStudentSet: () => idle(),
  useRemoveStudentSet: () => idle(),
}));

vi.mock('../../hooks/useRestTimer', async () => {
  const actual = await vi.importActual('../../hooks/useRestTimer');
  return { ...actual, startRestTimer: vi.fn(), clearRestTimer: vi.fn() };
});

import RpeSheet from './RpeSheet';
import { startRestTimer } from '../../hooks/useRestTimer';

// Set 2, as the cache shows it once « Validate set 2 » was tapped.
const validated = {
  id: 'log-2',
  exercise_slot_id: 'slot-1',
  set_number: 2,
  target_reps: 5,
  target_weight_kg: 100,
  target_rest_seconds: 120,
  done: true,
  failed: false,
  skipped: false,
  rpe: null,
};

// The page's state around the sheet: open once, closed by what the sheet says.
function Harness({ log, onClose }) {
  const [open, setOpen] = useState(true);
  return (
    <RpeSheet
      open={open}
      log={log}
      setNumber={log.set_number}
      onClose={() => {
        setOpen(false);
        onClose();
      }}
    />
  );
}

function renderSheet(log = validated) {
  const onClose = vi.fn();
  const view = render(<Harness log={log} onClose={onClose} />);
  return { ...view, onClose, rerenderWith: (next) => view.rerender(<Harness log={next} onClose={onClose} />) };
}

const dialog = () => document.querySelector('dialog');
const sheet = () => within(dialog());
const ratings = () => sheet().queryAllByRole('button', { name: /^RPE \d/ });

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the RPE sheet', () => {
  it('asks the RPE of the set, from 6 to 10 in half steps', () => {
    renderSheet();
    expect(dialog().open).toBe(true);
    expect(sheet().getByRole('heading', { level: 2, name: 'RPE of set 2' })).toBeInTheDocument();
    expect(sheet().getByText('From 6, easy, to 10, maximal')).toBeInTheDocument();
    expect(ratings().map((b) => b.textContent)).toEqual(['6', '6.5', '7', '7.5', '8', '8.5', '9', '9.5', '10']);
    for (const button of ratings()) expect(button).toHaveAttribute('aria-pressed', 'false');
  });

  it('a rating is written at the tap, alone — the set is already done — and closes the sheet', async () => {
    const user = userEvent.setup();
    const { onClose } = renderSheet();

    await user.click(sheet().getByRole('button', { name: 'RPE 7.5' }));

    expect(mockSetRpe.mutate).toHaveBeenCalledTimes(1);
    expect(mockSetRpe.mutate).toHaveBeenCalledWith({ logId: 'log-2', rpe: 7.5 });
    expect(mockToggleDone.mutate).not.toHaveBeenCalled();
    // The validation started the rest; the rating starts nothing.
    expect(startRestTimer).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
    expect(dialog().open).toBe(false);
    expect(ratings()).toEqual([]);
  });

  it('« Close without RPE » closes it with none', async () => {
    const user = userEvent.setup();
    const { onClose } = renderSheet();

    await user.click(sheet().getByRole('button', { name: 'Close without RPE' }));

    expect(mockSetRpe.mutate).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
    expect(dialog().open).toBe(false);
  });

  it('Escape closes it with none too', async () => {
    const user = userEvent.setup();
    const { onClose } = renderSheet();

    await user.keyboard('{Escape}');

    expect(mockSetRpe.mutate).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('the rating the set has is pressed, and a tap on it keeps it', async () => {
    const user = userEvent.setup();
    const { onClose } = renderSheet({ ...validated, rpe: 8 });

    const current = sheet().getByRole('button', { name: 'RPE 8' });
    expect(current).toHaveAttribute('aria-pressed', 'true');
    await user.click(current);

    expect(mockSetRpe.mutate).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('a rating that is not offered any more is shown first, pressed', () => {
    renderSheet({ ...validated, rpe: 4 });
    expect(ratings()[0]).toHaveAccessibleName('RPE 4');
    expect(ratings()[0]).toHaveAttribute('aria-pressed', 'true');
  });

  it('stays closed when the set is read again: a validation that leaves the screen and comes back', async () => {
    const user = userEvent.setup();
    const { rerenderWith } = renderSheet();
    await user.click(sheet().getByRole('button', { name: 'RPE 7' }));
    rerenderWith({ ...validated, rpe: 7 });
    expect(dialog().open).toBe(false);

    // A read that was sent before the validation reached the database, then
    // the validation landing: to do again, then done again.
    rerenderWith({ ...validated, done: false });
    rerenderWith({ ...validated, rpe: 7 });

    expect(dialog().open).toBe(false);
    expect(ratings()).toEqual([]);
    expect(mockSetRpe.mutate).toHaveBeenCalledTimes(1);
  });
});
