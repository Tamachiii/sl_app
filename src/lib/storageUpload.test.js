import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./supabase', () => ({
  supabase: { auth: { getSession: vi.fn() } },
}));

import { uploadObject, isAbortError, abortError, UPLOAD_NETWORK } from './storageUpload';
import { supabase } from './supabase';

// What the page's XMLHttpRequest is to this module: the calls it makes, and
// the four ways a request ends.
class FakeXhr {
  static sent = [];

  constructor() {
    this.upload = {};
    this.headers = {};
    this.status = 0;
    this.responseText = '';
  }

  open(method, url) {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name, value) {
    this.headers[name] = value;
  }

  send(body) {
    this.body = body;
    FakeXhr.sent.push(this);
  }

  abort() {
    this.aborted = true;
    this.onabort?.();
  }

  progress(loaded, total, lengthComputable = true) {
    this.upload.onprogress?.({ loaded, total, lengthComputable });
  }

  answer(status, body) {
    this.status = status;
    this.responseText = typeof body === 'string' ? body : JSON.stringify(body);
    this.onload?.();
  }
}

// The request, once the module has sent it (it reads the session first).
async function sentRequest() {
  await vi.waitFor(() => expect(FakeXhr.sent).toHaveLength(1));
  return FakeXhr.sent[0];
}

const file = new File(['abc'], 'clip.mp4', { type: 'video/mp4' });
const upload = (extra = {}) =>
  uploadObject({ bucket: 'set-videos', path: 'u-1/sl-1/1-abc.mp4', body: file, ...extra });

beforeEach(() => {
  FakeXhr.sent = [];
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
  vi.stubEnv('VITE_SUPABASE_URL', 'https://project.example.test/');
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key');
  supabase.auth.getSession.mockReset();
  supabase.auth.getSession.mockResolvedValue({
    data: { session: { access_token: 'user-token' } },
    error: null,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('uploadObject — the request', () => {
  it('is the request storage-js sends: POST to the object, the three headers, a multipart body', async () => {
    const done = upload();
    const xhr = await sentRequest();

    expect(xhr.method).toBe('POST');
    expect(xhr.url).toBe(
      'https://project.example.test/storage/v1/object/set-videos/u-1/sl-1/1-abc.mp4',
    );
    expect(xhr.headers).toEqual({
      apikey: 'anon-key',
      Authorization: 'Bearer user-token',
      'x-upsert': 'false',
    });
    expect(xhr.body).toBeInstanceOf(FormData);
    expect(xhr.body.get('cacheControl')).toBe('3600');
    // The file is the part named '' — its own type is the type of the part,
    // which is what the bucket compares with its list.
    expect(xhr.body.get('')).toBeInstanceOf(File);
    expect(xhr.body.get('').type).toBe('video/mp4');

    xhr.answer(200, { Id: 'o-1', Key: 'set-videos/u-1/sl-1/1-abc.mp4' });
    await expect(done).resolves.toEqual({ path: 'u-1/sl-1/1-abc.mp4' });
  });

  it('never sets a Content-Type: the browser writes the multipart boundary', async () => {
    const done = upload();
    const xhr = await sentRequest();
    expect(Object.keys(xhr.headers).map((h) => h.toLowerCase())).not.toContain('content-type');
    xhr.answer(200, {});
    await done;
  });

  it('sends nothing without a session', async () => {
    supabase.auth.getSession.mockResolvedValue({ data: { session: null }, error: null });
    await expect(upload()).rejects.toThrow(/not signed in/i);
    expect(FakeXhr.sent).toHaveLength(0);
  });

  it('sends nothing when the session cannot be read', async () => {
    supabase.auth.getSession.mockResolvedValue({ data: { session: null }, error: new Error('boom') });
    await expect(upload()).rejects.toThrow('boom');
    expect(FakeXhr.sent).toHaveLength(0);
  });
});

describe('uploadObject — progress', () => {
  it('reports the fraction of the bytes that left, and 1 when the server has answered', async () => {
    const onProgress = vi.fn();
    const done = upload({ onProgress });
    const xhr = await sentRequest();

    xhr.progress(250, 1000);
    xhr.progress(750, 1000);
    expect(onProgress.mock.calls).toEqual([[0.25], [0.75]]);

    xhr.answer(200, {});
    await done;
    expect(onProgress).toHaveBeenLastCalledWith(1);
  });

  it('says nothing for an event whose total is unknown', async () => {
    const onProgress = vi.fn();
    const done = upload({ onProgress });
    const xhr = await sentRequest();
    xhr.progress(250, 0, false);
    expect(onProgress).not.toHaveBeenCalled();
    xhr.answer(200, {});
    await done;
  });
});

describe('uploadObject — the ways it fails', () => {
  it('a refusal carries the message and the statusCode of the body', async () => {
    const done = upload();
    const xhr = await sentRequest();
    // The Storage API answers 400 and says why in the body.
    xhr.answer(400, {
      statusCode: '403',
      error: 'Unauthorized',
      message: 'new row violates row-level security policy',
    });
    await expect(done).rejects.toMatchObject({
      name: 'StorageApiError',
      message: 'new row violates row-level security policy',
      status: 400,
      statusCode: '403',
    });
  });

  it('a refusal that is not JSON still rejects, with the HTTP status', async () => {
    const done = upload();
    const xhr = await sentRequest();
    xhr.answer(502, '<html>Bad gateway</html>');
    await expect(done).rejects.toMatchObject({ status: 502, statusCode: '502' });
  });

  it('a dropped connection rejects with the network code', async () => {
    const done = upload();
    const xhr = await sentRequest();
    xhr.onerror();
    await expect(done).rejects.toMatchObject({ code: UPLOAD_NETWORK });
  });
});

describe('uploadObject — cancel', () => {
  it('a signal that aborts stops the request and rejects with an AbortError', async () => {
    const controller = new AbortController();
    const done = upload({ signal: controller.signal });
    const xhr = await sentRequest();

    controller.abort();

    expect(xhr.aborted).toBe(true);
    const error = await done.catch((e) => e);
    expect(isAbortError(error)).toBe(true);
  });

  it('a signal already aborted sends nothing, not even the session read', async () => {
    const controller = new AbortController();
    controller.abort();
    const error = await upload({ signal: controller.signal }).catch((e) => e);
    expect(isAbortError(error)).toBe(true);
    expect(supabase.auth.getSession).not.toHaveBeenCalled();
    expect(FakeXhr.sent).toHaveLength(0);
  });

  it('a signal that aborts while the session is read sends nothing', async () => {
    const controller = new AbortController();
    let release;
    supabase.auth.getSession.mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve({ data: { session: { access_token: 't' } }, error: null });
      }),
    );
    const done = upload({ signal: controller.signal });
    controller.abort();
    release();
    const error = await done.catch((e) => e);
    expect(isAbortError(error)).toBe(true);
    expect(FakeXhr.sent).toHaveLength(0);
  });

  it('an abort after the answer changes nothing', async () => {
    const controller = new AbortController();
    const done = upload({ signal: controller.signal });
    const xhr = await sentRequest();
    xhr.answer(200, {});
    await done;
    controller.abort();
    expect(xhr.aborted).toBeUndefined();
  });
});

describe('isAbortError', () => {
  it('knows the module’s own error and a DOM one, and nothing else', () => {
    expect(isAbortError(abortError())).toBe(true);
    expect(isAbortError(new DOMException('x', 'AbortError'))).toBe(true);
    expect(isAbortError(new Error('x'))).toBe(false);
    expect(isAbortError(null)).toBe(false);
  });
});
