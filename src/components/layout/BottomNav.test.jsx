import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

let mockRole = 'coach';

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({ role: mockRole }),
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

  it('does not render a logout button in the nav', () => {
    renderBottomNav();
    expect(screen.queryByRole('button', { name: /sign out/i })).not.toBeInTheDocument();
  });

  it('renders student nav with Home, Sessions, Stats and Goals links', () => {
    mockRole = 'student';
    renderBottomNav('/student');
    expect(screen.getByText('Home')).toBeInTheDocument();
    expect(screen.getByText('Sessions')).toBeInTheDocument();
    expect(screen.getByText('Stats')).toBeInTheDocument();
    expect(screen.getByText('Goals')).toBeInTheDocument();
    expect(screen.queryByText('Students')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sign out/i })).not.toBeInTheDocument();
  });

  it('Students tab is active on Students-section deep routes (WeekView, SessionEditor)', () => {
    renderBottomNav('/coach/student/s-1/week/w-1');
    const studentsLink = screen.getByRole('link', { name: /students/i });
    expect(studentsLink).toHaveClass('text-[var(--color-accent)]');
  });

  it('Sessions tab is active on the review deep route', () => {
    renderBottomNav('/coach/student/s-1/session/sess-1/review');
    const sessionsLink = screen.getByRole('link', { name: /sessions/i });
    expect(sessionsLink).toHaveClass('text-[var(--color-accent)]');
  });

  it('Students tab is NOT active on the review deep route', () => {
    renderBottomNav('/coach/student/s-1/session/sess-1/review');
    const studentsLink = screen.getByRole('link', { name: /students/i });
    expect(studentsLink).not.toHaveClass('text-[var(--color-accent)]');
  });

  it('Home tab is not active when student is on a sub-route like /student/session/1', () => {
    mockRole = 'student';
    renderBottomNav('/student/session/1');
    const homeLink = screen.getByRole('link', { name: /home/i });
    expect(homeLink).not.toHaveClass('text-primary');
  });
});
