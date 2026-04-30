import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../../hooks/useI18n', () => ({
  useI18n: () => ({
    t: (k) => {
      const map = {
        'coach.dashboard.weekStripAria': 'Week at a glance',
        'coach.dashboard.dayStatus.completed': 'Completed',
        'coach.dashboard.dayStatus.today': 'Today',
        'coach.dashboard.dayStatus.upcoming': 'Upcoming',
        'coach.dashboard.dayStatus.missed': 'Missed',
        'coach.dashboard.dayStatus.rest': 'Rest',
      };
      return map[k] || k;
    },
  }),
}));

import StudentWeekStrip from './StudentWeekStrip';

function makeWeek(overrides = {}) {
  // Default: every day is rest.
  return Array.from({ length: 7 }, (_, i) => ({
    dayNumber: i + 1,
    session: null,
    confirmed: false,
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

  it('marks confirmed sessions as completed', () => {
    const week = makeWeek({
      1: { session: { id: 'a', title: 'Push', archived_at: null }, confirmed: true },
    });
    render(<StudentWeekStrip weekDays={week} />);
    const cells = screen.getAllByRole('listitem');
    expect(cells[0].getAttribute('aria-label')).toMatch(/Mon: Completed/);
  });

  it('marks an unconfirmed session on today as today', () => {
    // Today is Wed (3); a non-archived non-confirmed session there → today.
    const week = makeWeek({
      3: { session: { id: 'a', title: 'Pull', archived_at: null }, confirmed: false },
    });
    render(<StudentWeekStrip weekDays={week} />);
    const cells = screen.getAllByRole('listitem');
    expect(cells[2].getAttribute('aria-label')).toMatch(/Wed: Today/);
  });

  it('marks past unconfirmed sessions as missed', () => {
    // Today is Wed; Mon (1) has an unconfirmed session → missed.
    const week = makeWeek({
      1: { session: { id: 'a', title: 'Push', archived_at: null }, confirmed: false },
    });
    render(<StudentWeekStrip weekDays={week} />);
    const cells = screen.getAllByRole('listitem');
    expect(cells[0].getAttribute('aria-label')).toMatch(/Mon: Missed/);
  });

  it('marks future sessions as upcoming', () => {
    // Today is Wed; Fri (5) has an unconfirmed session → upcoming.
    const week = makeWeek({
      5: { session: { id: 'a', title: 'Legs', archived_at: null }, confirmed: false },
    });
    render(<StudentWeekStrip weekDays={week} />);
    const cells = screen.getAllByRole('listitem');
    expect(cells[4].getAttribute('aria-label')).toMatch(/Fri: Upcoming/);
  });

  it('treats archived sessions as rest', () => {
    const week = makeWeek({
      2: { session: { id: 'a', title: 'X', archived_at: '2026-04-01' }, confirmed: false },
    });
    render(<StudentWeekStrip weekDays={week} />);
    const cells = screen.getAllByRole('listitem');
    expect(cells[1].getAttribute('aria-label')).toMatch(/Tue: Rest/);
  });

  it('marks days with no session as rest', () => {
    render(<StudentWeekStrip weekDays={makeWeek()} />);
    const cells = screen.getAllByRole('listitem');
    cells.forEach((c) => {
      expect(c.getAttribute('aria-label')).toMatch(/Rest/);
    });
  });
});
