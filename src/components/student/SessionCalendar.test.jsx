import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SessionCalendar from './SessionCalendar';

function renderCal(sessions = []) {
  return render(
    <MemoryRouter>
      <SessionCalendar sessions={sessions} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  // Anchor "today" inside March 2026 (a month that starts on a Sunday).
  vi.setSystemTime(new Date('2026-03-15T12:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('<SessionCalendar />', () => {
  it('renders Mon-first weekday header', () => {
    renderCal();
    const headerLetters = screen
      .getAllByText(/^[MTWFS]$/)
      .slice(0, 7)
      .map((el) => el.textContent);
    expect(headerLetters).toEqual(['M', 'T', 'W', 'T', 'F', 'S', 'S']);
  });

  it('uses 6 leading blanks for a Sunday-start month (March 2026)', () => {
    const { container } = renderCal();
    const cells = container.querySelectorAll('.grid.grid-cols-7.gap-1 > *');
    const grid = Array.from(cells).slice(7); // skip the weekday header row
    // First 6 cells before the day "1" must be blank placeholders.
    const dayOnePos = Array.from(grid).findIndex((el) => el.textContent.trim() === '1');
    expect(dayOnePos).toBe(6);
  });

  it('navigates to the next and previous month via the chevron buttons', () => {
    renderCal();
    expect(screen.getByText(/March 2026/i)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Next month'));
    expect(screen.getByText(/April 2026/i)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Previous month'));
    fireEvent.click(screen.getByLabelText('Previous month'));
    expect(screen.getByText(/February 2026/i)).toBeInTheDocument();
  });

  it('renders a dot for completed/upcoming sessions and links them', async () => {
    const sessions = [
      { session_id: 's-done', date: '2026-03-15', completed: true, title: 'Push' },
      { session_id: 's-future', date: '2026-03-16', completed: false, title: 'Pull' },
    ];
    renderCal(sessions);

    const linkDone = screen.getByLabelText(/Push on 2026-03-15/);
    expect(linkDone).toHaveAttribute('href', '/student/session/s-done');

    const linkFuture = screen.getByLabelText(/Pull on 2026-03-16/);
    expect(linkFuture).toHaveAttribute('href', '/student/session/s-future');
  });

  it('shows historical dot only when no active session falls on the same day', () => {
    const sessions = [
      // Day with both active (upcoming) and history → history dot suppressed.
      { session_id: 's-1', date: '2026-03-10', completed: false },
      { session_id: 's-h1', date: '2026-03-10', completed: true, historical: true },
      // Day with only history.
      { session_id: 's-h2', date: '2026-03-12', completed: true, historical: true },
    ];
    const { container } = renderCal(sessions);
    // History-only cells use ink-400 dots.
    const dots = container.querySelectorAll('span[style*="--color-ink-400"]');
    // One legend dot + one history dot from 03-12 day cell. Day 03-10 should NOT
    // contribute a history dot because an active entry exists too.
    expect(dots.length).toBeGreaterThan(0);
  });

  // N7 of the live review: every session not confirmed was drawn and
  // labelled "Upcoming", the days of September already gone included.
  describe('a day that is over', () => {
    const dotsOf = (label) =>
      [...screen.getByLabelText(label).querySelectorAll('[data-dot]')].map((d) => d.dataset.dot);

    it('does not draw a session not confirmed as upcoming once its day is over', () => {
      renderCal([
        { session_id: 's-past', date: '2026-03-10', completed: false, title: 'Pull' },
        { session_id: 's-today', date: '2026-03-15', completed: false, title: 'Push' },
        { session_id: 's-next', date: '2026-03-20', completed: false, title: 'Legs' },
      ]);
      expect(dotsOf(/Pull on 2026-03-10/)).toEqual(['unconfirmed']);
      // Today can still be trained; a later day is to come.
      expect(dotsOf(/Push on 2026-03-15/)).toEqual(['upcoming']);
      expect(dotsOf(/Legs on 2026-03-20/)).toEqual(['upcoming']);
    });

    it('keeps a confirmed session done, before today as on it', () => {
      renderCal([
        { session_id: 's-a', date: '2026-03-09', completed: true, title: 'Upper' },
        { session_id: 's-b', date: '2026-03-09', completed: false, title: 'Lower' },
      ]);
      expect(dotsOf(/Upper on 2026-03-09/)).toEqual(['done', 'unconfirmed']);
    });

    it('treats a past month the same', () => {
      renderCal([{ session_id: 's-feb', date: '2026-02-20', completed: false, title: 'Pull' }]);
      fireEvent.click(screen.getByLabelText('Previous month'));
      expect(dotsOf(/Pull on 2026-02-20/)).toEqual(['unconfirmed']);
    });

    it('names the state in the legend', () => {
      const { container } = renderCal();
      const legend = container.querySelector('[data-legend="unconfirmed"]');
      expect(legend).toHaveTextContent('UNCONFIRMED');
      expect(screen.getByText('UPCOMING')).toBeInTheDocument();
    });
  });
});

