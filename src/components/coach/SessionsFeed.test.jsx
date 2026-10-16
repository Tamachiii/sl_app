import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation, useParams } from 'react-router-dom';

let mockConfirmations = { data: [], isLoading: false };
let mockPositions = { data: undefined };

vi.mock('../../hooks/useSessionConfirmation', () => ({
  useAllConfirmations: () => mockConfirmations,
}));

vi.mock('../../hooks/useProgram', () => ({
  useCoachSessionPositions: () => mockPositions,
}));

import SessionsFeed from './SessionsFeed';

function renderFeed(initialEntries = ['/coach/sessions']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <SessionsFeed />
    </MemoryRouter>
  );
}

const makeConfirmation = (overrides = {}) => ({
  id: 'c-1',
  session_id: 'sess-1',
  student_id: 's-1',
  student_name: 'Alice',
  session_title: 'Push Day',
  day_number: 1,
  week_number: 1,
  week_label: null,
  confirmed_at: '2026-04-16T10:00:00Z',
  archived_at: null,
  notes: null,
  ...overrides,
});

describe('SessionsFeed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfirmations = { data: [], isLoading: false };
    mockPositions = { data: undefined };
    localStorage.clear();
  });

  it('renders loading spinner', () => {
    mockConfirmations = { data: undefined, isLoading: true };
    renderFeed();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('renders empty state when no confirmations', () => {
    renderFeed();
    expect(screen.getByText(/no confirmed sessions yet/i)).toBeInTheDocument();
  });

  it('renders a confirmation card with student name and session title', () => {
    mockConfirmations = { data: [makeConfirmation()], isLoading: false };
    renderFeed();
    expect(screen.getAllByText('Alice').length).toBeGreaterThan(0);
    expect(screen.getByText('Push Day')).toBeInTheDocument();
  });

  it('shows archived toggle button when archived sessions exist', async () => {
    const user = userEvent.setup();
    mockConfirmations = {
      data: [
        makeConfirmation({ id: 'c-1', archived_at: '2026-04-16T12:00:00Z', session_title: 'Archived Session' }),
      ],
      isLoading: false,
    };
    renderFeed();
    expect(screen.getByRole('button', { name: /show.*archived/i })).toBeInTheDocument();
    expect(screen.queryByText('Archived Session')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /show.*archived/i }));
    expect(screen.getByText('Archived Session')).toBeInTheDocument();
  });

  it('filters cards by selected student', async () => {
    const user = userEvent.setup();
    mockConfirmations = {
      data: [
        makeConfirmation({ id: 'c-1', session_id: 's-a', student_id: 's-1', student_name: 'Alice', session_title: 'Alice Push' }),
        makeConfirmation({ id: 'c-2', session_id: 's-b', student_id: 's-2', student_name: 'Bob', session_title: 'Bob Pull' }),
      ],
      isLoading: false,
    };
    renderFeed();
    expect(screen.getByText('Alice Push')).toBeInTheDocument();
    expect(screen.getByText('Bob Pull')).toBeInTheDocument();

    await user.selectOptions(screen.getByRole('combobox'), 's-1');
    expect(screen.getByText('Alice Push')).toBeInTheDocument();
    expect(screen.queryByText('Bob Pull')).not.toBeInTheDocument();
  });

  // Review item L14: the line under the title was "W{week} · {label} ·
  // D{day}" — a phase is not a calendar week and a session needs no weekday
  // any more, so live cards ended in a bare "· D" or read "W1 · W1 · D2".
  describe('where the session sits', () => {
    const card = () => screen.getByText('Push Day').closest('a');

    it('names the phase and the place in the block, never a week or a weekday', () => {
      mockConfirmations = {
        data: [makeConfirmation({ week_number: 3, day_number: 2, week_label: 'Volume' })],
        isLoading: false,
      };
      mockPositions = { data: { 'sess-1': { n: 2, total: 9 } } };
      renderFeed();
      expect(within(card()).getByText('Volume · Session 2/9')).toBeInTheDocument();
      expect(card().textContent).not.toMatch(/W3|D2/);
    });

    it('says nothing about a phase without a name and a session without a day', () => {
      mockConfirmations = {
        data: [makeConfirmation({ week_number: 3, day_number: null, week_label: null })],
        isLoading: false,
      };
      mockPositions = { data: { 'sess-1': { n: 4, total: 12 } } };
      renderFeed();
      expect(within(card()).getByText('Session 4/12')).toBeInTheDocument();
      expect(card().textContent).not.toMatch(/W3|· D|null/);
    });

    it('names the phase alone while the places are not known', () => {
      mockConfirmations = {
        data: [makeConfirmation({ week_number: 1, day_number: 2, week_label: 'Volume' })],
        isLoading: false,
      };
      renderFeed();
      expect(within(card()).getByText('Volume')).toBeInTheDocument();
      expect(card().textContent).not.toMatch(/Session \d|W1|D2/);
    });

    it('draws no empty line when there is nothing to say', () => {
      mockConfirmations = {
        data: [makeConfirmation({ week_number: 1, day_number: null, week_label: null })],
        isLoading: false,
      };
      renderFeed();
      expect(card().querySelectorAll('p')).toHaveLength(0);
    });

    // The confirmation of a workout logged offline reaches the server when
    // the queue is replayed, days later sometimes.
    it('dates the card with the day the athlete trained, in the app’s language', () => {
      mockConfirmations = {
        data: [makeConfirmation({ performed_on: '2026-04-12', confirmed_at: '2026-04-16T10:00:00Z' })],
        isLoading: false,
      };
      renderFeed();
      expect(within(card()).getByText('Apr 12, 2026')).toBeInTheDocument();
      expect(card().textContent).not.toMatch(/Apr 16|4\/16\/2026/);
    });

    it('falls back to the day of the confirmation for a row without a training date', () => {
      mockConfirmations = { data: [makeConfirmation({ performed_on: null })], isLoading: false };
      renderFeed();
      expect(within(card()).getByText('Apr 16, 2026')).toBeInTheDocument();
    });
  });

  it('displays student notes on the card', () => {
    mockConfirmations = {
      data: [makeConfirmation({ notes: 'Felt really strong today' })],
      isLoading: false,
    };
    renderFeed();
    expect(screen.getByText('Felt really strong today')).toBeInTheDocument();
  });

  it('defaults to the needs-review inbox: reviewed cards are hidden until "All"', async () => {
    const user = userEvent.setup();
    mockConfirmations = {
      data: [
        makeConfirmation({ id: 'c-r', session_id: 's-r', session_title: 'Pulled', reviewed_at: '2026-04-30T09:00:00Z' }),
        makeConfirmation({ id: 'c-u', session_id: 's-u', session_title: 'Pushed' }),
      ],
      isLoading: false,
    };
    renderFeed();
    // Default view is the inbox: only the unreviewed confirmation shows,
    // and the Needs-review pill carries the pending count.
    expect(screen.getByText('Pushed')).toBeInTheDocument();
    expect(screen.queryByText('Pulled')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /needs review · 1/i })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^all$/i }));
    expect(screen.getByText('Pulled')).toBeInTheDocument();
    expect(screen.getByText('Pushed')).toBeInTheDocument();
  });

  // `?student=` is how the roster's "N to review" chip and the athlete page's
  // "Sessions" action arrive.
  describe('arriving for one athlete (?student=)', () => {
    it('opens on their history when nothing is left to review, not on an empty inbox', () => {
      mockConfirmations = {
        data: [
          makeConfirmation({ id: 'c-r', session_id: 's-r', session_title: 'Pulled', reviewed_at: '2026-04-30T09:00:00Z' }),
        ],
        isLoading: false,
      };
      renderFeed(['/coach/sessions?student=s-1']);
      expect(screen.getByText('Pulled')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^all$/i })).toHaveAttribute('aria-pressed', 'true');
    });

    // Every such arrival used to open on "All": the chip said "2 to review"
    // and the page answered with the athlete's whole history.
    it('opens on what there is to review when there is something', () => {
      mockConfirmations = {
        data: [
          makeConfirmation({ id: 'c-r', session_id: 's-r', session_title: 'Pulled', reviewed_at: '2026-04-30T09:00:00Z' }),
          makeConfirmation({ id: 'c-u', session_id: 's-u', session_title: 'Pushed' }),
          makeConfirmation({ id: 'c-b', session_id: 's-b', student_id: 's-2', student_name: 'Bob', session_title: 'Bob Pull' }),
        ],
        isLoading: false,
      };
      renderFeed(['/coach/sessions?student=s-1']);
      expect(screen.getByText('Pushed')).toBeInTheDocument();
      expect(screen.queryByText('Pulled')).not.toBeInTheDocument();
      expect(screen.queryByText('Bob Pull')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /needs review · 1/i })).toHaveAttribute('aria-pressed', 'true');
    });

    it('still lets the coach switch to the full history', async () => {
      const user = userEvent.setup();
      mockConfirmations = {
        data: [
          makeConfirmation({ id: 'c-r', session_id: 's-r', session_title: 'Pulled', reviewed_at: '2026-04-30T09:00:00Z' }),
          makeConfirmation({ id: 'c-u', session_id: 's-u', session_title: 'Pushed' }),
        ],
        isLoading: false,
      };
      renderFeed(['/coach/sessions?student=s-1']);
      await user.click(screen.getByRole('button', { name: /^all$/i }));
      expect(screen.getByText('Pulled')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /needs review/i }));
      expect(screen.queryByText('Pulled')).not.toBeInTheDocument();
    });

    // The default follows the data: the confirmations can arrive after the
    // first render (a cold load straight onto the link).
    it('decides once the confirmations have loaded', () => {
      mockConfirmations = { data: undefined, isLoading: true };
      const { rerender } = renderFeed(['/coach/sessions?student=s-1']);
      mockConfirmations = {
        data: [
          makeConfirmation({ id: 'c-r', session_id: 's-r', session_title: 'Pulled', reviewed_at: '2026-04-30T09:00:00Z' }),
          makeConfirmation({ id: 'c-u', session_id: 's-u', session_title: 'Pushed' }),
        ],
        isLoading: false,
      };
      rerender(
        <MemoryRouter initialEntries={['/coach/sessions?student=s-1']}>
          <SessionsFeed />
        </MemoryRouter>,
      );
      expect(screen.getByText('Pushed')).toBeInTheDocument();
      expect(screen.queryByText('Pulled')).not.toBeInTheDocument();
    });
  });

  it('shows an all-caught-up empty state when every confirmation is reviewed', () => {
    mockConfirmations = {
      data: [
        makeConfirmation({ id: 'c-r', session_id: 's-r', session_title: 'Pulled', reviewed_at: '2026-04-30T09:00:00Z' }),
      ],
      isLoading: false,
    };
    renderFeed();
    expect(screen.getByText(/all caught up/i)).toBeInTheDocument();
    expect(screen.queryByText('Pulled')).not.toBeInTheDocument();
  });

  it('shows a "Reviewed" pill on cards whose session has been reviewed', async () => {
    const user = userEvent.setup();
    mockConfirmations = {
      data: [
        makeConfirmation({ id: 'c-r', session_id: 's-r', student_name: 'Reviewed Rita', session_title: 'Pulled', reviewed_at: '2026-04-30T09:00:00Z' }),
        makeConfirmation({ id: 'c-u', session_id: 's-u', student_name: 'Unreviewed Una', session_title: 'Pushed' }),
      ],
      isLoading: false,
    };
    renderFeed();
    // Reviewed cards live behind the "All" filter.
    await user.click(screen.getByRole('button', { name: /^all$/i }));
    // One pill, on the reviewed card only.
    const pills = screen.getAllByText(/^Reviewed$/i);
    expect(pills).toHaveLength(1);
    // The pill is inside the same card link as the reviewed session.
    const reviewedCard = screen.getByText('Pulled').closest('a');
    expect(reviewedCard).toContainElement(pills[0]);
    const unreviewedCard = screen.getByText('Pushed').closest('a');
    expect(unreviewedCard).not.toContainElement(pills[0]);
  });

  // The restore half of the Sessions-tab persistence. SessionReview saves the
  // open review and its own tests cover that write; this feed is what bounces
  // the coach back into it on return, and that redirect had no coverage — a
  // break here would have looked exactly like "persistence stopped working".
  describe('restoring the last-open review', () => {
    const KEY = 'sl_last_coach_session';

    function ReviewStub() {
      const { studentId, sessionId } = useParams();
      const { state } = useLocation();
      return (
        <div data-testid="review" data-from={state?.from ?? ''}>
          {studentId}/{sessionId}
        </div>
      );
    }

    function renderWithReviewRoute(entries = ['/coach/sessions']) {
      return render(
        <MemoryRouter initialEntries={entries}>
          <Routes>
            <Route path="/coach/sessions" element={<SessionsFeed />} />
            <Route
              path="/coach/student/:studentId/session/:sessionId/review"
              element={<ReviewStub />}
            />
          </Routes>
        </MemoryRouter>,
      );
    }

    it('bounces into the saved review on mount', () => {
      localStorage.setItem(KEY, JSON.stringify({ studentId: 's-1', sessionId: 'sess-1' }));
      renderWithReviewRoute();
      expect(screen.getByTestId('review')).toHaveTextContent('s-1/sess-1');
    });

    it('stays on the feed when nothing was saved', () => {
      renderWithReviewRoute();
      expect(screen.queryByTestId('review')).not.toBeInTheDocument();
    });

    // A link that names an athlete names its destination. Bouncing into the
    // review that happened to be left open — another athlete's, possibly —
    // would make "2 to review" land anywhere but on those two sessions.
    it('does not bounce when the coach arrives for one athlete', () => {
      localStorage.setItem(KEY, JSON.stringify({ studentId: 's-9', sessionId: 'sess-9' }));
      mockConfirmations = { data: [makeConfirmation()], isLoading: false };
      renderWithReviewRoute(['/coach/sessions?student=s-1']);
      expect(screen.queryByTestId('review')).not.toBeInTheDocument();
      expect(screen.getByText('Push Day')).toBeInTheDocument();
    });

    // The review's back button returns to the page that opened it. For the
    // feed that includes the athlete filter, which a `?student=` arrival does
    // not store anywhere else.
    it('tells the review to come back to this feed, filter included', async () => {
      const user = userEvent.setup();
      mockConfirmations = { data: [makeConfirmation()], isLoading: false };
      renderWithReviewRoute(['/coach/sessions?student=s-1']);
      await user.click(screen.getByText('Push Day'));
      expect(screen.getByTestId('review')).toHaveTextContent('s-1/sess-1');
      expect(screen.getByTestId('review')).toHaveAttribute('data-from', '/coach/sessions?student=s-1');
    });

    it.each([
      ['malformed JSON', '{ not json'],
      ['a missing sessionId', JSON.stringify({ studentId: 's-1' })],
      ['a missing studentId', JSON.stringify({ sessionId: 'sess-1' })],
    ])('stays on the feed on %s', (_label, raw) => {
      localStorage.setItem(KEY, raw);
      renderWithReviewRoute();
      expect(screen.queryByTestId('review')).not.toBeInTheDocument();
    });
  });
});
