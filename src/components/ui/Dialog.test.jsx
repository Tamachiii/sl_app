import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import Dialog from './Dialog';

// jsdom doesn't support HTMLDialogElement.showModal/close natively
beforeAll(() => {
  HTMLDialogElement.prototype.showModal = HTMLDialogElement.prototype.showModal || vi.fn();
  HTMLDialogElement.prototype.close = HTMLDialogElement.prototype.close || vi.fn();
});

describe('Dialog', () => {
  it('renders title and children when open', () => {
    render(
      <Dialog open={true} onClose={vi.fn()} title="Test Dialog">
        <p>Dialog content</p>
      </Dialog>
    );
    expect(screen.getByText('Test Dialog')).toBeInTheDocument();
    expect(screen.getByText('Dialog content')).toBeInTheDocument();
  });

  it('has aria-modal attribute', () => {
    render(
      <Dialog open={true} onClose={vi.fn()} title="Accessible Dialog">
        <p>Content</p>
      </Dialog>
    );
    const dialog = screen.getByRole('dialog', { hidden: true });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  it('renders without title', () => {
    render(
      <Dialog open={true} onClose={vi.fn()}>
        <p>No title content</p>
      </Dialog>
    );
    expect(screen.getByText('No title content')).toBeInTheDocument();
  });
});

// A page mounts its dialogs once and opens them later, and a closed Dialog
// still renders its <h2>. The title of each one is therefore in the document
// at the same time as the others: what a screen reader announces for a dialog
// is whatever its `aria-labelledby` resolves to among all of them.
describe('Dialog: the title that names it', () => {
  // What a screen reader resolves: the element the dialog points at.
  const labelOf = (dialog) => document.getElementById(dialog.getAttribute('aria-labelledby'));

  function twoDialogs({ firstOpen = false, secondOpen = true } = {}) {
    return (
      <>
        <Dialog open={firstOpen} onClose={vi.fn()} title="Confirm session">
          <p>first body</p>
        </Dialog>
        <Dialog open={secondOpen} onClose={vi.fn()} title="Undo confirmation?">
          <p>second body</p>
        </Dialog>
      </>
    );
  }

  it('is its own title when another dialog is mounted before it', () => {
    render(twoDialogs());
    const [first, second] = screen.getAllByRole('dialog', { hidden: true });

    expect(first.getAttribute('aria-labelledby')).toBeTruthy();
    expect(second.getAttribute('aria-labelledby')).toBeTruthy();
    expect(second.getAttribute('aria-labelledby')).not.toBe(first.getAttribute('aria-labelledby'));

    expect(labelOf(first)).toHaveTextContent('Confirm session');
    expect(labelOf(second)).toHaveTextContent('Undo confirmation?');
    // The element it points at is inside it, not in a neighbour.
    expect(first).toContainElement(labelOf(first));
    expect(second).toContainElement(labelOf(second));
  });

  // The name a query (and a screen reader) computes exists for the dialog
  // that is open: a closed <dialog> is not rendered at all.
  it('is announced under its own name, whichever of the two is open', () => {
    const { rerender } = render(twoDialogs({ firstOpen: false, secondOpen: true }));
    const [first, second] = screen.getAllByRole('dialog', { hidden: true });

    expect(screen.getByRole('dialog', { name: 'Undo confirmation?', hidden: true })).toBe(second);
    expect(screen.queryByRole('dialog', { name: 'Confirm session', hidden: true })).toBeNull();

    rerender(twoDialogs({ firstOpen: true, secondOpen: false }));
    expect(screen.getByRole('dialog', { name: 'Confirm session', hidden: true })).toBe(first);
    expect(screen.queryByRole('dialog', { name: 'Undo confirmation?', hidden: true })).toBeNull();
  });

  it('puts no id in the document twice, whatever the number of dialogs', () => {
    render(
      <>
        {twoDialogs()}
        <Dialog open={false} onClose={vi.fn()} title="Delete phase">
          <p>third body</p>
        </Dialog>
      </>,
    );
    const ids = [...document.querySelectorAll('h2')].map((heading) => heading.id);

    expect(ids).toHaveLength(3);
    expect(ids.every(Boolean)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(document.getElementById('dialog-title')).toBeNull();
  });

  it('keeps its id when the dialog opens, closes and renders again', () => {
    const { rerender } = render(twoDialogs({ firstOpen: false, secondOpen: false }));
    const idsNow = () =>
      screen.getAllByRole('dialog', { hidden: true }).map((dialog) => dialog.getAttribute('aria-labelledby'));
    const before = idsNow();

    rerender(twoDialogs({ firstOpen: true, secondOpen: false }));
    expect(idsNow()).toEqual(before);
    rerender(twoDialogs({ firstOpen: false, secondOpen: true }));
    expect(idsNow()).toEqual(before);

    const [first, second] = screen.getAllByRole('dialog', { hidden: true });
    expect(labelOf(first)).toHaveTextContent('Confirm session');
    expect(labelOf(second)).toHaveTextContent('Undo confirmation?');
  });

  it('follows a title that changes', () => {
    const { rerender } = render(
      <Dialog open={true} onClose={vi.fn()} title="Rename program">
        <p>body</p>
      </Dialog>,
    );
    rerender(
      <Dialog open={true} onClose={vi.fn()} title="Move to trash">
        <p>body</p>
      </Dialog>,
    );

    expect(screen.getByRole('dialog', { name: 'Move to trash', hidden: true })).toBeInTheDocument();
  });

  it('points at nothing when it has no title', () => {
    render(
      <>
        <Dialog open={false} onClose={vi.fn()} title="Confirm session">
          <p>first body</p>
        </Dialog>
        <Dialog open={true} onClose={vi.fn()}>
          <p>untitled body</p>
        </Dialog>
      </>,
    );
    const [, untitled] = screen.getAllByRole('dialog', { hidden: true });

    expect(untitled).not.toHaveAttribute('aria-labelledby');
    // It does not borrow the title of the dialog mounted before it.
    expect(untitled.querySelector('h2')).toBeNull();
    expect(screen.queryByRole('dialog', { name: 'Confirm session', hidden: true })).toBeNull();
  });
});
