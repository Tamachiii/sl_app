// The coach's feedback on a session, while it is still being written.
//
// The review of a session is one-shot: once it is sent, or once "Finish
// without feedback" stamps `reviewed_at`, nothing more can be said through it.
// A draft held in component state alone died with the page — the coach
// tabbing away, a reload, a read that found the confirmation undone and took
// the composer off screen — and was gone for good. So what is typed is kept
// here, one key per session, until it is sent, finished away on purpose, or
// emptied.
//
// localStorage, not sessionStorage: iOS kills an installed app in the
// background, and a session storage goes with it. The key names the session,
// and a session is only ever read by its coach (RLS), so two coaches on one
// device do not see each other's drafts in a review they can open.
//
// Every access is wrapped: a private window, a full or refused storage, or a
// value that is not ours under the key must never stop the coach typing or
// sending.

const PREFIX = 'sl_feedback_draft:';

export function feedbackDraftKey(sessionId) {
  return `${PREFIX}${sessionId}`;
}

/** The draft kept for this session, or '' when there is none. */
export function readFeedbackDraft(sessionId) {
  if (!sessionId) return '';
  try {
    const stored = localStorage.getItem(feedbackDraftKey(sessionId));
    return typeof stored === 'string' ? stored : '';
  } catch {
    return '';
  }
}

/**
 * Keep `body` as the draft of this session. A body with nothing but blanks
 * is no draft: the key is removed instead.
 */
export function writeFeedbackDraft(sessionId, body) {
  if (!sessionId) return;
  if (typeof body !== 'string' || body.trim() === '') {
    clearFeedbackDraft(sessionId);
    return;
  }
  try {
    localStorage.setItem(feedbackDraftKey(sessionId), body);
  } catch {
    // Storage full or refused: the text stays on screen, it is just not kept.
  }
}

/** Forget the draft of this session: it was sent, discarded, or emptied. */
export function clearFeedbackDraft(sessionId) {
  if (!sessionId) return;
  try {
    localStorage.removeItem(feedbackDraftKey(sessionId));
  } catch {
    // No storage: nothing was kept.
  }
}
