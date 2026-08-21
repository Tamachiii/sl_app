import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../../hooks/useI18n', () => ({
  useI18n: () => ({
    t: (k) => {
      const map = {
        'coach.dashboard.weekStripAria': 'Week at a glance',
        'coach.dashboard.dayStatus.performed': 'Trained',
        'coach.dashboard.dayStatus.today': 'Today',
        'coach.dashboard.dayStatus.planned': 'Recommended date',
        'coach.dashboard.dayStatus.suggested': 'Recommended day',
        'coach.dashboard.dayStatus.archived': 'Removed',
        'coach.dashboard.dayStatus.rest': 'Rest',
      };
      return map[k] || k;
    },
  }),
}));

import StudentWeekStrip from './StudentWeekStrip';

// The strip receives states already resolved by buildDayStrip — the component
// only paints them (plus the today highlight).
function makeWeek(overrides = {}) {
  return Array.from({ length: 7 }, (_, i) => ({
    dayNumber: i + 1,
    session: null,
    state: 'rest',
    ...(overrides[i + 1] || {}),
  }));
}

beforeEach(() => {
  // Pin "today" to Wednesday (dayNumber 3) for stable status assertions.
  // 2026-04-29 is a Wednesday.
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 3, 29, 12, 0, 0));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('StudentWeekStrip', () => {
  it('returns null when weekDays is empty/missing', () => {
    const { container } = render(<StudentWeekStrip weekDays={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders 7 day cells with M T W T F S S labels', () => {
    render(<StudentWeekStrip weekDays={makeWeek()} />);
    const cells = screen.getAllByRole('listitem');
    expect(cells).toHaveLength(7);
    expect(cells.map((c) => c.textContent)).toEqual(['M', 'T', 'W', 'T', 'F', 'S', 'S']);
  });

  it('shows the day a session was trained on', () => {
    const week = makeWeek({
      1: { session: { id: 'a', title: 'Push' }, state: 'performed' },
    });
    render(<StudentWeekStrip weekDays={week} />);
    const cells = screen.getAllByRole('listitem');
    expect(cells[0].getAttribute('aria-label')).toMatch(/Mon: Trained/);
  });

  it('highlights today when open work sits on it', () => {
    // Today is Wed (3).
    const week = makeWeek({
      3: { session: { id: 'a', title: 'Pull' }, state: 'planned' },
    });
    render(<StudentWeekStrip weekDays={week} />);
    const cells = screen.getAllByRole('listitem');
    expect(cells[2].getAttribute('aria-label')).toMatch(/Wed: Today/);
  });

  // The point of the refactor: a recommended day that has passed is not a
  // failure. It stays a recommendation, and the session stays next in queue.
  it('never marks a past day as missed', () => {
    const week = makeWeek({
      1: { session: { id: 'a', title: 'Push' }, state: 'suggested' },
    });
    render(<StudentWeekStrip weekDays={week} />);
    const cells = screen.getAllByRole('listitem');
    expect(cells[0].getAttribute('aria-label')).toMatch(/Mon: Recommended day/);
    expect(cells[0].getAttribute('aria-label')).not.toMatch(/Missed/);
  });

  it('keeps today from overriding a day already trained', () => {
    const week = makeWeek({
      3: { session: { id: 'a', title: 'Pull' }, state: 'performed' },
    });
    render(<StudentWeekStrip weekDays={week} />);
    const cells = screen.getAllByRole('listitem');
    expect(cells[2].getAttribute('aria-label')).toMatch(/Wed: Trained/);
  });

  it('keeps a pulled session visible instead of blanking the day', () => {
    const week = makeWeek({
      2: { session: { id: 'a', title: 'X' }, state: 'archived' },
    });
    render(<StudentWeekStrip weekDays={week} />);
    const cells = screen.getAllByRole('listitem');
    expect(cells[1].getAttribute('aria-label')).toMatch(/Tue: Removed/);
  });

  it('marks days with no session as rest', () => {
    render(<StudentWeekStrip weekDays={makeWeek()} />);
    const cells = screen.getAllByRole('listitem');
    cells.forEach((c) => {
      expect(c.getAttribute('aria-label')).toMatch(/Rest/);
    });
  });
});
