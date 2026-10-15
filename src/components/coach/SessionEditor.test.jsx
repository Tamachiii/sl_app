import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useLocation, useNavigate } from 'react-router-dom';
import { ThemeProvider } from '../../hooks/useTheme';

const mockAddSlot = { mutate: vi.fn(), isPending: false };
const mockUpdateSlot = { mutate: vi.fn(), mutateAsync: vi.fn().mockResolvedValue({}) };
const mockDeleteSlot = { mutate: vi.fn() };
const mockDuplicateSession = { mutate: vi.fn(), isPending: false };
let mockSessionData = { data: null, isLoading: false };
let mockLibraryData = { data: [] };
let mockConfirmation = { data: null };

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useParams: () => ({ sessionId: 'sess-1', studentId: 'stu-1' }),
  };
});

vi.mock('../../hooks/useStudents', () => ({
  useStudents: () => ({
    data: [
      { id: 'stu-1', profile: { full_name: 'Alice' } },
      { id: 'stu-2', profile: { full_name: 'Bob' } },
    ],
  }),
}));

const stubProgram = (id) => ({
  data: id ? { id: 'prog-1', weeks: [{ id: 'w-10', week_number: 1, label: null }] } : null,
});

vi.mock('../../hooks/useProgram', () => ({
  useActiveProgram: (sid) => stubProgram(sid),
  useProgram: (pid) => stubProgram(pid),
  // CopyDialog now picks the destination BLOCK before the week, so it needs
  // the athlete's program list rather than just their active one.
  useProgramsForStudent: (sid) => ({
    data: sid ? [{ id: 'prog-1', name: 'Block A', is_active: true }] : [],
  }),
}));

// The "last time" panel runs a real query; this file is about the editor.
vi.mock('../../hooks/useLastPerformance', () => ({
  useLastPerformance: () => ({ data: {}, isLoading: false }),
}));

vi.mock('../../hooks/useSession', () => ({
  useSession: () => mockSessionData,
  useAddSlot: () => mockAddSlot,
  useUpdateSlot: () => mockUpdateSlot,
  useDeleteSlot: () => mockDeleteSlot,
  useUpdateSetTarget: () => ({ mutate: vi.fn(), isPending: false }),
  useResetSlotToUniform: () => ({ mutate: vi.fn(), isPending: false }),
  useRemoveSet: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('../../hooks/useExerciseLibrary', () => ({
  useExerciseLibrary: () => mockLibraryData,
}));

vi.mock('../../hooks/useSessionConfirmation', () => ({
  useSessionConfirmation: () => mockConfirmation,
}));

vi.mock('../../hooks/useDuplicate', () => ({
  useDuplicateSession: () => mockDuplicateSession,
}));

const mockDeleteSession = { mutate: vi.fn(), isPending: false };

vi.mock('../../hooks/useWeek', () => ({
  useUpdateSession: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteSession: () => mockDeleteSession,
  useProgramIdForWeek: () => ({ data: 'prog-1' }),
}));

import SessionEditor from './SessionEditor';

function renderEditor(entry = '/coach/students/stu-1/s/sess-1') {
  return render(
    <ThemeProvider>
      <MemoryRouter initialEntries={[entry]}>
        <SessionEditor />
      </MemoryRouter>
    </ThemeProvider>
  );
}

// What useQuery reports for a read that has not produced a session.
function noSession(overrides = {}) {
  return {
    data: undefined,
    isLoading: false,
    isSuccess: false,
    isError: false,
    isPaused: false,
    isFetching: false,
    fetchStatus: 'idle',
    refetch: vi.fn(),
    ...overrides,
  };
}

describe('SessionEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockConfirmation = { data: null };
    mockLibraryData = {
      data: [
        { id: 'ex-1', name: 'Pull Up', type: 'pull', difficulty: 2, volume_weight: 1 },
        { id: 'ex-2', name: 'Dip', type: 'push', difficulty: 2, volume_weight: 1 },
      ],
    };
  });

  it('renders loading spinner', () => {
    mockSessionData = { data: null, isLoading: true };
    renderEditor();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  // Review items P49 and L11: the editor tested `isLoading` alone, so a read
  // that failed — or a session that is not there — rendered the full editor,
  // empty and writable.
  describe('without a session to show', () => {
    function expectNoEditor() {
      expect(screen.queryByText('+ ADD EXERCISE')).toBeNull();
      expect(screen.queryByText('Delete this session')).toBeNull();
      expect(screen.queryByLabelText('Recommended date')).toBeNull();
      expect(screen.queryByRole('button', { name: /edit session title/i })).toBeNull();
    }

    it('says a failed read failed, and asks again on Retry', async () => {
      const user = userEvent.setup();
      mockSessionData = noSession({ isError: true });
      renderEditor();

      expect(screen.getByText('This couldn’t be loaded')).toBeInTheDocument();
      expectNoEditor();
      await user.click(screen.getByRole('button', { name: 'Try again' }));
      expect(mockSessionData.refetch).toHaveBeenCalledWith({ cancelRefetch: false });
    });

    it('says it waits for the network when the read is paused', () => {
      mockSessionData = noSession({ isPaused: true, fetchStatus: 'paused' });
      renderEditor();

      expect(screen.getByText('This isn’t on this device yet')).toBeInTheDocument();
      expectNoEditor();
    });

    it('says a session that is not there is not found, with the way back to the athlete', () => {
      mockSessionData = noSession({ data: null, isSuccess: true });
      renderEditor();

      expect(screen.getByText('Session not found')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Back to the athlete' })).toHaveAttribute(
        'href',
        '/coach/students/stu-1',
      );
      expectNoEditor();
    });

    // The Athletes tab comes back to the last place the coach was: not to a
    // session that is gone.
    it('forgets the remembered place when the session is not found', () => {
      localStorage.setItem('sl_last_coach_students_path', '/coach/students/stu-1/s/sess-1');
      mockSessionData = noSession({ data: null, isSuccess: true });
      renderEditor();

      expect(localStorage.getItem('sl_last_coach_students_path')).toBeNull();
    });

    it('keeps it when the read only failed: the session may well be there', () => {
      localStorage.setItem('sl_last_coach_students_path', '/coach/students/stu-1/s/sess-1');
      mockSessionData = noSession({ isError: true });
      renderEditor();

      expect(localStorage.getItem('sl_last_coach_students_path')).toBe(
        '/coach/students/stu-1/s/sess-1',
      );
    });
  });

  // Review item P46: leaving the editor went to the athlete's page with no
  // block named, which shows the ACTIVE block — a coach preparing the next
  // block was sent back to the current one after every edit.
  describe('leaving it', () => {
    function Where() {
      const { pathname, search } = useLocation();
      const navigate = useNavigate();
      return (
        <>
          <output data-testid="where">{pathname + search}</output>
          {/* The system's back: one entry back in the history. */}
          <button type="button" onClick={() => navigate(-1)}>system back</button>
        </>
      );
    }

    // The editor at its route, and every other URL printed: where it went.
    function renderAtRoute(entry = '/coach/students/stu-1/s/sess-1') {
      return render(
        <ThemeProvider>
          <MemoryRouter initialEntries={['/coach/students/stu-1', entry]} initialIndex={1}>
            <Routes>
              <Route path="/coach/students/:studentId/s/:sessionId" element={<SessionEditor />} />
              <Route path="*" element={<Where />} />
            </Routes>
          </MemoryRouter>
        </ThemeProvider>
      );
    }

    const sessionIn = (fields) => ({
      data: { title: 'Day 1', exercise_slots: [], ...fields },
      isLoading: false,
      isSuccess: true,
    });

    it('goes back to the block the session is in when it is not the active one', async () => {
      const user = userEvent.setup();
      mockSessionData = sessionIn({ program_id: 'p-next', program_is_active: false });
      renderAtRoute();

      await user.click(screen.getByRole('button', { name: 'Back' }));
      expect(screen.getByTestId('where')).toHaveTextContent('/coach/students/stu-1?program=p-next');
    });

    it('goes back to the athlete page as it opens — the active block — for a session of that block', async () => {
      const user = userEvent.setup();
      mockSessionData = sessionIn({ program_id: 'p-now', program_is_active: true });
      renderAtRoute();

      await user.click(screen.getByRole('button', { name: 'Back' }));
      expect(screen.getByTestId('where').textContent).toBe('/coach/students/stu-1');
    });

    it('takes the place of the editor in the history: the system back does not reopen it', async () => {
      const user = userEvent.setup();
      mockSessionData = sessionIn({ program_id: 'p-next', program_is_active: false });
      renderAtRoute();

      await user.click(screen.getByRole('button', { name: 'Back' }));
      await user.click(screen.getByRole('button', { name: 'system back' }));
      // The athlete page the editor was opened from, not the editor.
      expect(screen.getByTestId('where').textContent).toBe('/coach/students/stu-1');
      expect(screen.queryByText('Day 1')).toBeNull();
    });

    it('returns to that block after deleting the session', async () => {
      const user = userEvent.setup();
      mockSessionData = sessionIn({ program_id: 'p-next', program_is_active: false });
      mockDeleteSession.mutate.mockImplementationOnce((_id, { onSuccess }) => onSuccess());
      renderAtRoute();

      await user.click(screen.getByText('Delete this session'));
      await user.click(screen.getByRole('button', { name: 'Delete' }));
      expect(screen.getByTestId('where')).toHaveTextContent('/coach/students/stu-1?program=p-next');
    });

    it('falls back on its own ?program= while there is no session', () => {
      mockSessionData = noSession({ data: null, isSuccess: true });
      renderAtRoute('/coach/students/stu-1/s/sess-1?program=p-next');

      expect(screen.getByRole('link', { name: 'Back to the athlete' })).toHaveAttribute(
        'href',
        '/coach/students/stu-1?program=p-next',
      );
    });

    // A session cached by a build that did not read `program_id`.
    it('goes to the active block for a session without its block', async () => {
      const user = userEvent.setup();
      mockSessionData = sessionIn({ program_is_active: false });
      renderAtRoute();

      await user.click(screen.getByRole('button', { name: 'Back' }));
      expect(screen.getByTestId('where').textContent).toBe('/coach/students/stu-1');
    });
  });

  it('renders session title', () => {
    mockSessionData = {
      data: { title: 'Push Day', exercise_slots: [] },
      isLoading: false,
    };
    renderEditor();
    expect(screen.getByText('Push Day')).toBeInTheDocument();
  });

  it('clicking "+ Add Exercise" shows the add form', async () => {
    const user = userEvent.setup();
    mockSessionData = {
      data: { title: 'Day 1', exercise_slots: [] },
      isLoading: false,
    };
    renderEditor();

    await user.click(screen.getByText('+ ADD EXERCISE'));
    expect(screen.getByText('Select exercise…')).toBeInTheDocument();
    expect(screen.getByText('Add')).toBeInTheDocument();
    expect(screen.getByText('Cancel')).toBeInTheDocument();
  });

  it('clicking Cancel hides the add form', async () => {
    const user = userEvent.setup();
    mockSessionData = {
      data: { title: 'Day 1', exercise_slots: [] },
      isLoading: false,
    };
    renderEditor();

    await user.click(screen.getByText('+ ADD EXERCISE'));
    await user.click(screen.getByText('Cancel'));
    expect(screen.queryByText('Select exercise…')).not.toBeInTheDocument();
  });

  it('selecting an exercise and clicking Add calls addSlot', async () => {
    const user = userEvent.setup();
    mockSessionData = {
      data: { title: 'Day 1', exercise_slots: [] },
      isLoading: false,
    };
    renderEditor();

    await user.click(screen.getByText('+ ADD EXERCISE'));
    await user.selectOptions(screen.getByRole('combobox'), 'ex-1');
    await user.click(screen.getByText('Add'));

    expect(mockAddSlot.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sess-1',
        exerciseId: 'ex-1',
        sets: 3,
        reps: 10,
      })
    );
  });


  // Duplicate and "copy to…" left this header: the sheet carries both now — a
  // duplicate button on every row, copy behind its selection bar — so keeping
  // them was a second door onto the same actions, above the actual work.
  it('leaves duplicate and copy to the sheet', () => {
    mockSessionData = { data: { title: 'Day 1', exercise_slots: [] }, isLoading: false };
    renderEditor();
    expect(screen.queryByText('duplicate')).toBeNull();
    expect(screen.queryByText('copy to…')).toBeNull();
  });

  // Delete stays — it is the ONLY delete path in the app, and archiving from
  // the sheet does not replace it for a session created by mistake. It moved
  // to the bottom, away from the title.
  it('deletes the session from here — this is the only delete path there is', async () => {
    const user = userEvent.setup();
    mockSessionData = {
      data: { title: 'Day 1', exercise_slots: [] },
      isLoading: false,
    };
    renderEditor();

    await user.click(screen.getByText('Delete this session'));
    // Destructive, so it must go through the confirm step.
    expect(mockDeleteSession.mutate).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(mockDeleteSession.mutate).toHaveBeenCalledWith('sess-1', expect.any(Object));
  });


  it('renders exercise slots', () => {
    mockSessionData = {
      data: {
        title: 'Day 1',
        exercise_slots: [
          {
            id: 'slot-1',
            sets: 3,
            reps: 10,
            weight_kg: 20,
            sort_order: 0,
            exercise: { name: 'Pull Up', type: 'pull', difficulty: 2, volume_weight: 1 },
          },
        ],
      },
      isLoading: false,
    };
    renderEditor();
    // Twice on purpose: once as the slot being edited, once in the "last time"
    // panel, which lists every exercise of the session with what the athlete
    // actually lifted for it.
    expect(screen.getAllByText('Pull Up')).toHaveLength(2);
  });

  // Regression: adding an exercise used to assign sortOrder = slots.length, which
  // collides with existing sort_orders when a prior deletion has left a gap. The
  // collision made superset children render before their parent.
  it('adds a new slot with sortOrder = max(existing)+1 when sort_orders have gaps', async () => {
    const user = userEvent.setup();
    mockSessionData = {
      data: {
        title: 'Day 1',
        exercise_slots: [
          { id: 's-a', sets: 3, reps: 10, sort_order: 0, exercise: { name: 'Pull Up', type: 'pull', difficulty: 2, volume_weight: 1 } },
          // gap at 1 (deleted)
          { id: 's-b', sets: 3, reps: 10, sort_order: 2, exercise: { name: 'Dip', type: 'push', difficulty: 2, volume_weight: 1 } },
          { id: 's-c', sets: 3, reps: 10, sort_order: 5, exercise: { name: 'Pull Up', type: 'pull', difficulty: 2, volume_weight: 1 } },
        ],
      },
      isLoading: false,
    };
    renderEditor();

    await user.click(screen.getByText('+ ADD EXERCISE'));
    await user.selectOptions(screen.getByRole('combobox'), 'ex-2');
    await user.click(screen.getByText('Add'));

    expect(mockAddSlot.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ sortOrder: 6 })
    );
  });

  // Review findings P3 and P12. Every session of the sheet used to open here
  // fully editable, confirmed ones included, and the editor's writes could
  // delete or rewrite what the athlete had logged.
  describe('a session the athlete has trained', () => {
    const pullUp = { name: 'Pull Up', type: 'pull', difficulty: 2, volume_weight: 1 };
    const dip = { name: 'Dip', type: 'push', difficulty: 2, volume_weight: 1 };
    const set = (id, n, extra = {}) => ({
      id, set_number: n, target_reps: 10, target_weight_kg: 20, done: false, ...extra,
    });
    const trainedSlots = [
      {
        id: 'slot-1', sets: 2, reps: 10, weight_kg: 20, sort_order: 0, exercise: pullUp,
        set_logs: [set('a1', 1, { done: true, rpe: 8 }), set('a2', 2)],
      },
      {
        id: 'slot-2', sets: 2, reps: 10, weight_kg: 20, sort_order: 1, exercise: dip,
        set_logs: [set('b1', 1), set('b2', 2)],
      },
    ];

    function reviewLink() {
      return screen.getByRole('link', { name: /open the review/i });
    }

    describe('confirmed', () => {
      beforeEach(() => {
        mockSessionData = {
          data: { title: 'Pull Day', scheduled_date: '2026-10-01', exercise_slots: trainedSlots },
          isLoading: false,
        };
        mockConfirmation = { data: { session_id: 'sess-1', confirmed_at: '2026-10-01T18:00:00Z' } };
      });

      it('says so, and links to the review', () => {
        renderEditor();
        expect(screen.getByRole('note')).toHaveTextContent(/confirmed by the athlete/i);
        expect(screen.getByRole('note')).toHaveTextContent(/read-only/i);
        expect(reviewLink()).toHaveAttribute('href', '/coach/student/stu-1/session/sess-1/review');
      });

      it('is read-only as a whole: nothing left on the page writes', () => {
        renderEditor();
        // Header: the title is text, the date is off.
        expect(screen.getByText('Pull Day')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /edit session title/i })).toBeNull();
        expect(screen.getByLabelText('Recommended date')).toBeDisabled();
        // Every field of every exercise, trained or not.
        const fields = [...screen.getAllByRole('spinbutton'), ...screen.queryAllByRole('textbox')];
        expect(fields.length).toBeGreaterThan(0);
        for (const field of fields) {
          expect(field.disabled || field.readOnly).toBe(true);
        }
        // And none of the structural actions.
        expect(screen.queryByText('+ ADD EXERCISE')).toBeNull();
        expect(screen.queryByText('Delete this session')).toBeNull();
        expect(screen.queryByRole('button', { name: /remove exercise/i })).toBeNull();
        expect(screen.queryByRole('button', { name: /remove set/i })).toBeNull();
        expect(screen.queryByRole('button', { name: /add set/i })).toBeNull();
        expect(screen.queryByRole('button', { name: /^reorder /i })).toBeNull();
      });

      it('hides "unlink" on a superset', () => {
        mockSessionData = {
          data: {
            title: 'Pull Day',
            exercise_slots: trainedSlots.map((sl) => ({ ...sl, superset_group: 'g-1' })),
          },
          isLoading: false,
        };
        renderEditor();
        expect(screen.getByText('Superset')).toBeInTheDocument();
        expect(screen.queryByText('unlink')).toBeNull();
      });

      // `performed_at` is the confirmation mirrored onto the session row. It
      // arrives with the session, so the lock holds while the confirmation
      // query is still loading — or if it fails.
      it('locks on the session row alone, before the confirmation query answers', () => {
        mockConfirmation = { data: undefined };
        mockSessionData = {
          data: {
            title: 'Pull Day',
            performed_at: '2026-10-01T00:00:00Z',
            exercise_slots: [{ ...trainedSlots[1] }],
          },
          isLoading: false,
        };
        renderEditor();
        expect(screen.getByRole('note')).toHaveTextContent(/confirmed by the athlete/i);
        expect(screen.queryByText('+ ADD EXERCISE')).toBeNull();
      });
    });

    describe('started but not confirmed', () => {
      beforeEach(() => {
        mockSessionData = {
          data: { title: 'Pull Day', exercise_slots: trainedSlots },
          isLoading: false,
        };
      });

      it('says which part is locked, and links to the review', () => {
        renderEditor();
        expect(screen.getByRole('note')).toHaveTextContent(/logged sets/i);
        expect(screen.getByRole('note')).not.toHaveTextContent(/read-only/i);
        expect(reviewLink()).toHaveAttribute('href', '/coach/student/stu-1/session/sess-1/review');
      });

      it('locks the logged set and keeps the rest of the session editable', () => {
        renderEditor();
        // Pull Up: set 1 is done, set 2 is still to do.
        expect(screen.getByLabelText('Set 1 reps')).toBeDisabled();
        expect(screen.getByLabelText('Set 2 reps')).toBeEnabled();
        // Dip is untouched: its compact row works as usual.
        expect(screen.getByLabelText('Sets')).toBeEnabled();
        const removeButtons = screen.getAllByRole('button', { name: /remove exercise/i });
        expect(removeButtons.map((b) => b.disabled)).toEqual([true, false]);
        // The session can still grow…
        expect(screen.getByText('+ ADD EXERCISE')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /edit session title/i })).toBeInTheDocument();
        expect(screen.getByLabelText('Recommended date')).toBeEnabled();
        // …but not be deleted: the database refuses a session with logged sets.
        expect(screen.queryByText('Delete this session')).toBeNull();
      });
    });

    it('shows no banner on a session nobody has trained', () => {
      mockSessionData = {
        data: { title: 'Pull Day', exercise_slots: [trainedSlots[1]] },
        isLoading: false,
      };
      renderEditor();
      expect(screen.queryByRole('note')).toBeNull();
      expect(screen.queryByRole('link', { name: /open the review/i })).toBeNull();
      expect(screen.getByText('Delete this session')).toBeInTheDocument();
    });
  });
});
