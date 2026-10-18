/**
 * The exercises of a session as a row of dots, over the ActionBar's main
 * action: the exercise shown is a pill in `ink`, a finished one a full `blue`
 * disc, the others a `line-strong` disc — the shape says which is shown, the
 * colour what is done, like WeekDots. It points at nothing: the exercise
 * before and the one after, named on either side, are the buttons.
 *
 * `count` is the number of exercises, `current` the index of the one shown,
 * `done` the indexes of the finished ones; `label` the sentence that says it
 * (« Exercice 2 sur 4, 1 terminé »).
 */
export default function ExerciseSteps({ count, current, done = [], label }) {
  const finished = new Set(done);
  return (
    <span className="pk-steps" role="img" aria-label={label}>
      {Array.from({ length: count }, (_, index) => (
        <span
          key={index}
          className={index === current ? 'is-current' : finished.has(index) ? 'is-done' : undefined}
        />
      ))}
    </span>
  );
}
