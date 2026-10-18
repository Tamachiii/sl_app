import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import CoachNote from './CoachNote';

describe('CoachNote', () => {
  it('is a region named by who speaks, the coach in blue', () => {
    render(<CoachNote title="Note du coach">Arrêt d'une seconde en haut.</CoachNote>);
    const note = screen.getByRole('region', { name: 'Note du coach' });
    expect(screen.getByRole('heading', { level: 3, name: 'Note du coach' })).toHaveClass('text-blue');
    expect(note).toHaveTextContent("Arrêt d'une seconde en haut.");
    expect(note).toHaveClass('bg-surface', 'rounded-group');
  });

  it('writes an athlete in ink', () => {
    render(
      <CoachNote title="Note de Léa, série 2" from="athlete">
        Prise qui lâche.
      </CoachNote>,
    );
    expect(screen.getByRole('heading', { name: 'Note de Léa, série 2' })).toHaveClass('text-ink');
  });

  it('shows the whole text with its line breaks', () => {
    render(<CoachNote title="Note du coach">{'Ligne 1\nLigne 2'}</CoachNote>);
    expect(screen.getByText(/Ligne 1/)).toHaveClass('whitespace-pre-line');
  });
});
