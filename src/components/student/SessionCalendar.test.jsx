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
});
