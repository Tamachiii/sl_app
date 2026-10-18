import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SessionCalendar from './SessionCalendar';
import { I18nProvider } from '../../hooks/useI18n';

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
    expect(screen.getByRole('heading', { level: 2, name: 'March 2026' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
    expect(screen.getByRole('heading', { level: 2, name: 'April 2026' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Previous month' }));
    fireEvent.click(screen.getByRole('button', { name: 'Previous month' }));
    expect(screen.getByRole('heading', { level: 2, name: 'February 2026' })).toBeInTheDocument();
  });

  it('is a section named by the month it shows', () => {
    renderCal();
    const month = screen.getByRole('region', { name: 'March 2026' });
    fireEvent.click(within(month).getByRole('button', { name: 'Next month' }));
    expect(screen.getByRole('region', { name: 'April 2026' })).toBe(month);
  });

  // The month and the day names are the app's, whatever the device's
  // language; a French month is written in lower case and is a title here.
  it('names the month and the weekdays in the language of the app', () => {
    localStorage.setItem('sl_app_lang', 'fr');
    try {
      render(
        <I18nProvider>
          <MemoryRouter>
            <SessionCalendar
              sessions={[{ session_id: 's-1', date: '2026-03-16', completed: false, title: 'Tirage' }]}
            />
          </MemoryRouter>
        </I18nProvider>,
      );
      expect(screen.getByRole('heading', { level: 2, name: 'Mars 2026' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Mois suivant' })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Tirage, lundi 16 mars' })).toBeInTheDocument();
      const header = [...document.querySelectorAll('[aria-hidden="true"].grid-cols-7 > *')].map((d) => d.textContent);
      expect(header).toEqual(['L', 'M', 'M', 'J', 'V', 'S', 'D']);
    } finally {
      localStorage.removeItem('sl_app_lang');
      document.documentElement.removeAttribute('lang');
    }
  });

  it('renders a dot for completed/upcoming sessions and links them', async () => {
    const sessions = [
      { session_id: 's-done', date: '2026-03-15', completed: true, title: 'Push' },
      { session_id: 's-future', date: '2026-03-16', completed: false, title: 'Pull' },
    ];
    renderCal(sessions);

    // A day is named by its session and its date, in words.
    const linkDone = screen.getByRole('link', { name: 'Push, Sunday, March 15' });
    expect(linkDone).toHaveAttribute('href', '/student/session/s-done');
    expect([...linkDone.querySelectorAll('[data-dot]')].map((d) => d.dataset.dot)).toEqual(['done']);

    const linkFuture = screen.getByRole('link', { name: 'Pull, Monday, March 16' });
    expect(linkFuture).toHaveAttribute('href', '/student/session/s-future');
    expect([...linkFuture.querySelectorAll('[data-dot]')].map((d) => d.dataset.dot)).toEqual(['upcoming']);
  });

  it('names a session without a title "Session"', () => {
    renderCal([{ session_id: 's-1', date: '2026-03-18', completed: false }]);
    expect(screen.getByRole('link', { name: 'Session, Wednesday, March 18' }))
      .toHaveAttribute('href', '/student/session/s-1');
  });

  it('links only the days that have a session', () => {
    renderCal([{ session_id: 's-1', date: '2026-03-18', completed: false, title: 'Legs' }]);
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });

  it('shows historical dot only when no active session falls on the same day', () => {
    const sessions = [
      // Day with both active (upcoming) and history → history dot suppressed.
      { session_id: 's-1', date: '2026-03-10', completed: false },
      { session_id: 's-h1', date: '2026-03-10', completed: true, historical: true },
      // Day with only history.
      { session_id: 's-h2', date: '2026-03-12', completed: true, historical: true },
    ];
    renderCal(sessions);
    const dotsOf = (name) =>
      [...screen.getByRole('link', { name }).querySelectorAll('[data-dot]')].map((d) => d.dataset.dot);
    // Day 03-10 leads to its active session and draws no history dot.
    expect(screen.getByRole('link', { name: 'Session, Tuesday, March 10' }))
      .toHaveAttribute('href', '/student/session/s-1');
    expect(dotsOf('Session, Tuesday, March 10')).toEqual(['unconfirmed']);
    // Day 03-12 has only a session of an earlier block.
    expect(screen.getByRole('link', { name: 'Session, Thursday, March 12' }))
      .toHaveAttribute('href', '/student/session/s-h2');
    expect(dotsOf('Session, Thursday, March 12')).toEqual(['history']);
  });

  // N7 of the live review: every session not confirmed was drawn and
  // labelled "Upcoming", the days of September already gone included.
  describe('a day that is over', () => {
    const dotsOf = (name) =>
      [...screen.getByRole('link', { name }).querySelectorAll('[data-dot]')].map((d) => d.dataset.dot);

    it('does not draw a session not confirmed as upcoming once its day is over', () => {
      renderCal([
        { session_id: 's-past', date: '2026-03-10', completed: false, title: 'Pull' },
        { session_id: 's-today', date: '2026-03-15', completed: false, title: 'Push' },
        { session_id: 's-next', date: '2026-03-20', completed: false, title: 'Legs' },
      ]);
      expect(dotsOf('Pull, Tuesday, March 10')).toEqual(['unconfirmed']);
      // Today can still be trained; a later day is to come.
      expect(dotsOf('Push, Sunday, March 15')).toEqual(['upcoming']);
      expect(dotsOf('Legs, Friday, March 20')).toEqual(['upcoming']);
    });

    it('keeps a confirmed session done, before today as on it', () => {
      renderCal([
        { session_id: 's-a', date: '2026-03-09', completed: true, title: 'Upper' },
        { session_id: 's-b', date: '2026-03-09', completed: false, title: 'Lower' },
      ]);
      expect(dotsOf('Upper, Monday, March 9')).toEqual(['done', 'unconfirmed']);
    });

    it('treats a past month the same', () => {
      renderCal([{ session_id: 's-feb', date: '2026-02-20', completed: false, title: 'Pull' }]);
      fireEvent.click(screen.getByRole('button', { name: 'Previous month' }));
      expect(dotsOf('Pull, Friday, February 20')).toEqual(['unconfirmed']);
    });

    it('names the state in the legend', () => {
      const { container } = renderCal();
      const legend = container.querySelector('[data-legend="unconfirmed"]');
      expect(legend).toHaveTextContent('Not confirmed');
      expect(screen.getByText('To come')).toBeInTheDocument();
    });
  });

  // Each mark is said in words, beside the same mark: a shape and a colour
  // for the eye, a word for everyone.
  it('says every mark in the legend, with its mark', () => {
    const { container } = renderCal();
    const legend = [...container.querySelectorAll('[data-legend]')].map((entry) => [
      entry.dataset.legend,
      entry.querySelector('[data-dot]').dataset.dot,
      entry.textContent,
    ]);
    expect(legend).toEqual([
      ['done', 'done', 'Done'],
      ['upcoming', 'upcoming', 'To come'],
      ['unconfirmed', 'unconfirmed', 'Not confirmed'],
      ['history', 'history', 'Earlier block'],
    ]);
  });
});

