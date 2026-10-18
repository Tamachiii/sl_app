import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import LargeTitle from './LargeTitle';
import { IconButton } from './Button';

describe('LargeTitle', () => {
  it('on a top-level screen: the title, the account at its right, the facts under it', () => {
    render(
      <LargeTitle
        title="Athlètes"
        subtitle="4 athlètes, 2 séances à revoir"
        trailing={<button type="button">Menu du compte</button>}
      />,
    );
    const title = screen.getByRole('heading', { level: 1, name: 'Athlètes' });
    expect(title).toHaveClass('pk-large-title');
    expect(title.parentElement).toContainElement(screen.getByRole('button', { name: 'Menu du compte' }));
    expect(screen.getByText('4 athlètes, 2 séances à revoir')).toHaveClass('pk-subhead');
  });

  it('on a detail screen: the round back button and the actions above the title', () => {
    const back = vi.fn();
    render(
      <LargeTitle
        title="Haut 1"
        back={{ label: "Retour à l'entraînement", onClick: back }}
        actions={<IconButton icon="more" label="Options de la séance" />}
      />,
    );
    const backButton = screen.getByRole('button', { name: "Retour à l'entraînement" });
    expect(backButton).toHaveClass('pk-icon-btn');
    fireEvent.click(backButton);
    expect(back).toHaveBeenCalledTimes(1);
    // The row of buttons comes before the title.
    const title = screen.getByRole('heading', { level: 1 });
    expect(backButton.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Options de la séance' })).toBeInTheDocument();
  });

  it('draws no row of buttons on a top-level screen', () => {
    render(<LargeTitle title="Stats" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
