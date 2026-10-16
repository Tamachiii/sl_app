import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  clearFeedbackDraft,
  feedbackDraftKey,
  readFeedbackDraft,
  writeFeedbackDraft,
} from './feedbackDraft';

// Review item P47: the coach's feedback lived in component state alone, and
// the review is one-shot. These hold the device side of the draft: one key per
// session, blank text is no draft, and a storage that throws stops nothing.

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('feedbackDraft', () => {
  it('keeps one draft per session, under a key that names it', () => {
    expect(feedbackDraftKey('sess-1')).toBe('sl_feedback_draft:sess-1');

    writeFeedbackDraft('sess-1', 'Brace harder');
    writeFeedbackDraft('sess-2', 'Slower eccentric');

    expect(localStorage.getItem('sl_feedback_draft:sess-1')).toBe('Brace harder');
    expect(readFeedbackDraft('sess-1')).toBe('Brace harder');
    expect(readFeedbackDraft('sess-2')).toBe('Slower eccentric');
    expect(readFeedbackDraft('sess-3')).toBe('');
  });

  it('keeps the text as it was typed, blanks around it included', () => {
    writeFeedbackDraft('sess-1', '  Brace harder\n');
    expect(readFeedbackDraft('sess-1')).toBe('  Brace harder\n');
  });

  it('removes the key for a body of blanks, or for no body', () => {
    writeFeedbackDraft('sess-1', 'Brace harder');
    writeFeedbackDraft('sess-1', '  \n ');
    expect(localStorage.getItem('sl_feedback_draft:sess-1')).toBeNull();

    writeFeedbackDraft('sess-1', 'Brace harder');
    writeFeedbackDraft('sess-1', undefined);
    expect(localStorage.getItem('sl_feedback_draft:sess-1')).toBeNull();
  });

  it('forgets the draft of one session and leaves the others', () => {
    writeFeedbackDraft('sess-1', 'Brace harder');
    writeFeedbackDraft('sess-2', 'Slower eccentric');
    clearFeedbackDraft('sess-1');

    expect(readFeedbackDraft('sess-1')).toBe('');
    expect(readFeedbackDraft('sess-2')).toBe('Slower eccentric');
  });

  it('does nothing without a session', () => {
    writeFeedbackDraft(undefined, 'Brace harder');
    expect(localStorage.length).toBe(0);
    expect(readFeedbackDraft(undefined)).toBe('');
    expect(() => clearFeedbackDraft(null)).not.toThrow();
  });

  // A private window, a full or refused storage.
  it('never throws when the storage does', () => {
    const refuse = () => { throw new Error('QuotaExceededError'); };
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(refuse);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(refuse);
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(refuse);

    expect(readFeedbackDraft('sess-1')).toBe('');
    expect(() => writeFeedbackDraft('sess-1', 'Brace harder')).not.toThrow();
    expect(() => writeFeedbackDraft('sess-1', '')).not.toThrow();
    expect(() => clearFeedbackDraft('sess-1')).not.toThrow();
  });
});
