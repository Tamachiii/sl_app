import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

let mockThread = { data: [], isLoading: false, isError: false };
const mockMarkRead = { mutate: vi.fn() };
const mockDelete = { mutate: vi.fn() };

vi.mock('../../hooks/useMessages', async () => {
  const actual = await vi.importActual('../../hooks/useMessages');
  return {
    ...actual,
    useMessageThread: () => mockThread,
    useMarkThreadRead: () => mockMarkRead,
    useDeleteMessage: () => mockDelete,
    useSessionRefsForMessages: () => new Map(),
  };
});

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'me' }, role: 'coach' }),
}));

vi.mock('../../hooks/useStudents', () => ({
  useStudents: () => ({ data: [] }),
}));

vi.mock('./MessageComposer', () => ({
  default: () => <div data-testid="composer" />,
}));

import MessageThread from './MessageThread';

function renderThread() {
  return render(
    <MemoryRouter>
      <MessageThread otherProfileId="other" otherFullName="Alex" />
    </MemoryRouter>,
  );
}

describe('MessageThread read receipt', () => {
  beforeEach(() => {
    mockMarkRead.mutate.mockReset();
  });

  it('shows "Sent" under the latest outgoing message when unread', () => {
    mockThread = {
      data: [
        { id: 'm1', sender_id: 'me', recipient_id: 'other', body: 'hi', read_at: null, created_at: '2026-05-05T10:00:00Z' },
      ],
      isLoading: false,
      isError: false,
    };
    renderThread();
    expect(screen.getByText('Sent')).toBeInTheDocument();
    expect(screen.queryByText(/^Read /)).not.toBeInTheDocument();
  });

  it('shows "Read · {time}" when the latest outgoing message has read_at', () => {
    mockThread = {
      data: [
        { id: 'm1', sender_id: 'me', recipient_id: 'other', body: 'hi', read_at: '2026-05-05T10:01:00Z', created_at: '2026-05-05T10:00:00Z' },
      ],
      isLoading: false,
      isError: false,
    };
    renderThread();
    expect(screen.getByText(/^Read · /)).toBeInTheDocument();
    expect(screen.queryByText(/^Sent$/)).not.toBeInTheDocument();
  });

  it('renders the receipt only once — under the most recent outgoing message', () => {
    mockThread = {
      data: [
        { id: 'm1', sender_id: 'me', recipient_id: 'other', body: 'first', read_at: '2026-05-05T10:00:00Z', created_at: '2026-05-05T09:00:00Z' },
        { id: 'm2', sender_id: 'other', recipient_id: 'me', body: 'reply', read_at: null, created_at: '2026-05-05T09:30:00Z' },
        { id: 'm3', sender_id: 'me', recipient_id: 'other', body: 'second', read_at: null, created_at: '2026-05-05T10:00:00Z' },
      ],
      isLoading: false,
      isError: false,
    };
    renderThread();
    // Only "Sent" appears (under m3) — no "Read" caption attached to m1.
    expect(screen.getAllByText('Sent')).toHaveLength(1);
    expect(screen.queryByText(/^Read /)).not.toBeInTheDocument();
  });

  it('omits the receipt when the latest message is incoming', () => {
    mockThread = {
      data: [
        { id: 'm1', sender_id: 'other', recipient_id: 'me', body: 'reply', read_at: null, created_at: '2026-05-05T10:00:00Z' },
      ],
      isLoading: false,
      isError: false,
    };
    renderThread();
    expect(screen.queryByText('Sent')).not.toBeInTheDocument();
    expect(screen.queryByText(/^Read /)).not.toBeInTheDocument();
  });
});
