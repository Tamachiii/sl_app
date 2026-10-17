import { useCallback, useState } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import { useI18n } from '../../hooks/useI18n';
import { Button, Icon } from '../parc';
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
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="pk-title">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-controls={panelId}
          className="flex min-h-11 w-full items-center justify-between gap-3 bg-transparent text-left"
        >
          {title}
          <Icon
            name="chevron-down"
            size={20}
            className={`shrink-0 text-ink-2 transition-transform ${open ? 'rotate-180' : ''}`}
          />
        </button>
      </h2>
      {/* Unmounted, not hidden: Stats runs a heavy aggregate query and Goals a
          profile-id resolve — a collapsed section shouldn't pay for either. */}
      {open && <div id={panelId}>{children}</div>}
    </section>
  );
}

/**
 * The athlete header's actions: the two places a coach goes FROM an athlete
 * that are not on this page — their message thread and their sessions in the
 * feed. Both existed on the old Profile tab and were lost when the tabs were
 * merged, which left the page with no way to review or to write.
 *
 * They sit here, directly under the header, and not inside it: the header
 * stays mounted over the session editor, where a band of actions above the
 * work is exactly what the editor's own header was trimmed to avoid.
 */
function AthleteActions({ student }) {
  const { t } = useI18n();
  if (!student) return null;
  const name = student.profile?.full_name || '';

  return (
    <nav aria-label={t('coachLoggedHistory.athlete.actionsLabel', { name })} className="flex flex-wrap gap-2">
      {/* The thread is keyed on the PROFILE id, not the students-row id. */}
      {student.profile_id && (
        <Button as={Link} variant="on-ground" to={`/coach/messages/${student.profile_id}`}>
          <Icon name="messages" size={18} />
          {t('parcProgram.message')}
        </Button>
      )}
      <Button as={Link} variant="on-ground" to={`/coach/sessions?student=${student.id}`}>
        <Icon name="sessions" size={18} />
        {t('parcProgram.sessions')}
      </Button>
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
    <div className="flex flex-col gap-8">
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
