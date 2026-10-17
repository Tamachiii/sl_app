# BACKLOG — what the 2026-09 review left for the redesign project

The review of 2026-09-30 produced a plan of ten waves. The owner cut it twice — on 2026-10-16, then on 2026-10-17 — so that the new design can start sooner: the campaign ends with wave 3 and Checkpoint C1. Everything on this page was **not built** in the current design. It is to be built once, in the new one, and nothing here is half done: no migration of it is written, no client code waits for it.

Each entry names its package — the id it has in the review's plan, `review-2026-09-30/execution-plan.md`, which lives in the owner's checkout only — and the findings it answers: `P…` and `B…` from the code review, `L…` from the review of the live app, `N…` from the production addendum, `product-N` from the product proposals. The migration numbers are the ones the plan reserved; the manifest stops at 26, and a later project numbers its own from 27.

## 1. Translation and accessibility of every screen

The sweeps of wave 4. They were to go over the screens of today one folder at a time; the redesign replaces those screens, so they are built into the new ones instead.

| Package | What it is | Findings |
|---|---|---|
| `sweep-student-i18n` | every string of the athlete's screens in English, French and German — the set rows, the swap and skip bar, the notes, the exercise cards, the session page, the goals — and the day names, dates, numbers and plurals through `src/lib/i18n/format.js`; a scan test that fails on hard-coded text in `src/components/student/` | P63, P41 |
| `sweep-student-a11y` | the athlete's screens named and stated for a screen reader: each set says its number, its target and its state, a pill says its state in hidden text, a calendar day its date and status, every field has a label; axe-core over the session page, the training list and the calendar | P45 |
| `sweep-coach-i18n` | the same for the coach's review, its dialogs, the programming section and the library labels; the day pills of the sheet and the roster strip through `format.js`; a scan test for `src/components/coach/` | L17 |
| `sweep-coach-a11y` | no `aria-label` that hides what is on screen (roster cards, session rows), the program switcher as a plain disclosure, `aria-controls` only on a mounted panel, labels on the library fields and the editor's exercise picker; axe-core over the roster and the review | L16, B25, B46 |
| `sweep-shared-format` | the last copies of the locale table and every `n === 1` plural in shared components and hooks through `format.js`; the app's language written to `profiles.lang` at sign-in, on reconnect and on change, so that pushes can speak it (migration 32, section 2) | B43, B45 |
| `sweep-shared-strings` | the toasts raised from hooks and from the mutation layer, the video player and the other shared components in the three languages; the scan test for `ui`, `layout`, `messaging`, `notifications` and `auth` | — |
| `sweep-shared-a11y` | the notification and user popovers as disclosures with their focus handled, a hidden "unread" on a notification, the focus kept inside the video lightbox, a document title per route and the focus moved to the page heading on navigation, `autocomplete` on the login fields | B42, B47 |
| `i18n-lazy-languages` | English in the entry chunk, French and German loaded on demand (precached, the stored language loaded before the first paint) | B24 |
| `dead-code` | the hooks and helpers nothing calls any more (`useActiveProgram`, `useWeekConfirmedSessionIds`, `useProgramIdForWeek`, `sessionDayNumber`, `nextFreeDayNumber` — each after a search proves it has no caller), and the translation keys nothing uses | B23 |

Two things wait with them:

- **The dictionaries.** The strings of waves 0 to 3 are in `src/lib/i18n/fragments/<package-id>.<lang>.js`, merged into `messages` at run time (`src/lib/i18n/mergeFragments.js`). Folding them into `en.js`, `fr.js` and `de.js`, and making `src/lib/i18n/usage.test.js` fail on a key nothing uses, was the wave-4 wrap-up's. What is still printed in one language, or in the device's, is listed in `docs/INVARIANTS.md`, "Language of what is printed".
- **The weight of the first load.** The JavaScript the page loads before it draws — the entry chunk and the three vendor chunks it preloads (`router`, `query`, `supabase`) — was 171.0 kB gzip before the review, the plan's target until wave 4. It was 175.1 kB after wave 1, **193.3 kB after wave 2 (13 % above)** and **207.3 kB after wave 3 (21 % above**; the entry chunk alone 123.85 kB gzip). `i18n-lazy-languages` (two of the three languages out of the entry chunk) and `perf-self-hosted-fonts` (section 2) are the packages that were to bring it back under the target: the new design starts from that number.

## 2. The SQL performance and tooling packages of wave 4, and the upgrades of wave 9

The last wave of the cut plan was to run these with the cut. It was not run either (decision of 2026-10-17).

| Package | What it is | Findings | Migration |
|---|---|---|---|
| `sql-19a-rls-initplan` | every policy that calls `auth.uid()` per row calls it once per query (`(select auth.uid())`, `TO authenticated`), the program tree first, then the other tables; a catalog test proves that each expression is the old one, wrapped | L19 | 27, 28 |
| `sql-19c-rls-split-draft-policies` | the athlete's `FOR ALL` draft policies on the four tables of a block split into `INSERT`, `UPDATE` and `DELETE`, so that they take no part in every read | L19 | 29 |
| `sql-19b-hide-trashed-programs` | a block in the trash hidden from its athlete by the read policies; the coach still sees the trash | L22 (the programs half) | 30 |
| `sql-20-rls-set-based` | set-returning helpers instead of a lookup per row on `set_logs`, `slot_comments`, `slot_deviations` and `set_log_videos`, and their duplicate permissive policies merged — optional, only if the timings improve | B11, L19 | 31 |
| `sql-21-push-localization` | pushes written in the recipient's language: `profiles.lang` and a table of templates that no user can rewrite, `send_push_event(kind, params)` | P64 | 32 |
| `tooling-node-ci-matrix` | Node 22 in `.nvmrc`, `engines` and the workflows; the date and stats suites run again in CI under `America/Los_Angeles` and `Pacific/Kiritimati`; `npm run test:docs` in CI | B15, B21 | — |
| `tooling-backup-hardening` | the backup workflow keeps its schedule alive (GitHub disables one after 60 days without activity), writes a row-count manifest beside the dump, and a weekly job restores the last artifact into a throw-away PostgreSQL | P67 (the rest of it) | — |
| `perf-self-hosted-fonts` | done by the Parc redesign: Archivo, the one font of Parc, is served from `@fontsource-variable/archivo` (`src/main.jsx`), the Google Fonts stylesheet, its preconnects and its runtime cache are gone, and the two other fonts were uninstalled | L33 | — |
| `security-csp-meta` | a content security policy in a `<meta>` written at build time from `VITE_SUPABASE_URL`, in a commit of its own that can be reverted | B5 | — |
| `tooling-vite8`, `tooling-plugin-react6`, `tooling-eslint10` | Vite 8, `@vitejs/plugin-react` 6 and ESLint 10, one commit each, stopping at the first plugin that does not follow, and the lint ceiling lowered to the count ESLint 10 measures | B16 | — |
| `docs-truth-pass` | the stale rules of the documents deleted, and `docs/identifiers.test.js` (run by `npm run test:docs`) failing on a back-ticked identifier or a `src` path that does not exist | P40 | — |
| `realtime-cold-start` | not in the plan. Twice, after hours without activity (2026-10-15 and 2026-10-16), the first Realtime subscription of the day missed a message written right after its `SUBSCRIBED`; the next ones got it in under a second. The fix proposed: read the cache again once more when the subscription is confirmed, or a few seconds after the first `SUBSCRIBED` | — | — |

`axe-core` was installed for these packages in wave 0 and is imported by nothing. Of the three fonts installed with it, Archivo is the font of Parc; Inter and JetBrains Mono were uninstalled by the redesign.

## 3. The product features of waves 5 to 8

The fourteen product proposals of the review. None has a line of code; the migrations they need are reserved, not written.

| Product | What the coach or the athlete gets | Packages | Migrations, functions |
|---|---|---|---|
| product-1 | the coach sees an athlete's records, e1RM and bodyweight on the athlete page, and the progression chart shows e1RM, tonnage or best reps | `p1-coach-records-e1rm` | none |
| product-2 | the roster says when a block has two sessions or fewer left, or is done; the coach is notified when the last session of the active block is confirmed; the athlete's "Block complete" leads to a message to the coach | `p2-block-ending-alerts`, `sql-22-product-wave5` | 33 |
| product-6 | an athlete is archived: an "Archived · N" drawer in the roster with a restore, and the athlete out of the messages, the feed's filter and the copy targets | `p6-archive-athlete` | 34 (`students.archived_at`) |
| product-11 | private notes of the coach per athlete, which the athlete cannot read — they replace `students.notes`, which the athlete can read today | `p11-coach-private-notes` | 35 (`coach_athlete_notes`); L22, the notes half |
| product-7 | a goal shows its progress from the training logged — best e1RM against a 1RM goal, the first set that meets a format goal — and is marked achieved in one tap | `p7-goals-from-logs` | none |
| product-4 | a review inbox with signals (failed, off plan, skipped, swapped, a request, a video, a note, the session RPE, pain), the sessions with signals first, "Mark reviewed" on a card without any, "Next · n left" in the review | `p4-review-inbox-signals`, `sql-23-product-wave6` | 37 (`session_review_signals`) |
| product-5 | an end-of-session check-in: a session RPE in half steps and pain yes or no with a note, queued offline with the confirmation; pain is the coach's first chip | `p5-session-checkin`, `p5-coach-pain-surface` | 36 |
| product-3 | the coach invites an athlete by e-mail from the roster; the invitation and a forgotten password are links handled by a route of the app; the badge half of L35 shipped in wave 3, the invitation half is here | `edge-invite-athlete`, `p3-invite-athlete-ui`, `p3-auth-links` | the Edge Function `invite-athlete`; customised e-mail templates and a custom SMTP sender (the free plan sends two e-mails an hour); L35 |
| product-9 | a block copied to another athlete (`duplicate_program` has taken a target athlete since migration 12) | `p9-copy-block-to-athlete` | none |
| product-10 | an exercise picker with search, the recent ones first, an exercise created in place, and the sets, reps and load of a new exercise taken from the athlete's last performance, with +2.5 kg suggested after an easy session | `p10-exercise-picker-prefill` | none |
| product-12 | cues and a demo link for each exercise of the library, shown on the athlete's logging screen and in the swap picker | `p12-library-cues`, `p12-how-to-card` | 38 |
| product-8 | the athlete exports their data and deletes their account; a coach's account cannot delete itself | `p8-export-delete-account`, `edge-delete-account` | 40, the Edge Function `delete-account` |
| product-13 | the exercise types legs and core beside pull and push, and the volume shown by type | `p13-volume-by-type` | 39 |
| product-14 | a set prescribed by RPE or by a percentage of the 1RM, and warm-up sets, which count in no volume, record or "Last time" | `p14-stats-format`, `p14-student-display`, `p14-coach-prescription`, `sql-25a-prescription-columns`, `sql-25b-prescription-propagation` | 41, 42 |

## 4. The contract migrations 43 to 45, and the code they would let go

A contract migration removes what an app older than the current one still uses, so it waits until no such app is open: at least 14 days after the last publication, with `MIN_CLIENT_BUILD` set the day before ([runbook/40-deploy.md](runbook/40-deploy.md), section 8), after a fresh backup and an audit that reads 0. None is written (`sql-26-contract`).

| Migration | What it would do | Condition | Findings |
|---|---|---|---|
| 43 | an athlete's insert into `set_logs` becomes an extra set without targets, unless it comes from `ensure_set_logs`, whose inserts carry the mark `app.trusted_set_log_insert` | no exercise of a session left with fewer prescribed sets than its count; the app of wave 2 everywhere | L6 |
| 44 | the athlete's `INSERT` and `UPDATE` policies on `scheduled_pushes` dropped: a rest push is scheduled and taken back through `schedule_rest_push` and `cancel_rest_push` only | no row written without an `endpoint` in the last 7 days — the app of wave 3 everywhere | B3 |
| 45 | `set_logs.weight_kg` and `students.notes` dropped | the notes moved by migration 35 first; not reversible without the backup | P36, L22 |

What the app and the database keep for the older apps until then — harmless, and to be dropped once no old app is in use:

- `useEnsureSetLogs` (`src/hooks/useSetLogs.js`) inserts the missing sets itself where `ensure_set_logs` is missing (`PGRST202`): after migration 43 that insert would be an extra set.
- `useRestTimerPush` falls back on its own insert of `scheduled_pushes` and its `canceled_at` update where `schedule_rest_push` is missing; the 350-second clamp lives on in the app of wave 2 only. Migration 44 closes both.
- The service worker treats a "Rest done" whose address is the training list — what the apps before wave 3 wrote — as the push of the session the athlete is in (`src/lib/swHandlers.js`, `LEGACY_REST_DONE` in its tests).
- `save_draft_tree` writes a weekday outside 1 to 7 as none, for a phone that cached its draft before migration 21; `student/RpeChoices` shows a rating of 1 to 5, logged before half steps, first and pressed (`rpeChoices` of `lib/rpe`).
- A write queued by an older build is replayed as it was made: `patchForSkipped(false)` stays `{ skipped: false }`, an RPE or an Actual without `done: true` marks nothing done, a cached session without `program_status` is read as approved.
- `useReviewCounts` and `useConversations` read their list page by page where the optional migration 26 is missing. That one is not a contract: the fallback goes once every project the app runs against has migration 26.

## 5. Small things found at the end of wave 3

- An iPad with a hardware keyboard reports `(pointer: coarse)`, so Enter writes a new line there too. No rule covers a device with both.

## 6. The checkpoints that are not held

Checkpoint C1 is the last one ([RUNBOOK.md](RUNBOOK.md)). C2 (migrations 27 to 30 and 32, 31 optional), D to G (33 to 42, with the two Edge Functions and the e-mail settings) and Z (43 to 45, then the fold of `schema.sql`) belong to the work above, and are written again by whoever brings it. The end-to-end run "after" on the test athlete, which was planned for C2, is part of C1.
