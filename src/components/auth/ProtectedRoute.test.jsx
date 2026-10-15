import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

vi.mock('../../hooks/useAuth', () => ({ useAuth: vi.fn() }));

import ProtectedRoute from './ProtectedRoute';
import { useAuth } from '../../hooks/useAuth';

function LoginStub() {
  const { state } = useLocation();
  return <div data-testid="login">{JSON.stringify(state)}</div>;
}

function renderRoute(path = '/guarded') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<ProtectedRoute />}>
          <Route path="/guarded" element={<div data-testid="guarded">In</div>} />
        </Route>
        <Route path="/login" element={<LoginStub />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('ProtectedRoute', () => {
  it('renders the spinner while auth is loading', () => {
    useAuth.mockReturnValue({ user: null, isLoading: true });
    renderRoute();
    expect(screen.getByRole('status')).toBeInTheDocument();
    expect(screen.queryByTestId('guarded')).not.toBeInTheDocument();
  });

  it('redirects to /login when there is no user', () => {
    useAuth.mockReturnValue({ user: null, isLoading: false });
    renderRoute();
    expect(screen.getByTestId('login')).toBeInTheDocument();
    expect(screen.queryByTestId('guarded')).not.toBeInTheDocument();
  });

  // Review item L11: the redirect dropped the link, so signing in landed on
  // the role's home instead of the page that was asked for.
  it('hands the login page the page that was asked for, query included', () => {
    useAuth.mockReturnValue({ user: null, isLoading: false });
    renderRoute('/guarded?program=p-2');
    expect(JSON.parse(screen.getByTestId('login').textContent)).toEqual({
      from: '/guarded?program=p-2',
    });
  });

  it('renders the outlet when authed', () => {
    useAuth.mockReturnValue({ user: { id: 'u-1' }, isLoading: false });
    renderRoute();
    expect(screen.getByTestId('guarded')).toBeInTheDocument();
  });
});
