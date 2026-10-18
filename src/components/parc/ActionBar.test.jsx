import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import ActionBar, { RestCountdown, formatRestClock } from './ActionBar';
import Button from './Button';

describe('ActionBar', () => {
  it('holds the rest and the main action', () => {
    render(
      <ActionBar>
        <RestCountdown label="Repos" time="1:30" ariaLabel="Repos, 90 secondes restantes" />
        <Button variant="primary" size="lg" className="flex-1">
          Valider la série 3
        </Button>
      </ActionBar>,
    );
    const timer = screen.getByRole('timer', { name: 'Repos, 90 secondes restantes' });
    expect(timer).toHaveTextContent('Repos1:30');
    expect(timer.closest('.pk-actionbar')).toContainElement(screen.getByRole('button', { name: 'Valider la série 3' }));
  });

  // The session's neighbouring exercises: a row across the bar, over the
  // row of the main action, which keeps its rest and its button.
  it('draws `above` as a row over the row of the main action', () => {
    render(
      <ActionBar above={<button type="button">Pec Deck</button>}>
        <RestCountdown label="Repos" time="1:30" ariaLabel="Repos, 90 secondes restantes" />
        <Button variant="primary" size="lg" className="flex-1">
          Valider la série 3
        </Button>
      </ActionBar>,
    );
    const bar = screen.getByRole('timer').closest('.pk-actionbar');
    expect(bar).toHaveClass('flex-col');
    const [top, main] = [...bar.children];
    expect(top).toBe(screen.getByRole('button', { name: 'Pec Deck' }));
    expect(main).toHaveClass('flex', 'items-center');
    expect(main).toContainElement(screen.getByRole('timer'));
    expect(main).toContainElement(screen.getByRole('button', { name: 'Valider la série 3' }));
  });

  it('without `above`, is the one row it always was', () => {
    render(
      <ActionBar>
        <Button variant="primary">Confirmer la séance</Button>
      </ActionBar>,
    );
    const button = screen.getByRole('button', { name: 'Confirmer la séance' });
    expect(button.parentElement).toHaveClass('pk-actionbar');
    expect(button.parentElement).not.toHaveClass('flex-col');
  });

  it('pads its bottom with the safe area, never less than its top', () => {
    const { container } = render(<ActionBar />);
    expect(container.firstChild.style.paddingBottom).toBe('max(var(--space-3), env(safe-area-inset-bottom))');
  });

  it('draws the time in condensed blue digits, which a screen reader does not read each second', () => {
    render(<RestCountdown label="Repos" time="0:45" ariaLabel="Repos, 45 secondes restantes" />);
    const digits = screen.getByText('0:45');
    expect(digits).toHaveClass('pk-numeral-md', 'text-blue');
    expect(digits).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByRole('timer')).not.toHaveAttribute('aria-live');
  });
});

describe('formatRestClock', () => {
  it.each([
    [90, '1:30'],
    [5, '0:05'],
    [0, '0:00'],
    [-3, '0:00'],
    [720, '12:00'],
    [89.2, '1:30'],
  ])('writes %s seconds as %s', (seconds, text) => {
    expect(formatRestClock(seconds)).toBe(text);
  });
});

describe('ActionBar and the toasts', () => {
  it('lifts the toasts above itself while it is shown', () => {
    const { unmount } = render(<ActionBar />);
    expect(document.documentElement.style.getPropertyValue('--toast-lift')).toMatch(/px$/);
    unmount();
    expect(document.documentElement.style.getPropertyValue('--toast-lift')).toBe('');
  });
});
