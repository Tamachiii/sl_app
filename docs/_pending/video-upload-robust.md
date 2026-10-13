# video-upload-robust — docs to fold (wave 2, items P29, B30)

Each block: target doc, section, then the text to fold in.

## docs/INVARIANTS.md — RLS / DB conventions

Add after the bullet that starts "A set video is stored at `<athlete's profile id>/<exercise slot of its set>/<file>`, and nowhere else.":

- **The row of a set video always names a file that exists: the new file first, then the row, then the old file.** [`useUploadSetVideo`](../src/hooks/useSetVideo.js) (`saveSetVideo`) uploads the clip at a path of its own, then points the row at it — an UPDATE of the row that is there (`set_log_id` is UNIQUE, so "insert the new row, delete the old one" cannot be written), an INSERT when the set had no video — and removes the previous file last. `useDeleteSetVideo` deletes the row with `.select('id')` and removes the file only when a row came back: the database answers an athlete's delete on a closed session by reaching no row, without an error. Either order reversed loses a video — a failed upload after the old file is gone, or a row left pointing at nothing. Three rules to keep when editing it: **a file is removed only when it is certain that no row names it** — after a row write the database refused (`refusedByDatabase`: a SQLSTATE or a `PGRST` code), never after one that got no answer, because that row may name the new file by now; **the last step never fails the mutation** — `removeUnreferenced` reads the error of `remove()`, treats an empty answer as "not removed" (what Storage returns when its policy keeps the file out of reach), and passes what stays behind to `reportError` with its path; and **the file is checked before the first request** — `videoFileProblem` in [lib/setVideoFile.js](../src/lib/setVideoFile.js): one of the bucket's three types, not empty (`size_bytes` is `CHECK > 0`), 25 MB at most. `lib/setVideoFile.test.js` reads the bucket's list out of `supabase/schema.sql`: a type added to the bucket is added to `ACCEPTED_VIDEO_TYPES` in the same change.
- **The progress and the cancel of a video upload are module state, by set — not state of the button.** `VideoUploadButton` is unmounted when its card closes, and ticking the last set of an exercise closes it (`SessionView`'s accordion), while the upload goes on: the mutation does not belong to the component. [lib/setVideoUploads.js](../src/lib/setVideoUploads.js) holds one entry per set that is uploading (`beginVideoUpload` / `end()` around `saveSetVideo`, `cancelVideoUpload` from the button) and the button reads its set through `useSyncExternalStore`, so the one that is mounted again shows the upload and can stop it, and a second upload of the same set is refused. So: **never abort an upload when the button unmounts** (it would kill the upload each time an athlete finishes the exercise), and **do not move progress, the `AbortController` or an `onError` into the button** — a callback passed to `mutate()` is dropped at unmount. For the same reason a failed upload is told from the hook: the mutation carries `meta: { skipErrorToast: true }` and its own `onError` pushes one toast (`uploadErrorKey`), whether or not the button is still there; removing one without the other gives two messages or none. A cancel (`isAbortError`) says nothing. Cancel is honoured up to the row write: stopped after the last byte and before it, the new file is removed; after it the replace has happened. The upload itself is [lib/storageUpload.js](../src/lib/storageUpload.js) (`uploadObject`), an `XMLHttpRequest` that sends the request storage-js sends for a Blob, because `supabase.storage.upload()` has no progress and takes no signal — do not go back to it. The two lines the button adds under a set (the `progressbar` and the refusal) are `order-last`: the component renders into `SetRow`'s wrapping flex container, ahead of the Actual and RPE pills, and a full-width line in that place pushes them under it.

## docs/INVARIANTS.md — RLS / DB conventions

Replace, in the bullet that starts "A set video is stored at `<athlete's profile id>/<exercise slot of its set>/<file>`, and nowhere else.", the words "a file whose row is gone stays in the bucket, readable by its athlete and their coach, and removable by the athlete only while the session of the slot in its path is writable." with:

a file whose row is gone stays in the bucket, readable by its athlete and their coach, and removable by the athlete only while the session of the slot in its path is writable — which is also what a clean-up that failed leaves: the old file of a replace, the file of a deleted video, the file of an upload that was cancelled or whose row was refused. The app removes each of them best-effort and reports the ones it could not remove (`removeUnreferenced` in `hooks/useSetVideo.js` → `reportError`, with the path), so they show in the coach's error list; nothing in the app lists or removes them afterwards. Two devices that replace the video of the same set at the same moment leave the file of the one that wrote its row first: each read the row before its upload.

## docs/ARCHITECTURE.md — Set video uploads

Replace the bullet that starts "**Client caps uploads at 25 MB**" with:

- **The client checks the file before it sends anything** (`videoFileProblem`, `lib/setVideoFile.js`): one of the bucket's three types — `video/mp4`, `video/quicktime`, `video/webm`, compared without parameters and in lower case — not empty, and 25 MB at most (the bucket caps at 30 MB). `VideoUploadButton` asks when the file is picked and writes the reason under the set; the hook asks again for any other caller. A type with parameters (`video/webm;codecs=vp9`) is stored and sent under its bare type (`videoUploadBody`). No client-side re-encoding.
- **The upload is an `XMLHttpRequest`** (`uploadObject`, `lib/storageUpload.js`): `POST <VITE_SUPABASE_URL>/storage/v1/object/set-videos/<path>` with `apikey`, `Authorization: Bearer <the session's access token>` and `x-upsert: false`, and a multipart body whose part named `''` is the file — the request storage-js sends for a Blob. It reports the bytes that left (`upload.onprogress`) and stops on a signal; the service worker has no route for the API's origin, so the count is real. A dropped connection rejects with `code: UPLOAD_NETWORK`, a refusal with the `message` and `statusCode` of the Storage API's body, a cancel with an `AbortError`.
- **Progress and cancel** are kept by set in `lib/setVideoUploads.js` and read by the button through `useSyncExternalStore`: while a clip is on its way the upload/replace button is the cancel button, with the progress drawn around it and a `progressbar` line under the row. Listeners are told once per whole percent.
- **Errors**: a file refused before the upload is written under the set and starts no mutation; an upload that fails is one toast, pushed by the hook (`videoUpload.failed`, `videoUpload.connectionLost`, `videoUpload.wrongType`, or the key `mutationErrorKey` gives for a refusal of row-level security); a cancel says nothing. Deleting uses the query client's toast.

## docs/ARCHITECTURE.md — Set video uploads

Replace the bullet that starts "**Replacement uploads** delete the old object + row first" with:

- **Replacement uploads** upload the new file first, then UPDATE the row in place (`storage_path`, `mime_type`, `size_bytes` — `UNIQUE(set_log_id)` leaves no room for a second row), then remove the old file best-effort. A failed or cancelled upload leaves the previous video as it was. Deleting removes the row first and the file after it. See "The row of a set video always names a file that exists" in [INVARIANTS.md](INVARIANTS.md).

## README.md — Offline Support (Student Session Logging)

Replace the bullet that starts "**Video uploads** — `VideoUploadButton` is gated on `useOnlineStatus()`" with:

- **Video uploads** — `VideoUploadButton` is gated on `useOnlineStatus()` and the CTA flips to "Connect to record video" when offline. Supabase Storage has no resumable background-upload story we can lean on safely on mobile, so an upload is one request: it shows its progress, can be cancelled, and starts again from zero if the connection drops. A file that is not an MP4, MOV or WebM video, or that is above 25 MB, is refused before anything is sent. Replacing a video keeps the previous one until the new one is saved, so a failed or cancelled upload loses nothing.

## CLAUDE.md — Repo map

Add to the `lib/` lines, after the line that starts "loggedSets.js (isLoggedSet":

```
                 setVideoFile.js (videoFileProblem — what a set video must be before it is sent:
                 the bucket's three types, not empty, 25 MB)
                 storageUpload.js (uploadObject — one upload to Storage with progress and abort)
                 setVideoUploads.js (the video uploads in flight, by set: progress and cancel
                 outside the button, which is unmounted while the upload goes on)
```

## CLAUDE.md — Feature → files map, row "Set video upload/playback"

Replace the row's file list, up to the semicolon before "migration `2026_10_12_08_session_write_gates.sql`", with:

`student/VideoUploadButton` (pre-flight refusal under the set, progress ring + cancel in place of upload/replace), `ui/VideoPlayer`, `coach/SessionReview`, `hooks/useSetVideo` (`useUploadSetVideo`: new file → row → old file, one toast of its own; `useDeleteSetVideo`: row → file), `lib/setVideoFile` (`videoFileProblem`, `ACCEPTED_VIDEO_TYPES`, `MAX_VIDEO_BYTES`), `lib/storageUpload` (`uploadObject`, `isAbortError`, `UPLOAD_NETWORK`), `lib/setVideoUploads` (`beginVideoUpload` / `cancelVideoUpload` / `getVideoUpload`), strings in the `videoUpload` namespace

## docs/RUNBOOK.md — the checkpoint that publishes the wave-2 app

Add to the step that tries the published app as an athlete, on a phone, signed in as the test athlete and on a session of theirs that is in progress (a set the coach marked "Record"):

1. **Progress.** Upload a clip of 10 MB or more on mobile data: the camera button becomes a cross with a ring that fills, and "Uploading video… N%" counts up under the set. When it ends the play button is there and the clip plays.
2. **Cancel.** On a set that already has a video, tap Replace, pick another clip, and tap the cross before the ring is full: the line goes away, no message appears, and the play button still plays the FIRST clip.
3. **A failed replace.** Start a replace and switch the phone to airplane mode while the ring fills: one message appears ("The connection dropped during the upload"), and once back online the play button still plays the first clip.
4. **A file that is refused.** Pick a photo, or a clip above 25 MB: the reason appears under the set at once, in the app's language, and nothing is uploaded.
5. **The card that closes.** Start an upload on the last set of an exercise and tick that set: the card closes. Open it again: the ring is still filling, and the cross still stops it.

What a test cannot show and these do: that `upload.onprogress` moves on iOS, and that the Storage API takes the request of `lib/storageUpload.js` as it takes the one of storage-js. If step 1 fails with a message on every clip while the app published before it uploads fine, revert the commit "fix(video): an upload shows its progress, can be cancelled, and fails in one place": it stands on top of "fix(video): the previous video is kept until the new one is saved", which keeps the safe order with the storage client's own upload.
