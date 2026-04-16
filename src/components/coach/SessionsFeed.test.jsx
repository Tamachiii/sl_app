import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

let mockConfirmations = { data: [], isLoading: false };

vi.mock('../../hooks/useSessionConfirmation', () => ({
  useAllConfirmations: () => mockConfirmations,
}));

import SessionsFeed from './SessionsFeed';

function renderFeed() {
  return render(
    <MemoryRouter>
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
    expect(screen.getByText('Alice')).toBeInTheDocument();
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

  it('displays student notes on the card', () => {
    mockConfirmations = {
      data: [makeConfirmation({ notes: 'Felt really strong today' })],
      isLoading: false,
    };
    renderFeed();
    expect(screen.getByText('Felt really strong today')).toBeInTheDocument();
  });
});
