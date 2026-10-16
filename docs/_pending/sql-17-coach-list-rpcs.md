# sql-17-coach-list-rpcs — docs to fold (wave 3, items: none)

Each block: target doc, section, then the text to fold in.

## docs/INVARIANTS.md — RLS / DB conventions

Add after the bullet that starts "**A coach-wide read names the coach; RLS is not the tenant filter.**":

- **The coach's two lists have a read function each, which names its caller and answers what the app's fold answers.** `public.coach_review_counts()` gives `(student_id, to_review)`: one row per athlete of `auth.uid()` (`students.coach_id`) who has confirmations of sessions neither reviewed nor archived, in a block out of the trash — `student_id` is `students.id`, never the profile id that `session_confirmations.student_id` holds — and no row for an athlete with none. `public.my_conversations()` gives one row per account the caller has exchanged a message with, the newest conversation first: `counterpart_id`, `full_name` (NULL when the caller may not read that profile — a former coach after `transfer_student` — or when it is empty), `last_body`, `last_at`, `unread`, then `last_id`, `last_sender_id`, `last_recipient_id`, `last_session_id`, `last_read_at`, so that the newest message comes back in the seven `MESSAGE_COLUMNS` of `src/lib/messageCache.js`; two messages at the same time are ordered by `id`. Migration `2026_10_16_26_coach_list_rpcs.sql`, `optional`: both are `STABLE` and `SECURITY INVOKER`, in the allow-list of the `FUNCTION PRIVILEGES` block and in `RPCS` of `supabase/tests/function-acl.test.js`; a request without a user id gets no row and no error. They are the fold of `reviewCountsByStudent` (`src/lib/coachRoster.js`) over the read of `useAllConfirmations`, and the fold of `useConversations` (`src/hooks/useMessages.js`), taken over every row instead of the newest 1000 the API answers: `supabase/tests/coach-list-rpcs.test.js` holds each to a copy of its fold, past 1000 rows, and for a coach who is somebody's athlete. A change of what a list means changes the function, the hook and that test together. A client calls them only with a way without them — on `PGRST202`, a project that skipped the migration, it reads the rows itself — and no migration may require them. Columns are added at the end of a list, never renamed: a `RETURNS TABLE` changes only by a drop and a create (`supabase/migrations/README.md`, "A migration that adds a read function for a list the coach sees").

## docs/INVARIANTS.md — Messaging / notifications

In the bullet that starts "**Messaging is realtime + RLS-scoped.**", replace "Conversations roll-up is a client-side fold over recent rows — fine at coach scale, swap for an RPC if the table grows." with:

The conversation list is one row per counterpart. `useConversations` folds it from the rows of `messages` — of which the API answers the newest 1000 — and the database gives the same roll-up in one request over every row: `public.my_conversations()` (migration `2026_10_16_26_coach_list_rpcs.sql`, optional; the bullet "The coach's two lists have a read function each" of "RLS / DB conventions").

## docs/INVARIANTS.md — Coach Athletes-roster layout

In the bullet that starts "**The Athletes roster merges the old Dashboard + Students tabs.**", replace "grouped by `student_id`)" with:

grouped by `student_id`; the same count per athlete is `public.coach_review_counts()` in the database — migration `2026_10_16_26_coach_list_rpcs.sql`, optional — written with the same predicate, which `supabase/tests/coach-list-rpcs.test.js` holds to `reviewCountsByStudent`)

## CLAUDE.md — Feature → files map, row "Coach Athletes roster (attention-first list; merged Dashboard + Students into one tab)"

At the end of the row, add:

. The to-review count per athlete is also a function of the database, `coach_review_counts()` — `(student_id = students.id, to_review)`, the same predicate, one row per athlete with something to review — in the optional migration `2026_10_16_26_coach_list_rpcs.sql` (tests `supabase/tests/coach-list-rpcs.test.js`, page `docs/runbook/migrations/26-coach-list-rpcs.md`)

## CLAUDE.md — Feature → files map, row "Messaging (coach ↔ student)"

At the end of the row, add:

. The conversation list is also a function of the database, `my_conversations()` — one row per counterpart, the newest first, with the unread count and the seven columns of the newest message (`last_id`, `last_sender_id`, `last_recipient_id`, `last_body`, `last_session_id`, `last_read_at`, `last_at`) — in the optional migration `2026_10_16_26_coach_list_rpcs.sql` (tests `supabase/tests/coach-list-rpcs.test.js`)

## CLAUDE.md — Feature → files map, row "DB / RLS test suite (`npm run test:db`)"

After the description of `storage-policies.test.js` (snippet `sql-16-storage-video-policies`), before "The migration tests are the next row.", add:

`coach-list-rpcs.test.js` (the two read functions of the optional migration `2026_10_16_26_coach_list_rpcs.sql`: `coach_review_counts()` and `my_conversations()` against copies of the app's folds — `reviewCountsByStudent` over the read of `useAllConfirmations`, `useConversations` — on the same rows: reviewed, archived, in the trash, a block waiting, an athlete with nothing to review, both directions, read and unread, feedback, a name that is empty, a counterpart whose profile the caller no longer reads after `transfer_student`, two messages at the same time; past 1000 rows, where the app's read is cut and the functions are not; a coach who is somebody's athlete, whose own block row-level security alone would count; another coach, an athlete, the service role and `anon`; `STABLE`, `SECURITY INVOKER`, the search_path, what each answers; the migration on the frozen baseline — the functions not there before, answering after, gone after the rollback, no row written — with the audit table and the check of its runbook page read off the page; refused as another role, next to a function of one of its names, without a column it reads; its rollback not refused for a later migration).
