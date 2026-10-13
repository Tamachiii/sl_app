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

  // The confirm button is a coloured fill: danger for a destructive question,
  // accent otherwise. Its label is small (13px), so it needs 4.5:1 on both,
  // which `sl-on-fill` gives and white does not — the ratios themselves are
  // recomputed from the stylesheet in src/test/contrast.test.js.
  describe('confirm button', () => {
    const confirmButton = (dialog) => within(dialog).getByRole('button', { name: 'Delete', hidden: true });
    // Every class of the button that sets something about its text.
    const textClasses = (button) => [...button.classList].filter((name) => name.includes('text-'));

    it('is a danger fill for a destructive question, which is the default', () => {
      const { dialog } = renderConfirm();
      expect(confirmButton(dialog).getAttribute('style')).toContain('background: var(--color-danger)');
    });

    it('is an accent fill otherwise', () => {
      const { dialog } = renderConfirm({ isDestructive: false });
      expect(confirmButton(dialog).getAttribute('style')).toContain('background: var(--color-accent)');
    });

    it.each([
      ['danger', true],
      ['accent', false],
    ])('writes its label in the on-fill colour on %s, and in no other', (_fill, isDestructive) => {
      const { dialog } = renderConfirm({ isDestructive });
      const button = confirmButton(dialog);

      expect(button).toHaveClass('sl-on-fill');
      expect(button).not.toHaveClass('text-white');
      // Its size, and nothing that could colour it: `text-ink-900` and
      // `text-gray-900` are cream in the dark theme.
      expect(textClasses(button)).toEqual(['text-[13px]']);
      expect(button.getAttribute('style')).not.toMatch(/(?:^|;\s*)color:/);
    });

    it('leaves Cancel a neutral button', () => {
      const { dialog } = renderConfirm();
      const cancel = within(dialog).getByRole('button', { name: 'Cancel', hidden: true });
      expect(cancel).not.toHaveClass('sl-on-fill');
      expect(cancel.getAttribute('style')).toBeNull();
    });
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
