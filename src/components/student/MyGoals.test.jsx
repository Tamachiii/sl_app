import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

let mockGoals = { data: [], isLoading: false };
let mockOnline = true;
const mockAddProgress = { mutate: vi.fn(), isPending: false };
const mockDeleteProgress = { mutate: vi.fn(), isPending: false };
const mockToggleAchieved = { mutate: vi.fn(), isPending: false };

vi.mock('../../hooks/useGoals', () => ({
  useMyGoals: () => mockGoals,
  useAddGoalProgress: () => mockAddProgress,
  useDeleteGoalProgress: () => mockDeleteProgress,
  useToggleGoalAchieved: () => mockToggleAchieved,
}));

vi.mock('../../hooks/useOnlineStatus', () => ({
  useOnlineStatus: () => mockOnline,
}));

import MyGoals from './MyGoals';

function Where() {
  const location = useLocation();
  return <p data-testid="where">{location.pathname}</p>;
}

// `entries`: the tab's history, the goals page last.
function renderAt(entries) {
  return render(
    <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
      <Routes>
        <Route path="/student/goals" element={<MyGoals />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>
  );
}

const where = () => screen.getByTestId('where').textContent;
const back = () => fireEvent.click(screen.getByRole('button', { name: /back/i }));

beforeEach(() => {
  vi.clearAllMocks();
  mockGoals = { data: [], isLoading: false };
  mockOnline = true;
});

// L31. The goals page is reached from the profile, but a link or a cold start
// of the installed app can open it as the first entry of the tab, where
// `navigate(-1)` has nowhere to go.
describe('MyGoals: the way back', () => {
  it('goes one step back, to the page it was opened from, when there is one', () => {
    renderAt(['/student/profile', '/student/goals']);
    back();
    expect(where()).toBe('/student/profile');
  });

  it("goes to the athlete's home from the first entry of the tab", () => {
    renderAt(['/student/goals']);
    back();
    expect(where()).toBe('/student');
  });
});

describe('MyGoals: the page', () => {
  it('is titled Goals, and says so when the coach has set none', () => {
    renderAt(['/student/goals']);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Goals');
    expect(screen.getByText('Your coach hasn’t set a goal yet.')).toBeInTheDocument();
  });

  it('shows a spinner, and not the empty line, while the goals are read', () => {
    mockGoals = { data: undefined, isLoading: true };
    renderAt(['/student/goals']);
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
    expect(screen.queryByText('Your coach hasn’t set a goal yet.')).not.toBeInTheDocument();
  });
});

// A goal: its exercise, what it asks for, achieved or not, the coach's notes,
// the best attempt and the attempts, and the athlete's own writes — none of
// which is queued offline, so each is gated on the network.
describe('MyGoals: a goal', () => {
  const goal = (over = {}) => ({
    id: 'g-1',
    kind: 'one_rm',
    target_weight_kg: 80,
    target_reps: 1,
    target_sets: null,
    achieved: false,
    notes: null,
    exercise: { id: 'e-1', name: 'Front Lever' },
    goal_progress: [],
    ...over,
  });
  const attempt = (id, weight_kg, recorded_at, over = {}) => ({ id, weight_kg, sets: null, reps: null, notes: null, recorded_at, ...over });

  function renderGoals(...goals) {
    mockGoals = { data: goals, isLoading: false };
    renderAt(['/student/goals']);
  }
  const card = (name = 'Front Lever') => within(screen.getByRole('region', { name }));

  it('says what it asks for: a 1RM, or sets × reps, at a load', () => {
    renderGoals(
      goal(),
      goal({ id: 'g-2', kind: 'format', target_sets: 5, target_reps: 3, target_weight_kg: '82.50', exercise: { id: 'e-2', name: 'Pull Up' } }),
    );
    expect(card().getByRole('heading', { name: 'Front Lever' })).toBeInTheDocument();
    expect(card().getByText('Target: 1RM at 80 kg')).toBeInTheDocument();
    expect(card('Pull Up').getByText('Target: 5 × 3 at 82.5 kg')).toBeInTheDocument();
  });

  it('says it is achieved, in blue, and offers to take it back', () => {
    renderGoals(goal({ achieved: true, notes: 'Hold 5 s, clean' }));
    expect(card().getByText('Achieved')).toHaveClass('text-blue');
    expect(card().getByText('Hold 5 s, clean')).toBeInTheDocument();
    fireEvent.click(card().getByRole('button', { name: 'Not achieved after all' }));
    expect(mockToggleAchieved.mutate).toHaveBeenCalledWith({ id: 'g-1', achieved: false });
  });

  it('is marked achieved by the athlete', () => {
    renderGoals(goal());
    expect(card().queryByText('Achieved')).not.toBeInTheDocument();
    fireEvent.click(card().getByRole('button', { name: 'Mark as achieved' }));
    expect(mockToggleAchieved.mutate).toHaveBeenCalledWith({ id: 'g-1', achieved: true });
  });

  it('shows the best attempt by its load, and the attempts newest first', () => {
    renderGoals(goal({
      goal_progress: [
        attempt('p-1', '70.00', '2026-10-01T12:00:00Z'),
        // The best, though not the newest: "82.50" is read as a number.
        attempt('p-2', '82.50', '2026-10-05T12:00:00Z', { sets: 3, reps: 2 }),
        attempt('p-3', '9.00', '2026-10-09T12:00:00Z', { notes: 'warm-up' }),
      ],
    }));
    expect(card().getByText('Best so far')).toBeInTheDocument();
    expect(card().getByText('82.5 kg', { selector: '.pk-condensed' })).toBeInTheDocument();
    expect(card().getByText('3 attempts')).toBeInTheDocument();
    const rows = card().getAllByRole('button', { name: /^Delete attempt logged on/ }).map((b) => b.getAttribute('aria-label'));
    expect(rows).toEqual([
      'Delete attempt logged on October 9',
      'Delete attempt logged on October 5',
      'Delete attempt logged on October 1',
    ]);
    expect(card().getByText('82.5 kg, 3 × 2')).toBeInTheDocument();
    expect(card().getByText('October 9, warm-up')).toBeInTheDocument();
  });

  it('counts one attempt in the singular', () => {
    renderGoals(goal({ goal_progress: [attempt('p-1', 70, '2026-10-01T12:00:00Z')] }));
    expect(card().getByText('1 attempt')).toBeInTheDocument();
  });

  it('shows eight attempts, and the others on a tap', () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      attempt(`p-${i + 1}`, 60 + i, `2026-09-${String(10 + i).padStart(2, '0')}T12:00:00Z`),
    );
    renderGoals(goal({ goal_progress: many }));
    const deletes = () => card().getAllByRole('button', { name: /^Delete attempt logged on/ });
    expect(deletes()).toHaveLength(8);
    fireEvent.click(card().getByRole('button', { name: 'Show all 10 attempts' }));
    expect(deletes()).toHaveLength(10);
    expect(card().queryByRole('button', { name: 'Show all 10 attempts' })).not.toBeInTheDocument();
  });

  it('deletes an attempt only once the athlete says so in the sheet', () => {
    renderGoals(goal({ goal_progress: [attempt('p-1', 70, '2026-10-01T12:00:00Z')] }));
    fireEvent.click(card().getByRole('button', { name: 'Delete attempt logged on October 1' }));
    const sheet = within(screen.getByRole('dialog', { name: 'Delete attempt?' }));
    expect(mockDeleteProgress.mutate).not.toHaveBeenCalled();
    fireEvent.click(sheet.getByRole('button', { name: 'Delete' }));
    expect(mockDeleteProgress.mutate).toHaveBeenCalledWith('p-1');
  });

  it('Cancel in the sheet deletes nothing', () => {
    renderGoals(goal({ goal_progress: [attempt('p-1', 70, '2026-10-01T12:00:00Z')] }));
    fireEvent.click(card().getByRole('button', { name: 'Delete attempt logged on October 1' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Delete attempt?' })).getByRole('button', { name: 'Cancel' }));
    expect(mockDeleteProgress.mutate).not.toHaveBeenCalled();
  });

  it('offline, offers no write that would wait: mark achieved and delete are off, and say why', () => {
    mockOnline = false;
    renderGoals(goal({ goal_progress: [attempt('p-1', 70, '2026-10-01T12:00:00Z')] }));
    const markAchieved = card().getByRole('button', { name: 'Mark as achieved' });
    expect(markAchieved).toBeDisabled();
    expect(markAchieved).toHaveAttribute('title', 'You’re offline — reconnect to do this.');
    expect(card().getByRole('button', { name: 'Delete attempt logged on October 1' })).toBeDisabled();

    fireEvent.click(card().getByRole('button', { name: 'Log an attempt' }));
    const log = card().getByRole('button', { name: 'Log an attempt' });
    expect(log).toHaveAttribute('type', 'submit');
    expect(log).toBeDisabled();
  });
});

// The attempt is typed in number fields read by parseDecimalInput: "62,5" is
// 62.5 in every browser, and garbage is refused — never saved as null or as a
// guess. These were `type="number"` fields read with Number().
describe('MyGoals: logging an attempt', () => {
  const formatGoal = {
    id: 'g-1',
    kind: 'format',
    target_weight_kg: 80,
    target_sets: 5,
    target_reps: 3,
    achieved: false,
    exercise: { id: 'e-1', name: 'Pull Up' },
    goal_progress: [],
  };

  async function openForm(user, goal = formatGoal) {
    mockGoals = { data: [goal], isLoading: false };
    renderAt(['/student/goals']);
    await user.click(screen.getByRole('button', { name: 'Log an attempt' }));
    return {
      weight: screen.getByRole('textbox', { name: 'Weight in kg' }),
      sets: screen.getByRole('textbox', { name: 'Sets' }),
      reps: screen.getByRole('textbox', { name: 'Reps' }),
      notes: screen.getByRole('textbox', { name: 'Notes, optional' }),
      save: () => user.click(screen.getByRole('button', { name: 'Log an attempt' })),
    };
  }

  it('opens on the sets and reps of the goal, with text fields and their keypads', async () => {
    const user = userEvent.setup();
    const form = await openForm(user);
    expect(form.weight).toHaveValue('');
    expect(form.sets).toHaveValue('5');
    expect(form.reps).toHaveValue('3');
    expect(form.weight).toHaveAttribute('type', 'text');
    expect(form.weight).toHaveAttribute('inputmode', 'decimal');
    expect(form.sets).toHaveAttribute('inputmode', 'numeric');
    expect(form.reps).toHaveAttribute('inputmode', 'numeric');
  });

  it('a 1RM goal opens on its one rep and no sets', async () => {
    const user = userEvent.setup();
    const form = await openForm(user, { ...formatGoal, kind: 'one_rm', target_sets: null, target_reps: 1 });
    expect(form.sets).toHaveValue('');
    expect(form.reps).toHaveValue('1');
  });

  it.each(['62,5', '62.5'])('"%s" kg is logged as 62.5', async (text) => {
    const user = userEvent.setup();
    const form = await openForm(user);
    await user.type(form.weight, text);
    await user.type(form.notes, 'Felt easy');
    await form.save();
    expect(mockAddProgress.mutate).toHaveBeenCalledTimes(1);
    expect(mockAddProgress.mutate).toHaveBeenCalledWith(
      { goalId: 'g-1', weight_kg: 62.5, sets: 5, reps: 3, notes: 'Felt easy' },
      expect.any(Object),
    );
  });

  // 0 is no count: written as none, as the old form wrote it.
  it('sets and reps of 0 are logged as none', async () => {
    const user = userEvent.setup();
    const form = await openForm(user);
    await user.type(form.weight, '70');
    await user.clear(form.sets);
    await user.type(form.sets, '0');
    await user.clear(form.reps);
    await user.type(form.reps, '0');
    await form.save();
    expect(mockAddProgress.mutate).toHaveBeenCalledWith(
      { goalId: 'g-1', weight_kg: 70, sets: null, reps: null, notes: null },
      expect.any(Object),
    );
  });

  it('sets and reps left empty are logged as none', async () => {
    const user = userEvent.setup();
    const form = await openForm(user);
    await user.type(form.weight, '70');
    await user.clear(form.sets);
    await user.clear(form.reps);
    await form.save();
    expect(mockAddProgress.mutate).toHaveBeenCalledWith(
      { goalId: 'g-1', weight_kg: 70, sets: null, reps: null, notes: null },
      expect.any(Object),
    );
  });

  it.each(['', 'abc', '62,5kg', '-5'])('a weight of "%s" logs nothing and says why', async (text) => {
    const user = userEvent.setup();
    const form = await openForm(user);
    if (text) await user.type(form.weight, text);
    await form.save();
    expect(mockAddProgress.mutate).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a weight from 0 to 9999.99 kg');
    expect(form.weight).toHaveAttribute('aria-invalid', 'true');
    expect(form.weight).toHaveAttribute('aria-describedby', screen.getByRole('alert').id);
    expect(form.weight).toHaveValue(text);
  });

  // `goal_progress.weight_kg` is a numeric(6,2).
  it('a weight past what the column holds logs nothing', async () => {
    const user = userEvent.setup();
    const form = await openForm(user);
    await user.type(form.weight, '10000');
    await form.save();
    expect(mockAddProgress.mutate).not.toHaveBeenCalled();
    expect(form.weight).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it.each([
    ['sets', '2,5'],
    ['reps', 'x'],
  ])('%s of "%s" log nothing and say why', async (name, text) => {
    const user = userEvent.setup();
    const form = await openForm(user);
    await user.type(form.weight, '70');
    await user.clear(form[name]);
    await user.type(form[name], text);
    await form.save();
    expect(mockAddProgress.mutate).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Enter a whole number');
    expect(form[name]).toHaveAccessibleDescription('Enter a whole number');
  });

  it('typing again takes the refusal away, and a good attempt then goes', async () => {
    const user = userEvent.setup();
    const form = await openForm(user);
    await user.type(form.weight, 'abc');
    await form.save();
    expect(screen.getByRole('alert')).toBeInTheDocument();

    await user.clear(form.weight);
    await user.type(form.weight, '75');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await form.save();
    expect(mockAddProgress.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ weight_kg: 75 }),
      expect.any(Object),
    );
  });

  it('closes, and empties the weight and the notes, once the attempt is saved', async () => {
    const user = userEvent.setup();
    const form = await openForm(user);
    await user.type(form.weight, '75');
    await user.type(form.notes, 'ok');
    await form.save();
    const [, { onSuccess }] = mockAddProgress.mutate.mock.calls[0];
    // Still open while the write is on its way.
    expect(screen.getByRole('textbox', { name: 'Weight in kg' })).toBeInTheDocument();
    await act(async () => onSuccess());
    expect(screen.queryByRole('textbox', { name: 'Weight in kg' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Log an attempt' }));
    expect(screen.getByRole('textbox', { name: 'Weight in kg' })).toHaveValue('');
    expect(screen.getByRole('textbox', { name: 'Notes, optional' })).toHaveValue('');
  });

  it('Cancel closes the form and logs nothing', async () => {
    const user = userEvent.setup();
    const form = await openForm(user);
    await user.type(form.weight, '75');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('textbox', { name: 'Weight in kg' })).not.toBeInTheDocument();
    expect(mockAddProgress.mutate).not.toHaveBeenCalled();
  });
});
