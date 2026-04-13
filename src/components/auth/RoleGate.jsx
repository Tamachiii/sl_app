import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';

export default function RoleGate({ allowed }) {
  const { role } = useAuth();

  if (role && role !== allowed) {
    return <Navigate to={`/${role}`} replace />;
  }

  return <Outlet />;
}
