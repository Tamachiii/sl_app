# sql-14-drafts-coach-readonly — docs to fold (wave 3, items P53)

Each block: target doc, section, then the text to fold in.

## docs/INVARIANTS.md — `set_logs` — per-set targets, outcomes, RPE

In the bullet that starts "**Student program authoring is an approval-gate model, ONLINE-ONLY for v1 (Phase 3.4).**", replace the sentence that starts "Students **never write `set_logs`** while drafting —" up to "needs no draft exception." with:

Students **never write `set_logs`** while drafting, and since migration `2026_10_16_20_drafts_coach_readonly.sql` (review P53) nobody else writes the tree of a draft either — see the bullet "**The tree of a draft is its author's.**" below. [`approve_program`](../supabase/schema.sql) (coach-only SECURITY DEFINER; self-authorizes with `auth.uid() IS NULL OR v_coach_id IS DISTINCT FROM auth.uid()`, where `v_coach_id` is `students.coach_id`) flips `status='approved'` FIRST — `UPDATE … WHERE id = p_program_id AND status = 'draft'`, and `{ approved: false }` when that finds no row —, then clears the four session columns, drops the sets without a target (not `is_student_added`, no `target_reps` and no `target_duration_seconds`, not `set_log_is_logged`, no video) and materializes the missing sets from the slot scalars, so `pin_set_log_targets_for_student` needs no draft exception. It answers `{ approved: true, set_logs_created: n }` as before, `n` counting the sets written again.

## docs/INVARIANTS.md — `set_logs` — per-set targets, outcomes, RPE

Add after the bullet that starts "**Student program authoring is an approval-gate model, ONLINE-ONLY for v1 (Phase 3.4).**":

- **The tree of a draft is its author's: the coach approves a draft, sends it back, renames it, trashes it and deletes it — and changes nothing in it.** `block_draft_tree_write` (one trigger name on `weeks`, `sessions`, `exercise_slots` and `set_logs`, one `STABLE SECURITY DEFINER` function per table: `block_draft_week_write`, `block_draft_session_write`, `block_draft_slot_write`, `block_draft_set_log_write`; migration `2026_10_16_20_drafts_coach_readonly.sql`, review P53) refuses with `P0001` `draft_read_only` a write that carries a user id other than `programs.created_by` on a row of a program whose `status` is `draft` — in the trash or not; an `UPDATE` is judged on its parent as it was and as it would be, so nothing moves into or out of a draft. The coach's policies on the four tables are `FOR ALL` and never look at `status`: without the trigger a coach's edit was accepted and then lost at the athlete's next `save_draft_tree` (which deletes the phases and writes them again from the phone), and the rows of a higher "Sets" — written by `reconcileSetLogCount` with the targets of a last row a draft does not have — outlived the approval without reps or load. What goes through: a request without a user id (SQL editor, migration, service role); the author, as the policies decide; a row whose parent is gone — the cascade of a delete, which is how the coach deletes a draft. The row of `programs` has no such trigger. The name sorts before every other `BEFORE` trigger of the four tables, so the refusal answers before any guard or pin. An `INSERT` is judged by its triggers before row-level security: a stranger's insert into a draft is answered `draft_read_only`, not `42501`. A program made a draft again by hand (`created_by` NULL) is written by nobody who signs in until `approve_program`. A `SECURITY DEFINER` function called by the coach is the coach: one that writes the tree of a draft for them marks it approved first, as `approve_program` does — written the other way round, `approve_program` is refused its own sets. `supabase/tests/drafts-readonly.test.js` holds it; the page `docs/runbook/migrations/20-drafts-coach-readonly.md` has the check.

## docs/INVARIANTS.md — `set_logs` — per-set targets, outcomes, RPE

In the bullet that starts "**A session of a DRAFT carries no `reviewed_at`, no `archived_at`, no `performed_at` and no `scheduled_date` — whoever writes it.**", replace "Consequences: the coach cannot archive or date a session of a draft either — the write is accepted and not kept, both are done after approval;" with:

Consequences: nobody archives or dates a session of a draft — both are done after approval; the coach's write on a draft is refused before the pin is reached (`block_draft_tree_write`, previous bullet), the author's, the owner's and the service role's are accepted and not kept;

and replace "The policies do not see it either, so the author and the coach are refused (`42501`);" with:

The policies do not see it either, so the author is refused (`42501`) — and the coach, whose week is refused first (`P0001` `draft_read_only`);

## CLAUDE.md — Feature → files map, row "Coach approve / send-back of a submitted draft (Phase 3.4c)"

Replace "Approve materializes set_logs and flips `status='approved'` **inactive** — the coach then Sets active" with:

Approve flips `status='approved'` **inactive** first, drops the sets without a target and materializes the missing ones — the coach then Sets active. The coach writes nothing in a draft's tree: `block_draft_tree_write` on `weeks`/`sessions`/`exercise_slots`/`set_logs` refuses (`P0001` `draft_read_only`) anyone with a user id but its author — migration `2026_10_16_20_drafts_coach_readonly.sql`, tests `supabase/tests/drafts-readonly.test.js`, page `docs/runbook/migrations/20-drafts-coach-readonly.md`

## CLAUDE.md — Feature → files map, row "DB / RLS test suite (`npm run test:db`)"

Add before "`auth-accounts.test.js` (the "who has an account" query":

`drafts-readonly.test.js` (the tree of a draft is its author's: every request of the coach's editor on a draft sent in, one being written and one in the trash refused with `draft_read_only` and nothing written; moves into and out of a draft; the copy and reorder RPCs; the coach still approves, sends back, renames, trashes and deletes a draft — the cascade finds no parent — and duplicates it into a block; the author's `save_draft_tree`, discard and own writes; a stranger's insert; the owner and the service role; a block made a draft again; `approve_program` dropping the sets without a target and writing them from the exercise, keeping the rest; an author's save and a second approval that cross an approval, on two connections; migration `2026_10_16_20_drafts_coach_readonly.sql` tried on the frozen baseline — holes before, closed after, back after its rollback — with the audit table, the check and the list of drafts of its runbook page read off the page);

## docs/ARCHITECTURE.md — Auth and Row-Level Security

Add after the paragraph that starts "**Rows two sides write.**":

**The tree of a draft.** A draft (`programs.status = 'draft'`) is written by its author: their own-draft policies on `weeks`, `sessions` and `exercise_slots`, and `save_draft_tree`, which replaces the whole tree on every save. The coach's policies on those tables are `FOR ALL` and do not look at `status`, so a trigger closes the tree to everyone else who carries a user id — `block_draft_tree_write` on `weeks`, `sessions`, `exercise_slots` and `set_logs` (`P0001` `draft_read_only`). The coach acts on the row of the program only: `approve_program`, `send_back_program`, a new name, the trash, a delete. `approve_program` marks the program approved before it writes anything, holds the row until it commits — an author's save that arrives meanwhile waits and is then refused by the author's `UPDATE` policy, which asks for a draft —, and writes every set from the exercise that has no set with a target. After the approval the block is the coach's to edit like any other.
