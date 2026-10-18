import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter } from 'react-router-dom';

const mockCreate = { mutate: vi.fn(), isPending: false };
const mockRename = { mutate: vi.fn(), isPending: false };
const mockDelete = { mutate: vi.fn(), isPending: false };
const mockSetActive = { mutate: vi.fn(), isPending: false };
const mockReorder = { mutate: vi.fn(), isPending: false };
const mockDuplicate = { mutate: vi.fn(), isPending: false };
const mockApprove = { mutate: vi.fn(), isPending: false };
const mockSendBack = { mutate: vi.fn(), isPending: false };
const mockRestore = { mutate: vi.fn(), isPending: false };
const mockHardDelete = { mutate: vi.fn(), isPending: false };
// What the switcher hands `useReorderPrograms`: the athlete whose queue its
// reorders wait in.
let reorderHookArgs = null;
// The athlete's blocks in the trash, and how the trash was asked for.
let mockTrashed = [];
const trashReads = vi.fn();

vi.mock('../../hooks/useProgram', () => ({
  useCreateProgram: () => mockCreate,
  useRenameProgram: () => mockRename,
  useDeleteProgram: () => mockDelete,
  useSetActiveProgram: () => mockSetActive,
  useReorderPrograms: (...args) => {
    reorderHookArgs = args;
    return mockReorder;
  },
  useTrashedPrograms: (...args) => {
    trashReads(...args);
    return { data: mockTrashed, isLoading: false };
  },
  useRestoreProgram: () => mockRestore,
  useHardDeleteProgram: () => mockHardDelete,
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
        athleteName="Alice"
        {...overrides}
      />
    </MemoryRouter>,
  );
  return { onSelect };
}

// The page's title: a button named by the block, which says what a tap does
// in its description.
const trigger = () => screen.getByRole('button', { description: 'Choose the block' });
const options = () => screen.getByRole('button', { name: 'Block options' });
const manageSheet = () => screen.getByRole('dialog', { name: 'Manage the block' });
const blocksSheet = () => screen.getByRole('dialog', { name: 'Alice’s blocks' });

describe('ProgramSwitcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTrashed = [];
  });

  // Review finding P51: two drags of one athlete's list wait for each other,
  // and the hook knows whose list it is from its argument.
  it('gives the reorder hook the athlete, so that two drags do not cross', () => {
    renderSwitcher();
    expect(reorderHookArgs).toEqual(['s-1']);
  });

  // Parc (design/parc/screens/Programme.dc.html): the block's name is the
  // page's title. The h1 is the block, and the button inside it is named by
  // the block too: what a tap does is its description, not its name.
  it('makes the selected block the page title, a button that opens the list', () => {
    renderSwitcher();
    const title = screen.getByRole('heading', { level: 1, name: 'Block 1 — Hypertrophy' });
    expect(title).toHaveClass('pk-large-title');
    expect(title).toContainElement(trigger());
    expect(trigger()).toHaveAccessibleName('Block 1 — Hypertrophy');
    expect(trigger()).toHaveAttribute('aria-haspopup', 'dialog');
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    expect(trigger()).toHaveClass('min-h-11');
  });

  // What the block is — in progress, a draft — is the line under the title,
  // which the page writes: the title is the name alone.
  it('leaves what the block is to the line under the title', () => {
    renderSwitcher({ subtitle: 'Alice, in progress, session 3 of 12' });
    expect(trigger()).not.toHaveTextContent('In progress');
    expect(screen.getByText('Alice, in progress, session 3 of 12')).toHaveClass('pk-subhead');

    renderSwitcher({ selectedId: 'p-2' });
    expect(screen.getByRole('heading', { level: 1, name: 'Block 2 — Strength' })).toBeInTheDocument();
  });

  // The frame of the title is the page's: the way back to the roster at the
  // left, the account menu at the right; the block's ⋯ beside its name.
  it('draws the way back and the actions it is handed', () => {
    renderSwitcher({
      titleProps: {
        back: { label: 'All athletes', as: Link, to: '/coach/students' },
        actions: <button type="button">Account</button>,
      },
    });
    expect(screen.getByRole('link', { name: 'All athletes' })).toHaveAttribute('href', '/coach/students');
    expect(screen.getByRole('button', { name: 'Account' })).toBeInTheDocument();
    expect(options()).toBeInTheDocument();
  });

  it('opens the athlete’s blocks in a sheet when the title is tapped', async () => {
    const user = userEvent.setup();
    renderSwitcher();

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    await user.click(trigger());

    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    expect(blocksSheet()).toBeInTheDocument();
    const listbox = within(blocksSheet()).getByRole('listbox', { name: 'Choose the block' });
    expect(listbox).toHaveTextContent('Block 1 — Hypertrophy');
    expect(listbox).toHaveTextContent('Block 2 — Strength');
    // One option per block, the one on screen selected, the one in progress
    // said so in words; and a handle to move each.
    const [first, second] = within(listbox).getAllByRole('option');
    expect(first).toHaveAttribute('aria-selected', 'true');
    expect(first).toHaveTextContent('In progress');
    expect(second).toHaveAttribute('aria-selected', 'false');
    expect(second).not.toHaveTextContent('In progress');
    expect(within(listbox).getByRole('button', { name: 'Move Block 1 — Hypertrophy' })).toHaveClass('pk-icon-btn');
    expect(within(listbox).getByRole('button', { name: 'Move Block 2 — Strength' })).toHaveClass('pk-icon-btn');
  });

  it('selecting a program from the listbox calls onSelect and closes it', async () => {
    const user = userEvent.setup();
    const { onSelect } = renderSwitcher();

    await user.click(trigger());
    await user.click(screen.getByRole('option', { name: /Block 2 — Strength/ }));

    expect(onSelect).toHaveBeenCalledWith('p-2');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('closes the listbox on Escape, choosing nothing', async () => {
    const user = userEvent.setup();
    const { onSelect } = renderSwitcher();

    await user.click(trigger());
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('keeps New block in the sheet, not beside the name', async () => {
    const user = userEvent.setup();
    const { onSelect } = renderSwitcher();

    // Creating a block is a once-a-cycle action; it must not hold width next
    // to the name, which is the thing the coach actually reads.
    expect(screen.queryByRole('button', { name: 'New block' })).not.toBeInTheDocument();

    await user.click(trigger());
    // In the sheet, under the list: a listbox holds options and nothing else.
    expect(within(screen.getByRole('listbox')).queryByRole('button', { name: 'New block' })).toBeNull();
    await user.click(within(blocksSheet()).getByRole('button', { name: 'New block' }));

    expect(mockCreate.mutate).toHaveBeenCalledWith(
      { studentId: 's-1', name: 'Program 3', setActive: false },
      expect.any(Object),
    );
    // Creating switches to the new program, so the list has served its purpose.
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    const { onSuccess } = mockCreate.mutate.mock.calls[0][1];
    act(() => onSuccess({ id: 'p-new' }));
    expect(onSelect).toHaveBeenCalledWith('p-new');
  });

  it('the trigger drops the week count the sheet below already lists', async () => {
    const user = userEvent.setup();
    renderSwitcher();
    expect(trigger()).not.toHaveTextContent(/week/i);
    // Nor do the rows of the list.
    await user.click(trigger());
    expect(screen.getByRole('listbox')).not.toHaveTextContent(/week/i);
  });

  // The trash is a rarely used corner: it is read while the list is open,
  // where its way in lives, and that way in is shown only when it holds a
  // block.
  describe('the trash', () => {
    it('is read only while the list is open', async () => {
      const user = userEvent.setup();
      renderSwitcher();
      expect(trashReads).toHaveBeenCalled();
      for (const [studentId, opts] of trashReads.mock.calls) {
        expect(studentId).toBe('s-1');
        expect(opts).toEqual({ enabled: false });
      }

      await user.click(trigger());
      expect(trashReads).toHaveBeenLastCalledWith('s-1', { enabled: true });
    });

    it('is not offered while it is empty', async () => {
      const user = userEvent.setup();
      renderSwitcher();
      await user.click(trigger());
      expect(screen.queryByRole('button', { name: /^Trash/ })).toBeNull();
    });

    it('says how many blocks it holds, and opens on the tap', async () => {
      const user = userEvent.setup();
      mockTrashed = [{ id: 'p-9', name: 'Old block' }];
      renderSwitcher();
      await user.click(trigger());
      await user.click(screen.getByRole('button', { name: 'Trash, 1' }));

      expect(screen.queryByRole('listbox')).toBeNull();
      const sheet = screen.getByRole('dialog', { name: 'Trash' });
      expect(within(sheet).getByText('Old block')).toBeInTheDocument();

      await user.click(within(sheet).getByRole('button', { name: 'Restore' }));
      expect(mockRestore.mutate).toHaveBeenCalledWith({ programId: 'p-9', studentId: 's-1' });
    });

    it('deletes a block for good only after a second tap', async () => {
      const user = userEvent.setup();
      mockTrashed = [{ id: 'p-9', name: 'Old block' }];
      renderSwitcher();
      await user.click(trigger());
      await user.click(screen.getByRole('button', { name: 'Trash, 1' }));
      const sheet = screen.getByRole('dialog', { name: 'Trash' });

      await user.click(within(sheet).getByRole('button', { name: 'Delete for good' }));
      expect(mockHardDelete.mutate).not.toHaveBeenCalled();
      await user.click(within(sheet).getByRole('button', { name: 'Confirm the deletion' }));
      expect(mockHardDelete.mutate).toHaveBeenCalledWith(
        { programId: 'p-9', studentId: 's-1' },
        expect.any(Object),
      );
    });

    // The database refuses to delete a block with logged training: the sheet
    // says to restore it instead.
    it('says why a block with logged training is not deleted', async () => {
      const user = userEvent.setup();
      mockTrashed = [{ id: 'p-9', name: 'Old block' }];
      renderSwitcher();
      await user.click(trigger());
      await user.click(screen.getByRole('button', { name: 'Trash, 1' }));
      const sheet = screen.getByRole('dialog', { name: 'Trash' });
      await user.click(within(sheet).getByRole('button', { name: 'Delete for good' }));
      await user.click(within(sheet).getByRole('button', { name: 'Confirm the deletion' }));

      const { onError } = mockHardDelete.mutate.mock.calls[0][1];
      act(() => onError({ code: 'PROGRAM_HAS_LOGGED_SETS' }));
      expect(within(sheet).getByText(/has logged training/i)).toBeInTheDocument();
      expect(within(sheet).getByRole('button', { name: 'Delete for good' })).toBeInTheDocument();
    });
  });

  it('opens the manage dialog for the selected program', async () => {
    const user = userEvent.setup();
    renderSwitcher({ selectedId: 'p-2' });
    // A round 44px button beside the name.
    expect(options()).toHaveClass('pk-icon-btn');
    await user.click(options());

    expect(manageSheet()).toBeInTheDocument();
    expect(screen.getByLabelText('Name of the block')).toHaveValue('Block 2 — Strength');
    expect(screen.getByRole('button', { name: 'Make it the block in progress' })).toBeInTheDocument();
  });

  it('renames the block, and only once the name has changed', async () => {
    const user = userEvent.setup();
    renderSwitcher({ selectedId: 'p-2' });
    await user.click(options());

    const rename = screen.getByRole('button', { name: 'Rename' });
    expect(rename).toBeDisabled();
    const field = screen.getByLabelText('Name of the block');
    await user.clear(field);
    await user.type(field, '  Peak  ');
    await user.click(rename);
    expect(mockRename.mutate).toHaveBeenCalledWith(
      { programId: 'p-2', studentId: 's-1', name: 'Peak' },
      expect.any(Object),
    );
  });

  it('makes a block the one in progress', async () => {
    const user = userEvent.setup();
    renderSwitcher({ selectedId: 'p-2' });
    await user.click(options());
    await user.click(screen.getByRole('button', { name: 'Make it the block in progress' }));
    expect(mockSetActive.mutate).toHaveBeenCalledWith(
      { programId: 'p-2', studentId: 's-1' },
      expect.any(Object),
    );
  });

  it('blocks trashing the active program when others exist', async () => {
    const user = userEvent.setup();
    renderSwitcher({ selectedId: 'p-1' });
    await user.click(options());

    expect(screen.getByRole('button', { name: 'Move to the trash' })).toBeDisabled();
    // And says what to do instead.
    expect(within(manageSheet()).getByText(/make another block the one in progress/i)).toBeInTheDocument();
    // The block in progress is not offered to become it.
    expect(screen.queryByRole('button', { name: 'Make it the block in progress' })).toBeNull();
  });

  it('duplicating a program calls useDuplicateProgram and selects the copy', async () => {
    const user = userEvent.setup();
    const { onSelect } = renderSwitcher({ selectedId: 'p-1' });
    await user.click(options());

    await user.click(screen.getByRole('button', { name: 'Duplicate the block' }));
    expect(mockDuplicate.mutate).toHaveBeenCalledWith(
      { programId: 'p-1', studentId: 's-1' },
      expect.any(Object),
    );

    // The onSuccess callback should select the returned copy.
    const onSuccess = mockDuplicate.mutate.mock.calls[0][1].onSuccess;
    act(() => onSuccess({ id: 'p-copy' }));
    expect(onSelect).toHaveBeenCalledWith('p-copy');
    // And the sheet has done its job.
    expect(screen.queryByRole('dialog', { name: 'Manage the block' })).toBeNull();
  });

  it('shows a Submitted status and coach approve/send-back for a submitted draft', async () => {
    const user = userEvent.setup();
    const draftPrograms = [
      { id: 'd-1', name: 'Student Block', is_active: false, status: 'draft', submitted_at: '2026-04-26T00:00:00Z', sort_order: 0, weeks: [{ id: 'w-1' }] },
    ];
    render(
      <MemoryRouter>
        <ProgramSwitcher studentId="s-1" programs={draftPrograms} selectedId="d-1" onSelect={vi.fn()} />
      </MemoryRouter>,
    );
    // The status in the list of blocks, in words (the page says it under the
    // title).
    await user.click(trigger());
    expect(screen.getByRole('option', { name: /Student Block/ })).toHaveTextContent('Submitted');
    expect(screen.getByRole('option', { name: /Student Block/ })).not.toHaveTextContent('Draft');
    await user.keyboard('{Escape}');

    await user.click(options());
    expect(within(manageSheet()).getByRole('heading', { name: 'Submitted for approval' })).toBeInTheDocument();
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
    await user.click(trigger());
    expect(screen.getByRole('option', { name: /WIP Block/ })).toHaveTextContent('Draft');
    await user.keyboard('{Escape}');

    await user.click(options());
    expect(within(manageSheet()).getByRole('heading', { name: 'Draft in progress' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^approve$/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /send back/i })).not.toBeInTheDocument();
    // Draft is never active → the "Set active" affordance is suppressed.
    expect(screen.queryByRole('button', { name: 'Make it the block in progress' })).not.toBeInTheDocument();
  });

  it('trashing an inactive program requires confirm and calls the mutation', async () => {
    const user = userEvent.setup();
    renderSwitcher({ selectedId: 'p-2' });
    await user.click(options());

    await user.click(screen.getByRole('button', { name: 'Move to the trash' }));
    expect(mockDelete.mutate).not.toHaveBeenCalled();
    // Trash-not-delete confirm copy: data stays safe, restore anytime.
    expect(screen.getByRole('heading', { name: 'Move “Block 2 — Strength” to the trash?' })).toBeInTheDocument();
    expect(screen.getByText(/can be restored at any time/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Move to the trash' }));
    expect(mockDelete.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ programId: 'p-2' }),
      expect.any(Object),
    );
  });

  it('takes the trash back on Cancel', async () => {
    const user = userEvent.setup();
    renderSwitcher({ selectedId: 'p-2' });
    await user.click(options());
    await user.click(screen.getByRole('button', { name: 'Move to the trash' }));
    await user.click(within(manageSheet()).getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('heading', { name: /to the trash\?/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Move to the trash' })).toBeEnabled();
    expect(mockDelete.mutate).not.toHaveBeenCalled();
  });
});
