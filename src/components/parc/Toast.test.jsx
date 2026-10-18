import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import Toast from './Toast';

describe('Toast', () => {
  it('an info toast is a status with its one action', () => {
    const onAction = vi.fn();
    render(<Toast message="Série 4 sautée." actionLabel="Annuler" onAction={onAction} onDismiss={() => {}} dismissLabel="Ignorer" />);
    const toast = screen.getByRole('status');
    expect(toast).toHaveClass('pk-toast');
    expect(toast).toHaveTextContent('Série 4 sautée.');
    fireEvent.click(screen.getByRole('button', { name: 'Annuler' }));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Ignorer' })).not.toBeInTheDocument();
  });

  it('an error is an alert with the cross and a close button', () => {
    const onDismiss = vi.fn();
    const { container } = render(
      <Toast kind="error" message="Non enregistré. Vérifie ta connexion et réessaie." onDismiss={onDismiss} dismissLabel="Fermer" />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Non enregistré.');
    expect(container.querySelector('svg.text-\\[var\\(--toast-error\\)\\]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Fermer' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('passes the handlers of the clock to its box', () => {
    const onPointerEnter = vi.fn();
    render(<Toast message="Séance archivée." onPointerEnter={onPointerEnter} />);
    fireEvent.pointerEnter(screen.getByRole('status'));
    expect(onPointerEnter).toHaveBeenCalledTimes(1);
  });
});
