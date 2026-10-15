# realtime-resilience — docs to fold (wave 2, items P26, P62)

Each block: target doc, section, then the text to fold in.

## docs/INVARIANTS.md — Messaging / notifications

Replace the sentence of the bullet "**Messaging is realtime + RLS-scoped.**" that starts "The table is in `supabase_realtime` with `REPLICA IDENTITY FULL`; [hooks/useMessages.js]" with:

The table is in `supabase_realtime` with `REPLICA IDENTITY FULL`; [hooks/useMessages.js](../src/hooks/useMessages.js) opens **one** channel from `AppShell` (`useMessagesRealtime`) with three bindings (`messageBindings` in [lib/messageCache.js](../src/lib/messageCache.js)): `recipient_id=eq.<me>`, `sender_id=eq.<me>`, and an unfiltered `DELETE`, since a deletion carries the id alone under row-level security and Realtime does not filter it on a column. An event patches the entries that show its message and reads nothing — see the next bullet.

## docs/INVARIANTS.md — Messaging / notifications

Add after the bullet that starts "**Messaging is realtime + RLS-scoped.**":

- **A message event changes the entries that show its message, and only them; it never invalidates the `['messages']` root.** `applyMessageChange` in [lib/messageCache.js](../src/lib/messageCache.js) puts an INSERT into its pair's thread (by time, the newest `THREAD_LIMIT` kept), the conversation list (last message, unread count, order) and `['messages', 'unread-count', me]`; an UPDATE merges the row; a DELETE removes the id from every cached thread and moves the conversation back to the message before it. Every other pair's thread keeps the same array. A message with a `session_id` also fills `['messages', 'session-feedback', sessionId]` and, for the athlete, `['messages', 'my-feedback-session-ids', me]` — the feedback card, the pill and the re-read of the session row in `SessionView` hang on those two. The rules that keep the counts right: the cache writes exactly the columns its read selects (7 for a message, 6 for the feedback entry), timestamps in PostgREST's form (`normalizeTimestamp` in [lib/realtimeCache.js](../src/lib/realtimeCache.js): Realtime hands timestamptz over as Postgres text, which Safari's `Date` cannot read); an unread count moves only by what a **whole** entry (cached, not invalidated) says the message was before, so one change applied twice — by the mutation and by its echo, by two bindings, after a refetch that already had it — counts once, and the id of a deleted message is remembered for that; when no whole entry can say, the exact keys `['messages', 'unread-count', me]` and `['messages', 'conversations', me]` are read again, gathered for `REFRESH_DELAY_MS` so a burst of N events asks once (`createRefresher`); `payload.old` is never read for a column (it is the primary key alone); an entry marked as behind is not patched (writing it would mark it current) and one being read when its event arrives is read again (`patchCached`). `useSendMessage`, `useDeleteMessage` and `useMarkThreadRead` (which asks for the rows it changed with `.select('id, read_at')`) apply their own change through the same functions instead of invalidating the root.

## docs/INVARIANTS.md — Messaging / notifications

Add after the bullet that starts "**A message event changes the entries that show its message**":

- **The chat and bell channels outlive a lost connection, and the cache is read again whenever events may have been missed.** Both hooks open their channel through `watchPostgresChanges` in [lib/realtimeChannel.js](../src/lib/realtimeChannel.js). `CHANNEL_ERROR` and `TIMED_OUT` leave the channel to the client, which joins it again by itself; it is removed only after `MAX_JOIN_FAILURES` failed joins in a row with no `SUBSCRIBED` between them, and opened again with a new count on the next `online` or `visibilitychange`; a channel the server closed is opened again then, or once it is `REOPEN_AFTER_MS` old. Each opening has a topic of its own (`<topic>-<n>`): the client hands back a channel that is still leaving under the same name. The root is invalidated on every `SUBSCRIBED` (the first included: what the page read while the channel was joining reached it on no channel), on `online` and on `visibilitychange` to visible (a suspended page is not told its socket died); the last two together ask once (`RESYNC_GAP_MS`). The messages resync leaves `['messages', 'session-refs', …]` alone: it reads `sessions`. Removing a channel on the first error — what the hooks did — freezes the chat and the bell until a reload after every dropped socket and every iOS suspension.

## docs/INVARIANTS.md — Messaging / notifications

Replace "New incoming feedback invalidates the `[messages]` subtree via `useMessagesRealtime`, so the pill appears without a manual refresh." (end of the bullet "**Student surfaces feedback in two places.**") with:

New incoming feedback is patched into `['messages', 'my-feedback-session-ids', me]` and `['messages', 'session-feedback', sessionId]` by `useMessagesRealtime`, so the pill and the card appear without a manual refresh.

## docs/INVARIANTS.md — Messaging / notifications

Replace "They are the only DELETE on `notifications`: there is still no client policy for it, and `useNotificationsRealtime` already listens to every event." (in the bullet "**A notification about something the athlete can take back is removed with it, while it is unread.**") with:

They are the only DELETE on `notifications`: there is still no client policy for it. `useNotificationsRealtime` hears them on its unfiltered `DELETE` binding (`notificationBindings` in [lib/notificationCache.js](../src/lib/notificationCache.js); its other binding is `recipient_id=eq.<me>`), which carries the id alone: the line is taken out of `['notifications', 'list', me]` and an unread one lowers `['notifications', 'unread-count', me]`; an id that a whole list shorter than `NOTIFICATIONS_PAGE_SIZE` does not hold was someone else's and changes nothing, and one a full page does not hold reads the count again.

## docs/ARCHITECTURE.md — React Query — who owns which key

Add two rows at the end of the table:

| [useMessages](../src/hooks/useMessages.js) | `['messages', 'thread', …pairKey]` (the newest `THREAD_LIMIT`, oldest first), `['messages', 'conversations', me]`, `['messages', 'unread-count', me]`, `['messages', 'session-feedback', sessionId]`, `['messages', 'my-feedback-session-ids', me]`, `['messages', 'session-refs', ids]`; keys built by `messageKeys` in [lib/messageCache.js](../src/lib/messageCache.js) | none broad: send, delete, mark-read and every realtime event patch the entries of their message (`applyMessageUpsert` / `applyMessageDelete`); a change no whole entry can place invalidates `['messages', 'unread-count', me]` and `['messages', 'conversations', me]` by exact key; the root is invalidated only by the channel's resync. A feedback send also drops `['all-confirmations']` and `['session', sessionId]` |
| [useNotifications](../src/hooks/useNotifications.js) | `['notifications', 'list', me]` (newest `NOTIFICATIONS_PAGE_SIZE`), `['notifications', 'unread-count', me]` | mark-read and mark-all invalidate `['notifications']`; realtime events patch the list and the count ([lib/notificationCache.js](../src/lib/notificationCache.js)); the channel's resync invalidates `['notifications']` |

## CLAUDE.md — Repo map

Replace the `lib/` line "pushNotifications.js  sessionQueue.js (buildQueue/buildDayStrip —" with:

```
                 pushNotifications.js  realtimeChannel.js (watchPostgresChanges — a
                 Realtime channel that outlives a lost connection)  realtimeCache.js
                 messageCache.js  notificationCache.js (patch the chat and bell
                 caches from one event)  sessionQueue.js (buildQueue/buildDayStrip —
```

## CLAUDE.md — Repo map

Replace the `test/` line "fakePostgrest.js (supabase.from() double that cuts at 1000 rows)" with:

```
                 fakePostgrest.js (supabase.from() double that cuts at 1000 rows)
                 fakeRealtime.js (supabase.channel()/removeChannel() double:
                 statuses, filtered bindings, events as realtime-js hands them over)
```

## CLAUDE.md — Feature → files map, row "Messaging (coach ↔ student)"

Replace the row's file list with:

`messaging/MessageThread`, `messaging/MessageComposer`, `messaging/ConversationList`, `messaging/UnreadMessagesBadge`, `messaging/SessionReferenceCard`, `coach/CoachMessages`, `student/StudentMessages`, `hooks/useMessages`, `lib/messageCache` (the keys, the bindings, and the patch of the cache from one change: an event, a send, a delete, a mark-read — never the whole root), `lib/realtimeCache` (`normalizeTimestamp`, `patchCached`, `createRefresher`), `lib/realtimeChannel` (`watchPostgresChanges`: the channel survives errors and resyncs on SUBSCRIBED, online and visible). Tests: `hooks/useMessages.realtime.test.jsx`, `lib/messageCache.test.js`, `lib/realtimeChannel.test.js`, on `test/fakeRealtime`

## CLAUDE.md — Feature → files map, row "Notifications (in-app bell)"

Replace "`notifications/NotificationBell` (rendered inside `ui/UserMenu`), `hooks/useNotifications`," with:

`notifications/NotificationBell` (rendered inside `ui/UserMenu`), `hooks/useNotifications`, `lib/notificationCache` (realtime events patch the list and the count; the channel through `lib/realtimeChannel`), tests `hooks/useNotifications.realtime.test.jsx`,
