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

  // The training week is no longer a thing the student is "in": the block is
  // an ordered queue and the strip is a record of real days, so naming an
  // ordinal week beside real dates would only invite the old mental model back.
  it('does not label the strip with a training week number', () => {
    mockWeeks = { data: sampleWeeks, isLoading: false };
    renderHome();
    expect(screen.getByLabelText('Week overview')).not.toHaveTextContent(/Week\s*1/);
  });

  it('does not repeat the week, day or a rest-day line in the greeting', () => {
    mockWeeks = { data: sampleWeeks, isLoading: false };
    renderHome();
    expect(screen.queryByText(/day off/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/session to finish today/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Hey,/)).toBeInTheDocument();
  });

  // Adherence measured the student against a calendar the plan no longer
  // imposes. The greeting now states what they DID, from the real training
  // dates, and says so honestly when there is nothing to state.
  it('shows the activity line from real training dates', () => {
    const twoDaysAgo = new Date();
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
    mockWeeks = {
      data: [
        {
          id: 'w-1',
          week_number: 1,
          label: null,
          sessions: [
            {
              id: 'sess-1',
              title: 'Push Day',
              day_number: 1,
              sort_order: 0,
              archived_at: null,
              performed_at: twoDaysAgo.toISOString(),
            },
            { id: 'sess-2', title: 'Pull Day', day_number: 3, sort_order: 1, archived_at: null },
          ],
        },
      ],
      isLoading: false,
    };
    mockConfirmedIds = { data: new Set(['sess-1']) };
    renderHome();
    expect(screen.getByText(/2 days ago/)).toBeInTheDocument();
    expect(screen.getByText(/1 session in the last 7 days/)).toBeInTheDocument();
  });

  it('says so plainly when nothing has been trained yet', () => {
    mockWeeks = { data: sampleWeeks, isLoading: false };
    renderHome();
    expect(screen.getByText('No sessions logged yet')).toBeInTheDocument();
  });

  // "Session 7 of 24" replaces the week number as the sense of place: it is
  // position in the block, which is exactly what the queue model promises.
  it('shows the position of the next session in the block', () => {
    mockWeeks = { data: sampleWeeks, isLoading: false };
    mockConfirmedIds = { data: new Set(['sess-1']) };
    renderHome();
    expect(screen.getByText('Session 2 of 2')).toBeInTheDocument();
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
      // The strip is a RECORD of days, so Thursday shows the session actually
      // trained on Thursday — a pending session's recommended weekday can't
      // overwrite it.
      expect(screen.getByLabelText(/Thursday 9 — Done Squat/)).toBeInTheDocument();
      // The guarantee that used to live on the strip cell now lives in the
      // queue, where it belongs: pending work is never hidden, it is the
      // headline. (This is what stops a busy calendar from burying it.)
      const section = screen.getByRole('region', { name: /next session/i });
      expect(within(section).getByText('Todo Bench')).toBeInTheDocument();
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
      // PROGRAM ORDER decides what is next — a date never jumps the queue.
      // This is the behaviour change the whole refactor turns on: a
      // recommended date is advice, so a later-week session dated today does
      // not push past work the student hasn't done yet. It stays reachable on
      // the strip, where its real date still places it.
      const section = screen.getByRole('region', { name: /next session/i });
      expect(within(section).getByText('Later Pull')).toBeInTheDocument();
      expect(within(section).queryByText('Today Press')).toBeNull();
      expect(screen.getByLabelText(/Thursday 9 — Today Press/)).toBeInTheDocument();
    });
  });
});
