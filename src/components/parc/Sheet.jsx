import { useEffect, useId, useRef } from 'react';
import { useI18n } from '../../hooks/useI18n';
import Button, { IconButton } from './Button';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(root) {
  return [...root.querySelectorAll(FOCUSABLE)].filter((el) => !el.closest('[inert]'));
}

/**
 * A sheet that rises from the bottom of the screen over the overlay
 * (design/parc/components/Sheet). It replaces every centred dialog: choosing
 * the RPE, typing an actual value, replacing or skipping an exercise,
 * confirming a deletion.
 *
 * It is a modal <dialog>: the page behind is inert while it is open. The
 * focus goes into the sheet when it opens, stays there — Tab and Shift+Tab
 * turn round inside it — and returns to the control that opened it when it
 * closes. Escape, the round close button and a tap on the overlay close it;
 * each calls `onClose`, as does closing it from outside (`open` → false).
 *
 * `title` is the sheet's `h2`, which names it; `description` a caption under
 * it (« De 6, facile, à 10, maximal »); `closeLabel` the name of the close
 * button (« Fermer », the default, or « Fermer sans RPE »). The children are
 * rendered only while the sheet is open.
 *
 * A reversible action needs no sheet: do it, and offer « Annuler » in a
 * toast. A sheet taller than two thirds of the screen is a screen.
 */
export default function Sheet({ open, onClose, title, description, closeLabel, className = '', children }) {
  const { t } = useI18n();
  const ref = useRef(null);
  const titleId = useId();
  const descriptionId = useId();
  // The control to give the focus back to, set while the sheet is open: an
  // opening ends once, whichever way it is closed.
  const opening = useRef(null);
  const latestOnClose = useRef(onClose);
  useEffect(() => {
    latestOnClose.current = onClose;
  });

  // The end of an opening: `onClose`, then the focus back where it was. The
  // browser also fires `close` after `dialog.close()`, a task later; by then
  // the opening is over and the event does nothing.
  function finish() {
    if (!opening.current) return;
    const { returnTo } = opening.current;
    opening.current = null;
    latestOnClose.current?.();
    if (returnTo?.isConnected && typeof returnTo.focus === 'function') returnTo.focus();
  }

  function requestClose() {
    const dialog = ref.current;
    if (dialog?.open) dialog.close();
    finish();
  }

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      opening.current = { returnTo: document.activeElement };
      dialog.showModal();
      if (!dialog.contains(document.activeElement)) {
        (dialog.querySelector('[autofocus]') ?? focusables(dialog)[0] ?? dialog).focus();
      }
    } else if (!open && dialog.open) {
      requestClose();
    }
    // requestClose reads refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function handleKeyDown(event) {
    const dialog = ref.current;
    if (event.key === 'Escape') {
      // Handled here rather than left to the browser's `cancel`, so that one
      // path closes the sheet everywhere.
      event.preventDefault();
      requestClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = focusables(dialog);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  // A tap on the overlay lands on the <dialog> itself; a tap in the sheet
  // lands on what is inside it.
  function handleClick(event) {
    if (event.target === ref.current) requestClose();
  }

  return (
    <dialog
      ref={ref}
      className="pk-sheet-dialog"
      aria-modal="true"
      aria-labelledby={title ? titleId : undefined}
      aria-describedby={description ? descriptionId : undefined}
      onClose={finish}
      onCancel={(event) => event.preventDefault()}
      onKeyDown={handleKeyDown}
      onClick={handleClick}
    >
      <section className={`pk-sheet ${className}`}>
        <div className="pk-sheet-handle" aria-hidden="true" />
        <div className="flex items-center justify-between gap-3">
          {title && (
            <h2 id={titleId} className="pk-title min-w-0">
              {title}
            </h2>
          )}
          <IconButton
            icon="close"
            size={18}
            tone="fill"
            label={closeLabel ?? t('common.close')}
            onClick={requestClose}
            className="ml-auto"
          />
        </div>
        {description && (
          <p id={descriptionId} className="pk-caption mt-1">
            {description}
          </p>
        )}
        <div className="mt-4">{open && children}</div>
      </section>
    </dialog>
  );
}

/**
 * The sheet that asks before an action that cannot be undone: the question as
 * the title, what will happen as the text, then the action — `danger` by
 * default, `primary` with `isDestructive={false}` — and a text button that
 * leaves everything as it is (`cancelText`, « Annuler » by default).
 *
 * `onConfirm` runs, then the sheet closes.
 */
export function ConfirmSheet({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmText,
  cancelText,
  isDestructive = true,
}) {
  const { t } = useI18n();
  return (
    <Sheet open={open} onClose={onClose} title={title}>
      {message && <p className="pk-body -mt-2 mb-5">{message}</p>}
      <div className="flex flex-col gap-1">
        <Button
          variant={isDestructive ? 'danger' : 'primary'}
          size="lg"
          onClick={() => {
            onConfirm();
            onClose();
          }}
        >
          {confirmText || t('common.delete')}
        </Button>
        <Button variant="text" onClick={onClose}>
          {cancelText || t('common.cancel')}
        </Button>
      </div>
    </Sheet>
  );
}
