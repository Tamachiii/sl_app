import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

let mockMyDraft = { data: null, isLoading: false };
let mockTree = { data: null, isLoading: false };
const mockCreate = { mutate: vi.fn(), isPending: false };
const mockActions = {
  addWeek: vi.fn(), addSession: vi.fn(), addSlot: vi.fn(), updateSlot: vi.fn(),
  deleteRow: vi.fn(), submit: vi.fn(), discard: vi.fn(), saving: false,
};
let mockOnline = true;
let mockLibrary = [];

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => vi.fn() };
});
vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({ profile: { full_name: 'Sam Lee' }, signOut: vi.fn() }),
}));
vi.mock('../../hooks/useOnlineStatus', () => ({ useOnlineStatus: () => mockOnline }));
// The real isActiveExercise: the picker filters with it.
vi.mock('../../hooks/useExerciseLibrary', async () => {
  const actual = await vi.importActual('../../hooks/useExerciseLibrary');
  return { ...actual, useExerciseLibrary: () => ({ data: mockLibrary }) };
});
vi.mock('../../hooks/useAuthoring', () => ({
  useMyDraft: () => mockMyDraft,
  useDraftTree: () => mockTree,
  useCreateDraft: () => mockCreate,
  useDraftActions: () => mockActions,
}));
vi.mock('../../components/notifications/NotificationBell', () => ({ default: () => null }), { virtual: true });

import StudentProgramAuthor from './StudentProgramAuthor';

function renderAuthor() {
  return render(<MemoryRouter><StudentProgramAuthor /></MemoryRouter>);
}

beforeEach(() => {
  mockMyDraft = { data: null, isLoading: false };
  mockTree = { data: null, isLoading: false };
  mockOnline = true;
  mockLibrary = [];
  vi.clearAllMocks();
});

describe('<StudentProgramAuthor />', () => {
  it('offers to create a draft when the student has none, and creates one', () => {
    renderAuthor();
    const input = screen.getByPlaceholderText(/off-season/i);
    fireEvent.change(input, { target: { value: 'My block' } });
    fireEvent.click(screen.getByRole('button', { name: /create draft/i }));
    expect(mockCreate.mutate).toHaveBeenCalledWith({ name: 'My block' });
  });

  it('stays editable offline — Create is enabled and the banner says changes sync', () => {
    mockOnline = false;
    renderAuthor();
    expect(screen.getByText(/changes sync when you reconnect/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create draft/i })).not.toBeDisabled();
  });

  it('renders the draft tree and gates submit until an exercise exists', () => {
    mockMyDraft = { data: { id: 'p-1', name: 'Block A', status: 'draft', submitted_at: null }, isLoading: false };
    mockTree = {
      data: {
        id: 'p-1', name: 'Block A', status: 'draft', submitted_at: null,
        weeks: [{ id: 'w-1', week_number: 1, sessions: [
          { id: 's-1', title: 'Day 1', sort_order: 0, exercise_slots: [
            { id: 'sl-1', exercise_id: 'e-1', sets: 3, reps: 5, sort_order: 0, exercise: { id: 'e-1', name: 'Squat', type: 'push' } },
          ] },
        ] }],
      },
      isLoading: false,
    };
    renderAuthor();
    expect(screen.getByText('Block A')).toBeInTheDocument();
    expect(screen.getByText('Week 1')).toBeInTheDocument();
    expect(screen.getByText('Squat')).toBeInTheDocument();
    const submitBtn = screen.getByRole('button', { name: /submit for approval/i });
    expect(submitBtn).not.toBeDisabled();
    fireEvent.click(submitBtn);
    expect(mockActions.submit).toHaveBeenCalled();
  });

  it('adds a week via the optimistic action (works offline)', () => {
    mockOnline = false;
    mockMyDraft = { data: { id: 'p-1', name: 'Block A', status: 'draft', submitted_at: null }, isLoading: false };
    mockTree = { data: { id: 'p-1', name: 'Block A', status: 'draft', submitted_at: null, weeks: [] }, isLoading: false };
    renderAuthor();
    fireEvent.click(screen.getByRole('button', { name: /add week/i }));
    expect(mockActions.addWeek).toHaveBeenCalled();
  });

  it('shows the submitted state (read-only) once submitted', () => {
    mockMyDraft = { data: { id: 'p-1', name: 'Block A', status: 'draft', submitted_at: '2026-04-26T00:00:00Z' }, isLoading: false };
    mockTree = { data: { id: 'p-1', name: 'Block A', status: 'draft', submitted_at: '2026-04-26T00:00:00Z', weeks: [] }, isLoading: false };
    renderAuthor();
    expect(screen.getByText(/awaiting coach/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /submit for approval/i })).not.toBeInTheDocument();
  });

  // P31. The sets, reps and kg of a slot were `type="number"` fields: "62,5"
  // gave "" in WebKit — saved as null, bodyweight — and 625 in a Chromium
  // whose UI is English, and garbage in sets or reps was quietly made 1. They
  // are text fields read by lib/number now, and a slot is not written while
  // one of them says something it cannot hold.
  describe('the fields of a slot', () => {
    function renderSlot(slot = {}) {
      mockMyDraft = { data: { id: 'p-1', name: 'Block A', status: 'draft', submitted_at: null }, isLoading: false };
      mockTree = {
        data: {
          id: 'p-1', name: 'Block A', status: 'draft', submitted_at: null,
          weeks: [{ id: 'w-1', week_number: 1, sessions: [
            { id: 's-1', title: 'Day 1', sort_order: 0, exercise_slots: [
              { id: 'sl-1', exercise_id: 'e-1', sets: 3, reps: 5, weight_kg: null, sort_order: 0,
                exercise: { id: 'e-1', name: 'Squat', type: 'push' }, ...slot },
            ] },
          ] }],
        },
        isLoading: false,
      };
      renderAuthor();
    }
    const sets = () => screen.getByRole('textbox', { name: 'sets' });
    const reps = () => screen.getByRole('textbox', { name: 'reps' });
    const kg = () => screen.getByRole('textbox', { name: 'kg' });

    // Replaces what the field holds, then leaves it: the blur commits.
    async function enter(user, field, text) {
      await user.clear(field);
      if (text) await user.type(field, text);
      await user.tab();
    }

    it('are text fields with a numeric keypad, opening on the slot', () => {
      renderSlot({ weight_kg: '62.50' });
      expect(sets()).toHaveAttribute('type', 'text');
      expect(sets()).toHaveAttribute('inputmode', 'numeric');
      expect(reps()).toHaveAttribute('inputmode', 'numeric');
      expect(kg()).toHaveAttribute('inputmode', 'decimal');
      expect(sets()).toHaveValue('3');
      expect(reps()).toHaveValue('5');
      expect(kg()).toHaveValue('62.5');
    });

    it.each(['62,5', '62.5'])('"%s" kg is written as 62.5', async (text) => {
      const user = userEvent.setup();
      renderSlot();
      await enter(user, kg(), text);
      expect(mockActions.updateSlot).toHaveBeenCalledWith('sl-1', { sets: 3, reps: 5, weight_kg: 62.5 });
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('a load left empty is bodyweight: null', async () => {
      const user = userEvent.setup();
      renderSlot({ weight_kg: 60 });
      await enter(user, kg(), '');
      expect(mockActions.updateSlot).toHaveBeenCalledWith('sl-1', { sets: 3, reps: 5, weight_kg: null });
    });

    it('a load that is not a number writes nothing and says why', async () => {
      const user = userEvent.setup();
      renderSlot({ weight_kg: 60 });
      await enter(user, kg(), 'abc');

      expect(mockActions.updateSlot).not.toHaveBeenCalled();
      expect(screen.getByRole('alert')).toHaveTextContent('Enter a number, like 82.5');
      expect(kg()).toHaveAttribute('aria-invalid', 'true');
      expect(kg()).toHaveAttribute('aria-describedby', screen.getByRole('alert').id);
      expect(kg()).toHaveValue('abc');
    });

    it.each([
      ['sets', ''],
      ['sets', '0'],
      ['sets', '2,5'],
      ['reps', ''],
      ['reps', '0'],
      ['reps', 'x'],
    ])('%s "%s" is refused, never made 1', async (name, text) => {
      const user = userEvent.setup();
      renderSlot();
      const field = name === 'sets' ? sets() : reps();
      await enter(user, field, text);

      expect(mockActions.updateSlot).not.toHaveBeenCalled();
      expect(screen.getByRole('alert')).toHaveTextContent('Enter a whole number, 1 or more');
      expect(field).toHaveAttribute('aria-invalid', 'true');
    });

    it('once the field is put right, the alert goes and the next blur writes the slot', async () => {
      const user = userEvent.setup();
      renderSlot();
      await enter(user, reps(), '0');
      expect(screen.getByRole('alert')).toBeInTheDocument();

      await user.clear(reps());
      await user.type(reps(), '8');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(reps()).not.toHaveAttribute('aria-invalid');
      await user.tab();

      expect(mockActions.updateSlot).toHaveBeenCalledTimes(1);
      expect(mockActions.updateSlot).toHaveBeenCalledWith('sl-1', { sets: 3, reps: 8, weight_kg: null });
    });
  });

  describe('the exercise picker', () => {
    const ARCHIVED = '2026-10-01T00:00:00Z';

    function renderSession(slots = []) {
      mockMyDraft = { data: { id: 'p-1', name: 'Block A', status: 'draft', submitted_at: null }, isLoading: false };
      mockTree = {
        data: {
          id: 'p-1', name: 'Block A', status: 'draft', submitted_at: null,
          weeks: [{ id: 'w-1', week_number: 1, sessions: [
            { id: 's-1', title: 'Day 1', sort_order: 0, exercise_slots: slots },
          ] }],
        },
        isLoading: false,
      };
      renderAuthor();
    }

    async function openPicker(user) {
      await user.click(screen.getByRole('button', { name: /add exercise/i }));
      return screen.getByRole('dialog', { name: 'Add exercise' });
    }

    it('does not offer an exercise the coach archived, and still names it on the slot that uses it', async () => {
      const user = userEvent.setup();
      const oldRow = { id: 'e-9', name: 'Old Row', type: 'pull', archived_at: ARCHIVED };
      mockLibrary = [
        { id: 'e-1', name: 'Squat', type: 'push', archived_at: null },
        oldRow,
        // Read before the column existed: active.
        { id: 'e-2', name: 'Pull-up', type: 'pull' },
      ];
      renderSession([
        { id: 'sl-1', exercise_id: 'e-9', sets: 3, reps: 5, sort_order: 0, exercise: oldRow },
      ]);
      expect(screen.getByText('Old Row')).toBeInTheDocument();

      const picker = await openPicker(user);
      const offered = within(picker).getAllByRole('button').map((b) => b.textContent);
      expect(offered.some((text) => text.includes('Squat'))).toBe(true);
      expect(offered.some((text) => text.includes('Pull-up'))).toBe(true);
      expect(within(picker).queryByText('Old Row')).not.toBeInTheDocument();

      await user.type(within(picker).getByRole('textbox', { name: /search exercises/i }), 'row');
      expect(within(picker).getByText(/no exercises found/i)).toBeInTheDocument();
    });

    it('shows each exercise\'s type with the shared badge, under its name in the app', async () => {
      const user = userEvent.setup();
      mockLibrary = [
        { id: 'e-1', name: 'Squat', type: 'push', archived_at: null },
        { id: 'e-2', name: 'Pull-up', type: 'pull', archived_at: null },
      ];
      renderSession();

      const picker = await openPicker(user);
      const squat = within(picker).getByRole('button', { name: /squat/i });
      const pullUp = within(picker).getByRole('button', { name: /pull-up/i });
      expect(within(squat).getByText('Push')).toHaveClass('sl-pill', 'bg-push/15', 'text-push');
      expect(within(pullUp).getByText('Pull')).toHaveClass('sl-pill', 'bg-pull/15', 'text-pull');

      await user.click(pullUp);
      expect(mockActions.addSlot).toHaveBeenCalledWith('s-1', mockLibrary[1]);
    });
  });
});
