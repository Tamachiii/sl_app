import { useCallback, useState } from 'react';
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
 * The whole athlete on one page. Replaced the Programming / Progress tab strip:
 * the coach asked to stop losing the page when moving between areas, and tabs
 * made every area a separate destination with its own mount and scroll reset.
 *
 * Programming is open by default because it is what the coach came for; Goals
 * and Stats sit collapsed underneath so the page opens short and stays fast.
 */
export default function StudentOverview() {
  const { t } = useI18n();

  return (
    <div className="space-y-1">
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
