import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useOutletContext, useParams } from 'react-router-dom';

// The two coach tabs that remember a place, with the pages that bounce back to
// it, under the real bottom nav: what a coach's tap on a tab ends on.

vi.mock('../../hooks/useAuth', () => ({
  useAuth: () => ({ role: 'coach', user: { id: 'me' }, profile: { full_name: 'Coach' } }),
}));
vi.mock('../../hooks/useMessages', () => ({
  useUnreadMessageCount: () => ({ data: 0 }),
}));
vi.mock('../../hooks/useStudents', () => ({
  useStudents: () => ({
    data: [{ id: 's-1', profile_id: 'p-1', created_at: null, profile: { full_name: 'Alice' } }],
    isLoading: false,
  }),
}));
vi.mock('../../hooks/useProgram', () => ({
  useCoachDashboardPrograms: () => ({ data: {} }),
  useCoachSessionPositions: () => ({ data: undefined }),
}));
vi.mock('../../hooks/useSessionConfirmation', () => ({
  useReviewInbox: () => ({ data: [], isLoading: false, isSuccess: true, fetchStatus: 'idle' }),
  useConfirmationTotals: () => ({ data: { active: 0, archived: 0 }, isLoading: false }),
  useConfirmationHistory: () => ({ data: undefined, isLoading: false, fetchStatus: 'idle' }),
  useReviewCounts: () => ({ data: {} }),
}));
vi.mock('../../hooks/useClientErrors', () => ({
  useClientErrors: () => ({ data: [] }),
}));
vi.mock('../ui/UserMenu', () => ({ default: () => null }));

import BottomNav from './BottomNav';
import CoachHome from '../coach/CoachHome';
import SessionsFeed from '../coach/SessionsFeed';

function OverviewStub() {
  const { student } = useOutletContext();
  return <div data-testid="overview">overview:{student.id}</div>;
}
function EditorStub() {
  return <div data-testid="editor">editor</div>;
}
function ReviewStub() {
  const { sessionId } = useParams();
  return <div data-testid="review">review:{sessionId}</div>;
}

function renderApp(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/coach/students" element={<CoachHome />} />
        <Route path="/coach/students/:studentId" element={<CoachHome />}>
          <Route index element={<OverviewStub />} />
          <Route path="s/:sessionId" element={<EditorStub />} />
        </Route>
        <Route path="/coach/sessions" element={<SessionsFeed />} />
        <Route path="/coach/student/:studentId/session/:sessionId/review" element={<ReviewStub />} />
        <Route path="/coach/exercises" element={<div data-testid="library">library</div>} />
        <Route path="/coach/messages" element={<div data-testid="messages">messages</div>} />
      </Routes>
      <BottomNav />
    </MemoryRouter>,
  );
}

const tab = (name) =>
  within(screen.getByRole('navigation', { name: 'Main navigation' })).getByRole('link', { name });

describe('a coach tab tapped while it is open', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  // Review item L13: the roster route opened, and CoachHome's restore sent the
  // coach straight back into the athlete they were trying to leave.
  it('Athletes, on an athlete page, shows the roster and stays there', () => {
    renderApp('/coach/students/s-1');
    expect(screen.getByTestId('overview')).toHaveTextContent('overview:s-1');

    fireEvent.click(tab(/athletes/i));
    expect(screen.queryByTestId('overview')).toBeNull();
    expect(screen.getByRole('link', { name: 'Alice' })).toBeInTheDocument();
  });

  it('Athletes, in a session editor, shows the roster too', () => {
    renderApp('/coach/students/s-1/s/sess-1');
    expect(screen.getByTestId('editor')).toBeInTheDocument();
    // The editor is a page of its own: no athlete title over it.
    expect(screen.queryByRole('heading', { level: 1 })).toBeNull();

    fireEvent.click(tab(/athletes/i));
    expect(screen.queryByTestId('editor')).toBeNull();
    expect(screen.queryByTestId('overview')).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Athletes' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Alice' })).toBeInTheDocument();
  });

  it('Sessions, on a review left open, shows the feed and stays there', () => {
    sessionStorage.setItem('sl_last_coach_session', JSON.stringify({ studentId: 's-1', sessionId: 'sess-1' }));
    renderApp('/coach/student/s-1/session/sess-1/review');
    expect(screen.getByTestId('review')).toHaveTextContent('review:sess-1');

    fireEvent.click(tab(/sessions/i));
    expect(screen.queryByTestId('review')).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Sessions' })).toBeInTheDocument();
    expect(screen.getByText('No confirmed session yet.')).toBeInTheDocument();
  });
});

describe('a coach tab tapped from another tab', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('Athletes comes back to the athlete page the coach left', () => {
    renderApp('/coach/students/s-1');
    fireEvent.click(tab(/library/i));
    expect(screen.getByTestId('library')).toBeInTheDocument();

    fireEvent.click(tab(/athletes/i));
    expect(screen.getByTestId('overview')).toHaveTextContent('overview:s-1');
  });

  // The editor is where the coach was, but not where a tab tap lands.
  it('Athletes comes back to the athlete page above an editor the coach left', () => {
    renderApp('/coach/students/s-1/s/sess-1');
    fireEvent.click(tab(/messages/i));

    fireEvent.click(tab(/athletes/i));
    expect(screen.getByTestId('overview')).toHaveTextContent('overview:s-1');
    expect(screen.queryByTestId('editor')).toBeNull();
  });

  it('Sessions comes back to the review the coach left', () => {
    sessionStorage.setItem('sl_last_coach_session', JSON.stringify({ studentId: 's-1', sessionId: 'sess-1' }));
    renderApp('/coach/student/s-1/session/sess-1/review');
    fireEvent.click(tab(/library/i));

    fireEvent.click(tab(/sessions/i));
    expect(screen.getByTestId('review')).toHaveTextContent('review:sess-1');
  });
});
