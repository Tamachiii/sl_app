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
