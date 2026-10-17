import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

let mockRecords = { data: [], isLoading: false };
vi.mock('../../hooks/useStudentRecords', () => ({
  useStudentRecords: () => mockRecords,
}));

import PersonalRecords, { BODYWEIGHT_HEADING_ID } from './PersonalRecords';

function rec(over = {}) {
  return {
    exercise_id: 'e-1',
    name: 'Weighted Pull-up',
    type: 'pull',
    loadMode: 'added',
    bestE1rm: 44,
    bestE1rmWeight: 40,
    bestE1rmReps: 3,
    bestE1rmAt: '2026-10-02T12:00:00Z',
    bestReps: 3,
    bestRepsAt: '2026-10-02T12:00:00Z',
    relStrength: 1.7,
    bwAtBest: 70,
    recent: false,
    ...over,
  };
}

// The row of a record: its name, the caption under it, and the figure at
// its right.
const rowOf = (name) => screen.getByText(name).closest('li');

beforeEach(() => {
  mockRecords = { data: [], isLoading: false };
});

describe('<PersonalRecords />', () => {
  it('shows the added-load headline, best set, and the peak ×BW', () => {
    mockRecords = { data: [rec()], isLoading: false };
    render(<PersonalRecords />);
    const row = rowOf('Weighted Pull-up');
    // The headline stays the added-load e1RM, said as load added.
    expect(within(row).getByText('44')).toBeInTheDocument();
    expect(within(row).getByText('kg added')).toBeInTheDocument();
    expect(row).toHaveTextContent('October 2, 3 × 40 kg, 1.7 × bodyweight');
  });

  it('leaves the ×BW out when relative strength is unknown', () => {
    mockRecords = {
      data: [rec({ relStrength: null, bwAtBest: null })],
      isLoading: false,
    };
    render(<PersonalRecords />);
    const row = rowOf('Weighted Pull-up');
    expect(within(row).getByText('44')).toBeInTheDocument();
    expect(row).toHaveTextContent('October 2, 3 × 40 kg');
    expect(screen.queryByText(/× bodyweight/)).not.toBeInTheDocument();
  });

  it('always renders ×BW to one decimal (2.0 ×, not 2 ×)', () => {
    mockRecords = { data: [rec({ relStrength: 2 })], isLoading: false };
    render(<PersonalRecords />);
    expect(rowOf('Weighted Pull-up')).toHaveTextContent('2.0 × bodyweight');
  });

  it('renders a plain full-load record', () => {
    mockRecords = {
      data: [rec({ name: 'Back Squat', loadMode: 'full', bestE1rm: 110, bestE1rmWeight: 100, relStrength: 1.6 })],
      isLoading: false,
    };
    render(<PersonalRecords />);
    const row = rowOf('Back Squat');
    expect(within(row).getByText('110')).toBeInTheDocument();
    expect(within(row).getByText('kg')).toBeInTheDocument();
    expect(row).toHaveTextContent('3 × 100 kg, 1.6 × bodyweight');
  });

  // An exercise without a load has no e1RM: its record is the most reps in
  // a row, dated by the set that made it.
  it('shows the most reps in a row for an exercise without a load', () => {
    mockRecords = {
      data: [
        rec({
          exercise_id: 'e-2', name: 'Muscle-up', loadMode: null, bestE1rm: null, bestE1rmWeight: 0,
          bestE1rmReps: 0, bestE1rmAt: null, bestReps: 7, bestRepsAt: '2026-09-26T12:00:00Z', relStrength: null,
        }),
        rec({
          exercise_id: 'e-3', name: 'Pistol squat', loadMode: null, bestE1rm: null, bestE1rmWeight: 0,
          bestE1rmReps: 0, bestE1rmAt: null, bestReps: 1, bestRepsAt: '2026-09-27T12:00:00Z', relStrength: null,
        }),
      ],
      isLoading: false,
    };
    render(<PersonalRecords />);
    const many = rowOf('Muscle-up');
    expect(within(many).getByText('7')).toBeInTheDocument();
    expect(within(many).getByText('reps in a row')).toBeInTheDocument();
    expect(many).toHaveTextContent('September 26');
    expect(many).not.toHaveTextContent('×');
    const one = rowOf('Pistol squat');
    expect(within(one).getByText('rep in a row')).toBeInTheDocument();
  });

  it('names the list, and says what the figures are once there are some', () => {
    mockRecords = { data: [rec()], isLoading: false };
    render(<PersonalRecords />);
    const list = screen.getByRole('region', { name: 'Records' });
    expect(within(list).getByRole('heading', { level: 2, name: 'Records' })).toBeInTheDocument();
    expect(within(list).getByText('Estimated one-rep max')).toBeInTheDocument();
  });

  // A fresh record is the one thing this list exists to celebrate: it is
  // said on its own row, in the list as it opens.
  describe('a record that is new', () => {
    it('says "New" with its date on its row', () => {
      mockRecords = {
        data: [rec(), rec({ exercise_id: 'e-2', name: 'Back Squat', recent: true, bestE1rmAt: '2026-10-12T12:00:00Z' })],
        isLoading: false,
      };
      render(<PersonalRecords />);
      expect(within(rowOf('Back Squat')).getByText('New, October 12')).toBeInTheDocument();
      expect(within(rowOf('Weighted Pull-up')).queryByText(/^New/)).not.toBeInTheDocument();
    });

    it('says "New record" when it has no date', () => {
      mockRecords = { data: [rec({ recent: true, bestE1rmAt: null })], isLoading: false };
      render(<PersonalRecords />);
      expect(rowOf('Weighted Pull-up')).toHaveTextContent('New record, 3 × 40 kg');
    });

    it('says nothing new when nothing is recent', () => {
      mockRecords = { data: [rec()], isLoading: false };
      render(<PersonalRecords />);
      expect(screen.queryByText(/^New/)).not.toBeInTheDocument();
    });
  });

  describe('a long list', () => {
    const records = (n) =>
      Array.from({ length: n }, (_, i) => rec({ exercise_id: `e-${i + 1}`, name: `Lift ${i + 1}` }));

    it('shows five records, then offers the others', async () => {
      mockRecords = { data: records(7), isLoading: false };
      render(<PersonalRecords />);
      expect(screen.getByText('Lift 5')).toBeInTheDocument();
      expect(screen.queryByText('Lift 6')).not.toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: 'Show the 2 other records' }));
      expect(screen.getByText('Lift 6')).toBeInTheDocument();
      expect(screen.getByText('Lift 7')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /other record/ })).not.toBeInTheDocument();
    });

    it('says "the other record" when one is left', () => {
      mockRecords = { data: records(6), isLoading: false };
      render(<PersonalRecords />);
      expect(screen.getByRole('button', { name: 'Show the other record' })).toBeInTheDocument();
    });

    it('offers nothing more when five or fewer', () => {
      mockRecords = { data: records(5), isLoading: false };
      render(<PersonalRecords />);
      expect(screen.getByText('Lift 5')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /other record/ })).not.toBeInTheDocument();
    });
  });

  describe('the bodyweight nudge', () => {
    const scrollIntoView = vi.fn();
    let target;

    beforeEach(() => {
      target = document.createElement('h2');
      target.id = BODYWEIGHT_HEADING_ID;
      target.scrollIntoView = scrollIntoView;
      document.body.appendChild(target);
      scrollIntoView.mockClear();
    });
    afterEach(() => {
      target.remove();
    });

    it('nudges the student to log bodyweight when a classified lift is missing it', async () => {
      mockRecords = {
        data: [rec({ relStrength: null, bwAtBest: null })],
        isLoading: false,
      };
      render(<PersonalRecords />);
      const nudge = screen.getByRole('button', { name: /log your bodyweight/i });
      // It leads to the bodyweight card, where the weight is logged.
      await userEvent.click(nudge);
      expect(scrollIntoView).toHaveBeenCalledTimes(1);
    });

    it('does not nudge on the coach surface (studentRowId present)', () => {
      mockRecords = {
        data: [rec({ relStrength: null, bwAtBest: null })],
        isLoading: false,
      };
      render(<PersonalRecords studentRowId="st-1" />);
      expect(screen.queryByText(/log your bodyweight/i)).not.toBeInTheDocument();
    });

    it('does not nudge once the bodyweight is known', () => {
      mockRecords = { data: [rec()], isLoading: false };
      render(<PersonalRecords />);
      expect(screen.queryByText(/log your bodyweight/i)).not.toBeInTheDocument();
    });
  });

  it('keeps the empty state as a plain row with no button', () => {
    mockRecords = { data: [], isLoading: false };
    render(<PersonalRecords />);
    expect(screen.getByText('Log sets to see your records.')).toBeInTheDocument();
    expect(screen.queryByText('Estimated one-rep max')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('waits for the records with a spinner', () => {
    mockRecords = { data: undefined, isLoading: true };
    render(<PersonalRecords />);
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
    expect(screen.queryByText('Log sets to see your records.')).not.toBeInTheDocument();
  });
});
