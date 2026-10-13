import { describe, it, expect, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HashRouter, Link, MemoryRouter, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useBackOr } from './useBackOr';

// A page with a back button, as the screens write it, and what a test needs
// to see around it: where the router is, and the system's own "back".
function Page({ fallback = '/student' }) {
  const goBack = useBackOr(fallback);
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <>
      <p data-testid="path">{location.pathname}</p>
      <button type="button" onClick={goBack}>
        Back
      </button>
      <button type="button" onClick={() => navigate(-1)}>
        System back
      </button>
      <Link to="/student/session/1">Open session</Link>
    </>
  );
}

const path = () => screen.getByTestId('path').textContent;
const back = () => fireEvent.click(screen.getByRole('button', { name: 'Back' }));
const systemBack = () => fireEvent.click(screen.getByRole('button', { name: 'System back' }));

describe('useBackOr, in a router that keeps its own history (MemoryRouter)', () => {
  const renderAt = (initialEntries, initialIndex, fallback) =>
    render(
      <MemoryRouter initialEntries={initialEntries} initialIndex={initialIndex}>
        <Routes>
          <Route path="*" element={<Page fallback={fallback} />} />
        </Routes>
      </MemoryRouter>,
    );

  it('goes to the fallback from the first entry, where "back" has nowhere to go', () => {
    renderAt(['/student/session/1']);
    back();
    expect(path()).toBe('/student');
  });

  it('replaces the entry: the system\'s back does not return to the page', () => {
    renderAt(['/student/session/1']);
    back();
    systemBack();
    expect(path()).toBe('/student');
  });

  it('goes one step back when there is a page behind, and leaves the fallback alone', () => {
    renderAt(['/student/goals', '/student/session/1'], 1, '/student');
    back();
    expect(path()).toBe('/student/goals');
  });

  it('goes back after a navigation inside the app', () => {
    renderAt(['/student/goals']);
    fireEvent.click(screen.getByRole('link', { name: 'Open session' }));
    expect(path()).toBe('/student/session/1');
    back();
    expect(path()).toBe('/student/goals');
  });

  it('takes a location object as the fallback', () => {
    renderAt(['/coach/students/7/programming/s/3'], 0, { pathname: '/coach/students/7', search: '?program=2' });
    back();
    expect(path()).toBe('/coach/students/7');
  });
});

// The app's router: the history is the tab's, and the router numbers its
// entries in `history.state.idx`.
describe('useBackOr, in the app\'s router (HashRouter)', () => {
  // A tab that has just opened on `hash`: one entry, no state.
  const openTab = (hash) => window.history.replaceState(null, '', hash);

  const renderApp = () =>
    render(
      <HashRouter>
        <Routes>
          <Route path="/arrive" element={<Navigate to="/student/session/1" replace />} />
          <Route path="*" element={<Page fallback="/student" />} />
        </Routes>
      </HashRouter>,
    );

  beforeEach(() => openTab('#/'));

  it('goes to the fallback on a deep link, the first entry of the tab', () => {
    openTab('#/student/session/1');
    const entries = window.history.length;
    renderApp();
    expect(path()).toBe('/student/session/1');
    expect(window.history.state.idx).toBe(0);

    back();
    expect(path()).toBe('/student');
    expect(window.location.hash).toBe('#/student');
    // Replaced, not pushed: the tab has as many entries as before.
    expect(window.history.length).toBe(entries);
    expect(window.history.state.idx).toBe(0);
  });

  it('goes to the fallback when the first entry was replaced by a redirect', async () => {
    // The return from the login page, a legacy path: the entry is still the
    // first of the tab, under a key that is no longer the default one. Going
    // by the key alone, the button would call history.back() and do nothing.
    openTab('#/arrive');
    renderApp();
    await waitFor(() => expect(path()).toBe('/student/session/1'));
    expect(window.history.state.idx).toBe(0);
    expect(window.history.state.key).not.toBe('default');

    back();
    expect(path()).toBe('/student');
  });

  it('goes one step back after a navigation inside the app', async () => {
    openTab('#/student/goals');
    renderApp();
    fireEvent.click(screen.getByRole('link', { name: 'Open session' }));
    expect(path()).toBe('/student/session/1');
    expect(window.history.state.idx).toBe(1);

    back();
    // history.back() is asynchronous.
    await waitFor(() => expect(path()).toBe('/student/goals'));
    expect(window.history.state.idx).toBe(0);
  });

  it('goes one step back on a page reloaded in the middle of the history', async () => {
    // What a reload leaves: the entries and their state, a new router.
    openTab('#/student/goals');
    window.history.replaceState({ idx: 0 }, '', '#/student/goals');
    window.history.pushState({ usr: null, key: 'k1', idx: 1 }, '', '#/student/session/1');
    renderApp();
    expect(path()).toBe('/student/session/1');

    back();
    await waitFor(() => expect(path()).toBe('/student/goals'));
  });

  it('goes to the fallback once the system\'s back has returned to the first entry', async () => {
    openTab('#/student/goals');
    renderApp();
    fireEvent.click(screen.getByRole('link', { name: 'Open session' }));
    expect(window.history.state.idx).toBe(1);
    systemBack();
    await waitFor(() => expect(path()).toBe('/student/goals'));
    expect(window.history.state.idx).toBe(0);

    back();
    expect(path()).toBe('/student');
    expect(window.location.hash).toBe('#/student');
  });
});
