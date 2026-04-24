import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

const mockSignIn = vi.fn();
let mockAuth = { user: null, role: null, signIn: mockSignIn };

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => mockAuth,
}));

import LoginPage from './LoginPage';

function renderLogin() {
  return render(
    <MemoryRouter>
      <LoginPage />
    </MemoryRouter>
  );
}

async function revealForm(user) {
  await user.click(screen.getAllByRole('button', { name: /sign in/i })[0]);
}

describe('LoginPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth = { user: null, role: null, signIn: mockSignIn };
  });

  it('renders the welcome headline and Sign In CTA', () => {
    renderLogin();
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent(/become/i);
    expect(heading).toHaveTextContent(/tony/i);
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
  });

  it('reveals email and password inputs when the CTA is tapped', async () => {
    const user = userEvent.setup();
    renderLogin();
    await revealForm(user);
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
  });

  it('types email and password then clicks Sign In', async () => {
    mockSignIn.mockResolvedValue({ error: null });
    const user = userEvent.setup();
    renderLogin();
    await revealForm(user);

    await user.type(screen.getByLabelText('Email'), 'test@test.com');
    await user.type(screen.getByLabelText('Password'), 'password123');
    await user.click(screen.getByRole('button', { name: 'Sign In' }));

    expect(mockSignIn).toHaveBeenCalledWith('test@test.com', 'password123');
  });

  it('shows error message on failed sign in', async () => {
    mockSignIn.mockResolvedValue({ error: { message: 'Invalid credentials' } });
    const user = userEvent.setup();
    renderLogin();
    await revealForm(user);

    await user.type(screen.getByLabelText('Email'), 'bad@test.com');
    await user.type(screen.getByLabelText('Password'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Sign In' }));

    expect(await screen.findByText('Invalid credentials')).toBeInTheDocument();
  });

  it('shows loading state while submitting', async () => {
    mockSignIn.mockImplementation(() => new Promise(() => {}));
    const user = userEvent.setup();
    renderLogin();
    await revealForm(user);

    await user.type(screen.getByLabelText('Email'), 'test@test.com');
    await user.type(screen.getByLabelText('Password'), 'password123');
    await user.click(screen.getByRole('button', { name: 'Sign In' }));

    expect(screen.getByRole('button', { name: 'Signing in…' })).toBeDisabled();
  });
});
