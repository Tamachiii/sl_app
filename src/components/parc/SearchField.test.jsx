import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import SearchField from './SearchField';

describe('SearchField', () => {
  it('is a search field named by its label, the placeholder repeating it', () => {
    const onChange = vi.fn();
    render(<SearchField label="Rechercher un athlète" value="" onChange={onChange} />);
    const field = screen.getByRole('searchbox', { name: 'Rechercher un athlète' });
    expect(field).toHaveAttribute('placeholder', 'Rechercher un athlète');
    expect(field).toHaveClass('pk-field', 'pl-[42px]');
    fireEvent.change(field, { target: { value: 'Léa' } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('keeps its label for assistive technology only', () => {
    render(<SearchField label="Rechercher un exercice" />);
    expect(screen.getByText('Rechercher un exercice')).toHaveClass('sr-only');
  });
});
