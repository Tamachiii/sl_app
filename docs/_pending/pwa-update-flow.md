# pwa-update-flow — docs to fold (wave 2, items P65)

Each block: target doc, section, then the text to fold in.

## docs/INVARIANTS.md — new section "App updates (a new version waits for the page)", after "Web Push (rest-timer "Rest done" lock-screen notification)"

Add the section:

````markdown
## App updates (a new version waits for the page)

- **A new service worker installs and WAITS; it takes over when a page tells it to.** `handleInstall` in [src/lib/swHandlers.js](../src/lib/swHandlers.js) calls `skipWaiting()` in one case only (next bullet); otherwise the worker stays behind the one that serves the app until a page posts `{ type: 'SKIP_WAITING' }` (`handleMessage`). Never put a bare `self.skipWaiting()` back in the `install` listener of [src/sw.js](../src/sw.js): the pages reload when their worker changes, and that reload would land in the middle of a rest or of a message being typed — which is what this flow exists to prevent. `src/sw.test.js` loads the real `sw.js` and fails on it; `src/lib/swHandlers.test.js` holds the handlers.
- **One worker still takes over by itself: the first of this kind on a device. A mark in Cache Storage tells it apart, and the mark must stay.** The client published before this flow registered its worker in "auto update" mode: its pages reload when a new worker activates and never send a message, so a worker that waited for them would wait until every window of the app is closed — and a reload is not a close. `handleActivate` therefore leaves one entry, `UPDATE_MARK_URL`, in a cache of its own, `UPDATE_MARK_CACHE` (`sl-app-update`); `handleInstall` reads it (`pagesAskForUpdates`): no mark means the pages on this device cannot ask, and the worker takes over at once, as every worker before it did. An unreadable Cache Storage is read as "no mark". Do not rename that cache to anything containing `-precache-` (workbox's `cleanupOutdatedCaches` deletes those), and do not clear it at sign-out. **What the mark cannot know is a rollback:** the app of a commit from before this flow, published again, takes over by itself and leaves the mark where it is — its pages cannot ask, and the worker of the deploy after it waits. On those devices that deploy arrives when the app is closed and opened again, not on a reload.
- **The page registers the worker itself. Nothing imports `virtual:pwa-register`, and `injectRegister` is `false` in [vite.config.js](../vite.config.js).** [src/main.jsx](../src/main.jsx) calls `appUpdater.start({ swUrl, scope })` (production builds only). The plugin's helper reloads every open window the moment a new worker activates, whatever the window is doing; and with `injectRegister` left at its default while nothing imports the virtual module, the plugin writes a `registerSW.js` into `index.html` — a second registration, with that same reload. `registerType: 'prompt'` changes nothing in an `injectManifest` build; it is there to say what the worker does. `src/main.test.jsx` scans `src/` for the import and reads the two options off the config.
- **The update flow has ONE `location.reload()`: `doReload` in [src/lib/appUpdate.js](../src/lib/appUpdate.js).** A worker that changes under a page that did not ask for it — another window applied the update, the first-worker case above, a rollback — does not reload that page: the page becomes `pending` like for any other update and reloads at a safe moment of its own, with no worker left to tell. A reload cannot loop: `AUTO_APPLIED_KEY` in `sessionStorage` holds the `BUILD_ID` of the build that last reloaded ITSELF, and a page that finds its own id there does not try a second time on its own (the offer still works; a tap does not use the attempt up). Where `sessionStorage` cannot be written, nothing is applied automatically.
- **The reload is asked for when the new worker is `activated` — never at `controllerchange`.** A worker that is told to take over becomes `activating` and the page hears `controllerchange` at once; the browser runs the worker's `activate` handlers only after that, and Chromium takes a full second to get there (1004 to 1015 ms on Chromium 147 with the handlers of `swHandlers.js`, which themselves need a few milliseconds). A reload asked for in that second is not refused: it is held back until `activated`, and the page it is going to replace stays on the screen meanwhile, takes taps and sends writes — which are then reloaded over. So `apply()` only remembers the worker it waits for (`awaited`: the one it told, or, for a page whose worker changed under it, `container.controller`), and `onWorkerState` calls `arrive()` when that worker's state is `activated`: 12 to 17 ms from there to the new page. `onControllerChange` reloads nothing; it marks the page `stale`. `pending` stays true for the whole of an attempt, so the card says "Updating…" until the page is replaced. An attempt whose worker is not `activated` after `APPLY_TIMEOUT_MS`, or whose worker becomes `redundant`, ends without a reload (`giveUp`) and the update is offered again. `fakeBrowser()` in [src/test/fakeServiceWorker.js](../src/test/fakeServiceWorker.js) keeps the browser's order — `activating(worker)` fires `controllerchange`, `activated(worker)` comes after, `takeOver` is the two — and a test of this flow that only calls `takeOver` cannot see the second in between.
- **"Safe" is five conditions, asked when the update is decided AND once more when the worker is `activated`, right before the reload.** The question is the probe `UpdatePrompt` registers with `appUpdater.watchForSafeMoment`: a reload would lose something while `queryClient.isMutating() > 0` (a write on its way or queued offline), while the rest timer's `endsAt` is in the future, while a field has the focus (`isField` in [src/lib/fieldWatch.js](../src/lib/fieldWatch.js): `textarea`, `select`, a typed `input`, an editable region — not a button or a checkbox), while a field holds text that was typed into it (`fieldWatch.holdsTypedText`, next bullet) or while a dialog is open (`dialog[open]`, `[role="dialog"][aria-modal="true"]`). The probe reads all five at the moment it is called, never from the last render. The second asking is in `arrive()`: the second the worker needs to be activated is a second in which a set can be ticked or a message begun, and that is exactly what the reload must not land on — the page then stays, already served by the new worker (`stale`), and reloads at the next safe moment. It applies to an update the page applied by itself; a tap on "Update" is the person's choice and is not asked again. **A new surface that holds unsaved input and is neither a field nor a dialog of those two shapes must add itself to the probe**, or an update reloads over it. **What the probe cannot see: a request that is not a React Query mutation** — `updateProfile` and `updatePassword` in [src/hooks/useAuth.jsx](../src/hooks/useAuth.jsx) are plain awaits. The password form sits in a dialog, which the probe sees; the rename of `student/StudentProfile` is sent from a `ui/EditableText` whose field is removed at once, and is on its way with nothing in the page to show it. A write that must not be reloaded over goes through `useMutation`.
- **Text that was typed and not sent is in progress wherever the focus is.** The drafts of `messaging/MessageComposer`, `coach/SessionFeedbackComposer`, the exercise and goal forms and the "Actual" editor of `student/SetRow` live in `useState` and nowhere else: a reload at the next return to the app, with the focus on a button, would lose them. `fieldWatch` (listening to `input` and `change` on the document, in the capture phase, while `UpdatePrompt` is mounted) remembers the fields that were typed into; `holdsTypedText()` is true while one of them is still in the page (`isConnected`) with text that is not blank. A field that is emptied (a message that was sent) or removed (a form that closed, another page) no longer counts; a `select` never does. **It cannot tell sent from unsent**: a field that saves when it is left and keeps showing what was typed (a slot's sets and reps in the session editor, the roster's search box) counts until its page is left. That is the side to err on — the update is offered where it could have been applied — and the reason the probe must not be narrowed to forms or to `textarea`s: the "Actual" editor is neither.
- **The offer is not drawn while a field is in use, nor for `FIELD_LEFT_MS` after one is left.** `fieldWatch.inUse()` is "a field has the focus, or lost it less than 400 ms ago", and `UpdatePrompt` draws the offer only when it is false. The first half keeps the card off what is being typed, right above the keyboard. The second is about the tap that takes the focus away: a tap on a button moves the focus at the press and is a click only at the release, so a card drawn when the focus moves appears under the finger and takes the release — the click then belongs to neither element and the tap is lost: on a phone with its keyboard open, the "Create" of the exercise form sits where the card goes, and would send nothing. `src/components/ui/UpdatePrompt.test.jsx` holds the order of that tap. "Updating…" is not held back: it has no button. `inUse()` is about where the card is drawn and is NOT part of the probe — a tap that leaves the roster's search box for an athlete is a change of page, and a reload there costs nothing.
- **An update is considered at four moments, and "it became safe" is not one of them.** `consider()` runs when the update appears (a worker has installed and waits, or the worker changed under the page), when the app returns to the foreground, when the route changes, and when the shell mounts. The end of a rest, leaving a field and sending the message that was being typed change nothing by themselves — the next set is about to be ticked — so an update offered during a rest is applied at the next return to the app or the next page, or by a tap. A window that is not visible neither applies nor offers. The second asking of the bullet above is not a fifth moment: it can only call an attempt off.
- **`UpdatePrompt` is mounted in `AppShell` only; a signed-out page has nobody to answer and its update waits.** It is applied when the shell mounts after sign-in, or when the app is closed and opened again. A reload of the login page does not bring it: a waiting worker waits for every window.
- **"Update" waits for the writes a reload would lose, for a bounded time.** `writesAreSafe` in [components/ui/UpdatePrompt.jsx](../src/components/ui/UpdatePrompt.jsx) waits for the writes that are on their way — up to `WRITES_WAIT_MS`, after which the offer comes back with `appUpdate.stillSaving` and nothing is reloaded — and then, if writes sit in the offline queue, for `QUEUE_ON_DISK_MS`, which must stay above the persister's `throttleTime` in [lib/queryClient.js](../src/lib/queryClient.js): a write queued this instant is in IndexedDB only once the throttle has passed. Raising the throttle means raising the constant.
- **The build id lives in `index.html`, never in a bundle.** The `sl-build-id` plugin of `vite.config.js` writes `<meta name="sl-build" content="…">`; `BUILD_ID` in [src/lib/buildInfo.js](../src/lib/buildInfo.js) reads it back (`NO_BUILD` where no build wrote one). A constant that changes with every build, inlined into the entry chunk, renames that chunk and every chunk that imports it: a deploy that changed no source would be a full download on every device. An id is the UTC time of the build, `YYYYMMDDHHmmss`, so ids compare as strings in the order of the builds; `SL_BUILD_ID` in the environment replaces it and must sort the same way (`makeBuildId` refuses anything but 1 to 64 letters, digits, `_`, `.`, `-`). **Consequence: every build has a new `index.html`, so a new `sw.js` — every deploy is an update for every device, including a deploy that changed no source.**
- **The page asks for a new version itself, and not more often than `CHECK_MIN_GAP_MS`.** A hash route change is not a navigation, so the browser never asks for a tab that stays open: `appUpdate` calls `registration.update()` on the return to the foreground, on `online`, and every `CHECK_EVERY_MS` (one hour). The gap (15 minutes) is what keeps the unlock between two sets from costing a request each time; a question that got no answer (no network) does not count towards it.
````

## docs/INVARIANTS.md — Web Push (rest-timer "Rest done" lock-screen notification)

Add at the end of the bullet that starts "**Custom service worker, not generated.**":

Its `install`, `activate` and `message` listeners are the update flow's: three lines that call `handleInstall`, `handleActivate` and `handleMessage` of [src/lib/swHandlers.js](../src/lib/swHandlers.js) — see "App updates".

## docs/ARCHITECTURE.md — new section "App updates", after "Scroll container"

Add the section:

````markdown
## App updates

Three files, one per place the code runs, and a fourth for what the page knows about its fields.

- **The worker** — [src/lib/swHandlers.js](../src/lib/swHandlers.js), wired by three lines at the end of [src/sw.js](../src/sw.js). `handleInstall` waits (or takes over, on a device that has never run a worker of this kind), `handleActivate` leaves the mark for the next worker and claims the open pages, `handleMessage` takes over on `{ type: 'SKIP_WAITING' }`. They are functions of the worker's scope so that vitest can run them.
- **The updater** — [src/lib/appUpdate.js](../src/lib/appUpdate.js): `createAppUpdater({ container, reload, storage, buildId })` and the app's one instance, `appUpdater`, started by [src/main.jsx](../src/main.jsx). It registers `sw.js`, follows the registration (`updatefound`, the workers' `statechange`, the container's `controllerchange`), asks the server for a new worker (`check`), and holds the state a component reads through `subscribe` / `getState`: `{ pending, applying, offered, failed }` — one frozen object per change, so `useSyncExternalStore` can read it. `pending` is "a new worker waits behind the active one", "the worker changed under this page" (`stale`) or "an attempt is under way". `apply()` posts `SKIP_WAITING` to the waiting worker — on a stale page there is no worker to tell, and it takes the one that serves the page — and waits for that worker (`awaited`) to be `activated`: `onWorkerState` then calls `arrive()`, which reloads. `controllerchange` comes about a second earlier in Chromium and reloads nothing; it makes the page `stale`. A stale page whose worker is `activated` already reloads at once. A worker that is not `activated` after `APPLY_TIMEOUT_MS`, or that becomes `redundant`, ends the attempt (`giveUp`): no reload, `failed`, and the update is offered again. `apply({ auto: true })` is the page acting on its own, and is the only form the loop guard and the second asking (in `arrive`) apply to.
- **The page** — [components/ui/UpdatePrompt.jsx](../src/components/ui/UpdatePrompt.jsx), mounted in `AppShell` before `ToastHost`. It answers the updater's one question (`watchForSafeMoment(probe)`), names the route change as a moment (`consider()` on `pathname`), and draws the card: "Updating…" while an update is applied — from the message to the worker until the page is replaced — and the offer with "Later" and "Update" otherwise — the sentence above, the two actions in a row below it, because side by side the French and German labels leave the sentence a column of two words on a phone. The card is fixed in the slot of the toasts, above the bottom nav; the offer is not drawn while a field is in use (`fieldWatch.inUse`). "Later" hides the offer until the next moment.
- **The fields** — [src/lib/fieldWatch.js](../src/lib/fieldWatch.js): `createFieldWatch(doc)` and the app's one instance, `fieldWatch`, which listens to the document (`focusin`, `focusout`, `input`, `change`, capture phase) while it has a subscriber — `UpdatePrompt`, through `useSyncExternalStore(fieldWatch.subscribe, fieldWatch.inUse)`. `hasFocus()` and `holdsTypedText()` are two of the probe's five answers; `inUse()` — the focus, or `FIELD_LEFT_MS` after it left a field — decides whether the offer is drawn. `isField` is the one definition of "a control that holds what someone is typing or choosing".

One update, on a phone in the middle of a session: the app comes back to the foreground → `check()` → the new worker installs and waits → `consider()` → a rest timer runs, so the update is offered, not applied → "Later", or nothing → the rest ends (not a moment) → the next return to the app finds nothing in progress → `SKIP_WAITING`, and the card says "Updating…" → `activating`, `controllerchange` → about a second, in Chromium, during which the page is still the old one and still in use → `activated` → the probe is asked once more → the reload, on the route the hash still names, some 15 ms later.

Two windows: the one with nothing in progress applies the update; the worker it activated claims the other one, which hears `controllerchange` without having asked and becomes `pending`: with nothing in progress it reloads by itself, once that worker is `activated` and the probe has been asked again; otherwise it offers the reload.

Tests: `src/lib/appUpdate.test.js` and `src/components/ui/UpdatePrompt.test.jsx` run the real updater — and the real rest timer and a real `QueryClient` — over [src/test/fakeServiceWorker.js](../src/test/fakeServiceWorker.js) (`fakeBrowser()`: a container, a registration and workers, with the moves a browser makes, in the browser's order: `find`, `installed`, `waitingWorker`, `activating`, `activated`, and `takeOver` for the last two at once); `src/lib/fieldWatch.test.js` holds the fields; `src/lib/swHandlers.test.js` runs the handlers over a Cache Storage that outlives the workers; `src/sw.test.js` loads `src/sw.js` itself; `src/main.test.jsx` holds the registration and the two plugin options.
````

## README.md — Offline Support (Student Session Logging)

Replace the bullet that starts "- **App-shell precache** — `vite-plugin-pwa` (`registerType: 'autoUpdate'`)" with:

- **App-shell precache** — `vite-plugin-pwa` (`injectManifest`) compiles [src/sw.js](src/sw.js) into `dist/sw.js`, which precaches the page, the JS/CSS bundles and the icons, and caches Google Fonts as they are used. The page loads with no network at all.
- **Updates** — the page registers the worker itself and decides when a new version takes over ([src/lib/appUpdate.js](src/lib/appUpdate.js)). It asks for one on every return to the app (at most every 15 minutes) and once an hour; the new worker installs and waits. With nothing in progress — no write pending or queued, no rest timer, no field being typed in, no text typed and not sent yet, no dialog open — the page applies it and reloads by itself, about a second later. Otherwise a card above the bottom nav offers it ("Update" / "Later"), and it is applied at the next return to the app or the next page where nothing is in progress.

## README.md — Offline Support (Student Session Logging)

Add after the numbered list under "To verify locally:":

To see an update arrive locally: with `npm run preview` running and the app open and signed in, run `npm run build` again — every build is a new version — then DevTools → Application → Service Workers → **Update**. The new worker shows as "waiting to activate" for the moment it takes the page to apply it, and the page says "Updating…" for the second the browser takes to activate it. With a rest timer running it stays waiting and the offer appears instead; with the cursor in a field, or with text typed in one, it stays waiting too, and the offer appears a moment after the field is left.

## README.md — Deployment

Add after the paragraph that starts "Pushing to `main` deploys automatically.":

Every deploy is a new version for every device, including one that changed no source: `index.html` carries the id of its build (`<meta name="sl-build">`, the UTC time of the build), so the service worker that lists it is new each time. An open app finds the deploy when it next returns to the foreground, or within the hour, and reloads once nothing is in progress. The `<head>` of the published `index.html` says which build is live.

## docs/runbook/40-deploy.md — 7. Putting an older app back

Add after the paragraph that starts "One limit the check does not know":

One thing the devices do after it: an app from before the update flow (before wave 2) takes over on every device by itself, as it always did — but the deploy that follows it does not. Its service worker waits to be asked by the page, and the pages of the older app cannot ask. On a device that had already run a wave-2 app, that next deploy arrives when the app is closed and opened again (on a phone: swiped away, or after the system has put it to sleep), not on a reload. Nothing is lost meanwhile; the device simply stays on the older app until then.

## CLAUDE.md — Repo map

Replace the two lines that start "  sw.js          custom service worker" with:

```
  sw.js          custom service worker (vite-plugin-pwa injectManifest mode):
                 push + notificationclick handlers for rest-timer Web Push;
                 install/activate/message = lib/swHandlers.js
```

Add to the `lib/` list, after the line of `loggedSets.js`:

```
                 appUpdate.js (createAppUpdater/appUpdater — registers the worker, asks for new
                 versions, applies one when the page says it is safe; the flow's one reload,
                 asked for when the new worker is activated)
                 fieldWatch.js (isField, createFieldWatch/fieldWatch — a field has the focus, was
                 just left, or holds text that was typed into it)
                 swHandlers.js (what the worker does at install, activate and on a message;
                 SKIP_WAITING and the mark that tells a first worker apart)
                 buildInfo.js (makeBuildId at build time, BUILD_ID at run time — the id is a
                 <meta> of index.html)
```

Replace, in the `ui/` list, "ErrorBoundary  NotFound" with:

```
                 ErrorBoundary  NotFound  UpdatePrompt
```

Add to the `test/` list, after the line of `fakePostgrest.js`:

```
                 fakeServiceWorker.js (fakeBrowser — a container, a registration and workers
                 that are found, install, wait and take over in two steps, activating then
                 activated; memoryStorage)
```

## CLAUDE.md — Feature → files map, new row after "Offline support (student writes)"

Add the row:

| App updates (a new version is asked for, waits, and is applied when nothing would be lost) | `lib/appUpdate` (`appUpdater`: `start` registers `sw.js`, `check` asks on return to the app / `online` / hourly, `consider` applies at a safe moment or offers, `apply` posts `SKIP_WAITING` and holds the flow's one reload, asked for when the worker is `activated` — not at `controllerchange` — `watchForSafeMoment`), `ui/UpdatePrompt` (in `layout/AppShell`, before `ToastHost`: the probe — pending write, rest timer, focused field, text typed and not sent, open dialog — and the "Update / Later" card), `lib/fieldWatch` (`hasFocus`, `holdsTypedText`, and `inUse` — the offer is not drawn until `FIELD_LEFT_MS` after a field is left), `lib/swHandlers` (`handleInstall`/`handleActivate`/`handleMessage`, wired at the end of `src/sw.js`; the mark `UPDATE_MARK_CACHE`), `lib/buildInfo` (`BUILD_ID` from `<meta name="sl-build">`), `vite.config.js` (`sl-build-id` plugin, `registerType: 'prompt'`, `injectRegister: false`), `src/main.jsx` (`appUpdater.start`), strings in the `appUpdate` namespace (`lib/i18n/fragments/pwa-update-flow.<lang>.js`). Tests: `lib/appUpdate.test.js`, `ui/UpdatePrompt.test.jsx`, `lib/fieldWatch.test.js`, `lib/swHandlers.test.js`, `src/sw.test.js`, `src/main.test.jsx`, `layout/AppShell.test.jsx`, `lib/buildInfo.test.js`, over `test/fakeServiceWorker` |
