import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { inTimeZone, ZONES } from '../../test/inTimeZone';

let mockSessionData = { data: null, isLoading: false };
let mockSetLogsData = { data: [], isLoading: false };
let mockParams = { studentId: 'st-1', sessionId: 'sess-1' };

// What useSessionConfirmation hands the page. The review offers its feedback
// step only on an answer READ SINCE THE PAGE OPENED, which it tells from the
// query's timestamps: `dataUpdatedAt` moves on a successful read,
// `errorUpdatedAt` on a failed one. These two stand on either side of "the
// page opened", whenever the test runs.
const AFTER_OPEN = Number.MAX_SAFE_INTEGER;
const BEFORE_OPEN = 1;
const mockRefetchConfirmation = vi.fn();
const mockUseSessionConfirmation = vi.fn();
function confirmationQuery(row, overrides = {}) {
  return {
    data: row,
    dataUpdatedAt: AFTER_OPEN,
    errorUpdatedAt: 0,
    isPaused: false,
    isFetching: false,
    refetch: mockRefetchConfirmation,
    ...overrides,
  };
}
// Trained on the 23rd, offline; the confirmation reached the server on the 25th.
const CONFIRMED = { confirmed_at: '2026-04-25T14:00:00Z', performed_on: '2026-04-23', notes: null };
let mockConfirmation = confirmationQuery(null);
let mockSessionFeedback = { data: null, isLoading: false };
let mockDeviations = { data: [], isLoading: false };
let mockComments = { data: [], isLoading: false };
let mockLibrary = { data: [], isLoading: false };
let mockVideos = { data: [], isLoading: false };
let mockOnline = true;
let mockAdoptPreview = { data: 2, isLoading: false };
let mockSkipPreview = { data: 3, isLoading: false };
const mockSignedUrl = vi.fn();
const mockNavigate = vi.fn();
const mockArchive = { mutate: vi.fn(), isPending: false };
const mockMarkReviewed = { mutate: vi.fn(), isPending: false };
const mockAdopt = { mutate: vi.fn(), isPending: false };
const mockSkip = { mutate: vi.fn(), isPending: false };
const mockDecline = { mutate: vi.fn(), isPending: false };

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useParams: () => mockParams,
    useNavigate: () => mockNavigate,
  };
});

vi.mock('../../hooks/useSession', () => ({
  useSession: () => mockSessionData,
  useMarkSessionReviewed: () => mockMarkReviewed,
}));
vi.mock('../../hooks/useSetLogs', () => ({
  useSetLogs: () => mockSetLogsData,
}));
vi.mock('../../hooks/useSlotComments', () => ({
  useSlotComments: () => mockComments,
}));
vi.mock('../../hooks/useSlotDeviations', () => ({
  useSlotDeviations: () => mockDeviations,
}));
vi.mock('../../hooks/useExerciseLibrary', () => ({
  useExerciseLibrary: () => mockLibrary,
}));
vi.mock('../../hooks/useOnlineStatus', () => ({
  useOnlineStatus: () => mockOnline,
}));
vi.mock('../../hooks/useAdoptSwap', () => ({
  useAdoptSwap: () => mockAdopt,
  useAdoptSwapPreview: () => mockAdoptPreview,
  useAdoptSkip: () => mockSkip,
  useAdoptSkipPreview: () => mockSkipPreview,
  useDeclinePromote: () => mockDecline,
}));
vi.mock('../../hooks/useSetVideo', () => ({
  useSetVideos: () => mockVideos,
  useSetVideoSignedUrl: (path) => {
    mockSignedUrl(path);
    return { data: null, isLoading: false };
  },
}));
vi.mock('../../hooks/useWeek', () => ({
  useArchiveSession: () => mockArchive,
}));
vi.mock('../../hooks/useSessionConfirmation', () => ({
  useSessionConfirmation: (...args) => {
    mockUseSessionConfirmation(...args);
    return mockConfirmation;
  },
}));
vi.mock('../../hooks/useStudents', () => ({
  useStudents: () => ({ data: [{ id: 'st-1', profile_id: 'p-1', profile: { full_name: 'Sam' } }] }),
}));
vi.mock('../../hooks/useMessages', () => ({
  useSendMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useSessionFeedback: () => mockSessionFeedback,
  formatMessageStamp: () => 'Apr 30',
}));

import SessionReview from './SessionReview';
import { I18nProvider } from '../../hooks/useI18n';
import { dismissToast, getToasts } from '../../lib/toast';

// `entry` is the history entry the review is opened from: a path, or
// `{ pathname, state }` when the opener said where to come back to.
function reviewTree(entry = '/coach/student/st-1/session/sess-1/review') {
  return (
    <MemoryRouter initialEntries={[entry]}>
      <SessionReview />
    </MemoryRouter>
  );
}
function renderReview(entry) {
  return render(reviewTree(entry));
}

const PUSH = { id: 'sess-1', title: 'Push', archived_at: null, exercise_slots: [] };
const session = (overrides = {}) => ({ data: { ...PUSH, ...overrides }, isLoading: false });

// A prescribed set of the first exercise, 5 reps at 100 kg, done as planned.
const setLog = (set_number, overrides = {}) => ({
  id: `log-${set_number}`,
  exercise_slot_id: 'sl-1',
  set_number,
  target_reps: 5,
  target_duration_seconds: null,
  target_weight_kg: 100,
  target_rest_seconds: 120,
  actual_reps: null,
  actual_weight_kg: null,
  done: true,
  failed: false,
  skipped: false,
  rpe: null,
  is_student_added: false,
  ...overrides,
});
const SQUAT = { id: 'ex-squat', name: 'Back Squat', type: 'push', difficulty: 3 };
const DIP = { id: 'ex-orig', name: 'Ring Dip', type: 'push', difficulty: 2 };

// The header's round buttons and the session options, a Parc Sheet.
const optionsButton = () => screen.queryByRole('button', { name: 'Session options' });
function openOptions() {
  fireEvent.click(optionsButton());
  return screen.getByRole('dialog', { name: 'Session options' });
}
// The subtitle of a confirmed session: who trained, and when.
const trainedLine = () => screen.queryByText(/^Sam, trained /);
// The buttons of the ActionBar at the bottom of the review, in their order.
function actionBarButtons() {
  const bars = document.querySelectorAll('.pk-actionbar');
  expect(bars).toHaveLength(1);
  return within(bars[0]).getAllByRole('button').map((button) => button.textContent);
}

beforeEach(() => {
  mockSessionData = { data: null, isLoading: false };
  mockSetLogsData = { data: [], isLoading: false };
  mockParams = { studentId: 'st-1', sessionId: 'sess-1' };
  mockConfirmation = confirmationQuery(null);
  mockSessionFeedback = { data: null, isLoading: false };
  mockDeviations = { data: [], isLoading: false };
  mockComments = { data: [], isLoading: false };
  mockLibrary = { data: [], isLoading: false };
  mockVideos = { data: [], isLoading: false };
  mockOnline = true;
  mockAdoptPreview = { data: 2, isLoading: false };
  mockSkipPreview = { data: 3, isLoading: false };
  mockSignedUrl.mockReset();
  mockNavigate.mockReset();
  mockRefetchConfirmation.mockReset();
  mockUseSessionConfirmation.mockReset();
  mockArchive.mutate.mockReset();
  mockMarkReviewed.mutate.mockReset();
  mockAdopt.mutate.mockReset();
  mockAdopt.isPending = false;
  mockSkip.mutate.mockReset();
  mockSkip.isPending = false;
  mockDecline.mutate.mockReset();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe('<SessionReview />', () => {
  it('renders a Spinner under its title while the session is loading', () => {
    mockSessionData = { data: null, isLoading: true };
    renderReview();
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Session' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(mockNavigate).toHaveBeenCalledWith('/coach/sessions');
    // Nothing to act on before there is a session.
    expect(optionsButton()).toBeNull();
  });

  // Review items P49 and L11: the review tested `isLoading` alone. A failed
  // read, or a session that is not there, rendered a review titled "Session"
  // with a feedback step — and saved itself as the review the Sessions tab
  // reopens. The page keeps its title bar now, and nothing of a review.
  describe('without a session to show', () => {
    const KEY = 'sl_last_coach_session';
    const refetch = vi.fn();
    const noSession = (overrides) => ({
      data: undefined,
      isLoading: false,
      isSuccess: false,
      isError: false,
      isPaused: false,
      isFetching: false,
      fetchStatus: 'idle',
      refetch,
      ...overrides,
    });

    beforeEach(() => {
      refetch.mockReset();
      mockConfirmation = confirmationQuery(CONFIRMED);
    });

    function expectNoReview() {
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/^Session$/);
      expect(trainedLine()).toBeNull();
      expect(screen.queryByText('Sam')).toBeNull();
      expect(screen.queryByRole('button', { name: /finish without feedback/i })).toBeNull();
      expect(screen.queryByRole('textbox')).toBeNull();
      expect(document.querySelector('.pk-actionbar')).toBeNull();
      // No way to the options, and so to the archive.
      expect(optionsButton()).toBeNull();
    }

    it('says a failed read failed, asks again on Retry, and saves nothing', () => {
      mockSessionData = noSession({ isError: true });
      renderReview();

      expect(screen.getByText('This couldn’t be loaded')).toBeInTheDocument();
      expectNoReview();
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      expect(refetch).toHaveBeenCalledWith({ cancelRefetch: false });
      expect(sessionStorage.getItem(KEY)).toBeNull();
    });

    it('says a session that is not there is not found, with the way back', () => {
      mockSessionData = noSession({ data: null, isSuccess: true });
      renderReview();

      expect(screen.getByText('Session not found')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Go back' })).toHaveAttribute('href', '/coach/sessions');
      expectNoReview();
      expect(sessionStorage.getItem(KEY)).toBeNull();
    });

    it('leads back to the page that opened it', () => {
      mockSessionData = noSession({ data: null, isSuccess: true });
      renderReview({
        pathname: '/coach/student/st-1/session/sess-1/review',
        state: { from: '/coach/students/st-1' },
      });

      expect(screen.getByRole('link', { name: 'Go back' })).toHaveAttribute('href', '/coach/students/st-1');
      fireEvent.click(screen.getByLabelText('Back'));
      expect(mockNavigate).toHaveBeenCalledWith('/coach/students/st-1');
    });

    // Saved on an earlier visit, while the session was there: the Sessions
    // tab would reopen this "not found" on every visit.
    it('forgets this review when it was saved before the session went', () => {
      sessionStorage.setItem(KEY, JSON.stringify({ studentId: 'st-1', sessionId: 'sess-1' }));
      mockSessionData = noSession({ data: null, isSuccess: true });
      renderReview();

      expect(sessionStorage.getItem(KEY)).toBeNull();
    });

    it('leaves another review saved', () => {
      const other = JSON.stringify({ studentId: 'st-1', sessionId: 'sess-9' });
      sessionStorage.setItem(KEY, other);
      mockSessionData = noSession({ data: null, isSuccess: true });
      renderReview();

      expect(sessionStorage.getItem(KEY)).toBe(other);
    });
  });

  describe('its title', () => {
    it('is the session’s, over the athlete', () => {
      mockSessionData = session();
      renderReview();
      expect(screen.getByRole('heading', { level: 1, name: 'Push' })).toBeInTheDocument();
      // Not confirmed: who, and no when.
      expect(screen.getByText('Sam')).toBeInTheDocument();
      expect(trainedLine()).toBeNull();
    });

    it('is "Session" for a session without one', () => {
      mockSessionData = session({ title: null });
      renderReview();
      expect(screen.getByRole('heading', { level: 1, name: 'Session' })).toBeInTheDocument();
    });
  });

  // Review item L15: the back button was 36px, and named in English only.
  it('has a back button a thumb can hit, named in the app language', () => {
    mockSessionData = session();
    renderReview();
    const back = screen.getByRole('button', { name: 'Back' });
    // A Parc round button: 44px, held by test/hitTargets.test.js.
    expect(back).toHaveClass('pk-icon-btn');
    expect(optionsButton()).toHaveClass('pk-icon-btn');
  });

  it('names its back button in French for a French coach', () => {
    localStorage.setItem('sl_app_lang', 'fr');
    mockSessionData = session();
    render(<I18nProvider>{reviewTree()}</I18nProvider>);
    expect(screen.getByRole('button', { name: 'Retour' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Options de la séance' })).toBeInTheDocument();
  });

  it('says the session is not confirmed when no confirmation exists', () => {
    mockSessionData = session();
    renderReview();
    expect(screen.getByText('Not confirmed')).toBeInTheDocument();
    expect(screen.getByText(/has not confirmed this session, or has undone the confirmation/i))
      .toBeInTheDocument();
    expect(trainedLine()).not.toBeInTheDocument();
  });

  it('says who trained under the title, and the athlete’s note under the exercises', () => {
    mockSessionData = session();
    mockConfirmation = confirmationQuery({
      confirmed_at: '2026-04-25T14:00:00Z',
      notes: 'felt strong',
    });
    renderReview();
    expect(trainedLine()).toBeInTheDocument();
    const note = screen.getByRole('heading', { level: 2, name: 'Sam’s note' });
    expect(note.parentElement).toHaveTextContent('felt strong');
    expect(screen.queryByText('Not confirmed')).not.toBeInTheDocument();
  });

  it('says nothing of a note the athlete did not write', () => {
    mockSessionData = session();
    mockConfirmation = confirmationQuery(CONFIRMED);
    renderReview();
    expect(screen.queryByRole('heading', { name: 'Sam’s note' })).toBeNull();
  });

  // Review item L14: the banner printed `confirmed_at`, which for a workout
  // confirmed offline is the moment the queue was replayed — another day,
  // for 40 of 293 confirmations in production. It is the line under the
  // title now, and says the day as the design does: « hier », « mardi »,
  // « le 3 octobre ».
  describe('the day under the title', () => {
    beforeEach(() => {
      mockSessionData = session();
      vi.useFakeTimers({ toFake: ['Date'] });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    // A Sunday, two and a half weeks after the 23rd.
    const SUNDAY_MAY_10 = () => vi.setSystemTime(new Date(2026, 4, 10, 12));

    it.each(ZONES)('is the day the athlete trained, not the day the confirmation arrived (%s)', (zone) => {
      inTimeZone(zone, () => {
        SUNDAY_MAY_10();
        mockConfirmation = confirmationQuery(CONFIRMED);
        renderReview();
        expect(trainedLine()).toHaveTextContent(/^Sam, trained on April 23$/);
        expect(screen.queryByText(/April 25/)).toBeNull();
      });
    });

    it('falls back to the day of the confirmation for a row without a training date', () => {
      inTimeZone('Europe/Paris', () => {
        SUNDAY_MAY_10();
        mockConfirmation = confirmationQuery({ ...CONFIRMED, performed_on: null });
        renderReview();
        expect(trainedLine()).toHaveTextContent(/^Sam, trained on April 25$/);
      });
    });

    it.each([
      ['2026-05-10', 'today'],
      ['2026-05-09', 'yesterday'],
      ['2026-05-07', 'on Thursday'],
      ['2026-05-04', 'on Monday'],
      ['2026-05-03', 'on May 3'],
      ['2025-12-30', 'on December 30, 2025'],
    ])('says a session trained on %s was trained %s', (performed_on, when) => {
      SUNDAY_MAY_10();
      mockConfirmation = confirmationQuery({ ...CONFIRMED, performed_on });
      renderReview();
      expect(trainedLine()).toHaveTextContent(new RegExp(`^Sam, trained ${when}$`));
    });
  });

  it('persists the studentId/sessionId pair for this launch on render', () => {
    mockSessionData = session();
    renderReview();
    const stored = JSON.parse(sessionStorage.getItem('sl_last_coach_session'));
    expect(stored).toEqual({ studentId: 'st-1', sessionId: 'sess-1' });
  });

  it('back button forgets the review and navigates to /coach/sessions', () => {
    mockSessionData = session();
    renderReview();
    fireEvent.click(screen.getByLabelText('Back'));
    expect(sessionStorage.getItem('sl_last_coach_session')).toBeNull();
    expect(mockNavigate).toHaveBeenCalledWith('/coach/sessions');
  });

  // Review finding P12: the back button always went to the sessions feed, so a
  // review opened from an athlete's sheet was a one-way trip out of it.
  describe('going back where the coach came from', () => {
    const KEY = 'sl_last_coach_session';
    const REVIEW = '/coach/student/st-1/session/sess-1/review';

    beforeEach(() => {
      mockSessionData = session();
    });

    it.each([
      ['the athlete page, on its block', '/coach/students/st-1?program=prog-2'],
      ['the session editor', '/coach/students/st-1/s/sess-1'],
      ['the feed, on its filter', '/coach/sessions?student=st-1'],
    ])('returns to %s', (_label, from) => {
      renderReview({ pathname: REVIEW, state: { from } });
      fireEvent.click(screen.getByLabelText('Back'));
      expect(mockNavigate).toHaveBeenCalledWith(from);
      expect(sessionStorage.getItem(KEY)).toBeNull();
    });

    // Sending feedback or finishing without it ends the review the same way
    // the back button does.
    it('returns there after "Finish without feedback" too', () => {
      mockConfirmation = confirmationQuery(CONFIRMED);
      renderReview({ pathname: REVIEW, state: { from: '/coach/students/st-1' } });
      fireEvent.click(screen.getByRole('button', { name: /finish without feedback/i }));
      mockMarkReviewed.mutate.mock.calls[0][1].onSettled();
      expect(mockNavigate).toHaveBeenCalledWith('/coach/students/st-1');
    });

    // The Sessions tab bounces back into a review left open, and that redirect
    // carries no router state. The origin is saved with the review for it.
    it('saves the origin with the open review, and reads it back without router state', () => {
      const { unmount } = renderReview({ pathname: REVIEW, state: { from: '/coach/students/st-1' } });
      expect(JSON.parse(sessionStorage.getItem(KEY))).toEqual({
        studentId: 'st-1',
        sessionId: 'sess-1',
        from: '/coach/students/st-1',
      });
      unmount();

      renderReview(REVIEW);
      fireEvent.click(screen.getByLabelText('Back'));
      expect(mockNavigate).toHaveBeenCalledWith('/coach/students/st-1');
    });

    // Review item L13: the memory lasts one launch, and what the app before
    // it left in localStorage is not read.
    it('ignores an origin an earlier version saved in localStorage', () => {
      localStorage.setItem(
        KEY,
        JSON.stringify({ studentId: 'st-1', sessionId: 'sess-1', from: '/coach/students/st-1' }),
      );
      renderReview(REVIEW);
      fireEvent.click(screen.getByLabelText('Back'));
      expect(mockNavigate).toHaveBeenCalledWith('/coach/sessions');
    });

    it('ignores an origin saved for another session', () => {
      sessionStorage.setItem(
        KEY,
        JSON.stringify({ studentId: 'st-9', sessionId: 'sess-9', from: '/coach/students/st-9' }),
      );
      renderReview(REVIEW);
      fireEvent.click(screen.getByLabelText('Back'));
      expect(mockNavigate).toHaveBeenCalledWith('/coach/sessions');
    });

    it.each([
      ['a student route', '/student'],
      ['another site', 'https://example.com/coach/'],
      ['not a string', { pathname: '/coach/students' }],
    ])('falls back to the feed when the origin is %s', (_label, from) => {
      renderReview({ pathname: REVIEW, state: { from } });
      fireEvent.click(screen.getByLabelText('Back'));
      expect(mockNavigate).toHaveBeenCalledWith('/coach/sessions');
    });
  });

  // The way into the editor and the archive sit behind the header's round
  // "Session options" button, in a Parc Sheet.
  describe('the session options', () => {
    beforeEach(() => {
      mockSessionData = session();
    });

    it('open in a sheet', () => {
      renderReview();
      expect(screen.queryByRole('link', { name: 'Open in the editor' })).toBeNull();
      const sheet = openOptions();
      expect(within(sheet).getByRole('link', { name: 'Open in the editor' })).toBeInTheDocument();
      expect(within(sheet).getByRole('button', { name: 'Archive the session' })).toBeInTheDocument();
    });

    // The sheet now opens a trained session HERE, so this page carries the
    // way into the editor.
    it('link to the session editor inside the athlete shell', () => {
      renderReview();
      openOptions();
      expect(screen.getByRole('link', { name: 'Open in the editor' }))
        .toHaveAttribute('href', '/coach/students/st-1/s/sess-1');
    });

    // Leaving through it is deliberate: the Sessions tab must not bounce the
    // coach back into this review afterwards.
    it('forget the open review when the editor is opened', () => {
      renderReview();
      expect(sessionStorage.getItem('sl_last_coach_session')).not.toBeNull();
      openOptions();
      fireEvent.click(screen.getByRole('link', { name: 'Open in the editor' }));
      expect(sessionStorage.getItem('sl_last_coach_session')).toBeNull();
    });

    it('archive the session via useArchiveSession, and close', () => {
      renderReview();
      openOptions();
      fireEvent.click(screen.getByRole('button', { name: 'Archive the session' }));
      expect(mockArchive.mutate).toHaveBeenCalledTimes(1);
      expect(mockArchive.mutate.mock.calls[0][0]).toEqual({
        sessionId: 'sess-1',
        archived: true,
      });
      expect(screen.queryByRole('dialog', { name: 'Session options' })).toBeNull();
    });

    it('hold the archive while it is sent', () => {
      mockArchive.isPending = true;
      try {
        renderReview();
        openOptions();
        expect(screen.getByRole('button', { name: 'Archive the session' })).toBeDisabled();
      } finally {
        mockArchive.isPending = false;
      }
    });
  });

  // Live finding N14: a 69×23 pill that archived on one tap, with nothing to
  // say it had, nor a way back but finding the session again.
  describe('archiving from the review', () => {
    beforeEach(() => {
      for (const toast of getToasts()) dismissToast(toast.id);
    });

    it('is a Parc button, like the way into the editor', () => {
      mockSessionData = session();
      renderReview();
      openOptions();
      // 44px and more, held by test/hitTargets.test.js.
      expect(screen.getByRole('button', { name: 'Archive the session' })).toHaveClass('pk-btn', 'pk-btn-lg');
      expect(screen.getByRole('link', { name: 'Open in the editor' })).toHaveClass('pk-btn', 'pk-btn-lg');
    });

    it('says the session was archived once it is, and Undo restores it', () => {
      mockSessionData = session();
      renderReview();
      openOptions();
      fireEvent.click(screen.getByRole('button', { name: 'Archive the session' }));
      // Nothing is said before the database has answered.
      expect(getToasts()).toEqual([]);

      act(() => mockArchive.mutate.mock.calls[0][1].onSuccess());
      const [toast] = getToasts();
      expect(toast).toMatchObject({
        kind: 'info',
        message: 'Session archived',
        action: { label: 'uiSharedHelpers.undo' },
      });

      toast.action.onClick();
      expect(mockArchive.mutate).toHaveBeenCalledTimes(2);
      expect(mockArchive.mutate.mock.calls[1][0]).toEqual({ sessionId: 'sess-1', archived: false });
    });

    it('restores an archived session with no toast', () => {
      mockSessionData = session({ archived_at: '2026-04-22T10:00:00Z' });
      renderReview();
      openOptions();
      fireEvent.click(screen.getByRole('button', { name: 'Take it out of the archive' }));
      expect(mockArchive.mutate).toHaveBeenCalledWith({ sessionId: 'sess-1', archived: false });
      expect(getToasts()).toEqual([]);
    });
  });

  it('says when an archived session was archived, and offers to take it out', () => {
    mockSessionData = session({ archived_at: '2026-04-22T10:00:00Z' });
    inTimeZone('Europe/Paris', () => {
      renderReview();
      expect(screen.getByText('Archived on April 22, 2026')).toBeInTheDocument();
    });
    openOptions();
    expect(screen.getByRole('button', { name: 'Take it out of the archive' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archive the session' })).toBeNull();
  });

  it('says nothing of an archive for a session that is not archived', () => {
    mockSessionData = session();
    renderReview();
    expect(screen.queryByText(/Archived on/)).toBeNull();
  });

  // The three figures of design/parc/screens/Revue.dc.html: the sets done of
  // the plan, the average RPE, the changes to the plan.
  describe('the session in figures', () => {
    const figures = () => screen.queryByRole('region', { name: 'The session in figures' });

    beforeEach(() => {
      mockSessionData = session({
        exercise_slots: [
          { id: 'sl-1', sets: 3, exercise: SQUAT },
          { id: 'sl-2', sets: 3, exercise: DIP },
        ],
      });
      mockConfirmation = confirmationQuery(CONFIRMED);
    });

    it('are not said before a set is logged', () => {
      renderReview();
      expect(figures()).toBeNull();
    });

    it('count the prescribed sets against the plan, the added ones apart', () => {
      mockSetLogsData = {
        data: [
          setLog(1, { rpe: 8 }),
          setLog(2, { rpe: 8.5 }),
          setLog(3, { rpe: 9, actual_weight_kg: 105 }),
          setLog(4, {
            target_reps: null, target_weight_kg: null, target_rest_seconds: null,
            is_student_added: true, rpe: 8, actual_reps: 5, actual_weight_kg: 100,
          }),
          setLog(1, { id: 'log-d1', exercise_slot_id: 'sl-2', target_reps: 8, target_weight_kg: null, rpe: 7 }),
          setLog(2, { id: 'log-d2', exercise_slot_id: 'sl-2', target_reps: 8, target_weight_kg: null, done: false, failed: true }),
          setLog(3, { id: 'log-d3', exercise_slot_id: 'sl-2', target_reps: 8, target_weight_kg: null, done: false, skipped: true }),
        ],
        isLoading: false,
      };
      renderReview();
      const box = within(figures());
      // 4 of the 6 prescribed sets, never 5: the added set is said apart.
      expect(box.getByText('4')).toBeInTheDocument();
      expect(box.getByText('sets done of 6')).toBeInTheDocument();
      expect(box.getByText('1 more added')).toBeInTheDocument();
      // (8 + 8.5 + 9 + 8 + 7) / 5, to one decimal.
      expect(box.getByText('8.1')).toBeInTheDocument();
      expect(box.getByText('average RPE')).toBeInTheDocument();
      // The set off plan and the set added; in amber.
      expect(box.getByText('2')).toHaveClass('text-amber');
      expect(box.getByText('changes to the plan')).toBeInTheDocument();
    });

    it('say "–" without an RPE, and nothing more without an added set', () => {
      mockSetLogsData = { data: [setLog(1), setLog(2, { done: false })], isLoading: false };
      renderReview();
      const box = within(figures());
      expect(box.getByText('1')).toBeInTheDocument();
      expect(box.getByText('set done of 6')).toBeInTheDocument();
      expect(box.queryByText(/more added/)).toBeNull();
      expect(box.getByText('–')).toBeInTheDocument();
      expect(box.getByText('0')).not.toHaveClass('text-amber');
      expect(box.getByText('changes to the plan')).toBeInTheDocument();
    });

    it('count an exercise swapped or skipped as a change', () => {
      mockSetLogsData = { data: [setLog(1)], isLoading: false };
      mockDeviations = {
        data: [{ exercise_slot_id: 'sl-2', kind: 'skip', substitute_exercise_id: null }],
        isLoading: false,
      };
      renderReview();
      const box = within(figures());
      expect(box.getByText('change to the plan')).toBeInTheDocument();
    });
  });

  describe('the exercises', () => {
    beforeEach(() => {
      mockConfirmation = confirmationQuery(CONFIRMED);
    });

    it('are one section each, named, with what was planned and the sets', () => {
      mockSessionData = session({ exercise_slots: [{ id: 'sl-1', sets: 3, exercise: SQUAT }] });
      mockSetLogsData = {
        data: [setLog(1, { rpe: 8 }), setLog(2, { rpe: 8.5 }), setLog(3, { done: false, failed: true })],
        isLoading: false,
      };
      renderReview();
      const squat = within(screen.getByRole('region', { name: 'Back Squat' }));
      expect(squat.getByText('Planned 3 × 5 at 100 kg, rest 2:00')).toBeInTheDocument();
      const rows = squat.getAllByRole('listitem');
      expect(rows).toHaveLength(2);
      expect(rows[0]).toHaveTextContent('Sets 1 and 2, As planned, 5 reps, 100 kg, RPE 8 to 8.5');
      expect(rows[1]).toHaveTextContent('Set 3, failed, Planned 5 reps, 100 kg');
    });

    it('say a superset as one', () => {
      mockSessionData = session({
        exercise_slots: [
          { id: 'sl-1', sets: 3, reps: 5, superset_group: 'A', exercise: SQUAT },
          { id: 'sl-2', sets: 3, reps: 8, superset_group: 'A', exercise: DIP },
          { id: 'sl-3', sets: 3, reps: 10, exercise: { id: 'ex-row', name: 'Ring Row', type: 'pull', difficulty: 1 } },
        ],
      });
      renderReview();
      const superset = screen.getByText('In a superset').parentElement;
      expect(within(superset).getByRole('region', { name: 'Back Squat' })).toBeInTheDocument();
      expect(within(superset).getByRole('region', { name: 'Ring Dip' })).toBeInTheDocument();
      expect(within(superset).queryByRole('region', { name: 'Ring Row' })).toBeNull();
      expect(screen.getAllByText('In a superset')).toHaveLength(1);
    });

    // Review item B8, the coach's half: an exercise this coach cannot read
    // (a former coach's library) comes as `exercise: null`, and reading its
    // name crashed the page.
    it('show a slot whose exercise cannot be read, with its plan and its sets, under a name that says so', () => {
      mockSessionData = session({
        exercise_slots: [
          { id: 'sl-1', sets: 3, exercise: null },
          { id: 'sl-2', sets: 2, reps: 8, exercise: DIP },
        ],
      });
      mockSetLogsData = { data: [setLog(1), setLog(2), setLog(3)], isLoading: false };
      renderReview();

      const unreadable = within(screen.getByRole('region', { name: 'Exercise unavailable' }));
      expect(unreadable.getByText(/a library you can’t read/i)).toBeInTheDocument();
      expect(unreadable.getByText('Planned 3 × 5 at 100 kg, rest 2:00')).toBeInTheDocument();
      expect(unreadable.getByRole('list', { name: 'Sets of Exercise unavailable' })).toHaveTextContent('Sets 1 to 3');
      // The exercise after it is on the page, with what was planned.
      expect(within(screen.getByRole('region', { name: 'Ring Dip' })).getByText('Planned 2 × 8, bodyweight'))
        .toBeInTheDocument();
    });

    it('act on the skip of a slot whose exercise cannot be read, under the same name', () => {
      mockSessionData = session({ exercise_slots: [{ id: 'sl-1', sets: 3, exercise: null }] });
      mockDeviations = {
        data: [{ exercise_slot_id: 'sl-1', kind: 'skip', substitute_exercise_id: null }],
        isLoading: false,
      };
      renderReview();
      fireEvent.click(screen.getByRole('button', { name: 'Remove from the sessions to come' }));
      expect(screen.getByText('Stop prescribing Exercise unavailable from now on?')).toBeInTheDocument();
    });

    // Live finding N12: a set the athlete added has no target, and it was
    // listed under PLANNED as "SET 3 (BW)" and counted against the plan.
    it('leave a set the athlete added out of what was planned', () => {
      mockSessionData = session({ exercise_slots: [{ id: 'sl-1', sets: 2, exercise: DIP }] });
      const planned = (set_number, target_reps, target_weight_kg) => ({
        id: `log-${set_number}`, exercise_slot_id: 'sl-1', set_number, target_reps, target_weight_kg,
        target_duration_seconds: null, target_rest_seconds: null, done: true, failed: false, skipped: false,
        rpe: null, is_student_added: false,
      });
      mockSetLogsData = {
        data: [
          planned(1, 10, 60),
          planned(2, 8, 70),
          {
            id: 'log-3', exercise_slot_id: 'sl-1', set_number: 3, target_reps: null, target_weight_kg: null,
            target_duration_seconds: null, target_rest_seconds: null, done: true, failed: false, skipped: false,
            rpe: null, is_student_added: true, actual_reps: 12, actual_weight_kg: 60,
          },
        ],
        isLoading: false,
      };
      renderReview();

      const dip = within(screen.getByRole('region', { name: 'Ring Dip' }));
      const plan = dip.getByText(/^Planned/);
      expect(plan).toHaveTextContent(/^Planned 10 at 60 kg, 8 at 70 kg$/);
      expect(plan).not.toHaveTextContent(/bodyweight|12/);

      // It is still the athlete's work: its row, with what was done…
      const rows = dip.getAllByRole('listitem');
      expect(rows[2]).toHaveTextContent('Set 3, added, 12 reps, 60 kg');
      expect(rows[2]).not.toHaveTextContent(/Planned|As planned/);
      // …and counted apart.
      const figures = within(screen.getByRole('region', { name: 'The session in figures' }));
      expect(figures.getByText('sets done of 2').previousElementSibling).toHaveTextContent(/^2$/);
      expect(figures.getByText('1 more added')).toBeInTheDocument();
    });

    it('name a swapped exercise by what the athlete did', () => {
      mockSessionData = session({ exercise_slots: [{ id: 'sl-1', sets: 3, exercise: DIP }] });
      mockDeviations = {
        data: [{ exercise_slot_id: 'sl-1', kind: 'swap', substitute_exercise_id: 'ex-sub' }],
        isLoading: false,
      };
      mockLibrary = { data: [{ id: 'ex-sub', name: 'Weighted Dip' }], isLoading: false };
      renderReview();
      const swap = within(screen.getByRole('region', { name: 'Weighted Dip' }));
      expect(swap.getByText('Replaces Ring Dip, the athlete’s choice')).toBeInTheDocument();
    });

    it('name a substitute the coach cannot read as unavailable', () => {
      mockSessionData = session({ exercise_slots: [{ id: 'sl-1', sets: 3, exercise: DIP }] });
      mockDeviations = {
        data: [{ exercise_slot_id: 'sl-1', kind: 'swap', substitute_exercise_id: 'ex-elsewhere' }],
        isLoading: false,
      };
      renderReview();
      const swap = within(screen.getByRole('region', { name: 'Exercise unavailable' }));
      expect(swap.getByText('Replaces Ring Dip, the athlete’s choice')).toBeInTheDocument();
    });

    it('play the video of a set from its row', () => {
      mockSessionData = session({ exercise_slots: [{ id: 'sl-1', sets: 3, exercise: SQUAT }] });
      mockSetLogsData = { data: [setLog(1), setLog(2), setLog(3)], isLoading: false };
      mockVideos = {
        data: [{ id: 'v-2', exercise_slot_id: 'sl-1', set_number: 2, storage_path: 'st-1/sl-1/v-2.mp4' }],
        isLoading: false,
      };
      renderReview();
      expect(screen.queryByRole('dialog')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Video of set 2' }));
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(mockSignedUrl).toHaveBeenCalledWith('st-1/sl-1/v-2.mp4');
    });

    it('carry the athlete’s note of each exercise', () => {
      mockSessionData = session({ exercise_slots: [{ id: 'sl-1', sets: 3, exercise: SQUAT }] });
      mockComments = { data: [{ exercise_slot_id: 'sl-1', body: 'Knees caved on the last one' }], isLoading: false };
      renderReview();
      const squat = within(screen.getByRole('region', { name: 'Back Squat' }));
      expect(squat.getByRole('heading', { level: 3, name: 'Sam’s note' })).toBeInTheDocument();
      expect(squat.getByText('Knees caved on the last one')).toBeInTheDocument();
    });
  });

  it('renders the feedback composer when no feedback exists yet', () => {
    mockSessionData = session();
    mockConfirmation = confirmationQuery(CONFIRMED);
    renderReview();
    expect(screen.getByRole('textbox', { name: 'Your feedback to Sam' })).toBeInTheDocument();
    expect(screen.queryByText(/^Feedback sent/)).not.toBeInTheDocument();
    expect(actionBarButtons()).toEqual(['Send the feedback', 'Finish without feedback']);
  });

  it('replaces the composer with a read-only end when feedback already exists', () => {
    mockSessionData = session();
    mockSessionFeedback = {
      data: {
        id: 'm-1',
        sender_id: 'coach-1',
        recipient_id: 'p-1',
        body: 'Solid session, push the rep cap next week.',
        session_id: 'sess-1',
        created_at: '2026-04-29T10:00:00Z',
      },
      isLoading: false,
    };
    renderReview();
    expect(screen.getByRole('heading', { level: 2, name: 'Feedback sent Apr 30' })).toBeInTheDocument();
    expect(screen.getByText('Solid session, push the rep cap next week.')).toBeInTheDocument();
    // Composer must be gone — no textarea, no "Send the feedback" button.
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /send the feedback/i })).not.toBeInTheDocument();

    expect(actionBarButtons()).toEqual(['Close the review', 'Open the conversation']);
    fireEvent.click(screen.getByRole('button', { name: 'Open the conversation' }));
    expect(mockNavigate).toHaveBeenCalledWith('/coach/messages/p-1');
    // Closing is leaving: the review was over already.
    fireEvent.click(screen.getByRole('button', { name: 'Close the review' }));
    expect(mockNavigate).toHaveBeenLastCalledWith('/coach/sessions');
    expect(mockMarkReviewed.mutate).not.toHaveBeenCalled();
  });

  it('hides both composer and read-only end while feedback is loading', () => {
    mockSessionData = session();
    mockSessionFeedback = { data: null, isLoading: true };
    mockConfirmation = confirmationQuery(CONFIRMED);
    renderReview();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByText(/^Feedback sent/)).not.toBeInTheDocument();
    expect(document.querySelector('.pk-actionbar')).toBeNull();
  });

  it('renders the "reviewed without feedback" end when reviewed_at is set and no feedback exists', () => {
    mockSessionData = session({ reviewed_at: '2026-04-30T09:00:00Z' });
    renderReview();
    expect(screen.getByRole('heading', { level: 2, name: 'Reviewed without feedback' })).toBeInTheDocument();
    expect(screen.getByText(/finished this review without leaving feedback/i)).toBeInTheDocument();
    expect(screen.getByText('Marked reviewed Apr 30')).toBeInTheDocument();
    // Composer must be gone.
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /send the feedback/i })).not.toBeInTheDocument();

    expect(actionBarButtons()).toEqual(['Close the review', 'Open the conversation']);
    fireEvent.click(screen.getByRole('button', { name: 'Close the review' }));
    expect(mockNavigate).toHaveBeenCalledWith('/coach/sessions');
    expect(mockMarkReviewed.mutate).not.toHaveBeenCalled();
  });

  it('"Finish without feedback" stamps reviewed_at via the mutation before navigating back', () => {
    mockSessionData = session();
    mockConfirmation = confirmationQuery(CONFIRMED);
    renderReview();
    fireEvent.click(screen.getByRole('button', { name: /finish without feedback/i }));
    expect(mockMarkReviewed.mutate).toHaveBeenCalledWith(
      { sessionId: 'sess-1' },
      expect.objectContaining({ onSettled: expect.any(Function) }),
    );
    // Trigger the onSettled callback so the component navigates.
    const [, opts] = mockMarkReviewed.mutate.mock.calls[0];
    opts.onSettled();
    expect(mockNavigate).toHaveBeenCalledWith('/coach/sessions');
  });

  // Review finding P57, coach half. A review needs a confirmation: the
  // database refuses `reviewed_at` and a feedback message for a session that
  // has none, and a session reviewed without one never came back to the
  // inbox. So the feedback step — the composer, which also carries "Finish
  // without feedback", the only other way to mark a session reviewed — is
  // offered for a confirmed session only.
  describe('a review needs a confirmation', () => {
    const composer = () => screen.queryByRole('textbox', { name: /your feedback/i });
    const sendButton = () => screen.queryByRole('button', { name: /send the feedback/i });
    const finishButton = () => screen.queryByRole('button', { name: /finish without feedback/i });
    const notConfirmedCard = () => screen.queryByText(/Nothing to review yet/i);
    const uncheckedCard = () => screen.queryByText(/Confirmation not checked/i);

    function expectNoFeedbackForm() {
      expect(composer()).not.toBeInTheDocument();
      expect(sendButton()).not.toBeInTheDocument();
      expect(finishButton()).not.toBeInTheDocument();
    }

    beforeEach(() => {
      mockSessionData = session();
    });

    it('offers the composer and "Finish without feedback" for a confirmed session', () => {
      mockConfirmation = confirmationQuery(CONFIRMED);
      renderReview();
      expect(composer()).toBeInTheDocument();
      expect(sendButton()).toBeInTheDocument();
      expect(finishButton()).toBeInTheDocument();
      expect(notConfirmedCard()).not.toBeInTheDocument();
      expect(uncheckedCard()).not.toBeInTheDocument();
    });

    it('offers neither without a confirmation, and says why in their place', () => {
      renderReview();
      expectNoFeedbackForm();
      expect(notConfirmedCard()).toBeInTheDocument();
      expect(screen.getByText(/can be reviewed once the athlete has confirmed it/i))
        .toBeInTheDocument();
      expect(uncheckedCard()).not.toBeInTheDocument();
    });

    // What is left to do about a session that cannot be reviewed: leave the
    // way the back button does, or write to the athlete.
    it('leads back, and to the athlete’s thread', () => {
      renderReview({
        pathname: '/coach/student/st-1/session/sess-1/review',
        state: { from: '/coach/students/st-1' },
      });
      expect(actionBarButtons()).toEqual(['Close the review', 'Open the conversation']);
      fireEvent.click(screen.getByRole('button', { name: 'Open the conversation' }));
      expect(mockNavigate).toHaveBeenCalledWith('/coach/messages/p-1');

      fireEvent.click(screen.getByRole('button', { name: 'Close the review' }));
      expect(mockNavigate).toHaveBeenCalledWith('/coach/students/st-1');
      expect(sessionStorage.getItem('sl_last_coach_session')).toBeNull();
      // Leaving is not a completion gesture here: nothing is marked reviewed.
      expect(mockMarkReviewed.mutate).not.toHaveBeenCalled();
    });

    // The cache keeps an answer for two minutes and across reloads, and the
    // athlete can undo a confirmation in between. That is the stale "Session
    // completed" notification: tapped again, it used to open the form on the
    // strength of what the coach's device remembered.
    describe('when the cache holds an answer from before the page opened', () => {
      it('asks for a fresh read as the page opens', () => {
        renderReview();
        expect(mockUseSessionConfirmation).toHaveBeenCalledWith('sess-1', {
          refetchOnMount: 'always',
        });
      });

      it('does not offer the form on a remembered confirmation that is gone', () => {
        mockConfirmation = confirmationQuery(CONFIRMED, {
          dataUpdatedAt: BEFORE_OPEN,
          isFetching: true,
        });
        const view = renderReview();
        // The read is in flight: no form yet, and no verdict either.
        expectNoFeedbackForm();
        expect(notConfirmedCard()).not.toBeInTheDocument();
        expect(uncheckedCard()).not.toBeInTheDocument();
        expect(document.querySelector('.pk-actionbar')).toBeNull();

        // It lands: the athlete has undone the confirmation.
        mockConfirmation = confirmationQuery(null);
        view.rerender(reviewTree());
        expectNoFeedbackForm();
        expect(screen.getByText('Not confirmed')).toBeInTheDocument();
        expect(notConfirmedCard()).toBeInTheDocument();
      });

      it('offers it as soon as the confirmation is read again', () => {
        mockConfirmation = confirmationQuery(CONFIRMED, {
          dataUpdatedAt: BEFORE_OPEN,
          isFetching: true,
        });
        const view = renderReview();
        // Shown at once from the cache — its date and notes are content.
        expect(trainedLine()).toBeInTheDocument();
        expectNoFeedbackForm();

        mockConfirmation = confirmationQuery(CONFIRMED);
        view.rerender(reviewTree());
        expect(composer()).toBeInTheDocument();
        expect(finishButton()).toBeInTheDocument();
      });

      // The other direction, and the common one: the coach looked at a session
      // in progress, the athlete confirmed it since.
      it('does not say "not confirmed" on a remembered absence', () => {
        mockConfirmation = confirmationQuery(null, {
          dataUpdatedAt: BEFORE_OPEN,
          isFetching: true,
        });
        const view = renderReview();
        expect(screen.queryByText('Not confirmed')).not.toBeInTheDocument();
        expect(notConfirmedCard()).not.toBeInTheDocument();
        expectNoFeedbackForm();

        mockConfirmation = confirmationQuery(CONFIRMED);
        view.rerender(reviewTree());
        expect(trainedLine()).toBeInTheDocument();
        expect(composer()).toBeInTheDocument();
      });
    });

    // "Not confirmed" is a statement about the athlete. A read that failed
    // says nothing about them.
    describe('when the confirmation cannot be read', () => {
      it('claims nothing, offers no form, and offers to check again first', () => {
        mockConfirmation = confirmationQuery(undefined, {
          dataUpdatedAt: 0,
          errorUpdatedAt: AFTER_OPEN,
        });
        renderReview();
        expectNoFeedbackForm();
        expect(screen.queryByText('Not confirmed')).not.toBeInTheDocument();
        expect(notConfirmedCard()).not.toBeInTheDocument();
        expect(uncheckedCard()).toBeInTheDocument();
        expect(actionBarButtons()).toEqual(['Check again', 'Open the conversation', 'Close the review']);

        fireEvent.click(screen.getByRole('button', { name: /check again/i }));
        expect(mockRefetchConfirmation).toHaveBeenCalledTimes(1);
      });

      it('does not fall back on a remembered confirmation', () => {
        mockConfirmation = confirmationQuery(CONFIRMED, {
          dataUpdatedAt: BEFORE_OPEN,
          errorUpdatedAt: AFTER_OPEN,
        });
        renderReview();
        expectNoFeedbackForm();
        expect(uncheckedCard()).toBeInTheDocument();
      });

      // Offline, the read does not fail: it waits for the network.
      it('says the same while the read waits for the network', () => {
        mockConfirmation = confirmationQuery(CONFIRMED, {
          dataUpdatedAt: BEFORE_OPEN,
          isPaused: true,
        });
        renderReview();
        expectNoFeedbackForm();
        expect(uncheckedCard()).toBeInTheDocument();
        expect(notConfirmedCard()).not.toBeInTheDocument();
      });

      it('keeps the card, with its button busy, while it checks again', () => {
        mockConfirmation = confirmationQuery(undefined, {
          dataUpdatedAt: 0,
          errorUpdatedAt: AFTER_OPEN,
          isFetching: true,
        });
        renderReview();
        expect(uncheckedCard()).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /checking/i })).toBeDisabled();
      });

      it('still leads back, without marking anything reviewed', () => {
        mockConfirmation = confirmationQuery(undefined, {
          dataUpdatedAt: 0,
          errorUpdatedAt: AFTER_OPEN,
        });
        renderReview();
        fireEvent.click(screen.getByRole('button', { name: 'Close the review' }));
        expect(mockNavigate).toHaveBeenCalledWith('/coach/sessions');
        expect(mockMarkReviewed.mutate).not.toHaveBeenCalled();
      });
    });

    describe('once the composer is on screen', () => {
      // A refetch on window focus that fails must not take the coach's unsent
      // text with it: the confirmation was read for this visit, and a failed
      // read does not take that back.
      it('keeps it, and what was typed, when a later read fails', () => {
        mockConfirmation = confirmationQuery(CONFIRMED);
        const view = renderReview();
        fireEvent.change(composer(), { target: { value: 'Good depth on the dips.' } });

        mockConfirmation = confirmationQuery(CONFIRMED, {
          errorUpdatedAt: AFTER_OPEN,
          isPaused: true,
        });
        view.rerender(reviewTree());
        expect(composer()).toHaveValue('Good depth on the dips.');
        expect(uncheckedCard()).not.toBeInTheDocument();
      });

      it('withdraws it when a later read finds the confirmation undone', () => {
        mockConfirmation = confirmationQuery(CONFIRMED);
        const view = renderReview();
        expect(composer()).toBeInTheDocument();

        mockConfirmation = confirmationQuery(null);
        view.rerender(reviewTree());
        expectNoFeedbackForm();
        expect(notConfirmedCard()).toBeInTheDocument();
      });

      // Review item P47: the draft lived in the composer's state, so the
      // withdrawal above threw it away for good.
      it('brings back what was typed when the confirmation is read again', () => {
        mockConfirmation = confirmationQuery(CONFIRMED);
        const view = renderReview();
        fireEvent.change(composer(), { target: { value: 'Good depth on the dips.' } });

        mockConfirmation = confirmationQuery(null);
        view.rerender(reviewTree());
        expectNoFeedbackForm();

        mockConfirmation = confirmationQuery(CONFIRMED);
        view.rerender(reviewTree());
        expect(composer()).toHaveValue('Good depth on the dips.');
      });

      it('asks before "Finish without feedback" throws a typed draft away', () => {
        mockConfirmation = confirmationQuery(CONFIRMED);
        renderReview();
        fireEvent.change(composer(), { target: { value: 'Good depth on the dips.' } });
        fireEvent.click(finishButton());

        expect(screen.getByRole('dialog', { name: 'Finish without sending?' })).toBeInTheDocument();
        expect(mockMarkReviewed.mutate).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole('button', { name: 'Finish and discard' }));
        expect(mockMarkReviewed.mutate).toHaveBeenCalledWith(
          { sessionId: 'sess-1' },
          expect.objectContaining({ onSettled: expect.any(Function) }),
        );
        expect(localStorage.getItem('sl_feedback_draft:sess-1')).toBeNull();
      });
    });

    // The composer forgets its draft when the send succeeds — unless the
    // coach had left the page before the answer came, or the review was
    // finished on another device. The page forgets it then.
    describe('a draft kept for a session that is reviewed', () => {
      const KEY = 'sl_feedback_draft:sess-1';

      it('is forgotten once the session says it is reviewed', () => {
        localStorage.setItem(KEY, 'Sent from the phone');
        mockSessionData = session({ reviewed_at: '2026-04-26T09:00:00Z' });
        mockConfirmation = confirmationQuery(CONFIRMED);
        renderReview();
        expect(localStorage.getItem(KEY)).toBeNull();
      });

      it('is forgotten once its feedback is there', () => {
        localStorage.setItem(KEY, 'Sent from the phone');
        mockSessionFeedback = {
          data: { id: 'm-1', body: 'Sent from the phone', created_at: '2026-04-26T09:00:00Z' },
          isLoading: false,
        };
        mockConfirmation = confirmationQuery(CONFIRMED);
        renderReview();
        expect(localStorage.getItem(KEY)).toBeNull();
      });

      it('is kept while the session waits for its review', () => {
        localStorage.setItem(KEY, 'Half written');
        mockConfirmation = confirmationQuery(CONFIRMED);
        renderReview();
        expect(localStorage.getItem(KEY)).toBe('Half written');
        expect(composer()).toHaveValue('Half written');
      });
    });

    // Sessions reviewed before the rule existed have no confirmation. Their
    // read-only ends say what happened; nothing can be submitted from them.
    describe('a session already reviewed, without a confirmation', () => {
      it('keeps its "reviewed without feedback" end', () => {
        mockSessionData = session({ reviewed_at: '2026-04-30T09:00:00Z' });
        renderReview();
        expect(screen.getByText('Reviewed without feedback')).toBeInTheDocument();
        expect(notConfirmedCard()).not.toBeInTheDocument();
        expectNoFeedbackForm();
      });

      it('keeps the feedback it was sent', () => {
        mockSessionFeedback = {
          data: {
            id: 'm-1',
            sender_id: 'coach-1',
            recipient_id: 'p-1',
            body: 'Solid session.',
            session_id: 'sess-1',
            created_at: '2026-04-29T10:00:00Z',
          },
          isLoading: false,
        };
        renderReview();
        expect(screen.getByText('Solid session.')).toBeInTheDocument();
        expect(notConfirmedCard()).not.toBeInTheDocument();
        expectNoFeedbackForm();
      });
    });

    // "Since the page opened" is counted per session. The router keeps the
    // route's element mounted when only its params change, so without a mount
    // per session the first review's opening time would vouch for whatever the
    // cache holds about the second.
    it('does not let one session’s opening time vouch for the next', () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(1_000);
        mockConfirmation = confirmationQuery(CONFIRMED, { dataUpdatedAt: 2_000 });
        const view = renderReview();
        expect(composer()).toBeInTheDocument();

        // Another session, opened at 5 000; the cache read it at 2 000.
        vi.setSystemTime(5_000);
        mockParams = { studentId: 'st-1', sessionId: 'sess-2' };
        view.rerender(reviewTree());
        expect(mockUseSessionConfirmation).toHaveBeenLastCalledWith('sess-2', {
          refetchOnMount: 'always',
        });
        expectNoFeedbackForm();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // A swap or a skip the athlete made, carried into the program from here
  // (Phase 3.1–3.3): each through a Parc Sheet that says how many sessions to
  // come it changes before anything is written.
  describe('carrying a change into the program', () => {
    const swapSession = session({
      exercise_slots: [{ id: 'sl-1', sets: 3, reps: 8, exercise: DIP }],
    });
    const SWAP = { exercise_slot_id: 'sl-1', kind: 'swap', substitute_exercise_id: 'ex-sub' };
    const SKIP = { exercise_slot_id: 'sl-1', kind: 'skip', substitute_exercise_id: null };

    beforeEach(() => {
      mockSessionData = swapSession;
      mockConfirmation = confirmationQuery(CONFIRMED);
      mockLibrary = { data: [{ id: 'ex-sub', name: 'Weighted Dip' }], isLoading: false };
    });

    it('offers "Adopt into the program" for a swap and adopts via the RPC hook', () => {
      mockDeviations = { data: [SWAP], isLoading: false };
      renderReview();

      fireEvent.click(screen.getByRole('button', { name: 'Adopt into the program' }));
      // The sheet opens with the blast-radius count (preview mock = 2).
      const sheet = within(screen.getByRole('dialog', { name: 'Adopt the change' }));
      expect(sheet.getByText('Prescribe Weighted Dip instead of Ring Dip?')).toBeInTheDocument();
      expect(sheet.getByText(/This changes 2 sessions to come/)).toBeInTheDocument();
      // The targets are carried, not reset: said where the coach can act on it.
      expect(sheet.getByText(/The targets of Ring Dip carry over/)).toBeInTheDocument();

      fireEvent.click(sheet.getByRole('button', { name: 'Adopt' }));
      expect(mockAdopt.mutate).toHaveBeenCalledWith(
        { slotId: 'sl-1', substituteId: 'ex-sub', sessionId: 'sess-1' },
        expect.any(Object),
      );

      act(() => mockAdopt.mutate.mock.calls[0][1].onSuccess({ applied: 2 }));
      expect(screen.queryByRole('dialog', { name: 'Adopt the change' })).toBeNull();
      expect(screen.getByText('Adopted into the program')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Adopt into the program' })).toBeNull();
    });

    // A rewrite that changed nothing must not read as one that did.
    it('does not say a swap was adopted when nothing was changed', () => {
      mockDeviations = { data: [SWAP], isLoading: false };
      renderReview();
      fireEvent.click(screen.getByRole('button', { name: 'Adopt into the program' }));
      fireEvent.click(screen.getByRole('button', { name: 'Adopt' }));
      act(() => mockAdopt.mutate.mock.calls[0][1].onSuccess({ applied: 0 }));
      expect(screen.queryByText('Adopted into the program')).toBeNull();
      expect(screen.getByRole('button', { name: 'Adopt into the program' })).toBeInTheDocument();
    });

    it('says when no session to come has the exercise, and adopts nothing', () => {
      mockDeviations = { data: [SWAP], isLoading: false };
      mockAdoptPreview = { data: 0, isLoading: false };
      renderReview();
      fireEvent.click(screen.getByRole('button', { name: 'Adopt into the program' }));
      expect(screen.getByText('No session to come still prescribes Ring Dip. Nothing to change.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Nothing to adopt' })).toBeDisabled();
      expect(screen.queryByText(/carry over/)).toBeNull();
    });

    it('checks the sessions to come before it offers to adopt', () => {
      mockDeviations = { data: [SWAP], isLoading: false };
      mockAdoptPreview = { data: undefined, isLoading: true };
      renderReview();
      fireEvent.click(screen.getByRole('button', { name: 'Adopt into the program' }));
      expect(screen.getByText('Checking the sessions to come…')).toBeInTheDocument();
    });

    it('holds the sheet while the adoption is sent, and Cancel closes it untouched', () => {
      mockDeviations = { data: [SWAP], isLoading: false };
      mockAdopt.isPending = true;
      const view = renderReview();
      fireEvent.click(screen.getByRole('button', { name: 'Adopt into the program' }));
      expect(screen.getByRole('button', { name: 'Adopting…' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();

      mockAdopt.isPending = false;
      view.rerender(reviewTree());
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('dialog', { name: 'Adopt the change' })).toBeNull();
      expect(mockAdopt.mutate).not.toHaveBeenCalled();
    });

    it('surfaces a promote request and declines it via the RPC hook', () => {
      mockDeviations = { data: [{ ...SWAP, promote_requested_at: '2026-04-26T09:00:00Z' }], isLoading: false };
      renderReview();

      expect(screen.getByText('The athlete asks to keep this change')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
      expect(mockDecline.mutate).toHaveBeenCalledWith({ slotId: 'sl-1', sessionId: 'sess-1' });
    });

    it('offers "Remove from the sessions to come" for a skip and drops it via the RPC hook', () => {
      mockDeviations = { data: [SKIP], isLoading: false };
      renderReview();
      expect(screen.getByText('Skipped by the athlete')).toBeInTheDocument();
      // A skip has no substitute, so it never offers the swap-adopt action…
      expect(screen.queryByRole('button', { name: 'Adopt into the program' })).not.toBeInTheDocument();

      // …but it can be dropped forward.
      fireEvent.click(screen.getByRole('button', { name: 'Remove from the sessions to come' }));
      // Sheet opened — blast-radius count (skip preview mock = 3).
      const sheet = within(screen.getByRole('dialog', { name: 'Remove from the sessions to come' }));
      expect(sheet.getByText('Stop prescribing Ring Dip from now on?')).toBeInTheDocument();
      expect(sheet.getByText(/Removes Ring Dip from 3 sessions to come/)).toBeInTheDocument();
      fireEvent.click(sheet.getByRole('button', { name: 'Remove' }));
      expect(mockSkip.mutate).toHaveBeenCalledWith(
        { slotId: 'sl-1', sessionId: 'sess-1' },
        expect.any(Object),
      );

      act(() => mockSkip.mutate.mock.calls[0][1].onSuccess({ applied: 3 }));
      expect(screen.getByText('Removed from the sessions to come')).toBeInTheDocument();
    });

    it('says when no session to come has the skipped exercise, and removes nothing', () => {
      mockDeviations = { data: [SKIP], isLoading: false };
      mockSkipPreview = { data: 0, isLoading: false };
      renderReview();
      fireEvent.click(screen.getByRole('button', { name: 'Remove from the sessions to come' }));
      expect(screen.getByText('No session to come still prescribes Ring Dip. Nothing to remove.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Nothing to remove' })).toBeDisabled();
    });

    it('holds the removal while it is sent', () => {
      mockDeviations = { data: [SKIP], isLoading: false };
      mockSkip.isPending = true;
      renderReview();
      fireEvent.click(screen.getByRole('button', { name: 'Remove from the sessions to come' }));
      expect(screen.getByRole('button', { name: 'Removing…' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    });

    // The RPCs are online-only.
    it('says to connect while offline', () => {
      mockOnline = false;
      mockDeviations = { data: [SWAP], isLoading: false };
      renderReview();
      expect(screen.getByText('Connect to adopt this change.')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Adopt into the program' })).toBeNull();
    });
  });
});
