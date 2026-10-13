import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Dialog from './Dialog';
import ConfirmDialog from './ConfirmDialog';

function renderConfirm(props = {}) {
  const onConfirm = vi.fn();
  const onClose = vi.fn();
  render(
    <ConfirmDialog
      open={true}
      onClose={onClose}
      onConfirm={onConfirm}
      title="Delete session"
      message="This cannot be undone."
      confirmText="Delete"
      {...props}
    />,
  );
  const dialog = screen.getByRole('dialog', { hidden: true });
  return { dialog, onConfirm, onClose };
}

describe('ConfirmDialog', () => {
  it('shows its message and confirms, then closes', async () => {
    const user = userEvent.setup();
    const { dialog, onConfirm, onClose } = renderConfirm();

    expect(within(dialog).getByText('This cannot be undone.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Delete', hidden: true }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onConfirm.mock.invocationCallOrder[0]).toBeLessThan(onClose.mock.invocationCallOrder[0]);
  });

  it('closes without confirming on Cancel', async () => {
    const user = userEvent.setup();
    const { dialog, onConfirm, onClose } = renderConfirm();

    await user.click(within(dialog).getByRole('button', { name: 'Cancel', hidden: true }));

    expect(onConfirm).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('labels the confirm button "Delete" when no text is given', () => {
    const { dialog } = renderConfirm({ confirmText: undefined });
    expect(within(dialog).getByRole('button', { name: 'Delete', hidden: true })).toBeInTheDocument();
  });

  // SessionView mounts the "confirm session" Dialog and, after it, the "undo
  // confirmation" ConfirmDialog; SessionEditor and ProgramSheet do the same
  // with their own pairs. The second one is the destructive question, and it
  // was announced under the title of the first.
  it('is announced under its own title when a dialog is mounted before it', () => {
    render(
      <>
        <Dialog open={false} onClose={vi.fn()} title="Confirm session">
          <p>Lock this session in?</p>
        </Dialog>
        <ConfirmDialog
          open={true}
          onClose={vi.fn()}
          onConfirm={vi.fn()}
          title="Undo confirmation?"
          message="The session opens again."
          confirmText="Undo"
        />
      </>,
    );

    const undo = screen.getByRole('dialog', { name: 'Undo confirmation?', hidden: true });
    expect(within(undo).getByText('The session opens again.')).toBeInTheDocument();
    expect(document.getElementById(undo.getAttribute('aria-labelledby'))).toHaveTextContent('Undo confirmation?');
    expect(screen.queryByRole('dialog', { name: 'Confirm session', hidden: true })).toBeNull();
  });
});
