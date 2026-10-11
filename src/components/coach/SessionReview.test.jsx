import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

let mockSessionData = { data: null, isLoading: false };
let mockSetLogsData = { data: [], isLoading: false };
let mockConfirmation = { data: null, isLoading: false };
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
    useParams: () => ({ studentId: 'st-1', sessionId: 'sess-1' }),
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
  useSessionConfirmation: () => mockConfirmation,
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
function renderReview(entry = '/coach/student/st-1/session/sess-1/review') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <SessionReview />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mockSessionData = { data: null, isLoading: false };
  mockSetLogsData = { data: [], isLoading: false };
  mockConfirmation = { data: null, isLoading: false };
  mockSessionFeedback = { data: null, isLoading: false };
  mockDeviations = { data: [], isLoading: false };
  mockLibrary = { data: [], isLoading: false };
  mockNavigate.mockReset();
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

  it('renders "Not yet confirmed" placeholder when no confirmation exists', () => {
    mockSessionData = {
      data: { id: 'sess-1', title: 'Push', archived_at: null, exercise_slots: [] },
      isLoading: false,
    };
    renderReview();
    expect(screen.getByText(/Not yet confirmed by the student/i)).toBeInTheDocument();
  });

  it('renders the green confirmed banner with the student notes', () => {
    mockSessionData = {
      data: { id: 'sess-1', title: 'Push', archived_at: null, exercise_slots: [] },
      isLoading: false,
    };
    mockConfirmation = {
      data: {
        confirmed_at: '2026-04-25T14:00:00Z',
        notes: 'felt strong',
      },
      isLoading: false,
    };
    renderReview();
    expect(screen.getByText(/Confirmed by student/i)).toBeInTheDocument();
    expect(screen.getByText(/felt strong/)).toBeInTheDocument();
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
    mockConfirmation = { data: { confirmed_at: '2026-04-25T14:00:00Z' }, isLoading: false };
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
    mockConfirmation = { data: { confirmed_at: '2026-04-25T14:00:00Z' }, isLoading: false };
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
    mockConfirmation = { data: { confirmed_at: '2026-04-25T14:00:00Z' }, isLoading: false };
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
