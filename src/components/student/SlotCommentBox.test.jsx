import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// The save is a stub: `mutate` is called and nothing ever answers — which is
// what a note written without a network looks like to the field. What the hook
// puts on screen meanwhile is in hooks/useSlotComments.test.jsx.
const mockSave = { mutate: vi.fn() };

vi.mock('../../hooks/useSlotComments', () => ({
  useSaveSlotComment: () => mockSave,
}));

import SlotCommentBox from './SlotCommentBox';

const NOTE = { id: 'sc-1', exercise_slot_id: 'sl-1', body: 'felt heavy' };

const field = () => screen.queryByRole('textbox', { name: 'Note for your coach' });
const addButton = () => screen.queryByRole('button', { name: 'Add a note for the coach' });
const editButton = () => screen.queryByRole('button', { name: 'Edit the note' });
const shownNote = () => screen.queryByRole('region', { name: 'Your note for the coach' });

function renderBox(comment) {
  return render(<SlotCommentBox sessionId="s-1" slotId="sl-1" comment={comment} />);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// One exercise is shown at a time on the session screen, so the note control
// is always in the exercise: the form a collapsed card showed beside its
// header is gone with the accordion.
describe('SlotCommentBox', () => {
  it('offers "Add a note for the coach" on an exercise without one, and the note itself on one that has it', () => {
    const { rerender } = renderBox(undefined);
    expect(addButton()).toBeInTheDocument();
    expect(shownNote()).toBeNull();

    rerender(<SlotCommentBox sessionId="s-1" slotId="sl-1" comment={NOTE} />);
    // The note is shown whole, signed, with the way to change it under it.
    expect(shownNote()).toHaveTextContent('felt heavy');
    expect(within(shownNote()).getByRole('button', { name: 'Edit the note' })).toBeInTheDocument();
    expect(addButton()).toBeNull();
  });

  // P68: a button is 44 px tall. jsdom lays nothing out: the 44 px are the
  // Parc button's class, whose min-height is the target size.
  it('draws its button at 44 px, with or without a note', () => {
    const { rerender } = renderBox(undefined);
    expect(addButton()).toHaveClass('pk-btn');

    rerender(<SlotCommentBox sessionId="s-1" slotId="sl-1" comment={NOTE} />);
    expect(editButton()).toHaveClass('pk-btn');
  });

  it('opens a field named for what it is, with the focus in it', async () => {
    const user = userEvent.setup();
    renderBox(undefined);

    await user.click(addButton());

    expect(field()).toBeInTheDocument();
    expect(field()).toHaveFocus();
    expect(addButton()).toBeNull();
  });

  // P25. The field used to close in the save's `onSuccess`: without a network
  // the write is parked, nothing answers, and it stayed open as if the note
  // had not been taken.
  it('closes when it is left, without waiting for the answer of the save', async () => {
    const user = userEvent.setup();
    renderBox(undefined);

    await user.click(addButton());
    await user.type(field(), 'felt heavy');
    await user.tab();

    expect(mockSave.mutate).toHaveBeenCalledTimes(1);
    expect(mockSave.mutate).toHaveBeenCalledWith(
      { sessionId: 's-1', slotId: 'sl-1', body: 'felt heavy' },
      expect.any(Object),
    );
    // Nothing has answered: the field is closed all the same.
    expect(field()).toBeNull();
    expect(addButton()).toBeInTheDocument();
  });

  it('left unchanged, it closes and saves nothing', async () => {
    const user = userEvent.setup();
    renderBox(NOTE);

    await user.click(editButton());
    expect(field()).toHaveValue('felt heavy');
    await user.tab();

    expect(mockSave.mutate).not.toHaveBeenCalled();
    expect(field()).toBeNull();
  });

  it('opens on the note as it is at that moment', async () => {
    const user = userEvent.setup();
    const { rerender } = renderBox(NOTE);
    // The note changed while the field was closed: a save that landed, a read.
    rerender(<SlotCommentBox sessionId="s-1" slotId="sl-1" comment={{ ...NOTE, body: 'felt light' }} />);

    await user.click(editButton());

    expect(field()).toHaveValue('felt light');
  });

  // The note changes under the field for other reasons than typing — a save
  // that is taken back, a read that comes in. What is being typed stays.
  it('does not replace what is being typed when the note changes under it', async () => {
    const user = userEvent.setup();
    const { rerender } = renderBox(NOTE);
    await user.click(editButton());
    await user.type(field(), ', left elbow');

    rerender(<SlotCommentBox sessionId="s-1" slotId="sl-1" comment={undefined} />);

    expect(field()).toHaveValue('felt heavy, left elbow');
  });

  describe('a save that failed', () => {
    async function writeAndFail(user) {
      const view = renderBox(NOTE);
      await user.click(editButton());
      await user.clear(field());
      await user.type(field(), 'felt heavy, left elbow');
      await user.tab();
      // The hook has put the note back as the database has it (the `comment`
      // prop is unchanged), and says so to the call that made the write.
      const { onError } = mockSave.mutate.mock.calls[0][1];
      act(() => onError(new Error('refused')));
      return view;
    }

    it('leaves the note as it was, and does not open the field by itself', async () => {
      const user = userEvent.setup();
      await writeAndFail(user);

      expect(field()).toBeNull();
      expect(shownNote()).toHaveTextContent('felt heavy');
      expect(shownNote()).not.toHaveTextContent('left elbow');
    });

    it('is what the field opens on next: the athlete does not write it twice', async () => {
      const user = userEvent.setup();
      await writeAndFail(user);

      await user.click(editButton());
      expect(field()).toHaveValue('felt heavy, left elbow');

      // Leaving it sends it again.
      await user.tab();
      expect(mockSave.mutate).toHaveBeenCalledTimes(2);
      expect(mockSave.mutate.mock.calls[1][0]).toEqual({
        sessionId: 's-1',
        slotId: 'sl-1',
        body: 'felt heavy, left elbow',
      });
    });

    it('is forgotten once the field has been left again', async () => {
      const user = userEvent.setup();
      await writeAndFail(user);
      await user.click(editButton());
      await user.clear(field());
      await user.type(field(), 'felt heavy');
      await user.tab();
      // Back to the note the database has: nothing to send.
      expect(mockSave.mutate).toHaveBeenCalledTimes(1);

      await user.click(editButton());
      expect(field()).toHaveValue('felt heavy');
    });
  });

  it('locked: the note is read-only text, and an exercise without a note shows nothing', () => {
    const { container, rerender } = render(
      <SlotCommentBox sessionId="s-1" slotId="sl-1" comment={NOTE} locked />,
    );
    expect(shownNote()).toHaveTextContent('felt heavy');
    expect(screen.queryByRole('button')).toBeNull();
    expect(field()).toBeNull();

    rerender(<SlotCommentBox sessionId="s-1" slotId="sl-1" comment={undefined} locked />);
    expect(container).toBeEmptyDOMElement();
  });
});
