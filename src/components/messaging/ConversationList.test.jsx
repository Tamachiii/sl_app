import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
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

const ALICE = {
  otherProfileId: 's1',
  otherFullName: 'Alice',
  unreadCount: 3,
  lastMessage: { id: 'm1', sender_id: 's1', recipient_id: 'me', body: 'Hey', created_at: 'now' },
};
const BOB = {
  otherProfileId: 's2',
  otherFullName: 'Bob',
  unreadCount: 0,
  lastMessage: { id: 'm2', sender_id: 'me', recipient_id: 's2', body: 'Reply', created_at: 'now' },
};

function renderList(props = {}) {
  return render(
    <MemoryRouter>
      <ConversationList linkBuilder={(c) => `/coach/messages/${c.otherProfileId}`} {...props} />
    </MemoryRouter>,
  );
}

describe('ConversationList', () => {
  beforeEach(() => {
    mockAuth = { user: { id: 'me' } };
  });

  it('waits for the conversations with a spinner', () => {
    mockConversations = { data: undefined, isLoading: true };
    renderList();
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('renders an empty state when there are no conversations', () => {
    mockConversations = { data: [], isLoading: false };
    renderList({ emptyMessage: 'None yet' });
    expect(screen.getByText('None yet')).toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('says "No conversation yet." when the page gives no empty message', () => {
    mockConversations = { data: [], isLoading: false };
    renderList();
    expect(screen.getByText('No conversation yet.')).toBeInTheDocument();
  });

  it('renders one row per conversation, named "Conversations", each a link to its thread', () => {
    mockConversations = { data: [ALICE, BOB], isLoading: false };
    renderList();

    const list = screen.getByRole('list', { name: 'Conversations' });
    const rows = within(list).getAllByRole('link');
    expect(rows).toHaveLength(2);
    expect(within(list).getByRole('link', { name: /Alice/ })).toHaveAttribute('href', '/coach/messages/s1');
    expect(within(list).getByRole('link', { name: /Bob/ })).toHaveAttribute('href', '/coach/messages/s2');
    // The name, the time of the last message and the message itself.
    expect(rows[0]).toHaveTextContent('Alice');
    expect(rows[0]).toHaveTextContent('12:00');
    expect(rows[0]).toHaveTextContent('Hey');
  });

  it('counts the unread messages of a conversation, and says so', () => {
    mockConversations = { data: [ALICE, BOB], isLoading: false };
    renderList();

    const alice = screen.getByRole('link', { name: /Alice/ });
    expect(within(alice).getByText('3')).toBeInTheDocument();
    expect(within(alice).getByText('3 unread messages')).toHaveClass('sr-only');
    // Bob has zero unread → no count.
    const bob = screen.getByRole('link', { name: /Bob/ });
    expect(within(bob).queryByText(/unread/i)).not.toBeInTheDocument();
    expect(bob.querySelector('.pk-count')).toBeNull();
  });

  it('one unread message is "1 unread message"', () => {
    mockConversations = { data: [{ ...ALICE, unreadCount: 1 }], isLoading: false };
    renderList();
    expect(screen.getByText('1 unread message')).toBeInTheDocument();
  });

  it('writes the last message in ink and semibold while it is unread', () => {
    mockConversations = { data: [ALICE, { ...BOB, lastMessage: { ...BOB.lastMessage, sender_id: 's2', recipient_id: 'me' } }], isLoading: false };
    renderList();
    expect(screen.getByText('Hey')).toHaveClass('font-semibold', 'text-ink');
    expect(screen.getByText('Reply')).not.toHaveClass('font-semibold');
    expect(screen.getByText('Reply')).toHaveClass('text-ink-2');
  });

  it('prefixes "You:" on outgoing messages in the preview', () => {
    mockConversations = { data: [BOB], isLoading: false };
    renderList();
    expect(screen.getByText(/You:\s+Reply/i)).toBeInTheDocument();
  });

  it('an incoming message has no prefix', () => {
    mockConversations = { data: [ALICE], isLoading: false };
    renderList();
    expect(screen.queryByText(/You:/)).not.toBeInTheDocument();
  });

  it('names a counterpart without a name "Conversation"', () => {
    mockConversations = { data: [{ ...BOB, otherFullName: '  ' }], isLoading: false };
    renderList();
    expect(screen.getByRole('link', { name: /^Conversation/ })).toHaveAttribute('href', '/coach/messages/s2');
  });

  describe('query', () => {
    it('keeps the conversations whose name holds it, whatever its case and spaces', () => {
      mockConversations = { data: [ALICE, BOB], isLoading: false };
      renderList({ query: '  aLi ' });
      const list = screen.getByRole('list', { name: 'Conversations' });
      expect(within(list).getAllByRole('link')).toHaveLength(1);
      expect(within(list).getByRole('link', { name: /Alice/ })).toBeInTheDocument();
    });

    it('says "No conversation matches." when none does', () => {
      mockConversations = { data: [ALICE, BOB], isLoading: false };
      renderList({ query: 'zoe', emptyMessage: 'None yet' });
      expect(screen.getByText('No conversation matches.')).toBeInTheDocument();
      expect(screen.queryByRole('list')).not.toBeInTheDocument();
      // Not the empty state: there are conversations, none of them matches.
      expect(screen.queryByText('None yet')).not.toBeInTheDocument();
    });
  });
});
