import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

let mockRole = 'student';
vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({ role: mockRole }),
}));

import NotFound from './NotFound';

// An address the app has no page for: it says so, shows the address, and
// leads to the home of the account's role — rather than bouncing through
// /login to that home with nothing said about the link that did not work.
function renderAt(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <NotFound />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mockRole = 'student';
});

describe('<NotFound />', () => {
  it('says the page is not here, under the large title, and shows the address', () => {
    renderAt('/student/no/such/page');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Page not found');
    expect(screen.getByText('This page isn’t here. It may have moved, or the link is old.')).toBeInTheDocument();
    expect(screen.getByText('Address: /student/no/such/page')).toBeInTheDocument();
  });

  it("leads an athlete to the athlete's home", () => {
    renderAt('/student/nowhere');
    const home = screen.getByRole('link', { name: 'Back to the home page' });
    expect(home).toHaveAttribute('href', '/student');
    expect(home).toHaveClass('pk-btn', 'pk-btn-primary');
  });

  it("leads a coach to the coach's athletes", () => {
    mockRole = 'coach';
    renderAt('/coach/nowhere');
    expect(screen.getByRole('link', { name: 'Back to the home page' })).toHaveAttribute('href', '/coach/students');
  });
});
