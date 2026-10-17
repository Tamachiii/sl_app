import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import SelectField from './SelectField';

describe('SelectField', () => {
  it('is a select named by its written label, drawn as a pk-field', () => {
    const onChange = vi.fn();
    render(
      <SelectField label="Athlète" value="" onChange={onChange}>
        <option value="">Tous les athlètes</option>
        <option value="a1">Léa Martin</option>
      </SelectField>,
    );
    const select = screen.getByRole('combobox', { name: 'Athlète' });
    expect(select).toHaveClass('pk-field');
    expect(screen.getByText('Athlète')).toHaveClass('pk-caption');
    fireEvent.change(select, { target: { value: 'a1' } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('passes disabled through to the select', () => {
    render(
      <SelectField label="Bloc" disabled>
        <option value="">Choisis d’abord un athlète</option>
      </SelectField>,
    );
    expect(screen.getByRole('combobox', { name: 'Bloc' })).toBeDisabled();
  });
});
