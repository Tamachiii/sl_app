import { useI18n } from '../../hooks/useI18n';
import { exerciseType, exerciseTypeLabel } from '../../lib/exerciseTypes';

// The mark of each type: the colour of its columns in the charts.
const MARK = { pull: 'bg-chart-pull', push: 'bg-chart-push' };

/**
 * What type an exercise is: `<TypeBadge type={ex.type} />`, in the Parc
 * design — a mark of the type's chart colour before its name, in `ink-2`
 * (design/parc/screens/Librairie.dc.html). The name comes from
 * lib/exerciseTypes.js; a type the list does not have is a grey mark under its
 * own name — never the colour of another type. No type (an exercise that
 * could not be read) draws nothing.
 *
 * `className` is added to the badge, for what the place needs (`shrink-0`).
 */
export default function TypeBadge({ type, className = '' }) {
  const { t } = useI18n();
  if (type == null || type === '') return null;
  const mark = MARK[exerciseType(type).id] ?? 'bg-ink-3';
  return (
    <span className={`inline-flex items-center gap-1.5 text-[14px] leading-[1.4] text-ink-2 ${className}`}>
      <span aria-hidden="true" className={`inline-block h-2.5 w-2.5 rounded-full ${mark}`} />
      {exerciseTypeLabel(type, t)}
    </span>
  );
}
