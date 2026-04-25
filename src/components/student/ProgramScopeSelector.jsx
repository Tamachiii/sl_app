import { useI18n } from '../../hooks/useI18n';

/**
 * Stats-page program scope selector.
 *
 * Value semantics:
 *   - 'all'      → aggregate across every program the student has done
 *   - 'active'   → restrict to the currently-active program
 *   - <programId> → restrict to a single specific program (active or past)
 *
 * `programs` is the shallow list from `useProgramsForStudent` (id, name,
 * is_active, sort_order). The selector is hidden when there are 0 programs.
 */
export default function ProgramScopeSelector({ programs, value, onChange }) {
  const { t } = useI18n();
  const list = Array.isArray(programs) ? programs : [];

  if (list.length === 0) return null;

  // Programs sorted oldest → newest by sort_order; reverse so the newest
  // (most recent) program shows first under "All programs".
  const orderedByRecency = list.slice().sort((a, b) => b.sort_order - a.sort_order);

  return (
    <label className="block">
      <span className="sl-label text-ink-400 block mb-1.5">
        {t('student.stats.scopeLabel')}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-ink-200 bg-white px-3 py-2 sl-mono text-[16px] text-gray-900 focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
      >
        <option value="all">{t('student.stats.scopeAll')}</option>
        {orderedByRecency.map((p) => (
          <option key={p.id} value={p.id}>
            {p.is_active
              ? t('student.stats.scopeActiveOption', { name: p.name })
              : p.name}
          </option>
        ))}
      </select>
    </label>
  );
}
