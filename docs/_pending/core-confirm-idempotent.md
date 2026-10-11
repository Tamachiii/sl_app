# core-confirm-idempotent — docs to fold (wave 1, items B13)

Each block: target doc, section, then the text to fold in.

## docs/INVARIANTS.md — Offline-safe student writes

Replace, in the bullet that starts "Offline-safe student writes are wired through one allow-list", the sentence "Replay-idempotency is the caller's job: prefer UPSERT over INSERT (`useConfirmSession` upserts on `session_id`, `useSaveSlotComment` upserts on `exercise_slot_id`) so a queued write replayed against an already-mutated row no-ops instead of tripping a UNIQUE constraint." with:

Replay-idempotency is the caller's job: a queued write replayed against a row that already exists must not trip a UNIQUE constraint, so nothing in the queue is a bare INSERT. `useSaveSlotComment` and `useSaveSlotDeviation` upsert on `exercise_slot_id` and the last writer wins; `useConfirmSession` is insert-or-nothing on `session_id` and the first writer wins (next bullet).

## docs/INVARIANTS.md — Offline-safe student writes

Add after the bullet that starts "Offline-safe student writes are wired through one allow-list":

- **A confirm is insert-or-nothing: the first confirmation of a session is the one that stays.** `confirmSessionFn` in [`lib/offlineMutations.js`](../src/lib/offlineMutations.js) upserts on `session_id` with `ignoreDuplicates: true` — PostgREST runs it as `INSERT … ON CONFLICT (session_id) DO NOTHING` — and reads the answer with `.maybeSingle()`. A second confirm is not exotic: it is the replay of a confirm whose first attempt reached the server but whose answer was lost, or a second device whose persisted cache still shows the session as unconfirmed. It writes nothing, so the athlete's note, `performed_on` and the `sessions.performed_at` mirror stay those of the first confirm, and the statement never reaches the UPDATE policy on `session_confirmations`. Both halves are load-bearing. Without `ignoreDuplicates` the same call is `DO UPDATE` on every column of the payload: the replay replaces the note with its own (usually NULL) and moves the training date. With `.single()` in place of `.maybeSingle()` the empty answer of a duplicate becomes a `PGRST116` error — a toast and a rolled-back screen for a session that is confirmed. The mutation therefore resolves the inserted row, or `null` for a duplicate: nothing may read its result as "the confirmation", and `useConfirmSession` refetches `['session-confirmation', sessionId]` on settle. A refusal of the INSERT itself (session archived, block no longer active) still fails the mutation. The only way to change a confirmation is undo, then confirm again — a DELETE, then a fresh INSERT, replayed in that order by the `offline-writes` FIFO scope. The cases are in `src/lib/offlineMutations.test.js`, which sends the request through the real supabase-js query builder and answers `fetch` by PostgREST's rules: a mocked `.upsert()` chain cannot tell `DO NOTHING` from `DO UPDATE`.

## docs/INVARIANTS.md — The date a session was actually trained

Replace, in the bullet that starts "The mirror is maintained by its own trigger, `sync_session_performed_at`", the sentence "The mirror needs the UPDATE branch (an offline confirm replays as an upsert) and the DELETE branch (undoing a confirmation un-performs the session, so `performed_at` goes back to NULL)." with:

The mirror needs the DELETE branch (undoing a confirmation un-performs the session, so `performed_at` goes back to NULL) and an UPDATE branch. The app's own confirm does not reach the UPDATE branch — it is insert-or-nothing, see "Offline-safe student writes" — but a `performed_on` corrected in SQL does, and so does an installed client that still sends the confirm as an updating upsert.

## README.md — Offline Support (Student Session Logging)

Replace the bullet that starts "**Conflict policy** — last-writer-wins per row." with:

- **Conflict policy** — each write is targeted at one `set_log` / `slot_comment` / `slot_deviation` / `session_confirmation`, and payloads are field-scoped. Set logs, comments and deviations are last-writer-wins; DB CHECKs (`set_logs_done_xor_failed`, `set_logs_no_rpe_when_failed`) are encoded in the patch helpers, so replays stay constraint-safe. A confirmation is first-writer-wins: `useConfirmSession` inserts or does nothing (an upsert on `session_id` with `ignoreDuplicates`), so a confirm replayed against a session that is already confirmed keeps the first note and training date. Changing a confirmation is undo, then confirm again. `useUnconfirmSession` is naturally idempotent (DELETE WHERE missing-row = no-op), `useSaveSlotComment` upserts on `exercise_slot_id` and turns empty bodies into deletes.
