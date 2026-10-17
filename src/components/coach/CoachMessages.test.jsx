import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

// The coach's thread page: its back button. The thread, the list and the
// header menu have tests of their own.
vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({ profile: { full_name: 'Coach Carter' }, signOut: vi.fn() }),
}));
vi.mock('../../hooks/useStudents', () => ({
  useStudents: () => ({ data: [{ id: 's1', profile_id: 'p1', profile: { full_name: 'Alex Honnold' } }] }),
}));
vi.mock('../../hooks/useMessages', () => ({
  useConversations: () => ({ data: [] }),
}));
vi.mock('../ui/UserMenu', () => ({ default: () => null }));
vi.mock('../messaging/MessageThread', () => ({ default: () => <div data-testid="thread" /> }));
vi.mock('../messaging/ConversationList', () => ({ default: () => null }));

import CoachMessages from './CoachMessages';

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

function renderThreadPage() {
  render(
    <MemoryRouter initialEntries={['/coach/messages/p1']}>
      <Routes>
        <Route path="/coach/messages/:otherProfileId" element={<CoachMessages />} />
        <Route path="/coach/messages" element={<CoachMessages />} />
      </Routes>
      <Where />
    </MemoryRouter>,
  );
}

describe('CoachMessages — a thread', () => {
  it('names the athlete and shows the thread', () => {
    renderThreadPage();
    expect(screen.getByText('Alex Honnold')).toBeInTheDocument();
    expect(screen.getByTestId('thread')).toBeInTheDocument();
  });

  it('the back button is a 44px target (review L15)', () => {
    renderThreadPage();
    const back = screen.getByRole('button', { name: 'Back' });
    expect(back).toHaveClass('w-11', 'h-11', 'shrink-0');
    expect(back).not.toHaveClass('w-9');
  });

  it('back leads to the list of conversations', async () => {
    renderThreadPage();
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByTestId('where')).toHaveTextContent('/coach/messages');
    expect(screen.queryByTestId('thread')).not.toBeInTheDocument();
  });
});
