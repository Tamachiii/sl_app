import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

let mockConfirmations = { data: [], isLoading: false };

vi.mock('../../hooks/useSessionConfirmation', () => ({
  useAllConfirmations: () => mockConfirmations,
}));

import SessionsFeed from './SessionsFeed';

function renderFeed(initialEntries = ['/coach/sessions']) {
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <SessionsFeed />
    </MemoryRouter>
  );
}

const makeConfirmation = (overrides = {}) => ({
  id: 'c-1',
  session_id: 'sess-1',
  student_id: 's-1',
  student_name: 'Alice',
  session_title: 'Push Day',
  day_number: 1,
  week_number: 1,
  week_label: null,
  confirmed_at: '2026-04-16T10:00:00Z',
  archived_at: null,
  notes: null,
  ...overrides,
});

describe('SessionsFeed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfirmations = { data: [], isLoading: false };
    localStorage.clear();
  });

  it('renders loading spinner', () => {
    mockConfirmations = { data: undefined, isLoading: true };
    renderFeed();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('renders empty state when no confirmations', () => {
    renderFeed();
    expect(screen.getByText(/no confirmed sessions yet/i)).toBeInTheDocument();
  });

  it('renders a confirmation card with student name and session title', () => {
    mockConfirmations = { data: [makeConfirmation()], isLoading: false };
    renderFeed();
    expect(screen.getAllByText('Alice').length).toBeGreaterThan(0);
    expect(screen.getByText('Push Day')).toBeInTheDocument();
  });

  it('shows archived toggle button when archived sessions exist', async () => {
    const user = userEvent.setup();
    mockConfirmations = {
      data: [
        makeConfirmation({ id: 'c-1', archived_at: '2026-04-16T12:00:00Z', session_title: 'Archived Session' }),
      ],
      isLoading: false,
    };
    renderFeed();
    expect(screen.getByRole('button', { name: /show.*archived/i })).toBeInTheDocument();
    expect(screen.queryByText('Archived Session')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /show.*archived/i }));
    expect(screen.getByText('Archived Session')).toBeInTheDocument();
  });

  it('filters cards by selected student', async () => {
    const user = userEvent.setup();
    mockConfirmations = {
      data: [
        makeConfirmation({ id: 'c-1', session_id: 's-a', student_id: 's-1', student_name: 'Alice', session_title: 'Alice Push' }),
        makeConfirmation({ id: 'c-2', session_id: 's-b', student_id: 's-2', student_name: 'Bob', session_title: 'Bob Pull' }),
      ],
      isLoading: false,
    };
    renderFeed();
    expect(screen.getByText('Alice Push')).toBeInTheDocument();
    expect(screen.getByText('Bob Pull')).toBeInTheDocument();

    await user.selectOptions(screen.getByRole('combobox'), 's-1');
    expect(screen.getByText('Alice Push')).toBeInTheDocument();
    expect(screen.queryByText('Bob Pull')).not.toBeInTheDocument();
  });

  it('displays student notes on the card', () => {
    mockConfirmations = {
      data: [makeConfirmation({ notes: 'Felt really strong today' })],
      isLoading: false,
    };
    renderFeed();
    expect(screen.getByText('Felt really strong today')).toBeInTheDocument();
  });

  it('defaults to the needs-review inbox: reviewed cards are hidden until "All"', async () => {
    const user = userEvent.setup();
    mockConfirmations = {
      data: [
        makeConfirmation({ id: 'c-r', session_id: 's-r', session_title: 'Pulled', reviewed_at: '2026-04-30T09:00:00Z' }),
        makeConfirmation({ id: 'c-u', session_id: 's-u', session_title: 'Pushed' }),
      ],
      isLoading: false,
    };
    renderFeed();
    // Default view is the inbox: only the unreviewed confirmation shows,
    // and the Needs-review pill carries the pending count.
    expect(screen.getByText('Pushed')).toBeInTheDocument();
    expect(screen.queryByText('Pulled')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /needs review · 1/i })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^all$/i }));
    expect(screen.getByText('Pulled')).toBeInTheDocument();
    expect(screen.getByText('Pushed')).toBeInTheDocument();
  });

  it('a ?student= deep link (profile "View sessions") defaults to All, not the inbox', () => {
    mockConfirmations = {
      data: [
        makeConfirmation({ id: 'c-r', session_id: 's-r', session_title: 'Pulled', reviewed_at: '2026-04-30T09:00:00Z' }),
      ],
      isLoading: false,
    };
    renderFeed(['/coach/sessions?student=s-1']);
    // History-browsing gesture: the reviewed card must be visible immediately
    // instead of an "all caught up" empty state.
    expect(screen.getByText('Pulled')).toBeInTheDocument();
  });

  it('shows an all-caught-up empty state when every confirmation is reviewed', () => {
    mockConfirmations = {
      data: [
        makeConfirmation({ id: 'c-r', session_id: 's-r', session_title: 'Pulled', reviewed_at: '2026-04-30T09:00:00Z' }),
      ],
      isLoading: false,
    };
    renderFeed();
    expect(screen.getByText(/all caught up/i)).toBeInTheDocument();
    expect(screen.queryByText('Pulled')).not.toBeInTheDocument();
  });

  it('shows a "Reviewed" pill on cards whose session has been reviewed', async () => {
    const user = userEvent.setup();
    mockConfirmations = {
      data: [
        makeConfirmation({ id: 'c-r', session_id: 's-r', student_name: 'Reviewed Rita', session_title: 'Pulled', reviewed_at: '2026-04-30T09:00:00Z' }),
        makeConfirmation({ id: 'c-u', session_id: 's-u', student_name: 'Unreviewed Una', session_title: 'Pushed' }),
      ],
      isLoading: false,
    };
    renderFeed();
    // Reviewed cards live behind the "All" filter.
    await user.click(screen.getByRole('button', { name: /^all$/i }));
    // One pill, on the reviewed card only.
    const pills = screen.getAllByText(/^Reviewed$/i);
    expect(pills).toHaveLength(1);
    // The pill is inside the same card link as the reviewed session.
    const reviewedCard = screen.getByText('Pulled').closest('a');
    expect(reviewedCard).toContainElement(pills[0]);
    const unreviewedCard = screen.getByText('Pushed').closest('a');
    expect(unreviewedCard).not.toContainElement(pills[0]);
  });
});
