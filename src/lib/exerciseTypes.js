// The types an exercise can be, and how each is shown.
//
// One list, because the type is drawn in several places — a badge next to the
// exercise's name, an <option> of the library form, a segment of the volume
// bars — and each place used to decide by itself: `type === 'pull' ? pull :
// push`, which draws every type that is not pull as a push.
//
// A type is added HERE, with its colour token in the @theme of src/index.css,
// once the `exercise_type` enum of the database has the value
// (exerciseTypes.test.js holds the list to the enum, and each entry's colour
// to AA on the surfaces a badge sits on).
//
// `className` is the badge's tint and text, written out in full: Tailwind
// finds its classes by reading this file as text, and would not find one put
// together from a token name.
export const EXERCISE_TYPES = Object.freeze([
  Object.freeze({
    id: 'pull',
    labelKey: 'coach.library.typePull',
    className: 'bg-pull/15 text-pull',
    color: 'var(--color-pull)',
  }),
  Object.freeze({
    id: 'push',
    labelKey: 'coach.library.typePush',
    className: 'bg-push/15 text-push',
    color: 'var(--color-push)',
  }),
]);

// How a type the list does not have is shown: neutral, under its own name.
// A value the database gained before the app did, a row read by an older
// build — it must not borrow the colour of another type.
const UNLISTED = Object.freeze({
  labelKey: null,
  className: 'bg-ink-100 text-ink-500',
  color: 'var(--color-ink-400)',
});

/**
 * The entry of a type: `{ id, labelKey, className, color }`. For a type the
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
