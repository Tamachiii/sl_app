import { useState } from 'react';
import { useSaveSlotComment } from '../../hooks/useSlotComments';
import { useI18n } from '../../hooks/useI18n';

// The chat bubble of the note, in both forms of the control.
function NoteIcon({ className }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M8 10h.01M12 10h.01M16 10h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
      />
    </svg>
  );
}

/**
 * Compact per-slot comment affordance for the student.
 *
 * Collapsed: a single chat-bubble button; shows a dot when a comment exists.
 * Expanded: a small textarea that saves when it is left (or cancels if
 * unchanged) and closes at once.
 * Locked: read-only text when the session is archived.
 *
 * Compact (B29): the form an exercise's card shows while it is collapsed — a
 * 44 px bubble beside the card's header, named after the exercise, accent
 * when the exercise has a note. Its field opens on a line of its own under
 * the header (`fieldClassName` places it), and saves and closes the same way.
 * Locked, it renders nothing: the card's header shows a passive badge. A card
 * shows one form or the other, never both.
 *
 * The field closes when it is left, not when the save is answered. The hook
 * writes the note into the cache at that moment, so the pill shows it; and the
 * answer can be hours away — a note written without a network is parked,
 * which is neither a success nor a failure, and the field used to stay open on
 * it as if nothing had happened.
 */
export default function SlotCommentBox({
  sessionId,
  slotId,
  comment,
  locked = false,
  compact = false,
  exerciseName = '',
  fieldClassName = '',
}) {
  const { t } = useI18n();
  const body = comment?.body || '';
  const [open, setOpen] = useState(false);
  // What is being typed. Filled when the field opens — not kept equal to the
  // note by an effect: the note changes under the field for other reasons
  // than typing (a save that is taken back, a read that comes in).
  const [draft, setDraft] = useState('');
  // What a save that failed was carrying. The note on screen goes back to what
  // the database has, and this is what the field opens on next: the athlete
  // does not write it twice.
  const [unsaved, setUnsaved] = useState(null);
  const save = useSaveSlotComment();

  function openEditor() {
    setDraft(unsaved ?? body);
    setOpen(true);
  }

  function handleBlur() {
    setOpen(false);
    setUnsaved(null);
    if (draft.trim() === body.trim()) return;
    const written = draft;
    save.mutate({ sessionId, slotId, body: written }, { onError: () => setUnsaved(written) });
  }

  if (locked) {
    if (compact || !body) return null;
    return (
      <div className="mt-1 text-xs text-gray-600 bg-gray-50 rounded-lg px-2 py-1.5 whitespace-pre-wrap">
        <span className="font-medium text-gray-500">Your note:</span> {body}
      </div>
    );
  }

  if (!open && compact) {
    const label = t(body ? 'sessionRestControls.editNoteOn' : 'sessionRestControls.addNoteOn', {
      name: exerciseName,
    });
    return (
      <button
        type="button"
        onClick={openEditor}
        aria-label={label}
        title={label}
        className={`sl-pill sl-pill-btn px-0 mr-2 shrink-0 hover:bg-ink-100 ${
          body ? 'text-accent' : 'text-ink-400'
        }`}
      >
        <NoteIcon className="w-4 h-4" />
      </button>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={openEditor}
        aria-label={body ? 'Edit note for coach' : 'Add note for coach'}
        // align-top pairs with the sibling "+ Add set" pill in SlotBody so the
        // two inline-flex pills sit level; the leading icon here throws off
        // baseline/middle alignment, and both must share the same value.
        className="sl-pill sl-pill-btn bg-ink-100 text-ink-600 hover:bg-ink-200 max-w-full align-top"
      >
        {/* Nudge the bubble down ~1px: its tail hangs below the body, so the
            SVG's box-center sits lower than the bubble's visual center and the
            icon otherwise reads as floating high next to the text. */}
        <NoteIcon className="w-3.5 h-3.5 shrink-0 translate-y-px" />
        {body ? (
          <span className="truncate max-w-[14rem] normal-case tracking-normal">{body}</span>
        ) : (
          <span className="leading-none">Add note</span>
        )}
      </button>
    );
  }

  const field = (
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
  // Compact: a line of its own under the card's header (the header row wraps).
  return compact ? <div className={`basis-full ${fieldClassName}`}>{field}</div> : field;
}
