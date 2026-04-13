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
