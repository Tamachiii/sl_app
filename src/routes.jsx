import { lazy, Suspense } from 'react';
import { Navigate } from 'react-router-dom';
import ProtectedRoute from './components/auth/ProtectedRoute';
import RoleGate from './components/auth/RoleGate';
import AppShell from './components/layout/AppShell';
import Spinner from './components/ui/Spinner';

const LoginPage = lazy(() => import('./components/auth/LoginPage'));
const CoachDashboard = lazy(() => import('./components/coach/CoachDashboard'));
const CoachHome = lazy(() => import('./components/coach/CoachHome'));
const SessionsFeed = lazy(() => import('./components/coach/SessionsFeed'));
const WeekView = lazy(() => import('./components/coach/WeekView'));
const SessionEditor = lazy(() => import('./components/coach/SessionEditor'));
const ExerciseLibrary = lazy(() => import('./components/coach/ExerciseLibrary'));
const ConfirmedSessions = lazy(() => import('./components/coach/ConfirmedSessions'));
const SessionReview = lazy(() => import('./components/coach/SessionReview'));
const StudentGoals = lazy(() => import('./components/coach/StudentGoals'));
const StudentHome = lazy(() => import('./components/student/StudentHome'));
const StudentSessions = lazy(() => import('./components/student/StudentSessions'));
const StudentStats = lazy(() => import('./components/student/StudentDashboard'));
const SessionView = lazy(() => import('./components/student/SessionView'));
const MyGoals = lazy(() => import('./components/student/MyGoals'));

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
              { path: '/coach/sessions', element: <Lazy><SessionsFeed /></Lazy> },
              { path: '/coach/student/:studentId/confirmations', element: <Lazy><ConfirmedSessions /></Lazy> },
              { path: '/coach/student/:studentId/session/:sessionId/review', element: <Lazy><SessionReview /></Lazy> },
              { path: '/coach/student/:studentId/goals', element: <Lazy><StudentGoals /></Lazy> },
              { path: '/coach/student/:studentId/week/:weekId', element: <Lazy><WeekView /></Lazy> },
              { path: '/coach/student/:studentId/week/:weekId/session/:sessionId', element: <Lazy><SessionEditor /></Lazy> },
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
