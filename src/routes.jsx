import { Navigate } from 'react-router-dom';
import ProtectedRoute from './components/auth/ProtectedRoute';
import RoleGate from './components/auth/RoleGate';
import LoginPage from './components/auth/LoginPage';
import AppShell from './components/layout/AppShell';
import CoachHome from './components/coach/CoachHome';
import WeekView from './components/coach/WeekView';
import SessionEditor from './components/coach/SessionEditor';
import ExerciseLibrary from './components/coach/ExerciseLibrary';
import StudentHome from './components/student/StudentHome';
import SessionView from './components/student/SessionView';

export const routes = [
  {
    path: '/login',
    element: <LoginPage />,
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
              { path: '/coach', element: <CoachHome /> },
              { path: '/coach/student/:studentId/week/:weekId', element: <WeekView /> },
              { path: '/coach/student/:studentId/week/:weekId/session/:sessionId', element: <SessionEditor /> },
              { path: '/coach/exercises', element: <ExerciseLibrary /> },
            ],
          },
          // Student routes
          {
            element: <RoleGate allowed="student" />,
            children: [
              { path: '/student', element: <StudentHome /> },
              { path: '/student/session/:sessionId', element: <SessionView /> },
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
