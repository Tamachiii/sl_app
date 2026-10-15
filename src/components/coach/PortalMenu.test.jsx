import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useRef, useState } from 'react';
import PortalMenu, { anchorOf, placeMenu, MENU_GAP, VIEWPORT_MARGIN } from './PortalMenu';

// A phone: 390 × 844. The trigger is a 44px ⋯ at the right end of a row.
function anchorAt(top, { left = 334, right = 378, vw = 390, vh = 844 } = {}) {
  return { top, bottom: top + 44, left, right, viewportWidth: vw, viewportHeight: vh };
}

describe('placeMenu', () => {
  it('opens below the trigger when the menu fits there', () => {
    const { style, upward } = placeMenu({ anchor: anchorAt(100), height: 228, width: 180 });
    expect(upward).toBe(false);
    expect(style.top).toBe(144 + MENU_GAP);
    expect(style.bottom).toBeUndefined();
    expect(style.maxHeight).toBeUndefined();
  });

  // Review findings P32 and L10: the menu of the last phase of a block hung
  // below the card and its last items were out of reach.
  it('opens above the trigger when the room below is short', () => {
    // 844 - 744 - 4 - 8 = 88px below, 228 needed.
    const { style, upward } = placeMenu({ anchor: anchorAt(700), height: 228, width: 180 });
    expect(upward).toBe(true);
    expect(style.bottom).toBe(844 - 700 + MENU_GAP);
    expect(style.top).toBeUndefined();
    expect(style.maxHeight).toBeUndefined();
  });

  it('stays below when the room above is shorter still, and scrolls inside', () => {
    const anchor = anchorAt(60, { vh: 300 });
    const { style, upward } = placeMenu({ anchor, height: 228, width: 180 });
    expect(upward).toBe(false);
    // 300 - 104 - 4 - 8
    expect(style.maxHeight).toBe(184);
    expect(style.overflowY).toBe('auto');
  });

  it('lines its right edge up with the trigger, inside the viewport', () => {
    expect(placeMenu({ anchor: anchorAt(100), height: 100, width: 180 }).style.right).toBe(390 - 378);
    // A trigger flush with the edge: the menu keeps its margin.
    const flush = anchorAt(100, { left: 346, right: 390 });
    expect(placeMenu({ anchor: flush, height: 100, width: 180 }).style.right).toBe(VIEWPORT_MARGIN);
  });

  it('lines its left edge up with a trigger at the start of a row, and never runs off the right', () => {
    const start = anchorAt(100, { left: 12, right: 56 });
    expect(placeMenu({ anchor: start, height: 100, width: 196, align: 'start' }).style.left).toBe(12);
    // On a 200px-wide screen a 196px grid cannot start at 12.
    const narrow = anchorAt(100, { left: 12, right: 56, vw: 200 });
    expect(placeMenu({ anchor: narrow, height: 100, width: 196, align: 'start' }).style.left).toBe(VIEWPORT_MARGIN);
  });

  it('never makes the menu wider than the viewport', () => {
    expect(placeMenu({ anchor: anchorAt(100), height: 100, width: 180 }).style.maxWidth).toBe(390 - 16);
  });
});

describe('anchorOf', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads the trigger box and the viewport', () => {
    const el = document.createElement('button');
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({ top: 10, bottom: 54, left: 20, right: 64 });
    expect(anchorOf(el)).toEqual({
      top: 10,
      bottom: 54,
      left: 20,
      right: 64,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });
  });
});

function Harness({ onPick = () => {} }) {
  const [anchor, setAnchor] = useState(null);
  const ref = useRef(null);
  return (
    <div data-testid="clipping" style={{ overflow: 'hidden' }}>
      <button ref={ref} type="button" onClick={(e) => setAnchor(anchorOf(e.currentTarget))}>
        open
      </button>
      {anchor && (
        <PortalMenu
          anchor={anchor}
          height={96}
          width={180}
          onClose={() => setAnchor(null)}
          returnFocus={ref}
          label="Things"
        >
          <button type="button" onClick={() => { onPick('one'); setAnchor(null); }}>one</button>
          <button type="button">two</button>
        </PortalMenu>
      )}
    </div>
  );
}

describe('PortalMenu', () => {
  it('draws the menu on <body>, outside the box that would clip it', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'open' }));
    const menu = screen.getByRole('group', { name: 'Things' });
    expect(screen.getByTestId('clipping')).not.toContainElement(menu);
    expect(menu.parentElement).toBe(document.body);
    expect(menu).toHaveClass('fixed');
  });

  it('gives the focus to its first item, and back to the trigger on Escape', () => {
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'open' });
    fireEvent.click(trigger);
    expect(screen.getByRole('button', { name: 'one' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('group', { name: 'Things' })).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('closes on a tap beside it, on a scroll and on a resize', () => {
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: 'open' });

    fireEvent.click(trigger);
    // The click-away layer is the only hidden button.
    fireEvent.click(document.body.querySelector('button[aria-hidden="true"]'));
    expect(screen.queryByRole('group', { name: 'Things' })).toBeNull();

    fireEvent.click(trigger);
    fireEvent.scroll(document.body);
    expect(screen.queryByRole('group', { name: 'Things' })).toBeNull();

    fireEvent.click(trigger);
    fireEvent(window, new Event('resize'));
    expect(screen.queryByRole('group', { name: 'Things' })).toBeNull();
  });

  it('runs the item that is pressed', () => {
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    fireEvent.click(screen.getByRole('button', { name: 'open' }));
    fireEvent.click(screen.getByRole('button', { name: 'one' }));
    expect(onPick).toHaveBeenCalledWith('one');
    expect(screen.queryByRole('group', { name: 'Things' })).toBeNull();
  });
});
