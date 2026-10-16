import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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

// weekDays that carry no missed/today/upcoming status regardless of the real
// clock (confirmed = completed, null = rest), so ordering assertions stay
// deterministic on any day the suite runs.
const CALM_WEEK = [
  { dayNumber: 1, session: { id: 'a' }, confirmed: true },
  { dayNumber: 2, session: null, confirmed: false },
  { dayNumber: 3, session: null, confirmed: false },
  { dayNumber: 4, session: null, confirmed: false },
  { dayNumber: 5, session: null, confirmed: false },
  { dayNumber: 6, session: null, confirmed: false },
  { dayNumber: 7, session: null, confirmed: false },
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
    expect(screen.getByText(/no students yet/i)).toBeInTheDocument();
  });

  it('renders the page title', () => {
    mockStudentsData = { data: [], isLoading: false };
    renderCoachHome();
    expect(screen.getByRole('heading', { level: 1, name: 'Athletes.' })).toBeInTheDocument();
  });

  // jsdom has no layout, so this guards the two structural things that made the
  // header jump on navigation: a differently-shaped kicker box, and a differently
  // -styled h1. Same classes + same box shape = same pixels.
  it('gives the roster and the athlete the same header box', () => {
    mockStudentsData = {
      data: [{ id: 's-1', profile_id: 'p-1', created_at: null, profile: { full_name: 'Alice' } }],
      isLoading: false,
    };

    renderCoachHome('/coach/students');
    const rosterH1 = screen.getByRole('heading', { level: 1, name: 'Athletes.' });
    const rosterKicker = rosterH1.previousElementSibling;

    renderCoachHome('/coach/students/s-1');
    const athleteH1 = screen.getByRole('heading', { level: 1, name: 'Alice.' });
    const athleteKicker = athleteH1.previousElementSibling;

    expect(athleteH1.className).toBe(rosterH1.className);
    // An inline-flex anchor wrapping an SVG chevron was the original culprit:
    // taller line box than the roster's block kicker, and a label indented off
    // the title's left edge. The chevron is a mono glyph in the text run now.
    expect(athleteKicker.tagName).toBe('A');
    expect(athleteKicker.querySelector('svg')).toBeNull();
    expect(athleteKicker.className).toContain('block');
    expect(athleteKicker.className).toContain('sl-label');
    expect(rosterKicker.className).toContain('sl-label');
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
          s1: { programName: 'Hyp', activeWeek: { week_number: 3, label: 'B1' }, weekDays: CALM_WEEK },
          s3: { programName: 'Str', activeWeek: { week_number: 1, label: null }, weekDays: CALM_WEEK },
          // s2 absent → no active program.
        },
      };
      // What useReviewCounts holds: sessions to review per `students.id`.
      mockReviewCounts = { data: { s3: 2 } };
    });

    it('renders a card link per athlete', () => {
      renderCoachHome();
      expect(screen.getByRole('link', { name: /open alice/i })).toBeInTheDocument();
      expect(screen.getByRole('link', { name: /open bob/i })).toHaveAttribute('href', '/coach/students/s2');
      expect(screen.getByRole('link', { name: /open cara/i })).toBeInTheDocument();
    });

    it('surfaces attention chips', () => {
      renderCoachHome();
      expect(screen.getByText(/no program/i)).toBeInTheDocument();
      expect(screen.getByText(/2 to review/i)).toBeInTheDocument();
    });

    // Review finding P12: the chip sat inside a card that opened the athlete
    // page, where nothing could be reviewed. It opens what it counts.
    it('links the "to review" chip to that athlete\'s sessions in the feed', () => {
      renderCoachHome();
      const chip = screen.getByRole('link', { name: /2 to review/i });
      expect(chip).toHaveAttribute('href', '/coach/sessions?student=s3');
      expect(chip).toHaveAccessibleName(/cara/i);
      expect(chip).toHaveTextContent(/^2 to review$/i);
    });

    // An anchor inside an anchor is invalid HTML, and browsers split it in
    // ways that differ. The card's link is stretched over the card instead of
    // wrapped around it.
    it('keeps the chip out of the card link, and the card one link', () => {
      renderCoachHome();
      const card = screen.getByRole('link', { name: /open cara/i });
      const chip = screen.getByRole('link', { name: /2 to review/i });
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
      const names = screen.getAllByRole('link', { name: /open /i }).map((el) => el.getAttribute('aria-label'));
      expect(names).toEqual(['Open Bob', 'Open Cara', 'Open Alice']);
    });

    it('filters the list by the search box', () => {
      renderCoachHome();
      fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'ali' } });
      expect(screen.getByRole('link', { name: /open alice/i })).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: /open bob/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: /open cara/i })).not.toBeInTheDocument();
    });

    it('shows the app-errors triage when there are errors', () => {
      mockClientErrors = { data: [{ id: 'e1', role: 'student', message: 'boom', url: '/x', created_at: '2026-01-01' }] };
      renderCoachHome();
      expect(screen.getByText(/app errors/i)).toBeInTheDocument();
      expect(screen.getByText('boom')).toBeInTheDocument();
    });

    // Review items P48, N16: the cards read only `data` of the two reads, and
    // a summary that had not arrived — or was answered by a 500 — was "nobody
    // has a program": a red chip on every athlete, all sorted to the top, and
    // re-sorted when the answer landed.
    describe('while the athletes\u2019 status is not known', () => {
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
      const cardNames = () =>
        screen.queryAllByRole('link', { name: /open /i }).map((el) => el.getAttribute('aria-label'));

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
        expect(placeholder.children).toHaveLength(3);
        expect(screen.queryByText(/no program/i)).toBeNull();
        expect(screen.queryByText(/^\d+ to review$/i)).toBeNull();
        expect(cardNames()).toEqual([]);
        expect(screen.queryByText(/no athletes match/i)).toBeNull();
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
        expect(cardNames()).toEqual(['Open Alice', 'Open Bob', 'Open Cara']);
        expect(screen.getByRole('link', { name: /open bob/i })).toHaveAttribute('href', '/coach/students/s2');

        fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
        expect(refetchSummary).toHaveBeenCalledWith({ cancelRefetch: false });
        expect(refetchCounts).not.toHaveBeenCalled();
      });

      it('keeps the review chips it knows when only the summary failed', () => {
        mockSummary = failedRead(refetchSummary);
        renderCoachHome();
        expect(screen.getByText(/2 to review/i)).toBeInTheDocument();
        expect(screen.queryByText(/no program/i)).toBeNull();
        expect(cardNames()).toEqual(['Open Cara', 'Open Alice', 'Open Bob']);
      });

      it('shows no "to review" chip it could not count, and keeps what the summary says', () => {
        mockReviewCounts = failedRead(refetchCounts);
        renderCoachHome();

        expect(screen.getByText('Athlete status couldn’t be loaded')).toBeInTheDocument();
        expect(screen.queryByText(/^\d+ to review$/i)).toBeNull();
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
        expect(cardNames()).toEqual(['Open Alice', 'Open Bob', 'Open Cara']);
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

    it('makes the athlete the page title, and keeps it while a session is open', () => {
      renderCoachHome('/coach/students/s-1');
      expect(screen.getByRole('heading', { level: 1, name: 'Alice.' })).toBeInTheDocument();
      // The roster title is REPLACED, not stacked above the name.
      expect(screen.queryByRole('heading', { name: 'Athletes.' })).not.toBeInTheDocument();

      // The editor is a child route, so identity must survive the drill-down.
      renderCoachHome('/coach/students/s-1/s/sess-1');
      expect(screen.getAllByRole('heading', { level: 1, name: 'Alice.' }).length).toBeGreaterThan(0);
      expect(screen.getByTestId('session-editor')).toHaveTextContent('session:s-1');
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
      expect(screen.queryByText(/no students yet/i)).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      expect(refetch).toHaveBeenCalledWith({ cancelRefetch: false });
    });

    it('says the roster waits for the network when the read is paused', () => {
      mockStudentsData = {
        data: undefined, isLoading: true, isError: false, isPaused: true, fetchStatus: 'paused', refetch,
      };
      renderCoachHome('/coach/students/s-1');

      expect(screen.getByText('This isn’t on this device yet')).toBeInTheDocument();
      expect(screen.queryByText(/no students yet/i)).toBeNull();
    });

    it('says an athlete who is not on the roster is not found, with the way back to it', () => {
      mockStudentsData = { data: [ALICE], isLoading: false };
      renderCoachHome('/coach/students/nobody');

      expect(screen.getByText('Athlete not found')).toBeInTheDocument();
      expect(screen.queryByText(/no students yet/i)).toBeNull();
      expect(screen.queryByTestId('overview')).toBeNull();
      const back = screen.getAllByRole('link', { name: /all athletes/i });
      expect(back.at(-1)).toHaveAttribute('href', '/coach/students');
    });

    it('says the same to a coach without athletes', () => {
      mockStudentsData = { data: [], isLoading: false };
      renderCoachHome('/coach/students/nobody/s/sess-1');

      expect(screen.getByText('Athlete not found')).toBeInTheDocument();
      expect(screen.queryByText(/no students yet/i)).toBeNull();
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
      fireEvent.click(screen.getByRole('link', { name: /open alice/i }));

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
        expect(screen.getByRole('link', { name: /open alice/i })).toBeInTheDocument();
      });

      // What the app before this change left behind must not send the first
      // launch after the update into the athlete either.
      it('ignores a place an earlier version saved in localStorage', () => {
        localStorage.setItem(KEY, '/coach/students/s-1');
        renderCoachHome('/coach/students');
        expect(screen.queryByTestId('overview')).toBeNull();
        expect(screen.getByRole('link', { name: /open alice/i })).toBeInTheDocument();
      });
    });

    it('ignores a remembered athlete who is no longer on the roster', () => {
      sessionStorage.setItem(KEY, '/coach/students/gone');
      renderCoachHome('/coach/students');
      expect(screen.queryByTestId('overview')).not.toBeInTheDocument();
      expect(screen.getByRole('link', { name: /open alice/i })).toBeInTheDocument();
    });

    it('"All athletes" clears the memory so the roster stays put', () => {
      renderCoachHome('/coach/students/s-1');
      fireEvent.click(screen.getByRole('link', { name: /all athletes/i }));
      expect(sessionStorage.getItem(KEY)).toBeNull();
      expect(screen.getByRole('link', { name: /open alice/i })).toBeInTheDocument();
    });
  });
});
