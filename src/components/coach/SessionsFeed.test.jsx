import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { inTimeZone } from '../../test/inTimeZone';

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

// The parts of the page, by the names they are read by.
const viewChips = () => screen.getByRole('group', { name: 'Filter the sessions' });
const chip = (name) => within(viewChips()).getByRole('button', { name });
const athleteSelect = () => screen.getByRole('combobox', { name: 'Athlete' });
// The row of a session is one link, read as one name: the athlete, then where
// the session sits, then what became of it, then the athlete's note. `row`
// finds it by its title.
const row = (title) => screen.queryByRole('link', { name: new RegExp(`, ${title}(,|$)`) });
// The one row of the "Archived" group, found by the count it starts with;
// its whole name is held by a test of its own (below).
const archivedGroup = () => screen.getByRole('region', { name: 'Archived' });
const archivedRow = (count) => within(archivedGroup()).getByRole('button', { name: new RegExp(`^${count}\\b`) });

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

  // The title stands while the inbox is read: the page is named before it
  // has anything to say.
  it('renders loading spinner under the title', () => {
    mockInbox = loadingRead();
    renderFeed();
    expect(screen.getByRole('heading', { level: 1, name: 'Sessions' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('renders empty state when no confirmations, and no chips to filter nothing', () => {
    renderFeed();
    expect(screen.getByText('No confirmed session yet.')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Filter the sessions' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Archived' })).toBeNull();
  });

  it('says so when the athlete it is filtered on has no confirmed session', () => {
    mockDb = [makeConfirmation({ student_id: 's-1' })];
    renderFeed(['/coach/sessions?student=s-2']);
    expect(screen.getByText('No confirmed session for this athlete.')).toBeInTheDocument();
    expect(screen.queryByText('No confirmed session yet.')).toBeNull();
  });

  it('renders a confirmation row with student name and session title, leading to its review', () => {
    mockDb = [makeConfirmation()];
    renderFeed();
    const link = screen.getByRole('link', { name: 'Alice, Push Day' });
    expect(link).toHaveAttribute('href', '/coach/student/s-1/session/sess-1/review');
  });

  it('names an athlete without a name "Athlete"', () => {
    mockDb = [makeConfirmation({ student_name: '  ' })];
    renderFeed();
    expect(screen.getByRole('link', { name: 'Athlete, Push Day' })).toBeInTheDocument();
  });

  // The archived sessions are put away behind one row, which says how many
  // there are and whether it is open.
  it('puts the archived sessions behind one row that opens and closes them', async () => {
    const user = userEvent.setup();
    mockDb = [
        makeConfirmation({ id: 'c-1', archived_at: '2026-04-16T12:00:00Z', session_title: 'Archived Session' }),
      ];
    renderFeed();
    // Nothing but archived sessions: nothing waits for a review.
    expect(screen.getByText('Nothing to review: every confirmed session is archived.')).toBeInTheDocument();
    const drawer = archivedRow('1 archived session');
    expect(drawer).toHaveAttribute('aria-expanded', 'false');
    expect(row('Archived Session')).toBeNull();

    await user.click(drawer);
    expect(drawer).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('link', { name: 'Alice, Archived Session, Archived' })).toBeInTheDocument();
    expect(screen.queryByText('Nothing to review: every confirmed session is archived.')).toBeNull();

    await user.click(drawer);
    expect(drawer).toHaveAttribute('aria-expanded', 'false');
    expect(row('Archived Session')).toBeNull();
  });

  // The row is a button that says how many sessions it holds, and nothing
  // else: its chevron is drawn for the eye only.
  it('names the archived row by the number of sessions it holds', () => {
    mockDb = [makeConfirmation({ session_title: 'Pushed' })];
    mockTotals = { ...readOf({ active: 1, archived: 12 }), isPlaceholderData: false };
    renderFeed();
    expect(archivedRow('12 archived sessions')).toHaveAccessibleName('12 archived sessions');
  });

  it('filters rows by selected student', async () => {
    const user = userEvent.setup();
    mockDb = [
        makeConfirmation({ id: 'c-1', session_id: 's-a', student_id: 's-1', student_name: 'Alice', session_title: 'Alice Push' }),
        makeConfirmation({ id: 'c-2', session_id: 's-b', student_id: 's-2', student_name: 'Bob', session_title: 'Bob Pull' }),
      ];
    renderFeed();
    expect(row('Alice Push')).toBeInTheDocument();
    expect(row('Bob Pull')).toBeInTheDocument();

    await user.selectOptions(athleteSelect(), 's-1');
    expect(row('Alice Push')).toBeInTheDocument();
    expect(row('Bob Pull')).toBeNull();
  });

  // Review item L14: the line under the title was "W{week} · {label} ·
  // D{day}" — a phase is not a calendar week and a session needs no weekday
  // any more, so live cards ended in a bare "· D" or read "W1 · W1 · D2".
  // The row now says it as the Programming sheet does, in one sentence.
  describe('where the session sits', () => {
    const link = () => screen.getByRole('link', { name: /^Alice, / });

    it('names the session, its phase and its place in the block, never a week or a weekday', () => {
      mockDb = [makeConfirmation({ week_number: 3, day_number: 2, week_label: 'Volume' })];
      mockPositions = { data: { 'sess-1': { n: 2, total: 9 } } };
      renderFeed();
      expect(link()).toHaveAccessibleName('Alice, Push Day, Volume, session 2 of\u00a09');
      expect(link().textContent).not.toMatch(/W3|D2/);
    });

    it('says nothing about a phase without a name and a session without a day', () => {
      mockDb = [makeConfirmation({ week_number: 3, day_number: null, week_label: null })];
      mockPositions = { data: { 'sess-1': { n: 4, total: 12 } } };
      renderFeed();
      expect(link()).toHaveAccessibleName('Alice, Push Day, session 4 of\u00a012');
      expect(link().textContent).not.toMatch(/W3|· D|null|, ,/);
    });

    it('names the phase alone while the places are not known', () => {
      mockDb = [makeConfirmation({ week_number: 1, day_number: 2, week_label: 'Volume' })];
      renderFeed();
      expect(link()).toHaveAccessibleName('Alice, Push Day, Volume');
      expect(link().textContent).not.toMatch(/session \d|W1|D2/i);
    });

    // A session neither reviewed nor archived, without a note: the row is
    // the athlete and the session, and no line is drawn empty.
    it('draws no empty line when there is nothing to say', () => {
      mockDb = [makeConfirmation({ week_number: 1, day_number: null, week_label: null })];
      renderFeed();
      expect(link()).toHaveAccessibleName('Alice, Push Day');
      expect(link().querySelectorAll('.pk-caption')).toHaveLength(1);
    });

    // Review item B28: sessions are born untitled now, and the fallback was
    // the day number — "Session null" for a session without a day.
    it('names an untitled session by its place in the block', () => {
      mockDb = [makeConfirmation({ session_title: null, day_number: null, week_label: 'Volume' })];
      mockPositions = { data: { 'sess-1': { n: 2, total: 9 } } };
      renderFeed();
      expect(link()).toHaveAccessibleName('Alice, Session 2 of\u00a09, Volume');
      expect(screen.queryByText(/null/)).toBeNull();
    });

    it('names an untitled session "Session" while its place is not known', () => {
      mockDb = [makeConfirmation({ session_title: null, day_number: null })];
      renderFeed();
      expect(link()).toHaveAccessibleName('Alice, Session');
      expect(screen.queryByText(/null/)).toBeNull();
    });

    // The day is the heading the row sits under (below), not a part of the
    // row.
    it('dates no row: the day is said once, above its sessions', () => {
      mockDb = [makeConfirmation({ performed_on: '2026-04-12', confirmed_at: '2026-04-16T10:00:00Z' })];
      renderFeed();
      expect(link().textContent).not.toMatch(/Apr|April|2026|\/16\//);
    });
  });

  it('displays student notes on the row, on two lines at most', () => {
    mockDb = [makeConfirmation({ notes: 'Felt really strong today' })];
    renderFeed();
    expect(screen.getByRole('link', { name: 'Alice, Push Day, Felt really strong today' })).toBeInTheDocument();
    expect(screen.getByText('Felt really strong today')).toHaveClass('line-clamp-2');
  });

  it('defaults to the needs-review inbox: reviewed rows are hidden until "Done"', async () => {
    const user = userEvent.setup();
    mockDb = [
        makeConfirmation({ id: 'c-r', session_id: 's-r', session_title: 'Pulled', reviewed_at: '2026-04-30T09:00:00Z' }),
        makeConfirmation({ id: 'c-u', session_id: 's-u', session_title: 'Pushed' }),
      ];
    renderFeed();
    // Default view is the inbox: only the unreviewed confirmation shows,
    // and the To-review chip carries the pending count.
    expect(row('Pushed')).toBeInTheDocument();
    expect(row('Pulled')).toBeNull();
    expect(chip('To review, 1')).toHaveAttribute('aria-pressed', 'true');
    expect(chip('Done')).toHaveAttribute('aria-pressed', 'false');

    await user.click(chip('Done'));
    expect(chip('Done')).toHaveAttribute('aria-pressed', 'true');
    expect(chip('To review, 1')).toHaveAttribute('aria-pressed', 'false');
    expect(row('Pulled')).toBeInTheDocument();
    expect(row('Pushed')).toBeInTheDocument();
  });

  // The count is a Parc `Count` on the chip, read with it: "To review, 3".
  it('counts the inbox on the To-review chip, and nothing when it is empty', async () => {
    const user = userEvent.setup();
    mockDb = [
        makeConfirmation({ id: 'c-1', session_id: 's-1a', session_title: 'One' }),
        makeConfirmation({ id: 'c-2', session_id: 's-1b', session_title: 'Two' }),
        makeConfirmation({ id: 'c-3', session_id: 's-2a', student_id: 's-2', student_name: 'Bob', session_title: 'Three' }),
        makeConfirmation({ id: 'c-r', session_id: 's-r', student_id: 's-2', student_name: 'Bob', session_title: 'Old', reviewed_at: '2026-04-30T09:00:00Z' }),
      ];
    renderFeed();
    expect(chip('To review, 3')).toBeInTheDocument();

    // The count follows the athlete filter, as the inbox does.
    await user.selectOptions(athleteSelect(), 's-2');
    expect(chip('To review, 1')).toBeInTheDocument();

    mockDb = mockDb.filter((c) => c.reviewed_at);
    await user.selectOptions(athleteSelect(), '');
    expect(chip('To review')).toBeInTheDocument();
  });

  // `?student=` is how the roster's "N to review" chip and the athlete page's
  // "Sessions" action arrive.
  describe('arriving for one athlete (?student=)', () => {
    it('opens on their history when nothing is left to review, not on an empty inbox', () => {
      mockDb = [
          makeConfirmation({ id: 'c-r', session_id: 's-r', session_title: 'Pulled', reviewed_at: '2026-04-30T09:00:00Z' }),
        ];
      renderFeed(['/coach/sessions?student=s-1']);
      expect(row('Pulled')).toBeInTheDocument();
      expect(chip('Done')).toHaveAttribute('aria-pressed', 'true');
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
      expect(row('Pushed')).toBeInTheDocument();
      expect(row('Pulled')).toBeNull();
      expect(row('Bob Pull')).toBeNull();
      expect(chip('To review, 1')).toHaveAttribute('aria-pressed', 'true');
    });

    it('still lets the coach switch to the full history', async () => {
      const user = userEvent.setup();
      mockDb = [
          makeConfirmation({ id: 'c-r', session_id: 's-r', session_title: 'Pulled', reviewed_at: '2026-04-30T09:00:00Z' }),
          makeConfirmation({ id: 'c-u', session_id: 's-u', session_title: 'Pushed' }),
        ];
      renderFeed(['/coach/sessions?student=s-1']);
      await user.click(chip('Done'));
      expect(row('Pulled')).toBeInTheDocument();
      await user.click(chip(/^To review/));
      expect(row('Pulled')).toBeNull();
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
      expect(row('Pushed')).toBeInTheDocument();
      expect(row('Pulled')).toBeNull();
    });
  });

  it('shows an all-caught-up empty state when every confirmation is reviewed', () => {
    mockDb = [
        makeConfirmation({ id: 'c-r', session_id: 's-r', session_title: 'Pulled', reviewed_at: '2026-04-30T09:00:00Z' }),
      ];
    renderFeed();
    expect(screen.getByText('All caught up, nothing to review.')).toBeInTheDocument();
    expect(row('Pulled')).toBeNull();
  });

  it('says "Reviewed" on the row of a reviewed session, and on it only', async () => {
    const user = userEvent.setup();
    mockDb = [
        makeConfirmation({ id: 'c-r', session_id: 's-r', student_name: 'Reviewed Rita', session_title: 'Pulled', reviewed_at: '2026-04-30T09:00:00Z' }),
        makeConfirmation({ id: 'c-u', session_id: 's-u', student_name: 'Unreviewed Una', session_title: 'Pushed' }),
      ];
    renderFeed();
    // Reviewed rows live behind the "Done" chip.
    await user.click(chip('Done'));
    // One status, on the reviewed row only.
    const statuses = screen.getAllByText(/^Reviewed$/);
    expect(statuses).toHaveLength(1);
    // The status is inside the same link as the reviewed session.
    expect(row('Pulled')).toContainElement(statuses[0]);
    expect(row('Pulled')).toHaveAccessibleName('Reviewed Rita, Pulled, Reviewed');
    expect(row('Pushed')).not.toContainElement(statuses[0]);
    expect(row('Pushed')).toHaveAccessibleName('Unreviewed Una, Pushed');
  });

  // The line under the title counts what waits for the coach: the inbox of
  // the athlete the feed is filtered on.
  describe('the line under the title', () => {
    it('counts the sessions to review', () => {
      mockDb = [
          makeConfirmation({ id: 'c-1', session_id: 's-1a', session_title: 'One' }),
          makeConfirmation({ id: 'c-2', session_id: 's-1b', session_title: 'Two' }),
          makeConfirmation({ id: 'c-3', session_id: 's-2a', student_id: 's-2', student_name: 'Bob', session_title: 'Three' }),
          makeConfirmation({ id: 'c-r', session_id: 's-r', session_title: 'Old', reviewed_at: '2026-04-30T09:00:00Z' }),
        ];
      renderFeed();
      expect(screen.getByText('3 sessions to review')).toBeInTheDocument();
    });

    it('counts those of the athlete it is filtered on', () => {
      mockDb = [
          makeConfirmation({ id: 'c-1', session_id: 's-1a', session_title: 'One' }),
          makeConfirmation({ id: 'c-2', session_id: 's-1b', session_title: 'Two' }),
          makeConfirmation({ id: 'c-3', session_id: 's-2a', student_id: 's-2', student_name: 'Bob', session_title: 'Three' }),
        ];
      renderFeed(['/coach/sessions?student=s-2']);
      expect(screen.getByText('1 session to review')).toBeInTheDocument();
      expect(screen.queryByText('3 sessions to review')).toBeNull();
    });

    it('says when nothing is left to review', () => {
      mockDb = [
          makeConfirmation({ id: 'c-r', session_id: 's-r', session_title: 'Pulled', reviewed_at: '2026-04-30T09:00:00Z' }),
        ];
      renderFeed();
      expect(screen.getByText('Nothing to review')).toBeInTheDocument();
    });

    it('claims nothing while the inbox is not known', () => {
      mockInbox = loadingRead();
      const { unmount } = renderFeed();
      expect(screen.queryByText('Nothing to review')).toBeNull();
      expect(screen.queryByText(/sessions? to review$/)).toBeNull();
      unmount();

      mockInbox = failedRead();
      renderFeed();
      expect(screen.getByRole('heading', { level: 1, name: 'Sessions' })).toBeInTheDocument();
      expect(screen.queryByText('Nothing to review')).toBeNull();
      expect(screen.queryByText(/sessions? to review$/)).toBeNull();
    });
  });

  // The feed reads as the days the athletes trained, the newest first
  // (design/parc/screens/Seances.dc.html). The day is `performedDate`'s: a
  // confirmation sent from a queue reaches the server when the queue is
  // replayed, days later sometimes, and the session belongs to the day the
  // athlete trained.
  describe('the days the sessions were trained', () => {
    // Friday 17 April 2026 at noon. Only `Date` is replaced — the clicks keep
    // their real timers.
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(2026, 3, 17, 12));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    const headings = (level = 2) => screen.getAllByRole('heading', { level }).map((h) => h.textContent);
    const day = (name) => screen.getByRole('region', { name });
    const on = (performed_on, title, overrides = {}) =>
      makeConfirmation({ id: `c-${title}`, session_id: `s-${title}`, session_title: title, performed_on, ...overrides });

    it('names a day "Today", "Yesterday", by its weekday within the week, by its date beyond it', () => {
      mockDb = [
        on('2026-04-17', 'Fri17'),
        on('2026-04-16', 'Thu16'),
        on('2026-04-15', 'Wed15'),
        on('2026-04-11', 'Sat11'),
        on('2026-04-10', 'Fri10'),
        on('2025-12-31', 'Wed31'),
        on(null, 'Undated', { confirmed_at: null }),
      ];
      renderFeed();
      expect(headings()).toEqual([
        'Today',
        'Yesterday',
        'Wednesday',
        'Saturday',
        // Seven days back is last week's Friday: its date, not "Friday".
        'Friday, April 10',
        // Another year is written out.
        'Wednesday, December 31, 2025',
        'No date',
      ]);
      expect(within(day('Today')).getByRole('link')).toHaveAccessibleName('Alice, Fri17');
      expect(within(day('Friday, April 10')).getByRole('link')).toHaveAccessibleName('Alice, Fri10');
      expect(within(day('No date')).getByRole('link')).toHaveAccessibleName('Alice, Undated');
    });

    it('puts the newest day first, and keeps the order of the read inside a day', () => {
      mockDb = [
        on('2026-04-15', 'First'),
        on(null, 'Undated', { confirmed_at: null }),
        on('2026-04-17', 'Newest'),
        on('2026-04-15', 'Second', { student_id: 's-2', student_name: 'Bob' }),
        on('2026-04-16', 'Middle'),
        on('2026-04-15', 'Third'),
      ];
      renderFeed();
      expect(headings()).toEqual(['Today', 'Yesterday', 'Wednesday', 'No date']);
      const wednesday = within(day('Wednesday')).getAllByRole('link');
      expect(wednesday).toHaveLength(3);
      expect(wednesday[0]).toHaveAccessibleName('Alice, First');
      expect(wednesday[1]).toHaveAccessibleName('Bob, Second');
      expect(wednesday[2]).toHaveAccessibleName('Alice, Third');
    });

    // performed_on, else performed_at read as a date, else the instant of the
    // confirmation read in the device's zone. West of Greenwich, a date read
    // as midnight UTC would fall on the evening before.
    it('puts a session confirmed late under the day it was trained, west of UTC', () => {
      inTimeZone('America/Los_Angeles', () => {
        vi.setSystemTime(new Date(2026, 3, 17, 12));
        mockDb = [
          // Trained on Sunday, confirmed when the queue was replayed on Thursday.
          on('2026-04-12', 'Offline', { confirmed_at: '2026-04-16T10:00:00Z' }),
          // A row that carries the session's performed_at: midnight UTC of
          // Tuesday, which is Monday evening here.
          on(null, 'Synced', { performed_at: '2026-04-14T00:00:00+00:00', confirmed_at: '2026-04-16T18:00:00Z' }),
          // No training date: the confirmation, Wednesday 22:00 here.
          on(null, 'Late night', { confirmed_at: '2026-04-16T05:00:00Z' }),
        ];
        renderFeed();
        expect(headings()).toEqual(['Wednesday', 'Tuesday', 'Sunday']);
        expect(within(day('Sunday')).getByRole('link')).toHaveAccessibleName('Alice, Offline');
        expect(within(day('Tuesday')).getByRole('link')).toHaveAccessibleName('Alice, Synced');
        expect(within(day('Wednesday')).getByRole('link')).toHaveAccessibleName('Alice, Late night');
      });
    });

    it('groups the history of "Done" by day too', async () => {
      const user = userEvent.setup();
      mockDb = [
        on('2026-04-16', 'Pulled', { reviewed_at: '2026-04-16T18:00:00Z' }),
        on('2026-04-17', 'Pushed'),
      ];
      renderFeed();
      expect(headings()).toEqual(['Today']);
      await user.click(chip('Done'));
      expect(headings()).toEqual(['Today', 'Yesterday']);
      expect(within(day('Yesterday')).getByRole('link')).toHaveAccessibleName('Alice, Pulled, Reviewed');
    });

    // The archived days are under the "Archived" group: one level down.
    it('heads the days of the archived drawer one level down', async () => {
      const user = userEvent.setup();
      mockDb = [
        on('2026-04-17', 'Pushed'),
        on('2026-04-16', 'Put away', { archived_at: '2026-04-17T08:00:00Z' }),
      ];
      renderFeed();
      await user.click(archivedRow('1 archived session'));
      expect(headings(2)).toEqual(['Today', 'Archived']);
      expect(headings(3)).toEqual(['Yesterday']);
      expect(within(day('Yesterday')).getByRole('link')).toHaveAccessibleName('Alice, Put away, Archived');
    });
  });

  // Review item L18: the feed read every confirmation of every athlete in one
  // request — the archived ones with the drawer closed — and PostgREST stops
  // at a thousand rows without a word.
  describe('reading only what it shows', () => {
    const reviewed = (n, overrides = {}) =>
      makeConfirmation({ id: `c-r${n}`, session_id: `s-r${n}`, session_title: `Reviewed ${n}`, reviewed_at: '2026-04-30T09:00:00Z', ...overrides });

    it('opens on the inbox, and reads the history only once "Done" is open', async () => {
      const user = userEvent.setup();
      mockDb = [makeConfirmation({ session_title: 'Pushed' }), reviewed(1)];
      renderFeed();
      expect(historyCalls.every((c) => !c.enabled)).toBe(true);

      await user.click(chip('Done'));
      expect(historyCalls.at(-2)).toEqual({ studentId: null, archived: false, enabled: true });
      expect(row('Reviewed 1')).toBeInTheDocument();
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
      expect(row('Old one')).toBeNull();
      const drawer = archivedRow('12 archived sessions');
      expect(drawer).toHaveAttribute('aria-expanded', 'false');

      await user.click(drawer);
      expect(historyCalls.filter((c) => c.archived).at(-1)).toEqual({ studentId: null, archived: true, enabled: true });
      expect(row('Old one')).toBeInTheDocument();
      expect(archivedRow('12 archived sessions')).toHaveAttribute('aria-expanded', 'true');
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
      // A Parc button: 44px, held by test/hitTargets.test.js.
      expect(more).toHaveClass('pk-btn');
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
      expect(row('Reviewed 1')).toBeInTheDocument();
    });

    it('draws no button once the last page is read', () => {
      mockDb = [reviewed(1)];
      renderFeed(['/coach/sessions?student=s-1']);
      expect(row('Reviewed 1')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();
    });

    it('reads the history of the athlete it is filtered on', () => {
      mockDb = [reviewed(1), reviewed(2, { student_id: 's-2', student_name: 'Bob' })];
      renderFeed(['/coach/sessions?student=s-2']);
      expect(historyCalls.at(-2)).toEqual({ studentId: 's-2', archived: false, enabled: true });
      expect(row('Reviewed 2')).toBeInTheDocument();
      expect(row('Reviewed 1')).toBeNull();
    });

    // The athletes of the filter used to be the ones whose confirmations had
    // been read: an athlete whose sessions were all older than the thousand
    // newest could not be picked.
    it('offers every athlete of the coach in the filter, by their students.id', () => {
      mockDb = [makeConfirmation({ student_id: 's-1', student_name: 'Alice' })];
      mockStudents = { data: [student('s-1', 'Alice'), student('s-2', 'Bob'), student('s-3', 'Cy')] };
      renderFeed();
      const options = within(athleteSelect()).getAllByRole('option');
      expect(options.map((o) => [o.value, o.textContent])).toEqual([
        ['', 'All athletes'],
        ['s-1', 'Alice'],
        ['s-2', 'Bob'],
        ['s-3', 'Cy'],
      ]);
    });

    it('orders the athletes A to Z, and names one without a name "Athlete"', () => {
      mockStudents = { data: [student('s-3', 'Cy'), student('s-4', null), student('s-2', 'Bob'), student('s-1', 'Alice')] };
      renderFeed();
      const options = within(athleteSelect()).getAllByRole('option');
      expect(options.map((o) => [o.value, o.textContent])).toEqual([
        ['', 'All athletes'],
        ['s-1', 'Alice'],
        ['s-4', 'Athlete'],
        ['s-2', 'Bob'],
        ['s-3', 'Cy'],
      ]);
    });

    it('draws no athlete filter for a coach without athletes', () => {
      mockStudents = { data: [] };
      renderFeed();
      expect(screen.queryByRole('combobox')).toBeNull();
    });

    it('says the sessions could not be loaded, and claims nothing about them', async () => {
      const user = userEvent.setup();
      mockInbox = failedRead();
      renderFeed();
      expect(screen.getByText('This couldn’t be loaded')).toBeInTheDocument();
      expect(screen.queryByText('All caught up, nothing to review.')).toBeNull();
      expect(screen.queryByText('No confirmed session yet.')).toBeNull();
      await user.click(screen.getByRole('button', { name: 'Try again' }));
      expect(mockInbox.refetch).toHaveBeenCalledWith({ cancelRefetch: false });
    });

    it('claims no empty feed while the numbers are not known', () => {
      mockTotals = { ...failedRead(), isPlaceholderData: false };
      renderFeed();
      expect(screen.queryByText('No confirmed session yet.')).toBeNull();
      // The inbox is known: nothing waits for a review.
      expect(screen.getByText('All caught up, nothing to review.')).toBeInTheDocument();
      expect(chip('Done')).toBeInTheDocument();
    });

    it('treats the numbers of the athlete it was filtered on before as unknown', () => {
      mockTotals = { ...readOf({ active: 0, archived: 4 }), isPlaceholderData: true };
      renderFeed(['/coach/sessions?student=s-2']);
      expect(screen.queryByRole('button', { name: /4 archived sessions/ })).toBeNull();
      expect(screen.queryByText('Nothing to review: every confirmed session is archived.')).toBeNull();
      expect(screen.queryByText('No confirmed session for this athlete.')).toBeNull();
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
      expect(row('Push Day')).toBeInTheDocument();
    });

    // The review's back button returns to the page that opened it. For the
    // feed that includes the athlete filter, which a `?student=` arrival does
    // not store anywhere else.
    it('tells the review to come back to this feed, filter included', async () => {
      const user = userEvent.setup();
      mockDb = [makeConfirmation()];
      renderWithReviewRoute(['/coach/sessions?student=s-1']);
      await user.click(row('Push Day'));
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
      await user.selectOptions(athleteSelect(), 's-2');
      expect(sessionStorage.getItem(FILTER_KEY)).toBe('s-2');
      expect(localStorage.getItem(FILTER_KEY)).toBeNull();
      first.unmount();

      renderFeed();
      expect(athleteSelect()).toHaveValue('s-2');
      expect(row('Alice Push')).toBeNull();
      expect(row('Bob Pull')).toBeInTheDocument();
    });

    it('forgets it when the coach picks every athlete again', async () => {
      const user = userEvent.setup();
      sessionStorage.setItem(FILTER_KEY, 's-2');
      renderFeed();
      await user.selectOptions(athleteSelect(), '');
      expect(sessionStorage.getItem(FILTER_KEY)).toBeNull();
    });

    it('opens unfiltered after a relaunch', async () => {
      const user = userEvent.setup();
      const first = renderFeed();
      await user.selectOptions(athleteSelect(), 's-2');
      first.unmount();
      sessionStorage.clear();

      renderFeed();
      expect(athleteSelect()).toHaveValue('');
      expect(row('Alice Push')).toBeInTheDocument();
      expect(row('Bob Pull')).toBeInTheDocument();
    });

    it('ignores a filter an earlier version saved in localStorage', () => {
      localStorage.setItem(FILTER_KEY, 's-2');
      renderFeed();
      expect(athleteSelect()).toHaveValue('');
    });
  });
});
