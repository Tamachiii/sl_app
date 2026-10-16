# coach-nav-memory-badge — docs to fold (wave 3, items L13)

Each block: target doc, section, then the text to fold in.

The badge also closes the badge half of L35 (live finding N17); the invitation half is another package's.

## docs/INVARIANTS.md — Coach Athletes-roster layout

In the bullet that starts "**The Athletes roster merges the old Dashboard + Students tabs.**", replace the sentences from "Tapping the Athletes tab restores the coach's last athlete" to the end of the bullet ("…bounces the coach straight back into the athlete they just left.") with:

The Athletes tab comes back to the coach's last athlete **for the rest of the launch** — `sl_last_coach_students_path` in `sessionStorage`, written by `CoachHome` and read back by its restore effect (see the coach-persistence section of [ARCHITECTURE.md](ARCHITECTURE.md)) — so a detour through Sessions/Messages/Library returns to the athlete. A cold launch opens on the roster. The restore lands on the **athlete page** only (`athletePageOf` in [`hooks/useRememberCoachStudentsPath.jsx`](../src/hooks/useRememberCoachStudentsPath.jsx): `/coach/students/:studentId`, with its `?program=` when the remembered path was that page), never on the session editor beneath it, and only for an athlete still on the roster. **"‹ All athletes" and a tap on the Athletes tab while it is open both clear that key** (`clearLastCoachStudentsPath`; the tab through the item's `onReselect`): `/coach/students` and `/coach/students/:studentId` keep one `CoachHome` mounted, its restore effect runs again when `:studentId` goes away, and without the clear it bounces the coach straight back into the athlete they just left.

## docs/INVARIANTS.md — Coach Athletes-roster layout

Add after the bullet that starts "**The Athletes roster merges the old Dashboard + Students tabs.**":

- **The coach's last place in each tab lasts one launch, and is read and written in one module.** [`hooks/useRememberCoachStudentsPath.jsx`](../src/hooks/useRememberCoachStudentsPath.jsx) holds the four keys — `sl_last_coach_students_path`, `sl_last_coach_students_path_forgotten`, `sl_last_coach_session`, `sl_last_coach_sessions_student` — in `sessionStorage`, behind its own functions (`getLastCoachStudentsPath` / `clearLastCoachStudentsPath`, `getLastCoachSession` / `rememberLastCoachSession` / `clearLastCoachSession`, `getLastCoachSessionsStudent` / `rememberLastCoachSessionsStudent`, `clearLastCoachSessionsTab`). `CoachHome`, `SessionsFeed`, `SessionReview` and `layout/navItems` go through them and never touch storage for these keys themselves. In `localStorage` they made every cold launch skip the attention-first roster for an athlete page or a session editor opened days before, and the Sessions tab reopen the last review. The same names in `localStorage`, left by earlier versions, are never read — the first launch after the update opens on the roster too — and are removed at the first access of a launch (`dropLegacyCoachMemory`). `getLastCoachSession` gives `null` for anything but two non-empty string ids, and keeps `from` only when it is a string. The feedback draft (`sl_feedback_draft:<sessionId>`) is not part of this: it stays in `localStorage` on purpose.
- **A tap on the coach tab that is open returns to its root.** The Athletes item of [`layout/navItems`](../src/components/layout/navItems.jsx) carries `onReselect: clearLastCoachStudentsPath`, the Sessions item `onReselect: clearLastCoachSessionsTab` (the review left open and the feed's athlete filter). `BottomNav` and `SideNav` call it from the `NavLink`'s `onClick`, which runs before the link navigates, through `reselectOnClick(event, active, onReselect)`: only when the item's `matches(pathname)` is true, and only for a plain primary click — a click with a modifier or another button opens the tab elsewhere and forgets nothing. The NavLink's own navigation then lands on the roster or the plain feed, and nothing bounces. Messages and Library need no `onReselect`: their root sends the coach nowhere.
- **The Sessions tab's number is the roster's "to review" count, summed.** [`hooks/useToReviewCount.js`](../src/hooks/useToReviewCount.js) adds up `reviewCountsByStudent` of [`lib/coachRoster.js`](../src/lib/coachRoster.js) — the function behind the cards' chips, a confirmation neither reviewed nor archived — over `useAllConfirmations`, so the tab and the cards cannot disagree. It is `undefined` while the confirmations are not known, and [`layout/ReviewCountBadge`](../src/components/layout/ReviewCountBadge.jsx) draws nothing then and nothing at 0. The navigation asks this hook and nothing else: a cheaper source for the count changes this file only. The count is as fresh as `['all-confirmations', userId]`: the invalidations of a review, an archive and a feedback send, and the query's own refetches — a new confirmation from an athlete reaches it at the next refetch.

## docs/ARCHITECTURE.md — Coach-section persistence across tab switches

Replace the sentence that introduces the list ("Two flows drive "pick up where you left off" via three localStorage keys…", as the earlier snippets of this wave leave it) with:

Two flows drive "pick up where you left off" for the rest of a launch, through three `sessionStorage` keys and a mark, all read and written by [src/hooks/useRememberCoachStudentsPath.jsx](../src/hooks/useRememberCoachStudentsPath.jsx); a cold launch starts with none of them, so each tab opens on its root. A fourth key, in `localStorage`, keeps the feedback being written:

## docs/ARCHITECTURE.md — Coach-section persistence across tab switches

In the bullet that starts "**`sl_last_coach_students_path`**", replace "Read by `CoachHome`'s restore effect when the route is `/coach/students` with no `:studentId`: it validates the saved athlete is still on the roster, then `navigate(saved, { replace: true })`. **Cleared by the "‹ All athletes" header link** — the coach's explicit "I want the roster" signal." with:

Read by `CoachHome`'s restore effect when the route is `/coach/students` with no `:studentId`: it takes the athlete page of the saved path (`athletePageOf` — `/coach/students/:studentId`, plus its `?program=` when the saved path was that page; never the editor), checks the athlete is still on the roster, then `navigate(target, { replace: true })`. The full path is still what is written, so the mark below stays exact for a session editor that found nothing. **Cleared by the "‹ All athletes" header link and by a tap on the Athletes tab while it is open** — the coach's explicit "I want the roster" signals.

## docs/ARCHITECTURE.md — Coach-section persistence across tab switches

In the bullet that starts "**`sl_last_coach_session`**", replace "Read by `SessionsFeed`'s mount effect" with "Read through `getLastCoachSession` by `SessionsFeed`'s mount effect", and add at the end of the bullet:

A tap on the Sessions tab while it is open clears it too, with `sl_last_coach_sessions_student` (`clearLastCoachSessionsTab`).

## docs/ARCHITECTURE.md — Coach-section persistence across tab switches

In the bullet that starts "**`sl_last_coach_sessions_student`**", replace "The filter lives in the URL — localStorage just repopulates it on return to `/coach/sessions`." with:

The filter lives in the URL — the key just repopulates it on return to `/coach/sessions` within the launch, and a tap on the Sessions tab while it is open clears it.

## docs/ARCHITECTURE.md — Nav tab active-state overrides

Add after the paragraph that starts "`BottomNav` / `SideNav` call `useLocation()`":

The same `matches(pathname)` decides a tap on the open tab: an item may carry `onReselect`, which the navs call from the `NavLink`'s `onClick` — before its navigation — when the item is active and the click is a plain primary one (`reselectOnClick` in `layout/navItems`). Athletes and Sessions use it to forget the place their root would bounce back to. An item may also carry `badge`: `'unread-messages'` draws `messaging/UnreadMessagesBadge` (Messages), `'to-review'` draws `layout/ReviewCountBadge` (Sessions, coach only — the hook behind it is never mounted in the athlete's nav).

## docs/DESIGN_SYSTEM.md — Responsive layout

Add after the paragraph that starts "Both nav components share their item list via `layout/navItems.getNavItems(role, t)`":

A count on a tab is an accent pill with `sl-on-fill` text: `ReviewCountBadge` puts it over the top right of the icon in `BottomNav` (`variant="icon"`, `leading-none`, `min-w-4`) and at the end of the row in `SideNav` (`variant="count"`, the size of the unread-messages count). It draws at most two digits ("99+") and is read as the tab's name followed by the sentence of the number ("Sessions, 147 sessions to review"): the digits are `aria-hidden` and the sentence is an `sr-only` span — an `aria-label` on a plain span is not read everywhere. In `BottomNav` it comes after the label in the DOM, so the label is read first.

## CLAUDE.md — Repo map

Replace the line `    layout/      AppShell  BottomNav  SideNav  navItems` with:

```
    layout/      AppShell  BottomNav  SideNav  navItems (getNavItems; reselectOnClick — a tap on the
                 open tab returns to its root)  ReviewCountBadge (the to-review number on Sessions)
```

## CLAUDE.md — Repo map

In the `hooks/` lines, replace `remember-coach-students-path` with:

`remember-coach-students-path (the coach's last place per tab, for one launch: sessionStorage, athletePageOf)` · `to-review-count`

## CLAUDE.md — Feature → files map, row "Coach Athletes roster (attention-first list; merged Dashboard + Students into one tab)"

Add at the end of the row:

The Athletes tab returns to the last athlete PAGE for the rest of the launch and opens on the roster after a cold launch; "‹ All athletes" and a tap on the open tab forget it — `hooks/useRememberCoachStudentsPath` (`sessionStorage`, `athletePageOf`, `clearLastCoachStudentsPath`), `layout/navItems` (`onReselect`, `reselectOnClick`). The Sessions tab shows the sum of the to-review chips: `hooks/useToReviewCount`, `layout/ReviewCountBadge` ("99+" past 99), strings in the `coachNavMemoryBadge` namespace. Tests: `hooks/useRememberCoachStudentsPath.test.jsx`, `layout/BottomNav.test.jsx`, `layout/navReselect.test.jsx` (the navs over the real `CoachHome` and `SessionsFeed`), `hooks/useToReviewCount.test.jsx`

## CLAUDE.md — Feature → files map, row "Coach sessions feed"

Add at the end of the row's file list:

; the review left open and the athlete filter come back for the rest of the launch only, through `hooks/useRememberCoachStudentsPath` (`getLastCoachSession`, `getLastCoachSessionsStudent`, `rememberLastCoachSessionsStudent`), and a tap on the open Sessions tab forgets both (`clearLastCoachSessionsTab`)
