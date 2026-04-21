import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

const mockNavigate = vi.fn();
const mockCreateWeek = { mutate: vi.fn(), isPending: false };

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('../../hooks/useProgram', () => ({
  useCreateWeek: () => mockCreateWeek,
}));

vi.mock('../../hooks/useWeek', () => ({
  useReorderWeeks: () => ({ mutate: vi.fn(), isPending: false }),
}));

import WeekTimeline from './WeekTimeline';

const program = {
  id: 'prog-1',
  weeks: [
    { id: 'w-1', week_number: 1, label: null },
    { id: 'w-2', week_number: 2, label: 'Deload' },
  ],
};

function renderTimeline(props = {}) {
  return render(
    <MemoryRouter>
      <WeekTimeline studentId="s-1" program={program} {...props} />
    </MemoryRouter>
  );
}

describe('WeekTimeline', () => {
  it('renders week buttons', () => {
    renderTimeline();
    expect(screen.getByText('W1')).toBeInTheDocument();
    expect(screen.getByText('W2')).toBeInTheDocument();
  });

  it('renders week label', () => {
    renderTimeline();
    expect(screen.getByText('Deload')).toBeInTheDocument();
  });

  it('clicking a week button navigates to the week view', async () => {
    const user = userEvent.setup();
    renderTimeline();

    await user.click(screen.getByText('W1'));
    expect(mockNavigate).toHaveBeenCalledWith('/coach/student/s-1/week/w-1');
  });

  it('clicking "+ Week" calls createWeek.mutate', async () => {
    const user = userEvent.setup();
    renderTimeline();

    await user.click(screen.getByText('+ WEEK'));
    expect(mockCreateWeek.mutate).toHaveBeenCalledWith({
      programId: 'prog-1',
      weekNumber: 3,
    });
  });
});
