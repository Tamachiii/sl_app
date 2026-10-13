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

  // The page colours itself inline, on ink-900. An inline colour is not
  // remapped by `.dark`, so the token named here is the one that is drawn:
  // ink-500 is 2.59:1 on that background, ink-400 is the muted-text token
  // src/test/contrast.test.js holds to AA.
  describe('footer line', () => {
    const footerStyle = () => screen.getByText('EST. 2026').parentElement.getAttribute('style');

    it('is muted text on the welcome step', () => {
      renderLogin();
      expect(screen.getByText('BUILT FOR THE BAR').parentElement).toBe(screen.getByText('EST. 2026').parentElement);
      expect(footerStyle()).toContain('color: var(--color-ink-400)');
      expect(footerStyle()).not.toContain('--color-ink-500');
    });

    it('is muted text under the form', async () => {
      const user = userEvent.setup();
      renderLogin();
      await revealForm(user);
      // The welcome step, and its footer, are gone: this is the other one.
      expect(screen.getByLabelText('Email')).toBeInTheDocument();
      expect(footerStyle()).toContain('color: var(--color-ink-400)');
      expect(footerStyle()).not.toContain('--color-ink-500');
    });

    it('draws no text on its dark background in a step darker than ink-400', async () => {
      const user = userEvent.setup();
      const { container } = renderLogin();
      // ink-500 to ink-950 as an inline text colour. An element that paints
      // its own background is left out: dark text on an accent fill is right.
      const darkText = () =>
        [...container.querySelectorAll('[style]')]
          .map((el) => el.getAttribute('style'))
          .filter((style) => /(?:^|;\s*)color:\s*var\(--color-ink-[5-9]\d\d\)/.test(style))
          .filter((style) => !/(?:^|;\s*)background(?:-color)?:/.test(style));

      expect(darkText()).toEqual([]);
      await revealForm(user);
      expect(darkText()).toEqual([]);
    });
  });
});
