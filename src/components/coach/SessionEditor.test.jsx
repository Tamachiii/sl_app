import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, Outlet, useLocation, useNavigate } from 'react-router-dom';

const mockAddSlot = { mutate: vi.fn(), isPending: false };
const mockUpdateSlot = { mutate: vi.fn(), mutateAsync: vi.fn().mockResolvedValue({}) };
const mockReorderSlots = { mutate: vi.fn(), isPending: false };
const mockUseReorderSlots = vi.fn(() => mockReorderSlots);
const mockDeleteSlot = { mutate: vi.fn() };
const mockUpdateSession = { mutate: vi.fn(), isPending: false };
const mockDeleteSession = { mutate: vi.fn(), isPending: false };
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
  useReorderSlots: (...args) => mockUseReorderSlots(...args),
}));

// dnd-kit measures the page to follow a pointer, and jsdom lays nothing out: a
// drag cannot be made here. The context is the real one, inside an element
// that carries its `onDragEnd`, which `drop()` calls.
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

// The real module underneath, for `isActiveExercise`: the picker leaves out
// what the library page counts as archived.
vi.mock('../../hooks/useExerciseLibrary', async () => ({
  ...(await vi.importActual('../../hooks/useExerciseLibrary')),
  useExerciseLibrary: () => mockLibraryData,
}));

vi.mock('../../hooks/useSessionConfirmation', () => ({
  useSessionConfirmation: () => mockConfirmation,
}));

vi.mock('../../hooks/useWeek', () => ({
  useUpdateSession: () => mockUpdateSession,
  useDeleteSession: () => mockDeleteSession,
}));

import SessionEditor from './SessionEditor';

const ALICE = { id: 'stu-1', profile: { full_name: 'Alice' } };

// The editor stands in the athlete's page (CoachHome), which hands it the
// athlete through its outlet.
function AthleteShell({ student }) {
  return <Outlet context={{ student }} />;
}

function renderEditor(entry = '/coach/students/stu-1/s/sess-1', { student = ALICE } = {}) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route element={<AthleteShell student={student} />}>
          <Route path="/coach/students/:studentId/s/:sessionId" element={<SessionEditor />} />
        </Route>
      </Routes>
    </MemoryRouter>
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

// The header's round buttons (a Parc LargeTitle), and the title, which is a
// button named by its text and described by what a tap does.
const backButton = () => screen.getByRole('button', { name: 'Back to the program' });
const optionsButton = () => screen.queryByRole('button', { name: 'Session options' });
const renameButton = () => screen.queryByRole('button', { description: 'Rename the session' });
const addExerciseButton = () => screen.queryByRole('button', { name: 'Add an exercise' });
// The round "Remove {name}" of each exercise — not the "Remove set n" of a
// per-set row.
const removeExerciseButtons = () => screen.queryAllByRole('button', { name: /^Remove (?!set \d)/ });
const moveButtons = () => screen.queryAllByRole('button', { name: /^Move / });

// "Session options" → "Delete the session": the question it asks.
async function askToDelete(user) {
  await user.click(optionsButton());
  const options = screen.getByRole('dialog', { name: 'Session options' });
  await user.click(within(options).getByRole('button', { name: 'Delete the session' }));
  return screen.getByRole('dialog', { name: 'Delete this session?' });
}

describe('SessionEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    mockConfirmation = { data: null };
    mockLibraryData = {
      data: [
        { id: 'ex-1', name: 'Pull Up', type: 'pull', difficulty: 2, volume_weight: 1 },
        { id: 'ex-2', name: 'Dip', type: 'push', difficulty: 2, volume_weight: 1 },
      ],
    };
  });

  // The header stands while the session is read: the way back, under a title
  // that names the kind of page.
  it('renders loading spinner', () => {
    mockSessionData = { data: null, isLoading: true };
    renderEditor();
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Session' })).toBeInTheDocument();
    expect(backButton()).toBeInTheDocument();
  });

  // Review items P49 and L11: the editor tested `isLoading` alone, so a read
  // that failed — or a session that is not there — rendered the full editor,
  // empty and writable.
  describe('without a session to show', () => {
    function expectNoEditor() {
      // The header stays — the way back, titled "Session" — and nothing that writes.
      expect(screen.getByRole('heading', { level: 1, name: 'Session' })).toBeInTheDocument();
      expect(backButton()).toBeInTheDocument();
      expect(addExerciseButton()).toBeNull();
      expect(optionsButton()).toBeNull();
      expect(screen.queryByLabelText('Recommended date')).toBeNull();
      expect(renameButton()).toBeNull();
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
      sessionStorage.setItem('sl_last_coach_students_path', '/coach/students/stu-1/s/sess-1');
      mockSessionData = noSession({ data: null, isSuccess: true });
      renderEditor();

      expect(sessionStorage.getItem('sl_last_coach_students_path')).toBeNull();
    });

    it('keeps it when the read only failed: the session may well be there', () => {
      sessionStorage.setItem('sl_last_coach_students_path', '/coach/students/stu-1/s/sess-1');
      mockSessionData = noSession({ isError: true });
      renderEditor();

      expect(sessionStorage.getItem('sl_last_coach_students_path')).toBe(
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
        <MemoryRouter initialEntries={['/coach/students/stu-1', entry]} initialIndex={1}>
          <Routes>
            <Route element={<AthleteShell student={ALICE} />}>
              <Route path="/coach/students/:studentId/s/:sessionId" element={<SessionEditor />} />
            </Route>
            <Route path="*" element={<Where />} />
          </Routes>
        </MemoryRouter>
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

      await user.click(backButton());
      expect(screen.getByTestId('where')).toHaveTextContent('/coach/students/stu-1?program=p-next');
    });

    it('goes back to the athlete page as it opens — the active block — for a session of that block', async () => {
      const user = userEvent.setup();
      mockSessionData = sessionIn({ program_id: 'p-now', program_is_active: true });
      renderAtRoute();

      await user.click(backButton());
      expect(screen.getByTestId('where').textContent).toBe('/coach/students/stu-1');
    });

    it('takes the place of the editor in the history: the system back does not reopen it', async () => {
      const user = userEvent.setup();
      mockSessionData = sessionIn({ program_id: 'p-next', program_is_active: false });
      renderAtRoute();

      await user.click(backButton());
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

      const confirm = await askToDelete(user);
      await user.click(within(confirm).getByRole('button', { name: 'Delete the session' }));
      expect(screen.getByTestId('where')).toHaveTextContent('/coach/students/stu-1?program=p-next');
    });

    it('falls back on its own ?program= while there is no session', async () => {
      const user = userEvent.setup();
      mockSessionData = noSession({ data: null, isSuccess: true });
      renderAtRoute('/coach/students/stu-1/s/sess-1?program=p-next');

      expect(screen.getByRole('link', { name: 'Back to the athlete' })).toHaveAttribute(
        'href',
        '/coach/students/stu-1?program=p-next',
      );
      // The header's way back goes to the same place.
      await user.click(backButton());
      expect(screen.getByTestId('where')).toHaveTextContent('/coach/students/stu-1?program=p-next');
    });

    // The header is there while the read has nothing to show, and leaves.
    it('leaves from a page whose read failed too', async () => {
      const user = userEvent.setup();
      mockSessionData = noSession({ isError: true });
      renderAtRoute();

      await user.click(backButton());
      expect(screen.getByTestId('where').textContent).toBe('/coach/students/stu-1');
    });

    // A session cached by a build that did not read `program_id`.
    it('goes to the active block for a session without its block', async () => {
      const user = userEvent.setup();
      mockSessionData = sessionIn({ program_is_active: false });
      renderAtRoute();

      await user.click(backButton());
      expect(screen.getByTestId('where').textContent).toBe('/coach/students/stu-1');
    });
  });

  // Review item P53: an athlete's draft is theirs until the coach approves it.
  describe('a session of a draft written by the athlete', () => {
    const draftSlot = {
      id: 'slot-1', sets: 2, reps: 10, weight_kg: 20, sort_order: 0,
      exercise: { name: 'Pull Up', type: 'pull', difficulty: 2, volume_weight: 1 },
      set_logs: [],
    };

    beforeEach(() => {
      mockSessionData = {
        data: { title: 'Draft day', program_status: 'draft', program_is_active: false, exercise_slots: [draftSlot] },
        isLoading: false,
        isSuccess: true,
      };
    });

    it('says it is a draft, and why it cannot be edited', () => {
      renderEditor();
      expect(screen.getByRole('note')).toHaveTextContent(/draft written by your athlete/i);
      expect(screen.getByRole('note')).toHaveTextContent(/read-only until you approve/i);
      // Not the banner of a trained session: there is no review to open.
      expect(screen.queryByRole('link', { name: /open the review/i })).toBeNull();
    });

    it('is read-only as a whole', () => {
      renderEditor();
      // The title is text, not the way to rename it.
      expect(screen.getByRole('heading', { level: 1, name: 'Draft day' })).toBeInTheDocument();
      expect(renameButton()).toBeNull();
      expect(screen.queryByRole('button', { name: 'Draft day' })).toBeNull();
      expect(screen.getByLabelText('Recommended date')).toBeDisabled();
      for (const field of [...screen.getAllByRole('spinbutton'), ...screen.queryAllByRole('textbox')]) {
        expect(field.disabled || field.readOnly).toBe(true);
      }
      expect(addExerciseButton()).toBeNull();
      expect(optionsButton()).toBeNull();
      expect(removeExerciseButtons()).toHaveLength(0);
      expect(moveButtons()).toHaveLength(0);
    });

    it('is editable once approved', () => {
      mockSessionData = {
        ...mockSessionData,
        data: { ...mockSessionData.data, program_status: 'approved' },
      };
      renderEditor();
      expect(screen.queryByRole('note')).toBeNull();
      expect(addExerciseButton()).toBeInTheDocument();
      expect(screen.getByLabelText('Recommended date')).toBeEnabled();
      expect(renameButton()).toBeInTheDocument();
      expect(optionsButton()).toBeInTheDocument();
    });
  });

  // Review item B27: a drag sent one update per moved slot, with no cache
  // write — the list snapped back until the refetches landed — and a drop
  // between two members of a superset could split it.
  describe('moving an exercise', () => {
    const ex = { name: 'Pull Up', type: 'pull', difficulty: 2, volume_weight: 1 };
    const slot = (id, sortOrder, group = null) => ({
      id, sets: 3, reps: 10, sort_order: sortOrder, superset_group: group, exercise: ex, set_logs: [],
    });

    function drop(activeId, overId) {
      const context = document.querySelector('[data-dnd]');
      act(() => context.onDrop({ active: { id: activeId }, over: { id: overId } }));
    }

    it('sends ONE write for the drag, with the whole new order', () => {
      mockSessionData = {
        data: { title: 'Day 1', exercise_slots: [slot('a', 0), slot('b', 1), slot('c', 2)] },
        isLoading: false,
      };
      renderEditor();
      drop('c', 'a');

      expect(mockReorderSlots.mutate).toHaveBeenCalledTimes(1);
      expect(mockReorderSlots.mutate).toHaveBeenCalledWith({
        orderedIds: ['c', 'a', 'b'],
        changes: [
          { id: 'c', sort_order: 0, superset_group: null },
          { id: 'a', sort_order: 1, superset_group: null },
          { id: 'b', sort_order: 2, superset_group: null },
        ],
      });
      expect(mockUpdateSlot.mutate).not.toHaveBeenCalled();
      expect(mockUpdateSlot.mutateAsync).not.toHaveBeenCalled();
    });

    it('joins the superset it is dropped into, rather than splitting it', () => {
      mockSessionData = {
        data: { title: 'Day 1', exercise_slots: [slot('x', 0), slot('a', 1, 'g'), slot('b', 2, 'g')] },
        isLoading: false,
      };
      renderEditor();
      drop('x', 'a');

      const [{ orderedIds, changes }] = mockReorderSlots.mutate.mock.calls[0];
      expect(orderedIds).toEqual(['a', 'x', 'b']);
      expect(changes).toContainEqual({ id: 'x', sort_order: 1, superset_group: 'g' });
    });

    it('sends nothing for a drop on itself', () => {
      mockSessionData = {
        data: { title: 'Day 1', exercise_slots: [slot('a', 0), slot('b', 1)] },
        isLoading: false,
      };
      renderEditor();
      drop('a', 'a');
      drop('a', null);

      expect(mockReorderSlots.mutate).not.toHaveBeenCalled();
    });

    it('runs the writes of each session under that session', () => {
      mockSessionData = { data: { title: 'Day 1', exercise_slots: [] }, isLoading: false };
      renderEditor();
      expect(mockUseReorderSlots).toHaveBeenCalledWith('sess-1');
    });
  });

  // Review item L15: the back button was 36px. The header's round buttons are
  // Parc's: 44px, held by test/hitTargets.test.js.
  it('has a back button a thumb can hit: 44px', () => {
    mockSessionData = { data: { title: 'Day 1', exercise_slots: [] }, isLoading: false };
    renderEditor();
    expect(backButton()).toHaveClass('pk-icon-btn');
    expect(optionsButton()).toHaveClass('pk-icon-btn');
  });

  // Review item B8, the coach's half: an exercise this coach cannot read
  // comes as `exercise: null`, and ExerciseSlotRow reads its name.
  it('shows a slot whose exercise cannot be read as such, and the others as usual', () => {
    mockSessionData = {
      data: {
        title: 'Day 1',
        exercise_slots: [
          { id: 'slot-1', sets: 3, reps: 10, sort_order: 0, exercise: null, set_logs: [] },
          {
            id: 'slot-2', sets: 3, reps: 10, sort_order: 1, set_logs: [],
            exercise: { name: 'Dip', type: 'push', difficulty: 2, volume_weight: 1 },
          },
        ],
      },
      isLoading: false,
    };
    renderEditor();

    expect(screen.getByRole('heading', { level: 2, name: 'Exercise unavailable' })).toBeInTheDocument();
    expect(screen.getByText(/a library you can’t read/i)).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Dip' })).toBeInTheDocument();
    expect(removeExerciseButtons().map((b) => b.getAttribute('aria-label'))).toEqual(['Remove Dip']);
  });

  // The page of the session (design/parc/screens/Editeur.dc.html): its name
  // as the title, a tap renames it, and the athlete under it.
  describe('the title', () => {
    it('renders session title', () => {
      mockSessionData = {
        data: { title: 'Push Day', exercise_slots: [] },
        isLoading: false,
      };
      renderEditor();
      const title = screen.getByRole('heading', { level: 1, name: 'Push Day' });
      // The title is the way to rename it: a button named by its text.
      expect(within(title).getByRole('button', { name: 'Push Day' })).toBe(renameButton());
    });

    it('renames the session on a tap', async () => {
      const user = userEvent.setup();
      mockSessionData = { data: { title: 'Push Day', exercise_slots: [] }, isLoading: false };
      renderEditor();

      await user.click(renameButton());
      const field = screen.getByRole('textbox', { name: 'Rename the session' });
      expect(field).toHaveFocus();
      await user.clear(field);
      await user.type(field, 'Upper body{Enter}');
      expect(mockUpdateSession.mutate).toHaveBeenCalledWith({ id: 'sess-1', title: 'Upper body' });
      expect(screen.getByRole('heading', { level: 1 })).toContainElement(renameButton());
    });

    it('names a session without a title "Session"', () => {
      mockSessionData = { data: { title: null, exercise_slots: [] }, isLoading: false };
      renderEditor();
      expect(screen.getByRole('heading', { level: 1, name: 'Session' })).toBeInTheDocument();
      expect(renameButton()).toHaveAccessibleName('Session');
    });

    it('puts the athlete under it', () => {
      mockSessionData = { data: { title: 'Push Day', exercise_slots: [] }, isLoading: false };
      renderEditor();
      const header = screen.getByRole('heading', { level: 1, name: 'Push Day' }).closest('header');
      expect(within(header).getByText('Alice')).toBeInTheDocument();
    });

    it('writes no line under it for an athlete without a name', () => {
      mockSessionData = { data: { title: 'Push Day', exercise_slots: [] }, isLoading: false };
      renderEditor(undefined, { student: { id: 'stu-1', profile: { full_name: '  ' } } });
      const header = screen.getByRole('heading', { level: 1, name: 'Push Day' }).closest('header');
      expect(header.querySelector('p')).toBeNull();
    });
  });

  it('writes the recommended date, and clears it', () => {
    mockSessionData = {
      data: { title: 'Day 1', scheduled_date: '2026-10-19', exercise_slots: [] },
      isLoading: false,
    };
    renderEditor();
    const date = screen.getByLabelText('Recommended date');
    expect(date).toHaveAttribute('id', 'session-date');
    expect(date).toHaveValue('2026-10-19');

    fireEvent.change(date, { target: { value: '2026-10-20' } });
    expect(mockUpdateSession.mutate).toHaveBeenLastCalledWith({ id: 'sess-1', scheduled_date: '2026-10-20' });
    fireEvent.change(date, { target: { value: '' } });
    expect(mockUpdateSession.mutate).toHaveBeenLastCalledWith({ id: 'sess-1', scheduled_date: null });
  });

  describe('adding an exercise', () => {
    beforeEach(() => {
      mockSessionData = {
        data: { title: 'Day 1', exercise_slots: [] },
        isLoading: false,
      };
    });

    const exercisePicker = () => screen.queryByRole('combobox', { name: 'Exercise' });

    it('clicking "Add an exercise" shows the add form', async () => {
      const user = userEvent.setup();
      renderEditor();

      await user.click(addExerciseButton());
      expect(exercisePicker()).toHaveDisplayValue('Choose an exercise');
      const unit = screen.getByRole('group', { name: 'Counted in' });
      expect(within(unit).getByRole('radio', { name: 'Reps' })).toBeChecked();
      expect(within(unit).getByRole('radio', { name: 'Seconds held' })).not.toBeChecked();
      // Nothing to pair with in an empty session.
      expect(screen.queryByRole('checkbox', { name: 'In a superset with the one before' })).toBeNull();
      // Nothing to add before an exercise is chosen.
      expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    });

    it('clicking Cancel hides the add form', async () => {
      const user = userEvent.setup();
      renderEditor();

      await user.click(addExerciseButton());
      await user.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(exercisePicker()).toBeNull();
      expect(addExerciseButton()).toBeInTheDocument();
    });

    it('names each exercise by its name, type and level', async () => {
      const user = userEvent.setup();
      renderEditor();
      await user.click(addExerciseButton());
      expect([...exercisePicker().options].map((o) => o.textContent)).toEqual([
        'Choose an exercise',
        'Pull Up, Pull, level 2',
        'Dip, Push, level 2',
      ]);
    });

    it('selecting an exercise and clicking Add calls addSlot', async () => {
      const user = userEvent.setup();
      renderEditor();

      await user.click(addExerciseButton());
      await user.selectOptions(exercisePicker(), 'ex-1');
      await user.click(screen.getByRole('button', { name: 'Add' }));

      expect(mockAddSlot.mutate).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'sess-1',
          exerciseId: 'ex-1',
          sets: 3,
          reps: 10,
        })
      );
      expect(mockAddSlot.mutate.mock.calls[0][0]).not.toHaveProperty('durationSeconds');
      // The form closes behind it.
      expect(exercisePicker()).toBeNull();
    });

    it('adds a held exercise in seconds, not reps', async () => {
      const user = userEvent.setup();
      renderEditor();

      await user.click(addExerciseButton());
      await user.selectOptions(exercisePicker(), 'ex-1');
      await user.click(screen.getByRole('radio', { name: 'Seconds held' }));
      await user.click(screen.getByRole('button', { name: 'Add' }));

      const [added] = mockAddSlot.mutate.mock.calls[0];
      expect(added).toMatchObject({ exerciseId: 'ex-1', sets: 3, durationSeconds: 30 });
      expect(added).not.toHaveProperty('reps');
    });

    it('pairs it with the exercise before in a superset when asked', async () => {
      const user = userEvent.setup();
      mockSessionData = {
        data: {
          title: 'Day 1',
          exercise_slots: [
            { id: 's-a', sets: 3, reps: 10, sort_order: 0, exercise: { name: 'Pull Up', type: 'pull', difficulty: 2, volume_weight: 1 }, set_logs: [] },
          ],
        },
        isLoading: false,
      };
      renderEditor();

      await user.click(addExerciseButton());
      await user.selectOptions(exercisePicker(), 'ex-2');
      await user.click(screen.getByRole('checkbox', { name: 'In a superset with the one before' }));
      await user.click(screen.getByRole('button', { name: 'Add' }));

      // The exercise before joins a new superset, and the new one with it.
      expect(mockUpdateSlot.mutate).toHaveBeenCalledTimes(1);
      const [{ id, superset_group: group }] = mockUpdateSlot.mutate.mock.calls[0];
      expect(id).toBe('s-a');
      expect(group).toEqual(expect.any(String));
      expect(mockAddSlot.mutate).toHaveBeenCalledWith(
        expect.objectContaining({ exerciseId: 'ex-2', supersetGroup: group }),
      );
    });

    it('joins the superset the exercise before is already in', async () => {
      const user = userEvent.setup();
      mockSessionData = {
        data: {
          title: 'Day 1',
          exercise_slots: [
            { id: 's-a', sets: 3, reps: 10, sort_order: 0, superset_group: 'g-1', exercise: { name: 'Pull Up', type: 'pull', difficulty: 2, volume_weight: 1 }, set_logs: [] },
          ],
        },
        isLoading: false,
      };
      renderEditor();

      await user.click(addExerciseButton());
      await user.selectOptions(exercisePicker(), 'ex-2');
      await user.click(screen.getByRole('checkbox', { name: 'In a superset with the one before' }));
      await user.click(screen.getByRole('button', { name: 'Add' }));

      expect(mockUpdateSlot.mutate).not.toHaveBeenCalled();
      expect(mockAddSlot.mutate).toHaveBeenCalledWith(expect.objectContaining({ supersetGroup: 'g-1' }));
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

      await user.click(addExerciseButton());
      await user.selectOptions(exercisePicker(), 'ex-2');
      await user.click(screen.getByRole('button', { name: 'Add' }));

      expect(mockAddSlot.mutate).toHaveBeenCalledWith(
        expect.objectContaining({ sortOrder: 6 })
      );
    });
  });

  // Review decision P18: an exercise in use is archived instead of deleted,
  // and an archived one is not offered for new work.
  describe('an archived exercise', () => {
    const ARCHIVED_AT = '2026-10-15T08:00:00.000Z';
    beforeEach(() => {
      mockLibraryData = {
        data: [
          { id: 'ex-1', name: 'Pull Up', type: 'pull', difficulty: 2, volume_weight: 1, archived_at: null },
          { id: 'ex-2', name: 'Dip', type: 'push', difficulty: 2, volume_weight: 1, archived_at: ARCHIVED_AT },
          // A row read before the column existed is on offer.
          { id: 'ex-3', name: 'Row', type: 'pull', difficulty: 1, volume_weight: 1 },
        ],
      };
    });

    it('is not offered when an exercise is added', async () => {
      const user = userEvent.setup();
      mockSessionData = { data: { title: 'Day 1', exercise_slots: [] }, isLoading: false };
      renderEditor();
      await user.click(addExerciseButton());
      const values = [...screen.getByRole('combobox', { name: 'Exercise' }).options].map((o) => o.value);
      expect(values).toEqual(['', 'ex-1', 'ex-3']);
    });

    it('still shows on the slot that holds it, which stays editable', () => {
      mockSessionData = {
        data: {
          title: 'Day 1',
          exercise_slots: [
            {
              id: 'slot-1', sets: 3, reps: 10, sort_order: 0, set_logs: [],
              exercise: { id: 'ex-2', name: 'Dip', type: 'push', difficulty: 2, volume_weight: 1, archived_at: ARCHIVED_AT },
            },
          ],
        },
        isLoading: false,
      };
      renderEditor();
      // The slot, and the "last time" panel that lists the session's exercises.
      expect(screen.getAllByText('Dip')).toHaveLength(2);
      expect(screen.getByRole('heading', { level: 2, name: 'Dip' })).toBeInTheDocument();
      expect(screen.queryByText('Exercise unavailable')).toBeNull();
      expect(removeExerciseButtons().map((b) => b.getAttribute('aria-label'))).toEqual(['Remove Dip']);
      expect(screen.getByLabelText('Sets')).toBeEnabled();
    });
  });

  // Duplicate and "copy to…" left this header: the sheet carries both now — a
  // duplicate button on every row, copy behind its selection bar — so keeping
  // them was a second door onto the same actions, above the actual work. The
  // session's options hold its delete alone.
  it('leaves duplicate and copy to the sheet', async () => {
    const user = userEvent.setup();
    mockSessionData = { data: { title: 'Day 1', exercise_slots: [] }, isLoading: false };
    renderEditor();
    expect(screen.queryByRole('button', { name: /duplicate|copy/i })).toBeNull();
    await user.click(optionsButton());
    const options = screen.getByRole('dialog', { name: 'Session options' });
    expect(within(options).getAllByRole('button').map((b) => b.getAttribute('aria-label') || b.textContent))
      .toEqual(['Close', 'Delete the session']);
  });

  // Delete stays — it is the ONLY delete path in the app, and archiving from
  // the sheet does not replace it for a session created by mistake. It lives
  // in the session's options, away from the work.
  it('deletes the session from here — this is the only delete path there is', async () => {
    const user = userEvent.setup();
    mockSessionData = {
      data: { title: 'Day 1', exercise_slots: [] },
      isLoading: false,
    };
    renderEditor();

    await user.click(optionsButton());
    const options = screen.getByRole('dialog', { name: 'Session options' });
    await user.click(within(options).getByRole('button', { name: 'Delete the session' }));
    // The options give way to the question.
    expect(options.open).toBe(false);
    const confirm = screen.getByRole('dialog', { name: 'Delete this session?' });
    // Destructive, so it must go through the confirm step.
    expect(mockDeleteSession.mutate).not.toHaveBeenCalled();
    expect(confirm).toHaveTextContent('It cannot be undone.');
    await user.click(within(confirm).getByRole('button', { name: 'Delete the session' }));
    expect(mockDeleteSession.mutate).toHaveBeenCalledWith('sess-1', expect.any(Object));
  });

  it('deletes nothing when the question is cancelled', async () => {
    const user = userEvent.setup();
    mockSessionData = { data: { title: 'Day 1', exercise_slots: [] }, isLoading: false };
    renderEditor();

    const confirm = await askToDelete(user);
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(confirm.open).toBe(false);
    expect(mockDeleteSession.mutate).not.toHaveBeenCalled();
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
    expect(screen.getByRole('region', { name: 'Pull Up' })).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Last time' })).getByText('Pull Up')).toBeInTheDocument();
  });

  // A superset is drawn as one group, which the coach can take apart.
  describe('a superset', () => {
    const ex = (name) => ({ name, type: 'pull', difficulty: 2, volume_weight: 1 });
    beforeEach(() => {
      mockSessionData = {
        data: {
          title: 'Day 1',
          exercise_slots: [
            { id: 's-a', sets: 3, reps: 10, sort_order: 0, superset_group: 'g-1', exercise: ex('Pull Up'), set_logs: [] },
            { id: 's-b', sets: 3, reps: 10, sort_order: 1, superset_group: 'g-1', exercise: ex('Row'), set_logs: [] },
            { id: 's-c', sets: 3, reps: 10, sort_order: 2, superset_group: null, exercise: ex('Dip'), set_logs: [] },
          ],
        },
        isLoading: false,
      };
    });

    it('is named as one, with its exercises', () => {
      renderEditor();
      expect(screen.getAllByText('In a superset')).toHaveLength(1);
      const group = screen.getByText('In a superset').parentElement.parentElement;
      expect(within(group).getByRole('region', { name: 'Pull Up' })).toBeInTheDocument();
      expect(within(group).getByRole('region', { name: 'Row' })).toBeInTheDocument();
      expect(within(group).queryByRole('region', { name: 'Dip' })).toBeNull();
    });

    it('is separated: each of its exercises leaves the group', async () => {
      const user = userEvent.setup();
      renderEditor();
      await user.click(screen.getByRole('button', { name: 'Separate this superset' }));
      expect(mockUpdateSlot.mutate).toHaveBeenCalledTimes(2);
      expect(mockUpdateSlot.mutate).toHaveBeenCalledWith({ id: 's-a', sessionId: 'sess-1', superset_group: null });
      expect(mockUpdateSlot.mutate).toHaveBeenCalledWith({ id: 's-b', sessionId: 'sess-1', superset_group: null });
    });
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
        // Header: the title is text, the date is off, no options.
        expect(screen.getByRole('heading', { level: 1, name: 'Pull Day' })).toBeInTheDocument();
        expect(renameButton()).toBeNull();
        expect(screen.getByLabelText('Recommended date')).toBeDisabled();
        expect(optionsButton()).toBeNull();
        // Every field of every exercise, trained or not.
        const fields = [...screen.getAllByRole('spinbutton'), ...screen.queryAllByRole('textbox')];
        expect(fields.length).toBeGreaterThan(0);
        for (const field of fields) {
          expect(field.disabled || field.readOnly).toBe(true);
        }
        // And none of the structural actions.
        expect(addExerciseButton()).toBeNull();
        expect(removeExerciseButtons()).toHaveLength(0);
        expect(screen.queryByRole('button', { name: /^Remove set/ })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Add a set' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Set by set' })).toBeNull();
        expect(moveButtons()).toHaveLength(0);
      });

      it('hides "Separate" on a superset', () => {
        mockSessionData = {
          data: {
            title: 'Pull Day',
            exercise_slots: trainedSlots.map((sl) => ({ ...sl, superset_group: 'g-1' })),
          },
          isLoading: false,
        };
        renderEditor();
        expect(screen.getByText('In a superset')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Separate this superset' })).toBeNull();
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
        expect(addExerciseButton()).toBeNull();
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

      // `from` is how the review's back button returns to this editor.
      it('opens the review with the way back to this editor', async () => {
        const user = userEvent.setup();
        function ReviewProbe() {
          const { state } = useLocation();
          return <output data-testid="from">{state?.from}</output>;
        }
        render(
          <MemoryRouter initialEntries={['/coach/students/stu-1/s/sess-1']}>
            <Routes>
              <Route path="/coach/students/:studentId/s/:sessionId" element={<SessionEditor />} />
              <Route path="/coach/student/:studentId/session/:sessionId/review" element={<ReviewProbe />} />
            </Routes>
          </MemoryRouter>
        );
        await user.click(reviewLink());
        expect(screen.getByTestId('from')).toHaveTextContent('/coach/students/stu-1/s/sess-1');
      });

      it('locks the logged set and keeps the rest of the session editable', () => {
        renderEditor();
        // Pull Up: set 1 is done, set 2 is still to do.
        expect(screen.getByLabelText('Set 1, reps')).toBeDisabled();
        expect(screen.getByLabelText('Set 2, reps')).toBeEnabled();
        // Dip is untouched: its compact row works as usual.
        expect(screen.getByLabelText('Sets')).toBeEnabled();
        expect(removeExerciseButtons().map((b) => [b.getAttribute('aria-label'), b.disabled])).toEqual([
          ['Remove Pull Up', true],
          ['Remove Dip', false],
        ]);
        // The session can still grow…
        expect(addExerciseButton()).toBeInTheDocument();
        expect(renameButton()).toBeInTheDocument();
        expect(screen.getByLabelText('Recommended date')).toBeEnabled();
        // …but not be deleted: the database refuses a session with logged sets.
        expect(optionsButton()).toBeNull();
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
      expect(optionsButton()).toBeInTheDocument();
    });
  });
});
