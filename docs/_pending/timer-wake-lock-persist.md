# timer-wake-lock-persist — docs to fold (wave 2, items P28, B31)

Each block: target doc, section, then the text to fold in.

## docs/INVARIANTS.md — Rest timer

Replace, in the bullet that starts "Rest timer is an app-wide singleton with one rendering site.", the sentence "[hooks/useRestTimer.js](../src/hooks/useRestTimer.js) holds one `{ logId, endsAt }` in module-scope and exposes it via `useSyncExternalStore`." with:

[hooks/useRestTimer.js](../src/hooks/useRestTimer.js) holds one `{ logId, endsAt }` in module scope, keeps a copy of it in `localStorage` (next bullet) and exposes it via `useSyncExternalStore`.

## docs/INVARIANTS.md — Rest timer

Add after the bullet that starts "Rest timer is an app-wide singleton with one rendering site.":

- **The running rest is also in `localStorage`: written by the store on every change of the timer, read once when the module loads.** iOS kills a PWA in the background — filming a set with the Camera app is enough — and module memory goes with it. [hooks/useRestTimer.js](../src/hooks/useRestTimer.js) writes `{ logId, endsAt }` under the key `sl_rest_timer` from `commit`, the one function through which `startRestTimer`, `clearRestTimer` and `resetRestTimer` change the timer, and removes the key when there is no timer. **Whatever changes `endsAt` goes through `commit`**, never through `state = …`: a skip or a "+30 s" written beside it leaves the old end time in storage, and the next launch brings back a rest the athlete had ended. `emit` — the 1 s tick and the `visibilitychange`/`focus` refresh — goes around `commit` on purpose and writes nothing. `readStored` runs once, at module load, and takes back only a non-empty string `logId` with a finite `endsAt` strictly after `Date.now()`; a rest that ended while the app was gone, and any value the module did not write, is removed and the app starts with no timer (a "Rest done" for a rest of ten minutes ago is noise). Do not move that read into `subscribe` or `getSnapshot`: a lazy read hands a test the timer another test left. Nothing is removed at expiry while the app is open; the next load discards it. Every access is inside a `try`: storage that refuses (private mode, quota) leaves the timer running in memory. The key is private to this file and holds a set id and a time; signing out does not remove it, and it stops being read when the rest ends. Two things follow from a restored rest: the effects hook treats it as a rest that just started (wake lock, beep at `endsAt`), and [hooks/useRestTimerPush.js](../src/hooks/useRestTimerPush.js) schedules a push for it while the row scheduled before the kill was never cancelled, so two pushes with the same tag can arrive for one rest.

## docs/INVARIANTS.md — Rest timer

Replace, in the bullet that starts "Out-of-band rest-timer effects ride the singleton via two hooks", the parenthesis "(re-acquires on `visibilitychange → visible` because the browser auto-releases on hide)" with:

(the browser releases the lock by itself when the page is hidden, and a released `WakeLockSentinel` is a dead object: the sentinel's `release` event clears the handle, a sentinel whose `released` is `true` counts as no lock, and `visibilitychange → visible` requests a new one for as long as `Date.now() < endsAt`. A page hidden and shown while a request is in flight sends a second request; the one that resolves second is released at once, never stored over the first, because a sentinel that is not stored is never released and keeps the screen on after the rest)

## docs/INVARIANTS.md — Rest timer

Replace, in the bullet that starts "Out-of-band rest-timer effects ride the singleton via two hooks", the sentence "The AudioContext is created/resumed on the first `pointerdown` so iOS lets it play unattended at expiry." with:

The AudioContext is created/resumed on the first `pointerdown` so iOS lets it play unattended at expiry. On iOS, Web Audio plays in the "ambient" audio session, which the ring/silent switch mutes; where `navigator.audioSession` exists, `playBeep` calls `takePlaybackSession`, which sets `navigator.audioSession.type` to `'playback'` for the beep, starts the beep 250 ms later (the type is applied in a task that runs after the assignment), and puts back the type it found 250 ms after the beep's last sample. **`'playback'` is taken for the beep only — never on the first `pointerdown`, never for the length of the session**: it is an exclusive type, and a page that holds it takes the phone's audio from the athlete's music instead of mixing with it. A type that is already `'playback'` is left to whoever set it, and nothing is written where the property does not exist. What the phone does with this is visible on an iPhone only; the tests in `useRestTimerEffects.test.js` hold when the property is written and that it is put back.

## README.md — Rest Timer (in-app + Web Push)

Add after the paragraph that starts "The student rest timer is an app-wide singleton":

A rest that is running is also written to `localStorage` (key `sl_rest_timer`). iOS kills a PWA in the background — opening the Camera app to film a set is enough — and when the athlete opens the app again the rest is still running, with the time it really has left. A rest that ended in the meantime is dropped.

## README.md — Rest Timer (in-app + Web Push)

Replace, in the bullet that starts "**In-app polish —", the words "the hook acquires `navigator.wakeLock` so the phone screen stays awake," with:

the hook acquires `navigator.wakeLock` so the phone screen stays awake — and acquires it again each time the athlete comes back to the app during the rest, because the browser releases it when the page is hidden —

## README.md — Rest Timer (in-app + Web Push)

Replace, in the bullet that starts "**In-app polish —", the sentence "The AudioContext is unlocked on the first `pointerdown` so iOS lets the cue play unattended." with:

The AudioContext is unlocked on the first `pointerdown` so iOS lets the cue play unattended. On an iPhone the beep asks for the `playback` audio session (`navigator.audioSession`) for its own length, so that it is heard with the ring/silent switch on; the session goes back to what it was right after, so that the app does not hold the phone's audio against the athlete's music. With the app in the background or the phone locked there is no sound — iOS plays no Web Audio from a background PWA — and the push below is the signal.

## docs/RUNBOOK.md — the checkpoint that publishes the wave-2 app

Add to the step that tries the published app as an athlete, on an iPhone (iOS 17 or later, the app installed on the Home Screen):

1. **The beep on silent.** Ring/silent switch on silent, no music. Validate a set with a short rest and keep the app open: the beep is heard when the rest ends.
2. **The beep and music.** Start music in another app, switch off silent, validate a set. Note what the music does when the rest ends — it may stop for the second the beep takes, or stay stopped until it is started again — and whether that is acceptable for the athletes. If it is not, revert the commit "fix(rest-timer): the end-of-rest sound plays with the silent switch on": it stands alone, and the app goes back to a beep that mixes with music and is muted on silent.
3. **The screen.** During a rest of two minutes, open another app for a few seconds and come back: the screen stays on until the rest ends, and locks normally after it.
4. **A kill.** During a rest, open the Camera app, then remove the app from the app switcher and open it again on the same session: the rest is still counting, with the time that is left.
