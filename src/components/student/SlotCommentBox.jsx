import { useId, useState } from 'react';
import { useSaveSlotComment } from '../../hooks/useSlotComments';
import { useI18n } from '../../hooks/useI18n';
import { Button, CoachNote } from '../parc';

/**
 * The athlete's note for the coach on one exercise.
 *
 * - No note: « Ajouter une note pour le coach », a text button.
 * - A note: the note itself, signed « Ta note pour le coach », and « Modifier
 *   la note ».
 * - Writing: a field that saves when it is left (or does nothing if unchanged)
 *   and closes at once.
 * - Locked (the session is read-only): the note, and no way to change it.
 *
 * The field closes when it is left, not when the save is answered. The hook
 * writes the note into the cache at that moment, so the note shows it; and the
 * answer can be hours away — a note written without a network is parked, which
 * is neither a success nor a failure, and the field used to stay open on it as
 * if nothing had happened.
 */
export default function SlotCommentBox({ sessionId, slotId, comment, locked = false }) {
  const { t } = useI18n();
  const fieldId = useId();
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
    if (!body) return null;
    return (
      <CoachNote title={t('parcSession.yourNote')} from="athlete">
        {body}
      </CoachNote>
    );
  }

  if (open) {
    return (
      <div className="grid gap-1.5">
        <label htmlFor={fieldId} className="pk-small">
          {t('parcSession.noteField')}
        </label>
        <textarea
          id={fieldId}
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={handleBlur}
          rows={3}
          placeholder={t('parcSession.notePlaceholder')}
          className="pk-field py-2.5"
        />
      </div>
    );
  }

  if (body) {
    return (
      <CoachNote title={t('parcSession.yourNote')} from="athlete">
        {body}
        <div>
          <Button variant="text" className="-ml-1 mt-1" onClick={openEditor}>
            {t('parcSession.editNote')}
          </Button>
        </div>
      </CoachNote>
    );
  }

  return (
    <Button variant="text" className="self-start" onClick={openEditor}>
      {t('parcSession.addNote')}
    </Button>
  );
}
