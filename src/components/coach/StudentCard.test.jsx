import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../hooks/useProgram', () => ({
  useProgram: () => ({
    data: {
      id: 'prog-1',
      weeks: [{ id: 'w-1', week_number: 1, label: null }],
    },
  }),
  useCreateWeek: () => ({ mutate: vi.fn(), isPending: false }),
}));

import StudentCard from './StudentCard';

describe('StudentCard', () => {
  it('renders student name', () => {
    render(
      <MemoryRouter>
        <StudentCard student={{ id: 's-1', profile: { full_name: 'John Doe' } }} />
      </MemoryRouter>
    );
    expect(screen.getByText('John Doe')).toBeInTheDocument();
  });

  it('renders fallback when no name', () => {
    render(
      <MemoryRouter>
        <StudentCard student={{ id: 's-1', profile: {} }} />
      </MemoryRouter>
    );
    expect(screen.getByText('Student')).toBeInTheDocument();
  });

  it('renders week timeline', () => {
    render(
      <MemoryRouter>
        <StudentCard student={{ id: 's-1', profile: { full_name: 'Jane' } }} />
      </MemoryRouter>
    );
    expect(screen.getByText('W1')).toBeInTheDocument();
  });
});
