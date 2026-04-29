import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Outlet } from 'react-router-dom';
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
    renderUnderOutlet({
      id: 's-1',
      created_at: '2024-03-14T10:00:00Z',
      profile: { full_name: 'Alice Brown' },
    });

    expect(screen.getByText('Alice Brown')).toBeInTheDocument();
    expect(screen.getByText('Student')).toBeInTheDocument();
    expect(screen.getByText('Coaching since')).toBeInTheDocument();
    expect(screen.getByText(/2024/)).toBeInTheDocument();
  });

  it('falls back to em-dash when created_at is missing', () => {
    renderUnderOutlet({ id: 's-1', profile: { full_name: 'Bob' } });
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('shows a placeholder name when full_name is missing', () => {
    renderUnderOutlet({ id: 's-1', created_at: '2024-01-01T00:00:00Z', profile: null });
    // Both the name fallback and the role label render as "Student".
    expect(screen.getAllByText('Student')).toHaveLength(2);
  });
});
