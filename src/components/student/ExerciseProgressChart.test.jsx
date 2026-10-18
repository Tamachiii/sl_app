import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import ExerciseProgressChart, {
  pointPositions,
  thinTicks,
  tickCentre,
  tickWidth,
} from './ExerciseProgressChart';
import { addDays, isoDate } from '../../lib/day';
import { inTimeZone, ZONES } from '../../test/inTimeZone';

describe('<ExerciseProgressChart />', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  const exercisePicker = () => screen.getByRole('combobox', { name: 'Exercise' });
  // The chart is drawn for the eye; a screen reader reads the same sessions
  // from a table named like the chart.
  const sessionRows = () =>
    within(screen.getByRole('table', { name: 'Tonnage per session' }))
      .getAllByRole('cell')
      .map((cell) => cell.textContent);
  const chartSvg = (container) => container.querySelector('svg');

  it('renders an empty placeholder when there are no exercises', () => {
    render(<ExerciseProgressChart exercises={[]} byExercise={{}} />);
    expect(screen.getByText('No exercise with a load yet.')).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).toBeNull();
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
    const { container } = render(<ExerciseProgressChart exercises={exercises} byExercise={byExercise} />);
    expect(exercisePicker().value).toBe('e-1');
    // Drawn for the eye only: the table and the caption say it in words.
    expect(chartSvg(container)).toHaveAttribute('aria-hidden', 'true');
    const rows = sessionRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatch(/1,000\u00a0kg$/);
    expect(rows[1]).toMatch(/1,500\u00a0kg$/);
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
    expect(sessionRows()).toEqual(['100\u00a0kg']);
    fireEvent.change(exercisePicker(), { target: { value: 'e-2' } });
    expect(exercisePicker().value).toBe('e-2');
    expect(sessionRows()).toEqual(['200\u00a0kg']);
  });

  it('says so when the selected exercise has no points', () => {
    const exercises = [{ id: 'e-1', name: 'Squat' }];
    const { container } = render(<ExerciseProgressChart exercises={exercises} byExercise={{ 'e-1': [] }} />);
    expect(screen.getByText('No session of this exercise yet.')).toBeInTheDocument();
    expect(chartSvg(container)).toBeNull();
  });

  it('does NOT render the line path when only 1 data point', () => {
    const exercises = [{ id: 'e-1', name: 'Squat' }];
    const byExercise = {
      'e-1': [{ week_number: 1, tonnage: 100, program_id: 'p', key: 'p:1' }],
    };
    const { container } = render(<ExerciseProgressChart exercises={exercises} byExercise={byExercise} />);
    // No <path> element means no line; the single session is a dot.
    expect(chartSvg(container).querySelectorAll('path')).toHaveLength(0);
    expect(chartSvg(container).querySelectorAll('circle')).toHaveLength(1);
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
    fireEvent.change(exercisePicker(), { target: { value: 'e-2' } });
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
    expect(exercisePicker().value).toBe('e-2');
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
    expect(exercisePicker().value).toBe('e-1');
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
    // Both points produce "Blo, 7/8" because both program names start with "Block ".
    expect(screen.getAllByText('Blo, 7/8').length).toBeGreaterThanOrEqual(1);
  });

  it('keeps the date alone on x-labels when every point is of one program', () => {
    const exercises = [{ id: 'e-1', name: 'Squat' }];
    const byExercise = {
      'e-1': [
        { session_id: 's-1', date: '2026-07-08', tonnage: 100, program_id: 'p-1', program_name: 'Block A', key: 's-1' },
        { session_id: 's-2', date: '2026-07-11', tonnage: 200, program_id: 'p-1', program_name: 'Block A', key: 's-2' },
      ],
    };
    render(<ExerciseProgressChart exercises={exercises} byExercise={byExercise} />);
    expect(screen.getByText('7/8')).toBeInTheDocument();
    expect(screen.queryByText(/^Blo, /)).toBeNull();
  });

  // What a dot says on hover is what the table says: the block, the day, the
  // session, the tonnage and a swap.
  it('says each session in words, on its dot and in the table', () => {
    const exercises = [{ id: 'e-1', name: 'Squat' }];
    const byExercise = {
      'e-1': [
        { session_id: 's-1', date: '2026-07-08', title: 'Heavy', tonnage: 1250, program_id: 'p-1', program_name: 'Block A', key: 's-1' },
        { session_id: 's-2', date: '2026-07-11', tonnage: 900, program_id: 'p-1', program_name: 'Block A', key: 's-2', swappedFrom: 'Front squat' },
        { session_id: 's-3', date: '2026-07-14', tonnage: 950, program_id: 'p-1', program_name: 'Block A', key: 's-3', swappedTo: 'Leg press' },
      ],
    };
    const { container } = render(<ExerciseProgressChart exercises={exercises} byExercise={byExercise} />);
    const said = [
      'Block A, Jul 8, 2026, Heavy, 1,250\u00a0kg',
      'Block A, Jul 11, 2026, 900\u00a0kg, in place of Front squat',
      'Block A, Jul 14, 2026, 950\u00a0kg, replaced by Leg press',
    ];
    expect(sessionRows()).toEqual(said);
    expect([...chartSvg(container).querySelectorAll('circle > title')].map((n) => n.textContent)).toEqual(said);
  });

  // The caption's highest figure is the PERFORMED peak: planned may be
  // higher, and the caption would then overstate what the athlete did.
  it('captions the performed peak, and the planned line only when one is drawn', () => {
    const exercises = [{ id: 'e-1', name: 'Squat' }];
    const point = (date, tonnage, plannedTonnage) => ({
      session_id: `s-${date}`, date, tonnage, plannedTonnage, program_id: 'p-1', key: `s-${date}`,
    });
    const dashed = (container) => chartSvg(container).querySelectorAll('path[stroke-dasharray]');

    const { container, unmount } = render(
      <ExerciseProgressChart
        exercises={exercises}
        byExercise={{ 'e-1': [point('2026-07-08', 1000, 1400), point('2026-07-11', 1200, 1200)] }}
      />,
    );
    expect(screen.getByText(/Highest, 1,200 kg\./)).toHaveTextContent(
      'Tonnage done: reps times load of the sets done, 1 kg at bodyweight. Highest, 1,200 kg. Dashed, the tonnage planned.',
    );
    expect(dashed(container)).toHaveLength(1);
    unmount();

    // As planned: no dashed line, and the caption does not mention one.
    const asPlanned = render(
      <ExerciseProgressChart
        exercises={exercises}
        byExercise={{ 'e-1': [point('2026-07-08', 1000, 1000), point('2026-07-11', 1200, 1200)] }}
      />,
    );
    expect(dashed(asPlanned.container)).toHaveLength(0);
    expect(screen.queryByText(/Dashed/)).toBeNull();
    asPlanned.unmount();

    // One session: no line of either kind, whatever was planned.
    const one = render(
      <ExerciseProgressChart exercises={exercises} byExercise={{ 'e-1': [point('2026-07-08', 1000, 1400)] }} />,
    );
    expect(dashed(one.container)).toHaveLength(0);
    expect(screen.queryByText(/Dashed/)).toBeNull();
  });

  // The Progression list of the athlete's stats opens the chart of the row
  // that was tapped: the exercise is the list's, and the chart has no
  // choice of its own.
  describe('given its exercise (`exerciseId`)', () => {
    const exercises = [
      { id: 'e-1', name: 'Squat' },
      { id: 'e-2', name: 'Pull' },
    ];
    const byExercise = {
      'e-1': [{ session_id: 's-1', date: '2026-07-08', tonnage: 100, program_id: 'p', key: 's-1' }],
      'e-2': [{ session_id: 's-2', date: '2026-07-09', tonnage: 200, program_id: 'p', key: 's-2' }],
    };

    it('draws that exercise, and offers no select', () => {
      render(<ExerciseProgressChart exercises={exercises} byExercise={byExercise} exerciseId="e-2" />);
      expect(screen.queryByRole('combobox')).toBeNull();
      expect(sessionRows()).toEqual(['Jul 9, 2026, 200\u00a0kg']);
    });

    it('follows the exercise it is given', () => {
      const view = render(<ExerciseProgressChart exercises={exercises} byExercise={byExercise} exerciseId="e-2" />);
      view.rerender(<ExerciseProgressChart exercises={exercises} byExercise={byExercise} exerciseId="e-1" />);
      expect(sessionRows()).toEqual(['Jul 8, 2026, 100\u00a0kg']);
    });

    it('neither reads nor writes a saved choice', () => {
      window.localStorage.setItem('sl_test_chart', 'e-1');
      render(
        <ExerciseProgressChart
          exercises={exercises}
          byExercise={byExercise}
          storageKey="sl_test_chart"
          exerciseId="e-2"
        />,
      );
      expect(sessionRows()).toEqual(['Jul 9, 2026, 200\u00a0kg']);
      expect(window.localStorage.getItem('sl_test_chart')).toBe('e-1');
    });

    it('says so when that exercise has no session', () => {
      render(<ExerciseProgressChart exercises={exercises} byExercise={{ 'e-1': byExercise['e-1'] }} exerciseId="e-2" />);
      expect(screen.getByText('No session of this exercise yet.')).toBeInTheDocument();
      expect(screen.queryByRole('table')).toBeNull();
    });
  });

  // `bare` is the chart drawn inside a row of a list, which is already white.
  it('draws its own white box unless it is `bare`', () => {
    const exercises = [{ id: 'e-1', name: 'Squat' }];
    const byExercise = { 'e-1': [{ session_id: 's-1', date: '2026-07-08', tonnage: 100, program_id: 'p', key: 's-1' }] };
    const boxed = render(<ExerciseProgressChart exercises={exercises} byExercise={byExercise} />);
    expect(boxed.container.firstChild).toHaveClass('bg-surface');
    boxed.unmount();

    const bare = render(<ExerciseProgressChart exercises={exercises} byExercise={byExercise} exerciseId="e-1" bare />);
    expect(bare.container.firstChild).not.toHaveClass('bg-surface');
    expect(bare.container.querySelector('svg')).not.toBeNull();
  });

  // B40: the points were spaced by their index, so two sessions two days
  // apart and two months apart looked the same.
  describe('a time axis', () => {
    const exercises = [{ id: 'e-1', name: 'Squat' }];
    const point = (date, over = {}) => ({
      session_id: `s-${date}`, date, tonnage: 100, program_id: 'p-1', key: `s-${date}`, ...over,
    });
    const chart = (points) => {
      const view = render(<ExerciseProgressChart exercises={exercises} byExercise={{ 'e-1': points }} />);
      const svg = view.container.querySelector('svg');
      return {
        cx: [...svg.querySelectorAll('circle')].map((c) => Number(c.getAttribute('cx'))),
        bars: [...svg.querySelectorAll('rect')].map((r) => Number(r.getAttribute('width'))),
        ticks: [...svg.querySelectorAll('g[data-axis="x"] text')].map((n) => ({
          text: n.textContent,
          x: Number(n.getAttribute('x')),
        })),
        width: Number(svg.getAttribute('viewBox').split(' ')[2]),
      };
    };
    // Twice a week from 1 June: 24 sessions over twelve weeks.
    const twiceAWeek = (over) => Array.from({ length: 24 }, (_, i) =>
      point(isoDate(addDays(new Date(2026, 5, 1), Math.floor(i / 2) * 7 + (i % 2) * 3)), over?.(i)));

    it('places a point by its date', () => {
      const { cx } = chart([point('2026-07-01'), point('2026-07-02'), point('2026-08-30')]);
      expect((cx[1] - cx[0]) / (cx[2] - cx[0])).toBeCloseTo(1 / 60, 6);
    });

    it.each(ZONES)('counts calendar days across a change of the clocks (%s)', (zone) => {
      inTimeZone(zone, () => {
        // 25 October 2026 is a day of 25 hours in Paris, 1 November in Los Angeles.
        const { cx } = chart([point('2026-10-20'), point('2026-10-27'), point('2026-11-03')]);
        expect(cx[1] - cx[0]).toBeCloseTo(cx[2] - cx[1], 6);
      });
    });

    it('centres a single point', () => {
      const one = chart([point('2026-07-01')]);
      // Halfway between the value axis (40 wide) and the right margin (8).
      const centre = (one.width + 40 - 8) / 2;
      expect(one.cx).toEqual([centre]);
    });

    it('centres the points of a single day', () => {
      const { cx, ticks } = chart([point('2026-07-01'), point('2026-07-01', { session_id: 's-b', key: 's-b' })]);
      expect(cx[0]).toBe(cx[1]);
      expect(ticks).toHaveLength(1);
    });

    it('spaces points without a date by their order, as before', () => {
      const { cx, ticks } = chart([
        { week_number: 1, tonnage: 100, key: 'a' },
        { week_number: 2, tonnage: 200, key: 'b' },
        { week_number: 3, tonnage: 300, key: 'c' },
      ]);
      expect(cx[1] - cx[0]).toBeCloseTo(cx[2] - cx[1], 6);
      expect(cx[0]).toBeLessThan(cx[1]);
      expect(ticks).toEqual([]);
    });

    it('draws no more than six dates under 24 sessions, the first and the last among them, none on another', () => {
      const points = twiceAWeek();
      const { ticks, width } = chart(points);
      expect(ticks.length).toBeGreaterThanOrEqual(4);
      expect(ticks.length).toBeLessThanOrEqual(6);
      expect(ticks[0].text).toBe('6/1');
      expect(ticks.at(-1).text).toBe('8/20');
      ticks.forEach((tick, i) => {
        const half = tickWidth(tick.text) / 2;
        expect(tick.x - half).toBeGreaterThanOrEqual(0);
        expect(tick.x + half).toBeLessThanOrEqual(width);
        if (i > 0) {
          const before = ticks[i - 1];
          expect(before.x + tickWidth(before.text) / 2).toBeLessThan(tick.x - half);
        }
      });
    });

    it('keeps the wider labels of several programs apart too', () => {
      const points = twiceAWeek((i) => ({ program_name: i < 12 ? 'Block A' : 'Peak' }));
      const { ticks } = chart(points);
      expect(ticks.length).toBeGreaterThanOrEqual(2);
      expect(ticks.length).toBeLessThanOrEqual(6);
      expect(ticks[0].text).toBe('Blo, 6/1');
      expect(ticks.at(-1).text).toBe('Pea, 8/20');
      ticks.slice(1).forEach((tick, i) => {
        const before = ticks[i];
        expect(before.x + tickWidth(before.text) / 2).toBeLessThan(tick.x - tickWidth(tick.text) / 2);
      });
    });

    it('makes a bar narrower than the gap to the nearest training day', () => {
      const close = chart([point('2026-07-01'), point('2026-07-02'), point('2026-08-30')]);
      const gap = close.cx[1] - close.cx[0];
      expect(close.bars.every((w) => w < gap)).toBe(true);
      // Far apart, a bar keeps its full width.
      expect(chart([point('2026-07-01'), point('2026-07-15')]).bars).toEqual([18, 18]);
    });
  });
});

describe('pointPositions', () => {
  const range = { left: 0, right: 100 };
  it('is a time axis when every point has a date, an order otherwise', () => {
    expect(pointPositions([{ date: '2026-07-01' }, { date: '2026-07-03' }, { date: '2026-07-11' }], range))
      .toEqual([0, 20, 100]);
    expect(pointPositions([{ date: '2026-07-01' }, {}, { date: '2026-07-11' }], range)).toEqual([0, 50, 100]);
    expect(pointPositions([{}], range)).toEqual([50]);
    expect(pointPositions([], range)).toEqual([]);
  });
});

describe('thinTicks', () => {
  const evenly = (n, width = 10, span = 300) =>
    Array.from({ length: n }, (_, i) => ({ x: (i * span) / (n - 1), width }));

  it('labels every point when they fit, and no more than `max`', () => {
    expect(thinTicks(evenly(3))).toEqual([0, 1, 2]);
    expect(thinTicks(evenly(24)).length).toBe(6);
    expect(thinTicks(evenly(24), { max: 4 })).toEqual([0, 8, 15, 23]);
  });

  it('gives fewer labels when wide ones would touch, always the first and the last', () => {
    const chosen = thinTicks(evenly(24, 70));
    expect(chosen[0]).toBe(0);
    expect(chosen.at(-1)).toBe(23);
    expect(chosen.length).toBeLessThan(6);
  });

  it('gives one label to points on one spot', () => {
    expect(thinTicks([{ x: 50, width: 20 }, { x: 50, width: 20 }])).toEqual([0]);
    expect(thinTicks([])).toEqual([]);
  });

  it('holds a label inside the chart before it measures the overlap', () => {
    expect(tickCentre(318, 18, { minX: 0, maxX: 320 })).toBe(311);
    expect(tickCentre(2, 18, { minX: 0, maxX: 320 })).toBe(9);
    // Two labels pushed against the edge would land on each other.
    expect(thinTicks([{ x: 300, width: 40 }, { x: 320, width: 40 }], { maxX: 320 })).toEqual([0]);
  });
});
