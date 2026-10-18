import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';

// The address the page leaves, printed for the test to read.
function LocationProbe() {
  return <output data-testid="location-search">{useLocation().search}</output>;
}
const search = () => screen.getByTestId('location-search').textContent;

let mockStats = { data: null, isLoading: true };
let lastScope = null;
let mockPrograms = [];
// What the page reads its programs list and its row id from. A test replaces
// them to render the page before the list is there, or without it.
let mockProgramsQuery = null;
let mockStudentIdQuery = null;
// Every call of the two stats hooks, in order: what the page asked to be
// computed, and whether it let the read start.
let statsCalls = [];
let historyCalls = [];
// The records and the bodyweight, all-time: they moved here from the Profile.
let mockRecords = { data: [], isLoading: false };
let recordsCalls = [];
let mockBodyweight = { data: [] };

vi.mock('../../hooks/useStudentProgressStats', () => ({
  useStudentProgressStats: (studentId, scope, options) => {
    lastScope = scope;
    statsCalls.push({ studentId, scope, enabled: options?.enabled });
    return mockStats;
  },
}));

vi.mock('../../hooks/useStudentHistoricalSessions', () => ({
  useStudentHistoricalSessions: (options) => {
    historyCalls.push(options);
    return { data: [] };
  },
}));

vi.mock('../../hooks/useStudents', () => ({
  useMyStudentId: () => mockStudentIdQuery || { data: 'student-1' },
}));

vi.mock('../../hooks/useProgram', () => ({
  useProgramsForStudent: () => mockProgramsQuery || { data: mockPrograms },
}));

vi.mock('../../hooks/useStudentRecords', () => ({
  useStudentRecords: (studentRowId) => {
    recordsCalls.push(studentRowId);
    return mockRecords;
  },
}));

vi.mock('../../hooks/useBodyweight', () => ({
  useBodyweightLogs: () => mockBodyweight,
  useLogBodyweight: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({}),
}));

import StudentDashboard from './StudentDashboard';

const PREFS_KEY = 'sl_stats_prefs:self';
const EXERCISE_KEY = 'sl_stats_prefs:self:exerciseId';
const savedScope = () => JSON.parse(localStorage.getItem(PREFS_KEY) || '{}').scope;

function dashboard(initialPath) {
  return (
    <MemoryRouter initialEntries={[initialPath]}>
      <StudentDashboard />
      <LocationProbe />
    </MemoryRouter>
  );
}

function renderDashboard(initialPath = '/student/stats') {
  const view = render(dashboard(initialPath));
  // Renders the same page again, after a test changed what a hook answers.
  return { ...view, again: () => view.rerender(dashboard(initialPath)) };
}

// The scope is a group of chips named "Block" (ProgramScopeSelector): the
// chip that is pressed, and a tap on one.
const scopeGroup = () => screen.getByRole('group', { name: 'Block' });
const queryScopeGroup = () => screen.queryByRole('group', { name: 'Block' });
const pressedScope = () =>
  within(scopeGroup())
    .getAllByRole('button')
    .filter((chip) => chip.getAttribute('aria-pressed') === 'true')
    .map((chip) => chip.textContent);
const pickScope = (name) => fireEvent.click(within(scopeGroup()).getByRole('button', { name }));

// A row of the Summary list, by its label: "Sessions done", "Sets done",
// "Average RPE". Its value is at the right, its note under the label.
const summaryRow = (label) =>
  within(screen.getByRole('region', { name: 'Summary' })).getByText(label).closest('li');

// The line under the title: what the figures are of.
const subtitle = () => screen.getByRole('heading', { level: 1, name: 'Stats' }).closest('header').querySelector('p');

const sampleData = {
  totalSessions: 12,
  totalSessionsConfirmed: 5,
  totalSets: 100,
  totalSetsDone: 42,
  weeksActive: 2,
  avgRpe: 7.3,
  // A volume row is a REAL Mon–Sun week the student trained in, identified by
  // its date range — not an ordinal "W1".
  weeklyVolume: [
    {
      bucket_start: '2026-07-06',
      bucket_end: '2026-07-12',
      pull: 50,
      push: 30,
      pull_planned: 60,
      push_planned: 40,
      sets_done: 9,
      sets_prescribed: 12,
      sessions_confirmed: 3,
    },
    {
      bucket_start: '2026-07-13',
      bucket_end: '2026-07-19',
      pull: 60,
      push: 40,
      pull_planned: 60,
      push_planned: 40,
      sets_done: 12,
      sets_prescribed: 12,
      sessions_confirmed: 2,
    },
  ],
  recentConfirmations: [],
  sessionCalendar: [],
  exerciseProgress: { exercises: [], byExercise: {} },
};

const emptyData = {
  totalSessions: 0,
  totalSessionsConfirmed: 0,
  totalSets: 0,
  totalSetsDone: 0,
  weeksActive: 0,
  avgRpe: null,
  weeklyVolume: [],
  recentConfirmations: [],
  sessionCalendar: [],
  exerciseProgress: { exercises: [], byExercise: {} },
};

// A record of a lift with added load, its bodyweight unknown: the list offers
// to log it (PersonalRecords).
const RECORD = {
  exercise_id: 'e-9',
  name: 'Weighted Pull-up',
  type: 'pull',
  loadMode: 'added',
  bestE1rm: 44,
  bestE1rmWeight: 40,
  bestE1rmReps: 3,
  bestE1rmAt: '2026-07-08T12:00:00Z',
  bestReps: 3,
  bestRepsAt: '2026-07-08T12:00:00Z',
  relStrength: null,
  bwAtBest: null,
  recent: false,
};

function resetMocks() {
  vi.clearAllMocks();
  // The scope is read from localStorage during render: what one test saved
  // would be the scope of the next.
  localStorage.clear();
  lastScope = null;
  mockProgramsQuery = null;
  mockStudentIdQuery = null;
  statsCalls = [];
  historyCalls = [];
  mockRecords = { data: [], isLoading: false };
  recordsCalls = [];
  mockBodyweight = { data: [] };
  mockPrograms = [
    { id: 'p-1', name: 'Block A', is_active: true, sort_order: 0 },
    { id: 'p-2', name: 'Block B', is_active: false, sort_order: 1 },
  ];
}

describe('StudentDashboard', () => {
  beforeEach(() => {
    resetMocks();
    mockStats = { data: null, isLoading: true };
  });

  it('renders the Stats header', () => {
    mockStats = { data: sampleData, isLoading: false };
    renderDashboard();
    expect(screen.getByRole('heading', { level: 1, name: 'Stats' })).toBeInTheDocument();
  });

  it('shows a spinner while loading, under the page\'s name', () => {
    renderDashboard();
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Stats' })).toBeInTheDocument();
    expect(screen.queryByText(/summary/i)).not.toBeInTheDocument();
  });

  it('shows the records and the bodyweight without waiting for the figures of the scope', () => {
    renderDashboard();
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Records' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Bodyweight' })).toBeInTheDocument();
  });

  it('shows empty state when no program', () => {
    mockStats = { data: emptyData, isLoading: false };
    renderDashboard();
    expect(screen.getByText('No stats yet. They come with your first sessions.')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Summary' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Volume per week' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Progression' })).not.toBeInTheDocument();
  });

  it('renders summary stats', () => {
    mockStats = { data: sampleData, isLoading: false };
    renderDashboard();
    const sessions = summaryRow('Sessions done');
    expect(within(sessions).getByText('5 of 12')).toBeInTheDocument();
    expect(within(sessions).getByText(/^42\s?% done$/)).toBeInTheDocument();
    expect(within(summaryRow('Sets done')).getByText('42 of 100')).toBeInTheDocument();
    expect(within(summaryRow('Average RPE')).getByText('7.3')).toBeInTheDocument();
  });

  // English writes a percentage against its number ("42% done", as every
  // other English string of the app does); the space is French and German.
  it('writes the share of sessions done the English way', () => {
    mockStats = { data: sampleData, isLoading: false };
    renderDashboard();
    expect(within(summaryRow('Sessions done')).getByText('42% done')).toBeInTheDocument();
  });

  // "Sets done" counts the prescribed sets; the ones the athlete added are
  // said apart, where the card used to read "5 done, of 3 prescribed".
  it('says the sets the athlete added apart from the prescribed ones, and only when there are some', () => {
    mockStats = { data: { ...sampleData, totalExtraSetsDone: 3 }, isLoading: false };
    const { again } = renderDashboard();
    expect(within(summaryRow('Sets done')).getByText('42 of 100')).toBeInTheDocument();
    expect(within(summaryRow('Sets done')).getByText('3 sets added')).toBeInTheDocument();

    mockStats = { data: { ...sampleData, totalExtraSetsDone: 1 }, isLoading: false };
    again();
    expect(within(summaryRow('Sets done')).getByText('1 set added')).toBeInTheDocument();

    mockStats = { data: { ...sampleData, totalExtraSetsDone: 0 }, isLoading: false };
    again();
    expect(within(summaryRow('Sets done')).getByText('42 of 100')).toBeInTheDocument();
    expect(screen.queryByText(/added/)).not.toBeInTheDocument();
  });

  // Volume rows are labelled by the real days they cover, so a block spread
  // over more time reads as more weeks instead of collapsing into "W1".
  it('labels each volume row with its calendar date range', () => {
    // The panel's weeks run to today: today is in the second week trained.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 6, 15, 12, 0, 0));
    try {
      mockStats = { data: sampleData, isLoading: false };
      renderDashboard();
      const volume = within(screen.getByRole('region', { name: 'Volume per week' }));
      // The chart is drawn for the eye; its table says the same in words.
      expect(volume.getByText('Jul 6 – 12').tagName).toBe('TH');
      expect(volume.getByText('Jul 13 – 19').tagName).toBe('TH');
      expect(screen.queryByText(/^W1$/)).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  // B39: the panel showed the last four weeks TRAINED, whatever the scope.
  it('runs the weekly panel to this week for "all", and ends a past block at its own weeks', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 6, 29, 12, 0, 0));
    try {
      mockStats = { data: sampleData, isLoading: false };
      const { container, unmount } = renderDashboard();
      const weeks = () => [...container.querySelectorAll('[data-week]')].map((r) => r.dataset.week);
      expect(weeks()).toEqual(['2026-07-06', '2026-07-13', '2026-07-20', '2026-07-27']);
      unmount();

      // Block B is not the active block: its weeks are the ones it was trained in.
      const past = renderDashboard('/student/stats?scope=p-2');
      expect([...past.container.querySelectorAll('[data-week]')].map((r) => r.dataset.week))
        .toEqual(['2026-07-06', '2026-07-13']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not render full-weeks stat or recent-activity section', () => {
    mockStats = { data: sampleData, isLoading: false };
    renderDashboard();
    expect(screen.queryByText('Full weeks')).not.toBeInTheDocument();
    expect(screen.queryByText('Recent activity')).not.toBeInTheDocument();
  });

  it('does not render lift progression or weekly progress sections', () => {
    mockStats = { data: sampleData, isLoading: false };
    renderDashboard();
    expect(screen.queryByText('Lift progression')).not.toBeInTheDocument();
    expect(screen.queryByText('Weekly progress')).not.toBeInTheDocument();
  });

  it('shows RPE dash when no samples', () => {
    mockStats = {
      data: { ...sampleData, avgRpe: null },
      isLoading: false,
    };
    renderDashboard();
    const rpe = summaryRow('Average RPE');
    expect(within(rpe).getByText('–')).toBeInTheDocument();
    expect(within(rpe).getByText('Rate your sets to see it')).toBeInTheDocument();
  });

  it('defaults the program scope to "all" and renders the scope selector', () => {
    mockStats = { data: sampleData, isLoading: false };
    renderDashboard();
    expect(lastScope).toBe('all');
    // The block being trained, the blocks before it, then "All".
    expect(within(scopeGroup()).getAllByRole('button').map((chip) => chip.textContent))
      .toEqual(['Block A', 'Block B', 'All']);
    expect(pressedScope()).toEqual(['All']);
  });

  it('reads the scope from the ?scope= URL param', () => {
    mockStats = { data: sampleData, isLoading: false };
    renderDashboard('/student/stats?scope=p-2');
    expect(lastScope).toBe('p-2');
    expect(pressedScope()).toEqual(['Block B']);
  });

  it('presses the active block\'s chip for ?scope=active', () => {
    mockStats = { data: sampleData, isLoading: false };
    renderDashboard('/student/stats?scope=active');
    expect(lastScope).toBe('active');
    expect(pressedScope()).toEqual(['Block A']);
  });

  it('falls back to "all" when ?scope= references an unknown program', () => {
    mockStats = { data: sampleData, isLoading: false };
    renderDashboard('/student/stats?scope=ghost-program-id');
    expect(lastScope).toBe('all');
    expect(pressedScope()).toEqual(['All']);
  });

  it('switches scope and rerenders when the user picks a block', () => {
    mockStats = { data: sampleData, isLoading: false };
    renderDashboard();
    pickScope('Block B');
    expect(lastScope).toBe('p-2');
    expect(pressedScope()).toEqual(['Block B']);
    // The address names what the page shows.
    expect(search()).toBe('?scope=p-2');
  });

  it('hides the scope selector when the student has no programs', () => {
    mockPrograms = [];
    mockStats = { data: sampleData, isLoading: false };
    renderDashboard();
    expect(queryScopeGroup()).not.toBeInTheDocument();
  });

  // design/parc/screens/Stats.dc.html: the line under the title says what the
  // figures are of.
  describe('the line under the title', () => {
    beforeEach(() => {
      mockStats = { data: sampleData, isLoading: false };
    });

    it('says "All your blocks" for "all"', () => {
      renderDashboard();
      expect(subtitle()).toHaveTextContent('All your blocks');
    });

    it('names the block being trained as such, picked by its id or as "active"', () => {
      const byId = renderDashboard('/student/stats?scope=p-1');
      expect(subtitle()).toHaveTextContent('Block A, block in progress');
      byId.unmount();

      renderDashboard('/student/stats?scope=active');
      expect(subtitle()).toHaveTextContent('Block A, block in progress');
    });

    it('names a past block by its name alone', () => {
      renderDashboard('/student/stats?scope=p-2');
      expect(subtitle()).toHaveTextContent(/^Block B$/);
    });
  });
});

// « Progression »: one row per exercise of the scope, which opens its chart
// under it. It replaced the chart and its select of exercises.
describe('StudentDashboard — the progression of each exercise', () => {
  const point = (session_id, date, tonnage) => ({ session_id, key: session_id, date, tonnage });
  const progress = {
    exercises: [
      { id: 'e-1', name: 'Bench' },
      { id: 'e-2', name: 'Row' },
      { id: 'e-3', name: 'Squat' },
      { id: 'e-4', name: 'Dips' },
    ],
    byExercise: {
      // Up 240 kg on the session before.
      'e-1': [point('s-0', '2026-06-24', 700), point('s-1', '2026-07-01', 1000), point('s-2', '2026-07-08', 1240)],
      // One session: nothing to compare.
      'e-2': [point('s-1', '2026-07-01', 800)],
      // Down 150 kg.
      'e-3': [point('s-1', '2026-07-01', 2150), point('s-2', '2026-07-08', 2000)],
      // Planned in the last session and not lifted: the row speaks of the
      // session before it, and compares that one with the one before.
      'e-4': [point('s-0', '2026-06-24', 900), point('s-1', '2026-07-01', 1200), point('s-2', '2026-07-08', 0)],
    },
  };
  const rowButton = (name) =>
    within(screen.getByRole('region', { name: 'Progression' })).getByRole('button', { name: new RegExp(`^${name},`) });
  // The chart under a row says its highest tonnage in its caption.
  const chartCaption = () => screen.queryByText(/^Tonnage done:/);

  beforeEach(() => {
    resetMocks();
    mockStats = { data: { ...sampleData, exerciseProgress: progress }, isLoading: false };
  });

  it('gives each exercise a row: the tonnage of its last session, and the change on the one before', () => {
    renderDashboard();
    const bench = rowButton('Bench');
    expect(bench).toHaveTextContent('Last session, 1,240 kg lifted');
    expect(bench).toHaveTextContent('+240 kg');
    expect(rowButton('Squat')).toHaveTextContent('-150 kg');
    // A single session has no change to show.
    expect(rowButton('Row')).toHaveTextContent('Last session, 800 kg lifted');
    expect(rowButton('Row')).not.toHaveTextContent(/[+-]\d/);
    // A last session in which the exercise weighed nothing is not its last.
    expect(rowButton('Dips')).toHaveTextContent('Last session, 1,200 kg lifted');
    expect(rowButton('Dips')).toHaveTextContent('+300 kg');
    expect(rowButton('Dips')).not.toHaveTextContent(/\b0 kg/);
    // Closed, all of them.
    for (const name of ['Bench', 'Row', 'Squat', 'Dips']) {
      expect(rowButton(name)).toHaveAttribute('aria-expanded', 'false');
    }
    expect(chartCaption()).not.toBeInTheDocument();
  });

  it('opens the chart of an exercise under its row, without a select, and closes it on a second tap', () => {
    renderDashboard();
    fireEvent.click(rowButton('Bench'));

    expect(rowButton('Bench')).toHaveAttribute('aria-expanded', 'true');
    const under = rowButton('Bench').closest('li').nextElementSibling;
    expect(under).toContainElement(chartCaption());
    expect(chartCaption()).toHaveTextContent('Highest, 1,240 kg.');
    // The row chose the exercise: the chart offers no other.
    expect(screen.queryByRole('combobox', { name: 'Exercise' })).not.toBeInTheDocument();

    fireEvent.click(rowButton('Bench'));
    expect(rowButton('Bench')).toHaveAttribute('aria-expanded', 'false');
    expect(chartCaption()).not.toBeInTheDocument();
  });

  it('opens one chart at a time', () => {
    renderDashboard();
    fireEvent.click(rowButton('Bench'));
    fireEvent.click(rowButton('Squat'));
    expect(rowButton('Bench')).toHaveAttribute('aria-expanded', 'false');
    expect(rowButton('Squat')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByText(/^Tonnage done:/)).toHaveLength(1);
    expect(chartCaption()).toHaveTextContent('Highest, 2,150 kg.');
  });

  // The key the chart's select was remembered under: an athlete who had
  // picked an exercise finds it open.
  it('remembers the open exercise for the next visit, and forgets it once closed', () => {
    const first = renderDashboard();
    fireEvent.click(rowButton('Squat'));
    expect(localStorage.getItem(EXERCISE_KEY)).toBe('e-3');
    first.unmount();

    const second = renderDashboard();
    expect(rowButton('Squat')).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(rowButton('Squat'));
    expect(localStorage.getItem(EXERCISE_KEY)).toBeNull();
    second.unmount();

    renderDashboard();
    expect(chartCaption()).not.toBeInTheDocument();
  });

  it('says so when the scope has no exercise to follow', () => {
    mockStats = { data: sampleData, isLoading: false };
    renderDashboard();
    const list = within(screen.getByRole('region', { name: 'Progression' }));
    expect(list.getByText('No exercise with a load yet.')).toBeInTheDocument();
    expect(list.queryByRole('button')).not.toBeInTheDocument();
  });
});

// The records and the bodyweight moved here from the Profile. They are
// all-time: the scope does not change them.
describe('StudentDashboard — the records and the bodyweight', () => {
  beforeEach(() => {
    resetMocks();
    mockStats = { data: sampleData, isLoading: false };
    mockRecords = { data: [RECORD], isLoading: false };
    mockBodyweight = { data: [{ id: 'bw-1', weight_kg: 72.4, logged_on: '2026-07-08' }] };
  });

  it('shows the athlete\'s records and bodyweight, read for the signed-in athlete', () => {
    renderDashboard();
    expect(within(screen.getByRole('region', { name: 'Records' })).getByText('Weighted Pull-up')).toBeInTheDocument();
    const bodyweight = within(screen.getByRole('region', { name: 'Bodyweight' }));
    expect(bodyweight.getByText('72.4')).toBeInTheDocument();
    expect(bodyweight.getByRole('button', { name: 'Log my weight' })).toBeInTheDocument();
    // No athlete row id: the athlete's own records, scoped by RLS.
    expect(recordsCalls.length).toBeGreaterThan(0);
    expect(recordsCalls.every((id) => id === undefined)).toBe(true);
  });

  it('keeps them when the scope holds nothing yet', () => {
    mockStats = { data: emptyData, isLoading: false };
    renderDashboard('/student/stats?scope=p-2');
    expect(screen.getByText('No stats yet. They come with your first sessions.')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Records' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Bodyweight' })).toBeInTheDocument();
  });

  it('keeps them, the same, from one scope to the next', () => {
    renderDashboard();
    pickScope('Block B');
    expect(within(screen.getByRole('region', { name: 'Records' })).getByText('Weighted Pull-up')).toBeInTheDocument();
    expect(recordsCalls.every((id) => id === undefined)).toBe(true);
  });

  // The nudge of the records list scrolls to the bodyweight card's title,
  // which is on this page now.
  it('leads the bodyweight nudge to the bodyweight card of the page', () => {
    const scrolled = [];
    Element.prototype.scrollIntoView = function scrollIntoView() {
      scrolled.push(this);
    };
    try {
      renderDashboard();
      fireEvent.click(screen.getByRole('button', { name: /log your bodyweight/i }));
      expect(scrolled).toEqual([screen.getByRole('heading', { level: 2, name: 'Bodyweight' })]);
    } finally {
      delete Element.prototype.scrollIntoView;
    }
  });
});

// The page computes ONE scope per visit. It used to start with 'all', learn
// the saved scope from an effect, and compute that one next — two full reads,
// the first of them for nothing.
describe('StudentDashboard — the scope is known before anything is computed', () => {
  // What a query answers while it is held back: not loading, and no data.
  const heldBack = { data: undefined, isLoading: false };

  beforeEach(() => {
    resetMocks();
    mockStats = { data: sampleData, isLoading: false };
  });

  const enabledScopes = () => [...new Set(statsCalls.filter((c) => c.enabled).map((c) => c.scope))];
  const sessionsDone = () => within(summaryRow('Sessions done')).getByText('5 of 12');

  it('computes the saved block from the first render, never "all" on the way', () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ scope: 'p-2' }));
    renderDashboard();

    expect(statsCalls[0]).toEqual({ studentId: undefined, scope: 'p-2', enabled: true });
    expect(enabledScopes()).toEqual(['p-2']);
    expect(statsCalls.some((c) => c.scope === 'all')).toBe(false);
    expect(pressedScope()).toEqual(['Block B']);
  });

  it('holds the stats back until the programs list says the saved block still exists', () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ scope: 'p-2' }));
    mockProgramsQuery = { data: undefined };
    mockStats = heldBack;
    const view = renderDashboard();

    expect(statsCalls.length).toBeGreaterThan(0);
    expect(statsCalls.every((c) => c.enabled === false && c.scope === 'p-2')).toBe(true);
    // Held back is not "nothing to show": no empty state, no figures.
    expect(screen.queryByText(/no stats yet/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/summary/i)).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Stats' })).toBeInTheDocument();

    mockProgramsQuery = null;
    mockStats = { data: sampleData, isLoading: false };
    view.again();

    expect(statsCalls.at(-1)).toEqual({ studentId: undefined, scope: 'p-2', enabled: true });
    expect(enabledScopes()).toEqual(['p-2']);
    expect(sessionsDone()).toBeInTheDocument();
  });

  it('holds a ?scope=<id> back the same way', () => {
    mockProgramsQuery = { data: undefined };
    mockStats = heldBack;
    renderDashboard('/student/stats?scope=p-2');
    expect(statsCalls.every((c) => c.enabled === false)).toBe(true);
  });

  it('does not wait for the programs list to compute "all"', () => {
    mockProgramsQuery = { data: undefined };
    renderDashboard();
    expect(statsCalls[0]).toEqual({ studentId: undefined, scope: 'all', enabled: true });
    expect(sessionsDone()).toBeInTheDocument();
  });

  it('does not wait for the programs list to compute the active block', () => {
    mockProgramsQuery = { data: undefined };
    renderDashboard('/student/stats?scope=active');
    expect(statsCalls[0]).toEqual({ studentId: undefined, scope: 'active', enabled: true });
  });

  it('falls back to "all" for a saved block that is gone, without ever computing it', () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ scope: 'p-gone' }));
    mockProgramsQuery = { data: undefined };
    mockStats = heldBack;
    const view = renderDashboard();
    expect(enabledScopes()).toEqual([]);

    mockProgramsQuery = null;
    mockStats = { data: sampleData, isLoading: false };
    view.again();
    expect(enabledScopes()).toEqual(['all']);
    expect(pressedScope()).toEqual(['All']);
  });

  it('lets the URL win over the saved scope', () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ scope: 'p-2' }));
    renderDashboard('/student/stats?scope=p-1');
    expect(enabledScopes()).toEqual(['p-1']);
  });

  it('goes back to "all" when the athlete picks it after a saved block', () => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ scope: 'p-2' }));
    renderDashboard();
    expect(lastScope).toBe('p-2');

    pickScope('All');
    expect(lastScope).toBe('all');
    expect(statsCalls.at(-1).enabled).toBe(true);
    expect(pressedScope()).toEqual(['All']);
    expect(savedScope()).toBeUndefined();
    expect(search()).toBe('');
  });

  it('saves the block the athlete picks', () => {
    renderDashboard();
    pickScope('Block B');
    expect(savedScope()).toBe('p-2');
    expect(statsCalls.at(-1)).toEqual({ studentId: undefined, scope: 'p-2', enabled: true });
  });

  // A list that failed or is paused is not coming: waiting for it would leave
  // the page on its spinner for as long as it stays away.
  it.each([
    ['the programs list failed', () => { mockProgramsQuery = { data: undefined, isError: true }; }],
    ['the programs list is paused', () => { mockProgramsQuery = { data: undefined, isPaused: true }; }],
    ['the athlete row failed', () => {
      mockStudentIdQuery = { data: undefined, isError: true };
      mockProgramsQuery = { data: undefined };
    }],
    ['the athlete row is paused', () => {
      mockStudentIdQuery = { data: undefined, isPaused: true };
      mockProgramsQuery = { data: undefined };
    }],
  ])('computes "all" for a saved block when %s', (_name, arrange) => {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ scope: 'p-2' }));
    arrange();
    renderDashboard();
    expect(statsCalls.at(-1)).toEqual({ studentId: undefined, scope: 'all', enabled: true });
    expect(sessionsDone()).toBeInTheDocument();
  });

  describe('history overlay', () => {
    it('is not read for "all"', () => {
      renderDashboard();
      expect(historyCalls.length).toBeGreaterThan(0);
      expect(historyCalls.every((o) => o?.enabled === false)).toBe(true);
    });

    it('is not read for a single block, saved or in the URL', () => {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ scope: 'p-2' }));
      renderDashboard();
      expect(historyCalls.every((o) => o?.enabled === false)).toBe(true);
    });

    it('is not read while the scope is still unknown', () => {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ scope: 'p-2' }));
      mockProgramsQuery = { data: undefined };
      mockStats = heldBack;
      renderDashboard();
      expect(historyCalls.every((o) => o?.enabled === false)).toBe(true);
    });

    it('is read for the active block, the one scope that draws it', () => {
      renderDashboard('/student/stats?scope=active');
      expect(historyCalls.length).toBeGreaterThan(0);
      expect(historyCalls.every((o) => o?.enabled === true)).toBe(true);
    });
  });
});

// N4 of the live review: changing the scope replaced the whole page, selector
// included, with a spinner — 3 s of nothing on the gym's 4G.
describe('StudentDashboard — changing the scope keeps the page', () => {
  beforeEach(() => {
    resetMocks();
    mockRecords = { data: [RECORD], isLoading: false };
    mockBodyweight = { data: [{ id: 'bw-1', weight_kg: 72.4, logged_on: '2026-07-08' }] };
  });

  // What the hook answers between two scopes: the figures of the scope that
  // was on screen, flagged as a stand-in.
  const standIn = { data: sampleData, isLoading: false, isPlaceholderData: true };
  const sessionsDone = () => within(summaryRow('Sessions done')).getByText('5 of 12');
  // Whether an element is inside a part of the page marked as on its way out.
  const busyParts = (container) => [...container.querySelectorAll('[aria-busy="true"]')];
  const isBusy = (container, element) => busyParts(container).some((part) => part.contains(element));

  it('keeps the header, the selector and the figures while the new scope loads', () => {
    mockStats = standIn;
    renderDashboard('/student/stats?scope=p-2');

    // The page's own header, not the bare one of the loading state.
    const title = screen.getByRole('heading', { level: 1, name: 'Stats' });
    expect(title).not.toHaveClass('sr-only');
    expect(subtitle()).toHaveTextContent('Block B');
    // The selector already shows the choice that was just made.
    expect(pressedScope()).toEqual(['Block B']);
    expect(sessionsDone()).toBeInTheDocument();
  });

  it('marks the outgoing figures as busy, and only them', () => {
    mockStats = standIn;
    const { container } = renderDashboard('/student/stats?scope=p-2');

    const busy = busyParts(container);
    expect(busy.length).toBeGreaterThan(0);
    expect(isBusy(container, sessionsDone())).toBe(true);
    expect(isBusy(container, screen.getByRole('region', { name: 'Volume per week' }))).toBe(true);
    for (const part of busy) expect(part).toHaveClass('opacity-50');
    // The control that changes the scope is not dimmed with them.
    expect(isBusy(container, scopeGroup())).toBe(false);
  });

  // They are all-time: nothing of them is on its way out. Dimmed, the button
  // that logs a weight reads as disabled while it is not.
  it('does not mark the records and the bodyweight as busy', () => {
    mockStats = standIn;
    const { container } = renderDashboard('/student/stats?scope=p-2');
    expect(isBusy(container, screen.getByRole('region', { name: 'Records' }))).toBe(false);
    expect(isBusy(container, screen.getByRole('region', { name: 'Bodyweight' }))).toBe(false);
  });

  it('marks nothing as busy once the figures are the scope\'s own', () => {
    mockStats = { data: sampleData, isLoading: false, isPlaceholderData: false };
    const { container } = renderDashboard('/student/stats?scope=p-2');
    expect(container.querySelector('[aria-busy]')).toBeNull();
    expect(container.querySelector('.opacity-50')).toBeNull();
    expect(sessionsDone()).toBeInTheDocument();
  });

  it('still opens on a spinner when there is nothing to keep', () => {
    mockStats = { data: undefined, isLoading: true, isPlaceholderData: false };
    const { container } = renderDashboard();
    expect(queryScopeGroup()).not.toBeInTheDocument();
    expect(container.querySelector('[aria-busy]')).toBeNull();
  });
});

// B41: the selector offers the active block by its id, so a block picked as
// "the one I am training" stayed on screen after the coach made the next one
// active — "I trained yesterday and Stats doesn't show it".
describe('StudentDashboard — a saved block, and a new block made active since', () => {
  const heldBack = { data: undefined, isLoading: false };
  const before = [
    { id: 'p-1', name: 'Block A', is_active: true, sort_order: 0 },
    { id: 'p-2', name: 'Block B', is_active: false, sort_order: 1 },
  ];
  // The coach has made Block C active since.
  const later = [
    { id: 'p-1', name: 'Block A', is_active: false, sort_order: 0 },
    { id: 'p-2', name: 'Block B', is_active: false, sort_order: 1 },
    { id: 'p-3', name: 'Block C', is_active: true, sort_order: 2 },
  ];
  const save = (prefs) => localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  const saved = () => JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
  const enabledScopes = () => [...new Set(statsCalls.filter((c) => c.enabled).map((c) => c.scope))];

  beforeEach(() => {
    resetMocks();
    mockStats = { data: sampleData, isLoading: false };
    mockPrograms = later;
  });

  it('shows every program, and forgets the block, when it was picked as the active one', () => {
    save({ scope: 'p-1', activeBlock: 'p-1' });
    renderDashboard();
    expect(enabledScopes()).toEqual(['all']);
    expect(pressedScope()).toEqual(['All']);
    expect(saved()).toEqual({});
    expect(search()).toBe('');
  });

  it('does the same for a past block picked while another block was active', () => {
    save({ scope: 'p-2', activeBlock: 'p-1' });
    renderDashboard();
    expect(enabledScopes()).toEqual(['all']);
    expect(saved()).toEqual({});
  });

  // The address used to be written at mount, before the list could say the
  // block was replaced — and the address wins over what was saved.
  it('decides once the list is there, and the block never reaches the address first', () => {
    save({ scope: 'p-1', activeBlock: 'p-1' });
    mockProgramsQuery = { data: undefined };
    mockStats = heldBack;
    const view = renderDashboard();
    expect(statsCalls.every((c) => c.enabled === false)).toBe(true);
    expect(search()).toBe('');

    mockProgramsQuery = null;
    mockStats = { data: sampleData, isLoading: false };
    view.again();
    expect(enabledScopes()).toEqual(['all']);
    expect(search()).toBe('');
    expect(saved()).toEqual({});
  });

  it('keeps the active block while it is still the active one, and names it in the address once known', () => {
    mockPrograms = before;
    save({ scope: 'p-1', activeBlock: 'p-1' });
    renderDashboard();
    expect(enabledScopes()).toEqual(['p-1']);
    expect(search()).toBe('?scope=p-1');
    expect(saved()).toEqual({ scope: 'p-1', activeBlock: 'p-1' });
  });

  it('keeps a past block while the block active when it was picked is still the active one', () => {
    mockPrograms = before;
    save({ scope: 'p-2', activeBlock: 'p-1' });
    renderDashboard();
    expect(enabledScopes()).toEqual(['p-2']);
  });

  it('keeps a block the address names', () => {
    save({ scope: 'p-1', activeBlock: 'p-1' });
    renderDashboard('/student/stats?scope=p-1');
    expect(enabledScopes()).toEqual(['p-1']);
    expect(saved()).toEqual({ scope: 'p-1', activeBlock: 'p-1' });
  });

  it('keeps a block saved by the app before, and gives it the active block for next time', () => {
    mockPrograms = before;
    save({ scope: 'p-2' });
    renderDashboard();
    expect(enabledScopes()).toEqual(['p-2']);
    expect(saved()).toEqual({ scope: 'p-2', activeBlock: 'p-1' });
  });

  it('computes "all" without the list, and forgets nothing', () => {
    save({ scope: 'p-1', activeBlock: 'p-1' });
    mockProgramsQuery = { data: undefined, isError: true };
    renderDashboard();
    expect(enabledScopes()).toEqual(['all']);
    expect(saved()).toEqual({ scope: 'p-1', activeBlock: 'p-1' });
    expect(search()).toBe('');
  });

  it('saves the active block with the one picked, and lets go of it when the next block is made active', () => {
    mockPrograms = before;
    const first = renderDashboard();
    pickScope('Block A');
    expect(saved()).toEqual({ scope: 'p-1', activeBlock: 'p-1' });
    first.unmount();

    mockPrograms = later;
    statsCalls = [];
    renderDashboard();
    expect(enabledScopes()).toEqual(['all']);
    expect(pressedScope()).toEqual(['All']);
  });
});
