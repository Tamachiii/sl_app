# rest-push-client — docs to fold (wave 3, items P50, B35, B38)

Each block: target doc, section, then the text to fold in. The snippet of session-rest-controls (student lane) edits other sentences of the same bullets and the start of the same CLAUDE.md row; the blocks below touch only the sentences it leaves.

**Fold this snippet after the one of session-rest-controls.** Two phrases below — "the shell unmounting" and "`student/RestTimerHost` mounts it with the student shell, on every page" — are true only once that package has moved the hook into `RestTimerHost`. In this lane `student/SessionView` still mounts it, and leaving the session page takes the push back. If session-rest-controls is not folded in the same wave, write "the session page unmounting" and "`student/SessionView` mounts it: leaving the page takes the push back" instead.

## docs/INVARIANTS.md — Web Push (rest-timer "Rest done" lock-screen notification)

Replace the bullet that starts "**A rest is 1 to 900 seconds for the database; the 350 s clamp is the app's and the deployed function's.**" with:

- **A rest is 1 to 900 seconds for the database, and the app asks for nothing outside that.** `schedule_rest_push` refuses a rest outside 1–900 seconds (`rest_seconds_out_of_range`) in both modes: 15 minutes is what the Edge Function can wait for, in hops, where no job runs. [hooks/useRestTimerPush.js](../src/hooks/useRestTimerPush.js) asks for a rest of 1 to `MAX_REST_PUSH_SECONDS` (900) seconds left, and for nothing otherwise — a longer rest keeps the in-app beep and the wake lock. The 350 s clamp is only in the client deployed before wave 3, which inserts its row itself; with the `dispatch-rest-push` deployed before wave 2, which waited inside one request the platform ends after 150 seconds, a rest of 150 seconds or more got no push.

Add after the bullet that starts "**An account names a device of its own.**":

- **The app schedules a rest push in one request, for this device, and falls back only when the functions are missing.** [hooks/useRestTimerPush.js](../src/hooks/useRestTimerPush.js) calls `schedule_rest_push(p_seconds, p_payload, p_endpoint)`: `p_seconds` the whole seconds left, an integer (`Math.ceil`, counted right before the request leaves — a fraction is a `22P02`), `p_endpoint` the endpoint of this device's subscription (`getActivePushSubscription`), never NULL — without it every device of the account rings for a rest taken on one of them (B38). Nothing is asked without a signed-in user, without push support, without the permission `granted`, without a subscription, offline (`navigator.onLine === false`: the server would count the seconds from whenever the request arrived) or for a rest outside 1–900 s. With `mode: 'cron'` the app does nothing more; with any other answer — `'edge'`, or no `mode` at all — it invokes `dispatch-rest-push` with `{ scheduleId: id }`, fire and forget: a call too many costs nothing, since every sender claims. A rest that changes or ends — Undo, Skip, the next set, "+30 s", the shell unmounting — takes its push back with `cancel_rest_push(id)`, and a rest that ends while its push is being scheduled takes it back as soon as the id is known and never dispatches it. The schedule requests leave one after the other, whichever mount of the hook sends them: each waits for the one before to be answered, `PREVIOUS_REQUEST_WAIT_MS` (5 s) at most, and a rest that changed during the wait asks for nothing — `schedule_rest_push` closes every row the account has waiting, so an old rest's request overtaken by the next one's would close the new row and then be taken back itself. **Only `PGRST202` falls back** to the insert of the app from before wave 3 (`user_id`, `fire_at` from the phone's clock, `payload`, no `endpoint` key) and its `UPDATE … SET canceled_at … WHERE status = 'pending'`; a refusal (`device_not_registered`, `rest_seconds_out_of_range`, `payload_invalid`, `42501`) or no answer schedules nothing, because the old insert names no device. The payload is `{ title, body, tag: REST_TIMER_TAG, data: { url } }`, written with `getMessage` in the language of the app at the moment the push is scheduled (`student.session.restDone`, `restPush.body`) — the language is followed through a ref, so changing it during a rest neither cancels nor reschedules the push. `data.url` is `${BASE_URL}#/student/session/<id>`, the session of the set (`logId`), found in the lists of sets the device holds (`['set-logs', sessionId, slotIds]`) without a request; when none holds the set the payload has no `data` and a tap moves no window. **Never `#/student`**: a tap on it took the athlete out of the session they were resting in (P50). The hook does not read the route: `student/RestTimerHost` mounts it with the student shell, on every page (session-rest-controls). Tests: `hooks/useRestTimerPush.test.jsx`.

## docs/INVARIANTS.md — Rest timer

In the bullet that starts "**The running rest is also in `localStorage`", replace "and [hooks/useRestTimerPush.js](../src/hooks/useRestTimerPush.js) schedules a push for it while the row scheduled before the kill was never cancelled, so two pushes with the same tag can arrive for one rest." with:

and [hooks/useRestTimerPush.js](../src/hooks/useRestTimerPush.js) schedules a push again for the seconds that are left, once the stored cache is restored (`useIsRestoring`: the set's session is found in it). `schedule_rest_push` closes the row scheduled before the kill, so one push arrives for one rest; on a database without migration 16 the fallback insert leaves that row pending, and two pushes with the same tag can arrive.

## README.md — Rest Timer (in-app + Web Push)

In the bullet that starts "**Background / lock-screen push — [useRestTimerPush]", replace "the hook inserts a `scheduled_pushes` row and invokes the [`dispatch-rest-push`](supabase/functions/dispatch-rest-push/index.ts) Edge Function. The function answers at once and waits for `fire_at` after its answer," with:

the hook asks the database for one push with `schedule_rest_push` — the seconds left, the text in the app's language, the session to go back to, and this device's endpoint, so that only this device rings. The database computes the time on its own clock and says who sends: its pg_cron job (`mode: 'cron'`), or the [`dispatch-rest-push`](supabase/functions/dispatch-rest-push/index.ts) Edge Function, which the hook then invokes (`'edge'`). A rest that ends early is taken back with `cancel_rest_push`. The function answers at once and waits for `fire_at` after its answer,

In the paragraph that starts "The DB tables ([2026_05_11_push_notifications.sql]", replace "The Edge Function asks `claim_rest_push` before it sends; the app does not call `schedule_rest_push` and `cancel_rest_push` yet." with:

The Edge Function asks `claim_rest_push` before it sends; the app calls `schedule_rest_push` and `cancel_rest_push`, and falls back on its own insert only where they are missing (`PGRST202`).

In the same paragraph, replace "The function waits for a rest of up to 15 minutes; the app asks for no push beyond 350 s (`useRestTimerPush`)." with:

The function waits for a rest of up to 15 minutes, and the app asks for a push for any rest of 1 to 900 seconds (`useRestTimerPush`).

## CLAUDE.md — Feature → files map, row "Rest timer (in-app cues + Web Push)"

Add at the end of the row, after "(the "pg_cron jobs" row)":

. The app's side is `hooks/useRestTimerPush` (one `schedule_rest_push` with the whole seconds left, the payload and this device's endpoint; `dispatch-rest-push` invoked unless `mode` is `'cron'`; `cancel_rest_push`; one schedule request at a time, `PREVIOUS_REQUEST_WAIT_MS`; the old insert and `canceled_at` update on `PGRST202` only; `MAX_REST_PUSH_SECONDS`; `restPushPayload` — `getMessage` in the app's language, `student.session.restDone` + `restPush.body` from `lib/i18n/fragments/rest-push-client.*`, `data.url` the session of the set found in the `['set-logs']` cache), tests `hooks/useRestTimerPush.test.jsx`
