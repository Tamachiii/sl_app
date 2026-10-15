import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import RpeInput from './RpeInput';

describe('RpeInput', () => {
  it('renders all 10 RPE buttons', () => {
    render(<RpeInput value={null} onChange={vi.fn()} />);
    for (let i = 1; i <= 10; i++) {
      expect(screen.getByRole('button', { name: `RPE ${i}` })).toBeInTheDocument();
    }
  });

  it('calls onChange with the clicked RPE value', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<RpeInput value={null} onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: 'RPE 7' }));
    expect(onChange).toHaveBeenCalledWith(7);
  });

  it('toggles off when clicking the active RPE', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<RpeInput value={5} onChange={onChange} />);

    await user.click(screen.getByRole('button', { name: 'RPE 5' }));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('has aria-pressed on selected button', () => {
    render(<RpeInput value={3} onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'RPE 3' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'RPE 4' })).toHaveAttribute('aria-pressed', 'false');
  });

  // P68. jsdom lays nothing out, so the size is read from the classes: two
  // rows of five, each button 44 px tall (`h-11`), not ten columns of 36 px.
  it('lays the ten ratings out in two rows of five, each 44 px tall', () => {
    render(<RpeInput value={null} onChange={vi.fn()} />);
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(10);
    const grid = buttons[0].parentElement;
    expect(grid).toHaveClass('grid-cols-5');
    expect(grid).not.toHaveClass('grid-cols-10');
    for (const button of buttons) {
      expect(button).toHaveClass('h-11');
      expect(button.parentElement).toBe(grid);
    }
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual(
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => `RPE ${n}`),
    );
  });

  it('clicks every RPE button 1-10', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<RpeInput value={null} onChange={onChange} />);

    for (let i = 1; i <= 10; i++) {
      await user.click(screen.getByRole('button', { name: `RPE ${i}` }));
      expect(onChange).toHaveBeenCalledWith(i);
    }
    expect(onChange).toHaveBeenCalledTimes(10);
  });
});
