import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, Outlet } from 'react-router-dom';

const mockCreateGoal = { mutate: vi.fn(), isPending: false };
const mockDeleteGoal = { mutate: vi.fn(), isPending: false };

let mockGoals = [];

vi.mock('../../hooks/useGoals', () => ({
  useStudentGoals: () => ({ data: mockGoals, isLoading: false }),
  useStudentProfileId: () => ({ data: 'profile-s1', isLoading: false }),
  useCreateGoal: () => mockCreateGoal,
  useDeleteGoal: () => mockDeleteGoal,
  formatGoalTarget: () => '',
}));

let mockLibrary = [{ id: 'ex-1', name: 'Pull Up', type: 'pull' }];

// The real module underneath, for `isActiveExercise`: the picker leaves out
// what the library page counts as archived.
vi.mock('../../hooks/useExerciseLibrary', async () => ({
  ...(await vi.importActual('../../hooks/useExerciseLibrary')),
  useExerciseLibrary: () => ({ data: mockLibrary, isLoading: false }),
}));

import StudentGoalsSection from './StudentGoalsSection';

// The section reads its athlete from the athlete page's <Outlet context>.
function renderSection() {
  return render(
    <MemoryRouter>
      <Routes>
        <Route element={<Outlet context={{ student: { id: 's1' } }} />}>
          <Route index element={<StudentGoalsSection />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

const addGoalButton = () => screen.getByRole('button', { name: 'Add a goal' });
const exerciseSelect = () => screen.getByRole('combobox', { name: 'Exercise' });
const saveButton = () => screen.getByRole('button', { name: 'Save the goal' });

async function fillGoal(user, weight) {
  await user.click(addGoalButton());
  await user.selectOptions(exerciseSelect(), 'ex-1');
  const field = screen.getByLabelText('Weight in kg');
  if (weight) await user.type(field, weight);
  return field;
}

// Review finding L9 (P31): the goal's weight was a `type="number"` field read
// with Number(). "62,5" was 625 in an English Chromium, and "" in WebKit —
// which `required` refused as a field left empty. It is a text field read by
// parseDecimalInput now, and the form is checked by that reader rather than
// by the browser (`noValidate`): a refusal is said under the field. Save is
// clicked as a person would.
describe('StudentGoalsSection — the goal weight', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGoals = [];
    mockLibrary = [{ id: 'ex-1', name: 'Pull Up', type: 'pull' }];
  });

  it('is a text field with the decimal keypad', async () => {
    const user = userEvent.setup();
    renderSection();
    const field = await fillGoal(user, '');
    expect(field).toHaveAttribute('type', 'text');
    expect(field).toHaveAttribute('inputmode', 'decimal');
    expect(field).toHaveClass('pk-field');
  });

  it.each(['62,5', '62.5'])('"%s" saves a goal of 62.5 kg', async (text) => {
    const user = userEvent.setup();
    renderSection();
    await fillGoal(user, text);
    await user.click(saveButton());
    expect(mockCreateGoal.mutate).toHaveBeenCalledTimes(1);
    expect(mockCreateGoal.mutate).toHaveBeenCalledWith(
      {
        student_id: 'profile-s1',
        exercise_id: 'ex-1',
        kind: 'one_rm',
        target_weight_kg: 62.5,
        target_reps: 1,
        target_sets: null,
        notes: null,
      },
      expect.any(Object),
    );
  });

  it('0 is a goal: a bodyweight movement', async () => {
    const user = userEvent.setup();
    renderSection();
    await fillGoal(user, '0');
    await user.click(saveButton());
    expect(mockCreateGoal.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ target_weight_kg: 0 }),
      expect.any(Object),
    );
  });

  // Not a number, or nothing: the reader refuses it, and the field says what
  // it takes.
  it.each(['abc', '62,5kg', '-5', ''])('"%s" saves nothing', async (text) => {
    const user = userEvent.setup();
    renderSection();
    const field = await fillGoal(user, text);
    await user.click(saveButton());
    expect(mockCreateGoal.mutate).not.toHaveBeenCalled();
    expect(field).toHaveValue(text);
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAccessibleDescription('Enter a weight from 0 to 9999.99 kg');
  });

  it('a weight past what the column holds saves nothing and says the range', async () => {
    const user = userEvent.setup();
    renderSection();
    const field = await fillGoal(user, '10000');
    await user.click(saveButton());
    expect(mockCreateGoal.mutate).not.toHaveBeenCalled();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Enter a weight from 0 to 9999.99 kg');
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAttribute('aria-describedby', alert.id);

    // Typing again takes the alert away; a good weight then goes.
    await user.clear(field);
    await user.type(field, '9999,99');
    expect(screen.queryByRole('alert')).toBeNull();
    await user.click(saveButton());
    expect(mockCreateGoal.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ target_weight_kg: 9999.99 }),
      expect.any(Object),
    );
  });

  it('the sets and reps of a format goal are still read as numbers', async () => {
    const user = userEvent.setup();
    renderSection();
    await user.click(addGoalButton());
    await user.selectOptions(exerciseSelect(), 'ex-1');
    const kind = within(screen.getByRole('group', { name: 'Kind of goal' }));
    expect(kind.getByRole('button', { name: '1RM' })).toHaveAttribute('aria-pressed', 'true');
    await user.click(kind.getByRole('button', { name: 'Sets × reps' }));
    expect(kind.getByRole('button', { name: 'Sets × reps' })).toHaveAttribute('aria-pressed', 'true');
    await user.type(screen.getByLabelText('Sets'), '3');
    await user.clear(screen.getByLabelText('Reps'));
    await user.type(screen.getByLabelText('Reps'), '5');
    await user.type(screen.getByLabelText('Weight in kg'), '82,5');
    await user.click(saveButton());
    expect(mockCreateGoal.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'format', target_sets: 3, target_reps: 5, target_weight_kg: 82.5 }),
      expect.any(Object),
    );
  });

  it('sets and reps are whole numbers, one at least: anything else saves nothing and says so', async () => {
    const user = userEvent.setup();
    renderSection();
    await user.click(addGoalButton());
    await user.selectOptions(exerciseSelect(), 'ex-1');
    await user.click(screen.getByRole('button', { name: 'Sets × reps' }));
    const sets = screen.getByLabelText('Sets');
    const reps = screen.getByLabelText('Reps');
    expect(sets).toHaveAttribute('inputmode', 'numeric');
    expect(reps).toHaveAttribute('inputmode', 'numeric');
    await user.type(screen.getByLabelText('Weight in kg'), '80');

    // Reps of 0.
    await user.clear(reps);
    await user.type(reps, '0');
    await user.type(sets, '3');
    await user.click(saveButton());
    expect(mockCreateGoal.mutate).not.toHaveBeenCalled();
    expect(reps).toHaveAccessibleDescription('Enter a whole number');

    // Sets of 2.5.
    await user.clear(reps);
    await user.type(reps, '5');
    await user.clear(sets);
    await user.type(sets, '2,5');
    await user.click(saveButton());
    expect(mockCreateGoal.mutate).not.toHaveBeenCalled();
    expect(sets).toHaveAccessibleDescription('Enter a whole number');

    await user.clear(sets);
    await user.type(sets, '3');
    await user.click(saveButton());
    expect(mockCreateGoal.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'format', target_sets: 3, target_reps: 5, target_weight_kg: 80 }),
      expect.any(Object),
    );
  });

  it('a 1RM goal is one rep, whatever was typed in the format before', async () => {
    const user = userEvent.setup();
    renderSection();
    await user.click(addGoalButton());
    await user.selectOptions(exerciseSelect(), 'ex-1');
    await user.click(screen.getByRole('button', { name: 'Sets × reps' }));
    await user.clear(screen.getByLabelText('Reps'));
    await user.type(screen.getByLabelText('Reps'), '5');
    await user.click(screen.getByRole('button', { name: '1RM' }));
    expect(screen.queryByLabelText('Sets')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Reps')).toHaveValue('1');
    await user.type(screen.getByLabelText('Weight in kg'), '100');
    await user.click(saveButton());
    expect(mockCreateGoal.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'one_rm', target_reps: 1, target_sets: null, target_weight_kg: 100 }),
      expect.any(Object),
    );
  });

  it('cannot be saved without an exercise', async () => {
    const user = userEvent.setup();
    renderSection();
    await user.click(addGoalButton());
    await user.type(screen.getByLabelText('Weight in kg'), '80');
    expect(saveButton()).toBeDisabled();
    expect(mockCreateGoal.mutate).not.toHaveBeenCalled();
  });
});

// A goal, as the coach sees it: the exercise, the target, achieved or not,
// the athlete's attempts — and a delete that asks first, in a sheet (it was a
// `window.confirm`).
describe('StudentGoalsSection — the goals set', () => {
  const goal = (over = {}) => ({
    id: 'g-1',
    exercise_id: 'ex-1',
    exercise: { id: 'ex-1', name: 'Pull Up', type: 'pull' },
    kind: 'one_rm',
    target_weight_kg: 40,
    target_reps: 1,
    target_sets: null,
    achieved: false,
    notes: null,
    goal_progress: [],
    ...over,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockLibrary = [{ id: 'ex-1', name: 'Pull Up', type: 'pull' }];
    mockGoals = [];
  });

  it('says so when the athlete has none', () => {
    renderSection();
    expect(screen.getByText('No goal yet for this athlete.')).toBeInTheDocument();
  });

  it('shows the target, the notes and the attempts of each goal', () => {
    mockGoals = [
      goal({ notes: 'Strict, no kip', goal_progress: [{ id: 'p-1' }] }),
      goal({
        id: 'g-2',
        exercise_id: 'ex-3',
        exercise: { id: 'ex-3', name: 'Dip', type: 'push' },
        kind: 'format',
        target_weight_kg: 82.5,
        target_sets: 5,
        target_reps: 3,
        achieved: true,
        goal_progress: [{ id: 'p-2' }, { id: 'p-3' }],
      }),
    ];
    renderSection();
    const pullUp = within(screen.getByRole('region', { name: 'Pull Up' }));
    expect(pullUp.getByRole('heading', { name: 'Pull Up' })).toBeInTheDocument();
    expect(pullUp.getByText('Target: 1RM at 40 kg')).toBeInTheDocument();
    expect(pullUp.getByText('Strict, no kip')).toBeInTheDocument();
    expect(pullUp.getByText('1 attempt')).toBeInTheDocument();
    expect(pullUp.queryByText('Achieved')).not.toBeInTheDocument();

    const dip = within(screen.getByRole('region', { name: 'Dip' }));
    expect(dip.getByText(/Target: 5 × 3 at 82\.5 kg/)).toBeInTheDocument();
    expect(dip.getByText('Achieved')).toHaveClass('text-blue');
    expect(dip.getByText('2 attempts')).toBeInTheDocument();
    expect(screen.queryByText('No goal yet for this athlete.')).not.toBeInTheDocument();
  });

  it('deletes a goal only once the coach says so in the sheet', async () => {
    mockGoals = [goal()];
    const user = userEvent.setup();
    renderSection();
    await user.click(screen.getByRole('button', { name: 'Delete the goal on Pull Up' }));
    const sheet = within(screen.getByRole('dialog', { name: 'Delete this goal?' }));
    expect(sheet.getByText('Its attempts go with it.')).toBeInTheDocument();
    expect(mockDeleteGoal.mutate).not.toHaveBeenCalled();

    await user.click(sheet.getByRole('button', { name: 'Delete the goal' }));
    expect(mockDeleteGoal.mutate).toHaveBeenCalledTimes(1);
    expect(mockDeleteGoal.mutate).toHaveBeenCalledWith('g-1');
  });

  it('Cancel in the sheet deletes nothing', async () => {
    mockGoals = [goal()];
    const user = userEvent.setup();
    renderSection();
    await user.click(screen.getByRole('button', { name: 'Delete the goal on Pull Up' }));
    const sheet = within(screen.getByRole('dialog', { name: 'Delete this goal?' }));
    await user.click(sheet.getByRole('button', { name: 'Cancel' }));
    expect(mockDeleteGoal.mutate).not.toHaveBeenCalled();
  });
});

// Review decision P18: an exercise in use is archived instead of deleted, and
// no new goal is set on an archived one.
describe('StudentGoalsSection — an archived exercise', () => {
  const ARCHIVED_AT = '2026-10-15T08:00:00.000Z';

  beforeEach(() => {
    vi.clearAllMocks();
    mockGoals = [];
    mockLibrary = [
      { id: 'ex-1', name: 'Pull Up', type: 'pull', archived_at: null },
      { id: 'ex-2', name: 'Dip', type: 'push', archived_at: ARCHIVED_AT },
    ];
  });

  it('is not offered for a new goal', async () => {
    const user = userEvent.setup();
    renderSection();
    await user.click(addGoalButton());
    const values = [...exerciseSelect().options].map((o) => o.value);
    expect(values).toEqual(['', 'ex-1']);
    // Each offered by its name and type.
    expect(within(exerciseSelect()).getByRole('option', { name: 'Pull Up, Pull' })).toBeInTheDocument();
  });

  it('still names the goal set on it', () => {
    mockGoals = [
      {
        id: 'g-1',
        exercise_id: 'ex-2',
        exercise: { id: 'ex-2', name: 'Dip', type: 'push', archived_at: ARCHIVED_AT },
        kind: 'one_rm',
        target_weight_kg: 40,
        target_reps: 1,
        achieved: false,
        goal_progress: [],
      },
    ];
    renderSection();
    expect(screen.getByText('Dip')).toBeInTheDocument();
  });
});
