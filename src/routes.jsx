import { lazy, Suspense } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { useAuth } from './hooks/useAuth';

function RedirectToStudentGoals() {
  const { studentId } = useParams();
  return <Navigate to={`/coach/students/${studentId}/goals`} replace />;
}

// The week page is gone — the athlete page lists every week with its sessions
// inline. Old /coach/student/:id/week/:weekId links land on that page.
function RedirectToProgramming() {
  const { studentId } = useParams();
  return <Navigate to={`/coach/students/${studentId}`} replace />;
}

// Session editing lives inside the athlete shell so the header stops
// unmounting. A plain <Navigate> can't interpolate params.
function RedirectToSessionEditor() {
  const { studentId, sessionId } = useParams();
  return <Navigate to={`/coach/students/${studentId}/s/${sessionId}`} replace />;
}

// Bare "/" lands here when an already-authenticated user opens the app
// without a hash route — most commonly an iOS PWA cold launch, which
// loads the manifest start_url (`/sl_app/`) with no hash. Without this,
// HashRouter sees pathname `/` and the wildcard renders the 404 page.
function RedirectToRoleHome() {
  const { role } = useAuth();
  if (!role) return <Navigate to="/login" replace />;
  return <Navigate to={`/${role}`} replace />;
}

import ProtectedRoute from './components/auth/ProtectedRoute';
import RoleGate from './components/auth/RoleGate';
import AppShell from './components/layout/AppShell';
import Spinner from './components/ui/Spinner';

const LoginPage = lazy(() => import('./components/auth/LoginPage'));
const CoachHome = lazy(() => import('./components/coach/CoachHome'));
const StudentOverview = lazy(() => import('./components/coach/StudentOverview'));
const SessionsFeed = lazy(() => import('./components/coach/SessionsFeed'));
const SessionEditor = lazy(() => import('./components/coach/SessionEditor'));
const ExerciseLibrary = lazy(() => import('./components/coach/ExerciseLibrary'));
const SessionReview = lazy(() => import('./components/coach/SessionReview'));
const CoachMessages = lazy(() => import('./components/coach/CoachMessages'));
const StudentTraining = lazy(() => import('./components/student/StudentTraining'));
const StudentStats = lazy(() => import('./components/student/StudentDashboard'));
const SessionView = lazy(() => import('./components/student/SessionView'));
const MyGoals = lazy(() => import('./components/student/MyGoals'));
const StudentMessages = lazy(() => import('./components/student/StudentMessages'));
const StudentProfile = lazy(() => import('./components/student/StudentProfile'));
const StudentProgramAuthor = lazy(() => import('./components/student/StudentProgramAuthor'));
const NotFound = lazy(() => import('./components/ui/NotFound'));

function Lazy({ children }) {
  return (
    <Suspense fallback={<div className="flex justify-center py-12"><Spinner /></div>}>
      {children}
    </Suspense>
  );
}

export const routes = [
  {
    path: '/login',
    element: <Lazy><LoginPage /></Lazy>,
  },
  {
    element: <ProtectedRoute />,
    children: [
      {
        element: <AppShell />,
        children: [
          // Bare "/" — send signed-in users to their role home so an iOS
          // PWA cold launch (start_url `/sl_app/`, no hash) doesn't land
          // on the 404 page.
          { index: true, element: <RedirectToRoleHome /> },
          // Coach routes
          {
            element: <RoleGate allowed="coach" />,
            children: [
              { path: '/coach', element: <Navigate to="/coach/students" replace /> },
              // Dashboard merged into the Athletes roster (/coach/students);
              // keep a redirect so old bookmarks / PWA shortcuts don't 404.
              { path: '/coach/dashboard', element: <Navigate to="/coach/students" replace /> },
              { path: '/coach/students', element: <Lazy><CoachHome /></Lazy> },
              {
                path: '/coach/students/:studentId',
                element: <Lazy><CoachHome /></Lazy>,
                children: [
                  // The athlete IS one page — no tabs, just collapsible
                  // sections. Session editing is the only child destination.
                  { index: true, element: <Lazy><StudentOverview /></Lazy> },
                  { path: 's/:sessionId', element: <Lazy><SessionEditor /></Lazy> },
                  // Every surface that used to be its own tab now lives in a
                  // section of the index page; old bookmarks and deep links
                  // land there rather than 404ing.
                  { path: 'programming', element: <Navigate to=".." replace relative="path" /> },
                  { path: 'progress', element: <Navigate to=".." replace relative="path" /> },
                  { path: 'profile', element: <Navigate to=".." replace relative="path" /> },
                  { path: 'goals', element: <Navigate to=".." replace relative="path" /> },
                  { path: 'stats', element: <Navigate to=".." replace relative="path" /> },
                  { path: 'messaging', element: <Navigate to=".." replace relative="path" /> },
                  { path: 'programming/s/:sessionId', element: <RedirectToSessionEditor /> },
                ],
              },
              { path: '/coach/student/:studentId/goals', element: <RedirectToStudentGoals /> },
              { path: '/coach/sessions', element: <Lazy><SessionsFeed /></Lazy> },
              { path: '/coach/student/:studentId/session/:sessionId/review', element: <Lazy><SessionReview /></Lazy> },
              // Legacy singular-prefix authoring routes → the merged surface.
              { path: '/coach/student/:studentId/week/:weekId', element: <RedirectToProgramming /> },
              { path: '/coach/student/:studentId/week/:weekId/session/:sessionId', element: <RedirectToSessionEditor /> },
              { path: '/coach/messages', element: <Lazy><CoachMessages /></Lazy> },
              { path: '/coach/messages/:otherProfileId', element: <Lazy><CoachMessages /></Lazy> },
              { path: '/coach/exercises', element: <Lazy><ExerciseLibrary /></Lazy> },
            ],
          },
          // Student routes
          {
            element: <RoleGate allowed="student" />,
            children: [
              // ONE training surface. Home and Sessions were two screens
              // answering the same question ("what do I do now?"), each able to
              // start the next session; the list is the page now.
              { path: '/student', element: <Lazy><StudentTraining /></Lazy> },
              { path: '/student/sessions', element: <Navigate to="/student" replace /> },
              { path: '/student/stats', element: <Lazy><StudentStats /></Lazy> },
              { path: '/student/dashboard', element: <Navigate to="/student/stats" replace /> },
              { path: '/student/session/:sessionId', element: <Lazy><SessionView /></Lazy> },
              { path: '/student/goals', element: <Lazy><MyGoals /></Lazy> },
              { path: '/student/author', element: <Lazy><StudentProgramAuthor /></Lazy> },
              { path: '/student/messages', element: <Lazy><StudentMessages /></Lazy> },
              { path: '/student/profile', element: <Lazy><StudentProfile /></Lazy> },
            ],
          },
          // Authenticated catch-all: any URL that didn't match a role route
          // lands here with a real 404 message instead of a silent redirect.
          { path: '*', element: <Lazy><NotFound /></Lazy> },
        ],
      },
    ],
  },
  // Unauthenticated catch-all still bounces to /login — ProtectedRoute
  // would do the same thing with a flicker, so handle it up front.
  {
    path: '*',
    element: <Navigate to="/login" replace />,
  },
];
