import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

// Where the coach was last looking, per tab: the Athletes tab comes back to the
// athlete they were working on, the Sessions tab to the review they left open
// and to the athlete they filtered the feed on. This module is the one place
// that memory is read and written.
//
// It lasts ONE LAUNCH (sessionStorage): a detour through another tab comes
// back, a cold launch of the app opens every tab on its root. It used to sit in
// localStorage, so each launch skipped the attention-first roster for whichever
// athlete — or session editor — the coach had last opened, days before, and the
// Sessions tab reopened the last review (review item L13).
//
// CoachHome is the route element for the athlete page AND the parent of the
// session editor (`s/:sessionId` renders in its Outlet), so a single writer
// call there already covers every Athletes-tab destination. What is written is
// the full path; what is restored is the athlete page only (`athletePageOf`).
const STUDENTS_PATH_KEY = 'sl_last_coach_students_path';
// The roster itself must never become the restore target — that would defeat
// the whole point of persistence.
const SKIP_WRITE_PATHS = new Set(['/coach/students']);
// The path a page of the tab found nothing at (`useForgetCoachStudentsPath`),
// so the writer below does not put it back.
const FORGOTTEN_KEY = 'sl_last_coach_students_path_forgotten';
// `{ studentId, sessionId, from? }` of the review left open (SessionReview
// writes it, SessionsFeed bounces back into it).
const SESSION_KEY = 'sl_last_coach_session';
// The athlete the coach last picked in the feed's filter.
const SESSIONS_STUDENT_KEY = 'sl_last_coach_sessions_student';

// The same four names, as earlier versions left them in localStorage. They are
// never read: the first launch after the update must open on the roster too.
// They are only removed, once per launch, so nothing is left behind.
const LEGACY_LOCAL_KEYS = [STUDENTS_PATH_KEY, FORGOTTEN_KEY, SESSION_KEY, SESSIONS_STUDENT_KEY];
let legacyChecked = false;

export function dropLegacyCoachMemory() {
  legacyChecked = true;
  try {
    for (const key of LEGACY_LOCAL_KEYS) window.localStorage.removeItem(key);
  } catch { /* ignore */ }
}

// Every access goes through these three. sessionStorage can throw (blocked
// site data, some private modes): the memory is then simply empty.
function read(key) {
  if (!legacyChecked) dropLegacyCoachMemory();
  try { return window.sessionStorage.getItem(key); } catch { return null; }
}

function write(key, value) {
  if (!legacyChecked) dropLegacyCoachMemory();
  try { window.sessionStorage.setItem(key, value); } catch { /* ignore */ }
}

function remove(key) {
  try { window.sessionStorage.removeItem(key); } catch { /* ignore */ }
}

// ---- the Athletes tab ----------------------------------------------------

export function useRememberCoachStudentsPath() {
  const { pathname, search } = useLocation();
  useEffect(() => {
    if (SKIP_WRITE_PATHS.has(pathname)) return;
    const path = pathname + (search || '');
    if (read(FORGOTTEN_KEY) === path) return;
    remove(FORGOTTEN_KEY);
    write(STUDENTS_PATH_KEY, path);
  }, [pathname, search]);
}

/**
 * For a page of the Athletes tab that found nothing at its URL — an athlete
 * who is not on the roster, a session that was deleted: while `forget` is
 * true, the URL is not where the tab comes back to. Without it, the Athletes
 * tab would open that "not found" again each time.
 *
 * A mark is left next to the remembered path because the writer runs AFTER
 * this hook when the two run in the same render: React runs a child's effects
 * before its parent's, and the writer sits in CoachHome, above the editor.
 * The writer skips the marked path, and the mark goes with the next path it
 * writes.
 */
export function useForgetCoachStudentsPath(forget) {
  const { pathname, search } = useLocation();
  useEffect(() => {
    if (!forget) return;
    write(FORGOTTEN_KEY, pathname + (search || ''));
    remove(STUDENTS_PATH_KEY);
  }, [forget, pathname, search]);
}

export function getLastCoachStudentsPath() {
  return read(STUDENTS_PATH_KEY);
}

// "‹ All athletes", the "not found" page's way out, and a tap on the Athletes
// tab while it is the one open: the coach asked for the roster.
export function clearLastCoachStudentsPath() {
  remove(STUDENTS_PATH_KEY);
}

// Pull a studentId out of `/coach/students/:id…` so CoachHome can validate the
// saved path against the current roster and skip the restore when that athlete
// is gone (rather than bouncing into a dead URL).
export function studentIdFromPath(path) {
  if (!path) return null;
  const m = path.match(/^\/coach\/students\/([^/?#]+)/);
  return m ? m[1] : null;
}

/**
 * The athlete page a remembered path belongs to — what the Athletes tab
 * restores. Never the session editor beneath it: an editor opened in another
 * session of the day is not where a tab tap should drop the coach, and the
 * session may be gone. The block the athlete page was on (`?program=`) is kept
 * when the path IS the athlete page; any other path gives the bare page.
 * Null for anything that is not under `/coach/students/:id`.
 */
export function athletePageOf(path) {
  if (typeof path !== 'string') return null;
  const m = path.match(/^\/coach\/students\/([^/?#]+)(\/[^?#]*)?(\?[^#]*)?/);
  if (!m) return null;
  const page = `/coach/students/${m[1]}`;
  const rest = m[2] || '';
  if (rest !== '' && rest !== '/') return page;
  const program = new URLSearchParams(m[3] || '').get('program');
  return program ? `${page}?${new URLSearchParams({ program })}` : page;
}

// ---- the Sessions tab ----------------------------------------------------

/**
 * The review left open: `{ studentId, sessionId, from? }`, or null when there
 * is none or what is stored is not that. Both ids are non-empty strings; `from`
 * is kept only when it is a string, and the review still checks it is a coach
 * route before it navigates there.
 */
export function getLastCoachSession() {
  const raw = read(SESSION_KEY);
  if (!raw) return null;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const { studentId, sessionId, from } = parsed;
  if (typeof studentId !== 'string' || !studentId) return null;
  if (typeof sessionId !== 'string' || !sessionId) return null;
  return typeof from === 'string' ? { studentId, sessionId, from } : { studentId, sessionId };
}

export function rememberLastCoachSession({ studentId, sessionId, from }) {
  if (!studentId || !sessionId) return;
  write(SESSION_KEY, JSON.stringify({ studentId, sessionId, ...(from ? { from } : {}) }));
}

export function clearLastCoachSession() {
  remove(SESSION_KEY);
}

export function getLastCoachSessionsStudent() {
  return read(SESSIONS_STUDENT_KEY) || null;
}

export function rememberLastCoachSessionsStudent(studentId) {
  if (studentId) write(SESSIONS_STUDENT_KEY, studentId);
  else remove(SESSIONS_STUDENT_KEY);
}

export function clearLastCoachSessionsStudent() {
  remove(SESSIONS_STUDENT_KEY);
}

// A tap on the Sessions tab while it is the one open: the plain feed, with no
// review to bounce into and no athlete filter put back.
export function clearLastCoachSessionsTab() {
  clearLastCoachSession();
  clearLastCoachSessionsStudent();
}
