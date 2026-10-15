import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import RpeInput, { RPE_VALUES, formatRpe } from './RpeInput';

// L34: half steps from 6 to 10.
const OFFERED = ['6', '6.5', '7', '7.5', '8', '8.5', '9', '9.5', '10'];

describe('RpeInput', () => {
  it('offers the nine ratings from 6 to 10 in half steps, in order', () => {
    render(<RpeInput value={null} onChange={vi.fn()} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(OFFERED.map((n) => `RPE ${n}`));
    expect(buttons.map((b) => b.textContent)).toEqual(OFFERED);
    expect(RPE_VALUES).toEqual([6, 6.5, 7, 7.5, 8, 8.5, 9, 9.5, 10]);
    // Nothing below 6 is offered.
    for (let i = 1; i <= 5; i++) {
      expect(screen.queryByRole('button', { name: `RPE ${i}` })).toBeNull();
    }
  });

  it('calls onChange with the number of the rating clicked, half steps included', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<RpeInput value={null} onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: 'RPE 7.5' }));
    expect(onChange).toHaveBeenLastCalledWith(7.5);
    await user.click(screen.getByRole('button', { name: 'RPE 8' }));
    expect(onChange).toHaveBeenLastCalledWith(8);
  });

  it('clicks every rating', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<RpeInput value={null} onChange={onChange} />);

    for (const n of RPE_VALUES) {
      await user.click(screen.getByRole('button', { name: `RPE ${n}` }));
      expect(onChange).toHaveBeenLastCalledWith(n);
    }
    expect(onChange).toHaveBeenCalledTimes(9);
  });

  it('toggles off when clicking the active rating', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<RpeInput value={7.5} onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: 'RPE 7.5' }));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('has aria-pressed on the selected rating only', () => {
    render(<RpeInput value={8.5} onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'RPE 8.5' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'RPE 8' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'RPE 9' })).toHaveAttribute('aria-pressed', 'false');
  });

  // A rating not offered any more — 1 to 5 from before half steps, or from an
  // older build — would otherwise be on the set with no button to take it back.
  it('shows a rating that is not offered any more first, pressed, and lets it be taken back', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<RpeInput value={4} onChange={onChange} />);

    const buttons = screen.getAllByRole('button');
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(
      ['4', ...OFFERED].map((n) => `RPE ${n}`),
    );
    expect(buttons[0]).toHaveAttribute('aria-pressed', 'true');
    await user.click(buttons[0]);
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('reads a rating handed over as text like the number it is', () => {
    render(<RpeInput value="7.5" onChange={vi.fn()} />);
    expect(screen.getAllByRole('button')).toHaveLength(9);
    expect(screen.getByRole('button', { name: 'RPE 7.5' })).toHaveAttribute('aria-pressed', 'true');
  });

  // P68. jsdom lays nothing out, so the size is read from the classes: two
  // rows of five, each button 44 px tall (`h-11`), not ten columns of 36 px.
  it('lays the ratings out in rows of five, each 44 px tall', () => {
    render(<RpeInput value={null} onChange={vi.fn()} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(9);
    const grid = buttons[0].parentElement;
    expect(grid).toHaveClass('grid-cols-5');
    expect(grid).not.toHaveClass('grid-cols-10');
    for (const button of buttons) {
      expect(button).toHaveClass('h-11');
      expect(button.parentElement).toBe(grid);
    }
  });

  it('writes a half step with the decimal separator of the language', () => {
    expect(formatRpe(7.5, 'en')).toBe('7.5');
    expect(formatRpe(7.5, 'fr')).toBe('7,5');
    expect(formatRpe(7.5, 'de')).toBe('7,5');
    expect(formatRpe(8, 'fr')).toBe('8');
  });
});
