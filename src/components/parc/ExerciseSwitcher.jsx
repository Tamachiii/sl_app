import { useEffect, useRef } from 'react';

/**
 * The row of chips that picks the exercise shown on the session screen
 * (design/parc/components/ExerciseSwitcher). One chip per exercise, in the
 * session's order, with its short name and no number; the one shown is
 * `aria-current` and drawn in `ink`.
 *
 * The row scrolls sideways when the chips are wider than the screen, and the
 * chip shown is brought to the middle whenever it changes — by a tap, or by
 * the screen moving on to the next exercise — without scrolling the page.
 *
 * `items` is `[{ id, label }]`, `currentId` the one shown, `onSelect(id)`,
 * `label` the name of the row (« Exercices de la séance »).
 */
export default function ExerciseSwitcher({ items, currentId, onSelect, label }) {
  const rowRef = useRef(null);

  useEffect(() => {
    const row = rowRef.current;
    const chip = row?.querySelector('[aria-current="true"]');
    if (!row || !chip || typeof row.scrollTo !== 'function') return;
    const left = chip.offsetLeft - (row.clientWidth - chip.offsetWidth) / 2;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    row.scrollTo({ left: Math.max(0, left), behavior: reduce ? 'auto' : 'smooth' });
  }, [currentId]);

  return (
    <nav
      ref={rowRef}
      aria-label={label}
      className="-mx-4 flex gap-2 overflow-x-auto px-4 [scrollbar-width:none] md:-mx-8 md:px-8 [&::-webkit-scrollbar]:hidden"
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          className="pk-chip shrink-0"
          aria-current={item.id === currentId ? 'true' : undefined}
          onClick={() => onSelect?.(item.id)}
        >
          {item.label}
        </button>
      ))}
    </nav>
  );
}
