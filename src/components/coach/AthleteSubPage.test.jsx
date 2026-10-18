import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Outlet, Route, Routes, useLocation } from 'react-router-dom';

// Goals and Stats left the athlete page for pages of their own: a title, the
// athlete under it, and the way back to the athlete. Their sections are
// stand-ins here — they have tests of their own.
vi.mock('./StudentGoalsSection', () => ({
  default: () => <div data-testid="goals-section">goals</div>,
}));
vi.mock('./StudentStatsSection', () => ({
  default: () => <div data-testid="stats-section">stats</div>,
}));

import StudentGoalsPage from './StudentGoalsPage';
import StudentStatsPage from './StudentStatsPage';

const ALICE = { id: 's-1', profile_id: 'p-1', profile: { full_name: 'Alice' } };

function Where() {
  const { pathname, search } = useLocation();
  return <output data-testid="where">{pathname + search}</output>;
}

// The pages as CoachHome hosts them: the athlete, their name and the frame of
// the title in the outlet's context.
function renderAt(entries, initialIndex = entries.length - 1) {
  const context = {
    student: ALICE,
    athleteName: 'Alice',
    titleProps: { actions: <button type="button">Account</button> },
  };
  return render(
    <MemoryRouter initialEntries={entries} initialIndex={initialIndex}>
      <Routes>
        <Route path="/coach/students/:studentId" element={<Outlet context={context} />}>
          <Route index element={<div data-testid="athlete-page">athlete</div>} />
          <Route path="goals" element={<StudentGoalsPage />} />
          <Route path="stats" element={<StudentStatsPage />} />
        </Route>
      </Routes>
      <Where />
    </MemoryRouter>,
  );
}

describe('the Goals and Stats pages of an athlete', () => {
  it('title Goals with the athlete under it, over the goals', () => {
    renderAt(['/coach/students/s-1/goals']);
    expect(screen.getByRole('heading', { level: 1, name: 'Goals' })).toHaveClass('pk-large-title');
    expect(screen.getByText('Alice')).toHaveClass('pk-subhead');
    expect(screen.getByTestId('goals-section')).toBeInTheDocument();
  });

  it('title Stats with the athlete under it, over the stats', () => {
    renderAt(['/coach/students/s-1/stats']);
    expect(screen.getByRole('heading', { level: 1, name: 'Stats' })).toBeInTheDocument();
    expect(screen.getByTestId('stats-section')).toBeInTheDocument();
  });

  it('keep the account menu of the frame they are handed', () => {
    renderAt(['/coach/students/s-1/goals']);
    expect(screen.getByRole('button', { name: 'Account' })).toBeInTheDocument();
  });

  // The athlete page is the only way in: back is one step back, which brings
  // the block the coach was on with it.
  it('go back to the athlete page they were opened from, on its block', async () => {
    const user = userEvent.setup();
    renderAt(['/coach/students/s-1?program=p-2', '/coach/students/s-1/stats']);
    await user.click(screen.getByRole('button', { name: 'Back to Alice' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/coach/students/s-1?program=p-2');
    expect(screen.getByTestId('athlete-page')).toBeInTheDocument();
  });

  // An old link to …/goals opens the tab on the page: back is the athlete.
  it('go to the athlete page on the first entry of the tab', async () => {
    const user = userEvent.setup();
    renderAt(['/coach/students/s-1/goals']);
    await user.click(screen.getByRole('button', { name: 'Back to Alice' }));
    expect(screen.getByTestId('where')).toHaveTextContent(/^\/coach\/students\/s-1$/);
  });
});
