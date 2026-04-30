import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Outlet } from 'react-router-dom';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

import StudentProfileSection from './StudentProfileSection';

function renderUnderOutlet(student, route = '/') {
  function Layout() {
    return <Outlet context={{ student }} />;
  }
  return render(
    <MemoryRouter initialEntries={[route]}>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<StudentProfileSection />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('StudentProfileSection', () => {
  it('renders the student name, role, and a coaching-since date', () => {
    mockNavigate.mockReset();
    renderUnderOutlet({
      id: 's-1',
      profile_id: 'p-1',
      created_at: '2024-03-14T10:00:00Z',
      profile: { full_name: 'Alice Brown' },
    });

    expect(screen.getByText('Alice Brown')).toBeInTheDocument();
    expect(screen.getByText('Student')).toBeInTheDocument();
    expect(screen.getByText('Coaching since')).toBeInTheDocument();
    expect(screen.getByText(/2024/)).toBeInTheDocument();
  });

  it('falls back to em-dash when created_at is missing', () => {
    mockNavigate.mockReset();
    renderUnderOutlet({ id: 's-1', profile_id: 'p-1', profile: { full_name: 'Bob' } });
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('shows a placeholder name when full_name is missing', () => {
    mockNavigate.mockReset();
    renderUnderOutlet({ id: 's-1', profile_id: 'p-1', created_at: '2024-01-01T00:00:00Z', profile: null });
    // Both the name fallback and the role label render as "Student".
    expect(screen.getAllByText('Student')).toHaveLength(2);
  });

  it('"View sessions" button navigates to /coach/sessions filtered by the student', () => {
    mockNavigate.mockReset();
    renderUnderOutlet({
      id: 's-1',
      profile_id: 'p-1',
      created_at: '2024-03-14T10:00:00Z',
      profile: { full_name: 'Alice Brown' },
    });
    fireEvent.click(screen.getByRole('button', { name: /view sessions/i }));
    expect(mockNavigate).toHaveBeenCalledWith('/coach/sessions?student=s-1');
  });

  it('"Message" button navigates to the coach messages thread for that profile', () => {
    mockNavigate.mockReset();
    renderUnderOutlet({
      id: 's-1',
      profile_id: 'p-1',
      created_at: '2024-03-14T10:00:00Z',
      profile: { full_name: 'Alice Brown' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^message$/i }));
    expect(mockNavigate).toHaveBeenCalledWith('/coach/messages/p-1');
  });

  it('disables the Message button when the student has no profile_id', () => {
    mockNavigate.mockReset();
    renderUnderOutlet({
      id: 's-1',
      profile_id: null,
      created_at: '2024-03-14T10:00:00Z',
      profile: { full_name: 'Alice Brown' },
    });
    expect(screen.getByRole('button', { name: /^message$/i })).toBeDisabled();
  });
});
