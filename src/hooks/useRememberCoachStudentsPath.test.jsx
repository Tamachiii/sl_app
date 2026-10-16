import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import { MemoryRouter, Link, Routes, Route, Outlet } from 'react-router-dom';
import {
  useRememberCoachStudentsPath,
  useForgetCoachStudentsPath,
  getLastCoachStudentsPath,
  clearLastCoachStudentsPath,
  athletePageOf,
  getLastCoachSession,
  rememberLastCoachSession,
  clearLastCoachSession,
  getLastCoachSessionsStudent,
  rememberLastCoachSessionsStudent,
  clearLastCoachSessionsTab,
} from './useRememberCoachStudentsPath';

// The writer sits in CoachHome; a page that finds nothing sits below it, in
// its outlet. React runs the child's effects first, so the "forget" of a page
// that already knows on its first render runs BEFORE the writer — which must
// not put the path back.
function Parent() {
  useRememberCoachStudentsPath();
  return (
    <>
      <Link to="/coach/students/a1">athlete</Link>
      <Outlet />
    </>
  );
}

function Child({ missing }) {
  useForgetCoachStudentsPath(missing);
  return null;
}

function renderAt(path, missing) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/coach/students/:id" element={<Parent />}>
          <Route path="s/:sessionId" element={<Child missing={missing} />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('useForgetCoachStudentsPath', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('keeps a path whose page is there', () => {
    renderAt('/coach/students/a1/s/s1', false);
    expect(getLastCoachStudentsPath()).toBe('/coach/students/a1/s/s1');
  });

  it('wins over the writer above it in the same render', () => {
    sessionStorage.setItem('sl_last_coach_students_path', '/coach/students/a1');
    renderAt('/coach/students/a1/s/gone', true);
    expect(getLastCoachStudentsPath()).toBeNull();
  });

  it('lets the writer remember the next path', () => {
    renderAt('/coach/students/a1/s/gone', true);
    fireEvent.click(screen.getByRole('link', { name: 'athlete' }));
    expect(getLastCoachStudentsPath()).toBe('/coach/students/a1');
  });
});

// Review item L13: the coach's last place, in each tab, lasts one launch.
describe('the memory of a launch', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('is written to sessionStorage, never to localStorage', () => {
    renderAt('/coach/students/a1', false);
    rememberLastCoachSession({ studentId: 'a1', sessionId: 's1' });
    rememberLastCoachSessionsStudent('a1');

    expect(sessionStorage.getItem('sl_last_coach_students_path')).toBe('/coach/students/a1');
    expect(JSON.parse(sessionStorage.getItem('sl_last_coach_session')))
      .toEqual({ studentId: 'a1', sessionId: 's1' });
    expect(sessionStorage.getItem('sl_last_coach_sessions_student')).toBe('a1');
    expect(Object.keys(localStorage)).toEqual([]);
  });

  it('is empty after a relaunch', () => {
    renderAt('/coach/students/a1', false);
    rememberLastCoachSession({ studentId: 'a1', sessionId: 's1' });
    rememberLastCoachSessionsStudent('a1');
    // What a cold start of the app does: the tab's sessionStorage is new.
    sessionStorage.clear();

    expect(getLastCoachStudentsPath()).toBeNull();
    expect(getLastCoachSession()).toBeNull();
    expect(getLastCoachSessionsStudent()).toBeNull();
  });

  it('reads nothing an earlier version left in localStorage', () => {
    localStorage.setItem('sl_last_coach_students_path', '/coach/students/a1');
    localStorage.setItem('sl_last_coach_session', JSON.stringify({ studentId: 'a1', sessionId: 's1' }));
    localStorage.setItem('sl_last_coach_sessions_student', 'a1');

    expect(getLastCoachStudentsPath()).toBeNull();
    expect(getLastCoachSession()).toBeNull();
    expect(getLastCoachSessionsStudent()).toBeNull();
  });

  // A fresh module is a fresh launch: its first read takes the old keys away.
  it('removes what an earlier version left in localStorage, once a launch', async () => {
    vi.resetModules();
    localStorage.setItem('sl_last_coach_students_path', '/coach/students/a1');
    localStorage.setItem('sl_last_coach_students_path_forgotten', '/coach/students/a1/s/x');
    localStorage.setItem('sl_last_coach_session', '{}');
    localStorage.setItem('sl_last_coach_sessions_student', 'a1');
    localStorage.setItem('sl_feedback_draft:s1', 'kept');
    const fresh = await import('./useRememberCoachStudentsPath');

    fresh.getLastCoachStudentsPath();
    expect(Object.keys(localStorage)).toEqual(['sl_feedback_draft:s1']);
  });

  it('keeps going when sessionStorage throws', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    try {
      expect(getLastCoachStudentsPath()).toBeNull();
      expect(getLastCoachSession()).toBeNull();
      expect(getLastCoachSessionsStudent()).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('forgets the Athletes tab on demand', () => {
    renderAt('/coach/students/a1', false);
    clearLastCoachStudentsPath();
    expect(getLastCoachStudentsPath()).toBeNull();
  });

  it('forgets the Sessions tab — review and filter — on demand', () => {
    rememberLastCoachSession({ studentId: 'a1', sessionId: 's1' });
    rememberLastCoachSessionsStudent('a1');
    clearLastCoachSessionsTab();
    expect(getLastCoachSession()).toBeNull();
    expect(getLastCoachSessionsStudent()).toBeNull();
  });
});

describe('getLastCoachSession', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('gives back the review with the page that opened it', () => {
    rememberLastCoachSession({ studentId: 'a1', sessionId: 's1', from: '/coach/students/a1' });
    expect(getLastCoachSession()).toEqual({ studentId: 'a1', sessionId: 's1', from: '/coach/students/a1' });
  });

  it('writes no origin when there is none', () => {
    rememberLastCoachSession({ studentId: 'a1', sessionId: 's1', from: null });
    expect(JSON.parse(sessionStorage.getItem('sl_last_coach_session'))).toEqual({ studentId: 'a1', sessionId: 's1' });
  });

  it.each([
    ['malformed JSON', '{ not json'],
    ['JSON that is not an object', '"a1/s1"'],
    ['null', 'null'],
    ['a missing sessionId', JSON.stringify({ studentId: 'a1' })],
    ['a missing studentId', JSON.stringify({ sessionId: 's1' })],
    ['an empty id', JSON.stringify({ studentId: '', sessionId: 's1' })],
    ['ids that are not strings', JSON.stringify({ studentId: 1, sessionId: { id: 2 } })],
  ])('is null on %s', (_label, raw) => {
    sessionStorage.setItem('sl_last_coach_session', raw);
    expect(getLastCoachSession()).toBeNull();
  });

  it('drops an origin that is not a string', () => {
    sessionStorage.setItem(
      'sl_last_coach_session',
      JSON.stringify({ studentId: 'a1', sessionId: 's1', from: { pathname: '/coach/' } }),
    );
    expect(getLastCoachSession()).toEqual({ studentId: 'a1', sessionId: 's1' });
  });

  it('is forgotten on demand', () => {
    rememberLastCoachSession({ studentId: 'a1', sessionId: 's1' });
    clearLastCoachSession();
    expect(getLastCoachSession()).toBeNull();
  });
});

describe('athletePageOf', () => {
  it.each([
    ['the athlete page', '/coach/students/a1', '/coach/students/a1'],
    ['the athlete page on a block', '/coach/students/a1?program=p2', '/coach/students/a1?program=p2'],
    ['the athlete page with a trailing slash', '/coach/students/a1/', '/coach/students/a1'],
    ['the session editor', '/coach/students/a1/s/s1', '/coach/students/a1'],
    ['the session editor with a query', '/coach/students/a1/s/s1?program=p2', '/coach/students/a1'],
    ['anything else under the athlete', '/coach/students/a1/programming', '/coach/students/a1'],
    ['a query that names no block', '/coach/students/a1?tab=x', '/coach/students/a1'],
  ])('gives the athlete page for %s', (_label, path, page) => {
    expect(athletePageOf(path)).toBe(page);
  });

  it.each([
    ['nothing', null],
    ['the roster', '/coach/students'],
    ['another tab', '/coach/sessions'],
    ['a review', '/coach/student/a1/session/s1/review'],
    ['not a string', 42],
  ])('is null for %s', (_label, path) => {
    expect(athletePageOf(path)).toBeNull();
  });
});
