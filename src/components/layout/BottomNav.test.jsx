import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

const mockSignOut = vi.fn();
let mockRole = 'coach';

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    role: mockRole,
    signOut: mockSignOut,
  }),
}));

import BottomNav from './BottomNav';

function renderBottomNav(route = '/coach/dashboard') {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <BottomNav />
    </MemoryRouter>
  );
}

describe('BottomNav', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRole = 'coach';
  });

  it('renders all 4 coach nav tabs', () => {
    renderBottomNav();
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Students')).toBeInTheDocument();
    expect(screen.getByText('Sessions')).toBeInTheDocument();
    expect(screen.getByText('Library')).toBeInTheDocument();
  });

  it('renders logout button with aria-label', () => {
    renderBottomNav();
    const logoutBtn = screen.getByRole('button', { name: /sign out/i });
    expect(logoutBtn).toBeInTheDocument();
  });

  it('clicking logout calls signOut', async () => {
    const user = userEvent.setup();
    renderBottomNav();

    await user.click(screen.getByRole('button', { name: /sign out/i }));
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  it('renders student nav with Home and Goals links', () => {
    mockRole = 'student';
    renderBottomNav('/student');
    expect(screen.getByText('Home')).toBeInTheDocument();
    expect(screen.getByText('Goals')).toBeInTheDocument();
    expect(screen.queryByText('Dashboard')).not.toBeInTheDocument();
  });

  it('student view also has logout button', async () => {
    const user = userEvent.setup();
    mockRole = 'student';
    renderBottomNav('/student');

    const logoutBtn = screen.getByRole('button', { name: /sign out/i });
    await user.click(logoutBtn);
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  it('Students tab is not active when on a sub-route', () => {
    renderBottomNav('/coach/student/s-1/week/w-1');
    const studentsLink = screen.getByRole('link', { name: /students/i });
    expect(studentsLink).not.toHaveClass('text-primary');
  });

  it('Home tab is not active when student is on a sub-route like /student/session/1', () => {
    mockRole = 'student';
    renderBottomNav('/student/session/1');
    const homeLink = screen.getByRole('link', { name: /home/i });
    expect(homeLink).not.toHaveClass('text-primary');
  });
});
