import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

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
const CONFIRMED = { confirmed_at: '2026-04-25T14:00:00Z', notes: null };
let mockConfirmation = confirmationQuery(null);
let mockSessionFeedback = { data: null, isLoading: false };
let mockDeviations = { data: [], isLoading: false };
let mockLibrary = { data: [], isLoading: false };
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
  useSlotComments: () => ({ data: [], isLoading: false }),
}));
vi.mock('../../hooks/useSlotDeviations', () => ({
  useSlotDeviations: () => mockDeviations,
}));
vi.mock('../../hooks/useExerciseLibrary', () => ({
  useExerciseLibrary: () => mockLibrary,
}));
vi.mock('../../hooks/useOnlineStatus', () => ({
  useOnlineStatus: () => true,
}));
vi.mock('../../hooks/useAdoptSwap', () => ({
  useAdoptSwap: () => mockAdopt,
  useAdoptSwapPreview: () => ({ data: 2, isLoading: false }),
  useAdoptSkip: () => mockSkip,
  useAdoptSkipPreview: () => ({ data: 3, isLoading: false }),
  useDeclinePromote: () => mockDecline,
}));
vi.mock('../../hooks/useSetVideo', () => ({
  useSetVideos: () => ({ data: [], isLoading: false }),
  useSetVideoSignedUrl: () => ({ data: null, isLoading: false }),
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

beforeEach(() => {
  mockSessionData = { data: null, isLoading: false };
  mockSetLogsData = { data: [], isLoading: false };
  mockParams = { studentId: 'st-1', sessionId: 'sess-1' };
  mockConfirmation = confirmationQuery(null);
  mockSessionFeedback = { data: null, isLoading: false };
  mockDeviations = { data: [], isLoading: false };
  mockLibrary = { data: [], isLoading: false };
  mockNavigate.mockReset();
  mockRefetchConfirmation.mockReset();
  mockUseSessionConfirmation.mockReset();
  mockArchive.mutate.mockReset();
  mockMarkReviewed.mutate.mockReset();
  mockAdopt.mutate.mockReset();
  mockSkip.mutate.mockReset();
  mockDecline.mutate.mockReset();
  window.localStorage.clear();
});

describe('<SessionReview />', () => {
  it('renders a Spinner while the session is loading', () => {
    mockSessionData = { data: null, isLoading: true };
    renderReview();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('says the session is not confirmed when no confirmation exists', () => {
    mockSessionData = {
      data: { id: 'sess-1', title: 'Push', archived_at: null, exercise_slots: [] },
      isLoading: false,
    };
    renderReview();
    expect(screen.getByText('Not confirmed')).toBeInTheDocument();
    expect(screen.getByText(/has not confirmed this session, or has undone the confirmation/i))
      .toBeInTheDocument();
    expect(screen.queryByText(/Confirmed by student/i)).not.toBeInTheDocument();
  });

  it('renders the green confirmed banner with the student notes', () => {
    mockSessionData = {
      data: { id: 'sess-1', title: 'Push', archived_at: null, exercise_slots: [] },
      isLoading: false,
    };
    mockConfirmation = confirmationQuery({
      confirmed_at: '2026-04-25T14:00:00Z',
      notes: 'felt strong',
    });
    renderReview();
    expect(screen.getByText(/Confirmed by student/i)).toBeInTheDocument();
    expect(screen.getByText(/felt strong/)).toBeInTheDocument();
    expect(screen.queryByText('Not confirmed')).not.toBeInTheDocument();
  });

  it('persists the studentId/sessionId pair to localStorage on render', () => {
    mockSessionData = {
      data: { id: 'sess-1', title: 'Push', archived_at: null, exercise_slots: [] },
      isLoading: false,
    };
    renderReview();
    const stored = JSON.parse(localStorage.getItem('sl_last_coach_session'));
    expect(stored).toEqual({ studentId: 'st-1', sessionId: 'sess-1' });
  });

  it('back button clears localStorage and navigates to /coach/sessions', () => {
    mockSessionData = {
      data: { id: 'sess-1', title: 'Push', archived_at: null, exercise_slots: [] },
      isLoading: false,
    };
    renderReview();
    fireEvent.click(screen.getByLabelText('Back'));
    expect(localStorage.getItem('sl_last_coach_session')).toBeNull();
    expect(mockNavigate).toHaveBeenCalledWith('/coach/sessions');
  });

  // Review finding P12: the back button always went to the sessions feed, so a
  // review opened from an athlete's sheet was a one-way trip out of it.
  describe('going back where the coach came from', () => {
    const KEY = 'sl_last_coach_session';
    const REVIEW = '/coach/student/st-1/session/sess-1/review';
    const session = {
      data: { id: 'sess-1', title: 'Push', archived_at: null, exercise_slots: [] },
      isLoading: false,
    };

    beforeEach(() => {
      mockSessionData = session;
    });

    it.each([
      ['the athlete page, on its block', '/coach/students/st-1?program=prog-2'],
      ['the session editor', '/coach/students/st-1/s/sess-1'],
      ['the feed, on its filter', '/coach/sessions?student=st-1'],
    ])('returns to %s', (_label, from) => {
      renderReview({ pathname: REVIEW, state: { from } });
      fireEvent.click(screen.getByLabelText('Back'));
      expect(mockNavigate).toHaveBeenCalledWith(from);
      expect(localStorage.getItem(KEY)).toBeNull();
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
      expect(JSON.parse(localStorage.getItem(KEY))).toEqual({
        studentId: 'st-1',
        sessionId: 'sess-1',
        from: '/coach/students/st-1',
      });
      unmount();

      renderReview(REVIEW);
      fireEvent.click(screen.getByLabelText('Back'));
      expect(mockNavigate).toHaveBeenCalledWith('/coach/students/st-1');
    });

    it('ignores an origin saved for another session', () => {
      localStorage.setItem(
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

  // The sheet now opens a trained session HERE, so this page carries the way
  // into the editor.
  describe('the way into the editor', () => {
    beforeEach(() => {
      mockSessionData = {
        data: { id: 'sess-1', title: 'Push', archived_at: null, exercise_slots: [] },
        isLoading: false,
      };
    });

    it('links to the session editor inside the athlete shell', () => {
      renderReview();
      expect(screen.getByRole('link', { name: /open this session in the editor/i }))
        .toHaveAttribute('href', '/coach/students/st-1/s/sess-1');
    });

    // Leaving through it is deliberate: the Sessions tab must not bounce the
    // coach back into this review afterwards.
    it('forgets the open review when it is used', () => {
      renderReview();
      expect(localStorage.getItem('sl_last_coach_session')).not.toBeNull();
      fireEvent.click(screen.getByRole('link', { name: /open this session in the editor/i }));
      expect(localStorage.getItem('sl_last_coach_session')).toBeNull();
    });
  });

  it('archive button toggles archived state via useArchiveSession', () => {
    mockSessionData = {
      data: { id: 'sess-1', title: 'Push', archived_at: null, exercise_slots: [] },
      isLoading: false,
    };
    renderReview();
    fireEvent.click(screen.getByText('archive'));
    expect(mockArchive.mutate).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      archived: true,
    });
  });

  it('shows "unarchive" label and an archived banner when session is archived', () => {
    mockSessionData = {
      data: {
        id: 'sess-1',
        title: 'Push',
        archived_at: '2026-04-22T10:00:00Z',
        exercise_slots: [],
      },
      isLoading: false,
    };
    renderReview();
    expect(screen.getByText('unarchive')).toBeInTheDocument();
    expect(screen.getByText(/Archived on/i)).toBeInTheDocument();
  });

  it('renders the feedback composer when no feedback exists yet', () => {
    mockSessionData = {
      data: { id: 'sess-1', title: 'Push', archived_at: null, exercise_slots: [] },
      isLoading: false,
    };
    mockConfirmation = confirmationQuery(CONFIRMED);
    renderReview();
    expect(screen.getByPlaceholderText(/What went well/i)).toBeInTheDocument();
    expect(screen.queryByText(/already sent/i)).not.toBeInTheDocument();
  });

  it('replaces the composer with a read-only card when feedback already exists', () => {
    mockSessionData = {
      data: { id: 'sess-1', title: 'Push', archived_at: null, exercise_slots: [] },
      isLoading: false,
    };
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
    expect(screen.getByText(/already sent/i)).toBeInTheDocument();
    expect(screen.getByText('Solid session, push the rep cap next week.')).toBeInTheDocument();
    // Composer must be gone — no textarea, no "Send feedback" button.
    expect(screen.queryByPlaceholderText(/What went well/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /send feedback/i })).not.toBeInTheDocument();
  });

  it('hides both composer and read-only card while feedback is loading', () => {
    mockSessionData = {
      data: { id: 'sess-1', title: 'Push', archived_at: null, exercise_slots: [] },
      isLoading: false,
    };
    mockSessionFeedback = { data: null, isLoading: true };
    mockConfirmation = confirmationQuery(CONFIRMED);
    renderReview();
    expect(screen.queryByPlaceholderText(/What went well/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/already sent/i)).not.toBeInTheDocument();
  });

  it('renders the "reviewed without feedback" card when reviewed_at is set and no feedback exists', () => {
    mockSessionData = {
      data: {
        id: 'sess-1',
        title: 'Push',
        archived_at: null,
        reviewed_at: '2026-04-30T09:00:00Z',
        exercise_slots: [],
      },
      isLoading: false,
    };
    renderReview();
    expect(screen.getByText(/already reviewed/i)).toBeInTheDocument();
    expect(screen.getByText(/finished this review without leaving feedback/i)).toBeInTheDocument();
    // Composer must be gone.
    expect(screen.queryByPlaceholderText(/What went well/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /send feedback/i })).not.toBeInTheDocument();
  });

  it('"Finish without feedback" stamps reviewed_at via the mutation before navigating back', () => {
    mockSessionData = {
      data: { id: 'sess-1', title: 'Push', archived_at: null, exercise_slots: [] },
      isLoading: false,
    };
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
    const composer = () => screen.queryByPlaceholderText(/What went well/i);
    const sendButton = () => screen.queryByRole('button', { name: /send feedback/i });
    const finishButton = () => screen.queryByRole('button', { name: /finish without feedback/i });
    const notConfirmedCard = () => screen.queryByText(/Nothing to review yet/i);
    const uncheckedCard = () => screen.queryByText(/Confirmation not checked/i);

    function expectNoFeedbackForm() {
      expect(composer()).not.toBeInTheDocument();
      expect(sendButton()).not.toBeInTheDocument();
      expect(finishButton()).not.toBeInTheDocument();
    }

    beforeEach(() => {
      mockSessionData = {
        data: { id: 'sess-1', title: 'Push', archived_at: null, exercise_slots: [] },
        isLoading: false,
      };
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

    // What is left to do about a session that cannot be reviewed: write to
    // the athlete, or leave the way the back button does.
    it('leads to the athlete’s thread and back from there', () => {
      renderReview({
        pathname: '/coach/student/st-1/session/sess-1/review',
        state: { from: '/coach/students/st-1' },
      });
      fireEvent.click(screen.getByRole('button', { name: /open thread/i }));
      expect(mockNavigate).toHaveBeenCalledWith('/coach/messages/p-1');

      fireEvent.click(screen.getByRole('button', { name: /back to sessions/i }));
      expect(mockNavigate).toHaveBeenCalledWith('/coach/students/st-1');
      expect(localStorage.getItem('sl_last_coach_session')).toBeNull();
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
        expect(screen.getByText(/Confirmed by student/i)).toBeInTheDocument();
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
        expect(screen.getByText(/Confirmed by student/i)).toBeInTheDocument();
        expect(composer()).toBeInTheDocument();
      });
    });

    // "Not confirmed" is a statement about the athlete. A read that failed
    // says nothing about them.
    describe('when the confirmation cannot be read', () => {
      it('claims nothing, offers no form, and offers to check again', () => {
        mockConfirmation = confirmationQuery(undefined, {
          dataUpdatedAt: 0,
          errorUpdatedAt: AFTER_OPEN,
        });
        renderReview();
        expectNoFeedbackForm();
        expect(screen.queryByText('Not confirmed')).not.toBeInTheDocument();
        expect(notConfirmedCard()).not.toBeInTheDocument();
        expect(uncheckedCard()).toBeInTheDocument();

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
    });

    // Sessions reviewed before the rule existed have no confirmation. Their
    // read-only cards say what happened; nothing can be submitted from them.
    describe('a session already reviewed, without a confirmation', () => {
      it('keeps its "already reviewed" card', () => {
        mockSessionData = {
          data: {
            id: 'sess-1',
            title: 'Push',
            archived_at: null,
            reviewed_at: '2026-04-30T09:00:00Z',
            exercise_slots: [],
          },
          isLoading: false,
        };
        renderReview();
        expect(screen.getByText(/already reviewed/i)).toBeInTheDocument();
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

  const swapSession = {
    id: 'sess-1',
    title: 'Push',
    archived_at: null,
    exercise_slots: [
      { id: 'sl-1', sets: 3, exercise: { id: 'ex-orig', name: 'Ring Dip', type: 'push', difficulty: 2 } },
    ],
  };

  it('offers "Adopt into program" for a swap deviation and adopts via the RPC hook', () => {
    mockSessionData = { data: swapSession, isLoading: false };
    mockConfirmation = confirmationQuery(CONFIRMED);
    mockDeviations = {
      data: [{ exercise_slot_id: 'sl-1', kind: 'swap', substitute_exercise_id: 'ex-sub' }],
      isLoading: false,
    };
    mockLibrary = { data: [{ id: 'ex-sub', name: 'Weighted Dip' }], isLoading: false };
    renderReview();

    const btn = screen.getByRole('button', { name: /adopt into program/i });
    fireEvent.click(btn);
    // Confirm dialog opens with the blast-radius count (preview mock = 2).
    expect(screen.getByText('Adopt swap')).toBeInTheDocument();
    expect(screen.getByText(/2 upcoming sessions/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Adopt$/ }));
    expect(mockAdopt.mutate).toHaveBeenCalledWith(
      { slotId: 'sl-1', substituteId: 'ex-sub', sessionId: 'sess-1' },
      expect.any(Object),
    );
  });

  it('surfaces a promote request and declines it via the RPC hook', () => {
    mockSessionData = { data: swapSession, isLoading: false };
    mockConfirmation = confirmationQuery(CONFIRMED);
    mockDeviations = {
      data: [{
        exercise_slot_id: 'sl-1', kind: 'swap', substitute_exercise_id: 'ex-sub',
        promote_requested_at: '2026-04-26T09:00:00Z',
      }],
      isLoading: false,
    };
    mockLibrary = { data: [{ id: 'ex-sub', name: 'Weighted Dip' }], isLoading: false };
    renderReview();

    expect(screen.getByText(/asked to make this permanent/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Decline$/ }));
    expect(mockDecline.mutate).toHaveBeenCalledWith({ slotId: 'sl-1', sessionId: 'sess-1' });
  });

  it('offers "Remove from upcoming" for a skip deviation and drops it via the RPC hook', () => {
    mockSessionData = { data: swapSession, isLoading: false };
    mockConfirmation = confirmationQuery(CONFIRMED);
    mockDeviations = {
      data: [{ exercise_slot_id: 'sl-1', kind: 'skip', substitute_exercise_id: null }],
      isLoading: false,
    };
    renderReview();
    expect(screen.getByText(/Skipped/)).toBeInTheDocument();
    // A skip has no substitute, so it never offers the swap-adopt action…
    expect(screen.queryByRole('button', { name: /adopt into program/i })).not.toBeInTheDocument();

    // …but it can be dropped forward.
    fireEvent.click(screen.getByRole('button', { name: /remove from upcoming/i }));
    // Dialog opened — blast-radius count (skip preview mock = 3).
    expect(screen.getByText(/3 upcoming sessions/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /remove forward/i }));
    expect(mockSkip.mutate).toHaveBeenCalledWith(
      { slotId: 'sl-1', sessionId: 'sess-1' },
      expect.any(Object),
    );
  });
});
