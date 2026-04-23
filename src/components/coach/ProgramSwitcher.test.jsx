import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

const mockCreate = { mutate: vi.fn(), isPending: false };
const mockRename = { mutate: vi.fn(), isPending: false };
const mockDelete = { mutate: vi.fn(), isPending: false };
const mockSetActive = { mutate: vi.fn(), isPending: false };
const mockReorder = { mutate: vi.fn(), isPending: false };

vi.mock('../../hooks/useProgram', () => ({
  useCreateProgram: () => mockCreate,
  useRenameProgram: () => mockRename,
  useDeleteProgram: () => mockDelete,
  useSetActiveProgram: () => mockSetActive,
  useReorderPrograms: () => mockReorder,
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

  it('blocks delete on the active program when others exist', async () => {
    const user = userEvent.setup();
    renderSwitcher({ selectedId: 'p-1' });
    await user.click(screen.getByRole('button', { name: /program options/i }));

    const deleteBtn = screen.getByRole('button', { name: 'Delete' });
    expect(deleteBtn).toBeDisabled();
  });
});
