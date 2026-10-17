import Icon from './Icon';
import { IconButton } from './Button';

/**
 * A passing black line above the ActionBar or the TabBar
 * (design/parc/components/Toast): it takes back what was just done, or says
 * that something failed.
 *
 * - `kind="info"`: a `status`; the message repeats the action's verb
 *   (« Série 4 sautée. ») and `actionLabel` — « Annuler », at most one
 *   action — calls `onAction`.
 * - `kind="error"`: an `alert`, with the pink cross, a sentence that says how
 *   to repair, and a round close button (`onDismiss`, `dismissLabel`).
 *
 * The toast draws; `ui/ToastHost` holds the store, the clock — 6 s, 8 with an
 * action, stopped under the finger or the focus — and the three on screen at
 * most. Other props (the pointer and focus handlers of that clock) go to the
 * toast's box.
 */
export default function Toast({
  kind = 'info',
  message,
  actionLabel,
  onAction,
  onDismiss,
  dismissLabel,
  className = '',
  ...rest
}) {
  const isError = kind === 'error';
  return (
    <div {...rest} role={isError ? 'alert' : 'status'} className={`pk-toast ${className}`}>
      {isError && <Icon name="close" size={18} strokeWidth={2.2} className="shrink-0 text-[var(--toast-error)]" />}
      <p className="min-w-0 flex-1">{message}</p>
      {actionLabel && (
        <button type="button" className="pk-btn shrink-0" onClick={onAction}>
          {actionLabel}
        </button>
      )}
      {isError && onDismiss && (
        <IconButton icon="close" size={16} tone="none" label={dismissLabel} onClick={onDismiss} />
      )}
    </div>
  );
}
