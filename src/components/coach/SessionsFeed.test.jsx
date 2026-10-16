import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation, useParams } from 'react-router-dom';

// The feed's reads, stubbed over one list: `mockDb` is every confirmation of
// the coach as the feed renders it, and each hook answers what its query
// would on those rows — the inbox (neither reviewed nor archived), the two
// numbers, a page of the history. `mockInbox` / `mockTotals` / `mockHistory`
// replace one answer for a test about that read.
let mockDb = [];
let mockInbox = null;
let mockTotals = null;
let mockHistory = null;
let mockPositions = { data: undefined };
let mockStudents = { data: [] };
const historyCalls = [];
const fetchNextPage = vi.fn();

function readOf(data) {
  return {
    data,
    isLoading: false,
    isSuccess: true,
    isError: false,
    isPaused: false,
    fetchStatus: 'idle',
    isFetching: false,
    refetch: vi.fn(),
  };
}
const loadingRead = () => ({
  data: undefined,
  isLoading: true,
  isSuccess: false,
  isError: false,
  isPaused: false,
  fetchStatus: 'fetching',
  isFetching: true,
  refetch: vi.fn(),
});
const failedRead = () => ({
  data: undefined,
  isLoading: false,
  isSuccess: false,
  isError: true,
  isPaused: false,
  fetchStatus: 'idle',
  isFetching: false,
  refetch: vi.fn(),
});
const ofStudent = (studentId) => (c) => !studentId || c.student_id === studentId;

function inboxRead() {
  return mockInbox ?? readOf(mockDb.filter((c) => !c.reviewed_at && !c.archived_at));
}
function totalsRead(studentId) {
  if (mockTotals) return mockTotals;
  const rows = mockDb.filter(ofStudent(studentId));
  return {
    ...readOf({ active: rows.filter((c) => !c.archived_at).length, archived: rows.filter((c) => c.archived_at).length }),
    isPlaceholderData: false,
  };
}
function historyRead({ studentId = null, archived = false, enabled = true } = {}) {
  historyCalls.push({ studentId: studentId || null, archived, enabled });
  if (!enabled) return { ...loadingRead(), isLoading: false, fetchStatus: 'idle', isFetching: false };
  if (mockHistory) return mockHistory;
  return {
    ...readOf(mockDb.filter(ofStudent(studentId)).filter((c) => !!c.archived_at === archived)),
    hasNextPage: false,
    isFetchingNextPage: false,
    isFetchNextPageError: false,
    fetchNextPage,
  };
}

vi.mock('../../hooks/useSessionConfirmation', () => ({
  useReviewInbox: () => inboxRead(),
  useConfirmationTotals: (studentId) => totalsRead(studentId),
  useConfirmationHistory: (options) => historyRead(options),
}));

vi.mock('../../hooks/useProgram', () => ({
  useCoachSessionPositions: () => mockPositions,
}));

vi.mock('../../hooks/useStudents', () => ({
  useStudents: () => mockStudents,
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

const student = (id, name) => ({ id, profile_id: `p-${id}`, created_at: null, profile: { full_name: name } });

describe('SessionsFeed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = [];
    mockInbox = null;
    mockTotals = null;
    mockHistory = null;
    historyCalls.length = 0;
    mockPositions = { data: undefined };
    mockStudents = { data: [student('s-1', 'Alice'), student('s-2', 'Bob')] };
    localStorage.clear();
    sessionStorage.clear();
  });

  it('renders loading spinner', () => {
    mockInbox = loadingRead();
    renderFeed();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('renders empty state when no confirmations', () => {
    renderFeed();
    expect(screen.getByText(/no confirmed sessions yet/i)).toBeInTheDocument();
  });

  it('renders a confirmation card with student name and session title', () => {
    mockDb = [makeConfirmation()];
    renderFeed();
    expect(screen.getAllByText('Alice').length).toBeGreaterThan(0);
    expect(screen.getByText('Push Day')).toBeInTheDocument();
  });

  it('shows archived toggle button when archived sessions exist', async () => {
    const user = userEvent.setup();
    mockDb = [
        makeConfirmation({ id: 'c-1', archived_at: '2026-04-16T12:00:00Z', session_title: 'Archived Session' }),
      ];
    renderFeed();
    expect(screen.getByRole('button', { name: /show.*archived/i })).toBeInTheDocument();
    expect(screen.queryByText('Archived Session')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /show.*archived/i }));
    expect(screen.getByText('Archived Session')).toBeInTheDocument();
  });

  it('filters cards by selected student', async () => {
    const user = userEvent.setup();
    mockDb = [
        makeConfirmation({ id: 'c-1', session_id: 's-a', student_id: 's-1', student_name: 'Alice', session_title: 'Alice Push' }),
        makeConfirmation({ id: 'c-2', session_id: 's-b', student_id: 's-2', student_name: 'Bob', session_title: 'Bob Pull' }),
      ];
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
      mockDb = [makeConfirmation({ week_number: 3, day_number: 2, week_label: 'Volume' })];
      mockPositions = { data: { 'sess-1': { n: 2, total: 9 } } };
      renderFeed();
      expect(within(card()).getByText('Volume · Session 2/9')).toBeInTheDocument();
      expect(card().textContent).not.toMatch(/W3|D2/);
    });

    it('says nothing about a phase without a name and a session without a day', () => {
      mockDb = [makeConfirmation({ week_number: 3, day_number: null, week_label: null })];
      mockPositions = { data: { 'sess-1': { n: 4, total: 12 } } };
      renderFeed();
      expect(within(card()).getByText('Session 4/12')).toBeInTheDocument();
      expect(card().textContent).not.toMatch(/W3|· D|null/);
    });

    it('names the phase alone while the places are not known', () => {
      mockDb = [makeConfirmation({ week_number: 1, day_number: 2, week_label: 'Volume' })];
      renderFeed();
      expect(within(card()).getByText('Volume')).toBeInTheDocument();
      expect(card().textContent).not.toMatch(/Session \d|W1|D2/);
    });

    it('draws no empty line when there is nothing to say', () => {
      mockDb = [makeConfirmation({ week_number: 1, day_number: null, week_label: null })];
      renderFeed();
      expect(card().querySelectorAll('p')).toHaveLength(0);
    });

    // Review item B28: sessions are born untitled now, and the fallback was
    // the day number — "Session null" for a session without a day.
    it('names an untitled session by its place in the block', () => {
      mockDb = [makeConfirmation({ session_title: null, day_number: null, week_label: 'Volume' })];
      mockPositions = { data: { 'sess-1': { n: 2, total: 9 } } };
      renderFeed();
      expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent(/^Session 2$/);
      expect(screen.queryByText(/null/)).toBeNull();
    });

    it('names an untitled session "Session" while its place is not known', () => {
      mockDb = [makeConfirmation({ session_title: null, day_number: null })];
      renderFeed();
      expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent(/^Session$/);
      expect(screen.queryByText(/null/)).toBeNull();
    });

    // The confirmation of a workout logged offline reaches the server when
    // the queue is replayed, days later sometimes.
    it('dates the card with the day the athlete trained, in the app’s language', () => {
      mockDb = [makeConfirmation({ performed_on: '2026-04-12', confirmed_at: '2026-04-16T10:00:00Z' })];
      renderFeed();
      expect(within(card()).getByText('Apr 12, 2026')).toBeInTheDocument();
      expect(card().textContent).not.toMatch(/Apr 16|4\/16\/2026/);
    });

    it('falls back to the day of the confirmation for a row without a training date', () => {
      mockDb = [makeConfirmation({ performed_on: null })];
      renderFeed();
      expect(within(card()).getByText('Apr 16, 2026')).toBeInTheDocument();
    });
  });

  it('displays student notes on the card', () => {
    mockDb = [makeConfirmation({ notes: 'Felt really strong today' })];
    renderFeed();
    expect(screen.getByText('Felt really strong today')).toBeInTheDocument();
  });

  it('defaults to the needs-review inbox: reviewed cards are hidden until "All"', async () => {
    const user = userEvent.setup();
    mockDb = [
        makeConfirmation({ id: 'c-r', session_id: 's-r', session_title: 'Pulled', reviewed_at: '2026-04-30T09:00:00Z' }),
        makeConfirmation({ id: 'c-u', session_id: 's-u', session_title: 'Pushed' }),
      ];
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
      mockDb = [
          makeConfirmation({ id: 'c-r', session_id: 's-r', session_title: 'Pulled', reviewed_at: '2026-04-30T09:00:00Z' }),
        ];
      renderFeed(['/coach/sessions?student=s-1']);
      expect(screen.getByText('Pulled')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^all$/i })).toHaveAttribute('aria-pressed', 'true');
    });

    // Every such arrival used to open on "All": the chip said "2 to review"
    // and the page answered with the athlete's whole history.
    it('opens on what there is to review when there is something', () => {
      mockDb = [
          makeConfirmation({ id: 'c-r', session_id: 's-r', session_title: 'Pulled', reviewed_at: '2026-04-30T09:00:00Z' }),
          makeConfirmation({ id: 'c-u', session_id: 's-u', session_title: 'Pushed' }),
          makeConfirmation({ id: 'c-b', session_id: 's-b', student_id: 's-2', student_name: 'Bob', session_title: 'Bob Pull' }),
        ];
      renderFeed(['/coach/sessions?student=s-1']);
      expect(screen.getByText('Pushed')).toBeInTheDocument();
      expect(screen.queryByText('Pulled')).not.toBeInTheDocument();
      expect(screen.queryByText('Bob Pull')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /needs review · 1/i })).toHaveAttribute('aria-pressed', 'true');
    });

    it('still lets the coach switch to the full history', async () => {
      const user = userEvent.setup();
      mockDb = [
          makeConfirmation({ id: 'c-r', session_id: 's-r', session_title: 'Pulled', reviewed_at: '2026-04-30T09:00:00Z' }),
          makeConfirmation({ id: 'c-u', session_id: 's-u', session_title: 'Pushed' }),
        ];
      renderFeed(['/coach/sessions?student=s-1']);
      await user.click(screen.getByRole('button', { name: /^all$/i }));
      expect(screen.getByText('Pulled')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /needs review/i }));
      expect(screen.queryByText('Pulled')).not.toBeInTheDocument();
    });

    // The default follows the data: the confirmations can arrive after the
    // first render (a cold load straight onto the link).
    it('decides once the confirmations have loaded', () => {
      mockInbox = loadingRead();
      const { rerender } = renderFeed(['/coach/sessions?student=s-1']);
      mockInbox = null;
      mockDb = [
          makeConfirmation({ id: 'c-r', session_id: 's-r', session_title: 'Pulled', reviewed_at: '2026-04-30T09:00:00Z' }),
          makeConfirmation({ id: 'c-u', session_id: 's-u', session_title: 'Pushed' }),
        ];
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
    mockDb = [
        makeConfirmation({ id: 'c-r', session_id: 's-r', session_title: 'Pulled', reviewed_at: '2026-04-30T09:00:00Z' }),
      ];
    renderFeed();
    expect(screen.getByText(/all caught up/i)).toBeInTheDocument();
    expect(screen.queryByText('Pulled')).not.toBeInTheDocument();
  });

  it('shows a "Reviewed" pill on cards whose session has been reviewed', async () => {
    const user = userEvent.setup();
    mockDb = [
        makeConfirmation({ id: 'c-r', session_id: 's-r', student_name: 'Reviewed Rita', session_title: 'Pulled', reviewed_at: '2026-04-30T09:00:00Z' }),
        makeConfirmation({ id: 'c-u', session_id: 's-u', student_name: 'Unreviewed Una', session_title: 'Pushed' }),
      ];
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

  // Review item L18: the feed read every confirmation of every athlete in one
  // request — the archived ones with the drawer closed — and PostgREST stops
  // at a thousand rows without a word.
  describe('reading only what it shows', () => {
    const reviewed = (n, overrides = {}) =>
      makeConfirmation({ id: `c-r${n}`, session_id: `s-r${n}`, session_title: `Reviewed ${n}`, reviewed_at: '2026-04-30T09:00:00Z', ...overrides });

    it('opens on the inbox, and reads the history only once "All" is open', async () => {
      const user = userEvent.setup();
      mockDb = [makeConfirmation({ session_title: 'Pushed' }), reviewed(1)];
      renderFeed();
      expect(historyCalls.every((c) => !c.enabled)).toBe(true);

      await user.click(screen.getByRole('button', { name: /^all$/i }));
      expect(historyCalls.at(-2)).toEqual({ studentId: null, archived: false, enabled: true });
      expect(screen.getByText('Reviewed 1')).toBeInTheDocument();
    });

    it('reads the archived sessions only when the drawer is opened, and counts them without reading them', async () => {
      const user = userEvent.setup();
      mockDb = [makeConfirmation({ session_title: 'Pushed' })];
      mockTotals = { ...readOf({ active: 1, archived: 12 }), isPlaceholderData: false };
      mockHistory = {
        ...readOf([makeConfirmation({ id: 'c-a', session_id: 's-a', session_title: 'Old one', archived_at: '2026-04-20T00:00:00Z' })]),
        hasNextPage: true,
        isFetchingNextPage: false,
        isFetchNextPageError: false,
        fetchNextPage,
      };
      renderFeed();
      expect(historyCalls.filter((c) => c.archived).every((c) => !c.enabled)).toBe(true);
      expect(screen.queryByText('Old one')).toBeNull();

      await user.click(screen.getByRole('button', { name: 'Show 12 archived' }));
      expect(historyCalls.filter((c) => c.archived).at(-1)).toEqual({ studentId: null, archived: true, enabled: true });
      expect(screen.getByText('Old one')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Hide 12 archived' })).toBeInTheDocument();
    });

    it('reads the next page when the coach asks for more', async () => {
      const user = userEvent.setup();
      mockDb = [reviewed(1)];
      mockHistory = {
        ...readOf([reviewed(1)]),
        hasNextPage: true,
        isFetchingNextPage: false,
        isFetchNextPageError: false,
        fetchNextPage,
      };
      renderFeed(['/coach/sessions?student=s-1']);
      const more = screen.getByRole('button', { name: 'Show more' });
      expect(more.className).toContain('sl-pill-btn');
      await user.click(more);
      expect(fetchNextPage).toHaveBeenCalledTimes(1);
    });

    it('says the next page is on its way, and when it could not be read', () => {
      mockDb = [reviewed(1)];
      mockHistory = {
        ...readOf([reviewed(1)]),
        hasNextPage: true,
        isFetchingNextPage: true,
        isFetchNextPageError: false,
        fetchNextPage,
      };
      const { unmount } = renderFeed(['/coach/sessions?student=s-1']);
      expect(screen.getByRole('button', { name: 'Loading…' })).toBeDisabled();
      unmount();

      mockHistory = { ...mockHistory, isFetchingNextPage: false, isFetchNextPageError: true };
      renderFeed(['/coach/sessions?student=s-1']);
      expect(screen.getByText('The next sessions couldn’t be loaded.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Show more' })).toBeEnabled();
      // What was read stays.
      expect(screen.getByText('Reviewed 1')).toBeInTheDocument();
    });

    it('draws no button once the last page is read', () => {
      mockDb = [reviewed(1)];
      renderFeed(['/coach/sessions?student=s-1']);
      expect(screen.getByText('Reviewed 1')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
    });

    it('reads the history of the athlete it is filtered on', () => {
      mockDb = [reviewed(1), reviewed(2, { student_id: 's-2', student_name: 'Bob' })];
      renderFeed(['/coach/sessions?student=s-2']);
      expect(historyCalls.at(-2)).toEqual({ studentId: 's-2', archived: false, enabled: true });
      expect(screen.getByText('Reviewed 2')).toBeInTheDocument();
      expect(screen.queryByText('Reviewed 1')).toBeNull();
    });

    // The athletes of the filter used to be the ones whose confirmations had
    // been read: an athlete whose sessions were all older than the thousand
    // newest could not be picked.
    it('offers every athlete of the coach in the filter, by their students.id', () => {
      mockDb = [makeConfirmation({ student_id: 's-1', student_name: 'Alice' })];
      mockStudents = { data: [student('s-1', 'Alice'), student('s-2', 'Bob'), student('s-3', 'Cy')] };
      renderFeed();
      const options = within(screen.getByRole('combobox')).getAllByRole('option');
      expect(options.map((o) => [o.value, o.textContent])).toEqual([
        ['', 'All students'],
        ['s-1', 'Alice'],
        ['s-2', 'Bob'],
        ['s-3', 'Cy'],
      ]);
    });

    it('says the sessions could not be loaded, and claims nothing about them', async () => {
      const user = userEvent.setup();
      mockInbox = failedRead();
      renderFeed();
      expect(screen.getByText('This couldn’t be loaded')).toBeInTheDocument();
      expect(screen.queryByText(/all caught up/i)).toBeNull();
      expect(screen.queryByText(/no confirmed sessions yet/i)).toBeNull();
      await user.click(screen.getByRole('button', { name: 'Try again' }));
      expect(mockInbox.refetch).toHaveBeenCalledWith({ cancelRefetch: false });
    });

    it('claims no empty feed while the numbers are not known', () => {
      mockTotals = { ...failedRead(), isPlaceholderData: false };
      renderFeed();
      expect(screen.queryByText(/no confirmed sessions yet/i)).toBeNull();
      // The inbox is known: nothing waits for a review.
      expect(screen.getByText(/all caught up/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /^all$/i })).toBeInTheDocument();
    });

    it('treats the numbers of the athlete it was filtered on before as unknown', () => {
      mockTotals = { ...readOf({ active: 0, archived: 4 }), isPlaceholderData: true };
      renderFeed(['/coach/sessions?student=s-2']);
      expect(screen.queryByRole('button', { name: /show 4 archived/i })).toBeNull();
      expect(screen.queryByText(/all confirmed sessions are archived/i)).toBeNull();
    });
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
      sessionStorage.setItem(KEY, JSON.stringify({ studentId: 's-1', sessionId: 'sess-1' }));
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
      sessionStorage.setItem(KEY, JSON.stringify({ studentId: 's-9', sessionId: 'sess-9' }));
      mockDb = [makeConfirmation()];
      renderWithReviewRoute(['/coach/sessions?student=s-1']);
      expect(screen.queryByTestId('review')).not.toBeInTheDocument();
      expect(screen.getByText('Push Day')).toBeInTheDocument();
    });

    // The review's back button returns to the page that opened it. For the
    // feed that includes the athlete filter, which a `?student=` arrival does
    // not store anywhere else.
    it('tells the review to come back to this feed, filter included', async () => {
      const user = userEvent.setup();
      mockDb = [makeConfirmation()];
      renderWithReviewRoute(['/coach/sessions?student=s-1']);
      await user.click(screen.getByText('Push Day'));
      expect(screen.getByTestId('review')).toHaveTextContent('s-1/sess-1');
      expect(screen.getByTestId('review')).toHaveAttribute('data-from', '/coach/sessions?student=s-1');
    });

    it.each([
      ['malformed JSON', '{ not json'],
      ['a missing sessionId', JSON.stringify({ studentId: 's-1' })],
      ['a missing studentId', JSON.stringify({ sessionId: 'sess-1' })],
      ['ids that are not strings', JSON.stringify({ studentId: 1, sessionId: 2 })],
    ])('stays on the feed on %s', (_label, raw) => {
      sessionStorage.setItem(KEY, raw);
      renderWithReviewRoute();
      expect(screen.queryByTestId('review')).not.toBeInTheDocument();
    });

    // Review item L13: the review left open was where the Sessions tab opened
    // on every launch, days later. It is kept for the launch only.
    it('bounces within the launch, and not after a relaunch', () => {
      sessionStorage.setItem(KEY, JSON.stringify({ studentId: 's-1', sessionId: 'sess-1' }));
      const first = renderWithReviewRoute();
      expect(screen.getByTestId('review')).toHaveTextContent('s-1/sess-1');
      first.unmount();
      // What a cold start of the app does: the tab's sessionStorage is new.
      sessionStorage.clear();

      renderWithReviewRoute();
      expect(screen.queryByTestId('review')).not.toBeInTheDocument();
    });

    it('ignores a review an earlier version saved in localStorage', () => {
      localStorage.setItem(KEY, JSON.stringify({ studentId: 's-1', sessionId: 'sess-1' }));
      renderWithReviewRoute();
      expect(screen.queryByTestId('review')).not.toBeInTheDocument();
    });
  });

  // The athlete the coach filtered the feed on comes back with the feed, for
  // the launch only.
  describe('restoring the athlete filter', () => {
    const FILTER_KEY = 'sl_last_coach_sessions_student';

    beforeEach(() => {
      mockDb = [
          makeConfirmation({ id: 'c-1', session_id: 's-a', student_id: 's-1', student_name: 'Alice', session_title: 'Alice Push' }),
          makeConfirmation({ id: 'c-2', session_id: 's-b', student_id: 's-2', student_name: 'Bob', session_title: 'Bob Pull' }),
        ];
    });

    it('keeps the athlete picked for the rest of the launch', async () => {
      const user = userEvent.setup();
      const first = renderFeed();
      await user.selectOptions(screen.getByRole('combobox'), 's-2');
      expect(sessionStorage.getItem(FILTER_KEY)).toBe('s-2');
      expect(localStorage.getItem(FILTER_KEY)).toBeNull();
      first.unmount();

      renderFeed();
      expect(screen.getByRole('combobox')).toHaveValue('s-2');
      expect(screen.queryByText('Alice Push')).not.toBeInTheDocument();
      expect(screen.getByText('Bob Pull')).toBeInTheDocument();
    });

    it('forgets it when the coach picks every athlete again', async () => {
      const user = userEvent.setup();
      sessionStorage.setItem(FILTER_KEY, 's-2');
      renderFeed();
      await user.selectOptions(screen.getByRole('combobox'), '');
      expect(sessionStorage.getItem(FILTER_KEY)).toBeNull();
    });

    it('opens unfiltered after a relaunch', async () => {
      const user = userEvent.setup();
      const first = renderFeed();
      await user.selectOptions(screen.getByRole('combobox'), 's-2');
      first.unmount();
      sessionStorage.clear();

      renderFeed();
      expect(screen.getByRole('combobox')).toHaveValue('');
      expect(screen.getByText('Alice Push')).toBeInTheDocument();
      expect(screen.getByText('Bob Pull')).toBeInTheDocument();
    });

    it('ignores a filter an earlier version saved in localStorage', () => {
      localStorage.setItem(FILTER_KEY, 's-2');
      renderFeed();
      expect(screen.getByRole('combobox')).toHaveValue('');
    });
  });
});
