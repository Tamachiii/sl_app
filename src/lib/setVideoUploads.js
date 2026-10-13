// The set-video uploads that are running, by set.
//
// Module state, not component state. `VideoUploadButton` lives in a row of an
// exercise card, and the card is unmounted when it closes — which is what
// ticking the last set of an exercise does. An upload started just before
// goes on (the mutation does not belong to the component), but a progress and
// a cancel kept in the button would be gone, and the button of the card
// opened again would offer to upload a second clip beside the first. Here the
// button that comes back finds the upload it started.
//
// `useUploadSetVideo` begins and ends an entry; the button reads one through
// `subscribeVideoUploads` / `getVideoUpload` and stops it with
// `cancelVideoUpload`. Nothing is persisted: an upload does not survive the
// page.

const uploads = new Map(); // setLogId → { percent, cancelled, controller }
const listeners = new Set();

function emit() {
  for (const listener of listeners) listener();
}

export function subscribeVideoUploads(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// The upload of this set, or null. The same object until something changes —
// `useSyncExternalStore` compares snapshots by identity.
export function getVideoUpload(setLogId) {
  return uploads.get(setLogId) ?? null;
}

/**
 * Registers the upload of a set. Returns null when one is already running for
 * it, otherwise what the upload needs:
 *   signal             aborted by `cancelVideoUpload`
 *   progress(fraction) 0…1; listeners are told once per whole percent
 *   end()              removes the entry — call it in a `finally`
 */
export function beginVideoUpload(setLogId) {
  if (uploads.has(setLogId)) return null;
  const controller = new AbortController();
  uploads.set(setLogId, { percent: 0, cancelled: false, controller });
  emit();

  const mine = () => {
    const entry = uploads.get(setLogId);
    return entry?.controller === controller ? entry : null;
  };

  return {
    signal: controller.signal,
    progress(fraction) {
      const entry = mine();
      if (!entry) return;
      const percent = Math.max(0, Math.min(100, Math.floor(Number(fraction) * 100) || 0));
      // XHR reports every few milliseconds: a row re-renders per percent, and
      // a figure that went up never comes back down.
      if (percent <= entry.percent) return;
      uploads.set(setLogId, { ...entry, percent });
      emit();
    },
    end() {
      if (!mine()) return;
      uploads.delete(setLogId);
      emit();
    },
  };
}

// Asks the upload of this set to stop. The entry stays, marked `cancelled`,
// until the upload has unwound and called `end()`.
export function cancelVideoUpload(setLogId) {
  const entry = uploads.get(setLogId);
  if (!entry || entry.cancelled) return;
  uploads.set(setLogId, { ...entry, cancelled: true });
  emit();
  entry.controller.abort();
}

/** Test helper: forget every upload. */
export function resetVideoUploads() {
  uploads.clear();
  emit();
}
