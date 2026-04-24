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
});
