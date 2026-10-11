import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// The page on the REAL useSession and a real query client. SessionView.test.jsx
// mocks the hook and checks WHEN the page asks for the session row again; this
// file checks what asking does — that a row the cache would have served as it
// is gets read, that the read is one request and not two, and that its answer
// is what locks the page. Those are React Query's behaviour, not an assumption
// about it.

vi.mock('../../lib/supabase', () => ({ supabase: { from: vi.fn() } }));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useParams: () => ({ sessionId: 'sess-1' }) };
});

vi.mock('../../hooks/useSetLogs', () => ({
  useSetLogs: () => ({ data: [], isLoading: false }),
  useEnsureSetLogs: () => ({ mutate: vi.fn() }),
  useToggleSetDone: () => ({ mutate: vi.fn() }),
  useSetFailed: () => ({ mutate: vi.fn() }),
  useSetRpe: () => ({ mutate: vi.fn() }),
  useLogActual: () => ({ mutate: vi.fn() }),
  useSetSkipped: () => ({ mutate: vi.fn() }),
  useAddStudentSet: () => ({ mutate: vi.fn(), isPending: false }),
  useRemoveStudentSet: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('../../hooks/useSlotDeviations', () => ({
  useSlotDeviations: () => ({ data: [], isLoading: false }),
  useSaveSlotDeviation: () => ({ mutate: vi.fn(), isPending: false }),
  useRequestPromote: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('../../hooks/useLastPerformance', () => ({
  useLastPerformance: () => ({ data: {} }),
}));

vi.mock('../../hooks/useExerciseLibrary', () => ({
  useExerciseLibrary: () => ({ data: [], isLoading: false }),
}));

vi.mock('../../hooks/useOnlineStatus', () => ({
  useOnlineStatus: () => true,
}));

vi.mock('../../hooks/useSlotComments', () => ({
  useSlotComments: () => ({ data: [], isLoading: false }),
  useSaveSlotComment: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('../../hooks/useSetVideo', () => ({
  useSetVideos: () => ({ data: [], isLoading: false }),
  useUploadSetVideo: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteSetVideo: () => ({ mutate: vi.fn(), isPending: false }),
  useSetVideoSignedUrl: () => ({ data: null, isLoading: false }),
}));

// Not part of what is tested, and both reach for the Supabase client.
vi.mock('../../hooks/useRestTimerPush', () => ({ useRestTimerPush: () => {} }));
vi.mock('../../hooks/useRestTimerEffects', () => ({ useRestTimerEffects: () => {} }));

let mockConfirmation = { data: null, isLoading: false };

vi.mock('../../hooks/useSessionConfirmation', () => ({
  useSessionConfirmation: () => mockConfirmation,
  useConfirmSession: () => ({ mutate: vi.fn(), isPending: false }),
  useUnconfirmSession: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('../../hooks/useMessages', () => ({
  useSessionFeedback: () => ({ data: null }),
  formatMessageStamp: () => 'stamp',
}));

import SessionView from './SessionView';
import { supabase } from '../../lib/supabase';

const REVIEWED_AT = '2026-04-15T09:00:00Z';
const SESSION_KEY = ['session', 'sess-1'];
const CONFIRMATION = {
  id: 'c-1',
  session_id: 'sess-1',
  student_id: 'u-1',
  confirmed_at: '2026-04-14T10:00:00Z',
  notes: null,
};

// The row as the cache holds it: what useSession's queryFn returns.
function cachedRow(fields = {}) {
  return {
    id: 'sess-1',
    title: 'Day 1',
    program_is_active: true,
    reviewed_at: null,
    exercise_slots: [],
    ...fields,
  };
}

// The row as the server answers. A new object per read: the queryFn edits it.
function serverRow(fields = {}) {
  return {
    id: 'sess-1',
    title: 'Day 1',
    weeks: { programs: { is_active: true } },
    reviewed_at: null,
    exercise_slots: [],
    ...fields,
  };
}

// The `sessions` read of useSession: from().select().eq().single().
function answerWith(single) {
  const chain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single,
  };
  supabase.from.mockReturnValue(chain);
  return chain;
}

// The app's own freshness window (lib/queryClient.js), so "fresh" means here
// what it means there.
function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: 1000 * 60 * 2, retry: false, gcTime: Infinity },
    },
  });
}

function renderSessionView(qc) {
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <SessionView />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

const undoButton = () => screen.queryByRole('button', { name: /undo confirmation/i });
const lockLine = () => screen.queryByText(/reviewed by your coach/i);

beforeEach(() => {
  vi.clearAllMocks();
  mockConfirmation = { data: null, isLoading: false };
});

describe('SessionView on the real session query: learning of a review', () => {
  it('reads a FRESH cached row again for a confirmed session, and the answer locks the page', async () => {
    mockConfirmation = { data: CONFIRMATION, isLoading: false };
    const qc = makeClient();
    // Read a moment ago: React Query alone would serve it without a request.
    qc.setQueryData(SESSION_KEY, cachedRow());
    // Since then the coach has reviewed the session.
    const chain = answerWith(
      vi.fn(async () => ({ data: serverRow({ reviewed_at: REVIEWED_AT }), error: null }))
    );

    renderSessionView(qc);

    // First paint is the cache: not reviewed, Undo offered.
    expect(undoButton()).toBeInTheDocument();
    expect(lockLine()).toBeNull();

    await waitFor(() => expect(lockLine()).toBeInTheDocument());
    expect(undoButton()).toBeNull();
    expect(screen.getByRole('link', { name: /message your coach/i })).toHaveAttribute(
      'href',
      '/student/messages'
    );
    expect(supabase.from).toHaveBeenCalledWith('sessions');
    expect(chain.single).toHaveBeenCalledTimes(1);
  });

  it('keeps Undo when the answer still says "not reviewed", and does not ask in a loop', async () => {
    mockConfirmation = { data: CONFIRMATION, isLoading: false };
    const qc = makeClient();
    qc.setQueryData(SESSION_KEY, cachedRow());
    const chain = answerWith(vi.fn(async () => ({ data: serverRow(), error: null })));

    renderSessionView(qc);

    await waitFor(() => expect(chain.single).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(qc.isFetching({ queryKey: SESSION_KEY })).toBe(0));
    expect(undoButton()).toBeInTheDocument();
    expect(lockLine()).toBeNull();
    expect(chain.single).toHaveBeenCalledTimes(1);
  });

  it('joins the request React Query makes for a STALE row instead of sending a second one', async () => {
    mockConfirmation = { data: CONFIRMATION, isLoading: false };
    const qc = makeClient();
    // Ten minutes old: stale, so mounting the query refetches by itself.
    qc.setQueryData(SESSION_KEY, cachedRow(), { updatedAt: Date.now() - 10 * 60 * 1000 });
    let answer;
    const chain = answerWith(vi.fn(() => new Promise((resolve) => { answer = resolve; })));

    renderSessionView(qc);

    // Both askers have had their turn; one request is on its way.
    await waitFor(() => expect(chain.single).toHaveBeenCalledTimes(1));
    answer({ data: serverRow({ reviewed_at: REVIEWED_AT }), error: null });

    await waitFor(() => expect(lockLine()).toBeInTheDocument());
    expect(chain.single).toHaveBeenCalledTimes(1);
  });

  it('leaves a session in progress to the cache', async () => {
    const qc = makeClient();
    qc.setQueryData(SESSION_KEY, cachedRow());
    const chain = answerWith(vi.fn(async () => ({ data: serverRow(), error: null })));

    renderSessionView(qc);

    expect(screen.getByRole('button', { name: /^confirm session$/i })).toBeInTheDocument();
    // Give an unwanted request the time to start.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(chain.single).not.toHaveBeenCalled();
  });

  it('a read that fails leaves the page as the cache had it', async () => {
    mockConfirmation = { data: CONFIRMATION, isLoading: false };
    const qc = makeClient();
    qc.setQueryData(SESSION_KEY, cachedRow());
    const chain = answerWith(
      vi.fn(async () => ({ data: null, error: new Error('Failed to fetch') }))
    );

    renderSessionView(qc);

    await waitFor(() => expect(chain.single).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(qc.isFetching({ queryKey: SESSION_KEY })).toBe(0));
    expect(screen.getByText('Day 1')).toBeInTheDocument();
    expect(undoButton()).toBeInTheDocument();
    expect(lockLine()).toBeNull();
  });
});
