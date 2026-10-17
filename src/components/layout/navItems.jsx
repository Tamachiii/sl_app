import {
  clearLastCoachStudentsPath,
  clearLastCoachSessionsTab,
} from '../../hooks/useRememberCoachStudentsPath';

// The icons are names of the Parc set (components/parc/Icon): the tab bar
// draws them at 24px, the side nav at 22px.

// Athletes-tab content all lives under `/coach/students/…` now (including
// session editing at `…/s/:sessionId`). The legacy singular
// `/coach/student/:sid/week/…` paths still resolve as redirects, and the
// Sessions-tab drill-down at `/coach/student/:sid/session/…/review` shares
// that prefix — so a plain `end: false` NavLink would light up both tabs at
// once. Each coach tab declares a `matches(pathname)` predicate instead.
const isCoachStudentsPath = (p) =>
  p.startsWith('/coach/students') || /^\/coach\/student\/[^/]+\/week/.test(p);
const isCoachSessionsPath = (p) =>
  p.startsWith('/coach/sessions') || /^\/coach\/student\/[^/]+\/session\//.test(p);

/**
 * A tap on the tab that is already open returns to its root. Athletes and
 * Sessions remember where the coach was (hooks/useRememberCoachStudentsPath)
 * and bounce back there when their root is opened, so their `onReselect`
 * forgets that place first; the NavLink's own navigation then lands on the
 * roster or the plain feed and stays there. The other tabs need nothing:
 * their root never sends the coach anywhere.
 *
 * Called by the navs' click handler before the navigation. `active` is the
 * item's `matches(pathname)`; a click that does not navigate in this window —
 * another button, or a modifier that opens a new tab — forgets nothing.
 */
export function reselectOnClick(event, active, onReselect) {
  if (!active || !onReselect) return;
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  onReselect();
}

export function getNavItems(role, t) {
  if (role === 'coach') {
    return [
      {
        to: '/coach/students',
        label: t('nav.athletes'),
        icon: 'athletes',
        end: false,
        matches: isCoachStudentsPath,
        onReselect: clearLastCoachStudentsPath,
      },
      {
        to: '/coach/sessions',
        label: t('nav.sessions'),
        icon: 'sessions',
        end: true,
        matches: isCoachSessionsPath,
        onReselect: clearLastCoachSessionsTab,
        // The sessions waiting for review (live finding N17: the roster's
        // chips are on every card, the tab says how many in all).
        badge: 'to-review',
      },
      {
        to: '/coach/messages',
        label: t('nav.messages'),
        icon: 'messages',
        end: false,
        badge: 'unread-messages',
      },
      { to: '/coach/exercises', label: t('nav.library'), icon: 'library', end: true },
    ];
  }
  // Student-side nav is 3 tabs since Home and Sessions merged into one
  // training surface. Goals lives behind the avatar (Profile surfaces the
  // active goal + a "View all" link to /student/goals, still a real route).
  return [
    { to: '/student', label: t('nav.training'), icon: 'sessions', end: true },
    { to: '/student/stats', label: t('nav.stats'), icon: 'stats', end: false },
    {
      to: '/student/messages',
      label: t('nav.messages'),
      icon: 'messages',
      end: false,
      badge: 'unread-messages',
    },
  ];
}
