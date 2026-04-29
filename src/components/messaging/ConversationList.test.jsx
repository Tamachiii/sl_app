import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

let mockConversations = { data: [], isLoading: false };
let mockAuth = { user: { id: 'me' } };

vi.mock('../../hooks/useMessages', () => ({
  useConversations: () => mockConversations,
  formatMessageStamp: () => '12:00',
}));

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => mockAuth,
}));

import ConversationList from './ConversationList';

describe('ConversationList', () => {
  beforeEach(() => {
    mockAuth = { user: { id: 'me' } };
  });

  it('renders an empty state when there are no conversations', () => {
    mockConversations = { data: [], isLoading: false };
    render(
      <MemoryRouter>
        <ConversationList linkBuilder={(c) => `/x/${c.otherProfileId}`} emptyMessage="None yet" />
      </MemoryRouter>,
    );
    expect(screen.getByText('None yet')).toBeInTheDocument();
  });

  it('renders one row per conversation with name + unread badge', () => {
    mockConversations = {
      data: [
        {
          otherProfileId: 's1',
          otherFullName: 'Alice',
          unreadCount: 3,
          lastMessage: { id: 'm1', sender_id: 's1', recipient_id: 'me', body: 'Hey', created_at: 'now' },
        },
        {
          otherProfileId: 's2',
          otherFullName: 'Bob',
          unreadCount: 0,
          lastMessage: { id: 'm2', sender_id: 'me', recipient_id: 's2', body: 'Reply', created_at: 'now' },
        },
      ],
      isLoading: false,
    };
    render(
      <MemoryRouter>
        <ConversationList linkBuilder={(c) => `/coach/messages/${c.otherProfileId}`} />
      </MemoryRouter>,
    );

    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    // Bob has zero unread → no badge.
    expect(screen.queryByLabelText(/0 unread/i)).not.toBeInTheDocument();

    const aliceLink = screen.getByText('Alice').closest('a');
    expect(aliceLink).toHaveAttribute('href', '/coach/messages/s1');
  });

  it('prefixes "You:" on outgoing messages in the preview', () => {
    mockConversations = {
      data: [{
        otherProfileId: 's1',
        otherFullName: 'Alice',
        unreadCount: 0,
        lastMessage: { id: 'm1', sender_id: 'me', recipient_id: 's1', body: 'Reply', created_at: 'now' },
      }],
      isLoading: false,
    };
    render(
      <MemoryRouter>
        <ConversationList linkBuilder={(c) => `/x/${c.otherProfileId}`} />
      </MemoryRouter>,
    );
    expect(screen.getByText(/You:\s+Reply/i)).toBeInTheDocument();
  });
});
