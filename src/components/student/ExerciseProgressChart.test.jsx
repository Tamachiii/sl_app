import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ExerciseProgressChart from './ExerciseProgressChart';

describe('<ExerciseProgressChart />', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('renders an empty placeholder when there are no exercises', () => {
    render(<ExerciseProgressChart exercises={[]} byExercise={{}} />);
    expect(
      screen.getByText(/no weighted exercises in your program yet/i),
    ).toBeInTheDocument();
  });

  it('renders the SVG chart with the first exercise selected by default', () => {
    const exercises = [
      { id: 'e-1', name: 'Squat', type: 'push' },
      { id: 'e-2', name: 'Pull', type: 'pull' },
    ];
    const byExercise = {
      'e-1': [
        { week_id: 'w-1', week_number: 1, label: null, program_id: 'p-1', program_name: 'A', tonnage: 1000, key: 'p-1:w-1' },
        { week_id: 'w-2', week_number: 2, label: null, program_id: 'p-1', program_name: 'A', tonnage: 1500, key: 'p-1:w-2' },
      ],
    };
    render(<ExerciseProgressChart exercises={exercises} byExercise={byExercise} />);
    const select = screen.getByRole('combobox');
    expect(select.value).toBe('e-1');
    const svg = document.querySelector('svg[role="img"]');
    expect(svg).toBeTruthy();
  });

  it('changing the select switches the visible exercise', () => {
    const exercises = [
      { id: 'e-1', name: 'Squat' },
      { id: 'e-2', name: 'Pull' },
    ];
    const byExercise = {
      'e-1': [{ week_number: 1, tonnage: 100, program_id: 'p', key: 'p:1' }],
      'e-2': [{ week_number: 1, tonnage: 200, program_id: 'p', key: 'p:1' }],
    };
    render(<ExerciseProgressChart exercises={exercises} byExercise={byExercise} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'e-2' } });
    expect(screen.getByRole('combobox').value).toBe('e-2');
  });

  it('shows "No data for this exercise yet" when the selected exercise has no points', () => {
    const exercises = [{ id: 'e-1', name: 'Squat' }];
    render(<ExerciseProgressChart exercises={exercises} byExercise={{ 'e-1': [] }} />);
    expect(screen.getByText(/no data for this exercise yet/i)).toBeInTheDocument();
  });

  it('does NOT render the line path when only 1 data point', () => {
    const exercises = [{ id: 'e-1', name: 'Squat' }];
    const byExercise = {
      'e-1': [{ week_number: 1, tonnage: 100, program_id: 'p', key: 'p:1' }],
    };
    render(<ExerciseProgressChart exercises={exercises} byExercise={byExercise} />);
    const svg = document.querySelector('svg[role="img"]');
    // No <path> element means no line; check there's no `d=` starting with M.
    const paths = svg.querySelectorAll('path');
    expect(paths.length).toBe(0);
  });

  it('persists the selected exercise to localStorage when storageKey is set', () => {
    const exercises = [
      { id: 'e-1', name: 'Squat' },
      { id: 'e-2', name: 'Pull' },
    ];
    const byExercise = {
      'e-1': [{ week_number: 1, tonnage: 100, program_id: 'p', key: 'p:1' }],
      'e-2': [{ week_number: 1, tonnage: 200, program_id: 'p', key: 'p:1' }],
    };
    render(
      <ExerciseProgressChart
        exercises={exercises}
        byExercise={byExercise}
        storageKey="sl_test_chart"
      />,
    );
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'e-2' } });
    expect(window.localStorage.getItem('sl_test_chart')).toBe('e-2');
  });

  it('hydrates the initial selection from localStorage when storageKey is set', () => {
    window.localStorage.setItem('sl_test_chart', 'e-2');
    const exercises = [
      { id: 'e-1', name: 'Squat' },
      { id: 'e-2', name: 'Pull' },
    ];
    const byExercise = {
      'e-1': [{ week_number: 1, tonnage: 100, program_id: 'p', key: 'p:1' }],
      'e-2': [{ week_number: 1, tonnage: 200, program_id: 'p', key: 'p:1' }],
    };
    render(
      <ExerciseProgressChart
        exercises={exercises}
        byExercise={byExercise}
        storageKey="sl_test_chart"
      />,
    );
    expect(screen.getByRole('combobox').value).toBe('e-2');
  });

  it('falls back to the first exercise when the saved id is no longer in the list', () => {
    window.localStorage.setItem('sl_test_chart', 'e-stale');
    const exercises = [
      { id: 'e-1', name: 'Squat' },
      { id: 'e-2', name: 'Pull' },
    ];
    const byExercise = {
      'e-1': [{ week_number: 1, tonnage: 100, program_id: 'p', key: 'p:1' }],
    };
    render(
      <ExerciseProgressChart
        exercises={exercises}
        byExercise={byExercise}
        storageKey="sl_test_chart"
      />,
    );
    expect(screen.getByRole('combobox').value).toBe('e-1');
  });

  // The x-axis is a real timeline now — one point per session on the day it
  // was trained — so ticks are dates, not ordinal week numbers.
  it('labels the x-axis with the training date', () => {
    const exercises = [{ id: 'e-1', name: 'Squat' }];
    const byExercise = {
      'e-1': [
        { session_id: 's-1', date: '2026-07-08', tonnage: 100, program_id: 'p-1', key: 's-1' },
        { session_id: 's-2', date: '2026-07-11', tonnage: 200, program_id: 'p-1', key: 's-2' },
      ],
    };
    render(<ExerciseProgressChart exercises={exercises} byExercise={byExercise} />);
    expect(screen.getByText('7/8')).toBeInTheDocument();
    expect(screen.getByText('7/11')).toBeInTheDocument();
  });

  it('prefixes program name on x-labels when points span multiple programs', () => {
    const exercises = [{ id: 'e-1', name: 'Squat' }];
    const byExercise = {
      'e-1': [
        { session_id: 's-1', date: '2026-07-08', tonnage: 100, program_id: 'p-1', program_name: 'Block A', key: 's-1' },
        { session_id: 's-2', date: '2026-07-08', tonnage: 200, program_id: 'p-2', program_name: 'Block B', key: 's-2' },
      ],
    };
    render(<ExerciseProgressChart exercises={exercises} byExercise={byExercise} />);
    // Both points produce "BLO·7/8" because both program names start with "Block ".
    expect(screen.getAllByText('BLO·7/8').length).toBeGreaterThanOrEqual(1);
  });
});
