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

  it('renders a pill per program', () => {
    renderSwitcher();
    expect(screen.getByText('Block 1 — Hypertrophy')).toBeInTheDocument();
    expect(screen.getByText('Block 2 — Strength')).toBeInTheDocument();
  });

  it('shows an ACTIVE badge on the active program only', () => {
    renderSwitcher();
    expect(screen.getAllByText('ACTIVE')).toHaveLength(1);
  });

  it('selecting a pill calls onSelect with that program id', async () => {
    const user = userEvent.setup();
    const { onSelect } = renderSwitcher();
    await user.click(screen.getByText('Block 2 — Strength'));
    expect(onSelect).toHaveBeenCalledWith('p-2');
  });

  it('clicking + PROGRAM calls useCreateProgram with the next default name', async () => {
    const user = userEvent.setup();
    renderSwitcher();
    await user.click(screen.getByText('+ PROGRAM'));
    expect(mockCreate.mutate).toHaveBeenCalledWith(
      { studentId: 's-1', name: 'Program 3', setActive: false },
      expect.any(Object),
    );
  });

  it('opens the manage dialog with rename + delete when a program menu opens', async () => {
    const user = userEvent.setup();
    renderSwitcher();
    const menuBtns = screen.getAllByRole('button', { name: /program options/i });
    await user.click(menuBtns[1]); // non-active program

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByLabelText(/program name/i)).toHaveValue('Block 2 — Strength');
    expect(screen.getByRole('button', { name: /set active/i })).toBeInTheDocument();
  });

  it('blocks delete on the active program when others exist', async () => {
    const user = userEvent.setup();
    renderSwitcher();
    const menuBtns = screen.getAllByRole('button', { name: /program options/i });
    await user.click(menuBtns[0]); // active program

    const deleteBtn = screen.getByRole('button', { name: 'Delete' });
    expect(deleteBtn).toBeDisabled();
  });
});
