import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import ProgramScopeSelector from './ProgramScopeSelector';

// The chips of the group, by name, in the order they are drawn.
const chips = () =>
  within(screen.getByRole('group', { name: 'Block' }))
    .getAllByRole('button')
    .map((chip) => chip.textContent);
const pressed = () =>
  within(screen.getByRole('group', { name: 'Block' }))
    .getAllByRole('button')
    .filter((chip) => chip.getAttribute('aria-pressed') === 'true')
    .map((chip) => chip.textContent);

// The block being trained is not the newest one here: the coach switched an
// older block back on.
const PROGRAMS = [
  { id: 'p-1', name: 'Block A', sort_order: 0, is_active: false },
  { id: 'p-2', name: 'Block B', sort_order: 1, is_active: true },
  { id: 'p-3', name: 'Block C', sort_order: 2, is_active: false },
];

describe('<ProgramScopeSelector />', () => {
  it('returns null when there are zero programs', () => {
    const { container } = render(
      <ProgramScopeSelector programs={[]} value="all" onChange={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('returns null while the programs list is not there', () => {
    const { container } = render(
      <ProgramScopeSelector programs={undefined} value="all" onChange={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  // design/parc/screens/Stats.dc.html: the block being trained, the blocks
  // before it newest first, then « Tout ».
  it('draws a group of chips: the active block first, the others newest first, then "All"', () => {
    render(<ProgramScopeSelector programs={PROGRAMS} value="all" onChange={() => {}} />);
    expect(chips()).toEqual(['Block B', 'Block C', 'Block A', 'All']);
  });

  it('presses the chip of the scope, and that one only', () => {
    const { rerender } = render(
      <ProgramScopeSelector programs={PROGRAMS} value="all" onChange={() => {}} />,
    );
    expect(pressed()).toEqual(['All']);

    rerender(<ProgramScopeSelector programs={PROGRAMS} value="p-3" onChange={() => {}} />);
    expect(pressed()).toEqual(['Block C']);

    // 'active' is the block being trained, whichever it is.
    rerender(<ProgramScopeSelector programs={PROGRAMS} value="active" onChange={() => {}} />);
    expect(pressed()).toEqual(['Block B']);
  });

  it('presses nothing for a block the list does not have', () => {
    render(<ProgramScopeSelector programs={PROGRAMS} value="p-ghost" onChange={() => {}} />);
    expect(pressed()).toEqual([]);
  });

  it('fires onChange with the program id of the chip, and "all" for "All"', () => {
    const onChange = vi.fn();
    render(<ProgramScopeSelector programs={PROGRAMS} value="all" onChange={onChange} />);
    const group = within(screen.getByRole('group', { name: 'Block' }));

    fireEvent.click(group.getByRole('button', { name: 'Block A' }));
    expect(onChange).toHaveBeenLastCalledWith('p-1');

    // The active block's chip names its id, not 'active': what is saved is
    // the block, which a new active block later replaces (lib/statsPrefs).
    fireEvent.click(group.getByRole('button', { name: 'Block B' }));
    expect(onChange).toHaveBeenLastCalledWith('p-2');

    fireEvent.click(group.getByRole('button', { name: 'All' }));
    expect(onChange).toHaveBeenLastCalledWith('all');
    expect(onChange).toHaveBeenCalledTimes(3);
  });
});
