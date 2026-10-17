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
