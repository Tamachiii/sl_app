import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import WeeklyVolumePanel, {
  computeMaxWeeklyTotal,
  formatBucketRange,
  weeklyWindow,
} from './WeeklyVolumePanel';
import { inTimeZone, ZONES } from '../../test/inTimeZone';

// A bucket as useStudentProgressStats builds it: one per Mon–Sun week trained.
const bucket = (bucket_start, over = {}) => ({
  bucket_start,
  bucket_end: null,
  pull: 50,
  push: 30,
  pull_planned: 60,
  push_planned: 40,
  sets_done: 9,
  sets_prescribed: 12,
  extra_sets_done: 0,
  sessions_confirmed: 1,
  ...over,
});

// Saturday 17 October 2026: its week starts on Monday the 12th.
const NOW = new Date(2026, 9, 17, 12, 0, 0);

const starts = (weeks) => weeks.map((w) => w.bucket_start);

describe('weeklyWindow', () => {
  it('fills the weeks nothing was trained in with zeros, and runs to this week', () => {
    const weeks = weeklyWindow([bucket('2026-09-21'), bucket('2026-10-05')], { now: NOW });
    expect(starts(weeks)).toEqual(['2026-09-21', '2026-09-28', '2026-10-05', '2026-10-12']);
    expect(weeks[1]).toEqual({
      bucket_start: '2026-09-28',
      bucket_end: '2026-10-04',
      pull: 0,
      push: 0,
      pull_planned: 0,
      push_planned: 0,
      sets_done: 0,
      extra_sets_done: 0,
      sets_prescribed: 0,
      sessions_confirmed: 0,
    });
    expect(weeks[2].pull).toBe(50);
    expect(weeks[3].sets_prescribed).toBe(0);
  });

  // The finding: after a layoff, the four rows were the last four weeks
  // TRAINED, months apart. The layoff is the picture now.
  it('shows a layoff longer than the window as empty weeks up to this one', () => {
    const weeks = weeklyWindow([bucket('2026-06-29'), bucket('2026-07-06')], { now: NOW });
    expect(starts(weeks)).toEqual(['2026-09-21', '2026-09-28', '2026-10-05', '2026-10-12']);
    expect(weeks.every((w) => w.pull + w.push === 0)).toBe(true);
  });

  it('ends a past block at its own last week, not at four empty weeks of today', () => {
    const weeks = weeklyWindow(
      [bucket('2026-06-15'), bucket('2026-06-22'), bucket('2026-07-06')],
      { now: NOW, current: false },
    );
    expect(starts(weeks)).toEqual(['2026-06-15', '2026-06-22', '2026-06-29', '2026-07-06']);
    expect(weeks[2].pull).toBe(0);
  });

  it('keeps the last four weeks of a long history', () => {
    const history = ['2026-08-24', '2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21', '2026-10-12']
      .map((start) => bucket(start));
    expect(starts(weeklyWindow(history, { now: NOW })))
      .toEqual(['2026-09-21', '2026-09-28', '2026-10-05', '2026-10-12']);
  });

  it('does not start before the first week trained', () => {
    expect(starts(weeklyWindow([bucket('2026-10-05')], { now: NOW })))
      .toEqual(['2026-10-05', '2026-10-12']);
    expect(starts(weeklyWindow([bucket('2026-10-12')], { now: NOW }))).toEqual(['2026-10-12']);
  });

  it('takes the buckets in any order, and keeps one dated after this week', () => {
    expect(starts(weeklyWindow([bucket('2026-10-19'), bucket('2026-10-05')], { now: NOW })))
      .toEqual(['2026-10-05', '2026-10-12', '2026-10-19']);
  });

  it('is empty when nothing was trained', () => {
    expect(weeklyWindow([], { now: NOW })).toEqual([]);
    expect(weeklyWindow(undefined, { now: NOW })).toEqual([]);
    expect(weeklyWindow([{ bucket_start: null }], { now: NOW })).toEqual([]);
  });

  // The weeks are stepped by calendar day: the night the clocks go back
  // (25 October 2026 in Paris) is 25 hours long, and seven days of
  // milliseconds from Monday the 26th would land on Sunday the 18th.
  it.each(ZONES)('steps by calendar weeks across a change of the clocks (%s)', (zone) => {
    inTimeZone(zone, () => {
      const weeks = weeklyWindow([bucket('2026-10-12')], { now: new Date(2026, 10, 4, 9, 0, 0) });
      expect(starts(weeks)).toEqual(['2026-10-12', '2026-10-19', '2026-10-26', '2026-11-02']);
    });
  });
});

describe('formatBucketRange', () => {
  it('writes the Mon–Sun span in the language of the app', () => {
    // Intl puts thin spaces around the dash; the test reads them as spaces.
    const plain = (text) => text.replace(/\s/g, ' ');
    expect(plain(formatBucketRange('2026-07-06', 'en'))).toBe('Jul 6 – 12');
    expect(plain(formatBucketRange('2026-07-06', 'fr'))).toMatch(/^6 ?– ?12 juil\.$/);
    expect(formatBucketRange('nope', 'en')).toBe('');
  });
});

describe('<WeeklyVolumePanel />', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const rows = (container) => [...container.querySelectorAll('[data-week]')];

  it('draws a row of zeros for a week with nothing trained', () => {
    const { container } = render(
      <WeeklyVolumePanel weeks={[bucket('2026-09-21'), bucket('2026-10-05')]} now={NOW} />,
    );
    expect(rows(container).map((r) => r.dataset.week))
      .toEqual(['2026-09-21', '2026-09-28', '2026-10-05', '2026-10-12']);
    const gap = rows(container)[1];
    expect(within(gap).getByText('Sep 28 – Oct 4')).toBeInTheDocument();
    expect(within(gap).getByText('0')).toBeInTheDocument();
    // No sets were planned in it: no "0/0 · NaN%".
    expect(within(gap).queryByText(/\//)).toBeNull();
  });

  it('runs to today by the clock when it is given no `now`', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const { container } = render(<WeeklyVolumePanel weeks={[bucket('2026-10-05')]} />);
    expect(rows(container).map((r) => r.dataset.week)).toEqual(['2026-10-05', '2026-10-12']);
  });

  it('does not draw four empty weeks for a past block', () => {
    const { container } = render(
      <WeeklyVolumePanel weeks={[bucket('2026-06-22'), bucket('2026-07-06')]} current={false} now={NOW} />,
    );
    expect(rows(container).map((r) => r.dataset.week))
      .toEqual(['2026-06-22', '2026-06-29', '2026-07-06']);
    expect(screen.getAllByText('9/12 · 75%')).toHaveLength(2);
  });

  // The finding: a week of planks and holds has no volume, and the panel
  // replaced every row with "No volume assigned yet." — adherence included.
  it('keeps the sets of a week that has no volume', () => {
    const holds = bucket('2026-10-12', {
      pull: 0, push: 0, pull_planned: 0, push_planned: 0, sets_done: 3, sets_prescribed: 3,
    });
    const { container } = render(<WeeklyVolumePanel weeks={[holds]} now={NOW} />);
    expect(rows(container)).toHaveLength(1);
    expect(screen.getByText('3/3 · 100%')).toBeInTheDocument();
    expect(screen.queryByText(/no volume assigned/i)).toBeNull();
    expect(screen.queryByText(/no training logged/i)).toBeNull();
    // What the figure counts is said; the pull/push legend has no bar to explain.
    expect(screen.getByText(/for the sessions trained that week/i)).toBeInTheDocument();
    expect(screen.queryByText('PULL')).toBeNull();
  });

  it('says nothing was trained only when nothing was', () => {
    render(<WeeklyVolumePanel weeks={[]} now={NOW} />);
    expect(screen.getByText('No training logged yet.')).toBeInTheDocument();
    expect(screen.queryByText(/no volume assigned/i)).toBeNull();
  });

  it('draws the legend and both notes beside a week with volume', () => {
    render(<WeeklyVolumePanel weeks={[bucket('2026-10-12')]} now={NOW} />);
    expect(screen.getByText('PULL')).toBeInTheDocument();
    expect(screen.getByText(/bars show performed volume/i)).toBeInTheDocument();
    expect(screen.getByText(/for the sessions trained that week/i)).toBeInTheDocument();
    expect(screen.queryByText('No training logged yet.')).toBeNull();
  });

  it('scales the bars to the weeks it draws, not to an older week out of view', () => {
    const old = bucket('2026-06-01', { pull: 900, push: 900, pull_planned: 900, push_planned: 900 });
    const { container } = render(<WeeklyVolumePanel weeks={[old, bucket('2026-10-12')]} now={NOW} />);
    const last = rows(container).at(-1);
    // 80 performed of 100 planned, the largest of the window: an 80% bar.
    expect(last.querySelector('.relative.flex').style.width).toBe('80%');
  });
});

describe('computeMaxWeeklyTotal', () => {
  it('is the larger of performed and planned, over the weeks given', () => {
    expect(computeMaxWeeklyTotal([])).toBe(0);
    expect(computeMaxWeeklyTotal([bucket('2026-10-12'), bucket('2026-10-05', { pull: 200 })])).toBe(230);
  });
});
