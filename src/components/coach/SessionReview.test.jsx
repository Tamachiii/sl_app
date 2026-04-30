import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

let mockSessionData = { data: null, isLoading: false };
let mockSetLogsData = { data: [], isLoading: false };
let mockConfirmation = { data: null, isLoading: false };
let mockSessionFeedback = { data: null, isLoading: false };
const mockNavigate = vi.fn();
const mockArchive = { mutate: vi.fn(), isPending: false };

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
}));
vi.mock('../../hooks/useSetLogs', () => ({
  useSetLogs: () => mockSetLogsData,
}));
vi.mock('../../hooks/useSlotComments', () => ({
  useSlotComments: () => ({ data: [], isLoading: false }),
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

function renderReview() {
  return render(
    <MemoryRouter>
      <SessionReview />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mockSessionData = { data: null, isLoading: false };
  mockSetLogsData = { data: [], isLoading: false };
  mockConfirmation = { data: null, isLoading: false };
  mockSessionFeedback = { data: null, isLoading: false };
  mockNavigate.mockReset();
  mockArchive.mutate.mockReset();
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
});
