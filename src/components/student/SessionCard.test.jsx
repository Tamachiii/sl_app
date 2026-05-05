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
    // sl-pill uses raw "archived" text; CSS uppercases visually.
    expect(screen.getByText('archived')).toBeInTheDocument();
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

  it('collapsed Start pill navigates to onStart without expanding the card', async () => {
    const user = userEvent.setup();
    const onStart = vi.fn();
    render(<SessionCard session={baseSession} onStart={onStart} />);
    // While collapsed, the pill is the dedicated "Start session" button on
    // the right of the row (separate from the title-toggle button).
    const pill = screen.getByRole('button', { name: 'Start session' });
    await user.click(pill);
    expect(onStart).toHaveBeenCalledTimes(1);
    // Card must remain collapsed — pill is a navigation, not an expand.
    expect(screen.queryByText('Front Squat')).toBeNull();
  });

  it('open card hides the pill and exposes only the bottom Start CTA', () => {
    render(<SessionCard session={baseSession} defaultOpen />);
    const startButtons = screen.getAllByRole('button', { name: /Start session/i });
    expect(startButtons).toHaveLength(1);
  });

  it('shows a grouped summary instead of compact prescription when sets differ', () => {
    const variedSlot = {
      id: 'slot-2',
      sets: 3,
      reps: 6,
      weight_kg: 100,
      exercise: { id: 'ex-2', name: 'Deadlift', type: 'pull' },
      set_logs: [
        { set_number: 1, target_reps: 6, target_weight_kg: 100 },
        { set_number: 2, target_reps: 6, target_weight_kg: 100 },
        { set_number: 3, target_reps: 8, target_weight_kg: 80 },
      ],
    };
    render(
      <SessionCard
        session={{ ...baseSession, exercise_slots: [variedSlot] }}
        defaultOpen
      />
    );
    expect(screen.getByText('2 × 6 @ 100kg · 1 × 8 @ 80kg')).toBeInTheDocument();
  });

  it('falls back to "N sets · varied" when more than three distinct groups', () => {
    const wildSlot = {
      id: 'slot-3',
      sets: 4,
      reps: 5,
      weight_kg: 100,
      exercise: { id: 'ex-3', name: 'Snatch', type: 'pull' },
      set_logs: [
        { set_number: 1, target_reps: 5, target_weight_kg: 60 },
        { set_number: 2, target_reps: 4, target_weight_kg: 70 },
        { set_number: 3, target_reps: 3, target_weight_kg: 80 },
        { set_number: 4, target_reps: 2, target_weight_kg: 90 },
      ],
    };
    render(
      <SessionCard
        session={{ ...baseSession, exercise_slots: [wildSlot] }}
        defaultOpen
      />
    );
    expect(screen.getByText('4 sets · varied')).toBeInTheDocument();
  });

  it('collapsible={false}: content always renders and no toggle button is exposed', () => {
    render(<SessionCard session={baseSession} collapsible={false} />);
    // Exercise list visible without any user interaction.
    expect(screen.getByText('Front Squat')).toBeInTheDocument();
    // No expandable header button (the chevron / toggle is suppressed).
    expect(screen.queryByRole('button', { expanded: true })).toBeNull();
    expect(screen.queryByRole('button', { expanded: false })).toBeNull();
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
