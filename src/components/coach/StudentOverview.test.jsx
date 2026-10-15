import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';

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

  // Review item L15: a section header was 36px tall.
  it('has section headers a thumb can hit: 44px', () => {
    render(<StudentOverview />);
    for (const name of [/programming/i, /goals/i, /stats/i]) {
      expect(screen.getByRole('button', { name })).toHaveClass('min-h-11');
    }
  });

  it('marks section headers with aria-expanded for assistive tech', async () => {
    const user = userEvent.setup();
    render(<StudentOverview />);
    const stats = screen.getByRole('button', { name: /stats/i });
    expect(stats).toHaveAttribute('aria-expanded', 'false');
    await user.click(stats);
    expect(stats).toHaveAttribute('aria-expanded', 'true');
  });

  // Review finding P12. The athlete page listed sessions and nothing else led
  // anywhere: the Message and View-sessions actions of the old Profile tab
  // went away with the tabs. They are back, as the header's action row.
  describe('athlete actions', () => {
    // The real wiring: CoachHome resolves the athlete and hands it down
    // through the outlet.
    function renderWithStudent(student) {
      return render(
        <MemoryRouter initialEntries={['/coach/students/s-1']}>
          <Routes>
            <Route path="/coach/students/:studentId" element={<Outlet context={{ student }} />}>
              <Route index element={<StudentOverview />} />
            </Route>
          </Routes>
        </MemoryRouter>,
      );
    }
    const alice = { id: 's-1', profile_id: 'p-1', profile: { full_name: 'Alice' } };

    it('links to the message thread, which is keyed on the PROFILE id', () => {
      renderWithStudent(alice);
      expect(screen.getByRole('link', { name: 'Message' }))
        .toHaveAttribute('href', '/coach/messages/p-1');
    });

    it('links to the athlete\'s sessions in the feed', () => {
      renderWithStudent(alice);
      expect(screen.getByRole('link', { name: 'Sessions' }))
        .toHaveAttribute('href', '/coach/sessions?student=s-1');
    });

    it('groups the two as one named set of links, above the sections', () => {
      renderWithStudent(alice);
      const nav = screen.getByRole('navigation', { name: /alice/i });
      expect(within(nav).getAllByRole('link')).toHaveLength(2);
      const programming = screen.getByRole('button', { name: /programming/i });
      expect(nav.compareDocumentPosition(programming) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    // Review item L15: the two were 36px tall (`min-h-9`).
    it('are pill buttons, 44px', () => {
      renderWithStudent(alice);
      for (const name of ['Message', 'Sessions']) {
        const link = screen.getByRole('link', { name });
        expect(link).toHaveClass('sl-pill', 'sl-pill-btn');
        expect(link).not.toHaveClass('min-h-9');
      }
    });

    it('offers no thread link for an athlete row without a profile id', () => {
      renderWithStudent({ id: 's-1', profile: { full_name: 'Alice' } });
      expect(screen.queryByRole('link', { name: 'Message' })).toBeNull();
      expect(screen.getByRole('link', { name: 'Sessions' })).toBeInTheDocument();
    });
  });
});
