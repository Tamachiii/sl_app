import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../hooks/useAuth';
import { useI18n } from '../../hooks/useI18n';
import { ConfirmSheet } from '../parc';
import { isQueuedWrite } from '../../lib/persistence';
import { hasUnsyncedDraft } from '../../lib/offlineMutations';
import { formatNumber, pluralKey } from '../../lib/i18n/format';

/**
 * Asks before a sign-out that would throw unsynced work away.
 *
 * A sign-out wipes what the device holds for the account (`ClearOnUserChange`
 * in App.jsx) — the reads, and the writes it still owes the database: the sets
 * ticked without signal, a confirmation, a program draft. Those exist nowhere
 * else. So while there are any, "Sign out" opens this question instead of
 * signing out, and goes ahead only on "Sign out anyway".
 *
 * Mounted once, under AuthProvider (App.jsx). It registers itself with the
 * provider (`guardSignOut`), and every sign-out of the app goes through the
 * provider's `signOut`: the avatar menu, the profile page and whatever comes
 * next are covered without knowing about it.
 *
 * "Owed" is `isQueuedWrite` (lib/persistence.js) — the test that decides what
 * the persister stores and what the offline banner counts — plus a draft that
 * is ahead of the server without a save on its way (`hasUnsyncedDraft`). It is
 * read at the moment of the tap, from the client, not kept in state.
 */
export default function SignOutGuard() {
  const { guardSignOut } = useAuth();
  const queryClient = useQueryClient();
  const { t, lang } = useI18n();
  // The question on screen: how many writes it is about (0: a draft alone).
  const [question, setQuestion] = useState(null);
  // Its answer, for whoever waits — every tap on "Sign out" made meanwhile.
  const asked = useRef(null);

  useEffect(() => {
    if (!guardSignOut) return undefined;
    return guardSignOut(() => {
      if (asked.current) return asked.current.answer;
      const writes = queryClient.isMutating({ predicate: isQueuedWrite });
      if (writes === 0 && !hasUnsyncedDraft(queryClient)) return true;

      let settle;
      const answer = new Promise((resolve) => {
        settle = resolve;
      });
      asked.current = { answer, settle };
      setQuestion({ writes });
      return answer;
    });
  }, [guardSignOut, queryClient]);

  // The dialog calls `onConfirm` and then `onClose`: the first answer counts.
  function answer(signOutAnyway) {
    const waiting = asked.current;
    if (!waiting) return;
    asked.current = null;
    setQuestion(null);
    waiting.settle(signOutAnyway);
  }

  // Not rendered closed: a dialog that is always in the page is one more
  // element carrying the dialog title's id.
  if (!question) return null;

  const { writes } = question;
  const message =
    writes === 0
      ? t('authOffline.signOutDraft')
      : t(pluralKey(lang, writes, { one: 'authOffline.signOutOne', other: 'authOffline.signOutMany' }), {
          n: formatNumber(lang, writes),
        });

  return (
    <ConfirmSheet
      open
      onClose={() => answer(false)}
      onConfirm={() => answer(true)}
      title={t('authOffline.signOutTitle')}
      message={message}
      confirmText={t('authOffline.signOutAnyway')}
    />
  );
}
