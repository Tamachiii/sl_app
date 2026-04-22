import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import SessionCard from './SessionCard';

const slot = {
  id: 'slot-1',
  sets: 3,
  reps: 8,
  weight_kg: 40,
  exercise: { id: 'ex-1', name: 'Front Squat', type: 'push' },
};

const baseSession = {
  id: 'sess-1',
  title: 'Lower 1',
  sort_order: 0,
  archived_at: null,
  exercise_slots: [slot],
};

describe('SessionCard', () => {
  it('renders the session title and exercise count', () => {
    render(<SessionCard session={baseSession} />);
    expect(screen.getByText('Lower 1')).toBeInTheDocument();
    expect(screen.getByText(/1\s+EX/)).toBeInTheDocument();
  });

  it('shows the Start pill and fires onStart when not confirmed', async () => {
    const onStart = vi.fn();
    render(<SessionCard session={baseSession} onStart={onStart} defaultOpen />);
    // sl-pill uses raw "start" text; CSS uppercases visually.
    expect(screen.getByText('start')).toBeInTheDocument();
    const startButton = screen.getByRole('button', { name: /Start session/i });
    await userEvent.click(startButton);
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it('shows the done pill and the Review CTA when confirmed', () => {
    render(<SessionCard session={baseSession} confirmed defaultOpen />);
    // sl-pill uses raw "done" text; CSS uppercases visually.
    expect(screen.getByText('done')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Review session/i })).toBeInTheDocument();
  });

  it('shows the archived pill and hides the CTA when archived', () => {
    render(<SessionCard session={baseSession} archived defaultOpen />);
    expect(screen.getByText('ARCHIVED')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Start session|Review session/i })).toBeNull();
  });

  it('uncontrolled mode: clicking the header toggles open', async () => {
    const user = userEvent.setup();
    render(<SessionCard session={baseSession} />);
    const header = screen.getByRole('button', { expanded: false });
    expect(screen.queryByText('Front Squat')).toBeNull();
    await user.click(header);
    expect(screen.getByText('Front Squat')).toBeInTheDocument();
  });

  it('controlled mode: parent "open" wins and onToggle fires', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    const { rerender } = render(
      <SessionCard session={baseSession} open={false} onToggle={onToggle} />
    );
    expect(screen.queryByText('Front Squat')).toBeNull();

    const header = screen.getByRole('button', { expanded: false });
    await user.click(header);
    expect(onToggle).toHaveBeenCalledTimes(1);
    // With parent state unchanged, the card stays closed even after click.
    expect(screen.queryByText('Front Squat')).toBeNull();

    rerender(<SessionCard session={baseSession} open onToggle={onToggle} />);
    expect(screen.getByText('Front Squat')).toBeInTheDocument();
  });
});
