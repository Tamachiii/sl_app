import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import ReviewExercise from './ReviewExercise';

// One exercise of the coach's review (design/parc/screens/Revue.dc.html): its
// name over what was planned — or what it replaced —, the athlete's change
// and what the coach can do with it, a row per set with the video of a set
// under its row, and the athlete's note. SessionReview.test.jsx runs it inside
// the page; this file holds what the page does not reach: the coach offline,
// a change already carried into the program, the rows and their videos.

const SQUAT = { id: 'ex-squat', name: 'Back Squat' };
const slot = (overrides = {}) => ({
  id: 'sl-1', sets: 3, reps: 5, weight_kg: 100, rest_seconds: 90, exercise: SQUAT, ...overrides,
});
const log = (set_number, overrides = {}) => ({
  id: `log-${set_number}`,
  exercise_slot_id: 'sl-1',
  set_number,
  target_reps: 5,
  target_duration_seconds: null,
  target_weight_kg: 100,
  target_rest_seconds: 90,
  actual_reps: null,
  actual_weight_kg: null,
  done: true,
  failed: false,
  skipped: false,
  rpe: null,
  is_student_added: false,
  ...overrides,
});
const SWAP = { exercise_slot_id: 'sl-1', kind: 'swap', substitute_exercise_id: 'ex-sub' };
const SKIP = { exercise_slot_id: 'sl-1', kind: 'skip', substitute_exercise_id: null };
const ASKED = '2026-04-26T09:00:00Z';

function renderExercise(props = {}) {
  const handlers = { onDecline: vi.fn(), onAdopt: vi.fn(), onRemove: vi.fn(), onPlay: vi.fn() };
  const view = render(
    <ReviewExercise
      slot={slot()}
      logs={[log(1), log(2), log(3)]}
      online
      adopted={false}
      declining={false}
      athleteName="Sam"
      {...handlers}
      {...props}
    />,
  );
  return { ...view, ...handlers };
}

const rowTexts = (name) =>
  within(screen.getByRole('list', { name })).getAllByRole('listitem').map((li) => li.textContent.replace(/\s+/g, ' ').trim());

describe('<ReviewExercise />', () => {
  it('is a section named by its exercise, over what was planned and the rest', () => {
    renderExercise();
    const section = screen.getByRole('region', { name: 'Back Squat' });
    expect(within(section).getByRole('heading', { level: 2, name: 'Back Squat' })).toBeInTheDocument();
    expect(within(section).getByText('Planned 3 × 5 at 100 kg, rest 1:30')).toBeInTheDocument();
    expect(rowTexts('Sets of Back Squat')).toEqual(['Sets 1 to 3, As planned, 5 reps, 100 kg']);
  });

  // Live finding N12: a set the athlete added has no target, and it was
  // listed with the plan as "SET 3 (BW)".
  it('says what was planned from the prescribed sets only', () => {
    renderExercise({
      logs: [
        log(1, { target_reps: 10, target_weight_kg: 60 }),
        log(2, { target_reps: 8, target_weight_kg: 70 }),
        log(3, {
          target_reps: null, target_weight_kg: null, target_rest_seconds: null,
          is_student_added: true, actual_reps: 12, actual_weight_kg: 60,
        }),
      ],
    });
    // Sets that differ: the plan by groups, and no rest, which each set holds.
    const plan = screen.getByText(/^Planned/);
    expect(plan).toHaveTextContent(/^Planned 10 at 60 kg, 8 at 70 kg$/);
    expect(rowTexts('Sets of Back Squat')).toEqual([
      'Set 1, As planned, 10 reps, 60 kg',
      'Set 2, As planned, 8 reps, 70 kg',
      'Set 3, added, 12 reps, 60 kg',
    ]);
  });

  it('says the rest only when every set has the same', () => {
    renderExercise({ logs: [log(1), log(2), log(3, { target_rest_seconds: 120 })] });
    expect(screen.getByText('Planned 3 × 5 at 100 kg')).toBeInTheDocument();
  });

  it('has no list before a set is logged', () => {
    renderExercise({ logs: [] });
    expect(screen.queryByRole('list')).toBeNull();
    // The plan comes from the exercise's own columns then.
    expect(screen.getByText('Planned 3 × 5 at 100 kg, rest 1:30')).toBeInTheDocument();
  });

  // Review item B8: an exercise of a library the coach cannot read comes as
  // `exercise: null`.
  it('names an exercise the coach cannot read, and says why', () => {
    renderExercise({ slot: slot({ exercise: null }) });
    expect(screen.getByRole('heading', { level: 2, name: 'Exercise unavailable' })).toBeInTheDocument();
    expect(screen.getByText(/a library you can’t read/i)).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Sets of Exercise unavailable' })).toBeInTheDocument();
  });

  describe('a swapped exercise', () => {
    it('is named by what the athlete did, with what it replaced', () => {
      renderExercise({
        deviation: SWAP,
        substituteName: 'Weighted Dip',
        logs: [log(1, { actual_reps: 8, actual_weight_kg: 10 }), log(2, { actual_reps: 6, actual_weight_kg: 10 })],
      });
      expect(screen.getByRole('region', { name: 'Weighted Dip' })).toBeInTheDocument();
      expect(screen.getByText('Replaces Back Squat, the athlete’s choice')).toBeInTheDocument();
      // The plan was the other exercise's.
      expect(screen.queryByText(/^Planned/)).toBeNull();
      expect(rowTexts('Sets of Weighted Dip')).toEqual(['Set 1, 8 reps, 10 kg', 'Set 2, 6 reps, 10 kg']);
    });

    it('offers to adopt it into the program', () => {
      const { onAdopt } = renderExercise({ deviation: SWAP, substituteName: 'Weighted Dip' });
      fireEvent.click(screen.getByRole('button', { name: 'Adopt into the program' }));
      expect(onAdopt).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('button', { name: 'Decline' })).toBeNull();
    });

    it('offers nothing to adopt without a substitute', () => {
      renderExercise({ deviation: { ...SWAP, substitute_exercise_id: null }, substituteName: null });
      expect(screen.queryByRole('button', { name: 'Adopt into the program' })).toBeNull();
    });

    it('says it was adopted once it is', () => {
      renderExercise({ deviation: { ...SWAP, promote_requested_at: ASKED }, substituteName: 'Weighted Dip', adopted: true });
      expect(screen.getByText('Adopted into the program')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Adopt into the program' })).toBeNull();
      expect(screen.queryByText('The athlete asks to keep this change')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Decline' })).toBeNull();
    });

    it('says how to adopt it while offline', () => {
      renderExercise({ deviation: SWAP, substituteName: 'Weighted Dip', online: false });
      expect(screen.getByText('Connect to adopt this change.')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Adopt into the program' })).toBeNull();
    });
  });

  describe('a skipped exercise', () => {
    it('says the athlete skipped it, and offers to remove it from the sessions to come', () => {
      const { onRemove } = renderExercise({ deviation: SKIP, logs: [] });
      expect(screen.getByText('Skipped by the athlete')).toBeInTheDocument();
      expect(screen.queryByText(/^Planned/)).toBeNull();
      expect(screen.queryByRole('button', { name: 'Adopt into the program' })).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Remove from the sessions to come' }));
      expect(onRemove).toHaveBeenCalledTimes(1);
    });

    it('says it was removed once it is', () => {
      renderExercise({ deviation: SKIP, adopted: true });
      expect(screen.getByText('Removed from the sessions to come')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Remove from the sessions to come' })).toBeNull();
    });

    it('says how to remove it while offline', () => {
      renderExercise({ deviation: SKIP, online: false });
      expect(screen.getByText('Connect to change the program.')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Remove from the sessions to come' })).toBeNull();
    });
  });

  describe('the athlete’s request to keep the change', () => {
    it('is said, with Decline', () => {
      const { onDecline } = renderExercise({ deviation: { ...SKIP, promote_requested_at: ASKED } });
      expect(screen.getByText('The athlete asks to keep this change')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
      expect(onDecline).toHaveBeenCalledTimes(1);
    });

    it('holds Decline while it is sent', () => {
      renderExercise({ deviation: { ...SWAP, promote_requested_at: ASKED }, substituteName: 'Weighted Dip', declining: true });
      expect(screen.getByRole('button', { name: 'Decline' })).toBeDisabled();
    });

    it('is still said offline, without Decline', () => {
      renderExercise({ deviation: { ...SWAP, promote_requested_at: ASKED }, substituteName: 'Weighted Dip', online: false });
      expect(screen.getByText('The athlete asks to keep this change')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Decline' })).toBeNull();
    });
  });

  describe('the videos', () => {
    const video = (id, set_number) => ({ id, exercise_slot_id: 'sl-1', set_number, storage_path: `st-1/sl-1/${id}.mp4` });

    it('stand under the row of their set, and play on a tap', () => {
      const v2 = video('v-2', 2);
      const { onPlay } = renderExercise({
        logs: [log(1), log(2, { actual_weight_kg: 105 }), log(3)],
        videos: [v2],
      });
      expect(rowTexts('Sets of Back Squat')).toEqual([
        'Sets 1 and 3, As planned, 5 reps, 100 kg',
        'Set 2, off plan, Off plan, 5 reps, 105 kg',
        'Video of set 2',
      ]);
      fireEvent.click(screen.getByRole('button', { name: 'Video of set 2' }));
      expect(onPlay).toHaveBeenCalledWith(v2);
    });

    it('of the sets of one row stand under it in their order', () => {
      renderExercise({ videos: [video('v-3', 3), video('v-1', 1)] });
      expect(rowTexts('Sets of Back Squat')).toEqual([
        'Sets 1 to 3, As planned, 5 reps, 100 kg',
        'Video of set 1',
        'Video of set 3',
      ]);
    });
  });

  describe('the athlete’s note', () => {
    it('is named after the athlete', () => {
      renderExercise({ comment: { exercise_slot_id: 'sl-1', body: 'Knees caved on the last one' } });
      expect(screen.getByRole('heading', { level: 3, name: 'Sam’s note' })).toBeInTheDocument();
      expect(screen.getByText('Knees caved on the last one')).toBeInTheDocument();
    });

    it('is the athlete’s when the name is not known', () => {
      renderExercise({ athleteName: null, comment: { exercise_slot_id: 'sl-1', body: 'Knees caved' } });
      expect(screen.getByRole('heading', { level: 3, name: 'The athlete’s note' })).toBeInTheDocument();
    });
  });
});
