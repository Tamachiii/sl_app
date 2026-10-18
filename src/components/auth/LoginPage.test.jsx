import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

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

const emailField = () => screen.getByLabelText('Email');
const passwordField = () => screen.getByLabelText('Password');
const signInButton = () => screen.getByRole('button', { name: 'Sign in' });

describe('LoginPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth = { user: null, role: null, signIn: mockSignIn };
  });

  it("shows the app's name, the coach's line and the form on one screen", () => {
    renderLogin();
    expect(screen.getByText('SL Coach')).toBeInTheDocument();
    expect(screen.getByText('Become a big monster like Tony.')).toBeInTheDocument();
    // The form's title is the page's one heading.
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Sign in');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(signInButton()).toHaveAttribute('type', 'submit');
  });

  it('shows email and password at once: there is no step before the form', () => {
    // On a phone, a "welcome" step used to stand before the form, behind a
    // tap on Sign In.
    renderLogin();
    expect(emailField()).toHaveAttribute('type', 'email');
    expect(emailField()).toHaveAttribute('autocomplete', 'email');
    expect(emailField()).toHaveFocus();
    expect(passwordField()).toHaveAttribute('type', 'password');
    expect(passwordField()).toHaveAttribute('autocomplete', 'current-password');
    expect(screen.getAllByRole('button')).toEqual([signInButton()]);
  });

  it('types email and password then clicks Sign in', async () => {
    mockSignIn.mockResolvedValue({ error: null });
    const user = userEvent.setup();
    renderLogin();

    await user.type(emailField(), 'test@test.com');
    await user.type(passwordField(), 'password123');
    await user.click(signInButton());

    expect(mockSignIn).toHaveBeenCalledWith('test@test.com', 'password123');
  });

  it('says in the app’s language that the email or the password is wrong', async () => {
    mockSignIn.mockResolvedValue({ error: { message: 'Invalid login credentials', code: 'invalid_credentials', status: 400 } });
    const user = userEvent.setup();
    renderLogin();

    await user.type(emailField(), 'bad@test.com');
    await user.type(passwordField(), 'wrong');
    await user.click(signInButton());

    expect(await screen.findByRole('alert')).toHaveTextContent('Wrong email or password.');
    // The form is offered again.
    expect(signInButton()).toBeEnabled();
  });

  // The auth server's message is English; it is never shown as it comes.
  it.each([
    ['an older server, without a code', { message: 'Invalid login credentials', status: 400 }, 'Wrong email or password.'],
    ['too many tries', { message: 'Request rate limit reached', status: 429 }, 'Too many tries. Wait a few minutes, then try again.'],
    ['no answer', Object.assign(new Error('Failed to fetch'), { name: 'AuthRetryableFetchError' }), 'The server did not answer. Check your connection and try again.'],
    ['anything else', { message: 'Database error querying schema', code: 'unexpected_failure', status: 500 }, 'Signing in did not work. Try again.'],
  ])('words a refusal in the app’s language: %s', async (_case, error, sentence) => {
    mockSignIn.mockResolvedValue({ error });
    const user = userEvent.setup();
    renderLogin();
    await user.type(emailField(), 'bad@test.com');
    await user.type(passwordField(), 'wrong');
    await user.click(signInButton());
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(sentence);
    expect(alert).not.toHaveTextContent(error.message);
  });

  it('shows loading state while submitting', async () => {
    mockSignIn.mockImplementation(() => new Promise(() => {}));
    const user = userEvent.setup();
    renderLogin();

    await user.type(emailField(), 'test@test.com');
    await user.type(passwordField(), 'password123');
    await user.click(signInButton());

    expect(screen.getByRole('button', { name: 'Signing in…' })).toBeDisabled();
  });

  // The page used to colour itself inline, on ink-900, and its muted lines
  // had to be held to the token src/test/contrast.test.js keeps at AA. In
  // Parc it is drawn from the design system's classes only, whose text pairs
  // src/test/parcTokens.test.js holds to 4.5:1.
  it('draws its colours from the Parc tokens: no inline colour, none of the old ink scale', () => {
    const { container } = renderLogin();
    const inlineColours = [...container.querySelectorAll('[style]')]
      .map((el) => el.getAttribute('style'))
      .filter((style) => /(?:^|;\s*)(?:color|background(?:-color)?):/.test(style));
    expect(inlineColours).toEqual([]);
    const oldScale = [...container.querySelectorAll('[class]')]
      .map((el) => el.getAttribute('class'))
      .filter((cls) => /\b(?:text|bg|border)-(?:ink-\d{3}|gray-\d{3}|accent)\b/.test(cls));
    expect(oldScale).toEqual([]);
  });

  // Review item L11: signing in always went to the role's home, so a link
  // opened without a session — a notification, a bookmark — was lost on the
  // way through this page.
  describe('once signed in', () => {
    function Where() {
      const { pathname, search } = useLocation();
      return <output data-testid="where">{pathname + search}</output>;
    }

    function signedInAt(state) {
      render(
        <MemoryRouter initialEntries={[{ pathname: '/login', state }]}>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="*" element={<Where />} />
          </Routes>
        </MemoryRouter>,
      );
      return screen.getByTestId('where').textContent;
    }

    beforeEach(() => {
      mockAuth = { user: { id: 'u-1' }, role: 'coach', signIn: mockSignIn };
    });

    it('returns to the page that sent here when it is a page of the role', () => {
      expect(signedInAt({ from: '/coach/students/a1/s/s1' })).toBe('/coach/students/a1/s/s1');
    });

    it('keeps the query of that page', () => {
      expect(signedInAt({ from: '/coach/students/a1?program=p2' })).toBe('/coach/students/a1?program=p2');
    });

    it('goes to the role home without a page to return to', () => {
      expect(signedInAt(undefined)).toBe('/coach');
    });

    it.each([
      ["another role's page", '/student/session/s1'],
      ['a protocol-relative URL', '//evil.example/coach/students'],
      ['an absolute URL', 'https://evil.example/coach/students'],
      ['a value that is not a string', { pathname: '/coach/students/a1' }],
      ['the root', '/'],
    ])('goes to the role home for %s', (_label, from) => {
      expect(signedInAt({ from })).toBe('/coach');
    });

    it('returns a student to a page of theirs', () => {
      mockAuth = { user: { id: 'u-2' }, role: 'student', signIn: mockSignIn };
      expect(signedInAt({ from: '/student/session/s1' })).toBe('/student/session/s1');
    });
  });
});
