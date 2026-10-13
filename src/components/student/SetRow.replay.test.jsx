// P56, end to end on the row: sets logged without a network, then replayed.
//
// The rows are rendered from the real cache and written through the real
// hooks; only the database and the rest timer's two entry points are doubles.
// What the athlete did offline is three gestures. What the rows then go
// through when the network returns — a read that does not have the sets yet,
// then each write landing — is not a gesture, and must start no rest and open
// no RPE selector.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider, useQuery, onlineManager } from '@tanstack/react-query';

vi.mock('../../lib/supabase', () => ({
  supabase: {
    from: vi.fn(),
    auth: { getSession: async () => ({ data: { session: { user: { id: 'u-1' } } }, error: null }) },
  },
}));

vi.mock('../../hooks/useRestTimer', async () => {
  const actual = await vi.importActual('../../hooks/useRestTimer');
  return { ...actual, startRestTimer: vi.fn(), clearRestTimer: vi.fn() };
});

import SetRow from './SetRow';
import { supabase } from '../../lib/supabase';
import { startRestTimer, clearRestTimer } from '../../hooks/useRestTimer';

const KEY = ['set-logs', 'sess-1', ['slot-1']];

const pendingRow = (id, set_number) => ({
  id,
  exercise_slot_id: 'slot-1',
  set_number,
  target_reps: 5,
  target_weight_kg: 100,
  target_rest_seconds: 120,
  done: false,
  failed: false,
  skipped: false,
  logged_at: null,
  failed_at: null,
  rpe: null,
  actual_reps: null,
  actual_weight_kg: null,
});

// A `set_logs` table that takes every update at once and answers with the row.
function fakeSetLogs(initial) {
  const server = new Map(initial.map((r) => [r.id, { ...r }]));
  const requests = [];
  supabase.from.mockImplementation(() => {
    const request = {};
    const chain = {
      update: (patch) => {
        request.patch = patch;
        return chain;
      },
      eq: (_column, id) => {
        request.logId = id;
        return chain;
      },
      select: () => chain,
      single: async () => {
        const row = { ...server.get(request.logId), ...request.patch };
        server.set(request.logId, row);
        requests.push(request);
        return { data: { ...row }, error: null };
      },
    };
    return chain;
  });
  // The sets as the database has them at that moment.
  const rows = async () => [...server.values()].map((r) => ({ ...r }));
  return { server, requests, rows };
}

// The list of sets as the session page mounts it: trusted, so it is read again
// only when something asks for it.
function Sets({ read }) {
  const { data } = useQuery({ queryKey: KEY, queryFn: read, staleTime: Infinity });
  return (data || []).map((log) => <SetRow key={log.id} log={log} />);
}

const rpeGrids = () => screen.queryAllByRole('button', { name: /^RPE 5$/i });

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  onlineManager.setOnline(true);
});

describe('a workout logged offline and replayed', () => {
  it('starts one rest per set the athlete marked, and reopens no RPE selector', async () => {
    const user = userEvent.setup();
    const api = fakeSetLogs([pendingRow('a', 1), pendingRow('b', 2)]);
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
    });
    qc.setQueryData(KEY, await api.rows());
    render(
      <QueryClientProvider client={qc}>
        <Sets read={api.rows} />
      </QueryClientProvider>,
    );

    // In the gym, no network: set 1 done and rated, set 2 done.
    onlineManager.setOnline(false);
    await user.click(screen.getAllByRole('button', { name: /mark set done/i })[0]);
    await user.click(screen.getByRole('button', { name: /^RPE 8$/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /RPE 8, tap to change/i })).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /mark set done/i }));
    await waitFor(() => expect(screen.getAllByRole('button', { name: /mark set failed/i })).toHaveLength(2));

    expect(startRestTimer.mock.calls).toEqual([
      ['a', 120],
      ['b', 120],
    ]);
    // Set 2 is waiting for its RPE; set 1 has its own and is closed.
    expect(rpeGrids()).toHaveLength(1);
    expect(api.requests).toHaveLength(0);
    expect(qc.isMutating()).toBe(3);

    // The network returns. A read of the sets answers before the queue has
    // left: nothing of the workout is in it.
    const withoutTheWorkout = await api.rows();
    act(() => {
      qc.setQueryData(KEY, withoutTheWorkout);
    });
    await waitFor(() => expect(screen.getAllByRole('button', { name: /mark set done/i })).toHaveLength(2));

    // Then the three writes land, each putting its row back on screen.
    onlineManager.setOnline(true);
    await act(() => qc.resumePausedMutations());
    await waitFor(() => expect(qc.isMutating()).toBe(0));

    expect(api.requests).toHaveLength(3);
    expect(screen.getAllByRole('button', { name: /mark set failed/i })).toHaveLength(2);
    expect(screen.getByRole('button', { name: /RPE 8, tap to change/i })).toBeInTheDocument();
    // Nothing of that was a gesture.
    expect(startRestTimer).toHaveBeenCalledTimes(2);
    expect(clearRestTimer).not.toHaveBeenCalled();
    expect(rpeGrids()).toHaveLength(1);
  });
});
