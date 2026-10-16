import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';

// SessionReview.test.jsx hands the page a hand-built confirmation query. This
// file runs the page on the REAL useSessionConfirmation and a real query
// client, so that what the page reads off the query — `dataUpdatedAt`,
// `errorUpdatedAt`, `isPaused`, and the forced read on mount — is React
// Query's behaviour and not an assumption about it. Only the network is
// stubbed: `server` is what `session_confirmations` answers.
let server = { data: null, error: null };
const confirmationReads = vi.fn();

vi.mock('../../lib/supabase', () => ({
  supabase: {
    from: (table) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            confirmationReads(table);
            return server;
          },
        }),
      }),
    }),
  },
}));
vi.mock('../../hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'coach-1' } }) }));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ studentId: 'st-1', sessionId: 'sess-1' }) };
});
vi.mock('../../hooks/useSession', () => ({
  useSession: () => ({
    data: { id: 'sess-1', title: 'Push', archived_at: null, exercise_slots: [] },
    isLoading: false,
  }),
  useMarkSessionReviewed: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('../../hooks/useSetLogs', () => ({ useSetLogs: () => ({ data: [] }) }));
vi.mock('../../hooks/useSlotComments', () => ({ useSlotComments: () => ({ data: [] }) }));
vi.mock('../../hooks/useSlotDeviations', () => ({ useSlotDeviations: () => ({ data: [] }) }));
vi.mock('../../hooks/useExerciseLibrary', () => ({ useExerciseLibrary: () => ({ data: [] }) }));
vi.mock('../../hooks/useOnlineStatus', () => ({ useOnlineStatus: () => true }));
vi.mock('../../hooks/useAdoptSwap', () => ({
  useDeclinePromote: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('../../hooks/useSetVideo', () => ({ useSetVideos: () => ({ data: [] }) }));
vi.mock('../../hooks/useWeek', () => ({
  useArchiveSession: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('../../hooks/useStudents', () => ({
  useStudents: () => ({ data: [{ id: 'st-1', profile_id: 'p-1', profile: { full_name: 'Sam' } }] }),
}));
vi.mock('../../hooks/useMessages', () => ({
  useSendMessage: () => ({ mutate: vi.fn(), isPending: false }),
  useSessionFeedback: () => ({ data: null, isLoading: false }),
  formatMessageStamp: () => 'Apr 30',
}));

import SessionReview from './SessionReview';

const KEY = ['session-confirmation', 'sess-1'];
const ROW = { id: 'c-1', session_id: 'sess-1', confirmed_at: '2026-04-25T14:00:00Z', notes: null };

// The app's defaults that decide this (lib/queryClient.js): an answer is
// served from the cache for two minutes, a failed read is retried once, and a
// read attempted offline waits for the network instead of failing.
function appLikeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 1000 * 60 * 2,
        retry: 1,
        retryDelay: 1,
        networkMode: 'offlineFirst',
        gcTime: Infinity,
      },
    },
  });
}

// What the coach's device remembers from a visit half a minute ago: well
// inside the two minutes, so nothing but the review's own request re-reads it.
function remembered(qc, row) {
  qc.setQueryData(KEY, row, { updatedAt: Date.now() - 30_000 });
}

function renderReview(qc) {
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/coach/student/st-1/session/sess-1/review']}>
        <SessionReview />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const composer = () => screen.queryByPlaceholderText(/What went well/i);
const finishButton = () => screen.queryByRole('button', { name: /finish without feedback/i });

beforeEach(() => {
  server = { data: null, error: null };
  confirmationReads.mockReset();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => {
  onlineManager.setOnline(true);
});

describe('<SessionReview /> on the real confirmation query', () => {
  // The stale "Session completed" notification.
  it('never offers the form on a remembered confirmation the athlete has undone', async () => {
    const qc = appLikeClient();
    remembered(qc, ROW);
    server = { data: null, error: null };
    renderReview(qc);

    // First paint, from the cache: the confirmation is shown, the form is not.
    expect(screen.getByText(/Confirmed by student/i)).toBeInTheDocument();
    expect(composer()).not.toBeInTheDocument();
    expect(finishButton()).not.toBeInTheDocument();

    expect(await screen.findByText('Not confirmed')).toBeInTheDocument();
    expect(screen.getByText(/Nothing to review yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/Confirmed by student/i)).not.toBeInTheDocument();
    expect(composer()).not.toBeInTheDocument();
    expect(finishButton()).not.toBeInTheDocument();
    expect(confirmationReads).toHaveBeenCalledTimes(1);
    expect(confirmationReads).toHaveBeenCalledWith('session_confirmations');
  });

  it('offers it once a remembered confirmation is read again', async () => {
    const qc = appLikeClient();
    remembered(qc, ROW);
    server = { data: ROW, error: null };
    renderReview(qc);
    expect(composer()).not.toBeInTheDocument();

    expect(await screen.findByPlaceholderText(/What went well/i)).toBeInTheDocument();
    expect(finishButton()).toBeInTheDocument();
    expect(confirmationReads).toHaveBeenCalledTimes(1);
  });

  it('does not say "not confirmed" on a remembered absence the athlete has since confirmed', async () => {
    const qc = appLikeClient();
    remembered(qc, null);
    server = { data: ROW, error: null };
    renderReview(qc);
    expect(screen.queryByText('Not confirmed')).not.toBeInTheDocument();
    expect(screen.queryByText(/Nothing to review yet/i)).not.toBeInTheDocument();

    expect(await screen.findByPlaceholderText(/What went well/i)).toBeInTheDocument();
    expect(screen.getByText(/Confirmed by student/i)).toBeInTheDocument();
    expect(screen.queryByText('Not confirmed')).not.toBeInTheDocument();
  });

  it('says the read failed, not that the session is unconfirmed, and recovers on "Check again"', async () => {
    const qc = appLikeClient();
    server = { data: null, error: { message: 'upstream timeout' } };
    renderReview(qc);

    expect(await screen.findByText(/Confirmation not checked/i)).toBeInTheDocument();
    expect(screen.queryByText('Not confirmed')).not.toBeInTheDocument();
    expect(screen.queryByText(/Nothing to review yet/i)).not.toBeInTheDocument();
    expect(composer()).not.toBeInTheDocument();
    // One read and its one retry.
    expect(confirmationReads).toHaveBeenCalledTimes(2);

    server = { data: ROW, error: null };
    fireEvent.click(screen.getByRole('button', { name: /check again/i }));
    expect(await screen.findByPlaceholderText(/What went well/i)).toBeInTheDocument();
    expect(screen.queryByText(/Confirmation not checked/i)).not.toBeInTheDocument();
  });

  it('holds the form back while offline, and offers it when the read gets through', async () => {
    const qc = appLikeClient();
    remembered(qc, ROW);
    onlineManager.setOnline(false);
    server = { data: null, error: { message: 'Failed to fetch' } };
    renderReview(qc);

    // The read is parked until the network is back: not a failure, not a "no".
    expect(await screen.findByText(/Confirmation not checked/i)).toBeInTheDocument();
    expect(screen.getByText(/Confirmed by student/i)).toBeInTheDocument();
    expect(screen.queryByText('Not confirmed')).not.toBeInTheDocument();
    expect(composer()).not.toBeInTheDocument();

    server = { data: ROW, error: null };
    onlineManager.setOnline(true);
    expect(await screen.findByPlaceholderText(/What went well/i)).toBeInTheDocument();
    expect(screen.queryByText(/Confirmation not checked/i)).not.toBeInTheDocument();
  });

  // The composer holds the coach's unsent text in its own state: unmounting it
  // loses the text. A refetch that fails after the confirmation was read for
  // this visit must not do that.
  it('keeps the composer and its text when a later refetch fails', async () => {
    const qc = appLikeClient();
    server = { data: ROW, error: null };
    renderReview(qc);
    const box = await screen.findByPlaceholderText(/What went well/i);
    fireEvent.change(box, { target: { value: 'Good depth on the dips.' } });

    server = { data: null, error: { message: 'upstream timeout' } };
    await qc.refetchQueries({ queryKey: KEY });
    await waitFor(() => expect(qc.getQueryState(KEY).status).toBe('error'));

    expect(composer()).toHaveValue('Good depth on the dips.');
    expect(screen.queryByText(/Confirmation not checked/i)).not.toBeInTheDocument();
  });
});
