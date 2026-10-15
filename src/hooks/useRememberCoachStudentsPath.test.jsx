import { describe, it, expect, beforeEach } from 'vitest';
import { render, fireEvent, screen } from '@testing-library/react';
import { MemoryRouter, Link, Routes, Route, Outlet } from 'react-router-dom';
import {
  useRememberCoachStudentsPath,
  useForgetCoachStudentsPath,
  getLastCoachStudentsPath,
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
  });

  it('keeps a path whose page is there', () => {
    renderAt('/coach/students/a1/s/s1', false);
    expect(getLastCoachStudentsPath()).toBe('/coach/students/a1/s/s1');
  });

  it('wins over the writer above it in the same render', () => {
    localStorage.setItem('sl_last_coach_students_path', '/coach/students/a1');
    renderAt('/coach/students/a1/s/gone', true);
    expect(getLastCoachStudentsPath()).toBeNull();
  });

  it('lets the writer remember the next path', () => {
    renderAt('/coach/students/a1/s/gone', true);
    fireEvent.click(screen.getByRole('link', { name: 'athlete' }));
    expect(getLastCoachStudentsPath()).toBe('/coach/students/a1');
  });
});
