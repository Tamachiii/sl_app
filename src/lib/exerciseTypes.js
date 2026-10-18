// The types an exercise can be, and how each is shown.
//
// One list, because the type is drawn in several places — a badge next to the
// exercise's name, an <option> of the library form, a segment of the volume
// bars — and each place used to decide by itself: `type === 'pull' ? pull :
// push`, which draws every type that is not pull as a push.
//
// A type is added HERE, with its chart colour in design/parc/tokens.json (and
// so in src/styles/parc-tokens.css), once the `exercise_type` enum of the
// database has the value (exerciseTypes.test.js holds the list to the enum,
// and each mark to a Parc token that stands out of the surfaces it sits on).
//
// `mark` is the class of the type's mark — the colour of its columns in the
// charts (design/parc: `chart-pull`, `chart-push`) —, written out in full:
// Tailwind finds its classes by reading this file as text, and would not find
// one put together from a token name. `color` is the same colour for a chart.
export const EXERCISE_TYPES = Object.freeze([
  Object.freeze({
    id: 'pull',
    labelKey: 'coach.library.typePull',
    mark: 'bg-chart-pull',
    color: 'var(--chart-pull)',
  }),
  Object.freeze({
    id: 'push',
    labelKey: 'coach.library.typePush',
    mark: 'bg-chart-push',
    color: 'var(--chart-push)',
  }),
]);

// How a type the list does not have is shown: neutral, under its own name.
// A value the database gained before the app did, a row read by an older
// build — it must not borrow the colour of another type.
const UNLISTED = Object.freeze({
  labelKey: null,
  mark: 'bg-ink-3',
  color: 'var(--ink-3)',
});

/**
 * The entry of a type: `{ id, labelKey, mark, color }`. For a type the
 * list does not have, the neutral entry under that id, `labelKey` null.
 */
export function exerciseType(id) {
  return EXERCISE_TYPES.find((type) => type.id === id) ?? { ...UNLISTED, id: id ?? null };
}

/**
 * The name of a type in the language of `t` (from useI18n). A type the list
 * does not have is named by its own id; no type at all is ''.
 */
export function exerciseTypeLabel(id, t) {
  const { labelKey } = exerciseType(id);
  if (labelKey) return t(labelKey);
  return id == null ? '' : String(id);
}
