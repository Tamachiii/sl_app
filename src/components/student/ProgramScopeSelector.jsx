import { useI18n } from '../../hooks/useI18n';

/**
 * Which training the stats are of, as a row of chips (design/parc/screens/
 * Stats.dc.html): the block being trained, each block before it, newest
 * first, and « Tout ». One choice at a time, pressed.
 *
 * Value semantics:
 *   - 'all'       → aggregate across every program the student has done
 *   - 'active'    → restrict to the currently-active program (its chip)
 *   - <programId> → restrict to a single specific program (active or past)
 *
 * `programs` is the shallow list from `useProgramsForStudent` (id, name,
 * is_active, sort_order). The selector is hidden when there are 0 programs.
 */
export default function ProgramScopeSelector({ programs, value, onChange }) {
  const { t } = useI18n();
  const list = Array.isArray(programs) ? programs : [];

  if (list.length === 0) return null;

  const ordered = list
    .slice()
    .sort((a, b) => Number(b.is_active) - Number(a.is_active) || b.sort_order - a.sort_order);
  const options = [
    ...ordered.map((p) => ({
      value: p.id,
      label: p.is_active ? t('parcStats.scopeActive', { name: p.name }) : p.name,
      pressed: value === p.id || (value === 'active' && p.is_active),
    })),
    { value: 'all', label: t('parcStats.scopeAll'), pressed: value === 'all' },
  ];

  return (
    <div
      role="group"
      aria-label={t('parcStats.scopeLabel')}
      className="-mx-4 flex gap-2 overflow-x-auto px-4 [scrollbar-width:none] md:-mx-8 md:px-8 [&::-webkit-scrollbar]:hidden"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className="pk-chip shrink-0"
          aria-pressed={option.pressed}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
