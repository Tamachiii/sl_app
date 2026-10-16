import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

let mockGoals = { data: [], isLoading: false };

vi.mock('../../hooks/useGoals', () => ({
  useMyGoals: () => mockGoals,
  useAddGoalProgress: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteGoalProgress: () => ({ mutate: vi.fn(), isPending: false }),
  useToggleGoalAchieved: () => ({ mutate: vi.fn(), isPending: false }),
  formatGoalTarget: () => '100 kg',
}));

vi.mock('../../hooks/useOnlineStatus', () => ({
  useOnlineStatus: () => true,
}));

import MyGoals from './MyGoals';

function Where() {
  const location = useLocation();
  return <p data-testid="where">{location.pathname}</p>;
}

// `entries`: the tab's history, the goals page last.
function renderAt(entries) {
  return render(
    <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
      <Routes>
        <Route path="/student/goals" element={<MyGoals />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>
  );
}

const where = () => screen.getByTestId('where').textContent;
const back = () => fireEvent.click(screen.getByRole('button', { name: /back/i }));

beforeEach(() => {
  mockGoals = { data: [], isLoading: false };
});

// L31. The goals page is reached from the profile, but a link or a cold start
// of the installed app can open it as the first entry of the tab, where
// `navigate(-1)` has nowhere to go.
describe('MyGoals: the way back', () => {
  it('goes one step back, to the page it was opened from, when there is one', () => {
    renderAt(['/student/profile', '/student/goals']);
    back();
    expect(where()).toBe('/student/profile');
  });

  it("goes to the athlete's home from the first entry of the tab", () => {
    renderAt(['/student/goals']);
    back();
    expect(where()).toBe('/student');
  });
});
