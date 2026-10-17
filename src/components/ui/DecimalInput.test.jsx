import { describe, it, expect, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DecimalInput from './DecimalInput';
import { I18nProvider } from '../../hooks/useI18n';
import { parseDecimalInput } from '../../lib/number';

// A caller as the screens write it: it holds the text, and keeps what the
// field reported with every keystroke.
function Field({ initial = '', onParsed, ...props }) {
  const [text, setText] = useState(initial);
  return (
    <DecimalInput
      aria-label="Weight"
      value={text}
      onChange={(event, parsed) => {
        setText(event.target.value);
        onParsed?.(parsed);
      }}
      {...props}
    />
  );
}

const field = () => screen.getByLabelText('Weight');

describe('<DecimalInput />', () => {
  it('is a text field with the decimal keypad, never type="number"', () => {
    render(<Field />);
    expect(field()).toHaveAttribute('type', 'text');
    expect(field()).toHaveAttribute('inputmode', 'decimal');
    expect(field()).toHaveAttribute('pattern');
    // A browser applies the pattern anchored, with the `v` flag.
    const pattern = new RegExp(`^(?:${field().getAttribute('pattern')})$`, 'v');
    expect(pattern.test('82,5')).toBe(true);
    expect(pattern.test('82.5')).toBe(true);
    expect(pattern.test('82kg')).toBe(false);
  });

  it('is 16px with and without a className of the caller (iOS zooms under it)', () => {
    const { rerender } = render(<DecimalInput aria-label="Weight" value="" onChange={() => {}} />);
    expect(field()).toHaveClass('text-[16px]');
    rerender(<DecimalInput aria-label="Weight" value="" onChange={() => {}} className="w-16 text-center" />);
    expect(field()).toHaveClass('text-[16px]', 'w-16', 'text-center');
  });

  it('is drawn as the Parc field without a className of the caller, and only then', () => {
    const { rerender } = render(<DecimalInput aria-label="Weight" value="" onChange={() => {}} />);
    expect(field()).toHaveClass('pk-field', 'pk-tnum');
    rerender(<DecimalInput aria-label="Weight" value="" onChange={() => {}} className="w-16 text-center" />);
    expect(field()).not.toHaveClass('pk-field');
  });

  it('keeps "82,5" as typed and reports 82.5', async () => {
    const onParsed = vi.fn();
    render(<Field onParsed={onParsed} />);
    await userEvent.type(field(), '82,5');
    expect(field()).toHaveValue('82,5');
    expect(onParsed).toHaveBeenLastCalledWith({ ok: true, value: 82.5 });
    expect(field()).not.toHaveAttribute('aria-invalid');
  });

  it('reports the same number for a point', async () => {
    const onParsed = vi.fn();
    render(<Field onParsed={onParsed} />);
    await userEvent.type(field(), '82.5');
    expect(field()).toHaveValue('82.5');
    expect(onParsed).toHaveBeenLastCalledWith({ ok: true, value: 82.5 });
  });

  it('does not rewrite the text under the cursor', async () => {
    // "82.0" rewritten to "82" would make the next key, 5, give 825.
    render(<Field />);
    await userEvent.type(field(), '82.05');
    expect(field()).toHaveValue('82.05');
    await userEvent.clear(field());
    await userEvent.type(field(), '82,');
    expect(field()).toHaveValue('82,');
  });

  it('marks text that is not a number, and never reports null for it', async () => {
    const onParsed = vi.fn();
    render(<Field onParsed={onParsed} />);
    await userEvent.type(field(), 'abc');
    expect(field()).toHaveValue('abc');
    expect(field()).toHaveAttribute('aria-invalid', 'true');
    expect(field()).toHaveAttribute('title', 'Enter a number, like 82.5');
    expect(onParsed).toHaveBeenCalledTimes(3);
    for (const [parsed] of onParsed.mock.calls) {
      expect(parsed).toEqual({ ok: false, reason: 'format' });
      expect(parsed).not.toHaveProperty('value');
    }
  });

  it('reports null once the field is emptied, and only then', async () => {
    const onParsed = vi.fn();
    render(<Field initial="82,5" onParsed={onParsed} />);
    await userEvent.clear(field());
    expect(onParsed).toHaveBeenLastCalledWith({ ok: true, value: null });
    expect(field()).not.toHaveAttribute('aria-invalid');
  });

  it('holds the text to the range of the caller', async () => {
    const onParsed = vi.fn();
    render(<Field onParsed={onParsed} min={1} max={500} />);
    await userEvent.type(field(), '600');
    expect(onParsed).toHaveBeenLastCalledWith({ ok: false, reason: 'range' });
    expect(field()).toHaveAttribute('aria-invalid', 'true');
    await userEvent.clear(field());
    await userEvent.type(field(), '82,5');
    expect(onParsed).toHaveBeenLastCalledWith({ ok: true, value: 82.5 });
    expect(field()).not.toHaveAttribute('aria-invalid');
  });

  it('does not mark an empty field that needs an answer until the caller does', async () => {
    const onParsed = vi.fn();
    const { rerender } = render(<Field initial="8" onParsed={onParsed} allowEmpty={false} />);
    await userEvent.clear(field());
    expect(onParsed).toHaveBeenLastCalledWith({ ok: false, reason: 'empty' });
    expect(field()).not.toHaveAttribute('aria-invalid');
    rerender(<Field allowEmpty={false} invalid />);
    expect(field()).toHaveAttribute('aria-invalid', 'true');
  });

  it('asks for a whole number with the numeric keypad', async () => {
    const onParsed = vi.fn();
    render(<Field onParsed={onParsed} integer />);
    expect(field()).toHaveAttribute('inputmode', 'numeric');
    await userEvent.type(field(), '8');
    expect(onParsed).toHaveBeenLastCalledWith({ ok: true, value: 8 });
    await userEvent.type(field(), ',5');
    expect(field()).toHaveValue('8,5');
    expect(onParsed).toHaveBeenLastCalledWith({ ok: false, reason: 'format' });
    expect(field()).toHaveAttribute('aria-invalid', 'true');
    expect(field()).toHaveAttribute('title', 'Enter a whole number');
  });

  it('shows a stored number as text, and nothing for no value', () => {
    const { rerender } = render(<DecimalInput aria-label="Weight" value={82.5} onChange={() => {}} />);
    expect(field()).toHaveValue('82.5');
    rerender(<DecimalInput aria-label="Weight" value={0} onChange={() => {}} />);
    expect(field()).toHaveValue('0');
    rerender(<DecimalInput aria-label="Weight" value={null} onChange={() => {}} />);
    expect(field()).toHaveValue('');
    rerender(<DecimalInput aria-label="Weight" value={undefined} onChange={() => {}} />);
    expect(field()).toHaveValue('');
  });

  it('works as a drop-in for the handlers the screens already have', () => {
    // (e) => setX(e.target.value) and an onBlur that commits: the first
    // argument is the native event, and the rest goes to the <input>.
    const onBlur = vi.fn();
    function Screen() {
      const [weight, setWeight] = useState('');
      return (
        <DecimalInput
          id="w"
          placeholder="kg"
          aria-label="Weight"
          value={weight}
          onChange={(e) => setWeight(e.target.value)}
          onBlur={() => onBlur(parseDecimalInput(weight))}
        />
      );
    }
    render(<Screen />);
    fireEvent.change(field(), { target: { value: '82,5' } });
    fireEvent.blur(field());
    expect(onBlur).toHaveBeenCalledWith({ ok: true, value: 82.5 });
    expect(field()).toHaveAttribute('id', 'w');
    expect(field()).toHaveAttribute('placeholder', 'kg');
  });

  it('passes disabled, a ref and a title of the caller through', () => {
    let node = null;
    render(
      <DecimalInput
        aria-label="Weight"
        value="abc"
        onChange={() => {}}
        disabled
        title="Bar weight"
        ref={(element) => {
          node = element;
        }}
      />,
    );
    expect(field()).toBeDisabled();
    expect(field()).toHaveAttribute('title', 'Bar weight');
    expect(node).toBe(field());
  });

  it('cannot be turned back into a number field by a prop', () => {
    render(<DecimalInput aria-label="Weight" value="" onChange={() => {}} type="number" inputMode="text" />);
    expect(field()).toHaveAttribute('type', 'text');
    expect(field()).toHaveAttribute('inputmode', 'decimal');
  });

  it('explains itself in the language of the app', () => {
    localStorage.setItem('sl_app_lang', 'fr');
    try {
      render(
        <I18nProvider>
          <DecimalInput aria-label="Weight" value="abc" onChange={() => {}} />
        </I18nProvider>,
      );
      expect(field()).toHaveAttribute('title', 'Saisis un nombre, par exemple 82,5');
    } finally {
      localStorage.removeItem('sl_app_lang');
    }
  });
});
