import { useEffect, useRef } from 'react';

// A press held this long is a long press (design/parc/components/SetRow: a set
// is marked failed by a press of 500 ms, never by a tap). A finger that
// travels more than LONG_PRESS_SLOP_PX first is a scroll, and holds nothing.
export const LONG_PRESS_MS = 500;
export const LONG_PRESS_SLOP_PX = 10;

/**
 * The handlers of a control that has a tap and a long press: spread them on
 * the element. `onPress` is the tap; `onLongPress` fires once the press has
 * lasted LONG_PRESS_MS, and the click that ends that press is swallowed.
 *
 * The context menu is the long press for those who cannot hold: a right
 * click, the menu key or Shift+F10 (WCAG 2.1.1) — and Android, which opens it
 * on a long press itself. It fires `onLongPress` and shows no menu. A key that
 * activates the control (Enter, Space) is a tap.
 *
 * `enabled: false` leaves the tap and turns the long press off.
 */
export function useLongPress({ onPress, onLongPress, enabled = true, delay = LONG_PRESS_MS }) {
  const press = useRef({ timer: null, down: false, x: 0, y: 0, fired: false });
  // The latest callbacks, so a timer started before a render calls the
  // current ones.
  const latest = useRef({ onPress, onLongPress });
  useEffect(() => {
    latest.current = { onPress, onLongPress };
  });

  useEffect(() => {
    const current = press.current;
    return () => clearTimeout(current.timer);
  }, []);

  const longPressOn = enabled && typeof onLongPress === 'function';

  function stop() {
    const p = press.current;
    clearTimeout(p.timer);
    p.timer = null;
    p.down = false;
  }

  function fire() {
    press.current.fired = true;
    latest.current.onLongPress?.();
  }

  return {
    onPointerDown(event) {
      const p = press.current;
      p.fired = false;
      stop();
      // A second mouse button or a second finger holds nothing.
      if (!longPressOn || event.button > 0 || event.isPrimary === false) return;
      p.down = true;
      p.x = event.clientX;
      p.y = event.clientY;
      p.timer = setTimeout(() => {
        p.timer = null;
        fire();
      }, delay);
    },
    onPointerMove(event) {
      const p = press.current;
      if (!p.timer) return;
      if (Math.hypot(event.clientX - p.x, event.clientY - p.y) > LONG_PRESS_SLOP_PX) stop();
    },
    onPointerUp: stop,
    onPointerCancel: stop,
    onPointerLeave: stop,
    onClick(event) {
      if (press.current.fired) {
        // The click that ends a long press: the press has done its work.
        press.current.fired = false;
        event.preventDefault();
        return;
      }
      latest.current.onPress?.(event);
    },
    onContextMenu(event) {
      if (!longPressOn) return;
      event.preventDefault();
      const p = press.current;
      if (p.fired) return; // the hold got there first
      const pressing = p.down;
      stop();
      fire();
      // Only a press still down ends in a click to swallow.
      if (!pressing) p.fired = false;
    },
    onKeyDown() {
      // A key press is never the end of a hold.
      press.current.fired = false;
    },
  };
}
