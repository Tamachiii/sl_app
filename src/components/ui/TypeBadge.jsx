import { useI18n } from '../../hooks/useI18n';
import { exerciseType, exerciseTypeLabel } from '../../lib/exerciseTypes';

/**
 * The pill that says what type an exercise is: `<TypeBadge type={ex.type} />`.
 *
 * Colour and name come from lib/exerciseTypes.js, so a type added to that
 * list is drawn here without a change. A type the list does not have is a
 * neutral pill under its own name — never the colour of another type. No type
 * (an exercise that could not be read) draws nothing.
 *
 * `className` is added to the pill, for what the place needs (`shrink-0`).
 */
export default function TypeBadge({ type, className = '' }) {
  const { t } = useI18n();
  if (type == null || type === '') return null;
  const classes = ['sl-pill', exerciseType(type).className, className].filter(Boolean).join(' ');
  return <span className={classes}>{exerciseTypeLabel(type, t)}</span>;
}
