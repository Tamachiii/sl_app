import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useRef } from 'react';
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

// The exercise's menu opens the field through the box's `ref`: a button
// stands in for its item.
function Harness({ comment, locked }) {
  const box = useRef(null);
  return (
    <>
      <button type="button" onClick={() => box.current?.open()}>
        Open the note
      </button>
      <SlotCommentBox ref={box} sessionId="s-1" slotId="sl-1" comment={comment} locked={locked} />
    </>
  );
}

const field = () => screen.queryByRole('textbox', { name: 'Note for your coach' });
const opener = () => screen.getByRole('button', { name: 'Open the note' });
const editButton = () => screen.queryByRole('button', { name: 'Edit the note' });
const shownNote = () => screen.queryByRole('region', { name: 'Your note for the coach' });

function renderBox(comment, props = {}) {
  const view = render(<Harness comment={comment} {...props} />);
  return { ...view, rerenderBox: (next, more = {}) => view.rerender(<Harness comment={next} {...props} {...more} />) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// One exercise is shown at a time on the session screen, so the note control
// is always in the exercise: the form a collapsed card showed beside its
// header is gone with the accordion.
describe('SlotCommentBox', () => {
  it('shows nothing on an exercise without a note — the menu offers it — and the note itself on one that has it', () => {
    const { rerenderBox } = renderBox(undefined);
    expect(shownNote()).toBeNull();
    expect(screen.getAllByRole('button')).toEqual([opener()]);

    rerenderBox(NOTE);
    // The note is shown whole, signed, with the way to change it under it.
    expect(shownNote()).toHaveTextContent('felt heavy');
    expect(within(shownNote()).getByRole('button', { name: 'Edit the note' })).toBeInTheDocument();
  });

  // P68: a button is 44 px tall. jsdom lays nothing out: the 44 px are the
  // Parc button's class, whose min-height is the target size.
  it('draws its button at 44 px', () => {
    renderBox(NOTE);
    expect(editButton()).toHaveClass('pk-btn');
  });

  it('opened from the menu, it is a field named for what it is, with the focus in it', async () => {
    const user = userEvent.setup();
    renderBox(undefined);

    await user.click(opener());

    expect(field()).toBeInTheDocument();
    expect(field()).toHaveFocus();
  });

  it('opened from the menu on a note, the field holds it', async () => {
    const user = userEvent.setup();
    renderBox(NOTE);

    await user.click(opener());

    expect(field()).toHaveValue('felt heavy');
    expect(editButton()).toBeNull();
  });

  // P25. The field used to close in the save's `onSuccess`: without a network
  // the write is parked, nothing answers, and it stayed open as if the note
  // had not been taken.
  it('closes when it is left, without waiting for the answer of the save', async () => {
    const user = userEvent.setup();
    renderBox(undefined);

    await user.click(opener());
    await user.type(field(), 'felt heavy');
    await user.tab();

    expect(mockSave.mutate).toHaveBeenCalledTimes(1);
    expect(mockSave.mutate).toHaveBeenCalledWith(
      { sessionId: 's-1', slotId: 'sl-1', body: 'felt heavy' },
      expect.any(Object),
    );
    // Nothing has answered: the field is closed all the same.
    expect(field()).toBeNull();
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
    const { rerenderBox } = renderBox(NOTE);
    // The note changed while the field was closed: a save that landed, a read.
    rerenderBox({ ...NOTE, body: 'felt light' });

    await user.click(editButton());

    expect(field()).toHaveValue('felt light');
  });

  // The note changes under the field for other reasons than typing — a save
  // that is taken back, a read that comes in. What is being typed stays.
  it('does not replace what is being typed when the note changes under it', async () => {
    const user = userEvent.setup();
    const { rerenderBox } = renderBox(NOTE);
    await user.click(editButton());
    await user.type(field(), ', left elbow');

    rerenderBox(undefined);

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

    it('is what the menu opens on too', async () => {
      const user = userEvent.setup();
      await writeAndFail(user);

      await user.click(opener());
      expect(field()).toHaveValue('felt heavy, left elbow');
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

  it('locked: the note is read-only text, the menu opens nothing, and an exercise without a note shows nothing', async () => {
    const user = userEvent.setup();
    const { rerenderBox } = renderBox(NOTE, { locked: true });
    expect(shownNote()).toHaveTextContent('felt heavy');
    expect(screen.getAllByRole('button')).toEqual([opener()]);

    await user.click(opener());
    expect(field()).toBeNull();

    rerenderBox(undefined);
    expect(shownNote()).toBeNull();
    expect(screen.getAllByRole('button')).toEqual([opener()]);
  });
});
