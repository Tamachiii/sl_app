import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Outlet } from 'react-router-dom';

vi.mock('../messaging/MessageThread', () => ({
  default: ({ otherProfileId, otherFullName }) => (
    <div data-testid="message-thread" data-other-profile={otherProfileId} data-other-name={otherFullName} />
  ),
}));

import StudentMessagingSection from './StudentMessagingSection';

function renderUnderOutlet(student, route = '/') {
  function Layout() {
    return <Outlet context={{ student }} />;
  }
  return render(
    <MemoryRouter initialEntries={[route]}>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<StudentMessagingSection />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('StudentMessagingSection', () => {
  it('mounts the message thread for the student\'s profile id', () => {
    renderUnderOutlet({
      id: 's-1',
      profile_id: 'p-1',
      profile: { full_name: 'Alice Brown' },
    });
    const thread = screen.getByTestId('message-thread');
    expect(thread).toHaveAttribute('data-other-profile', 'p-1');
    expect(thread).toHaveAttribute('data-other-name', 'Alice Brown');
  });

  it('shows an empty state if the student is not linked to a profile', () => {
    renderUnderOutlet({ id: 's-1', profile_id: null, profile: { full_name: 'Bob' } });
    expect(screen.queryByTestId('message-thread')).not.toBeInTheDocument();
    expect(screen.getByText(/isn['’]t linked yet/i)).toBeInTheDocument();
  });
});
