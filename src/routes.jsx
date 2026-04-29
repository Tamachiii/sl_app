import { lazy, Suspense } from 'react';
import { Navigate, useParams } from 'react-router-dom';

function RedirectToStudentGoals() {
  const { studentId } = useParams();
  return <Navigate to={`/coach/students/${studentId}/goals`} replace />;
}
import ProtectedRoute from './components/auth/ProtectedRoute';
import RoleGate from './components/auth/RoleGate';
import AppShell from './components/layout/AppShell';
import Spinner from './components/ui/Spinner';

const LoginPage = lazy(() => import('./components/auth/LoginPage'));
const CoachDashboard = lazy(() => import('./components/coach/CoachDashboard'));
const CoachHome = lazy(() => import('./components/coach/CoachHome'));
const StudentProfileSection = lazy(() => import('./components/coach/StudentProfileSection'));
const StudentProgrammingSection = lazy(() => import('./components/coach/StudentProgrammingSection'));
const StudentGoalsSection = lazy(() => import('./components/coach/StudentGoalsSection'));
const StudentStatsSection = lazy(() => import('./components/coach/StudentStatsSection'));
const StudentMessagingSection = lazy(() => import('./components/coach/StudentMessagingSection'));
const SessionsFeed = lazy(() => import('./components/coach/SessionsFeed'));
const WeekView = lazy(() => import('./components/coach/WeekView'));
const SessionEditor = lazy(() => import('./components/coach/SessionEditor'));
const ExerciseLibrary = lazy(() => import('./components/coach/ExerciseLibrary'));
const SessionReview = lazy(() => import('./components/coach/SessionReview'));
const CoachMessages = lazy(() => import('./components/coach/CoachMessages'));
const StudentHome = lazy(() => import('./components/student/StudentHome'));
const StudentSessions = lazy(() => import('./components/student/StudentSessions'));
const StudentStats = lazy(() => import('./components/student/StudentDashboard'));
const SessionView = lazy(() => import('./components/student/SessionView'));
const MyGoals = lazy(() => import('./components/student/MyGoals'));
const StudentMessages = lazy(() => import('./components/student/StudentMessages'));

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
          // Coach routes
          {
            element: <RoleGate allowed="coach" />,
            children: [
              { path: '/coach', element: <Navigate to="/coach/dashboard" replace /> },
              { path: '/coach/dashboard', element: <Lazy><CoachDashboard /></Lazy> },
              { path: '/coach/students', element: <Lazy><CoachHome /></Lazy> },
              {
                path: '/coach/students/:studentId',
                element: <Lazy><CoachHome /></Lazy>,
                children: [
                  { index: true, element: <Navigate to="programming" replace /> },
                  { path: 'profile', element: <Lazy><StudentProfileSection /></Lazy> },
                  { path: 'programming', element: <Lazy><StudentProgrammingSection /></Lazy> },
                  { path: 'goals', element: <Lazy><StudentGoalsSection /></Lazy> },
                  { path: 'stats', element: <Lazy><StudentStatsSection /></Lazy> },
                  { path: 'messaging', element: <Lazy><StudentMessagingSection /></Lazy> },
                ],
              },
              { path: '/coach/student/:studentId/goals', element: <RedirectToStudentGoals /> },
              { path: '/coach/sessions', element: <Lazy><SessionsFeed /></Lazy> },
              { path: '/coach/student/:studentId/session/:sessionId/review', element: <Lazy><SessionReview /></Lazy> },
              { path: '/coach/student/:studentId/week/:weekId', element: <Lazy><WeekView /></Lazy> },
              { path: '/coach/student/:studentId/week/:weekId/session/:sessionId', element: <Lazy><SessionEditor /></Lazy> },
              { path: '/coach/messages', element: <Lazy><CoachMessages /></Lazy> },
              { path: '/coach/messages/:otherProfileId', element: <Lazy><CoachMessages /></Lazy> },
              { path: '/coach/exercises', element: <Lazy><ExerciseLibrary /></Lazy> },
            ],
          },
          // Student routes
          {
            element: <RoleGate allowed="student" />,
            children: [
              { path: '/student', element: <Lazy><StudentHome /></Lazy> },
              { path: '/student/sessions', element: <Lazy><StudentSessions /></Lazy> },
              { path: '/student/stats', element: <Lazy><StudentStats /></Lazy> },
              { path: '/student/dashboard', element: <Navigate to="/student/stats" replace /> },
              { path: '/student/session/:sessionId', element: <Lazy><SessionView /></Lazy> },
              { path: '/student/goals', element: <Lazy><MyGoals /></Lazy> },
              { path: '/student/messages', element: <Lazy><StudentMessages /></Lazy> },
            ],
          },
        ],
      },
    ],
  },
  {
    path: '*',
    element: <Navigate to="/login" replace />,
  },
];
