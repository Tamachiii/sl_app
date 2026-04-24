import { useEffect, useState } from 'react';
import { useSaveSlotComment } from '../../hooks/useSlotComments';

/**
 * Compact per-slot comment affordance for the student.
 *
 * Collapsed: a single chat-bubble button; shows a dot when a comment exists.
 * Expanded: a small textarea that saves on blur (or cancels if unchanged).
 * Locked: read-only text when the session is archived.
 */
export default function SlotCommentBox({ sessionId, slotId, comment, locked = false }) {
  const body = comment?.body || '';
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(body);
  const save = useSaveSlotComment();

  useEffect(() => {
    setDraft(body);
  }, [body]);

  function handleBlur() {
    if (draft.trim() === body.trim()) {
      setOpen(false);
      return;
    }
    save.mutate(
      { sessionId, slotId, body: draft },
      { onSuccess: () => setOpen(false) }
    );
  }

  if (locked) {
    if (!body) return null;
    return (
      <div className="mt-1 text-xs text-gray-600 bg-gray-50 rounded-lg px-2 py-1.5 whitespace-pre-wrap">
        <span className="font-medium text-gray-500">Your note:</span> {body}
      </div>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={body ? 'Edit note for coach' : 'Add note for coach'}
        className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-primary"
      >
        <svg
          className="w-3.5 h-3.5"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M8 10h.01M12 10h.01M16 10h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
          />
        </svg>
        {body ? (
          <span className="truncate max-w-[14rem]">{body}</span>
        ) : (
          <span>Add note for coach</span>
        )}
      </button>
    );
  }

  return (
    <textarea
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={handleBlur}
      rows={2}
      placeholder="Note for your coach…"
      className="w-full mt-1 rounded-lg border border-gray-300 px-2 py-1.5 text-[16px] focus:outline-none focus:ring-2 focus:ring-primary"
    />
  );
}
