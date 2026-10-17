import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import NumberField from './NumberField';

describe('NumberField', () => {
  it('is a text field with the decimal keypad, named by its visible label', () => {
    const onChange = vi.fn();
    render(<NumberField label="Charge en kg" value="22,5" onChange={onChange} />);
    const field = screen.getByRole('textbox', { name: 'Charge en kg' });
    expect(field).toHaveAttribute('type', 'text');
    expect(field).toHaveAttribute('inputmode', 'decimal');
    expect(field).toHaveClass('pk-field');
    expect(field).toHaveValue('22,5');
    fireEvent.change(field, { target: { value: '25' } });
    expect(onChange.mock.calls[0][1]).toEqual({ ok: true, value: 25 });
  });

  it('a refused entry: red outline, and the expected range said under the field', () => {
    render(<NumberField label="Poids de corps en kg" value="0" error="Saisis un nombre de 20 à 250." onChange={() => {}} />);
    const field = screen.getByRole('textbox', { name: 'Poids de corps en kg' });
    expect(field).toHaveAttribute('aria-invalid', 'true');
    const message = screen.getByRole('alert');
    expect(message).toHaveTextContent('Saisis un nombre de 20 à 250.');
    expect(field).toHaveAttribute('aria-describedby', message.id);
  });

  it('in a sheet: condensed 28px digits in a 56px box, whole numbers on the numeric keypad', () => {
    render(<NumberField label="Répétitions" value="5" size="lg" integer onChange={() => {}} />);
    const field = screen.getByRole('textbox', { name: 'Répétitions' });
    expect(field).toHaveClass('pk-condensed', 'min-h-button-lg', 'text-[28px]!');
    expect(field).toHaveAttribute('inputmode', 'numeric');
  });

  // A message written by the caller for several fields at once.
  it('keeps the description the caller gives when it has no error of its own', () => {
    render(
      <>
        <NumberField label="Séries" value="0" onChange={() => {}} invalid aria-describedby="slot-alert" />
        <p id="slot-alert">Un nombre entier, 1 au moins</p>
      </>,
    );
    const field = screen.getByLabelText('Séries');
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAccessibleDescription('Un nombre entier, 1 au moins');
  });
});
