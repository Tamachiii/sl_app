import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

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

beforeEach(() => {
  mockRecords = { data: [], isLoading: false };
});

describe('<PersonalRecords />', () => {
  it('shows the added-load headline, best set, and the peak ×BW pill', () => {
    mockRecords = { data: [rec()], isLoading: false };
    render(<PersonalRecords />);
    expect(screen.getByText(/44 kg/)).toBeInTheDocument(); // headline stays the added-load e1RM
    expect(screen.getByText(/best BW\+40kg × 3/)).toBeInTheDocument();
    expect(screen.getByText(/1\.7× BW/)).toBeInTheDocument();
  });

  it('hides the ×BW pill when relative strength is unknown', () => {
    mockRecords = {
      data: [rec({ relStrength: null, bwAtBest: null })],
      isLoading: false,
    };
    render(<PersonalRecords />);
    expect(screen.getByText(/44 kg/)).toBeInTheDocument();
    expect(screen.queryByText(/× BW/)).not.toBeInTheDocument();
  });

  it('always renders ×BW to one decimal (2.0×, not 2×)', () => {
    mockRecords = { data: [rec({ relStrength: 2 })], isLoading: false };
    render(<PersonalRecords />);
    expect(screen.getByText(/2\.0× BW/)).toBeInTheDocument();
  });

  it('nudges the student to log bodyweight when a classified lift is missing it', () => {
    mockRecords = {
      data: [rec({ relStrength: null, bwAtBest: null })],
      isLoading: false,
    };
    render(<PersonalRecords />);
    expect(screen.getByText(/log your bodyweight/i)).toBeInTheDocument();
  });

  it('does not nudge on the coach surface (studentRowId present)', () => {
    mockRecords = {
      data: [rec({ relStrength: null, bwAtBest: null })],
      isLoading: false,
    };
    render(<PersonalRecords studentRowId="st-1" />);
    expect(screen.queryByText(/log your bodyweight/i)).not.toBeInTheDocument();
  });

  it('renders a plain full-load record', () => {
    mockRecords = {
      data: [rec({ name: 'Back Squat', loadMode: 'full', bestE1rm: 110, bestE1rmWeight: 100, relStrength: 1.6 })],
      isLoading: false,
    };
    render(<PersonalRecords />);
    expect(screen.getByText(/110 kg/)).toBeInTheDocument();
    expect(screen.getByText(/best 100kg × 3/)).toBeInTheDocument();
    expect(screen.getByText(/1\.6× BW/)).toBeInTheDocument();
  });
});
