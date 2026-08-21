import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'u-1' },
    profile: { full_name: 'Tony Me' },
    signOut: vi.fn(),
  }),
}));

let mockWeeks = { data: [], isLoading: false };
vi.mock('../../hooks/useStudentProgramDetails', () => ({
  useStudentProgramDetails: () => mockWeeks,
}));

let mockConfirmedIds = { data: new Set() };
vi.mock('../../hooks/useSessionConfirmation', () => ({
  useMyConfirmedSessionIds: () => mockConfirmedIds,
}));

vi.mock('../../hooks/useMessages', () => ({
  useMyFeedbackSessionIds: () => ({ data: new Set() }),
  useUnreadMessageCount: () => ({ data: 0 }),
}));

vi.mock('../ui/UserMenu', () => ({ default: () => <div data-testid="user-menu" /> }));

import StudentTraining from './StudentTraining';

const activeProgram = { id: 'p-1', name: 'Bloc Reprise', sort_order: 1, is_active: true };

const session = (id, title, over = {}) => ({
  id,
  title,
  day_number: 1,
  sort_order: 0,
  archived_at: null,
  scheduled_date: null,
  performed_at: null,
  exercise_slots: [],
  ...over,
});

const week = (id, week_number, sessions, program = activeProgram) => ({
  id,
  week_number,
  label: null,
  program,
  sessions,
});

function renderTraining() {
  return render(
    <MemoryRouter>
      <StudentTraining />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockConfirmedIds = { data: new Set() };
  mockWeeks = { data: [], isLoading: false };
});

describe('StudentTraining', () => {
  it('shows a spinner while loading', () => {
    mockWeeks = { data: null, isLoading: true };
    const { container } = renderTraining();
    expect(container.querySelector('.animate-spin')).toBeTruthy();
  });

  it('shows the empty state when no program is assigned', () => {
    renderTraining();
    expect(screen.getByText(/no program assigned yet/i)).toBeInTheDocument();
  });

  // The whole reason the two pages merged: one screen, one question.
  it('does not render a Mon–Sun day strip or week navigation', () => {
    mockWeeks = {
      data: [week('w-1', 1, [session('s-1', 'Upper 1', { day_number: 1 })])],
      isLoading: false,
    };
    renderTraining();
    expect(screen.queryByLabelText('Week overview')).toBeNull();
    expect(screen.queryByRole('button', { name: /previous week/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /next week/i })).toBeNull();
  });

  it('states where the athlete is in the block exactly once', () => {
    mockWeeks = {
      data: [
        week('w-1', 1, [
          session('done-1', 'Upper 1', { day_number: 1, performed_at: '2026-08-18T18:00:00Z' }),
          session('next-1', 'Upper 2', { day_number: 3 }),
        ]),
      ],
      isLoading: false,
    };
    mockConfirmedIds = { data: new Set(['done-1']) };
    renderTraining();
    expect(screen.getByText('Session 2 of 2')).toBeInTheDocument();
    // The old page stacked four headings for this; these are retired.
    expect(screen.queryByText('Next session')).toBeNull();
    expect(screen.queryByText('Then')).toBeNull();
  });

  // The defect that prompted the merge: finished sessions were ordered by
  // RECOMMENDED weekday, so one trained on the 18th sat above one trained on
  // the 21st. A log has exactly one honest order — when it happened.
  it('orders finished sessions by the day they were really trained, newest first', () => {
    mockWeeks = {
      data: [
        week('w-1', 1, [
          // Monday's session, trained first.
          session('upper1', 'Upper 1', { day_number: 1, performed_at: '2026-08-18T18:00:00Z' }),
          // Friday's session, trained three days LATER — must sort above.
          session('wrist', 'Wrist Routine', { day_number: 5, performed_at: '2026-08-21T18:00:00Z' }),
        ]),
      ],
      isLoading: false,
    };
    mockConfirmedIds = { data: new Set(['upper1', 'wrist']) };
    renderTraining();

    const titles = screen.getAllByText(/^(Upper 1|Wrist Routine)$/).map((n) => n.textContent);
    expect(titles).toEqual(['Wrist Routine', 'Upper 1']);
  });

  it('shows each finished session on the date it was actually trained', () => {
    mockWeeks = {
      data: [
        week('w-1', 1, [
          session('wrist', 'Wrist Routine', {
            day_number: 1, // recommended Monday…
            performed_at: '2026-08-21T18:00:00Z', // …trained on the Friday
          }),
        ]),
      ],
      isLoading: false,
    };
    mockConfirmedIds = { data: new Set(['wrist']) };
    renderTraining();
    expect(screen.getByText(/Fri, Aug 21/)).toBeInTheDocument();
  });

  it('spells a recommended weekday out as advice rather than a date', () => {
    mockWeeks = {
      data: [week('w-1', 1, [session('s-1', 'Upper 1', { day_number: 3 })])],
      isLoading: false,
    };
    renderTraining();
    expect(screen.getByText(/Recommended Wednesday/)).toBeInTheDocument();
  });

  it('puts the next session first and leaves the rest in program order', () => {
    mockWeeks = {
      data: [
        week('w-1', 1, [
          session('a', 'Upper 1', { day_number: 1 }),
          session('b', 'Leg', { day_number: 3 }),
        ]),
        week('w-2', 2, [session('c', 'Upper 2', { day_number: 1 })]),
      ],
      isLoading: false,
    };
    renderTraining();
    const titles = screen.getAllByText(/^(Upper 1|Leg|Upper 2)$/).map((n) => n.textContent);
    expect(titles).toEqual(['Upper 1', 'Leg', 'Upper 2']);
  });

  it('celebrates a finished block instead of showing an empty next slot', () => {
    mockWeeks = {
      data: [week('w-1', 1, [session('a', 'Upper 1', { performed_at: '2026-08-18T18:00:00Z' })])],
      isLoading: false,
    };
    mockConfirmedIds = { data: new Set(['a']) };
    renderTraining();
    expect(screen.getByText(/block complete/i)).toBeInTheDocument();
  });

  describe('the activity line says something or nothing', () => {
    const withPerformed = (iso) => ({
      data: [week('w-1', 1, [
        session('a', 'Upper 1', { performed_at: iso }),
        session('b', 'Upper 2', { day_number: 3 }),
      ])],
      isLoading: false,
    });

    it('reports staleness when the athlete has been away', () => {
      const fourDaysAgo = new Date();
      fourDaysAgo.setDate(fourDaysAgo.getDate() - 4);
      mockWeeks = withPerformed(fourDaysAgo.toISOString());
      mockConfirmedIds = { data: new Set(['a']) };
      renderTraining();
      expect(screen.getByText(/4 days ago/)).toBeInTheDocument();
    });

    // "Trained today" told the athlete what they already knew.
    it('never says "trained today" — it shows the week\'s rhythm instead', () => {
      mockWeeks = withPerformed(new Date().toISOString());
      mockConfirmedIds = { data: new Set(['a']) };
      renderTraining();
      expect(screen.queryByText(/trained today/i)).toBeNull();
      expect(screen.getByText(/1 session in the last 7 days/)).toBeInTheDocument();
    });

    it('says nothing at all when there is no program to comment on', () => {
      renderTraining();
      expect(screen.queryByText(/last trained/i)).toBeNull();
      expect(screen.queryByText(/in the last 7 days/i)).toBeNull();
    });
  });

  describe('past blocks', () => {
    const pastProgram = { id: 'p-0', name: 'Bloc 1', sort_order: 0, is_active: false };

    it('renders finished blocks below the active one, labelled as past', () => {
      mockWeeks = {
        data: [
          week('w-1', 1, [session('now', 'Upper 1', { day_number: 1 })]),
          week('w-0', 1, [session('old', 'Old Squat', { performed_at: '2026-06-01T18:00:00Z' })], pastProgram),
        ],
        isLoading: false,
      };
      mockConfirmedIds = { data: new Set(['old']) };
      renderTraining();

      expect(screen.getByText('Bloc Reprise')).toBeInTheDocument();
      expect(screen.getByText('Bloc 1')).toBeInTheDocument();
      expect(screen.getByText(/past program/i)).toBeInTheDocument();
    });

    // A year of coaching is hundreds of cards; the landing page must not spend
    // its height on them. Collapsed blocks are not rendered at all.
    it('collapses a finished block to a single summary row', async () => {
      const user = userEvent.setup();
      mockWeeks = {
        data: [
          week('w-1', 1, [session('now', 'Current Work', { day_number: 1 })]),
          week('w-0', 1, [
            session('old-a', 'Old Squat', { performed_at: '2026-06-01T18:00:00Z' }),
            session('old-b', 'Old Pull', { performed_at: '2026-05-20T18:00:00Z' }),
          ], pastProgram),
        ],
        isLoading: false,
      };
      mockConfirmedIds = { data: new Set(['old-a', 'old-b']) };
      renderTraining();

      // The row states what is inside without rendering any of it.
      expect(screen.getByText(/past program · 2 sessions/i)).toBeInTheDocument();
      expect(screen.queryByText('Old Squat')).toBeNull();
      expect(screen.queryByText('Old Pull')).toBeNull();
      // The ACTIVE block stays open — that is the page's actual subject.
      expect(screen.getByText('Current Work')).toBeInTheDocument();

      await user.click(screen.getByText('Bloc 1'));
      expect(screen.getByText('Old Squat')).toBeInTheDocument();
      expect(screen.getByText('Old Pull')).toBeInTheDocument();
    });

    // A lock stops LOGGING, never LOOKING. Reviewing what you did in an old
    // block is the reason the history is on the page at all — and the first
    // cut of `locked` broke exactly this by dropping onStart wholesale, so
    // "Review session" rendered as an inert button.
    it('lets a finished past-block session be reviewed', async () => {
      const user = userEvent.setup();
      mockWeeks = {
        data: [
          week('w-1', 1, [session('now', 'Current Work', { day_number: 1 })]),
          week('w-0', 1, [
            session('old', 'Old Squat', { performed_at: '2026-06-01T18:00:00Z' }),
          ], pastProgram),
        ],
        isLoading: false,
      };
      mockConfirmedIds = { data: new Set(['old']) };
      renderTraining();

      await user.click(screen.getByText('Bloc 1'));
      await user.click(screen.getByText('Old Squat'));
      const review = screen.getByRole('button', { name: /review session/i });
      await user.click(review);
      expect(mockNavigate).toHaveBeenCalledWith('/student/session/old');
    });

    // Past-block sessions are locked in the UI and by RLS, so a Start button
    // on one led nowhere.
    it('offers no Start affordance on a past block', async () => {
      const user = userEvent.setup();
      mockWeeks = {
        data: [
          week('w-1', 1, [session('now', 'Current Work', { day_number: 1 })]),
          week('w-0', 1, [session('stale', 'Never Finished')], pastProgram),
        ],
        isLoading: false,
      };
      renderTraining();
      await user.click(screen.getByText('Bloc 1'));
      const past = screen.getByText('Bloc 1').closest('section');
      expect(within(past).getByText('Never Finished')).toBeInTheDocument();
      expect(within(past).queryByRole('button', { name: /^start$/i })).toBeNull();
    });

    it('offers no Start CTA inside an unfinished past-block session either', async () => {
      const user = userEvent.setup();
      mockWeeks = {
        data: [
          week('w-1', 1, [session('now', 'Current Work', { day_number: 1 })]),
          week('w-0', 1, [session('stale', 'Never Finished')], pastProgram),
        ],
        isLoading: false,
      };
      renderTraining();
      await user.click(screen.getByText('Bloc 1'));
      await user.click(screen.getByText('Never Finished'));
      // Scoped: the ACTIVE block's next-up card legitimately shows a Start CTA.
      const past = screen.getByText('Bloc 1').closest('section');
      expect(within(past).queryByRole('button', { name: /start session/i })).toBeNull();
    });

    // A past block's unfinished sessions are history the athlete moved on
    // from — surfacing one as "next" would put stale work at the top.
    it('never offers a past block session as the next one', () => {
      mockWeeks = {
        data: [
          week('w-1', 1, [session('now', 'Current Work', { day_number: 1 })]),
          week('w-0', 1, [session('abandoned', 'Never Finished')], pastProgram),
        ],
        isLoading: false,
      };
      renderTraining();
      const heading = screen.getByText('Bloc Reprise').closest('section');
      expect(within(heading).getByText('Current Work')).toBeInTheDocument();
      expect(within(heading).queryByText('Never Finished')).toBeNull();
    });
  });

  it('hides archived sessions behind a toggle', () => {
    mockWeeks = {
      data: [
        week('w-1', 1, [
          session('a', 'Upper 1', { performed_at: '2026-08-18T18:00:00Z' }),
          session('gone', 'Pulled', { day_number: 3, archived_at: '2026-08-01T00:00:00Z' }),
        ]),
      ],
      isLoading: false,
    };
    mockConfirmedIds = { data: new Set(['a']) };
    renderTraining();
    expect(screen.queryByText('Pulled')).toBeNull();
    expect(screen.getByRole('button', { name: /show 1 archived/i })).toBeInTheDocument();
  });
});
