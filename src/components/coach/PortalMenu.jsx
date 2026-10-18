import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

/**
 * A small menu that hangs off the button that opened it — the ⋯ of a phase,
 * the weekday picker of a session row — drawn in a portal on <body>.
 *
 * In the sheet it used to be an absolutely positioned child of its row, and
 * the sheet is one rounded group with `overflow-hidden`: it cut every menu at its
 * edge. On the last phase of a block — right after "+ Phase", the one that is
 * empty — "Reorder phases" and "Delete phase" were below the card and could
 * not be reached, and that menu is the only way to delete a phase. The card
 * keeps its `overflow-hidden` (it rounds the rows' corners); the menu is no
 * longer inside it.
 *
 * Where it goes is decided once, from the trigger's box and the viewport as
 * they were at the tap (`anchorOf`), and from the menu's height, which the
 * caller knows: its items are 44px each. Nothing is measured after it is
 * drawn, so nothing moves under the finger. It opens below the trigger, and
 * above it when the room below is short and there is more above. A page that
 * scrolls or a window that resizes closes it, since it no longer sits by its
 * trigger.
 */

// Between the trigger and the menu, and between the menu and the viewport.
export const MENU_GAP = 4;
export const VIEWPORT_MARGIN = 8;
// The menu's own padding (`p-1`), top and bottom together.
export const MENU_PADDING = 8;

/**
 * The trigger's box and the viewport, read in the click handler that opens the
 * menu — not during a render, and not in an effect that would draw twice.
 */
export function anchorOf(element) {
  const { top, bottom, left, right } = element.getBoundingClientRect();
  return {
    top,
    bottom,
    left,
    right,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
  };
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * Where a menu of `height` × `width` goes for this anchor. `align: 'end'` lines
 * its right edge up with the trigger's (a ⋯ at the end of a row), `'start'` its
 * left edge (a pill at the start of one). Returns the fixed-position style and
 * whether it opens upward.
 */
export function placeMenu({ anchor, height, width = 0, align = 'end' }) {
  const vw = anchor.viewportWidth;
  const vh = anchor.viewportHeight;
  const below = vh - anchor.bottom - MENU_GAP - VIEWPORT_MARGIN;
  const above = anchor.top - MENU_GAP - VIEWPORT_MARGIN;
  const upward = height > below && above > below;
  const room = Math.max(0, upward ? above : below);

  const style = { maxWidth: Math.max(0, vw - 2 * VIEWPORT_MARGIN) };
  if (upward) style.bottom = vh - anchor.top + MENU_GAP;
  else style.top = anchor.bottom + MENU_GAP;
  // Neither side holds it (a phone held sideways): the side with more room,
  // scrolling inside.
  if (height > room) {
    style.maxHeight = room;
    style.overflowY = 'auto';
  }
  if (align === 'start') {
    style.left = clamp(anchor.left, VIEWPORT_MARGIN, vw - width - VIEWPORT_MARGIN);
  } else {
    style.right = clamp(vw - anchor.right, VIEWPORT_MARGIN, vw - width - VIEWPORT_MARGIN);
  }
  return { style, upward };
}

/**
 * `anchor` from `anchorOf`; `height` and `width` the menu's size in px;
 * `onClose` closes it (a tap beside it, Escape, a scroll, a resize);
 * `returnFocus` a ref to the trigger, which gets the focus back on Escape.
 *
 * The first button of the menu takes the focus when it opens: drawn at the
 * end of <body>, the menu is no longer next to its trigger in the tab order.
 */
export default function PortalMenu({
  anchor, height, width, align = 'end', onClose, returnFocus, label, className = '', children,
}) {
  const panelRef = useRef(null);
  const { style, upward } = placeMenu({ anchor, height, width, align });

  useEffect(() => {
    panelRef.current?.querySelector('button')?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    function onKey(e) {
      if (e.key !== 'Escape') return;
      onClose();
      returnFocus?.current?.focus();
    }
    // A scroll of the page or of any scroller in it (capture: a scroll event
    // does not bubble) leaves the menu where the trigger no longer is.
    function onMove() {
      onClose();
    }
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onMove);
    window.addEventListener('scroll', onMove, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [onClose, returnFocus]);

  return createPortal(
    <>
      {/* Click-away layer, over the page and under the menu. */}
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="fixed inset-0 z-40 cursor-default"
      />
      <div
        ref={panelRef}
        role="group"
        aria-label={label}
        data-placement={upward ? 'above' : 'below'}
        className={`fixed z-40 rounded-control border border-line bg-surface p-1 shadow-lg ${className}`}
        style={style}
      >
        {children}
      </div>
    </>,
    document.body,
  );
}
