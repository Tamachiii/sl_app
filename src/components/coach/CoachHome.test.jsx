import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Navigate, useLocation, useOutletContext } from 'react-router-dom';

let mockStudentsData = { data: null, isLoading: false };
let mockSummary = { data: {} };
let mockReviewCounts = { data: {} };
let mockClientErrors = { data: [] };

vi.mock('../../hooks/useStudents', () => ({
  useStudents: () => mockStudentsData,
}));

vi.mock('../../hooks/useProgram', () => ({
  useCoachDashboardPrograms: () => mockSummary,
}));

// Read by the rows' "to review" and by the title's count of sessions to
// review (hooks/useToReviewCount sums it), so the two cannot disagree.
vi.mock('../../hooks/useSessionConfirmation', () => ({
  useReviewCounts: () => mockReviewCounts,
}));

vi.mock('../../hooks/useClientErrors', () => ({
  useClientErrors: () => mockClientErrors,
}));

// Inline stubs that read the outlet context the same way the real sections do
// — verifies the layout's <Outlet context> wiring without pulling in their
// data hooks.
function OverviewStub() {
  const { student } = useOutletContext();
  return <div data-testid="overview">overview:{student.id}</div>;
}
function SessionStub() {
  const { student } = useOutletContext();
  return <div data-testid="session-editor">session:{student.id}</div>;
}

// Where the router is, search included.
function LocationProbe() {
  const { pathname, search } = useLocation();
  return <div data-testid="location">{pathname + search}</div>;
}

import CoachHome from './CoachHome';

// Mirrors the real route tree: the athlete is ONE page, with every surface that
// used to be a tab redirecting back to it.
function renderCoachHome(path = '/coach/students') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <LocationProbe />
      <Routes>
        <Route path="/coach/students" element={<CoachHome />} />
        <Route path="/coach/students/:studentId" element={<CoachHome />}>
          <Route index element={<OverviewStub />} />
          <Route path="s/:sessionId" element={<SessionStub />} />
          <Route path="programming" element={<Navigate to=".." replace relative="path" />} />
          <Route path="progress" element={<Navigate to=".." replace relative="path" />} />
          <Route path="profile" element={<Navigate to=".." replace relative="path" />} />
          <Route path="goals" element={<Navigate to=".." replace relative="path" />} />
          <Route path="stats" element={<Navigate to=".." replace relative="path" />} />
          <Route path="messaging" element={<Navigate to=".." replace relative="path" />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

// The rows' own links — the athlete's name, stretched over the row — in the
// order they are drawn. The "to review" links lead to the feed instead.
const cardLinks = () =>
  screen.queryAllByRole('link').filter((a) => /^\/coach\/students\/[^/?]+$/.test(a.getAttribute('href')));
const cardNames = () => cardLinks().map((a) => a.textContent);
// The row of one athlete.
const rowOf = (name) => screen.getByRole('link', { name }).closest('li');

// weekDays that carry no today/upcoming status regardless of the real clock
// (performed = trained, rest = nothing), so ordering assertions stay
// deterministic on any day the suite runs.
const CALM_WEEK = [
  { dayNumber: 1, session: { id: 'a' }, state: 'performed' },
  { dayNumber: 2, session: null, state: 'rest' },
  { dayNumber: 3, session: null, state: 'rest' },
  { dayNumber: 4, session: null, state: 'rest' },
  { dayNumber: 5, session: null, state: 'rest' },
  { dayNumber: 6, session: null, state: 'rest' },
  { dayNumber: 7, session: null, state: 'rest' },
];

describe('CoachHome', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    mockStudentsData = { data: null, isLoading: false };
    mockSummary = { data: {} };
    mockReviewCounts = { data: {} };
    mockClientErrors = { data: [] };
  });

  it('renders loading spinner', () => {
    mockStudentsData = { data: undefined, isLoading: true };
    renderCoachHome();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('renders empty state when no students', () => {
    mockStudentsData = { data: [], isLoading: false };
    renderCoachHome();
    expect(screen.getByText(/no athlete yet/i)).toBeInTheDocument();
    expect(screen.queryByRole('searchbox')).toBeNull();
  });

  it('renders the page title', () => {
    mockStudentsData = { data: [], isLoading: false };
    renderCoachHome();
    expect(screen.getByRole('heading', { level: 1, name: 'Athletes' })).toBeInTheDocument();
  });

  // Moving between the roster and an athlete changes the words of the title,
  // not its type: both are the one h1 of a Parc LargeTitle.
  it('draws the roster and the athlete with the same title', () => {
    mockStudentsData = {
      data: [{ id: 's-1', profile_id: 'p-1', created_at: null, profile: { full_name: 'Alice' } }],
      isLoading: false,
    };

    renderCoachHome('/coach/students');
    const rosterH1 = screen.getByRole('heading', { level: 1, name: 'Athletes' });

    renderCoachHome('/coach/students/s-1');
    const athleteH1 = screen.getByRole('heading', { level: 1, name: 'Alice' });

    expect(athleteH1.className).toBe(rosterH1.className);
  });

  describe('roster landing', () => {
    beforeEach(() => {
      mockStudentsData = {
        data: [
          { id: 's1', profile: { full_name: 'Alice' } }, // calm
          { id: 's2', profile: { full_name: 'Bob' } }, // no program
          { id: 's3', profile: { full_name: 'Cara' } }, // 2 to review
        ],
        isLoading: false,
      };
      mockSummary = {
        data: {
          s1: { programName: 'Hyp', position: 7, totalSessions: 24, weekDays: CALM_WEEK },
          s3: { programName: 'Str', position: 1, totalSessions: 12, weekDays: CALM_WEEK },
          // s2 absent → no active program.
        },
      };
      // What useReviewCounts holds: sessions to review per `students.id`.
      mockReviewCounts = { data: { s3: 2 } };
    });

    it('renders a card link per athlete', () => {
      renderCoachHome();
      expect(screen.getByRole('link', { name: 'Alice' })).toHaveAttribute('href', '/coach/students/s1');
      expect(screen.getByRole('link', { name: 'Bob' })).toHaveAttribute('href', '/coach/students/s2');
      expect(screen.getByRole('link', { name: 'Cara' })).toHaveAttribute('href', '/coach/students/s3');
    });

    it('says how many athletes and how many sessions wait for a review, under the title', () => {
      renderCoachHome();
      expect(screen.getByText('3 athletes, 2 sessions to review')).toBeInTheDocument();
    });

    it('surfaces attention chips', () => {
      renderCoachHome();
      expect(screen.getByText(/no program/i)).toBeInTheDocument();
      expect(screen.getByText(/2 to review/i)).toBeInTheDocument();
    });

    it('says how long an athlete has been quiet', () => {
      mockSummary.data.s1 = { ...mockSummary.data.s1, daysSinceLast: 12 };
      renderCoachHome();
      expect(within(rowOf('Alice')).getByText('Quiet 12 d')).toBeInTheDocument();
      expect(within(screen.getByRole('region', { name: 'To follow' })).getByRole('link', { name: 'Alice' }))
        .toBeInTheDocument();
    });

    // design/parc/components/StatusText: one status per athlete, the most
    // urgent — no program before sessions to review before silence.
    it('writes one status per athlete, the most urgent', () => {
      mockSummary.data.s3 = { ...mockSummary.data.s3, daysSinceLast: 12 };
      mockReviewCounts = { data: { s2: 1, s3: 2 } };
      renderCoachHome();

      expect(within(rowOf('Bob')).getByText('No program')).toBeInTheDocument();
      expect(within(rowOf('Bob')).queryByText(/to review/i)).toBeNull();
      expect(within(rowOf('Cara')).getByText('2 to review')).toBeInTheDocument();
      expect(within(rowOf('Cara')).queryByText(/quiet/i)).toBeNull();
    });

    it('says where the athlete is in the block', () => {
      renderCoachHome();
      expect(within(rowOf('Alice')).getByText('Session 7 of 24, Hyp')).toBeInTheDocument();
      // No program, no place in one.
      expect(within(rowOf('Bob')).queryByText(/^session /i)).toBeNull();
    });

    // Review finding P12: the chip sat inside a card that opened the athlete
    // page, where nothing could be reviewed. It opens what it counts.
    it('links the "to review" chip to that athlete\'s sessions in the feed', () => {
      renderCoachHome();
      const chip = screen.getByRole('link', { name: /to review/i });
      expect(chip).toHaveAttribute('href', '/coach/sessions?student=s3');
      expect(chip).toHaveAccessibleName(/cara/i);
      expect(chip).toHaveTextContent(/^2 to review$/i);
    });

    // An anchor inside an anchor is invalid HTML, and browsers split it in
    // ways that differ. The row's link is stretched over the row instead of
    // wrapped around it.
    it('keeps the chip out of the card link, and the card one link', () => {
      renderCoachHome();
      const card = screen.getByRole('link', { name: 'Cara' });
      const chip = screen.getByRole('link', { name: /to review/i });
      expect(card).not.toContainElement(chip);
      expect(card).toHaveAttribute('href', '/coach/students/s3');
      expect(card.className).toContain('after:absolute');
      expect(card.className).toContain('after:inset-0');
      // Raised above the stretched area, or the tap would open the athlete.
      expect(chip.className).toContain('z-10');
      expect(document.querySelector('a a')).toBeNull();
    });

    it('leaves the other chips as plain labels', () => {
      renderCoachHome();
      expect(screen.getByText(/no program/i).closest('a')).toBeNull();
      // One card link per athlete, plus the one chip.
      expect(screen.getAllByRole('link')).toHaveLength(4);
    });

    it('orders attention-first (no-program, then to-review, then calm)', () => {
      renderCoachHome();
      expect(cardNames()).toEqual(['Bob', 'Cara', 'Alice']);
    });

    // design/parc/README.md: « À suivre » before « À jour », each in the order
    // buildRoster gives.
    it('puts the athletes who need a look under "To follow", the others under "Up to date"', () => {
      renderCoachHome();
      const toFollow = screen.getByRole('region', { name: 'To follow' });
      const upToDate = screen.getByRole('region', { name: 'Up to date' });

      expect(within(toFollow).getAllByRole('link', { name: /^(bob|cara)$/i }).map((a) => a.textContent))
        .toEqual(['Bob', 'Cara']);
      expect(within(toFollow).getByText('2 athletes')).toBeInTheDocument();
      expect(within(upToDate).getByRole('link', { name: 'Alice' })).toBeInTheDocument();
      expect(within(upToDate).getByText('1 athlete')).toBeInTheDocument();
      expect(toFollow.compareDocumentPosition(upToDate) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('draws no "Up to date" group when every athlete needs a look', () => {
      mockSummary.data.s1 = { ...mockSummary.data.s1, daysSinceLast: 12 };
      renderCoachHome();
      expect(screen.queryByRole('region', { name: 'Up to date' })).toBeNull();
      expect(cardNames()).toEqual(['Bob', 'Cara', 'Alice']);
    });

    it('filters the list by the search box', () => {
      renderCoachHome();
      fireEvent.change(screen.getByRole('searchbox', { name: 'Search an athlete' }), { target: { value: 'ali' } });
      expect(screen.getByRole('link', { name: 'Alice' })).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Bob' })).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Cara' })).not.toBeInTheDocument();
    });

    it('finds an athlete by the name of their block too, and says when nobody matches', () => {
      renderCoachHome();
      fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'str' } });
      expect(cardNames()).toEqual(['Cara']);

      fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zzz' } });
      expect(cardNames()).toEqual([]);
      expect(screen.getByText(/no athlete matches/i)).toBeInTheDocument();
    });

    // The app's errors are a closed row at the end of the roster, opened to
    // read them.
    it('shows the app-errors triage when there are errors', () => {
      mockClientErrors = { data: [{ id: 'e1', role: 'student', message: 'boom', url: '/x', created_at: '2026-01-01' }] };
      renderCoachHome();

      const triage = screen.getByRole('region', { name: /app errors/i });
      const toggle = within(triage).getByRole('button', { name: '1 error' });
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByText('boom')).toBeNull();
      expect(
        screen.getByRole('region', { name: 'Up to date' }).compareDocumentPosition(triage)
          & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();

      fireEvent.click(toggle);
      expect(toggle).toHaveAttribute('aria-expanded', 'true');
      expect(within(triage).getByText('boom')).toBeInTheDocument();
      expect(within(triage).getByText('/x')).toBeInTheDocument();
    });

    it('shows no app-errors triage without errors', () => {
      renderCoachHome();
      expect(screen.queryByRole('region', { name: /app errors/i })).toBeNull();
    });

    // Review items P48, N16: the cards read only `data` of the two reads, and
    // a summary that had not arrived — or was answered by a 500 — was "nobody
    // has a program": a red chip on every athlete, all sorted to the top, and
    // re-sorted when the answer landed.
    describe('while the athletes’ status is not known', () => {
      const refetchSummary = vi.fn();
      const refetchCounts = vi.fn();
      const loadingRead = (refetch) => ({
        data: undefined, isLoading: true, isError: false, isPaused: false, fetchStatus: 'fetching', isFetching: true, refetch,
      });
      const failedRead = (refetch) => ({
        data: undefined, isLoading: false, isError: true, isPaused: false, fetchStatus: 'idle', isFetching: false, refetch,
      });
      const pausedRead = (refetch) => ({
        data: undefined, isLoading: true, isError: false, isPaused: true, fetchStatus: 'paused', isFetching: false, refetch,
      });

      beforeEach(() => {
        refetchSummary.mockReset();
        refetchCounts.mockReset();
      });

      it('draws one placeholder per athlete while the reads are on their way, and nothing to tap', () => {
        mockSummary = loadingRead(refetchSummary);
        mockReviewCounts = loadingRead(refetchCounts);
        renderCoachHome();

        const placeholder = screen.getByRole('status', { name: /loading your athletes/i });
        expect(placeholder).toHaveAttribute('aria-busy', 'true');
        expect(placeholder.querySelectorAll('li')).toHaveLength(3);
        expect(placeholder.querySelector('a, button, input')).toBeNull();
        expect(screen.queryByText(/no program/i)).toBeNull();
        expect(screen.queryByText(/^\d+ to review$/i)).toBeNull();
        expect(cardNames()).toEqual([]);
        expect(screen.queryByRole('region', { name: 'To follow' })).toBeNull();
        expect(screen.queryByRole('region', { name: 'Up to date' })).toBeNull();
        expect(screen.queryByText(/no athlete matches/i)).toBeNull();
      });

      it('waits for both reads before it draws the cards', () => {
        mockReviewCounts = loadingRead(refetchCounts);
        renderCoachHome();
        expect(cardNames()).toEqual([]);
        expect(screen.getByRole('status', { name: /loading your athletes/i })).toBeInTheDocument();
      });

      it('says the summary could not be read, invents no chip, and asks again on Retry', () => {
        mockSummary = failedRead(refetchSummary);
        mockReviewCounts = { data: {} };
        renderCoachHome();

        expect(screen.getByText('Athlete status couldn’t be loaded')).toBeInTheDocument();
        expect(screen.queryByText(/no program/i)).toBeNull();
        // Every athlete is still there, A–Z, and opens.
        expect(cardNames()).toEqual(['Alice', 'Bob', 'Cara']);
        expect(screen.getByRole('link', { name: 'Bob' })).toHaveAttribute('href', '/coach/students/s2');
        // No block is named and no place in one is invented either.
        expect(screen.queryByText(/^session /i)).toBeNull();
        expect(screen.queryByRole('img')).toBeNull();

        fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
        expect(refetchSummary).toHaveBeenCalledWith({ cancelRefetch: false });
        expect(refetchCounts).not.toHaveBeenCalled();
      });

      // « Up to date » is a status too: it says the coach has nothing to see
      // to. An athlete whose program or sessions to review are not known is
      // not known to be up to date.
      it('files no athlete under "Up to date" while their status is not known', () => {
        mockSummary = failedRead(refetchSummary);
        mockReviewCounts = { data: {} };
        renderCoachHome();

        expect(screen.getByText('Athlete status couldn’t be loaded')).toBeInTheDocument();
        expect(cardNames()).toEqual(['Alice', 'Bob', 'Cara']);
        expect(screen.queryByRole('region', { name: 'Up to date' })).toBeNull();
      });

      it('keeps the review chips it knows when only the summary failed', () => {
        mockSummary = failedRead(refetchSummary);
        renderCoachHome();
        expect(screen.getByText(/2 to review/i)).toBeInTheDocument();
        expect(screen.queryByText(/no program/i)).toBeNull();
        expect(cardNames()).toEqual(['Cara', 'Alice', 'Bob']);
      });

      it('shows no "to review" chip it could not count, and keeps what the summary says', () => {
        mockReviewCounts = failedRead(refetchCounts);
        renderCoachHome();

        expect(screen.getByText('Athlete status couldn’t be loaded')).toBeInTheDocument();
        expect(screen.queryByText(/^\d+ to review$/i)).toBeNull();
        // Nor does the title count sessions it could not count.
        expect(screen.getByText('3 athletes')).toBeInTheDocument();
        expect(screen.getByText(/no program/i)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
        expect(refetchCounts).toHaveBeenCalledWith({ cancelRefetch: false });
        expect(refetchSummary).not.toHaveBeenCalled();
      });

      it('asks both reads again when both failed', () => {
        mockSummary = failedRead(refetchSummary);
        mockReviewCounts = failedRead(refetchCounts);
        renderCoachHome();

        expect(screen.queryByText(/no program/i)).toBeNull();
        expect(screen.queryByText(/^\d+ to review$/i)).toBeNull();
        expect(cardNames()).toEqual(['Alice', 'Bob', 'Cara']);
        fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
        expect(refetchSummary).toHaveBeenCalledWith({ cancelRefetch: false });
        expect(refetchCounts).toHaveBeenCalledWith({ cancelRefetch: false });
      });

      it('says the status waits for the network when a read is paused', () => {
        mockSummary = pausedRead(refetchSummary);
        renderCoachHome();
        expect(screen.getByText('Athlete status isn’t on this device yet')).toBeInTheDocument();
        expect(screen.queryByText(/no program/i)).toBeNull();
      });

      it('shows what it last read when a refresh fails', () => {
        mockSummary = { ...failedRead(refetchSummary), data: { s1: { programName: 'Hyp', weekDays: CALM_WEEK } } };
        renderCoachHome();
        expect(screen.queryByText('Athlete status couldn’t be loaded')).toBeNull();
        expect(screen.getAllByText(/no program/i)).toHaveLength(2);
      });
    });
  });

  // The week of each row, in seven dots (design/parc/components/WeekDots),
  // with the sentence that says it. What StudentWeekStrip used to draw.
  describe('the week of each athlete', () => {
    const week = (states) =>
      Array.from({ length: 7 }, (_, i) => ({
        dayNumber: i + 1,
        session: states[i + 1] ? { id: `x${i + 1}` } : null,
        state: states[i + 1] || 'rest',
      }));
    const renderWeek = (states) => {
      mockSummary = { data: { s1: { programName: 'Hyp', position: 2, totalSessions: 9, weekDays: week(states) } } };
      renderCoachHome();
    };
    const dotsOf = (img) => Array.from(img.children, (dot) => dot.className);

    beforeEach(() => {
      mockStudentsData = { data: [{ id: 's1', profile: { full_name: 'Alice' } }], isLoading: false };
      mockReviewCounts = { data: {} };
      // Pin "today" to Wednesday (dayNumber 3): 2026-04-29 is a Wednesday.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(2026, 3, 29, 12, 0, 0));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('marks the days trained and a session planned today', () => {
      renderWeek({ 1: 'performed', 3: 'planned', 5: 'suggested' });
      const dots = within(rowOf('Alice')).getByRole('img', {
        name: 'This week, Monday done, a session planned today',
      });
      // Today's session is the next one: a later day gets no ring, as on the
      // athlete's own week.
      expect(dotsOf(dots)).toEqual(['is-done', '', 'is-today', '', '', '', '']);
    });

    it('rings the day of the next session when it is still to come', () => {
      renderWeek({ 1: 'performed', 5: 'suggested', 6: 'planned' });
      const dots = within(rowOf('Alice')).getByRole('img', {
        name: 'This week, Monday done, next session Friday',
      });
      expect(dotsOf(dots)).toEqual(['is-done', '', '', '', 'is-next', '', '']);
    });

    it('rings no later day while the next session sits on a day gone by', () => {
      renderWeek({ 2: 'planned', 5: 'planned' });
      const dots = within(rowOf('Alice')).getByRole('img', { name: 'This week, nothing planned' });
      expect(dotsOf(dots)).toEqual(['', '', '', '', '', '', '']);
    });

    it('keeps today from overriding a day already trained', () => {
      renderWeek({ 3: 'performed' });
      const dots = within(rowOf('Alice')).getByRole('img', { name: 'This week, Wednesday done' });
      expect(dotsOf(dots)[2]).toBe('is-done');
    });

    // A recommended day that has passed is not a failure. It stays a
    // recommendation, and the session stays next in the queue.
    it('never marks a past day as missed', () => {
      renderWeek({ 1: 'suggested' });
      const dots = within(rowOf('Alice')).getByRole('img', { name: 'This week, nothing planned' });
      expect(dotsOf(dots)).toEqual(['', '', '', '', '', '', '']);
      expect(screen.queryByText(/missed/i)).toBeNull();
    });

    it('draws seven plain days for a week without a session', () => {
      renderWeek({});
      const dots = within(rowOf('Alice')).getByRole('img', { name: 'This week, nothing planned' });
      expect(dotsOf(dots)).toEqual(['', '', '', '', '', '', '']);
    });

    it('draws no week for an athlete without a program', () => {
      mockSummary = { data: {} };
      renderCoachHome();
      expect(within(rowOf('Alice')).queryByRole('img')).toBeNull();
    });

    // At the end of a row with nothing to see to: the day of the next session.
    it('writes the day of the next session at the end of a calm row', () => {
      renderWeek({ 5: 'suggested' });
      expect(within(rowOf('Alice')).getByText('Friday')).toBeInTheDocument();
    });

    it('writes "Today" when the next session is planned today', () => {
      renderWeek({ 3: 'planned' });
      expect(within(rowOf('Alice')).getByText('Today')).toBeInTheDocument();
    });

    // The session planned today comes before the one planned on Friday.
    it('writes "Today", not a later day, when sessions are planned today and later', () => {
      renderWeek({ 3: 'planned', 5: 'suggested' });
      expect(within(rowOf('Alice')).getByText('Today')).toBeInTheDocument();
      expect(within(rowOf('Alice')).queryByText('Friday')).toBeNull();
    });

    it('writes the status instead of the day for a row that needs a look', () => {
      mockReviewCounts = { data: { s1: 1 } };
      renderWeek({ 5: 'suggested' });
      expect(within(rowOf('Alice')).getByText('1 to review')).toBeInTheDocument();
      expect(within(rowOf('Alice')).queryByText('Friday')).toBeNull();
    });
  });

  describe('with a selected student', () => {
    beforeEach(() => {
      mockStudentsData = {
        data: [{
          id: 's-1',
          profile_id: 'p-1',
          created_at: '2025-03-04T00:00:00Z',
          profile: { full_name: 'Alice' },
        }],
        isLoading: false,
      };
    });

    it('renders a back link to all athletes', () => {
      renderCoachHome('/coach/students/s-1');
      expect(screen.getByRole('link', { name: /all athletes/i })).toHaveAttribute('href', '/coach/students');
    });

    it('renders no tab strip — the athlete is one page', () => {
      renderCoachHome('/coach/students/s-1');
      expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
      expect(screen.queryAllByRole('tab')).toHaveLength(0);
    });

    it('makes the athlete the page title', () => {
      renderCoachHome('/coach/students/s-1');
      expect(screen.getByRole('heading', { level: 1, name: 'Alice' })).toBeInTheDocument();
      // The roster title is REPLACED, not stacked above the name.
      expect(screen.queryByRole('heading', { name: 'Athletes' })).not.toBeInTheDocument();
    });

    // The session editor is a page of its own (design/parc/screens/
    // Editeur.dc.html): its title is the session, the athlete's name under
    // it. The athlete's header stands aside — no second h1 above the editor's
    // — and neither the roster title nor "All athletes" takes its place.
    it('draws no title of its own over the session editor, and hands it the athlete', () => {
      renderCoachHome('/coach/students/s-1/s/sess-1');
      expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
      expect(screen.queryByRole('link', { name: /all athletes/i })).toBeNull();
      // The editor is a child route, so identity must survive the drill-down.
      expect(screen.getByTestId('session-editor')).toHaveTextContent('session:s-1');
    });

    // The header stands aside only for the editor it would sit over: while
    // the athlete is not known, or not there, the page keeps its title and
    // its way back.
    it('keeps a title over an editor route whose athlete is not shown', () => {
      mockStudentsData = { data: [], isLoading: false };
      renderCoachHome('/coach/students/nobody/s/sess-1');
      expect(screen.getByRole('heading', { level: 1, name: 'Athletes' })).toBeInTheDocument();
      expect(screen.queryByTestId('session-editor')).toBeNull();
    });

    it('carries nothing but the name — no second identity row under the title', () => {
      renderCoachHome('/coach/students/s-1');
      expect(screen.queryByRole('link', { name: /view sessions/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: /^message$/i })).not.toBeInTheDocument();
      // The fixture carries a created_at, so a date on screen means the meta
      // line came back rather than the student simply having no join date.
      expect(screen.queryByText(/coaching since/i)).not.toBeInTheDocument();
      expect(screen.queryByRole('heading', { level: 2, name: /alice/i })).not.toBeInTheDocument();
    });

    // The title adds nothing to the name: a name that ends in a full stop
    // keeps the one it has.
    it("doesn't double the full stop on a name that already ends in one", () => {
      mockStudentsData = {
        data: [{
          id: 's-1',
          profile_id: 'p-1',
          created_at: '2025-03-04T00:00:00Z',
          profile: { full_name: 'Sammy Jr.' },
        }],
        isLoading: false,
      };
      renderCoachHome('/coach/students/s-1');
      expect(screen.getByRole('heading', { level: 1, name: 'Sammy Jr.' })).toBeInTheDocument();
    });

    it('names an athlete without a name', () => {
      mockStudentsData = {
        data: [{ id: 's-1', profile_id: 'p-1', created_at: null, profile: { full_name: '  ' } }],
        isLoading: false,
      };
      renderCoachHome('/coach/students/s-1');
      expect(screen.getByRole('heading', { level: 1, name: 'Athlete without a name' })).toBeInTheDocument();
    });

    it('renders the overview on the bare athlete URL', () => {
      renderCoachHome('/coach/students/s-1');
      expect(screen.getByTestId('overview')).toHaveTextContent('overview:s-1');
    });

    it.each([
      '/coach/students/s-1/programming',
      '/coach/students/s-1/progress',
      '/coach/students/s-1/profile',
      '/coach/students/s-1/goals',
      '/coach/students/s-1/stats',
      '/coach/students/s-1/messaging',
    ])('former tab URL %s falls back to the one page', (path) => {
      renderCoachHome(path);
      expect(screen.getByTestId('overview')).toBeInTheDocument();
    });
  });

  // Review items P49 and L11: a failed read and an unknown athlete both said
  // "No students yet. Add students via Supabase dashboard." — to a coach who
  // has athletes.
  describe('when the page has nothing to show', () => {
    const KEY = 'sl_last_coach_students_path';
    const refetch = vi.fn();
    const ALICE = { id: 's-1', profile_id: 'p-1', created_at: null, profile: { full_name: 'Alice' } };

    beforeEach(() => {
      refetch.mockReset();
    });

    it('says the roster could not be read, and asks again on Retry', () => {
      mockStudentsData = {
        data: undefined, isLoading: false, isError: true, isPaused: false, fetchStatus: 'idle', refetch,
      };
      renderCoachHome('/coach/students');

      expect(screen.getByText('This couldn’t be loaded')).toBeInTheDocument();
      expect(screen.queryByText(/no athlete yet/i)).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      expect(refetch).toHaveBeenCalledWith({ cancelRefetch: false });
    });

    it('says the roster waits for the network when the read is paused', () => {
      mockStudentsData = {
        data: undefined, isLoading: true, isError: false, isPaused: true, fetchStatus: 'paused', refetch,
      };
      renderCoachHome('/coach/students/s-1');

      expect(screen.getByText('This isn’t on this device yet')).toBeInTheDocument();
      expect(screen.queryByText(/no athlete yet/i)).toBeNull();
    });

    it('says an athlete who is not on the roster is not found, with the way back to it', () => {
      mockStudentsData = { data: [ALICE], isLoading: false };
      renderCoachHome('/coach/students/nobody');

      expect(screen.getByText('Athlete not found')).toBeInTheDocument();
      expect(screen.queryByText(/no athlete yet/i)).toBeNull();
      expect(screen.queryByTestId('overview')).toBeNull();
      const back = screen.getAllByRole('link', { name: /all athletes/i });
      expect(back.at(-1)).toHaveAttribute('href', '/coach/students');
    });

    it('says the same to a coach without athletes', () => {
      mockStudentsData = { data: [], isLoading: false };
      renderCoachHome('/coach/students/nobody/s/sess-1');

      expect(screen.getByText('Athlete not found')).toBeInTheDocument();
      expect(screen.queryByText(/no athlete yet/i)).toBeNull();
      expect(screen.queryByTestId('session-editor')).toBeNull();
    });

    it('does not make the unknown athlete the place the Athletes tab returns to', () => {
      sessionStorage.setItem(KEY, '/coach/students/s-1');
      mockStudentsData = { data: [ALICE], isLoading: false };
      renderCoachHome('/coach/students/nobody');

      expect(sessionStorage.getItem(KEY)).toBeNull();
    });

    it('remembers the next athlete opened after it', () => {
      mockStudentsData = { data: [ALICE], isLoading: false };
      renderCoachHome('/coach/students/nobody');
      fireEvent.click(screen.getAllByRole('link', { name: /all athletes/i }).at(-1));
      fireEvent.click(screen.getByRole('link', { name: 'Alice' }));

      expect(screen.getByTestId('overview')).toHaveTextContent('overview:s-1');
      expect(sessionStorage.getItem(KEY)).toBe('/coach/students/s-1');
    });
  });

  // Leaving for Sessions/Messages/Library and tapping Athletes again must come
  // back to the athlete, not dump the coach on the roster.
  describe('Athletes-tab persistence', () => {
    const KEY = 'sl_last_coach_students_path';

    beforeEach(() => {
      mockStudentsData = {
        data: [{ id: 's-1', profile_id: 'p-1', created_at: null, profile: { full_name: 'Alice' } }],
        isLoading: false,
      };
    });

    it('remembers the athlete', () => {
      renderCoachHome('/coach/students/s-1');
      expect(sessionStorage.getItem(KEY)).toBe('/coach/students/s-1');
    });

    it('remembers the session editor under the athlete', () => {
      renderCoachHome('/coach/students/s-1/s/sess-1');
      expect(sessionStorage.getItem(KEY)).toBe('/coach/students/s-1/s/sess-1');
    });

    it('never remembers the roster itself', () => {
      renderCoachHome('/coach/students');
      expect(sessionStorage.getItem(KEY)).toBeNull();
    });

    it('restores the athlete when returning to the roster route', () => {
      sessionStorage.setItem(KEY, '/coach/students/s-1');
      renderCoachHome('/coach/students');
      expect(screen.getByTestId('overview')).toHaveTextContent('overview:s-1');
    });

    // Review item L13: the tab used to drop the coach back inside an editor
    // left open hours before — of a session that may be gone since.
    it('restores the athlete page, not the editor beneath it', () => {
      sessionStorage.setItem(KEY, '/coach/students/s-1/s/sess-1');
      renderCoachHome('/coach/students');
      expect(screen.getByTestId('overview')).toHaveTextContent('overview:s-1');
      expect(screen.queryByTestId('session-editor')).toBeNull();
      expect(screen.getByTestId('location')).toHaveTextContent(/^\/coach\/students\/s-1$/);
    });

    it('restores the block the athlete page was on', () => {
      sessionStorage.setItem(KEY, '/coach/students/s-1?program=prog-2');
      renderCoachHome('/coach/students');
      expect(screen.getByTestId('location')).toHaveTextContent(/^\/coach\/students\/s-1\?program=prog-2$/);
    });

    // The memory lasts one launch. A detour inside the launch comes back to
    // the athlete; a cold start opens on the attention-first roster.
    describe('across a launch', () => {
      it('comes back to the athlete within the same launch', () => {
        const first = renderCoachHome('/coach/students/s-1');
        first.unmount();

        renderCoachHome('/coach/students');
        expect(screen.getByTestId('overview')).toHaveTextContent('overview:s-1');
      });

      it('opens on the roster after a relaunch', () => {
        const first = renderCoachHome('/coach/students/s-1/s/sess-1');
        first.unmount();
        // What a cold start of the app does: the tab's sessionStorage is new.
        sessionStorage.clear();

        renderCoachHome('/coach/students');
        expect(screen.queryByTestId('overview')).toBeNull();
        expect(screen.getByRole('link', { name: 'Alice' })).toBeInTheDocument();
      });

      // What the app before this change left behind must not send the first
      // launch after the update into the athlete either.
      it('ignores a place an earlier version saved in localStorage', () => {
        localStorage.setItem(KEY, '/coach/students/s-1');
        renderCoachHome('/coach/students');
        expect(screen.queryByTestId('overview')).toBeNull();
        expect(screen.getByRole('link', { name: 'Alice' })).toBeInTheDocument();
      });
    });

    it('ignores a remembered athlete who is no longer on the roster', () => {
      sessionStorage.setItem(KEY, '/coach/students/gone');
      renderCoachHome('/coach/students');
      expect(screen.queryByTestId('overview')).not.toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Alice' })).toBeInTheDocument();
    });

    it('"All athletes" clears the memory so the roster stays put', () => {
      renderCoachHome('/coach/students/s-1');
      fireEvent.click(screen.getByRole('link', { name: /all athletes/i }));
      expect(sessionStorage.getItem(KEY)).toBeNull();
      expect(screen.getByRole('link', { name: 'Alice' })).toBeInTheDocument();
    });
  });
});
