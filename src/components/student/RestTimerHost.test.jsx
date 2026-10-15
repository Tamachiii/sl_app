import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import RestTimerHost from './RestTimerHost';
import RestTimerBanner from './RestTimerBanner';
import {
  startRestTimer,
  clearRestTimer,
  extendRestTimer,
  resetRestTimer,
} from '../../hooks/useRestTimer';

// Their own tests hold what they do; here they would reach for the wake lock,
// the audio and Supabase.
vi.mock('../../hooks/useRestTimerEffects', () => ({ useRestTimerEffects: () => {} }));
vi.mock('../../hooks/useRestTimerPush', () => ({ useRestTimerPush: () => {} }));

beforeEach(() => {
  resetRestTimer();
  vi.useFakeTimers();
});

afterEach(() => {
  resetRestTimer();
  vi.useRealTimers();
});

const region = () => screen.getByRole('status');

function tick(ms) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

// P44. The banner's countdown was a live region whose label changed every
// second: VoiceOver and TalkBack read the rest aloud second by second and
// "Rest done" was lost in it.
describe('RestTimerHost: what a screen reader hears of a rest', () => {
  it('is a status region that is always in the page, empty while no rest runs', () => {
    render(<RestTimerHost />);
    expect(region()).toHaveTextContent(/^$/);
    expect(region()).toHaveClass('sr-only');
  });

  it('says the start of a rest, then nothing new until it ends, then "Rest done"', () => {
    render(<RestTimerHost />);
    const node = region();

    act(() => {
      startRestTimer('log-A', 90);
    });
    expect(node).toHaveTextContent(/^Rest 1:30$/);

    // A minute of ticks: the text the region holds does not move.
    for (let i = 0; i < 60; i += 1) {
      tick(1000);
      expect(node).toHaveTextContent(/^Rest 1:30$/);
    }

    tick(30_000);
    expect(node).toHaveTextContent(/^Rest done$/);
    // The same node all along: a region mounted with its text says nothing.
    expect(region()).toBe(node);
  });

  it('is emptied once the "Rest done" flash is over', () => {
    render(<RestTimerHost />);
    act(() => {
      startRestTimer('log-A', 30);
    });
    tick(30_000);
    expect(region()).toHaveTextContent(/^Rest done$/);
    tick(6_000);
    expect(region()).toHaveTextContent(/^$/);
  });

  it('is emptied when the rest is taken back', () => {
    render(<RestTimerHost />);
    act(() => {
      startRestTimer('log-A', 60);
    });
    act(() => {
      clearRestTimer('log-A');
    });
    expect(region()).toHaveTextContent(/^$/);
  });

  it('says the length of the next rest when a new set replaces the running one', () => {
    render(<RestTimerHost />);
    act(() => {
      startRestTimer('log-A', 90);
    });
    tick(20_000);
    act(() => {
      startRestTimer('log-B', 120);
    });
    expect(region()).toHaveTextContent(/^Rest 2:00$/);
  });

  it('says the new length when the athlete gives the rest 30 s more', () => {
    render(<RestTimerHost />);
    act(() => {
      startRestTimer('log-A', 90);
    });
    tick(20_000);
    act(() => {
      extendRestTimer('log-A', 30);
    });
    expect(region()).toHaveTextContent(/^Rest 1:40$/);
    tick(99_000);
    expect(region()).toHaveTextContent(/^Rest 1:40$/);
    tick(1_000);
    expect(region()).toHaveTextContent(/^Rest done$/);
  });

  it('leaves the visible countdown out of every live region', () => {
    render(
      <>
        <RestTimerBanner />
        <RestTimerHost />
      </>,
    );
    act(() => {
      startRestTimer('log-A', 90);
    });
    tick(1000);
    const countdown = screen.getByText('1:29');
    expect(countdown.closest('[aria-live], [role="status"], [role="alert"], [role="timer"]')).toBeNull();
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });
});
