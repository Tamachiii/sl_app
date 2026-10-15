import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { loginState } from '../../lib/returnPath';
import Spinner from '../ui/Spinner';

export default function ProtectedRoute() {
  const { user, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Spinner />
      </div>
    );
  }

  // The page asked for goes with the redirect, so signing in returns to it
  // (LoginPage, lib/returnPath.js).
  if (!user) {
    return <Navigate to="/login" replace state={loginState(location)} />;
  }

  return <Outlet />;
}
