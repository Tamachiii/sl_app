import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import EditableText from './EditableText';

describe('<EditableText />', () => {
  it('renders the value as a button initially', () => {
    render(<EditableText value="Hello" onSave={() => {}} />);
    expect(screen.getByRole('button')).toHaveTextContent('Hello');
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('shows the placeholder when value is empty', () => {
    render(<EditableText value="" onSave={() => {}} placeholder="Add title" />);
    expect(screen.getByRole('button')).toHaveTextContent('Add title');
  });

  it('clicking enters edit mode and selects existing text', async () => {
    const user = userEvent.setup();
    render(<EditableText value="Hello" onSave={() => {}} />);
    await user.click(screen.getByRole('button'));
    const input = screen.getByRole('textbox');
    expect(input).toHaveFocus();
    expect(input).toHaveValue('Hello');
  });

  it('Enter commits the trimmed draft', async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    render(<EditableText value="Hello" onSave={onSave} />);
    await user.click(screen.getByRole('button'));
    await user.clear(screen.getByRole('textbox'));
    await user.type(screen.getByRole('textbox'), '  World  {Enter}');
    expect(onSave).toHaveBeenCalledWith('World');
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('blur commits the draft', async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    render(
      <div>
        <EditableText value="Hello" onSave={onSave} />
        <button>focus sink</button>
      </div>,
    );
    await user.click(screen.getByRole('button', { name: /Edit Hello/i }));
    await user.clear(screen.getByRole('textbox'));
    await user.type(screen.getByRole('textbox'), 'Bye');
    await user.click(screen.getByRole('button', { name: /focus sink/i }));
    expect(onSave).toHaveBeenCalledWith('Bye');
  });

  it('Escape cancels and reverts the draft', async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    render(<EditableText value="Hello" onSave={onSave} />);
    await user.click(screen.getByRole('button'));
    await user.clear(screen.getByRole('textbox'));
    await user.type(screen.getByRole('textbox'), 'Discarded{Escape}');
    expect(onSave).not.toHaveBeenCalled();
    // Re-entering edit mode shows the original value.
    await user.click(screen.getByRole('button'));
    expect(screen.getByRole('textbox')).toHaveValue('Hello');
  });

  it('does not call onSave when committing an unchanged value', async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    render(<EditableText value="Hello" onSave={onSave} />);
    await user.click(screen.getByRole('button'));
    await user.type(screen.getByRole('textbox'), '{Enter}');
    expect(onSave).not.toHaveBeenCalled();
  });

  it('uses the supplied aria-label when provided', () => {
    render(<EditableText value="Week 1" onSave={() => {}} ariaLabel="Edit week label" />);
    expect(screen.getByRole('button', { name: 'Edit week label' })).toBeInTheDocument();
  });
});
