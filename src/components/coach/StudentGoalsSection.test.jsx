import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, Outlet } from 'react-router-dom';

const mockCreateGoal = { mutate: vi.fn(), isPending: false };

let mockGoals = [];

vi.mock('../../hooks/useGoals', () => ({
  useStudentGoals: () => ({ data: mockGoals, isLoading: false }),
  useStudentProfileId: () => ({ data: 'profile-s1', isLoading: false }),
  useCreateGoal: () => mockCreateGoal,
  useDeleteGoal: () => ({ mutate: vi.fn() }),
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

async function fillGoal(user, weight) {
  await user.click(screen.getByRole('button', { name: '+ ADD GOAL' }));
  await user.selectOptions(screen.getByRole('combobox'), 'ex-1');
  const field = screen.getByLabelText('Weight (kg)');
  if (weight) await user.type(field, weight);
  return field;
}

// Review finding L9 (P31): the goal's weight was a `type="number"` field read
// with Number(). "62,5" was 625 in an English Chromium, and "" in WebKit —
// which `required` refused as a field left empty. It is a text field read by
// parseDecimalInput now. Save is clicked as a person would, so the form's
// validation runs.
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
    expect(field).toBeRequired();
  });

  it.each(['62,5', '62.5'])('"%s" saves a goal of 62.5 kg', async (text) => {
    const user = userEvent.setup();
    renderSection();
    await fillGoal(user, text);
    await user.click(screen.getByRole('button', { name: 'Save goal' }));
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
    await user.click(screen.getByRole('button', { name: 'Save goal' }));
    expect(mockCreateGoal.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ target_weight_kg: 0 }),
      expect.any(Object),
    );
  });

  // Not a number, or nothing: the field's pattern and `required` stop the
  // submit, as the browser does.
  it.each(['abc', '62,5kg', '-5', ''])('"%s" saves nothing', async (text) => {
    const user = userEvent.setup();
    renderSection();
    const field = await fillGoal(user, text);
    await user.click(screen.getByRole('button', { name: 'Save goal' }));
    expect(mockCreateGoal.mutate).not.toHaveBeenCalled();
    expect(field).toHaveValue(text);
  });

  it('a weight past what the column holds saves nothing and says the range', async () => {
    const user = userEvent.setup();
    renderSection();
    const field = await fillGoal(user, '10000');
    await user.click(screen.getByRole('button', { name: 'Save goal' }));
    expect(mockCreateGoal.mutate).not.toHaveBeenCalled();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Enter a weight from 0 to 9999.99 kg');
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAttribute('aria-describedby', alert.id);

    // Typing again takes the alert away; a good weight then goes.
    await user.clear(field);
    await user.type(field, '9999,99');
    expect(screen.queryByRole('alert')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Save goal' }));
    expect(mockCreateGoal.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ target_weight_kg: 9999.99 }),
      expect.any(Object),
    );
  });

  it('the sets and reps of a format goal are still read as numbers', async () => {
    const user = userEvent.setup();
    renderSection();
    await user.click(screen.getByRole('button', { name: '+ ADD GOAL' }));
    await user.selectOptions(screen.getByRole('combobox'), 'ex-1');
    await user.click(screen.getByRole('radio', { name: /sets × reps/i }));
    await user.type(screen.getByLabelText('Sets'), '3');
    await user.clear(screen.getByLabelText('Reps'));
    await user.type(screen.getByLabelText('Reps'), '5');
    await user.type(screen.getByLabelText('Weight (kg)'), '82,5');
    await user.click(screen.getByRole('button', { name: 'Save goal' }));
    expect(mockCreateGoal.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'format', target_sets: 3, target_reps: 5, target_weight_kg: 82.5 }),
      expect.any(Object),
    );
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
    await user.click(screen.getByRole('button', { name: '+ ADD GOAL' }));
    const values = [...screen.getByRole('combobox').options].map((o) => o.value);
    expect(values).toEqual(['', 'ex-1']);
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
