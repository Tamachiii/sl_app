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

function renderBottomNav(route = '/coach') {
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

  it('renders coach nav links: Students and Library', () => {
    renderBottomNav();
    expect(screen.getByText('Students')).toBeInTheDocument();
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

  it('renders student nav with Home link', () => {
    mockRole = 'student';
    renderBottomNav('/student');
    expect(screen.getByText('Home')).toBeInTheDocument();
    expect(screen.queryByText('Library')).not.toBeInTheDocument();
  });

  it('student view also has logout button', async () => {
    const user = userEvent.setup();
    mockRole = 'student';
    renderBottomNav('/student');

    const logoutBtn = screen.getByRole('button', { name: /sign out/i });
    await user.click(logoutBtn);
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });
});
