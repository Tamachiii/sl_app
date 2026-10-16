import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// What the coach has: two athletes, their blocks, the phases of each block.
// A test changes these to play a list that is read again.
let students;
let blocksOf;
let blocks;
const readStudents = vi.fn();

vi.mock('../../hooks/useStudents', () => ({
  useStudents: () => {
    readStudents();
    return { data: students };
  },
}));

vi.mock('../../hooks/useProgram', () => ({
  useProgramsForStudent: (studentId) => ({ data: studentId ? blocksOf[studentId] ?? [] : undefined }),
  useProgram: (programId) => ({ data: programId ? blocks[programId] : undefined }),
}));

import CopyDialog from './CopyDialog';

beforeEach(() => {
  vi.clearAllMocks();
  students = [
    { id: 'st-1', profile: { full_name: 'Alice' } },
    { id: 'st-2', profile: { full_name: 'Bob' } },
    { id: 'st-3', profile: null },
  ];
  blocksOf = {
    'st-1': [{ id: 'p-1', name: 'Block 1', is_active: true }],
    'st-2': [
      { id: 'p-2', name: 'Base', is_active: true },
      { id: 'p-3', name: 'Peak', is_active: false },
    ],
    'st-3': [],
  };
  blocks = {
    'p-1': { id: 'p-1', weeks: [{ id: 'w-1', week_number: 1, label: null }] },
    'p-2': {
      id: 'p-2',
      weeks: [
        {
          id: 'w-2',
          week_number: 1,
          label: 'Volume',
          sessions: [{ id: 's-1', sort_order: 0, archived_at: null }, { id: 's-2', sort_order: 1, archived_at: null }],
        },
        { id: 'w-3', week_number: 2, label: null, sessions: [{ id: 's-3', sort_order: 0, archived_at: null }] },
      ],
    },
    'p-3': { id: 'p-3', weeks: [] },
  };
});

function dialogProps(props = {}) {
  return {
    open: true,
    onClose: vi.fn(),
    onCopy: vi.fn(),
    title: 'Copy sessions',
    currentStudentId: 'st-1',
    ...props,
  };
}

function renderDialog(props) {
  const all = dialogProps(props);
  const utils = render(<CopyDialog {...all} />);
  return { ...all, ...utils, rerenderWith: (next) => utils.rerender(<CopyDialog {...all} {...next} />) };
}

const athlete = () => screen.getByLabelText('Student');
const block = () => screen.getByLabelText('Destination block');
const phase = () => screen.getByLabelText('Destination week');
const copyButton = () => screen.getByRole('button', { name: 'Copy' });
const options = (select) => within(select).getAllByRole('option').map((o) => o.textContent);

async function pickDestination(user) {
  await user.selectOptions(athlete(), 'st-2');
  await user.selectOptions(block(), 'p-2');
  await user.selectOptions(phase(), 'w-3');
}

describe('CopyDialog', () => {
  it('asks for the athlete, then the block, then the phase, and copies only to a complete destination', async () => {
    const user = userEvent.setup();
    const { onCopy } = renderDialog({ showWeekSelect: true });

    expect(block()).toBeDisabled();
    expect(phase()).toBeDisabled();
    expect(copyButton()).toBeDisabled();

    await user.selectOptions(athlete(), 'st-2');
    expect(block()).toBeEnabled();
    // Every block of the athlete, not only the active one.
    expect(options(block())).toEqual(['Select a block', 'Base (active)', 'Peak']);
    expect(phase()).toBeDisabled();
    expect(copyButton()).toBeDisabled();

    await user.selectOptions(block(), 'p-2');
    expect(phase()).toBeEnabled();
    expect(options(phase())).toEqual(['Select week…', 'Volume · Sessions 1–2', 'Unnamed phase · Session 3']);
    expect(copyButton()).toBeDisabled();

    await user.selectOptions(phase(), 'w-3');
    expect(copyButton()).toBeEnabled();

    await user.click(copyButton());
    expect(onCopy).toHaveBeenCalledTimes(1);
    expect(onCopy).toHaveBeenCalledWith({ studentId: 'st-2', programId: 'p-2', weekId: 'w-3' });
  });

  // Copying a phase: it goes to a block, as its last phase.
  it('takes a block for a complete destination when no phase is asked for', async () => {
    const user = userEvent.setup();
    const { onCopy } = renderDialog();

    expect(screen.queryByLabelText('Destination week')).toBeNull();
    await user.selectOptions(athlete(), 'st-2');
    expect(copyButton()).toBeDisabled();
    await user.selectOptions(block(), 'p-3');
    await user.click(copyButton());

    expect(onCopy).toHaveBeenCalledWith({ studentId: 'st-2', programId: 'p-3', weekId: undefined });
  });

  it('says so when the athlete has no block, or the block no phase', async () => {
    const user = userEvent.setup();
    renderDialog({ showWeekSelect: true });

    await user.selectOptions(athlete(), 'st-3');
    expect(block()).toBeDisabled();
    expect(options(block())).toEqual(['This athlete has no block yet']);

    await user.selectOptions(athlete(), 'st-2');
    await user.selectOptions(block(), 'p-3');
    expect(phase()).toBeDisabled();
    expect(options(phase())).toEqual(['No weeks in this student’s program']);
    expect(copyButton()).toBeDisabled();
  });

  it('forgets the block and the phase when another athlete is picked', async () => {
    const user = userEvent.setup();
    renderDialog({ showWeekSelect: true, currentProgramId: 'p-1' });
    await pickDestination(user);

    await user.selectOptions(athlete(), 'st-1');

    expect(block()).toHaveValue('');
    expect(phase()).toHaveValue('');
    expect(copyButton()).toBeDisabled();
  });

  it('leaves the athlete of the page out, unless the copy may stay with them', () => {
    const { unmount } = renderDialog();
    expect(options(athlete())).toEqual(['Select student…', 'Bob', 'Unnamed student']);
    unmount();

    // With the block being edited: a phase or a session can be copied within it.
    renderDialog({ currentProgramId: 'p-1' });
    expect(options(athlete())).toEqual(['Select student…', 'Alice (this athlete)', 'Bob', 'Unnamed student']);
  });

  it('shows the copy as on its way and takes no second one meanwhile', async () => {
    const user = userEvent.setup();
    const { onCopy, rerenderWith } = renderDialog({ showWeekSelect: true });
    await pickDestination(user);

    rerenderWith({ isPending: true });

    const pending = screen.getByRole('button', { name: 'Copying…' });
    expect(pending).toBeDisabled();
    await user.click(pending);
    expect(onCopy).not.toHaveBeenCalled();
  });

  // The parent closes the dialog when the copy is made. One that is refused
  // leaves it open: the destination has to be there still, to be sent again —
  // it used to be cleared at the click, which left an open dialog with empty
  // selects and a dead Copy button.
  it('keeps the destination after Copy, so that a refused copy can be sent again', async () => {
    const user = userEvent.setup();
    const { onCopy, rerenderWith } = renderDialog({ showWeekSelect: true });
    await pickDestination(user);

    await user.click(copyButton());
    rerenderWith({ isPending: true });
    // Still shown while the copy is on its way…
    expect(athlete()).toHaveValue('st-2');
    expect(block()).toHaveValue('p-2');
    expect(phase()).toHaveValue('w-3');

    // …and after it was refused.
    rerenderWith({ isPending: false });
    expect(phase()).toHaveValue('w-3');
    await user.click(copyButton());

    expect(onCopy).toHaveBeenCalledTimes(2);
    expect(onCopy).toHaveBeenLastCalledWith({ studentId: 'st-2', programId: 'p-2', weekId: 'w-3' });
  });

  it('forgets the destination once it is closed, whoever closes it', async () => {
    const user = userEvent.setup();
    const { rerenderWith } = renderDialog({ showWeekSelect: true });
    await pickDestination(user);

    // The parent closes it — after a copy that was made — and opens it again.
    rerenderWith({ open: false });
    rerenderWith({ open: true });

    expect(athlete()).toHaveValue('');
    expect(block()).toBeDisabled();
    expect(phase()).toBeDisabled();
    expect(copyButton()).toBeDisabled();
  });

  it('asks the parent to close on Cancel', async () => {
    const user = userEvent.setup();
    const { onClose, onCopy } = renderDialog();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onCopy).not.toHaveBeenCalled();
  });

  // Review item B28: a phase is a free-text name, never "Week 3", and an
  // unnamed one is drawn as the sheet draws it. What it holds tells two
  // phases of the same name apart.
  it('names each phase as the sheet does, with the places its sessions hold in the block', async () => {
    const user = userEvent.setup();
    const live = (id, sort_order) => ({ id, sort_order, archived_at: null });
    blocks = {
      ...blocks,
      'p-2': {
        id: 'p-2',
        weeks: [
          { id: 'w-a', week_number: 1, label: null, sessions: [live('a2', 1), live('a1', 0)] },
          {
            id: 'w-b',
            week_number: 2,
            label: null,
            // The archived session holds no place.
            sessions: [live('b1', 0), { id: 'b2', sort_order: 1, archived_at: '2026-04-01T00:00:00Z' }, live('b3', 2)],
          },
          { id: 'w-c', week_number: 3, label: 'Deload', sessions: [] },
          { id: 'w-d', week_number: 4, label: 'Peak', sessions: [live('d1', 0)] },
        ],
      },
    };
    renderDialog({ showWeekSelect: true });
    await user.selectOptions(athlete(), 'st-2');
    await user.selectOptions(block(), 'p-2');

    expect(options(phase())).toEqual([
      'Select week…',
      'Unnamed phase · Sessions 1–2',
      'Unnamed phase · Sessions 3–4',
      'Deload · No sessions yet',
      'Peak · Session 5',
    ]);
    expect(options(phase()).join(' ')).not.toMatch(/Week \d/);
  });

  // What a refused copy is followed by: the lists are read again, and the
  // block or the phase that was picked may not be in them any more. The select
  // then shows its placeholder, and Copy must not send what is not shown.
  it('does not copy to a phase that is no longer offered', async () => {
    const user = userEvent.setup();
    const { onCopy, rerenderWith } = renderDialog({ showWeekSelect: true });
    await pickDestination(user);

    blocks = { ...blocks, 'p-2': { id: 'p-2', weeks: [{ id: 'w-2', week_number: 1, label: 'Volume' }] } };
    rerenderWith({});

    expect(phase()).toHaveValue('');
    expect(copyButton()).toBeDisabled();
    await user.click(copyButton());
    expect(onCopy).not.toHaveBeenCalled();

    // The coach picks one that is.
    await user.selectOptions(phase(), 'w-2');
    await user.click(copyButton());
    expect(onCopy).toHaveBeenCalledWith({ studentId: 'st-2', programId: 'p-2', weekId: 'w-2' });
  });

  it('does not copy to a block that is no longer offered', async () => {
    const user = userEvent.setup();
    const { onCopy, rerenderWith } = renderDialog();
    await user.selectOptions(athlete(), 'st-2');
    await user.selectOptions(block(), 'p-3');

    // The block went to the trash in another tab.
    blocksOf = { ...blocksOf, 'st-2': [{ id: 'p-2', name: 'Base', is_active: true }] };
    rerenderWith({});

    expect(block()).toHaveValue('');
    expect(copyButton()).toBeDisabled();
    await user.click(copyButton());
    expect(onCopy).not.toHaveBeenCalled();
  });

  // The sheet keeps two of these mounted, closed: neither reads a list until
  // it is opened.
  it('reads nothing while it is closed', () => {
    renderDialog({ open: false });

    expect(readStudents).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Student')).toBeNull();
  });
});
