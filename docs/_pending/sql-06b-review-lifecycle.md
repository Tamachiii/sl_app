# sql-06b-review-lifecycle — docs to fold (wave 1, items P57)

Each block: target doc, section, then the text to fold in.

## docs/INVARIANTS.md — Coach session review

Add after the bullet that starts "**Coach session review is one-shot per session.**" (and after the bullet "**A review needs a confirmation, and the page offers its feedback step only on a confirmation READ SINCE IT OPENED.**" that `docs/_pending/coach-review-needs-confirmation.md` adds there):

- **A review needs a confirmation and closes it — and the database holds both, for a request that carries a user id.** Migration `2026_10_13_09_review_lifecycle.sql` (review P57) ties `session_confirmations` to `sessions.reviewed_at` in three places. *A review needs a confirmation*: the trigger `trg_review_needs_confirmation` (BEFORE UPDATE on `sessions`, function `review_needs_confirmation`) refuses `reviewed_at` going from NULL to a value while the session has no confirmation — `42501`, "session … is not confirmed by its athlete — it cannot be marked as reviewed" — which is what `useMarkSessionReviewed` meets, and what `notify_student_on_session_feedback` meets when it stamps the review, so the feedback message is undone with it; the INSERT policy of `messages` asks `session_is_confirmed(session_id)` of a message that names a session, so the API answers a policy refusal first. *A review closes the confirmation*: the athlete's UPDATE and DELETE policies on `session_confirmations` ask `session_writable(session_id)` — neither archived nor reviewed — so "Undo confirmation" on a reviewed session reaches no row. *When the two cross*: a policy judges the database as its statement saw it when it started, so `block_confirmation_delete_when_reviewed` (BEFORE DELETE) reads the session again `FOR SHARE` and raises `42501` for the undo that lost the race, and `review_needs_confirmation` is `VOLATILE` so that it reads the confirmations as they are once the row of the session is locked. Rules to keep:
  - **"Reviewed" does not mean "confirmed".** Sessions reviewed without a confirmation exist from before the migration, and the owner of the database and the service role are not judged (no user id): removing an account cascades to its confirmations, and a review is taken back by hand (`docs/runbook/migrations/09-review-lifecycle.md`, "Taking a review back" — there is no reopening in the app). The trigger judges the transition from NULL to a value only: such a session is still archived, restored, renamed, reordered and moved with `move_session`.
  - **A reviewed session can still be confirmed, and that confirmation is final.** The INSERT policy of `session_confirmations` does not ask about the review, on purpose: `buildQueue` keeps a session in the athlete's list until it is confirmed or archived. Do not add `session_writable` to it.
  - **A function that marks sessions as reviewed for a coach meets the trigger**, one session or many: the whole statement is refused as soon as one of them has no confirmation. Filter on the confirmation in the statement.
  - **`review_needs_confirmation` stays `VOLATILE` and `trg_review_needs_confirmation` keeps a name that sorts after `trg_pin_draft_session_columns`.** `STABLE` reads the confirmation that has just been taken back; a name that sorts before the pin raises on a session of a draft, where the pin of migration 06 is silent. No test on one connection sees the first: `supabase/tests/review-lifecycle.test.js` has three on several connections.
  - **A confirmation sent twice is insert-or-nothing.** An upsert that updates (`ON CONFLICT DO UPDATE`, what the app deployed before wave 1 sends) is judged by the UPDATE policy and raises `42501` once the session is reviewed; `confirmSessionFn` sends `ON CONFLICT DO NOTHING`, which is an INSERT only and writes nothing.

## docs/INVARIANTS.md — Messaging / notifications

Add after the bullet that starts "**Notifications are SECURITY DEFINER trigger-driven.**":

- **A notification about something the athlete can take back is removed with it, while it is unread.** Two AFTER DELETE triggers of migration `2026_10_13_09_review_lifecycle.sql` (review P57, L12): `trg_retract_session_completed_notification` on `session_confirmations` deletes the unread `session_completed` rows of the session (matched on `payload->>'session_id'` and `payload->>'confirmation_id'`), and `trg_retract_slot_deviation_notifications` on `slot_deviations` deletes the unread `session_deviation` and `promote_requested` rows of the exercise slot (`payload->>'slot_id'`). So confirm, undo, confirm leaves one line in the coach's bell, and a skip that is undone leaves none. A row the coach has read stays: it is their history, and its link may lead to a review page that says the session is not confirmed. Both fire on a cascade too — a session or an exercise that is deleted. They are the only DELETE on `notifications`: there is still no client policy for it, and `useNotificationsRealtime` already listens to every event. **A new kind of notification about a row that can be taken back names that row in its payload and gets its own AFTER DELETE trigger**; without it the bell keeps a line about something that no longer exists. The push of a confirmation carries the tag `session-confirm-<session id>`: with the id of the confirmation, which is a new one after each undo, the pushes of one session stacked on the lock screen — keep the tag when `notify_coach_on_session_confirm` is re-created.

## docs/INVARIANTS.md — RLS / DB conventions

Replace, in the first of the five bullets that `docs/_pending/sql-06a-session-write-gates.md` adds ("**A session is read-only for its athlete when its program is not the block being trained, …**"), the sentence "`session_confirmations` is not one of the five: its policies ask "not archived" and "program active", not "not reviewed"." with:

`session_confirmations` is not one of the five, and since migration `2026_10_13_09_review_lifecycle.sql` it is closed by the review all the same: its UPDATE and DELETE policies ask "program active" and `session_writable(session_id)`. Its INSERT policy asks "not archived" and "program active", and nothing about the review (see "A review needs a confirmation and closes it", under Coach session review).

Replace, in the second of those bullets ("**`session_writable` is the lock of the SESSION and says nothing about the program.**"), the sentence "`session_writable(uuid)` is not executable by a signed-in user — no policy calls it; `session_writable_for_slot` does, as its owner." with:

`session_writable(uuid)` and `session_writable_for_slot(uuid)` are both executable by a signed-in user: the first is asked of a session id by the UPDATE and DELETE policies of `session_confirmations`, the second of a slot by the five surfaces.

Replace, in the third of those bullets ("**The lock is `reviewed_at`, not the confirmation.**"), the three sentences from "The two are independent in the other direction too:" to "The way out for its athlete is the confirmation, which the database accepts on a reviewed session: `session_confirmations` is not one of the five surfaces." with:

The app can no longer make a session reviewed without a confirmation (migration `2026_10_13_09_review_lifecycle.sql`), but such sessions exist — reviewed before that migration from a `session_deviation` notification while the athlete was still training, or whose confirmation was undone after the review — and the owner of the database can still make one. Such a session is closed like any reviewed one, while `buildQueue` — which drops a session when it is confirmed or archived, never when it is reviewed — keeps listing it as to do. The way out for its athlete is the confirmation: the INSERT policy of `session_confirmations` does not ask about the review, and a confirmation made on a reviewed session cannot be undone.

## docs/ARCHITECTURE.md — Read-only gate on past-program sessions

Replace, in the bullet "- **RLS gate** —" as `docs/_pending/sql-06a-session-write-gates.md` rewrites it, the sentence "`session_confirmations` keeps its own split policies (not archived, program active)." with:

`session_confirmations` has its own four: SELECT by ownership, INSERT with "not archived" and "program active", UPDATE and DELETE with "program active" and `session_writable(session_id)` — a confirmation can be made on a reviewed session, and not changed or taken back (migration `2026_10_13_09_review_lifecycle.sql`). The INSERT policy of `messages` asks `session_is_confirmed(session_id)` of a feedback message.

## CLAUDE.md — Feature → files map, row "Coach session review"

Add to the end of the row:

. The database refuses the review of a session its athlete has not confirmed and closes the confirmation of a reviewed one: migration `2026_10_13_09_review_lifecycle.sql` (`review_needs_confirmation`, `session_is_confirmed`, `block_confirmation_delete_when_reviewed`), tests `supabase/tests/review-lifecycle.test.js`; reopening a reviewed session is the owner's SQL, `docs/runbook/migrations/09-review-lifecycle.md`

## CLAUDE.md — Feature → files map, row "Notifications (in-app bell)"

Replace the row's file list with:

`notifications/NotificationBell` (rendered inside `ui/UserMenu`), `hooks/useNotifications`, DB triggers `notify_coach_on_session_confirm` + `notify_student_on_session_feedback`; a confirmation, a swap or a skip that is taken back removes its unread rows (`retract_session_completed_notification`, `retract_slot_deviation_notifications`, migration `2026_10_13_09_review_lifecycle.sql`)

## CLAUDE.md — Feature → files map, row "DB / RLS test suite (`npm run test:db`)"

Add to the row's file list, after the entry for `session-gates.test.js` (the one `docs/_pending/sql-06a-session-write-gates.md` adds):

`review-lifecycle.test.js` (a review needs a confirmation and closes it: the confirm of the app deployed before wave 1 — an updating upsert — and of wave 1 — insert or nothing — replayed before and after a review; feedback and "Finish without feedback" on a session that is not confirmed; a session reviewed without a confirmation still archived, reordered and moved; a review and an undo that cross, on three connections; the coach's bell after confirm, undo, confirm and after swap, undo, skip; the tag of the push; migration `2026_10_13_09_review_lifecycle.sql` tried on the frozen baseline — holes before, closed after, back after its rollback — with the audit table, the check and the statements of its runbook page read off the page, and the stale notifications it deletes)

## README.md — Database Tests

Replace "A run reports 10 files and `218 passed | 7 expected fail`" with the file and test counts of the wave-1 gate run. This package brings the count to 20 files and `708 passed | 1 expected fail`.

Add after the bullet that starts "- `session-gates.test.js` holds the rule" (the one `docs/_pending/sql-06a-session-write-gates.md` adds):

- `review-lifecycle.test.js` holds "a review needs a confirmation, and closes it". Three of its tests are about two requests that cross — a review and an undo sent in the same instant — and one connection cannot show that: `cross({ first, second })` runs the first request and holds it open, uncommitted, starts the second, waits until `pg_stat_activity` shows it waiting for a lock, and only then commits the first. They commit what they write, so they have an athlete and a block of their own. A rule that a policy or a `STABLE` function holds alone gets such a test: both judge the database as their statement saw it when it started.

## docs/RUNBOOK.md — new section "Checkpoint A2 — …", after the section of Checkpoint A1

Add when Checkpoint A2 is handed over (its row marked **ready**). The part of the sequence that belongs to migration 09, after the steps of migration 08, every command taken from `docs/runbook/migrations/09-review-lifecycle.md` as it stands there, one per fence:

1. the audit of migration 09 — it reads as the "before" column of the page's table. **Line 12 must read `none`**: otherwise stop and report the line, the migration would undo itself. **Lines 14 and 15 are noted**: they are the notifications the migration deletes — unread, about a confirmation, a swap or a skip that no longer exists — and they do not come back with a rollback. Line 13 is noted and stops nothing;
2. the migration;
3. the audit again — lines 2 to 8 read `yes`, line 10 lists `session_is_confirmed(uuid); session_writable(uuid)`, lines 14 and 15 read `0`, line 13 is the number of step 1;
4. the page's check, which must fail with `check only, nothing was written: protected: a confirmation is taken back until the review and not after, and a session that is not confirmed is not marked as reviewed` — `BROKEN` means roll back; `NOT PROTECTED`, `NOT TRIED` or a message that does not start with `check only` means stop and report; `nothing to try` leaves the audit of step 3 as the answer;
5. the smoke check in the app that is deployed, as the test athlete (step 4 of the page's "After": confirm the next session, undo the confirmation), only once step 4 above answered `protected`.

Say with the rollback of migration 09, in the words of its page: an athlete's "I cannot undo my confirmation" is not a reason to roll back when the coach has reviewed the session. The review of that one session is taken back with the statement of the page's section "Taking a review back".

Add to what the coach is told at this checkpoint, three lines: from migration 09 on, an athlete can no longer undo the confirmation of a session you have reviewed — to correct one, they write to you, and the owner reopens that session; you review a session once its athlete has confirmed it — on a session that is not confirmed, the app that is deployed answers "You don't have permission to do that." to *Finish without feedback* and shows a database sentence in the feedback box, until the next version of the app is deployed; and lines in your bell that you had not read, about a confirmation or a skip that was undone, are gone.
