import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import WeeklyVolumePanel, {
  WEEKS_SHOWN,
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
    expect(starts(weeks)).toEqual([
      '2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28', '2026-10-05', '2026-10-12',
    ]);
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

  // Six weeks, as the mock draws them (design/parc/screens/Stats.dc.html).
  it('keeps the last six weeks of a long history', () => {
    expect(WEEKS_SHOWN).toBe(6);
    const history = ['2026-08-17', '2026-08-24', '2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21', '2026-10-12']
      .map((start) => bucket(start));
    expect(starts(weeklyWindow(history, { now: NOW }))).toEqual([
      '2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28', '2026-10-05', '2026-10-12',
    ]);
  });

  it('takes another size', () => {
    const history = ['2026-09-21', '2026-10-12'].map((start) => bucket(start));
    expect(starts(weeklyWindow(history, { now: NOW, size: 2 }))).toEqual(['2026-10-05', '2026-10-12']);
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

  // A week is a group of the chart (its columns, its label, its <title>) and
  // a row of the table a screen reader reads.
  const rows = (container) => [...container.querySelectorAll('[data-week]')];
  const table = () => screen.getByRole('table', { name: 'Volume per week' });
  const tableRows = () =>
    within(table())
      .getAllByRole('row')
      .slice(1)
      .map((row) => [...row.querySelectorAll('th, td')].map((cell) => plain(cell.textContent)));
  // Intl puts thin spaces around the dash of a range; read them as spaces.
  const plain = (text) => text.replace(/\s/g, ' ');
  // The sentence under the chart.
  const lastWeekLine = (container) => container.querySelector('section > p:last-child').textContent;

  it('is a section named by its title', () => {
    render(<WeeklyVolumePanel weeks={[bucket('2026-10-12')]} now={NOW} />);
    expect(screen.getByRole('region', { name: 'Volume per week' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Volume per week' })).toBeInTheDocument();
  });

  it('draws a row of zeros for a week with nothing trained', () => {
    const { container } = render(
      <WeeklyVolumePanel weeks={[bucket('2026-09-21'), bucket('2026-10-05')]} now={NOW} />,
    );
    expect(rows(container).map((r) => r.dataset.week))
      .toEqual(['2026-09-21', '2026-09-28', '2026-10-05', '2026-10-12']);
    const gap = rows(container)[1];
    expect(within(gap).getByText('Sep 28')).toBeInTheDocument();
    // No column for a week of zeros.
    expect(gap.querySelectorAll('path')).toHaveLength(0);
    expect(plain(gap.querySelector('title').textContent)).toMatch(/^Week of Sep 28 – Oct 4, pull 0, push 0,/);
    expect(tableRows()[1].slice(0, 3)).toEqual(['Sep 28 – Oct 4', '0', '0']);
    // No sets were planned in it: no "0/0 · NaN%".
    expect(container).not.toHaveTextContent(/NaN/);
  });

  it('says each week in words: its range, pull, push and the sets done of those planned', () => {
    render(
      <WeeklyVolumePanel
        weeks={[bucket('2026-10-05', { pull: 1250.4, push: 980, sets_done: 19, sets_prescribed: 21 })]}
        now={NOW}
      />,
    );
    expect(within(table()).getAllByRole('columnheader').map((h) => h.textContent))
      .toEqual(['Week', 'Pull', 'Push', 'Sets']);
    const [trained, thisWeek] = tableRows();
    expect(trained).toEqual(['Oct 5 – 11', '1,250', '980', '19 of 21']);
    expect(thisWeek.slice(0, 3)).toEqual(['Oct 12 – 18', '0', '0']);
  });

  it('runs to today by the clock when it is given no `now`', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const { container } = render(<WeeklyVolumePanel weeks={[bucket('2026-10-05')]} />);
    expect(rows(container).map((r) => r.dataset.week)).toEqual(['2026-10-05', '2026-10-12']);
    // The current week is the one in bold.
    expect(within(rows(container)[1]).getByText('Oct 12')).toHaveAttribute('font-weight', '700');
    expect(within(rows(container)[0]).getByText('Oct 5')).toHaveAttribute('font-weight', '400');
  });

  it('draws six weeks at most', () => {
    const history = ['2026-08-17', '2026-08-24', '2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21', '2026-10-12']
      .map((start) => bucket(start));
    const { container } = render(<WeeklyVolumePanel weeks={history} now={NOW} />);
    expect(rows(container)).toHaveLength(6);
    expect(tableRows()).toHaveLength(6);
  });

  it('does not draw empty weeks up to today for a past block', () => {
    const { container } = render(
      <WeeklyVolumePanel weeks={[bucket('2026-06-22'), bucket('2026-07-06')]} current={false} now={NOW} />,
    );
    expect(rows(container).map((r) => r.dataset.week))
      .toEqual(['2026-06-22', '2026-06-29', '2026-07-06']);
    expect(within(table()).getAllByText('9 of 12')).toHaveLength(2);
    // Its last week is not this week: it is named.
    expect(lastWeekLine(container)).toBe('Week of Jul 6, 9 of 12 sets done.');
  });

  // The finding: a week of planks and holds has no volume, and the panel
  // replaced every row with "No volume assigned yet." — adherence included.
  it('keeps the sets of a week that has no volume', () => {
    const holds = bucket('2026-10-12', {
      pull: 0, push: 0, pull_planned: 0, push_planned: 0, sets_done: 3, sets_prescribed: 3,
    });
    const { container } = render(<WeeklyVolumePanel weeks={[holds]} now={NOW} />);
    expect(rows(container)).toHaveLength(1);
    expect(within(table()).getByText('3 of 3')).toBeInTheDocument();
    expect(screen.queryByText('No training in this block yet.')).toBeNull();
    // What the figure counts is said; the pull/push legend has no bar to explain.
    expect(lastWeekLine(container)).toBe('This week, 3 of 3 sets done.');
    expect(container.querySelector('svg path')).toBeNull();
    expect(screen.queryByText('Pull', { selector: 'span' })).toBeNull();
  });

  it('says nothing was trained only when nothing was', () => {
    const { container } = render(<WeeklyVolumePanel weeks={[]} now={NOW} />);
    expect(screen.getByText('No training in this block yet.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Volume per week' })).toBeInTheDocument();
    expect(container.querySelector('svg')).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('draws the legend and the sentence beside a week with volume', () => {
    const { container } = render(
      <WeeklyVolumePanel
        weeks={[bucket('2026-10-12', { sets_done: 19, sets_prescribed: 21, extra_sets_done: 2 })]}
        now={NOW}
      />,
    );
    expect(screen.getByText('Work done, pull and push')).toBeInTheDocument();
    expect(screen.getByText('Pull', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('Push', { selector: 'span' })).toBeInTheDocument();
    // The chart is for the eye: the table and the sentence say it in words.
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    // One column for pull, one for push.
    expect(rows(container)[0].querySelectorAll('path')).toHaveLength(2);
    expect(lastWeekLine(container)).toBe('This week, 19 of 21 sets done. 2 more were added.');
    expect(screen.queryByText('No training in this block yet.')).toBeNull();
  });

  it('says when nothing was planned this week yet', () => {
    const { container } = render(<WeeklyVolumePanel weeks={[bucket('2026-10-05')]} now={NOW} />);
    expect(lastWeekLine(container)).toBe('No session this week yet.');
  });

  it('scales the bars to the weeks it draws, not to an older week out of view', () => {
    const old = bucket('2026-06-01', { pull: 900, push: 900, pull_planned: 900, push_planned: 900 });
    const { container } = render(<WeeklyVolumePanel weeks={[old, bucket('2026-10-12')]} now={NOW} />);
    // The value axis tops at the largest column of the window, 50.
    const axis = [...container.querySelectorAll('svg > g:not([data-week]) > text')].map((n) => n.textContent);
    expect(axis).toEqual(['50', '25', '0']);
    // 50 pull and 30 push: the push column is 60% of the pull one.
    const height = (path) => {
      const [, foot] = /^M[\d.]+,([\d.]+)/.exec(path.getAttribute('d'));
      const [, top] = /Q[\d.]+,([\d.]+)/.exec(path.getAttribute('d'));
      return Number(foot) - Number(top);
    };
    const [pull, push] = rows(container).at(-1).querySelectorAll('path');
    expect(pull).toHaveAttribute('fill', 'var(--chart-pull)');
    expect(push).toHaveAttribute('fill', 'var(--chart-push)');
    expect(height(push) / height(pull)).toBeCloseTo(0.6, 6);
  });
});

describe('computeMaxWeeklyTotal', () => {
  it('is the larger of performed and planned, over the weeks given', () => {
    expect(computeMaxWeeklyTotal([])).toBe(0);
    expect(computeMaxWeeklyTotal([bucket('2026-10-12'), bucket('2026-10-05', { pull: 200 })])).toBe(230);
  });
});
