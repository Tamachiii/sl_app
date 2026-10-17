import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import SetRow from './SetRow';
import { LONG_PRESS_MS } from './useLongPress';

const inList = (row) => render(<ol className="pk-group">{row}</ol>);

describe('SetRow: the states', () => {
  it('done: a blue disc with a check, the RPE at the right', () => {
    const { container } = inList(<SetRow state="done" number={1} title="Série 1, faite" caption="5 répétitions, 20 kg" trailing="RPE 7,5" />);
    const dot = container.querySelector('.pk-set-dot');
    expect(dot).toHaveClass('pk-set-dot-done');
    expect(dot.querySelector('svg')).not.toBeNull();
    expect(screen.getByText('RPE 7,5')).toBeInTheDocument();
  });

  it('failed: the whole row on red-soft, a cross, the title in red', () => {
    const { container } = inList(<SetRow state="failed" number={2} title="Série 2, ratée" caption="3 répétitions sur 5, 20 kg" />);
    expect(container.querySelector('li')).toHaveClass('bg-red-soft', '-mx-4', 'px-4');
    expect(container.querySelector('.pk-set-dot')).toHaveClass('pk-set-dot-failed');
    expect(screen.getByText('Série 2, ratée')).toHaveClass('text-red');
  });

  it('current: a ring with the number, « En cours » in blue', () => {
    const { container } = inList(<SetRow state="current" number={3} title="Série 3" trailing="En cours" />);
    expect(container.querySelector('.pk-set-dot')).toHaveClass('pk-set-dot-current');
    expect(container.querySelector('.pk-set-dot')).toHaveTextContent('3');
    expect(screen.getByText('En cours')).toHaveClass('text-blue');
  });

  it('pending: the number on fill', () => {
    const { container } = inList(<SetRow state="pending" number={4} title="Série 4" />);
    expect(container.querySelector('.pk-set-dot')).toHaveClass('pk-set-dot-pending');
  });

  it('off the plan: the row on amber-soft, the caption in amber', () => {
    const { container } = inList(<SetRow state="offplan" number={5} title="Série 5, ajoutée" caption="Hors plan, 4 répétitions, 22,5 kg" />);
    expect(container.querySelector('li')).toHaveClass('bg-amber-soft');
    expect(screen.getByText('Hors plan, 4 répétitions, 22,5 kg')).toHaveClass('text-amber');
  });

  it('is a plain row without a gesture', () => {
    inList(<SetRow state="done" number={1} title="Série 1, faite" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('SetRow: a tap and a long press', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(props = {}) {
    const onPress = vi.fn();
    const onLongPress = vi.fn();
    inList(
      <SetRow
        state="current"
        number={3}
        title="Série 3"
        onPress={onPress}
        onLongPress={onLongPress}
        describedBy="hold-hint"
        {...props}
      />,
    );
    return { onPress, onLongPress, row: screen.getByRole('button') };
  }

  it('reads as one sentence: the title, the target and the state, separated by commas', () => {
    inList(<SetRow state="current" number={3} title="Série 3" caption="5 répétitions, 20 kg" trailing="En cours" onPress={() => {}} />);
    expect(screen.getByRole('button')).toHaveAccessibleName('Série 3, 5 répétitions, 20 kg, En cours');
  });

  it('is a button described by the sentence that says how to fail a set', () => {
    const { row } = setup();
    expect(row).toHaveClass('pk-row');
    expect(row).toHaveAttribute('aria-describedby', 'hold-hint');
  });

  it('a tap is a press', () => {
    const { row, onPress, onLongPress } = setup();
    fireEvent.pointerDown(row, { button: 0, isPrimary: true, clientX: 0, clientY: 0 });
    act(() => vi.advanceTimersByTime(100));
    fireEvent.pointerUp(row);
    fireEvent.click(row);
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('a press held 500 ms is a long press, and the click that ends it is no tap', () => {
    const { row, onPress, onLongPress } = setup();
    fireEvent.pointerDown(row, { button: 0, isPrimary: true, clientX: 0, clientY: 0 });
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS - 1));
    expect(onLongPress).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onLongPress).toHaveBeenCalledTimes(1);
    fireEvent.pointerUp(row);
    fireEvent.click(row);
    expect(onPress).not.toHaveBeenCalled();
  });

  it('a finger that travels is a scroll, and holds nothing', () => {
    const { row, onLongPress } = setup();
    fireEvent.pointerDown(row, { button: 0, isPrimary: true, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(row, { clientX: 0, clientY: 30 });
    act(() => vi.advanceTimersByTime(LONG_PRESS_MS * 2));
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('the context menu is the long press for a keyboard or a mouse, and shows no menu', () => {
    const { row, onLongPress } = setup();
    const event = fireEvent.contextMenu(row);
    expect(event).toBe(false); // default prevented
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it('a key that activates the row is a tap', () => {
    const { row, onPress } = setup();
    fireEvent.keyDown(row, { key: 'Enter' });
    fireEvent.click(row);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('holds nothing when disabled', () => {
    const { row, onLongPress } = setup({ disabled: true });
    expect(row).toBeDisabled();
    fireEvent.contextMenu(row);
    expect(onLongPress).not.toHaveBeenCalled();
  });
});
