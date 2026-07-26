import { useI18n } from '../../hooks/useI18n';
import StudentGoalsSection from './StudentGoalsSection';
import StudentStatsSection from './StudentStatsSection';

/**
 * "Progress" — one tab answering one question: how is this athlete doing?
 *
 * Goals and Stats were separate tabs, but they are two halves of the same
 * answer: goals are the TARGETS, stats are the EVIDENCE. Reading them in that
 * order ("aiming at 100kg bench" → "here is the volume and progression") beats
 * flipping between two destinations. Both children still call
 * `useOutletContext()` themselves — React Router's outlet context reaches any
 * descendant, so nesting them changes nothing about how they resolve the
 * student.
 */
export default function StudentProgressSection() {
  const { t } = useI18n();

  return (
    <div className="space-y-6">
      <section aria-labelledby="goals-heading" className="space-y-2">
        <h3 id="goals-heading" className="sl-label text-ink-400">
          {t('coach.tabs.goals')}
        </h3>
        <StudentGoalsSection />
      </section>

      <div className="sl-hairline" />

      <section aria-labelledby="stats-heading" className="space-y-2">
        <h3 id="stats-heading" className="sl-label text-ink-400">
          {t('coach.tabs.stats')}
        </h3>
        <StudentStatsSection />
      </section>
    </div>
  );
}
