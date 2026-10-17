import { IconButton } from './Button';

/**
 * The header of a screen (design/parc/components/LargeTitle): one condensed
 * large title, a line of context, and the round buttons that move around.
 *
 * Two forms:
 * - a top-level screen (Athlètes, Séances, Entraînement, Stats): the title at
 *   the left and `trailing` — the account menu — at the right of the same row;
 * - a detail screen (a session, the editor, a review): a row of round buttons
 *   first — `back` at the left, `actions` at the right — then the title.
 *
 * `back` is `{ label, onClick }` (from `useBackOr(fallback)`) or `{ label, to,
 * as: Link }`. `subtitle` is facts separated by commas, never a label in
 * capitals above the title. The title is the page's one `h1`.
 */
export default function LargeTitle({ title, subtitle, trailing, back, actions, className = '' }) {
  const detail = Boolean(back || actions);
  return (
    <header className={className}>
      {detail && (
        <div className="flex items-center justify-between gap-3">
          {back ? (
            <IconButton
              icon="chevron-left"
              label={back.label}
              onClick={back.onClick}
              as={back.as}
              to={back.to}
            />
          ) : (
            <span />
          )}
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={`flex items-center justify-between gap-4 ${detail ? 'mt-4' : ''}`}>
        <h1 className="pk-large-title min-w-0 break-words">{title}</h1>
        {trailing}
      </div>
      {subtitle && <p className="pk-subhead mt-1.5">{subtitle}</p>}
    </header>
  );
}
