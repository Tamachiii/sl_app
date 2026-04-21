import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Header from './Header';
import { ThemeProvider } from '../../hooks/useTheme';

const mockNavigate = vi.fn();
const mockSignOut = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({ signOut: mockSignOut }),
}));

function renderHeader(props = {}) {
  return render(
    <ThemeProvider>
      <MemoryRouter>
        <Header title="Test Title" {...props} />
      </MemoryRouter>
    </ThemeProvider>
  );
}

describe('Header', () => {
  it('renders the title', () => {
    renderHeader();
    expect(screen.getByText('Test Title')).toBeInTheDocument();
  });

  it('does not show back button by default', () => {
    renderHeader();
    expect(screen.queryByLabelText('Back')).not.toBeInTheDocument();
  });

  it('shows and clicks back button when showBack is true', async () => {
    const user = userEvent.setup();
    renderHeader({ showBack: true });

    const backBtn = screen.getByLabelText('Back');
    expect(backBtn).toBeInTheDocument();
    await user.click(backBtn);
    expect(mockNavigate).toHaveBeenCalledWith(-1);
  });

  it('renders action buttons', () => {
    renderHeader({ actions: <button>Action</button> });
    expect(screen.getByText('Action')).toBeInTheDocument();
  });

  it('renders sign-out button and calls signOut on click', async () => {
    const user = userEvent.setup();
    renderHeader();
    const signOutBtn = screen.getByLabelText('Sign out');
    expect(signOutBtn).toBeInTheDocument();
    await user.click(signOutBtn);
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });
});
