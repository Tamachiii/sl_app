# w2-followups-pwa — docs to fold (wave 3, items: none)

Each block: target doc, section, then the text to fold in. The snippet of session-rest-controls (student lane) replaces the last sentence of the first bullet below ("the page that schedules it is the page that beeps, …"); the blocks here touch other sentences of the same three bullets, and either snippet can be folded first.

## docs/INVARIANTS.md — Web Push (rest-timer "Rest done" lock-screen notification)

In the bullet that starts "**"Rest done" in front of the athlete is shown quietly and taken away", replace "and closes it `FOCUSED_REST_CLOSE_MS` later (`closeNotifications`, by tag)." with:

and closes it `FOCUSED_REST_CLOSE_MS` later (`closeNotifications`, by tag) — unless another "Rest done" has been shown since. The tag is also the one of a "Rest done" that replaced the quiet one in those seconds, and that one may be loud (the phone went into a pocket, the next rest ended): the worker counts the "Rest done" it asks `showNotification` for (`restShows`), a quiet one keeps the number it was shown under, and it is closed only while that number is still the last. The one that replaced it is its own push's to close, if quiet, or to leave, if loud. The count is taken when a notification is asked for, not when a push arrives: a "Rest done" still waiting for its answer about the windows has replaced nothing, and the quiet one before it goes on time.

In the same bullet, replace "**Whoever writes the payload of the rest push keeps the tag `rest-timer`** ([hooks/useRestTimerPush.js](../src/hooks/useRestTimerPush.js)): under another tag the push is an ordinary one — two cues in front of the athlete, and a notification nothing closes." with:

**Whoever writes the payload of the rest push keeps the tag `rest-timer`** ([hooks/useRestTimerPush.js](../src/hooks/useRestTimerPush.js) writes `REST_TIMER_TAG`): under another tag the push is an ordinary one — two cues in front of the athlete, and a notification nothing closes. The value cannot follow a rename either: the client deployed before wave 3 writes the literal, and `scheduled_pushes` holds payloads written by it (`lib/swHandlers.test.js` pins it). `hooks/useRestTimerPush.test.jsx` hands the payload the hook really writes to `handlePush` and `handleNotificationClick` and fails when the worker does not treat it as the rest push.

In the bullet that starts "**A tap brings the app to the front and moves a window only when it is somewhere else.**", replace "same origin, same path, same route in the hash, where a trailing `/` does not count and `#/`, `#` and no hash are one route." with:

same origin, same path — where a path that ends in a whole `index.html` segment is its directory, so `/sl_app/index.html` and `/sl_app/` are one document and `/sl_app/myindex.html` is not — same route in the hash, where a trailing `/` does not count and `#/`, `#` and no hash are one route.

In the same bullet, replace "**The payload decides where a tap leads: a "Rest done" whose `data.url` is the training list sends a window that is on the session to the list.** The session's own route in `data.url` is what leaves the athlete in the session." with:

**The payload decides where a tap leads — except that a "Rest done" never takes the athlete out of a session to a page that is not one.** `handleNotificationClick` passes the tag of the tapped notification to `bringAppToFront`: for a notification tagged `REST_TIMER_TAG` whose address is not a session — the training list, which the client deployed before wave 3 and every row it scheduled give it — a window on a session (`/student/session/<id>`, `isSessionRoute`) is focused and never navigated, and is preferred to a window that would have to move. A window on the payload's own page still comes first, a window on another page is still sent to the address, and with no window the address is opened. A "Rest done" that names its session (what [hooks/useRestTimerPush.js](../src/hooks/useRestTimerPush.js) writes since wave 3) is read as it is: a window on another session is sent to it. Every other tag follows its payload alone. The tag is read from the notification, synchronously: nothing more is awaited before `matchAll`.

In the bullet that starts "**A "Rest done" that is no longer news is closed when the app comes back", add at the end:

A sweep waits `SWEEP_ANSWER_MS` (5 s) at most for the device (`within` of [src/lib/swHandlers.js](../src/lib/swHandlers.js), the bound the worker puts on its own question about the windows): the watcher's `running` flag, which makes the `visibilitychange` and the `focus` of one return a single sweep, is cleared then, so a `getRegistration()` or a `getNotifications()` that never answers costs one sweep and not every later one.

## CLAUDE.md — Feature → files map, row "Notifications on the device (a push is shown, a tap opens the app, a "Rest done" that is over goes away)"

In the row, replace "then closed after `FOCUSED_REST_CLOSE_MS`; `handleNotificationClick`: `targetOf`, `isSameRoute` — a window already on the page is focused and not moved, another one is focused and navigated, none opens one; `closeNotifications`)" with:

then closed after `FOCUSED_REST_CLOSE_MS` unless another "Rest done" was shown since (`restShows`); `handleNotificationClick`: `targetOf`, `isSameRoute` (a trailing `index.html` is its directory) — a window already on the page is focused and not moved, another one is focused and navigated, none opens one, and a "Rest done" whose address is not a session leaves a window on a session where it is; `closeNotifications`; `within`)

In the same row, replace "`lib/restNotifications` (`closeRestNotifications` on return to the app, installed by `src/main.jsx`)" with:

`lib/restNotifications` (`closeRestNotifications` on return to the app, installed by `src/main.jsx`; a sweep is given up after `SWEEP_ANSWER_MS`)

In the same row, replace "Tests: `lib/swHandlers.test.js` (a notification centre with one notification per tag and the two `TypeError`s of `showNotification`)," with:

Tests: `lib/swHandlers.test.js` (a notification centre with one notification per tag and the two `TypeError`s of `showNotification`; `REST_DONE` the payload of the hook, `LEGACY_REST_DONE` the one of the client deployed before wave 3), `hooks/useRestTimerPush.test.jsx` (the payload the hook writes, through the worker's handlers),
