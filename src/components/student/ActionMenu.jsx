import { useRef, useState } from 'react';
import { Icon, IconButton, Row, Sheet } from '../parc';

/**
 * A round « ⋯ » and the sheet of actions it opens: one row per item, its icon
 * in a `blue-soft` disc, its title and an optional caption. Used for the
 * actions that are not the way through a session — the exercise's (replace,
 * skip, a note) and the session's (finish it before every set is done).
 *
 * `items` are `{ key, icon, title, subtitle?, disabled?, onSelect }`; with
 * none, nothing is drawn. `label` names the button and `title` the sheet.
 * `tone` is the button's (`IconButton`): `fill` on `surface`.
 *
 * An item's `onSelect` runs once the sheet has closed and given the focus
 * back to the « ⋯ », so it may open another sheet — which then gives the focus
 * back to the « ⋯ » too — or put the focus in a field.
 */
export default function ActionMenu({ label, title, items, tone, className = '' }) {
  const [open, setOpen] = useState(false);
  const chosen = useRef(null);

  if (items.length === 0) return null;

  function choose(item) {
    chosen.current = item.onSelect;
    setOpen(false);
  }

  // Called by the sheet once per opening, however it is closed: with an item
  // chosen, its action follows.
  function handleClose() {
    setOpen(false);
    const action = chosen.current;
    chosen.current = null;
    action?.();
  }

  return (
    <>
      <IconButton icon="more" label={label} tone={tone} className={className} onClick={() => setOpen(true)} />
      <Sheet open={open} onClose={handleClose} title={title}>
        <ul className="pk-group p-0">
          {items.map((item) => (
            <Row
              key={item.key}
              onClick={() => choose(item)}
              disabled={item.disabled}
              leading={
                <span className="pk-set-dot bg-blue-soft text-blue" aria-hidden="true">
                  <Icon name={item.icon} size={18} />
                </span>
              }
              title={item.title}
              subtitle={item.subtitle}
              className="disabled:opacity-45"
            />
          ))}
        </ul>
      </Sheet>
    </>
  );
}
