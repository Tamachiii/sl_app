import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
    index: 1,
    total: 3,
    onUpdate: vi.fn(),
    onDelete: vi.fn(),
    onMove: vi.fn(),
    ...props,
  };
  return { ...render(<ExerciseSlotRow {...defaultProps} />), props: defaultProps };
}

describe('ExerciseSlotRow', () => {
  it('renders exercise name and type', () => {
    renderSlotRow();
    expect(screen.getByText('Pull Up')).toBeInTheDocument();
    expect(screen.getByText('pull')).toBeInTheDocument();
  });

  it('clicking move up calls onMove(-1)', async () => {
    const user = userEvent.setup();
    const { props } = renderSlotRow();

    await user.click(screen.getByRole('button', { name: /move up/i }));
    expect(props.onMove).toHaveBeenCalledWith(-1);
  });

  it('clicking move down calls onMove(1)', async () => {
    const user = userEvent.setup();
    const { props } = renderSlotRow();

    await user.click(screen.getByRole('button', { name: /move down/i }));
    expect(props.onMove).toHaveBeenCalledWith(1);
  });

  it('move up is disabled when index is 0', () => {
    renderSlotRow({ index: 0 });
    expect(screen.getByRole('button', { name: /move up/i })).toBeDisabled();
  });

  it('move down is disabled when index is last', () => {
    renderSlotRow({ index: 2, total: 3 });
    expect(screen.getByRole('button', { name: /move down/i })).toBeDisabled();
  });

  it('clicking delete calls onDelete after confirm', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { props } = renderSlotRow();

    await user.click(screen.getByRole('button', { name: /remove exercise/i }));
    expect(props.onDelete).toHaveBeenCalled();
    window.confirm.mockRestore();
  });

  it('delete does not call onDelete when confirm is cancelled', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const { props } = renderSlotRow();

    await user.click(screen.getByRole('button', { name: /remove exercise/i }));
    expect(props.onDelete).not.toHaveBeenCalled();
    window.confirm.mockRestore();
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
