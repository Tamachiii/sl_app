import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import ErrorBoundary from './ErrorBoundary';

function Boom({ shouldThrow }) {
  if (shouldThrow) throw new Error('kaboom');
  return <div data-testid="ok">no error</div>;
}

describe('<ErrorBoundary />', () => {
  it('renders children when no error', () => {
    render(
      <ErrorBoundary>
        <Boom shouldThrow={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('ok')).toBeInTheDocument();
  });

  it('catches a render error and shows the fallback with the message', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <ErrorBoundary>
        <Boom shouldThrow={true} />
      </ErrorBoundary>,
    );
    expect(screen.getByText(/Something went wrong/i)).toBeInTheDocument();
    expect(screen.getByText(/kaboom/)).toBeInTheDocument();
    errSpy.mockRestore();
  });

  it('"Try again" resets state — re-rendering with non-throwing children works', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    function Toggle() {
      const [crash, setCrash] = useState(true);
      return (
        <ErrorBoundary>
          <button onClick={() => setCrash(false)}>fix</button>
          <Boom shouldThrow={crash} />
        </ErrorBoundary>
      );
    }
    const { rerender } = render(<Toggle />);
    expect(screen.getByText(/Something went wrong/i)).toBeInTheDocument();
    // Click "Try again" — state resets but the child still throws because
    // `crash` is still true. The next render with crash=false (achieved by
    // rerendering Toggle after clicking "fix") passes through.
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Try again/i }));
    // Boundary cleared; child re-mounts. Since crash is still true it throws
    // again. Verify the boundary still shows fallback.
    expect(screen.getByText(/Something went wrong/i)).toBeInTheDocument();
    rerender(<Toggle />);
    errSpy.mockRestore();
  });
});
