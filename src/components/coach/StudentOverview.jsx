import { useCallback, useState } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import { useI18n } from '../../hooks/useI18n';
import StudentProgrammingSection from './StudentProgrammingSection';
import StudentGoalsSection from './StudentGoalsSection';
import StudentStatsSection from './StudentStatsSection';

const PREFS_KEY = 'sl_coach_student_sections';

function readPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writePref(key, open) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...readPrefs(), [key]: open }));
  } catch {
    /* private mode / quota — the section still works, it just won't remember */
  }
}

/**
 * One collapsible block of the single Student page. Open/closed is remembered
 * across athletes and reloads: a coach who never looks at Stats shouldn't have
 * to collapse it every visit.
 */
function Section({ id, title, defaultOpen = false, children }) {
  const [open, setOpen] = useState(() => readPrefs()[id] ?? defaultOpen);

  const toggle = useCallback(() => {
    setOpen((prev) => {
      writePref(id, !prev);
      return !prev;
    });
  }, [id]);

  const headingId = `section-${id}-heading`;
  const panelId = `section-${id}-panel`;

  return (
    <section aria-labelledby={headingId}>
      <h3 id={headingId}>
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-controls={panelId}
          className="w-full flex items-center gap-2 py-2 text-left group"
        >
          <span className="sl-label text-ink-400 group-hover:text-ink-700 transition-colors">
            {title}
          </span>
          <span className="flex-1 sl-hairline" aria-hidden="true" />
          <svg
            className={`w-3.5 h-3.5 text-ink-400 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
            fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </h3>
      {/* Unmounted, not hidden: Stats runs a heavy aggregate query and Goals a
          profile-id resolve — a collapsed section shouldn't pay for either. */}
      {open && <div id={panelId} className="pt-1 pb-2">{children}</div>}
    </section>
  );
}

/**
 * The athlete header's actions: the two places a coach goes FROM an athlete
 * that are not on this page — their message thread and their sessions in the
 * feed. Both existed on the old Profile tab and were lost when the tabs were
 * merged, which left the page with no way to review or to write.
 *
 * They sit here, directly under the header, and not inside it: the header box
 * is shared pixel for pixel with the roster (see CoachHome), and it stays
 * mounted over the session editor, where a band of actions above the work is
 * exactly what the editor's own header was trimmed to avoid.
 */
function AthleteActions({ student }) {
  const { t } = useI18n();
  if (!student) return null;
  const name = student.profile?.full_name || '';
  const cls =
    'sl-pill min-h-9 px-3.5 bg-ink-100 text-ink-700 hover:bg-ink-200 transition-colors';

  return (
    <nav
      aria-label={t('coachLoggedHistory.athlete.actionsLabel', { name })}
      className="flex items-center gap-2 pb-2"
    >
      {/* The thread is keyed on the PROFILE id, not the students-row id. */}
      {student.profile_id && (
        <Link to={`/coach/messages/${student.profile_id}`} className={cls}>
          {t('coachLoggedHistory.athlete.message')}
        </Link>
      )}
      <Link to={`/coach/sessions?student=${student.id}`} className={cls}>
        {t('coachLoggedHistory.athlete.sessions')}
      </Link>
    </nav>
  );
}

/**
 * The whole athlete on one page. Replaced the Programming / Progress tab strip:
 * the coach asked to stop losing the page when moving between areas, and tabs
 * made every area a separate destination with its own mount and scroll reset.
 *
 * Programming is open by default because it is what the coach came for; Goals
 * and Stats sit collapsed underneath so the page opens short and stays fast.
 */
export default function StudentOverview() {
  const { t } = useI18n();
  // CoachHome resolves the athlete and hands it down through the outlet.
  const { student } = useOutletContext() || {};

  return (
    <div className="space-y-1">
      <AthleteActions student={student} />

      <Section id="programming" title={t('coach.tabs.programming')} defaultOpen>
        <StudentProgrammingSection />
      </Section>

      <Section id="goals" title={t('coach.tabs.goals')}>
        <StudentGoalsSection />
      </Section>

      <Section id="stats" title={t('coach.tabs.stats')}>
        <StudentStatsSection />
      </Section>
    </div>
  );
}
