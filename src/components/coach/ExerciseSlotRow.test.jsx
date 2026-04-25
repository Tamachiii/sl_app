import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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

describe('ExerciseSlotRow', () => {
  it('renders exercise name', () => {
    renderSlotRow();
    expect(screen.getByText('Pull Up')).toBeInTheDocument();
  });

  it('renders a drag handle for reordering', () => {
    renderSlotRow();
    expect(
      screen.getByRole('button', { name: /reorder pull up/i })
    ).toBeInTheDocument();
  });

  it('clicking delete opens a confirm dialog and confirming calls onDelete', async () => {
    const user = userEvent.setup();
    const { props } = renderSlotRow();

    await user.click(screen.getByRole('button', { name: /remove exercise/i }));
    // Dialog opens with the exercise name in the message
    expect(screen.getByRole('dialog', { hidden: true })).toHaveTextContent(/Pull Up/);

    await user.click(screen.getByRole('button', { name: 'Remove' }));
    expect(props.onDelete).toHaveBeenCalled();
  });

  it('cancelling the confirm dialog does not call onDelete', async () => {
    const user = userEvent.setup();
    const { props } = renderSlotRow();

    await user.click(screen.getByRole('button', { name: /remove exercise/i }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(props.onDelete).not.toHaveBeenCalled();
  });

  it('renders sets, reps, and weight inputs', () => {
    renderSlotRow();
    expect(screen.getByLabelText('Sets')).toHaveValue(3);
    expect(screen.getByLabelText('Reps')).toHaveValue(10);
    expect(screen.getByLabelText('Weight')).toHaveValue(50);
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

  it('shows "+ Add coach note" button when slot has no notes', () => {
    renderSlotRow();
    expect(screen.getByRole('button', { name: /add coach note/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/coach note for student/i)).not.toBeInTheDocument();
  });

  it('reveals notes textarea when "+ Add coach note" is clicked', async () => {
    const user = userEvent.setup();
    renderSlotRow();
    await user.click(screen.getByRole('button', { name: /add coach note/i }));
    expect(screen.getByLabelText(/coach note for student/i)).toBeInTheDocument();
  });

  it('shows notes textarea pre-expanded when slot already has a note', () => {
    renderSlotRow({ slot: { ...defaultSlot, notes: 'Keep elbows tucked' } });
    expect(screen.getByLabelText(/coach note for student/i)).toHaveValue('Keep elbows tucked');
    expect(screen.queryByRole('button', { name: /add coach note/i })).not.toBeInTheDocument();
  });

  it('calls onUpdate with notes on blur when notes change', async () => {
    const user = userEvent.setup();
    const { props } = renderSlotRow();
    await user.click(screen.getByRole('button', { name: /add coach note/i }));
    const textarea = screen.getByLabelText(/coach note for student/i);
    await user.type(textarea, 'Focus on the negative');
    fireEvent.blur(textarea);
    expect(props.onUpdate).toHaveBeenCalledWith({ notes: 'Focus on the negative' });
  });

  it('clicking "+ Customize sets" reveals a per-set table', async () => {
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
    expect(screen.queryByLabelText(/per-set targets/i)).toBeNull();
    await user.click(screen.getByRole('button', { name: /customize sets/i }));
    expect(screen.getByRole('table', { name: /per-set targets/i })).toBeInTheDocument();
    expect(screen.getByLabelText('Set 1 reps')).toHaveValue(10);
    expect(screen.getByLabelText('Set 3 weight')).toHaveValue(50);
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
    await user.click(screen.getByRole('button', { name: /customize sets/i }));
    const repsInput = screen.getByLabelText('Set 3 reps');
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
    expect(screen.getByRole('table', { name: /per-set targets/i })).toBeInTheDocument();
  });

  it('clicking "reset to uniform" calls onResetToUniform', async () => {
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
    await user.click(screen.getByRole('button', { name: /reset to uniform/i }));
    expect(onResetToUniform).toHaveBeenCalled();
  });
});
