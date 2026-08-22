import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

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

function renderPanel(slots, perf = {}) {
  mockPerf = { data: perf, isLoading: false };
  return render(
    <PreviousSessionPanel studentRowId="st-1" sessionId="sess-1" slots={slots} />,
  );
}

describe('PreviousSessionPanel', () => {
  // The whole point of the rewrite: it used to list the coach's own past
  // PRESCRIPTION from "the same weekday last week". Progressive overload is
  // written against what the athlete actually lifted.
  it('shows the sets the athlete really performed, per exercise', () => {
    renderPanel(
      [slot('sl-1', 'ex-1', 'Bench Press')],
      {
        'ex-1': {
          performedAt: new Date().toISOString(),
          sets: [
            { weight: 100, reps: 8 },
            { weight: 100, reps: 8 },
            { weight: 100, reps: 8 },
          ],
        },
      },
    );
    expect(screen.getByText('Bench Press')).toBeInTheDocument();
    expect(screen.getByText('3 × 8 @ 100kg')).toBeInTheDocument();
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
    expect(screen.getByText('no history')).toBeInTheDocument();
  });

  it('lists every exercise of the session, history or not', () => {
    renderPanel(
      [slot('sl-1', 'ex-1', 'Bench Press'), slot('sl-2', 'ex-2', 'Row')],
      { 'ex-1': { performedAt: new Date().toISOString(), sets: [{ weight: 60, reps: 5 }] } },
    );
    expect(screen.getByText('Bench Press')).toBeInTheDocument();
    expect(screen.getByText('Row')).toBeInTheDocument();
    expect(screen.getByText('5 @ 60kg')).toBeInTheDocument();
    expect(screen.getByText('no history')).toBeInTheDocument();
  });

  // It used to require `week_number === current - 1`, so a one-week block —
  // the normal shape since the queue refactor — got no reference at all.
  it('renders in a block with no previous week, because there is no week maths left', () => {
    renderPanel(
      [slot('sl-1', 'ex-1', 'Bench Press')],
      { 'ex-1': { performedAt: new Date().toISOString(), sets: [{ weight: 80, reps: 6 }] } },
    );
    expect(screen.getByText('6 @ 80kg')).toBeInTheDocument();
  });

  it('renders nothing for a session with no exercises yet', () => {
    const { container } = renderPanel([]);
    expect(container).toBeEmptyDOMElement();
  });
});
