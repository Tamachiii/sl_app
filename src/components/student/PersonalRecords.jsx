import { useI18n } from '../../hooks/useI18n';
import { useStudentRecords } from '../../hooks/useStudentRecords';
import Spinner from '../ui/Spinner';

/**
 * Per-exercise all-time personal records. Weighted exercises show estimated
 * 1RM + the best single set; a recent PR gets a celebratory badge.
 *
 * NOTE: a bodyweight-relative "×BW" figure is intentionally NOT shown yet.
 * set_logs stores ADDED load for weighted calisthenics but FULL load for
 * barbell lifts, and the exercise library has no flag to tell them apart, so
 * a single ×BW would understate weighted-bodyweight lifts (a 30kg weighted
 * pull-up at 70kg BW is ~1.4× relative strength, not 0.43×). Correct relative
 * strength needs a bodyweight-movement model on exercises — a follow-up. The
 * bodyweight series is still logged (BodyweightCard) to feed it.
 *
 * `studentRowId` (the students-table id) is optional — omit for the signed-in
 * student, pass it on the coach surface.
 */
export default function PersonalRecords({ studentRowId }) {
  const { t } = useI18n();
  const { data: records, isLoading } = useStudentRecords(studentRowId);

  return (
    <section aria-labelledby="profile-records-heading" className="space-y-2">
      <h2 id="profile-records-heading" className="sl-label text-ink-400">
        {t('student.profile.records.title')}
      </h2>
      {isLoading ? (
        <div className="flex justify-center py-6"><Spinner /></div>
      ) : !records || records.length === 0 ? (
        <div className="sl-card p-4">
          <p className="sl-mono text-[11px] text-ink-400">{t('student.profile.records.empty')}</p>
        </div>
      ) : (
        <ul className="space-y-2">
          {records.map((r) => {
            return (
              <li key={r.exercise_id} className="sl-card p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="sl-display text-[15px] text-gray-900 truncate">{r.name}</span>
                  {r.recent && (
                    <span
                      className="sl-pill text-ink-900 shrink-0"
                      style={{ background: 'color-mix(in srgb, var(--color-accent) 22%, transparent)' }}
                    >
                      {t('student.profile.records.newPr')}
                    </span>
                  )}
                </div>
                <div className="sl-mono text-[11px] text-ink-400 mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                  {r.bestE1rm ? (
                    <>
                      <span>
                        {t('student.profile.records.est1rm')}{' '}
                        <span className="text-gray-800" style={{ color: 'var(--color-accent)' }}>
                          {r.bestE1rm} kg
                        </span>
                      </span>
                      <span>
                        {t('student.profile.records.best', {
                          weight: r.bestE1rmWeight,
                          reps: r.bestE1rmReps,
                        })}
                      </span>
                    </>
                  ) : (
                    <span>
                      {t('student.profile.records.bestReps')}{' '}
                      <span className="text-gray-800" style={{ color: 'var(--color-accent)' }}>
                        {t('student.profile.records.reps', { n: r.bestReps })}
                      </span>
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
