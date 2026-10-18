import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import Sheet, { ConfirmSheet } from './Sheet';

function Harness({ onClose = () => {}, children = <button type="button">6</button>, ...props }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Valider la série 2
      </button>
      <Sheet
        open={open}
        onClose={() => {
          setOpen(false);
          onClose();
        }}
        title="RPE de la série 2"
        description="De 6, facile, à 10, maximal"
        {...props}
      >
        {children}
      </Sheet>
    </>
  );
}

const dialog = () => document.querySelector('dialog');

describe('Sheet', () => {
  it('opens as a modal dialog named by its title and described by its caption', () => {
    render(<Harness />);
    expect(dialog().open).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Valider la série 2' }));
    expect(dialog().open).toBe(true);
    expect(dialog()).toHaveAttribute('aria-modal', 'true');
    expect(dialog()).toHaveClass('pk-sheet-dialog');
    expect(dialog().getAttribute('aria-labelledby')).toBe(screen.getByRole('heading', { level: 2, name: 'RPE de la série 2' }).id);
    expect(dialog().getAttribute('aria-describedby')).toBe(screen.getByText('De 6, facile, à 10, maximal').id);
    expect(dialog().querySelector('.pk-sheet .pk-sheet-handle')).not.toBeNull();
  });

  it('renders its content only while open', () => {
    render(<Harness />);
    expect(screen.queryByText('6')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Valider la série 2' }));
    expect(screen.getByText('6')).toBeInTheDocument();
  });

  it('takes the focus when it opens', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Valider la série 2' }));
    expect(dialog()).toContainElement(document.activeElement);
  });

  it('closes on Escape and gives the focus back to what opened it', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const trigger = screen.getByRole('button', { name: 'Valider la série 2' });
    trigger.focus();
    fireEvent.click(trigger);
    fireEvent.keyDown(dialog(), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(dialog().open).toBe(false);
    expect(document.activeElement).toBe(trigger);
  });

  it('closes on its round button, named « Close » unless told otherwise', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} closeLabel="Fermer sans RPE" />);
    fireEvent.click(screen.getByRole('button', { name: 'Valider la série 2' }));
    const close = screen.getByRole('button', { name: 'Fermer sans RPE' });
    expect(close).toHaveClass('pk-icon-btn', 'bg-fill');
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(dialog().open).toBe(false);
  });

  it('closes on a tap on the overlay, and not on a tap inside', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Valider la série 2' }));
    fireEvent.click(screen.getByText('6'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(dialog());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps the focus inside: Tab from the last control goes to the first, Shift+Tab back', () => {
    render(
      <Harness>
        <button type="button">7</button>
        <button type="button">8</button>
      </Harness>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Valider la série 2' }));
    const close = screen.getByRole('button', { name: 'Close' });
    const last = screen.getByRole('button', { name: '8' });
    last.focus();
    fireEvent.keyDown(dialog(), { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(dialog(), { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it('ends an opening once, however many ways it is closed', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Valider la série 2' }));
    fireEvent.keyDown(dialog(), { key: 'Escape' });
    // The `close` event a browser fires a task after `dialog.close()`.
    fireEvent(dialog(), new Event('close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('gives two sheets of one page two titles of their own', () => {
    render(
      <>
        <Sheet open={false} onClose={() => {}} title="Un" />
        <Sheet open={false} onClose={() => {}} title="Deux" />
      </>,
    );
    const ids = [...document.querySelectorAll('dialog')].map((d) => d.getAttribute('aria-labelledby'));
    expect(new Set(ids).size).toBe(2);
  });
});

describe('ConfirmSheet', () => {
  it('asks, then runs the action and closes', () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(
      <ConfirmSheet
        open
        onClose={onClose}
        onConfirm={onConfirm}
        title="Supprimer l'exercice ?"
        message="Il n'est utilisé nulle part."
        confirmText="Supprimer l'exercice"
        cancelText="Garder l'exercice"
      />,
    );
    expect(screen.getByText("Il n'est utilisé nulle part.")).toBeInTheDocument();
    const confirm = screen.getByRole('button', { name: "Supprimer l'exercice" });
    expect(confirm).toHaveClass('pk-btn-danger', 'pk-btn-lg');
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps everything on its text button, and is primary for an action that destroys nothing', () => {
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(
      <ConfirmSheet open onClose={onClose} onConfirm={onConfirm} title="Archiver ?" confirmText="Archiver" isDestructive={false} />,
    );
    expect(screen.getByRole('button', { name: 'Archiver' })).toHaveClass('pk-btn-primary');
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(cancel).toHaveClass('pk-btn-text');
    fireEvent.click(cancel);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
