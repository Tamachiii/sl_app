import { supabase } from './supabase';

// Best-effort production error telemetry: the dev-coach's only feedback loop
// for crashes on students' phones. Every path here swallows its own failure —
// reporting an error must never itself throw or block the UI.

let currentUser = null; // { id, role } — set from AuthProvider.
const recent = new Set(); // signature dedupe within a session.
const RECENT_CAP = 200; // bound the dedupe set on a days-long PWA session.

export function setErrorReporterUser(user) {
  currentUser = user ? { id: user.id, role: user.role || null } : null;
}

// Strip anything token-shaped from the URL before it lands in the coach-
// readable table. Supabase's implicit auth flow briefly puts
// #access_token=…&refresh_token=… in location.href on magic-link / OAuth /
// recovery redirects; never persist that. HashRouter routes (#/coach/…) are
// safe and useful for triage, so keep those.
function safeUrl() {
  if (typeof location === 'undefined') return null;
  const href = location.href;
  if (/access_token|refresh_token|[?#&](token|code)=/.test(href)) {
    return `${location.origin}${location.pathname}#<redacted-auth-params>`.slice(0, 500);
  }
  return href.slice(0, 500);
}

async function report({ message, stack }) {
  try {
    if (!message) return;
    // The INSERT policy requires user_id = auth.uid(); a null user_id (pre-
    // auth / login-page crash) is always rejected, so skip the doomed round
    // trip and just log locally rather than emit a swallowed error.
    if (!currentUser?.id) return;

    const sig = `${message}::${(stack || '').slice(0, 120)}`;
    if (recent.has(sig)) return; // don't spam the table with a render loop
    if (recent.size >= RECENT_CAP) recent.clear();
    recent.add(sig);

    await supabase.from('client_errors').insert({
      user_id: currentUser.id,
      role: currentUser.role ?? null,
      message: String(message).slice(0, 2000),
      stack: stack ? String(stack).slice(0, 8000) : null,
      url: safeUrl(),
      user_agent: typeof navigator !== 'undefined' ? navigator.userAgent.slice(0, 500) : null,
    });
  } catch {
    // Telemetry is best-effort; never surface a reporting failure.
  }
}

export function reportError(error, extra) {
  const message = extra || error?.message || String(error);
  return report({ message, stack: error?.stack });
}

let installed = false;

/** Wire window-level handlers once (call from app bootstrap). */
export function installGlobalErrorReporting() {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('error', (e) => {
    report({ message: e.message || 'window.onerror', stack: e.error?.stack });
  });
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason;
    report({
      message: reason?.message || `unhandledrejection: ${String(reason)}`,
      stack: reason?.stack,
    });
  });
}
