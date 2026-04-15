import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import RoleGate from './RoleGate';
import { useAuth } from '../../hooks/useAuth';

vi.mock('../../hooks/useAuth', () => ({
  useAuth: vi.fn()
}));

describe('RoleGate', () => {
  it('renders Outlet if role matches', () => {
    useAuth.mockReturnValue({ role: 'coach' });
    render(
      <MemoryRouter initialEntries={['/guarded']}>
        <Routes>
          <Route element={<RoleGate allowed="coach" />}>
            <Route path="/guarded" element={<div data-testid="protected-content">Content</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    );
    expect(screen.getByTestId('protected-content')).toBeInTheDocument();
  });

  it('redirects if role does not match', () => {
    useAuth.mockReturnValue({ role: 'student' });
    render(
      <MemoryRouter initialEntries={['/guarded']}>
        <Routes>
          <Route element={<RoleGate allowed="coach" />}>
            <Route path="/guarded" element={<div data-testid="protected-content">Content</div>} />
          </Route>
          <Route path="/student" element={<div data-testid="redirect-target">Student Home</div>} />
        </Routes>
      </MemoryRouter>
    );
    expect(screen.queryByTestId('protected-content')).not.toBeInTheDocument();
    expect(screen.getByTestId('redirect-target')).toBeInTheDocument();
  });
});


