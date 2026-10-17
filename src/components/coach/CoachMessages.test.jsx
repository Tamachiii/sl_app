import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

// The coach's two message pages (design/parc/screens/MessagesCoach.dc.html,
// Conversation.dc.html): the list — its title, the search, the conversations
// and the athletes to start one with — and the header of a thread. The
// thread and the header menu have tests of their own; the list is the real
// one, so that the search is seen filtering it.
vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'coach' }, profile: { full_name: 'Coach Carter' }, signOut: vi.fn() }),
}));

let mockStudents;
vi.mock('../../hooks/useStudents', () => ({
  useStudents: () => ({ data: mockStudents }),
}));

let mockConversations;
vi.mock('../../hooks/useMessages', () => ({
  useConversations: () => ({ data: mockConversations, isLoading: false }),
  formatMessageStamp: () => '12:00',
}));
vi.mock('../ui/UserMenu', () => ({ default: () => null }));
vi.mock('../messaging/MessageThread', () => ({
  default: ({ otherProfileId, otherFullName }) => (
    <div data-testid="thread" data-other={otherProfileId} data-name={otherFullName ?? ''} />
  ),
}));

import CoachMessages from './CoachMessages';

const athlete = (id, profileId, fullName) => ({ id, profile_id: profileId, profile: { full_name: fullName } });

const conversation = (otherProfileId, otherFullName, unreadCount = 0, body = 'Hey') => ({
  otherProfileId,
  otherFullName,
  unreadCount,
  lastMessage: { id: `m-${otherProfileId}`, sender_id: otherProfileId, recipient_id: 'coach', body, created_at: 'now' },
});

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

function renderAt(path) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/coach/messages/:otherProfileId" element={<CoachMessages />} />
        <Route path="/coach/messages" element={<CoachMessages />} />
      </Routes>
      <Where />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mockStudents = [athlete('s1', 'p1', 'Alex Honnold')];
  mockConversations = [];
});

describe('CoachMessages — the list', () => {
  it('is titled "Messages" and says how many conversations hold unread messages', () => {
    mockStudents = [athlete('s1', 'p1', 'Alex Honnold'), athlete('s2', 'p2', 'Bea Kim'), athlete('s3', 'p3', 'Cy Doe')];
    mockConversations = [conversation('p1', 'Alex Honnold', 2), conversation('p2', 'Bea Kim', 0)];
    renderAt('/coach/messages');
    expect(screen.getByRole('heading', { level: 1, name: 'Messages' })).toBeInTheDocument();
    expect(screen.getByText('1 unread conversation')).toBeInTheDocument();
  });

  it('counts the unread conversations, not the unread messages', () => {
    mockStudents = [athlete('s1', 'p1', 'Alex Honnold'), athlete('s2', 'p2', 'Bea Kim')];
    mockConversations = [conversation('p1', 'Alex Honnold', 3), conversation('p2', 'Bea Kim', 1)];
    renderAt('/coach/messages');
    expect(screen.getByText('2 unread conversations')).toBeInTheDocument();
  });

  it('says "Everything read" when no conversation holds an unread message', () => {
    mockConversations = [conversation('p1', 'Alex Honnold', 0)];
    renderAt('/coach/messages');
    expect(screen.getByText('Everything read')).toBeInTheDocument();
  });

  it('says nothing about unread messages while the conversations are on their way', () => {
    mockConversations = undefined;
    renderAt('/coach/messages');
    expect(screen.queryByText('Everything read')).not.toBeInTheDocument();
    expect(screen.queryByText(/unread conversation/)).not.toBeInTheDocument();
  });

  it('waits for the athletes with a spinner', () => {
    mockStudents = undefined;
    renderAt('/coach/messages');
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
    expect(screen.queryByText('No athlete yet.')).not.toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('a coach without athletes reads "No athlete yet." and nothing else', () => {
    mockStudents = [];
    renderAt('/coach/messages');
    expect(screen.getByText('No athlete yet.')).toBeInTheDocument();
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Start a conversation' })).not.toBeInTheDocument();
  });

  it('each conversation leads to its thread', () => {
    mockConversations = [conversation('p1', 'Alex Honnold', 1)];
    renderAt('/coach/messages');
    const list = screen.getByRole('list', { name: 'Conversations' });
    expect(within(list).getByRole('link', { name: /Alex Honnold/ })).toHaveAttribute('href', '/coach/messages/p1');
  });

  it('without a conversation it points at the athletes below', () => {
    renderAt('/coach/messages');
    expect(screen.getByText('No conversation yet. Choose an athlete below to start one.')).toBeInTheDocument();
  });

  it('offers the search only when there are conversations to search', () => {
    renderAt('/coach/messages');
    expect(screen.queryByRole('searchbox')).not.toBeInTheDocument();
  });

  it('the search keeps the conversations whose name holds it', async () => {
    mockStudents = [athlete('s1', 'p1', 'Alex Honnold'), athlete('s2', 'p2', 'Bea Kim')];
    mockConversations = [conversation('p1', 'Alex Honnold'), conversation('p2', 'Bea Kim')];
    renderAt('/coach/messages');
    const search = screen.getByRole('searchbox', { name: 'Search a conversation' });
    await userEvent.type(search, 'bea');
    const list = screen.getByRole('list', { name: 'Conversations' });
    expect(within(list).getByRole('link', { name: /Bea Kim/ })).toBeInTheDocument();
    expect(within(list).queryByRole('link', { name: /Alex Honnold/ })).not.toBeInTheDocument();

    await userEvent.clear(search);
    await userEvent.type(search, 'zz');
    expect(screen.getByText('No conversation matches.')).toBeInTheDocument();
  });

  it('lists the athletes without a conversation to start one with, each leading to their thread', () => {
    mockStudents = [athlete('s1', 'p1', 'Alex Honnold'), athlete('s2', 'p2', 'Bea Kim'), athlete('s3', 'p3', '  ')];
    mockConversations = [conversation('p1', 'Alex Honnold')];
    renderAt('/coach/messages');
    const start = screen.getByRole('region', { name: 'Start a conversation' });
    const rows = within(start).getAllByRole('link');
    expect(rows).toHaveLength(2);
    expect(within(start).getByRole('link', { name: /Bea Kim/ })).toHaveAttribute('href', '/coach/messages/p2');
    // An athlete without a name is still offered, under a name that says what it is.
    expect(within(start).getByRole('link', { name: /Athlete/ })).toHaveAttribute('href', '/coach/messages/p3');
    // Alex already has a conversation: not offered twice.
    expect(within(start).queryByRole('link', { name: /Alex Honnold/ })).not.toBeInTheDocument();
  });

  // Looking for an athlete finds them, conversation or not.
  it('the search keeps the athletes to start a conversation with whose name holds it', async () => {
    mockStudents = [athlete('s1', 'p1', 'Alex Honnold'), athlete('s2', 'p2', 'Bea Kim'), athlete('s3', 'p3', 'Cy Lee')];
    mockConversations = [conversation('p1', 'Alex Honnold')];
    renderAt('/coach/messages');
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search a conversation' }), 'bea');
    expect(screen.getByText('No conversation matches.')).toBeInTheDocument();
    const start = screen.getByRole('region', { name: 'Start a conversation' });
    expect(within(start).getByRole('link', { name: /Bea Kim/ })).toBeInTheDocument();
    expect(within(start).queryByRole('link', { name: /Cy Lee/ })).not.toBeInTheDocument();
  });

  it('offers nothing to start once every athlete has a conversation', () => {
    mockConversations = [conversation('p1', 'Alex Honnold')];
    renderAt('/coach/messages');
    expect(screen.queryByRole('heading', { name: 'Start a conversation' })).not.toBeInTheDocument();
  });
});

describe('CoachMessages — a thread', () => {
  it('names the athlete and shows the thread', () => {
    renderAt('/coach/messages/p1');
    expect(screen.getByRole('heading', { level: 1, name: 'Alex Honnold' })).toBeInTheDocument();
    const thread = screen.getByTestId('thread');
    expect(thread).toHaveAttribute('data-other', 'p1');
    expect(thread).toHaveAttribute('data-name', 'Alex Honnold');
    // The list is not drawn under a thread.
    expect(screen.queryByRole('heading', { name: 'Start a conversation' })).not.toBeInTheDocument();
  });

  it('the back button is a round 44px target (review L15)', () => {
    renderAt('/coach/messages/p1');
    // pk-icon-btn is 44px wide and high: src/test/hitTargets.test.js holds it.
    expect(screen.getByRole('button', { name: 'Back to the messages' })).toHaveClass('pk-icon-btn');
  });

  it('back leads to the list of conversations', async () => {
    renderAt('/coach/messages/p1');
    await userEvent.click(screen.getByRole('button', { name: 'Back to the messages' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/coach/messages');
    expect(screen.queryByTestId('thread')).not.toBeInTheDocument();
  });

  it('the athlete’s initials lead to their page', () => {
    renderAt('/coach/messages/p1');
    const page = screen.getByRole('link', { name: 'See Alex Honnold’s page' });
    expect(page).toHaveAttribute('href', '/coach/students/s1');
    expect(page).toHaveTextContent('AH');
  });

  it('someone who is not one of the coach’s athletes is named from the conversation, without a page', () => {
    mockStudents = [];
    mockConversations = [conversation('p9', 'Former Athlete')];
    renderAt('/coach/messages/p9');
    expect(screen.getByRole('heading', { level: 1, name: 'Former Athlete' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /page/ })).not.toBeInTheDocument();
  });

  it('a counterpart nobody can name is "Conversation"', () => {
    mockStudents = [];
    renderAt('/coach/messages/unknown');
    expect(screen.getByRole('heading', { level: 1, name: 'Conversation' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /page/ })).not.toBeInTheDocument();
    expect(screen.getByTestId('thread')).toHaveAttribute('data-other', 'unknown');
  });
});
