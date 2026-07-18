import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

const mockCreate = { mutate: vi.fn(), isPending: false };
const mockRename = { mutate: vi.fn(), isPending: false };
const mockDelete = { mutate: vi.fn(), isPending: false };
const mockSetActive = { mutate: vi.fn(), isPending: false };
const mockReorder = { mutate: vi.fn(), isPending: false };
const mockDuplicate = { mutate: vi.fn(), isPending: false };
const mockApprove = { mutate: vi.fn(), isPending: false };
const mockSendBack = { mutate: vi.fn(), isPending: false };

vi.mock('../../hooks/useProgram', () => ({
  useCreateProgram: () => mockCreate,
  useRenameProgram: () => mockRename,
  useDeleteProgram: () => mockDelete,
  useSetActiveProgram: () => mockSetActive,
  useReorderPrograms: () => mockReorder,
  useTrashedPrograms: () => ({ data: [], isLoading: false }),
  useRestoreProgram: () => ({ mutate: vi.fn(), isPending: false }),
  useHardDeleteProgram: () => ({ mutate: vi.fn(), isPending: false }),
  useApproveProgram: () => mockApprove,
  useSendBackProgram: () => mockSendBack,
}));

vi.mock('../../hooks/useDuplicate', () => ({
  useDuplicateProgram: () => mockDuplicate,
}));

import ProgramSwitcher from './ProgramSwitcher';

const programs = [
  { id: 'p-1', name: 'Block 1 — Hypertrophy', is_active: true, sort_order: 0, weeks: [{ id: 'w-1' }] },
  { id: 'p-2', name: 'Block 2 — Strength', is_active: false, sort_order: 1, weeks: [] },
];

function renderSwitcher(overrides = {}) {
  const onSelect = vi.fn();
  render(
    <MemoryRouter>
      <ProgramSwitcher
        studentId="s-1"
        programs={programs}
        selectedId="p-1"
        onSelect={onSelect}
        {...overrides}
      />
    </MemoryRouter>,
  );
  return { onSelect };
}

describe('ProgramSwitcher', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the selected program in the trigger', () => {
    renderSwitcher();
    const trigger = screen.getByRole('button', { name: /select program/i });
    expect(trigger).toHaveTextContent('Block 1 — Hypertrophy');
    expect(trigger).toHaveTextContent('ACTIVE');
  });

  it('opens a listbox of all programs when the trigger is clicked', async () => {
    const user = userEvent.setup();
    renderSwitcher();

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /select program/i }));

    const listbox = screen.getByRole('listbox');
    expect(listbox).toHaveTextContent('Block 1 — Hypertrophy');
    expect(listbox).toHaveTextContent('Block 2 — Strength');
  });

  it('selecting a program from the listbox calls onSelect and closes it', async () => {
    const user = userEvent.setup();
    const { onSelect } = renderSwitcher();

    await user.click(screen.getByRole('button', { name: /select program/i }));
    await user.click(screen.getByRole('option', { name: /Block 2 — Strength/ }));

    expect(onSelect).toHaveBeenCalledWith('p-2');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('clicking + PROGRAM calls useCreateProgram with the next default name', async () => {
    const user = userEvent.setup();
    renderSwitcher();
    await user.click(screen.getByRole('button', { name: '+ PROGRAM' }));
    expect(mockCreate.mutate).toHaveBeenCalledWith(
      { studentId: 's-1', name: 'Program 3', setActive: false },
      expect.any(Object),
    );
  });

  it('opens the manage dialog for the selected program', async () => {
    const user = userEvent.setup();
    renderSwitcher({ selectedId: 'p-2' });
    await user.click(screen.getByRole('button', { name: /program options/i }));

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByLabelText(/program name/i)).toHaveValue('Block 2 — Strength');
    expect(screen.getByRole('button', { name: /set active/i })).toBeInTheDocument();
  });

  it('blocks trashing the active program when others exist', async () => {
    const user = userEvent.setup();
    renderSwitcher({ selectedId: 'p-1' });
    await user.click(screen.getByRole('button', { name: /program options/i }));

    const trashBtn = screen.getByRole('button', { name: /move to trash/i });
    expect(trashBtn).toBeDisabled();
  });

  it('duplicating a program calls useDuplicateProgram and selects the copy', async () => {
    const user = userEvent.setup();
    const { onSelect } = renderSwitcher({ selectedId: 'p-1' });
    await user.click(screen.getByRole('button', { name: /program options/i }));

    await user.click(screen.getByRole('button', { name: /duplicate program/i }));
    expect(mockDuplicate.mutate).toHaveBeenCalledWith(
      { programId: 'p-1', studentId: 's-1' },
      expect.any(Object),
    );

    // The onSuccess callback should select the returned copy.
    const onSuccess = mockDuplicate.mutate.mock.calls[0][1].onSuccess;
    act(() => onSuccess({ id: 'p-copy' }));
    expect(onSelect).toHaveBeenCalledWith('p-copy');
  });

  it('shows a SUBMITTED badge and coach approve/send-back for a submitted draft', async () => {
    const user = userEvent.setup();
    const draftPrograms = [
      { id: 'd-1', name: 'Student Block', is_active: false, status: 'draft', submitted_at: '2026-04-26T00:00:00Z', sort_order: 0, weeks: [{ id: 'w-1' }] },
    ];
    render(
      <MemoryRouter>
        <ProgramSwitcher studentId="s-1" programs={draftPrograms} selectedId="d-1" onSelect={vi.fn()} />
      </MemoryRouter>,
    );
    // Badge on the trigger.
    expect(screen.getByRole('button', { name: /select program/i })).toHaveTextContent('SUBMITTED');

    await user.click(screen.getByRole('button', { name: /program options/i }));
    await user.click(screen.getByRole('button', { name: /^approve$/i }));
    expect(mockApprove.mutate).toHaveBeenCalledWith(
      { programId: 'd-1', studentId: 's-1' },
      expect.any(Object),
    );

    await user.click(screen.getByRole('button', { name: /send back/i }));
    expect(mockSendBack.mutate).toHaveBeenCalledWith(
      { programId: 'd-1', studentId: 's-1' },
      expect.any(Object),
    );
  });

  it('an unsubmitted draft can be approved but offers no send-back', async () => {
    const user = userEvent.setup();
    const draftPrograms = [
      { id: 'd-2', name: 'WIP Block', is_active: false, status: 'draft', submitted_at: null, sort_order: 0, weeks: [] },
    ];
    render(
      <MemoryRouter>
        <ProgramSwitcher studentId="s-1" programs={draftPrograms} selectedId="d-2" onSelect={vi.fn()} />
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: /select program/i })).toHaveTextContent('DRAFT');
    await user.click(screen.getByRole('button', { name: /program options/i }));
    expect(screen.getByRole('button', { name: /^approve$/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /send back/i })).not.toBeInTheDocument();
    // Draft is never active → the "Set active" affordance is suppressed.
    expect(screen.queryByRole('button', { name: /set active/i })).not.toBeInTheDocument();
  });

  it('trashing an inactive program requires confirm and calls the mutation', async () => {
    const user = userEvent.setup();
    renderSwitcher({ selectedId: 'p-2' });
    await user.click(screen.getByRole('button', { name: /program options/i }));

    await user.click(screen.getByRole('button', { name: /move to trash/i }));
    // Trash-not-delete confirm copy: data stays safe, restore anytime.
    expect(screen.getByText(/restore it anytime/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'MOVE TO TRASH' }));
    expect(mockDelete.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ programId: 'p-2' }),
      expect.any(Object),
    );
  });
});
