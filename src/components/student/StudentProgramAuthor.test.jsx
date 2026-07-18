import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

let mockMyDraft = { data: null, isLoading: false };
let mockTree = { data: null, isLoading: false };
const mockCreate = { mutate: vi.fn(), isPending: false };
const mockAddWeek = { mutate: vi.fn(), isPending: false };
const mockSubmit = { mutate: vi.fn(), isPending: false };
let mockOnline = true;

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => vi.fn() };
});
vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({ profile: { full_name: 'Sam Lee' }, signOut: vi.fn() }),
}));
vi.mock('../../hooks/useOnlineStatus', () => ({ useOnlineStatus: () => mockOnline }));
vi.mock('../../hooks/useExerciseLibrary', () => ({ useExerciseLibrary: () => ({ data: [] }) }));
vi.mock('../../hooks/useAuthoring', () => ({
  useMyDraft: () => mockMyDraft,
  useDraftTree: () => mockTree,
  useCreateDraft: () => mockCreate,
  useAddDraftWeek: () => mockAddWeek,
  useAddDraftSession: () => ({ mutate: vi.fn(), isPending: false }),
  useAddDraftSlot: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateDraftSlot: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteDraftRow: () => ({ mutate: vi.fn(), isPending: false }),
  useSubmitDraft: () => mockSubmit,
  useDeleteDraft: () => ({ mutate: vi.fn(), isPending: false }),
}));
// NotificationBell inside UserMenu pulls in hooks we don't care about here.
vi.mock('../../components/notifications/NotificationBell', () => ({ default: () => null }), { virtual: true });

import StudentProgramAuthor from './StudentProgramAuthor';

function renderAuthor() {
  return render(<MemoryRouter><StudentProgramAuthor /></MemoryRouter>);
}

beforeEach(() => {
  mockMyDraft = { data: null, isLoading: false };
  mockTree = { data: null, isLoading: false };
  mockOnline = true;
  mockCreate.mutate.mockReset();
  mockAddWeek.mutate.mockReset();
  mockSubmit.mutate.mockReset();
});

describe('<StudentProgramAuthor />', () => {
  it('offers to create a draft when the student has none, and creates one', () => {
    renderAuthor();
    const input = screen.getByPlaceholderText(/off-season/i);
    fireEvent.change(input, { target: { value: 'My block' } });
    fireEvent.click(screen.getByRole('button', { name: /create draft/i }));
    expect(mockCreate.mutate).toHaveBeenCalledWith({ name: 'My block' });
  });

  it('disables authoring and shows an offline banner when offline', () => {
    mockOnline = false;
    renderAuthor();
    expect(screen.getByText(/you're offline/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create draft/i })).toBeDisabled();
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
    // One exercise present → submit is enabled and wired.
    const submitBtn = screen.getByRole('button', { name: /submit for approval/i });
    expect(submitBtn).not.toBeDisabled();
    fireEvent.click(submitBtn);
    expect(mockSubmit.mutate).toHaveBeenCalledWith({ programId: 'p-1' });
  });

  it('shows the submitted state (read-only) once submitted', () => {
    mockMyDraft = { data: { id: 'p-1', name: 'Block A', status: 'draft', submitted_at: '2026-04-26T00:00:00Z' }, isLoading: false };
    mockTree = { data: { id: 'p-1', name: 'Block A', status: 'draft', submitted_at: '2026-04-26T00:00:00Z', weeks: [] }, isLoading: false };
    renderAuthor();
    expect(screen.getByText(/awaiting coach/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /submit for approval/i })).not.toBeInTheDocument();
  });
});
