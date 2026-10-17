import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useLocation } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useRestTimer } from '../../hooks/useRestTimer';
import { useI18n } from '../../hooks/useI18n';
import { appUpdater } from '../../lib/appUpdate';
import { fieldWatch } from '../../lib/fieldWatch';
import { writesAreSafe } from '../../lib/pendingWrites';
import { Button } from '../parc';

// A Parc Sheet keeps its <dialog> mounted and closed; only an open one counts.
const dialogIsOpen = () =>
  document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]') !== null;

const isResting = (timer) => timer.endsAt != null && timer.endsAt > Date.now();

/**
 * The page's half of an app update (lib/appUpdate holds the other half and the
 * whole story). Mounted once, in AppShell; `updater` is a prop for the tests.
 *
 * It answers one question for the updater — "would a reload lose something
 * right now?" — and the answer is yes while:
 *
 *   • a write is pending, on its way or queued offline (React Query's count);
 *   • a rest timer is running (`useRestTimer`);
 *   • a field has the focus, or holds text that was typed into it — a message
 *     or a feedback that is written and not sent is in progress wherever the
 *     focus is (lib/fieldWatch);
 *   • a dialog is open.
 *
 * At a safe moment the updater applies the update by itself and this component
 * says "Updating…" until the page is replaced. At any other moment it OFFERS
 * the update: a card above the bottom nav, fixed, so that nothing moves under a
 * thumb in the middle of a set. The card stays out while a field is in use: it
 * would sit on top of what is being typed, right above the keyboard — and for a
 * moment after the field is left, because the tap that takes the focus out of a
 * field is not over when the focus moves. A card drawn at that instant, under
 * the finger, takes the end of the tap, and the button that was aimed at gets
 * no click (`fieldWatch.inUse`, FIELD_LEFT_MS).
 *
 * "Update" is the person's own choice and is not held back by the timer or by
 * the queue: it waits only for the writes that a reload would actually lose —
 * and not for ever (WRITES_WAIT_MS): a write that does not come back gives the
 * offer back, with the reason, and nothing is reloaded.
 */
export default function UpdatePrompt({ updater = appUpdater }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { pathname } = useLocation();
  const update = useSyncExternalStore(updater.subscribe, updater.getState, updater.getState);
  // Subscribing is also what makes the watch listen for what is typed.
  const fieldInUse = useSyncExternalStore(fieldWatch.subscribe, fieldWatch.inUse, () => false);
  const timer = useRestTimer();
  const [accepted, setAccepted] = useState(false);
  const [stillSaving, setStillSaving] = useState(false);

  // The updater asks from event handlers, long after a render: it gets the
  // counts of that moment, not of the last time this component was drawn.
  const timerRef = useRef(timer);
  useEffect(() => {
    timerRef.current = timer;
  }, [timer]);

  useEffect(
    () =>
      updater.watchForSafeMoment(
        () =>
          queryClient.isMutating() > 0 ||
          isResting(timerRef.current) ||
          fieldWatch.hasFocus() ||
          fieldWatch.holdsTypedText() ||
          dialogIsOpen(),
      ),
    [updater, queryClient],
  );

  // Going to another page is a moment at which a reload costs nothing.
  useEffect(() => {
    updater.consider();
  }, [updater, pathname]);

  if (!update.pending) return null;

  const updating = update.applying || accepted;
  if (!updating && (!update.offered || fieldInUse)) return null;

  const onUpdate = async () => {
    setStillSaving(false);
    setAccepted(true);
    if (await writesAreSafe(queryClient)) updater.apply();
    else setStillSaving(true);
    setAccepted(false);
  };

  const onLater = () => {
    setStillSaving(false);
    updater.dismiss();
  };

  let message = t('appUpdate.ready');
  if (stillSaving) message = t('appUpdate.stillSaving');
  else if (update.failed) message = t('appUpdate.failed');

  return (
    <div
      className="pointer-events-none fixed inset-x-0 z-50 flex justify-center px-4"
      style={{ bottom: 'calc(env(safe-area-inset-bottom) + 72px)' }}
    >
      <div
        role="status"
        aria-live="polite"
        data-testid="update-prompt"
        className="pointer-events-auto w-full max-w-[420px] rounded-group border border-line bg-surface p-4 shadow-lg"
      >
        {updating ? (
          <p className="pk-body m-0">{t('appUpdate.updating')}</p>
        ) : (
          // The text above, the two actions below it: side by side, "Mettre à
          // jour" and "Aktualisieren" leave the sentence a column of a few
          // words on a phone, and the card grows over the page it sits on.
          <>
            <p className="pk-body m-0">{message}</p>
            {isResting(timer) && <p className="pk-small m-0 mt-1">{t('appUpdate.stopsRest')}</p>}
            <div className="mt-2 flex items-center justify-end gap-1">
              <Button variant="text" onClick={onLater}>
                {t('appUpdate.later')}
              </Button>
              <Button variant="primary" onClick={onUpdate}>
                {t('appUpdate.update')}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
