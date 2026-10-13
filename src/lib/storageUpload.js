import { supabase } from './supabase';

// One upload to Supabase Storage that reports how far it is and can be
// stopped.
//
// `supabase.storage.from(bucket).upload()` is a single fetch: it has no
// progress, and its options take no signal, so nothing can stop it. An
// XMLHttpRequest has both. This sends the request storage-js sends for a Blob
// — same address, same headers, same multipart body — so the server and its
// policies see no difference.
//
// The service worker has no route for the API's origin (src/sw.js), so the
// request leaves the page directly and `upload.onprogress` counts bytes that
// really left.

// `code` of the error when no answer came back: the connection dropped, or the
// request never left.
export const UPLOAD_NETWORK = 'UPLOAD_NETWORK';

export function abortError() {
  const error = new Error('Upload cancelled');
  error.name = 'AbortError';
  return error;
}

export function isAbortError(error) {
  return error?.name === 'AbortError';
}

function networkError() {
  const error = new Error('The upload got no answer');
  error.name = 'StorageUploadNetworkError';
  error.code = UPLOAD_NETWORK;
  return error;
}

// A refusal of the Storage API, shaped like the error storage-js returns:
// `message` and `statusCode` come from the body, `{ statusCode, error, message }`.
// The body's `statusCode` is the one that says why (403, 413, 415); the HTTP
// status of the answer is often 400 whatever the reason.
function refusal(xhr) {
  let body = null;
  try {
    body = JSON.parse(xhr.responseText);
  } catch {
    // Not JSON: a page of the gateway.
  }
  const error = new Error(body?.message || body?.error || `Upload refused (HTTP ${xhr.status})`);
  error.name = 'StorageApiError';
  error.status = xhr.status;
  error.statusCode = String(body?.statusCode ?? xhr.status);
  return error;
}

function objectUrl(bucket, path) {
  const base = String(import.meta.env.VITE_SUPABASE_URL ?? '').replace(/\/+$/, '');
  const encoded = String(path)
    .replace(/^\/+/, '')
    .split('/')
    .map(encodeURIComponent)
    .join('/');
  return `${base}/storage/v1/object/${encodeURIComponent(bucket)}/${encoded}`;
}

/**
 * Uploads `body` (a File or a Blob) as a NEW object: an existing one is never
 * overwritten (`x-upsert: false`).
 *
 * `onProgress(fraction)` is called with 0…1 as the bytes leave. `signal`
 * stops the request; the promise then rejects with an `AbortError`
 * (`isAbortError`). A dropped connection rejects with `code: UPLOAD_NETWORK`,
 * a refusal of the server with its `message` and `statusCode`.
 */
export async function uploadObject({ bucket, path, body, signal, onProgress }) {
  if (signal?.aborted) throw abortError();

  // The signed-in user's token, as the client's own requests carry it.
  // getSession renews one that is about to expire.
  const { data, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw sessionError;
  const token = data?.session?.access_token;
  if (!token) throw new Error('Not signed in');
  if (signal?.aborted) throw abortError();

  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const onAbort = () => xhr.abort();
    const settle = (fn, value) => {
      signal?.removeEventListener('abort', onAbort);
      fn(value);
    };

    xhr.open('POST', objectUrl(bucket, path));
    xhr.setRequestHeader('apikey', import.meta.env.VITE_SUPABASE_ANON_KEY);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('x-upsert', 'false');
    // No Content-Type: the browser writes the multipart boundary itself.

    if (onProgress) {
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
      };
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress?.(1);
        settle(resolve, { path });
      } else {
        settle(reject, refusal(xhr));
      }
    };
    xhr.onerror = () => settle(reject, networkError());
    xhr.ontimeout = () => settle(reject, networkError());
    xhr.onabort = () => settle(reject, abortError());

    signal?.addEventListener('abort', onAbort, { once: true });

    const form = new FormData();
    form.append('cacheControl', '3600');
    form.append('', body);
    xhr.send(form);
  });
}
