import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import ProgramScopeSelector from './ProgramScopeSelector';

describe('<ProgramScopeSelector />', () => {
  it('returns null when there are zero programs', () => {
    const { container } = render(
      <ProgramScopeSelector programs={[]} value="all" onChange={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders an "All programs" option plus one per program, newest first', () => {
    const programs = [
      { id: 'p-1', name: 'Block A', sort_order: 0, is_active: false },
      { id: 'p-2', name: 'Block B', sort_order: 1, is_active: true },
    ];
    render(<ProgramScopeSelector programs={programs} value="all" onChange={() => {}} />);
    const options = Array.from(screen.getByRole('combobox').querySelectorAll('option'));
    // First option is "All programs"; subsequent options are programs sorted newest first.
    expect(options[0].value).toBe('all');
    expect(options[1].value).toBe('p-2');
    expect(options[2].value).toBe('p-1');
  });

  it('fires onChange with the selected value', () => {
    const onChange = vi.fn();
    const programs = [{ id: 'p-1', name: 'Block A', sort_order: 0, is_active: true }];
    render(<ProgramScopeSelector programs={programs} value="all" onChange={onChange} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'p-1' } });
    expect(onChange).toHaveBeenCalledWith('p-1');
  });
});
