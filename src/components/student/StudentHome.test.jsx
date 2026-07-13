import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from '../../hooks/useTheme';

const mockNavigate = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'user-1' },
    profile: { full_name: 'Ada Lovelace' },
    signOut: vi.fn(),
  }),
}));

// UserMenu now mounts the NotificationBell which calls a React Query hook;
// stub it to a constant so we don't need to fake the supabase chain.
vi.mock('../../hooks/useNotifications', () => ({
  useNotifications: () => ({ data: [], isLoading: false }),
  useUnreadNotificationCount: () => ({ data: 0 }),
  useMarkNotificationRead: () => ({ mutate: vi.fn(), isPending: false }),
  useMarkAllNotificationsRead: () => ({ mutate: vi.fn(), isPending: false }),
  useNotificationsRealtime: () => {},
  describeNotification: () => ({ i18nKey: 'notifications.unknown', params: {}, path: null }),
  formatNotificationStamp: () => '',
}));

let mockWeeks = { data: null, isLoading: true };
let mockConfirmedIds = { data: new Set() };

vi.mock('../../hooks/useStudentProgramDetails', () => ({
  useStudentProgramDetails: () => mockWeeks,
}));

vi.mock('../../hooks/useSessionConfirmation', () => ({
  useMyConfirmedSessionIds: () => mockConfirmedIds,
}));

vi.mock('../../hooks/useMessages', () => ({
  useMyFeedbackSessionIds: () => ({ data: new Set() }),
}));

import StudentHome from './StudentHome';

function renderHome() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ThemeProvider>
        <MemoryRouter>
          <StudentHome />
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

const sampleWeeks = [
  {
    id: 'w-1',
    week_number: 1,
    label: 'Intro',
    sessions: [
      {
        id: 'sess-1',
        title: 'Push Day',
        day_number: 1,
        sort_order: 0,
        archived_at: null,
        exercise_slots: [
          { id: 'slot-1', sets: 3, reps: 8, weight_kg: 40, exercise: { id: 'ex-1', name: 'Bench Press' } },
        ],
      },
      { id: 'sess-2', title: 'Pull Day', day_number: 3, sort_order: 1, archived_at: null },
    ],
  },
];

describe('StudentHome', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWeeks = { data: null, isLoading: true };
    mockConfirmedIds = { data: new Set() };
  });

  it('renders the Home header', () => {
    renderHome();
    expect(screen.getByText('Home')).toBeInTheDocument();
  });

  it('shows spinner while loading', () => {
    renderHome();
    expect(screen.queryByText(/week/i)).not.toBeInTheDocument();
  });

  it('shows empty state when no weeks', () => {
    mockWeeks = { data: [], isLoading: false };
    renderHome();
    expect(screen.getByText(/no program assigned yet/i)).toBeInTheDocument();
  });

  it('renders the active week heading', () => {
    mockWeeks = { data: sampleWeeks, isLoading: false };
    renderHome();
    expect(screen.getByText(/Week 1/)).toBeInTheDocument();
  });

  it('shows the weekly adherence line for the current week', () => {
    mockWeeks = { data: sampleWeeks, isLoading: false };
    // Two sessions this week (day 1 + day 3), one confirmed.
    mockConfirmedIds = { data: new Set(['sess-1']) };
    renderHome();
    expect(screen.getByText('This week: 1/2 sessions done.')).toBeInTheDocument();
  });

  it('renders a 7-day strip with 7 cells', () => {
    mockWeeks = { data: sampleWeeks, isLoading: false };
    renderHome();
    // Day labels M T W T F S S
    const mCells = screen.getAllByText('M');
    expect(mCells.length).toBeGreaterThanOrEqual(1);
  });

  it('shows the next unconfirmed session card', () => {
    mockWeeks = { data: sampleWeeks, isLoading: false };
    renderHome();
    expect(screen.getByText('Next session')).toBeInTheDocument();
    // Earliest unconfirmed session (by weekday) becomes the Next session card.
    expect(screen.getByText('Push Day')).toBeInTheDocument();
  });

  it('renders the Next session exercise list expanded by default (no toggle)', () => {
    mockWeeks = { data: sampleWeeks, isLoading: false };
    renderHome();
    // Exercise from the Push Day slot is visible without any interaction.
    expect(screen.getByText('Bench Press')).toBeInTheDocument();
    // The Next session card is non-collapsible — no expand/collapse toggle inside the section.
    const section = screen.getByRole('region', { name: /next session/i });
    const inSection = within(section);
    expect(inSection.queryByRole('button', { expanded: true })).toBeNull();
    expect(inSection.queryByRole('button', { expanded: false })).toBeNull();
  });

  it('surfaces the next unconfirmed session when the first is confirmed', () => {
    mockWeeks = { data: sampleWeeks, isLoading: false };
    mockConfirmedIds = { data: new Set(['sess-1']) };
    renderHome();
    // Remaining unconfirmed session becomes the Next session card.
    expect(screen.getByText('Next session')).toBeInTheDocument();
    expect(screen.getByText('Pull Day')).toBeInTheDocument();
  });

  it('keeps an archived session visible in the day strip (does not flip to Rest)', () => {
    mockWeeks = {
      data: [
        {
          id: 'w-1',
          week_number: 1,
          label: 'Intro',
          sessions: [
            { id: 'sess-1', title: 'Push Day', day_number: 1, sort_order: 0, archived_at: null },
            {
              id: 'sess-arch',
              title: 'Leg 1',
              day_number: 3,
              sort_order: 1,
              archived_at: '2026-04-22T08:00:00Z',
            },
          ],
        },
      ],
      isLoading: false,
    };
    renderHome();
    // The archived session keeps its title in the day strip and is exposed as archived to AT.
    expect(screen.getByLabelText(/Leg 1 \(archived\)/i)).toBeInTheDocument();
    // The cell is disabled — no click navigates from an archived day.
    const cell = screen.getByLabelText(/Leg 1 \(archived\)/i);
    expect(cell).toBeDisabled();
  });

  it('clicking a day-strip cell navigates to that session', async () => {
    const user = userEvent.setup();
    mockWeeks = { data: sampleWeeks, isLoading: false };
    renderHome();
    // The Wednesday cell links to sess-2 (day_number 3). Its aria-label exposes the title.
    await user.click(screen.getByLabelText(/Pull Day/));
    expect(mockNavigate).toHaveBeenCalledWith('/student/session/sess-2');
  });

  describe('calendar week placement & navigation', () => {
    beforeEach(() => {
      // Freeze "today" at Thursday 2026-07-09 (current week: Mon 06 – Sun 12).
      // Only Date is faked so userEvent's real timers keep working.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(2026, 6, 9, 12, 0, 0));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    const datedWeeks = [
      {
        id: 'w-1',
        week_number: 1,
        label: 'Intro',
        sessions: [
          {
            id: 'sess-mon',
            title: 'Future Push',
            day_number: 1,
            sort_order: 0,
            archived_at: null,
            // "Week 1" session the coach dated on NEXT calendar week's Monday.
            scheduled_date: '2026-07-13',
          },
          {
            id: 'sess-fri',
            title: 'Leg Day',
            day_number: 1, // deliberately wrong weekday — the date must win
            sort_order: 1,
            archived_at: null,
            scheduled_date: '2026-07-10', // Friday of the current week
          },
        ],
      },
    ];

    it('does not bleed a next-week-dated session into the current week strip', () => {
      mockWeeks = { data: datedWeeks, isLoading: false };
      renderHome();
      // The strip's Monday cell is a rest day — Future Push lives on 13 Jul.
      expect(screen.queryByLabelText(/Future Push/)).toBeNull();
      expect(screen.getByLabelText(/^Monday 6 — rest day/)).toBeInTheDocument();
    });

    it('places a dated session on its calendar weekday, ignoring day_number', () => {
      mockWeeks = { data: datedWeeks, isLoading: false };
      renderHome();
      // Leg Day is dated Friday 10 Jul even though day_number says Monday.
      expect(screen.getByLabelText(/Friday 10 — Leg Day/)).toBeInTheDocument();
    });

    it('navigating to the next week reveals the session on its real date', async () => {
      const user = userEvent.setup();
      mockWeeks = { data: datedWeeks, isLoading: false };
      renderHome();
      await user.click(screen.getByLabelText('Next week'));
      expect(screen.getByLabelText(/Monday 13 — Future Push/)).toBeInTheDocument();
      // Cells now show next week's dates (Mon 13 … Sun 19).
      expect(screen.getByText('19')).toBeInTheDocument();
      // "Today" resets back to the current week.
      await user.click(screen.getByText('Today'));
      expect(screen.queryByLabelText(/Future Push/)).toBeNull();
    });

    it('shows the real date on the Next session card for a dated session', () => {
      mockWeeks = { data: datedWeeks, isLoading: false };
      renderHome();
      // Leg Day (Fri 10 Jul) sorts before Future Push (Mon 13 Jul) by date.
      const section = screen.getByRole('region', { name: /next session/i });
      expect(within(section).getByText('Leg Day')).toBeInTheDocument();
      expect(within(section).getByText(/Fri, Jul 10/)).toBeInTheDocument();
    });

    it('keeps undated sessions pinned to the current week only', async () => {
      const user = userEvent.setup();
      mockWeeks = { data: sampleWeeks, isLoading: false };
      renderHome();
      expect(screen.getByLabelText(/Monday 6 — Push Day/)).toBeInTheDocument();
      // Undated sessions have no calendar anchor — other weeks show rest days.
      await user.click(screen.getByLabelText('Previous week'));
      expect(screen.queryByLabelText(/Push Day/)).toBeNull();
      await user.click(screen.getByText('Today'));
      expect(screen.getByLabelText(/Monday 6 — Push Day/)).toBeInTheDocument();
    });

    it('prefers an active dated session over an archived one on the same date', () => {
      mockWeeks = {
        data: [
          {
            id: 'w-1',
            week_number: 1,
            label: null,
            sessions: [
              {
                id: 'sess-old',
                title: 'Old Push',
                day_number: 5,
                sort_order: 0,
                archived_at: '2026-07-01T08:00:00Z',
                scheduled_date: '2026-07-10',
              },
              {
                id: 'sess-new',
                title: 'New Push',
                day_number: 5,
                sort_order: 1,
                archived_at: null,
                scheduled_date: '2026-07-10',
              },
            ],
          },
        ],
        isLoading: false,
      };
      renderHome();
      // The replacement session wins the cell; the archived one doesn't shadow it.
      expect(screen.getByLabelText(/Friday 10 — New Push/)).toBeInTheDocument();
      expect(screen.queryByLabelText(/Old Push/)).toBeNull();
    });

    it("a confirmed dated session from another week never hides today's pending session", () => {
      mockWeeks = {
        data: [
          {
            id: 'w-1',
            week_number: 1,
            label: null,
            sessions: [
              {
                id: 'sess-done',
                title: 'Done Squat',
                day_number: 4,
                sort_order: 0,
                archived_at: null,
                scheduled_date: '2026-07-09', // today (Thursday)
              },
            ],
          },
          {
            id: 'w-2',
            week_number: 2,
            label: null,
            sessions: [
              // Active week (w-1 fully confirmed): undated, due Thursday.
              { id: 'sess-todo', title: 'Todo Bench', day_number: 4, sort_order: 0, archived_at: null },
            ],
          },
        ],
        isLoading: false,
      };
      mockConfirmedIds = { data: new Set(['sess-done']) };
      renderHome();
      // The pending session claims the Thursday cell and stays clickable…
      const cell = screen.getByLabelText(/Thursday 9 — Todo Bench/);
      expect(cell).toBeEnabled();
      expect(screen.queryByLabelText(/Done Squat/)).toBeNull();
      // …and the greeting still says there is a session to finish today.
      expect(screen.getByText(/session to finish today/i)).toBeInTheDocument();
    });

    it('surfaces a cross-week session dated today as the Next session', () => {
      mockWeeks = {
        data: [
          {
            id: 'w-1',
            week_number: 1,
            label: null,
            sessions: [
              {
                id: 'sess-later',
                title: 'Later Pull',
                day_number: 3,
                sort_order: 0,
                archived_at: null,
                scheduled_date: '2026-07-15', // next Wednesday — still open, week 1 stays active
              },
            ],
          },
          {
            id: 'w-2',
            week_number: 2,
            label: null,
            sessions: [
              {
                id: 'sess-today',
                title: 'Today Press',
                day_number: 4,
                sort_order: 0,
                archived_at: null,
                scheduled_date: '2026-07-09', // today
              },
            ],
          },
        ],
        isLoading: false,
      };
      renderHome();
      // The strip, greeting, and Next card must agree: today's dated session
      // comes first even though it belongs to a non-active training week.
      const section = screen.getByRole('region', { name: /next session/i });
      expect(within(section).getByText('Today Press')).toBeInTheDocument();
      expect(screen.getByText(/session to finish today/i)).toBeInTheDocument();
    });
  });
});
