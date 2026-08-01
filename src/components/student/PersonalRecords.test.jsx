import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

let mockRecords = { data: [], isLoading: false };
vi.mock('../../hooks/useStudentRecords', () => ({
  useStudentRecords: () => mockRecords,
}));

import PersonalRecords from './PersonalRecords';

function rec(over = {}) {
  return {
    exercise_id: 'e-1',
    name: 'Weighted Pull-up',
    type: 'pull',
    loadMode: 'added',
    bestE1rm: 44,
    bestE1rmWeight: 40,
    bestE1rmReps: 3,
    bestReps: 3,
    relStrength: 1.7,
    bwAtBest: 70,
    recent: false,
    ...over,
  };
}

// The list is collapsed by default, so every content assertion opens it first.
function toggle() {
  return screen.getByRole('button', { name: /record/i });
}

async function expand() {
  await userEvent.click(toggle());
}

beforeEach(() => {
  mockRecords = { data: [], isLoading: false };
  localStorage.clear();
});

describe('<PersonalRecords />', () => {
  it('shows the added-load headline, best set, and the peak ×BW pill', async () => {
    mockRecords = { data: [rec()], isLoading: false };
    render(<PersonalRecords />);
    await expand();
    expect(screen.getByText(/44 kg/)).toBeInTheDocument(); // headline stays the added-load e1RM
    expect(screen.getByText(/best BW\+40kg × 3/)).toBeInTheDocument();
    expect(screen.getByText(/1\.7× BW/)).toBeInTheDocument();
  });

  it('hides the ×BW pill when relative strength is unknown', async () => {
    mockRecords = {
      data: [rec({ relStrength: null, bwAtBest: null })],
      isLoading: false,
    };
    render(<PersonalRecords />);
    await expand();
    expect(screen.getByText(/44 kg/)).toBeInTheDocument();
    expect(screen.queryByText(/× BW/)).not.toBeInTheDocument();
  });

  it('always renders ×BW to one decimal (2.0×, not 2×)', async () => {
    mockRecords = { data: [rec({ relStrength: 2 })], isLoading: false };
    render(<PersonalRecords />);
    await expand();
    expect(screen.getByText(/2\.0× BW/)).toBeInTheDocument();
  });

  it('nudges the student to log bodyweight when a classified lift is missing it', async () => {
    mockRecords = {
      data: [rec({ relStrength: null, bwAtBest: null })],
      isLoading: false,
    };
    render(<PersonalRecords />);
    await expand();
    expect(screen.getByText(/log your bodyweight/i)).toBeInTheDocument();
  });

  it('does not nudge on the coach surface (studentRowId present)', async () => {
    mockRecords = {
      data: [rec({ relStrength: null, bwAtBest: null })],
      isLoading: false,
    };
    render(<PersonalRecords studentRowId="st-1" />);
    await expand();
    expect(screen.queryByText(/log your bodyweight/i)).not.toBeInTheDocument();
  });

  it('renders a plain full-load record', async () => {
    mockRecords = {
      data: [rec({ name: 'Back Squat', loadMode: 'full', bestE1rm: 110, bestE1rmWeight: 100, relStrength: 1.6 })],
      isLoading: false,
    };
    render(<PersonalRecords />);
    await expand();
    expect(screen.getByText(/110 kg/)).toBeInTheDocument();
    expect(screen.getByText(/best 100kg × 3/)).toBeInTheDocument();
    expect(screen.getByText(/1\.6× BW/)).toBeInTheDocument();
  });

  it('collapses the list behind a count row by default', () => {
    mockRecords = {
      data: [rec(), rec({ exercise_id: 'e-2', name: 'Back Squat' })],
      isLoading: false,
    };
    render(<PersonalRecords />);
    expect(screen.getByText('2 records')).toBeInTheDocument();
    expect(toggle()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Weighted Pull-up')).not.toBeInTheDocument();
    expect(screen.queryByText('Back Squat')).not.toBeInTheDocument();
  });

  it('reveals every record when the count row is tapped, and folds them away again', async () => {
    mockRecords = {
      data: [rec(), rec({ exercise_id: 'e-2', name: 'Back Squat' })],
      isLoading: false,
    };
    render(<PersonalRecords />);
    await expand();
    expect(toggle()).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Weighted Pull-up')).toBeInTheDocument();
    expect(screen.getByText('Back Squat')).toBeInTheDocument();

    await userEvent.click(toggle());
    expect(screen.queryByText('Weighted Pull-up')).not.toBeInTheDocument();
  });

  it('uses the singular count label for one record', () => {
    mockRecords = { data: [rec()], isLoading: false };
    render(<PersonalRecords />);
    expect(screen.getByText('1 record')).toBeInTheDocument();
  });

  it('mirrors a fresh PR badge onto the collapsed row so it is not hidden', () => {
    mockRecords = {
      data: [rec(), rec({ exercise_id: 'e-2', name: 'Back Squat', recent: true })],
      isLoading: false,
    };
    render(<PersonalRecords />);
    expect(screen.getByText('NEW PR')).toBeInTheDocument(); // collapsed: only the summary badge
    expect(screen.queryByText('Back Squat')).not.toBeInTheDocument();
  });

  it('shows no PR badge on the collapsed row when nothing is recent', () => {
    mockRecords = { data: [rec()], isLoading: false };
    render(<PersonalRecords />);
    expect(screen.queryByText('NEW PR')).not.toBeInTheDocument();
  });

  it('remembers that the list was left open', () => {
    localStorage.setItem('sl_student_records_open', '1');
    mockRecords = { data: [rec()], isLoading: false };
    render(<PersonalRecords />);
    expect(screen.getByText('Weighted Pull-up')).toBeInTheDocument();
    expect(toggle()).toHaveAttribute('aria-expanded', 'true');
  });

  it('keeps the empty state as a plain card with no toggle', () => {
    mockRecords = { data: [], isLoading: false };
    render(<PersonalRecords />);
    expect(screen.getByText(/log some sets to see your records/i)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
