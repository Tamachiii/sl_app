import { useCallback, useState } from 'react';
import { useI18n } from '../../hooks/useI18n';
import { useStudentRecords } from '../../hooks/useStudentRecords';
import Spinner from '../ui/Spinner';

// Open/closed survives reloads. A student who checks their PRs every session
// shouldn't have to re-open the list each visit, and one who never does
// shouldn't have to re-collapse it. Same rationale as the coach's
// sl_coach_student_sections.
const OPEN_KEY = 'sl_student_records_open';

function readOpen() {
  try {
    return localStorage.getItem(OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

function writeOpen(open) {
  try {
    localStorage.setItem(OPEN_KEY, open ? '1' : '0');
  } catch {
    /* private mode / quota — the toggle still works, it just won't remember */
  }
}

/**
 * Per-exercise all-time personal records. Weighted exercises show estimated
 * 1RM + the best single set; a recent PR gets a celebratory badge.
 *
 * The list is COLLAPSED behind a count row by default: it grows one card per
 * exercise the student has ever logged, which buried the rest of the profile
 * page. The fresh-PR badge is mirrored onto the collapsed row so the one thing
 * this section exists to celebrate stays visible while it's folded away.
 *
 * Relative strength (×BW): once a coach classifies an exercise's load_mode and
 * the student has logged bodyweight, each record also shows its peak ×BW — the
 * strongest single relative to bodyweight (system load ÷ bodyweight for an
 * 'added' movement, logged load ÷ bodyweight for a 'full' one). The est-1RM
 * headline is unchanged; unclassified exercises or an unknown bodyweight simply
 * show no pill.
 *
 * `studentRowId` (the students-table id) is optional — omit for the signed-in
 * student, pass it on the coach surface.
 */
export default function PersonalRecords({ studentRowId }) {
  const { t } = useI18n();
  const { data: records, isLoading } = useStudentRecords(studentRowId);
  const [open, setOpen] = useState(readOpen);

  const toggle = useCallback(() => {
    setOpen((prev) => {
      writeOpen(!prev);
      return !prev;
    });
  }, []);

  const list = records || [];

  // Student's own view only: nudge to log bodyweight when a classified 'added'
  // movement is missing the ×BW it would otherwise show. The coach can't log
  // the student's weight, so it's suppressed on the coach surface.
  const showBwNudge =
    !studentRowId &&
    list.some((r) => r.bestE1rm && r.loadMode === 'added' && r.bwAtBest == null);

  const hasRecentPr = list.some((r) => r.recent);

  function scrollToBodyweight() {
    document
      .getElementById('profile-bodyweight-heading')
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  return (
    <section aria-labelledby="profile-records-heading" className="space-y-2">
      <h2 id="profile-records-heading" className="sl-label text-ink-400">
        {t('student.profile.records.title')}
      </h2>
      {isLoading ? (
        <div className="flex justify-center py-6"><Spinner /></div>
      ) : list.length === 0 ? (
        <div className="sl-card p-4">
          <p className="sl-mono text-[11px] text-ink-400">{t('student.profile.records.empty')}</p>
        </div>
      ) : (
        <>
          <button
            type="button"
            onClick={toggle}
            aria-expanded={open}
            aria-controls="profile-records-panel"
            className="sl-card w-full flex items-center justify-between gap-2 px-3 py-2.5 text-left hover:bg-ink-50 transition-colors"
          >
            <span className="sl-mono text-[12px] text-ink-700">
              {t(
                list.length === 1
                  ? 'student.profile.records.countOne'
                  : 'student.profile.records.countMany',
                { n: list.length },
              )}
            </span>
            <span className="flex items-center gap-2 shrink-0">
              {hasRecentPr && (
                <span
                  className="sl-pill text-ink-900"
                  style={{ background: 'color-mix(in srgb, var(--color-accent) 22%, transparent)' }}
                >
                  {t('student.profile.records.newPr')}
                </span>
              )}
              <svg
                className={`w-3.5 h-3.5 text-ink-400 transition-transform ${open ? 'rotate-90' : ''}`}
                fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </span>
          </button>

          {open && (
            <div id="profile-records-panel" className="space-y-2">
              {showBwNudge && (
                <button
                  type="button"
                  onClick={scrollToBodyweight}
                  className="sl-mono text-[11px] w-full text-left rounded-lg px-3 py-2"
                  style={{
                    background: 'color-mix(in srgb, var(--color-accent) 8%, transparent)',
                    color: 'var(--color-accent)',
                  }}
                >
                  {t('student.profile.records.bwNudge')}
                </button>
              )}
              <ul className="space-y-2">
                {list.map((r) => {
                  const isAdded = r.loadMode === 'added';
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
                              {t(
                                isAdded
                                  ? 'student.profile.records.bestAdded'
                                  : 'student.profile.records.best',
                                { weight: r.bestE1rmWeight, reps: r.bestE1rmReps },
                              )}
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
                        {r.relStrength != null && (
                          <span className="text-gray-800" style={{ color: 'var(--color-accent)' }}>
                            {t('student.profile.records.relStrength', { mult: r.relStrength.toFixed(1) })}
                          </span>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </>
      )}
    </section>
  );
}
