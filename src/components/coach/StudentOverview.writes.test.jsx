import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, Outlet, Link, useParams } from 'react-router-dom';
import { QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { createTestQueryClient } from '../../test/utils';
import { supabase } from '../../lib/supabase';

// The writes are the real ones — `useReorderSessions`, `useMoveSession`,
// `useReorderWeeks` and `useReorderPrograms`, down to the request — because
// what this file holds is where a write goes once the page has moved on to
// another block or another athlete. Only the reads are stand-ins.
vi.mock('../../lib/supabase', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}));

const PROGRAMS = {
  's-1': [
    { id: 'p-1', name: 'Block one', is_active: true, sort_order: 0 },
    { id: 'p-2', name: 'Block two', is_active: false, sort_order: 1 },
  ],
  's-2': [
    { id: 'p-7', name: 'Block seven', is_active: true, sort_order: 0 },
    { id: 'p-8', name: 'Block eight', is_active: false, sort_order: 1 },
  ],
};

function session(id, title, sortOrder) {
  return { id, title, day_number: null, sort_order: sortOrder, archived_at: null, exercise_slots: [] };
}

const BLOCKS = {
  'p-1': {
    id: 'p-1',
    weeks: [
      { id: 'w-1', program_id: 'p-1', week_number: 1, label: 'Base', sessions: [session('a', 'Pull', 0), session('b', 'Push', 1)] },
      { id: 'w-2', program_id: 'p-1', week_number: 2, label: 'Peak', sessions: [session('c', 'Legs', 0)] },
    ],
  },
  'p-2': {
    id: 'p-2',
    weeks: [
      { id: 'w-9', program_id: 'p-2', week_number: 1, label: null, sessions: [session('x', 'Handstand', 0), session('y', 'Rings', 1)] },
    ],
  },
  'p-7': { id: 'p-7', weeks: [] },
};

vi.mock('../../hooks/useProgram', async (importOriginal) => ({
  ...(await importOriginal()),
  useProgramsForStudent: (studentId) => ({ data: PROGRAMS[studentId] ?? [], isSuccess: true }),
  useProgram: (programId) => ({ data: BLOCKS[programId] ?? null }),
  useTrashedPrograms: () => ({ data: [] }),
}));
vi.mock('../../hooks/useSessionConfirmation', () => ({
  useProgramConfirmedSessionIds: () => ({ data: new Set() }),
  useReviewCounts: () => ({ data: {} }),
}));
vi.mock('../../hooks/useSession', () => ({
  useProgramLoggedSessionIds: () => ({ data: new Set() }),
}));
vi.mock('../../hooks/useStudents', () => ({
  useStudents: () => ({ data: [] }),
}));

// dnd-kit measures the page to follow a pointer, and jsdom lays nothing out:
// a drag cannot be made here. The context is the real one, inside an element
// that carries its `onDragEnd` — the sheet and the open switcher each have a
// context, and `drop()` takes the one around the row it is told about.
vi.mock('@dnd-kit/core', async (importOriginal) => {
  const actual = await importOriginal();
  const RealContext = actual.DndContext;
  return {
    ...actual,
    DndContext: (props) => (
      <div
        data-dnd
        ref={(el) => {
          if (el) el.onDrop = props.onDragEnd;
        }}
      >
        <RealContext {...props} />
      </div>
    ),
  };
});

import StudentOverview from './StudentOverview';

// The athlete's page as `CoachHome` hosts it: one route, the athlete in the
// outlet context. The link is the bell's — a notification about another
// athlete leads from one athlete's page straight to the other's, on the same
// route, so nothing above the section is mounted again.
function AthletePage() {
  const { studentId } = useParams();
  return (
    <>
      <Link to="/coach/students/s-2">other athlete</Link>
      <Outlet context={{ student: { id: studentId } }} />
    </>
  );
}

function renderSection() {
  const qc = createTestQueryClient();
  const invalidate = vi.spyOn(qc, 'invalidateQueries');
  render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/coach/students/s-1']}>
        <Routes>
          <Route path="/coach/students/:studentId" element={<AthletePage />}>
            <Route index element={<StudentOverview />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { qc, invalidate };
}

function drop(row, activeId, overId) {
  const context = row.closest('[data-dnd]');
  act(() => context.onDrop({ active: { id: activeId }, over: { id: overId } }));
}

async function pickBlock(user, name) {
  await user.click(screen.getByRole('button', { description: 'Choose the block' }));
  await user.click(screen.getByRole('option', { name: new RegExp(name) }));
}

// A request the test answers when it chooses to.
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const OK = { data: null, error: null };
// Long enough for a request that is not held back to have gone out.
const settle = () => new Promise((r) => setTimeout(r, 25));

beforeEach(() => {
  vi.clearAllMocks();
  supabase.rpc.mockReset();
  supabase.from.mockReset();
});

afterEach(() => {
  onlineManager.setOnline(true);
});

// Review of P51. The sheet's three order hooks wait in one queue per block and
// the switcher's reorder in one per athlete. A hook that stays mounted while
// its block or its athlete changes re-points the write it has waiting at the
// new queue, where it is never given its turn: these tests fail without the
// `key` on `ProgramSheet` and on `ProgramSwitcher`.
describe('a write that was waiting when the page moved on', () => {
  it('is still sent after the coach has picked another block, and the block is read again', async () => {
    const first = deferred();
    supabase.rpc.mockReturnValueOnce(first.promise).mockResolvedValue(OK);
    const user = userEvent.setup();
    const { invalidate } = renderSection();

    // Block one: a reorder on its way, and a move across the divider behind it.
    drop(screen.getByText('Pull'), 'b', 'a');
    await waitFor(() => expect(supabase.rpc).toHaveBeenCalledTimes(1));
    drop(screen.getByText('Pull'), 'a', 'c');
    await act(settle);
    expect(supabase.rpc).toHaveBeenCalledTimes(1);

    await pickBlock(user, 'Block two');
    expect(await screen.findByText('Handstand')).toBeInTheDocument();
    expect(screen.queryByText('Pull')).not.toBeInTheDocument();
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['program'] });

    first.resolve(OK);
    await waitFor(() => expect(supabase.rpc).toHaveBeenCalledTimes(2));
    expect(supabase.rpc.mock.calls.map(([fn]) => fn)).toEqual(['reorder_sessions', 'move_session']);
    expect(supabase.rpc.mock.calls[1][1]).toEqual({
      p_session_id: 'a',
      p_dest_week_id: 'w-2',
      p_source_ids: ['b'],
      p_dest_ids: ['a', 'c'],
    });
    // The last write of the run is the one that reads the server again.
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['program'] }));

    // And the block now on screen has a queue of its own, which is free.
    drop(screen.getByText('Handstand'), 'y', 'x');
    await waitFor(() => expect(supabase.rpc).toHaveBeenCalledTimes(3));
    expect(supabase.rpc.mock.calls[2]).toEqual([
      'reorder_sessions',
      { p_week_id: 'w-9', p_ids: ['y', 'x'] },
    ]);
  });

  it('is sent with the others once the network is back: a drag in each of two blocks, made offline', async () => {
    supabase.rpc.mockResolvedValue(OK);
    const user = userEvent.setup();
    renderSection();

    act(() => onlineManager.setOnline(false));
    drop(screen.getByText('Pull'), 'b', 'a');
    await pickBlock(user, 'Block two');
    drop(await screen.findByText('Handstand'), 'y', 'x');
    await act(settle);
    expect(supabase.rpc).not.toHaveBeenCalled();

    act(() => onlineManager.setOnline(true));
    await waitFor(() => expect(supabase.rpc).toHaveBeenCalledTimes(2));
    expect(supabase.rpc.mock.calls.map(([, args]) => args.p_week_id).sort()).toEqual(['w-1', 'w-9']);
  });

  // The switcher has ONE order hook, so a drag that is on its way is no longer
  // the write the hook holds once a second one is made — the case that is lost
  // is the one below, where each athlete's drag is the only one of its queue.
  it('is sent with the others once the network is back: the blocks of two athletes reordered offline', async () => {
    // One `programs` update per block and per pass.
    const updates = [];
    supabase.from.mockImplementation(() => ({
      update: (patch) => ({
        eq: (_column, id) => {
          updates.push([id, patch.sort_order]);
          return Promise.resolve(OK);
        },
      }),
    }));
    const user = userEvent.setup();
    const { invalidate } = renderSection();
    const list = () => within(screen.getByRole('listbox'));

    act(() => onlineManager.setOnline(false));
    await user.click(screen.getByRole('button', { description: 'Choose the block' }));
    drop(list().getByText('Block one'), 'p-2', 'p-1');

    await user.click(screen.getByRole('link', { name: 'other athlete' }));
    const trigger = await screen.findByRole('button', { description: 'Choose the block' });
    expect(trigger).toHaveTextContent('Block seven');
    await user.click(trigger);
    drop(list().getByText('Block seven'), 'p-8', 'p-7');
    await act(settle);
    expect(updates).toHaveLength(0);

    act(() => onlineManager.setOnline(true));
    // Two passes of two requests for each athlete.
    await waitFor(() => expect(updates).toHaveLength(8));
    const placed = (ids) => updates.filter(([id, order]) => ids.includes(id) && order < 100000);
    expect(placed(['p-1', 'p-2'])).toEqual([['p-2', 0], ['p-1', 1]]);
    expect(placed(['p-7', 'p-8'])).toEqual([['p-8', 0], ['p-7', 1]]);
    // Each athlete's list is read again by the drag that wrote it.
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['programs', 's-2'] }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['programs', 's-1'] });
  });
});
