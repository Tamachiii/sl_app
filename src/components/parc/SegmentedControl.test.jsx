import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import SegmentedControl from './SegmentedControl';

const options = [
  { value: 'pull', label: 'Tirage' },
  { value: 'push', label: 'Poussée' },
];

describe('SegmentedControl', () => {
  it('is a group named by its visible label, the choice made pressed', () => {
    render(<SegmentedControl label="Type" options={options} value="push" onChange={() => {}} />);
    const group = screen.getByRole('group', { name: 'Type' });
    expect(group).toHaveClass('pk-segmented');
    expect(screen.getByRole('button', { name: 'Poussée' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Tirage' })).toHaveAttribute('aria-pressed', 'false');
    for (const button of screen.getAllByRole('button')) expect(button).toHaveClass('pk-btn', 'pk-segment');
  });

  it('says which value was picked', () => {
    const onChange = vi.fn();
    render(<SegmentedControl label="Type" options={options} value="push" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Tirage' }));
    expect(onChange).toHaveBeenCalledWith('pull');
  });

  it('without a visible label, is named by ariaLabel', () => {
    render(<SegmentedControl ariaLabel="Language" options={options} value="pull" onChange={() => {}} />);
    const group = screen.getByRole('group', { name: 'Language' });
    expect(group).not.toHaveAttribute('aria-labelledby');
  });

  it('with a visible label, is named by it and not by ariaLabel', () => {
    render(<SegmentedControl label="Type" ariaLabel="Language" options={options} value="pull" onChange={() => {}} />);
    expect(screen.getByRole('group', { name: 'Type' })).not.toHaveAttribute('aria-label');
  });
});
