import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import ExerciseSwitcher from './ExerciseSwitcher';

const items = [
  { id: 'a', label: 'Tractions lestées' },
  { id: 'b', label: 'Dips lestés' },
  { id: 'c', label: 'Front lever' },
];

describe('ExerciseSwitcher', () => {
  it('is a named row of chips, the one shown aria-current', () => {
    render(<ExerciseSwitcher items={items} currentId="b" label="Exercices de la séance" />);
    const nav = screen.getByRole('navigation', { name: 'Exercices de la séance' });
    const chips = screen.getAllByRole('button');
    expect(chips.map((chip) => chip.textContent)).toEqual(['Tractions lestées', 'Dips lestés', 'Front lever']);
    expect(nav).toContainElement(chips[0]);
    expect(chips[1]).toHaveAttribute('aria-current', 'true');
    expect(chips[0]).not.toHaveAttribute('aria-current');
    for (const chip of chips) expect(chip).toHaveClass('pk-chip');
  });

  it('says which exercise was picked', () => {
    const onSelect = vi.fn();
    render(<ExerciseSwitcher items={items} currentId="a" onSelect={onSelect} label="Exercices" />);
    fireEvent.click(screen.getByRole('button', { name: 'Front lever' }));
    expect(onSelect).toHaveBeenCalledWith('c');
  });

  it('scrolls the row, not the page, to the chip shown when it changes', () => {
    const scrollTo = vi.fn();
    const original = HTMLElement.prototype.scrollTo;
    HTMLElement.prototype.scrollTo = scrollTo;
    try {
      const { rerender } = render(<ExerciseSwitcher items={items} currentId="a" label="Exercices" />);
      rerender(<ExerciseSwitcher items={items} currentId="c" label="Exercices" />);
      expect(scrollTo).toHaveBeenCalledTimes(2);
      expect(scrollTo.mock.contexts.at(-1)).toBe(screen.getByRole('navigation'));
    } finally {
      HTMLElement.prototype.scrollTo = original;
    }
  });
});
