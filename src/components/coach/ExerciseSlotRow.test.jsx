import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DndContext } from '@dnd-kit/core';
import { SortableContext } from '@dnd-kit/sortable';
import ExerciseSlotRow from './ExerciseSlotRow';

const defaultSlot = {
  id: 'slot-1',
  sets: 3,
  reps: 10,
  weight_kg: 50,
  sort_order: 0,
  exercise: { name: 'Pull Up', type: 'pull', difficulty: 2, volume_weight: 1 },
};

function renderSlotRow(props = {}) {
  const defaultProps = {
    slot: defaultSlot,
    onUpdate: vi.fn(),
    onDelete: vi.fn(),
    ...props,
  };
  const result = render(
    <DndContext>
      <SortableContext items={[defaultProps.slot.id]}>
        <ExerciseSlotRow {...defaultProps} />
      </SortableContext>
    </DndContext>
  );
  return { ...result, props: defaultProps };
}

// The per-set table of the exercise, named after it.
const perSetTable = () => screen.queryByRole('table', { name: 'Targets of each set of Pull Up' });

describe('ExerciseSlotRow', () => {
  // A section named by the exercise: its name, then what it prescribes and
  // its level on one line (design/parc/screens/Editeur.dc.html).
  it('renders exercise name', () => {
    renderSlotRow();
    const card = screen.getByRole('region', { name: 'Pull Up' });
    expect(within(card).getByRole('heading', { level: 2, name: 'Pull Up' })).toBeInTheDocument();
    expect(within(card).getByText('3 × 10 at 50 kg, Level 2')).toBeInTheDocument();
  });

  it('renders a drag handle for reordering', () => {
    renderSlotRow();
    expect(
      screen.getByRole('button', { name: 'Move Pull Up' })
    ).toBeInTheDocument();
  });

  it('clicking delete opens a confirm sheet and confirming calls onDelete', async () => {
    const user = userEvent.setup();
    const { props } = renderSlotRow();

    await user.click(screen.getByRole('button', { name: 'Remove Pull Up' }));
    // The sheet asks about the exercise by name, and says what happens.
    const sheet = screen.getByRole('dialog', { name: 'Remove Pull Up?' });
    expect(sheet).toHaveTextContent('It leaves this session for good.');
    expect(props.onDelete).not.toHaveBeenCalled();

    await user.click(within(sheet).getByRole('button', { name: 'Remove' }));
    expect(props.onDelete).toHaveBeenCalled();
  });

  it('cancelling the confirm sheet does not call onDelete', async () => {
    const user = userEvent.setup();
    const { props } = renderSlotRow();

    await user.click(screen.getByRole('button', { name: 'Remove Pull Up' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(props.onDelete).not.toHaveBeenCalled();
  });

  it('renders sets, reps, and weight inputs', () => {
    renderSlotRow();
    expect(screen.getByLabelText('Sets')).toHaveValue(3);
    expect(screen.getByLabelText('Reps')).toHaveValue(10);
    // A text field (ui/DecimalInput): its value is the text. Empty, it is the
    // athlete's bodyweight.
    expect(screen.getByLabelText('Load in kg')).toHaveValue('50');
    expect(screen.getByLabelText('Load in kg')).toHaveAttribute('placeholder', 'body');
    expect(screen.getByLabelText('Rest in s')).toHaveAttribute('placeholder', '–');
  });

  it('calls onUpdate on sets blur when value changes', async () => {
    const user = userEvent.setup();
    const { props } = renderSlotRow();

    const setsInput = screen.getByLabelText('Sets');
    await user.clear(setsInput);
    await user.type(setsInput, '5');
    fireEvent.blur(setsInput);

    expect(props.onUpdate).toHaveBeenCalledWith(expect.objectContaining({ sets: 5 }));
  });

  // The database holds `sets` above 0: a count below 1 would fail there, or
  // shrink the exercise. The field shows the stored count again.
  it.each(['0', '-2', ''])('writes no sets for "%s" and shows the stored count again', (text) => {
    const { props } = renderSlotRow();
    const setsInput = screen.getByLabelText('Sets');
    fireEvent.change(setsInput, { target: { value: text } });
    fireEvent.blur(setsInput);
    expect(props.onUpdate).not.toHaveBeenCalled();
    expect(setsInput).toHaveValue(3);
  });

  it('keeps what the coach is typing when a refetched slot arrives mid-edit', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <DndContext>
        <SortableContext items={['slot-1']}>
          <ExerciseSlotRow slot={defaultSlot} onUpdate={vi.fn()} onDelete={vi.fn()} />
        </SortableContext>
      </DndContext>
    );

    // Commit Sets, then tab into the load and keep typing. Committing Sets
    // refetches the slot, so the new props land while the load has focus.
    const setsInput = screen.getByLabelText('Sets');
    await user.clear(setsInput);
    await user.type(setsInput, '5');
    const weightInput = screen.getByLabelText('Load in kg');
    await user.click(weightInput);
    await user.clear(weightInput);
    await user.type(weightInput, '7');

    rerender(
      <DndContext>
        <SortableContext items={['slot-1']}>
          <ExerciseSlotRow slot={{ ...defaultSlot, sets: 5 }} onUpdate={vi.fn()} onDelete={vi.fn()} />
        </SortableContext>
      </DndContext>
    );

    expect(screen.getByLabelText('Load in kg')).toHaveValue('7');
  });

  it('shows "Add a note" button when slot has no notes', () => {
    renderSlotRow();
    expect(screen.getByRole('button', { name: 'Add a note' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Note for the athlete')).not.toBeInTheDocument();
  });

  it('reveals notes textarea when "Add a note" is clicked', async () => {
    const user = userEvent.setup();
    renderSlotRow();
    await user.click(screen.getByRole('button', { name: 'Add a note' }));
    expect(screen.getByRole('textbox', { name: 'Note for the athlete' })).toBeInTheDocument();
  });

  it('shows notes textarea pre-expanded when slot already has a note', () => {
    renderSlotRow({ slot: { ...defaultSlot, notes: 'Keep elbows tucked' } });
    expect(screen.getByLabelText('Note for the athlete')).toHaveValue('Keep elbows tucked');
    expect(screen.queryByRole('button', { name: 'Add a note' })).not.toBeInTheDocument();
  });

  it('calls onUpdate with notes on blur when notes change', async () => {
    const user = userEvent.setup();
    const { props } = renderSlotRow();
    await user.click(screen.getByRole('button', { name: 'Add a note' }));
    const textarea = screen.getByLabelText('Note for the athlete');
    await user.type(textarea, 'Focus on the negative');
    fireEvent.blur(textarea);
    expect(props.onUpdate).toHaveBeenCalledWith({ notes: 'Focus on the negative' });
  });

  it('clicking "Set by set" reveals a per-set table', async () => {
    const user = userEvent.setup();
    renderSlotRow({
      slot: {
        ...defaultSlot,
        set_logs: [
          { id: 'l1', set_number: 1, target_reps: 10, target_weight_kg: 50 },
          { id: 'l2', set_number: 2, target_reps: 10, target_weight_kg: 50 },
          { id: 'l3', set_number: 3, target_reps: 10, target_weight_kg: 50 },
        ],
      },
    });
    expect(perSetTable()).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Set by set' }));
    const table = perSetTable();
    expect(table).toBeInTheDocument();
    expect(within(table).getAllByRole('columnheader').map((th) => th.textContent)).toEqual([
      'Set', 'Reps', 'Load in kg', 'Rest in s',
    ]);
    expect(screen.getByLabelText('Set 1, reps')).toHaveValue(10);
    expect(screen.getByLabelText('Set 3, load in kg')).toHaveValue('50');
  });

  it('editing a per-set field calls onUpdateSet with that log id', async () => {
    const user = userEvent.setup();
    const onUpdateSet = vi.fn();
    renderSlotRow({
      slot: {
        ...defaultSlot,
        set_logs: [
          { id: 'l1', set_number: 1, target_reps: 10, target_weight_kg: 50 },
          { id: 'l2', set_number: 2, target_reps: 10, target_weight_kg: 50 },
          { id: 'l3', set_number: 3, target_reps: 10, target_weight_kg: 50 },
        ],
      },
      onUpdateSet,
    });
    await user.click(screen.getByRole('button', { name: 'Set by set' }));
    const repsInput = screen.getByLabelText('Set 3, reps');
    await user.clear(repsInput);
    await user.type(repsInput, '6');
    fireEvent.blur(repsInput);
    expect(onUpdateSet).toHaveBeenCalledWith('l3', { reps: 6 });
  });

  it('opens the per-set editor automatically when sets are heterogeneous', () => {
    renderSlotRow({
      slot: {
        ...defaultSlot,
        set_logs: [
          { id: 'l1', set_number: 1, target_reps: 10, target_weight_kg: 80 },
          { id: 'l2', set_number: 2, target_reps: 6, target_weight_kg: 100 },
        ],
      },
    });
    expect(perSetTable()).toBeInTheDocument();
  });

  it('clicking "Make every set like the first" calls onResetToUniform', async () => {
    const user = userEvent.setup();
    const onResetToUniform = vi.fn();
    renderSlotRow({
      slot: {
        ...defaultSlot,
        set_logs: [
          { id: 'l1', set_number: 1, target_reps: 10, target_weight_kg: 80 },
          { id: 'l2', set_number: 2, target_reps: 6, target_weight_kg: 100 },
        ],
      },
      onResetToUniform,
    });
    expect(screen.queryByRole('button', { name: 'All sets alike' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Make every set like the first' }));
    expect(onResetToUniform).toHaveBeenCalled();
  });

  // Sets that are alike go back to the compact row without a write.
  it('clicking "All sets alike" goes back to the compact row', async () => {
    const user = userEvent.setup();
    const onResetToUniform = vi.fn();
    renderSlotRow({
      slot: {
        ...defaultSlot,
        set_logs: [
          { id: 'l1', set_number: 1, target_reps: 10, target_weight_kg: 50 },
          { id: 'l2', set_number: 2, target_reps: 10, target_weight_kg: 50 },
          { id: 'l3', set_number: 3, target_reps: 10, target_weight_kg: 50 },
        ],
      },
      onResetToUniform,
    });
    await user.click(screen.getByRole('button', { name: 'Set by set' }));
    expect(screen.queryByRole('button', { name: 'Make every set like the first' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'All sets alike' }));
    expect(perSetTable()).toBeNull();
    expect(screen.getByLabelText('Sets')).toHaveValue(3);
    expect(onResetToUniform).not.toHaveBeenCalled();
  });

  it('custom mode hides the Sets input and shows "Add a set" instead', async () => {
    const user = userEvent.setup();
    renderSlotRow({
      slot: {
        ...defaultSlot,
        set_logs: [
          { id: 'l1', set_number: 1, target_reps: 10, target_weight_kg: 50 },
          { id: 'l2', set_number: 2, target_reps: 10, target_weight_kg: 50 },
          { id: 'l3', set_number: 3, target_reps: 10, target_weight_kg: 50 },
        ],
      },
    });
    await user.click(screen.getByRole('button', { name: 'Set by set' }));
    expect(screen.queryByLabelText('Sets')).toBeNull();
    expect(screen.getByRole('button', { name: 'Add a set' })).toBeInTheDocument();
  });

  it('clicking "Add a set" calls onAddSet', async () => {
    const user = userEvent.setup();
    const onAddSet = vi.fn();
    renderSlotRow({
      slot: {
        ...defaultSlot,
        set_logs: [
          { id: 'l1', set_number: 1, target_reps: 10, target_weight_kg: 50 },
          { id: 'l2', set_number: 2, target_reps: 10, target_weight_kg: 50 },
          { id: 'l3', set_number: 3, target_reps: 10, target_weight_kg: 50 },
        ],
      },
      onAddSet,
    });
    await user.click(screen.getByRole('button', { name: 'Set by set' }));
    await user.click(screen.getByRole('button', { name: 'Add a set' }));
    expect(onAddSet).toHaveBeenCalledTimes(1);
  });

  it('clicking the X on a set row calls onRemoveSet with the set number', async () => {
    const user = userEvent.setup();
    const onRemoveSet = vi.fn();
    renderSlotRow({
      slot: {
        ...defaultSlot,
        set_logs: [
          { id: 'l1', set_number: 1, target_reps: 10, target_weight_kg: 50 },
          { id: 'l2', set_number: 2, target_reps: 10, target_weight_kg: 50 },
          { id: 'l3', set_number: 3, target_reps: 10, target_weight_kg: 50 },
        ],
      },
      onRemoveSet,
    });
    await user.click(screen.getByRole('button', { name: 'Set by set' }));
    await user.click(screen.getByRole('button', { name: 'Remove set 2' }));
    expect(onRemoveSet).toHaveBeenCalledWith(2);
  });

  it('disables the X button when only one set remains', async () => {
    const user = userEvent.setup();
    renderSlotRow({
      slot: {
        ...defaultSlot,
        sets: 1,
        set_logs: [
          { id: 'l1', set_number: 1, target_reps: 10, target_weight_kg: 50 },
        ],
      },
    });
    await user.click(screen.getByRole('button', { name: 'Set by set' }));
    expect(screen.getByRole('button', { name: 'Remove set 1' })).toBeDisabled();
  });

  // An exercise held for a time counts seconds where the others count reps.
  describe('an exercise held for a time', () => {
    const heldSlot = {
      ...defaultSlot,
      reps: null,
      duration_seconds: 30,
      weight_kg: null,
      exercise: { name: 'Pull Up', type: 'pull', difficulty: 2, volume_weight: 1 },
    };

    it('asks for seconds in the compact row', () => {
      renderSlotRow({ slot: heldSlot });
      expect(screen.getByLabelText('Seconds')).toHaveValue(30);
      expect(screen.queryByLabelText('Reps')).toBeNull();
    });

    it('writes the seconds on blur', () => {
      const { props } = renderSlotRow({ slot: heldSlot });
      const seconds = screen.getByLabelText('Seconds');
      fireEvent.change(seconds, { target: { value: '45' } });
      fireEvent.blur(seconds);
      expect(props.onUpdate).toHaveBeenCalledWith({ duration_seconds: 45 });
    });

    it('asks for each set’s seconds in the per-set table', () => {
      const onUpdateSet = vi.fn();
      renderSlotRow({
        slot: {
          ...heldSlot,
          sets: 2,
          set_logs: [
            { id: 'l1', set_number: 1, target_duration_seconds: 30 },
            { id: 'l2', set_number: 2, target_duration_seconds: 20 },
          ],
        },
        onUpdateSet,
      });
      expect(within(perSetTable()).getByRole('columnheader', { name: 'Seconds' })).toBeInTheDocument();
      expect(screen.queryByLabelText('Set 1, reps')).toBeNull();
      const seconds = screen.getByLabelText('Set 2, seconds');
      expect(seconds).toHaveValue(20);
      fireEvent.change(seconds, { target: { value: '25' } });
      fireEvent.blur(seconds);
      expect(onUpdateSet).toHaveBeenCalledWith('l2', { duration_seconds: 25 });
    });
  });

  // Which sets the athlete is asked to film: one round 44px toggle per set,
  // then "All" or "None".
  describe('the sets to film', () => {
    it('toggles one set, and says which are on', async () => {
      const user = userEvent.setup();
      const { props } = renderSlotRow({ slot: { ...defaultSlot, record_video_set_numbers: [1] } });
      const one = screen.getByRole('button', { name: 'Film set 1' });
      const two = screen.getByRole('button', { name: 'Film set 2' });
      expect(one).toHaveAttribute('aria-pressed', 'true');
      expect(two).toHaveAttribute('aria-pressed', 'false');
      expect(two).toHaveClass('h-11', 'w-11');

      await user.click(two);
      expect(props.onUpdate).toHaveBeenCalledWith({ record_video_set_numbers: [1, 2] });
      await user.click(one);
      expect(props.onUpdate).toHaveBeenLastCalledWith({ record_video_set_numbers: [] });
    });

    // Named after the exercise: an editor holds one pair per exercise.
    it('films every set with "All", and none with "None"', async () => {
      const user = userEvent.setup();
      const { props } = renderSlotRow();
      expect(screen.getByRole('button', { name: 'Film every set of Pull Up' })).toHaveTextContent('All');
      await user.click(screen.getByRole('button', { name: 'Film every set of Pull Up' }));
      expect(props.onUpdate).toHaveBeenCalledWith({ record_video_set_numbers: [1, 2, 3] });
    });

    it('offers "None" once every set is filmed', async () => {
      const user = userEvent.setup();
      const { props } = renderSlotRow({ slot: { ...defaultSlot, record_video_set_numbers: [1, 2, 3] } });
      expect(screen.queryByRole('button', { name: 'Film every set of Pull Up' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Film no set of Pull Up' })).toHaveTextContent('None');
      await user.click(screen.getByRole('button', { name: 'Film no set of Pull Up' }));
      expect(props.onUpdate).toHaveBeenCalledWith({ record_video_set_numbers: [] });
    });
  });

  // Review finding L9 (P31, live N3): the weights were `type="number"` fields.
  // "62,5" was 625 in a Chromium whose UI is English and "" in WebKit — written
  // as null, which the athlete saw as "BW". They are text fields read by
  // parseDecimalInput now, and text they cannot read writes nothing.
  describe('a target weight typed with a comma or a point', () => {
    const perSetSlot = {
      ...defaultSlot,
      set_logs: [
        { id: 'l1', set_number: 1, target_reps: 10, target_weight_kg: 50 },
        { id: 'l2', set_number: 2, target_reps: 10, target_weight_kg: 50 },
        { id: 'l3', set_number: 3, target_reps: 10, target_weight_kg: 60 },
      ],
    };

    async function typeAndLeave(user, field, text) {
      await user.clear(field);
      if (text) await user.type(field, text);
      fireEvent.blur(field);
    }

    it('are text fields with the decimal keypad', () => {
      renderSlotRow();
      const weight = screen.getByLabelText('Load in kg');
      expect(weight).toHaveAttribute('type', 'text');
      expect(weight).toHaveAttribute('inputmode', 'decimal');
    });

    it.each(['62,5', '62.5'])('the compact row writes "%s" as 62.5 kg', async (text) => {
      const user = userEvent.setup();
      const { props } = renderSlotRow();
      await typeAndLeave(user, screen.getByLabelText('Load in kg'), text);
      expect(props.onUpdate).toHaveBeenCalledTimes(1);
      expect(props.onUpdate).toHaveBeenCalledWith({ weight_kg: 62.5 });
    });

    it.each(['abc', '62,5kg', '-5', '1,000.5', '10000'])(
      'the compact row writes nothing for "%s" and shows the stored weight again',
      async (text) => {
        const user = userEvent.setup();
        const { props } = renderSlotRow();
        const weight = screen.getByLabelText('Load in kg');
        await user.clear(weight);
        await user.type(weight, text);
        // Marked while it is wrong…
        expect(weight).toHaveAttribute('aria-invalid', 'true');
        fireEvent.blur(weight);
        // …and never read as an empty field, which is null.
        expect(props.onUpdate).not.toHaveBeenCalled();
        expect(weight).toHaveValue('50');
        expect(weight).not.toHaveAttribute('aria-invalid');
      },
    );

    it('an empty field is still no load: null, on purpose', async () => {
      const user = userEvent.setup();
      const { props } = renderSlotRow();
      await typeAndLeave(user, screen.getByLabelText('Load in kg'), '');
      expect(props.onUpdate).toHaveBeenCalledWith({ weight_kg: null });
    });

    it('a weight it cannot read stays out of the write; the other fields of the blur go', () => {
      const { props } = renderSlotRow();
      fireEvent.change(screen.getByLabelText('Reps'), { target: { value: '8' } });
      const weight = screen.getByLabelText('Load in kg');
      fireEvent.change(weight, { target: { value: 'abc' } });
      fireEvent.blur(weight);
      expect(props.onUpdate).toHaveBeenCalledTimes(1);
      expect(props.onUpdate).toHaveBeenCalledWith({ reps: 8 });
      expect(weight).toHaveValue('50');
    });

    it('a weight stored as "62.50" opens as "62.5" and a blur without a change writes nothing', () => {
      const { props } = renderSlotRow({ slot: { ...defaultSlot, weight_kg: '62.50' } });
      const weight = screen.getByLabelText('Load in kg');
      expect(weight).toHaveValue('62.5');
      fireEvent.blur(weight);
      expect(props.onUpdate).not.toHaveBeenCalled();
    });

    it('the compact row of a slot with sets starts from the first set\'s weight', () => {
      renderSlotRow({
        slot: {
          ...defaultSlot,
          set_logs: [1, 2, 3].map((n) => ({
            id: `l${n}`, set_number: n, target_reps: 10, target_weight_kg: '42.50',
          })),
        },
      });
      expect(screen.getByLabelText('Load in kg')).toHaveValue('42.5');
    });

    it.each(['62,5', '62.5'])('a per-set row writes "%s" as 62.5 kg on its own set', async (text) => {
      const user = userEvent.setup();
      const onUpdateSet = vi.fn();
      renderSlotRow({ slot: perSetSlot, onUpdateSet });
      const weight = screen.getByLabelText('Set 3, load in kg');
      expect(weight).toHaveAttribute('type', 'text');
      expect(weight).toHaveAttribute('inputmode', 'decimal');
      await typeAndLeave(user, weight, text);
      expect(onUpdateSet).toHaveBeenCalledTimes(1);
      expect(onUpdateSet).toHaveBeenCalledWith('l3', { weight_kg: 62.5 });
    });

    it.each(['abc', '10000'])(
      'a per-set row writes nothing for "%s" and shows the stored weight again',
      async (text) => {
        const user = userEvent.setup();
        const onUpdateSet = vi.fn();
        renderSlotRow({ slot: perSetSlot, onUpdateSet });
        const weight = screen.getByLabelText('Set 3, load in kg');
        await typeAndLeave(user, weight, text);
        expect(onUpdateSet).not.toHaveBeenCalled();
        expect(weight).toHaveValue('60');
      },
    );

    it('a per-set row emptied writes null for that set', async () => {
      const user = userEvent.setup();
      const onUpdateSet = vi.fn();
      renderSlotRow({ slot: perSetSlot, onUpdateSet });
      await typeAndLeave(user, screen.getByLabelText('Set 3, load in kg'), '');
      expect(onUpdateSet).toHaveBeenCalledWith('l3', { weight_kg: null });
    });

    it('a per-set weight stored as "62.50" opens as "62.5" and is not written back', () => {
      const onUpdateSet = vi.fn();
      renderSlotRow({
        slot: {
          ...perSetSlot,
          set_logs: perSetSlot.set_logs.map((l) =>
            l.id === 'l3' ? { ...l, target_weight_kg: '62.50' } : l,
          ),
        },
        onUpdateSet,
      });
      const weight = screen.getByLabelText('Set 3, load in kg');
      expect(weight).toHaveValue('62.5');
      fireEvent.blur(weight);
      expect(onUpdateSet).not.toHaveBeenCalled();
    });

    it('a logged set\'s weight stays locked', () => {
      renderSlotRow({
        slot: {
          ...perSetSlot,
          set_logs: perSetSlot.set_logs.map((l) => (l.id === 'l1' ? { ...l, done: true } : l)),
        },
      });
      expect(screen.getByLabelText('Set 1, load in kg')).toBeDisabled();
      expect(screen.getByLabelText('Set 3, load in kg')).toBeEnabled();
    });
  });

  // Review finding P3: the editor used to let the coach rewrite or delete sets
  // the athlete had already trained. A logged set is now read-only wherever it
  // shows up, and the rest of the exercise stays editable.
  describe('a slot the athlete has started', () => {
    const startedSlot = {
      ...defaultSlot,
      sets: 4,
      set_logs: [
        { id: 'l1', set_number: 1, target_reps: 10, target_weight_kg: 50, done: true, rpe: 8 },
        { id: 'l2', set_number: 2, target_reps: 10, target_weight_kg: 50, failed: true },
        { id: 'l3', set_number: 3, target_reps: 10, target_weight_kg: 50 },
        { id: 'l4', set_number: 4, target_reps: 10, target_weight_kg: 50 },
      ],
    };

    // The compact row edits "all sets" at once. With a logged set in the slot
    // that is no longer one thing, so the per-set table takes over.
    it('shows the per-set table, without the compact fields or a way back to them', () => {
      renderSlotRow({ slot: startedSlot });
      expect(perSetTable()).toBeInTheDocument();
      expect(screen.queryByLabelText('Sets')).toBeNull();
      expect(screen.queryByRole('button', { name: 'All sets alike' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Make every set like the first' })).toBeNull();
    });

    it('locks the logged sets and marks them', () => {
      renderSlotRow({ slot: startedSlot });
      for (const n of [1, 2]) {
        expect(screen.getByLabelText(`Set ${n}, reps`)).toBeDisabled();
        expect(screen.getByLabelText(`Set ${n}, load in kg`)).toBeDisabled();
        expect(screen.getByLabelText(`Set ${n}, rest in s`)).toBeDisabled();
        expect(screen.getByRole('img', { name: `Set ${n} is logged` })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: `Remove set ${n}` })).toBeNull();
      }
    });

    it('leaves the pending sets editable and removable', async () => {
      const user = userEvent.setup();
      const onUpdateSet = vi.fn();
      const onRemoveSet = vi.fn();
      renderSlotRow({ slot: startedSlot, onUpdateSet, onRemoveSet });

      const reps = screen.getByLabelText('Set 3, reps');
      expect(reps).toBeEnabled();
      await user.clear(reps);
      await user.type(reps, '8');
      fireEvent.blur(reps);
      expect(onUpdateSet).toHaveBeenCalledWith('l3', { reps: 8 });

      await user.click(screen.getByRole('button', { name: 'Remove set 4' }));
      expect(onRemoveSet).toHaveBeenCalledWith(4);
      expect(screen.queryByRole('img', { name: 'Set 3 is logged' })).toBeNull();
    });

    it('still offers to add a set', async () => {
      const user = userEvent.setup();
      const onAddSet = vi.fn();
      renderSlotRow({ slot: startedSlot, onAddSet });
      await user.click(screen.getByRole('button', { name: 'Add a set' }));
      expect(onAddSet).toHaveBeenCalledTimes(1);
    });

    it('cannot be removed, and says why', async () => {
      const user = userEvent.setup();
      const { props } = renderSlotRow({ slot: startedSlot });
      const remove = screen.getByRole('button', { name: 'Remove Pull Up' });
      expect(remove).toBeDisabled();
      expect(remove).toHaveAttribute('title', expect.stringMatching(/logged sets/i));
      await user.click(remove);
      expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
      expect(props.onDelete).not.toHaveBeenCalled();
    });

    it.each([
      ['skipped', { skipped: true }],
      ['rated without being ticked', { rpe: 7 }],
      ['logged with off-plan reps', { actual_reps: 6 }],
      ['logged with an off-plan weight', { actual_weight_kg: 42.5 }],
    ])('treats a set that is %s as logged', (_label, patch) => {
      renderSlotRow({
        slot: {
          ...defaultSlot,
          sets: 2,
          set_logs: [
            { id: 'l1', set_number: 1, target_reps: 10, target_weight_kg: 50, ...patch },
            { id: 'l2', set_number: 2, target_reps: 10, target_weight_kg: 50 },
          ],
        },
      });
      expect(screen.getByLabelText('Set 1, reps')).toBeDisabled();
      expect(screen.getByLabelText('Set 2, reps')).toBeEnabled();
    });

    // Extras are kept out of the table (they are the athlete's, not the
    // prescription), but removing the exercise would cascade to them.
    it('counts a logged student-added set against removing the exercise', () => {
      renderSlotRow({
        slot: {
          ...defaultSlot,
          sets: 1,
          set_logs: [
            { id: 'l1', set_number: 1, target_reps: 10, target_weight_kg: 50 },
            { id: 'lx', set_number: 2, is_student_added: true, done: true },
          ],
        },
      });
      expect(screen.getByRole('button', { name: 'Remove Pull Up' })).toBeDisabled();
      // The prescription itself is untouched, so the compact row stays.
      expect(screen.getByLabelText('Sets')).toBeEnabled();
    });
  });

  // A session the athlete has confirmed is opened read-only as a whole.
  describe('read-only', () => {
    const slot = {
      ...defaultSlot,
      notes: 'Keep elbows tucked',
      record_video_set_numbers: [1],
      set_logs: [
        { id: 'l1', set_number: 1, target_reps: 10, target_weight_kg: 50 },
        { id: 'l2', set_number: 2, target_reps: 10, target_weight_kg: 50 },
        { id: 'l3', set_number: 3, target_reps: 10, target_weight_kg: 50 },
      ],
    };

    it('disables every field of the compact row and drops what would change the slot', () => {
      renderSlotRow({ slot, readOnly: true });
      for (const label of ['Sets', 'Reps', 'Load in kg', 'Rest in s']) {
        expect(screen.getByLabelText(label)).toBeDisabled();
      }
      expect(screen.queryByRole('button', { name: 'Remove Pull Up' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Move Pull Up' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Set by set' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Add a note' })).toBeNull();
      // The "film these sets" toggles stay visible as information.
      expect(screen.getByRole('button', { name: 'Film set 1' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Film set 1' })).toHaveAttribute('aria-pressed', 'true');
      expect(screen.queryByRole('button', { name: /Film every set|Film no set/ })).toBeNull();
    });

    it('keeps the coach note readable, not editable', () => {
      renderSlotRow({ slot, readOnly: true });
      const note = screen.getByLabelText('Note for the athlete');
      expect(note).toHaveValue('Keep elbows tucked');
      expect(note).toHaveAttribute('readonly');
    });

    it('locks pending sets too, with nothing to add or remove', () => {
      renderSlotRow({
        slot: {
          ...slot,
          set_logs: [
            { id: 'l1', set_number: 1, target_reps: 10, target_weight_kg: 80, done: true },
            { id: 'l2', set_number: 2, target_reps: 6, target_weight_kg: 100 },
          ],
        },
        readOnly: true,
      });
      expect(screen.getByLabelText('Set 1, reps')).toBeDisabled();
      expect(screen.getByLabelText('Set 2, reps')).toBeDisabled();
      expect(screen.queryByRole('button', { name: /^Remove set/ })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Add a set' })).toBeNull();
      // Only the set that IS logged carries the mark.
      expect(screen.getAllByRole('img', { name: /is logged/i })).toHaveLength(1);
    });
  });
});
