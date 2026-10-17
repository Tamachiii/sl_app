import { useId } from 'react';
import { Link } from 'react-router-dom';
import Icon from './Icon';

/**
 * A white grouped list on the page's `ground`, under a section title
 * (design/parc/components/ListGroup): the default way content is put away —
 * a roster, the sessions of a block, the history.
 *
 * `title` is the section's `h2` (« À suivre »), 10px above the list; it
 * carries information and orders by priority, never decorates. `aside` sits
 * at the right of the title (« 4 athlètes »). `ordered` makes the list an
 * <ol>. Without `title`, `label` names the list. The children are `<Row>`s.
 */
export default function ListGroup({ title, aside, label, ordered = false, className = '', children }) {
  const titleId = useId();
  const List = ordered ? 'ol' : 'ul';
  const list = (
    <List className="pk-group" aria-label={title ? undefined : label}>
      {children}
    </List>
  );
  if (!title) return <div className={className}>{list}</div>;
  return (
    <section aria-labelledby={titleId} className={`flex flex-col gap-2.5 ${className}`}>
      <div className="flex items-baseline justify-between gap-3">
        <h2 id={titleId} className="pk-headline">{title}</h2>
        {aside && <span className="pk-subhead">{aside}</span>}
      </div>
      {list}
    </section>
  );
}

/**
 * One row of a ListGroup, 60px high at least: `leading` (an avatar), the
 * title in `headline` and the second line in `caption`, then `trailing` (a
 * StatusText, a value) and a chevron when the row leads somewhere.
 *
 * The row is a router link with `to`, a link with `href`, a button with
 * `onClick`, and a plain row otherwise. `chevron` defaults to on for a link.
 * `children` replace the title and caption when a row needs more.
 */
export function Row({
  to,
  href,
  onClick,
  title,
  subtitle,
  leading,
  trailing,
  chevron,
  label,
  className = '',
  children,
  ...rest
}) {
  const isLink = Boolean(to || href);
  const showChevron = chevron ?? isLink;
  const content = (
    <>
      {leading}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        {children ?? (
          <>
            {title != null && <span className="pk-headline">{title}</span>}
            {/* The comma is for a screen reader, which reads a row that is a
                link or a button as one name. */}
            {subtitle != null && (
              <span className="pk-caption">
                {title != null && (
                  <>
                    <span className="sr-only">,</span>{' '}
                  </>
                )}
                {subtitle}
              </span>
            )}
          </>
        )}
      </span>
      {trailing != null && trailing !== false && (
        <>
          <span className="sr-only">,</span> {trailing}
        </>
      )}
      {showChevron && <Icon name="chevron-right" size={18} className="shrink-0 text-ink-2" />}
    </>
  );

  const rowClass = `pk-row ${className}`;
  let row;
  if (to) {
    row = (
      <Link to={to} aria-label={label} className={rowClass} {...rest}>
        {content}
      </Link>
    );
  } else if (href) {
    row = (
      <a href={href} aria-label={label} className={rowClass} {...rest}>
        {content}
      </a>
    );
  } else if (onClick) {
    row = (
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        className={`${rowClass} w-full bg-transparent text-left`}
        {...rest}
      >
        {content}
      </button>
    );
  } else {
    row = (
      <div className={rowClass} {...rest}>
        {content}
      </div>
    );
  }
  return <li>{row}</li>;
}

/**
 * The initials of a person in a 44px disc: `blue` on `blue-soft` (5.6:1).
 * Decorative: the name is written beside it.
 */
export function Avatar({ name, size = 44 }) {
  const initials = String(name ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join('');
  return (
    <span
      aria-hidden="true"
      className="flex shrink-0 items-center justify-center rounded-full bg-blue-soft text-[15px] font-bold text-blue"
      style={{ width: size, height: size }}
    >
      {initials}
    </span>
  );
}
