import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';

let mockPerf = { data: {}, isLoading: false };
vi.mock('../../hooks/useLastPerformance', () => ({
  useLastPerformance: (...args) => {
    mockPerf.calledWith = args;
    return mockPerf;
  },
}));

import PreviousSessionPanel from './PreviousSessionPanel';

const slot = (id, exId, name) => ({
  id,
  exercise: { id: exId, name },
});

function renderPanel(slots, perf = {}, { isLoading = false } = {}) {
  mockPerf = { data: perf, isLoading };
  return render(
    <PreviousSessionPanel studentRowId="st-1" sessionId="sess-1" slots={slots} />,
  );
}

// A session trained `days` calendar days ago, at this time of day.
function daysAgo(days) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString();
}

// The row of one exercise, read as one line: its name, then what was lifted.
const rowOf = (name) => screen.getByText(name).closest('li');

describe('PreviousSessionPanel', () => {
  // A section of the editor under its own heading.
  it('is the section "Last time"', () => {
    renderPanel([slot('sl-1', 'ex-1', 'Bench Press')]);
    const section = screen.getByRole('region', { name: 'Last time' });
    expect(within(section).getByRole('heading', { level: 2, name: 'Last time' })).toBeInTheDocument();
    expect(within(section).getByText('Bench Press')).toBeInTheDocument();
  });

  // The whole point of the rewrite: it used to list the coach's own past
  // PRESCRIPTION from "the same weekday last week". Progressive overload is
  // written against what the athlete actually lifted — in the athlete's own
  // words of « Last time » (lastTimeText of student/sessionModel).
  it('shows the sets the athlete really performed, per exercise', () => {
    renderPanel(
      [slot('sl-1', 'ex-1', 'Bench Press')],
      {
        'ex-1': {
          performedAt: daysAgo(7),
          sets: [
            { weight: 17.5, reps: 5 },
            { weight: 17.5, reps: 5 },
            { weight: 17.5, reps: 5 },
            { weight: 17.5, reps: 5 },
            { weight: 17.5, reps: 5 },
          ],
        },
      },
    );
    expect(screen.getByText('Bench Press')).toBeInTheDocument();
    expect(screen.getByText('7 days ago, 5 × 5 at 17.5 kg.')).toBeInTheDocument();
    expect(rowOf('Bench Press')).toHaveTextContent('Bench Press, 7 days ago, 5 × 5 at 17.5 kg.');
  });

  it('scopes the read to THIS athlete — a coach must not see another one’s history', () => {
    renderPanel([slot('sl-1', 'ex-1', 'Bench Press')]);
    // (sessionId, slots, scheduledDate, deviations, ready, studentRowId)
    expect(mockPerf.calledWith[0]).toBe('sess-1');
    expect(mockPerf.calledWith[5]).toBe('st-1');
  });

  it('says so plainly when an exercise has no history to beat', () => {
    renderPanel([slot('sl-1', 'ex-1', 'Snatch')]);
    expect(screen.getByText('Snatch')).toBeInTheDocument();
    expect(screen.getByText('Not trained yet')).toBeInTheDocument();
  });

  it('lists every exercise of the session, history or not', () => {
    renderPanel(
      [slot('sl-1', 'ex-1', 'Bench Press'), slot('sl-2', 'ex-2', 'Row')],
      { 'ex-1': { performedAt: daysAgo(0), sets: [{ weight: 60, reps: 5 }] } },
    );
    expect(rowOf('Bench Press')).toHaveTextContent('Today, 5 at 60 kg.');
    expect(rowOf('Row')).toHaveTextContent('Not trained yet');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  // It used to require `week_number === current - 1`, so a one-week block —
  // the normal shape since the queue refactor — got no reference at all.
  it('renders in a block with no previous week, because there is no week maths left', () => {
    renderPanel(
      [slot('sl-1', 'ex-1', 'Bench Press')],
      { 'ex-1': { performedAt: daysAgo(1), sets: [{ weight: 80, reps: 6 }] } },
    );
    expect(screen.getByText('Yesterday, 6 at 80 kg.')).toBeInTheDocument();
  });

  it('waits for the read with a spinner, not with "Not trained yet"', () => {
    renderPanel([slot('sl-1', 'ex-1', 'Bench Press')], undefined, { isLoading: true });
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
    expect(screen.queryByText('Not trained yet')).toBeNull();
  });

  it('renders nothing for a session with no exercises yet', () => {
    const { container } = renderPanel([]);
    expect(container).toBeEmptyDOMElement();
  });
});
