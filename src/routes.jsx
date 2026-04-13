import { lazy, Suspense } from 'react';
import { Navigate } from 'react-router-dom';
import ProtectedRoute from './components/auth/ProtectedRoute';
import RoleGate from './components/auth/RoleGate';
import AppShell from './components/layout/AppShell';
import Spinner from './components/ui/Spinner';

const LoginPage = lazy(() => import('./components/auth/LoginPage'));
const CoachHome = lazy(() => import('./components/coach/CoachHome'));
const WeekView = lazy(() => import('./components/coach/WeekView'));
const SessionEditor = lazy(() => import('./components/coach/SessionEditor'));
const ExerciseLibrary = lazy(() => import('./components/coach/ExerciseLibrary'));
const StudentHome = lazy(() => import('./components/student/StudentHome'));
const SessionView = lazy(() => import('./components/student/SessionView'));

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
              { path: '/coach', element: <Lazy><CoachHome /></Lazy> },
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
              { path: '/student/session/:sessionId', element: <Lazy><SessionView /></Lazy> },
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
