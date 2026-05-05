const HomeIcon = (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0h4" />
  </svg>
);

const DashboardIcon = (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zm10 0a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
  </svg>
);

const StudentsIcon = (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
  </svg>
);

const SessionsIcon = (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
  </svg>
);

const LibraryIcon = (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
  </svg>
);

const StatsIcon = (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
  </svg>
);

const MessagesIcon = (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.86 9.86 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
  </svg>
);

// Under the Students tab, deep routes live at `/coach/student/:sid/week/…` and
// `/coach/student/:sid/week/…/session/…`. Sessions-tab drill-down lives at
// `/coach/student/:sid/session/…/review`. They share the `/coach/student/`
// prefix, so a plain `end: false` NavLink match would light up both tabs at
// once — instead each coach tab declares a `matches(pathname)` predicate that
// distinguishes /week/ routes (Students) from /review routes (Sessions).
const isCoachStudentsPath = (p) =>
  p.startsWith('/coach/students') || /^\/coach\/student\/[^/]+\/week/.test(p);
const isCoachSessionsPath = (p) =>
  p.startsWith('/coach/sessions') || /^\/coach\/student\/[^/]+\/session\//.test(p);

export function getNavItems(role, t) {
  if (role === 'coach') {
    return [
      { to: '/coach/dashboard', label: t('nav.dashboard'), icon: DashboardIcon, end: true },
      {
        to: '/coach/students',
        label: t('nav.students'),
        icon: StudentsIcon,
        end: false,
        matches: isCoachStudentsPath,
      },
      {
        to: '/coach/sessions',
        label: t('nav.sessions'),
        icon: SessionsIcon,
        end: true,
        matches: isCoachSessionsPath,
      },
      {
        to: '/coach/messages',
        label: t('nav.messages'),
        icon: MessagesIcon,
        end: false,
        badge: 'unread-messages',
      },
      { to: '/coach/exercises', label: t('nav.library'), icon: LibraryIcon, end: true },
    ];
  }
  // Student-side nav is intentionally 4 tabs; Goals lives behind the avatar
  // (Profile page surfaces the active goal + a "View all" link to the goals
  // page, which still exists at /student/goals as a standalone route).
  return [
    { to: '/student', label: t('nav.home'), icon: HomeIcon, end: true },
    { to: '/student/sessions', label: t('nav.sessions'), icon: SessionsIcon, end: false },
    { to: '/student/stats', label: t('nav.stats'), icon: StatsIcon, end: false },
    {
      to: '/student/messages',
      label: t('nav.messages'),
      icon: MessagesIcon,
      end: false,
      badge: 'unread-messages',
    },
  ];
}
