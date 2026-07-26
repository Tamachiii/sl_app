import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('./StudentProgrammingSection', () => ({
  default: () => <div data-testid="programming">programming</div>,
}));
vi.mock('./StudentGoalsSection', () => ({
  default: () => <div data-testid="goals">goals</div>,
}));
vi.mock('./StudentStatsSection', () => ({
  default: () => <div data-testid="stats">stats</div>,
}));

import StudentOverview from './StudentOverview';

describe('StudentOverview', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('opens Programming by default and leaves the rest collapsed', () => {
    render(<StudentOverview />);
    expect(screen.getByTestId('programming')).toBeInTheDocument();
    expect(screen.queryByTestId('goals')).not.toBeInTheDocument();
    expect(screen.queryByTestId('stats')).not.toBeInTheDocument();
  });

  it('shows every section heading so nothing is hidden', () => {
    render(<StudentOverview />);
    expect(screen.getByRole('button', { name: /programming/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /goals/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /stats/i })).toBeInTheDocument();
  });

  it('expands a collapsed section on click', async () => {
    const user = userEvent.setup();
    render(<StudentOverview />);
    await user.click(screen.getByRole('button', { name: /stats/i }));
    expect(screen.getByTestId('stats')).toBeInTheDocument();
  });

  it('unmounts a collapsed section rather than hiding it, so it costs no query', async () => {
    const user = userEvent.setup();
    render(<StudentOverview />);
    await user.click(screen.getByRole('button', { name: /programming/i }));
    expect(screen.queryByTestId('programming')).not.toBeInTheDocument();
  });

  it('remembers open/closed across remounts', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<StudentOverview />);
    await user.click(screen.getByRole('button', { name: /goals/i }));
    expect(screen.getByTestId('goals')).toBeInTheDocument();

    unmount();
    render(<StudentOverview />);
    expect(screen.getByTestId('goals')).toBeInTheDocument();
  });

  it('marks section headers with aria-expanded for assistive tech', async () => {
    const user = userEvent.setup();
    render(<StudentOverview />);
    const stats = screen.getByRole('button', { name: /stats/i });
    expect(stats).toHaveAttribute('aria-expanded', 'false');
    await user.click(stats);
    expect(stats).toHaveAttribute('aria-expanded', 'true');
  });
});
