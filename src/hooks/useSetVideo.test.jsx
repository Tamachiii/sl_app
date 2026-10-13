import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('../lib/supabase', () => {
  const storage = {
    from: vi.fn(),
  };
  return {
    supabase: {
      from: vi.fn(),
      storage,
    },
  };
});
vi.mock('./useAuth', () => ({ useAuth: vi.fn() }));
// The real reporter writes to `client_errors` through supabase.from(): it
// would be taken for a write of the hook.
vi.mock('../lib/errorReporter', () => ({ reportError: vi.fn() }));

import {
  useSetVideos,
  useUploadSetVideo,
  useDeleteSetVideo,
  useSetVideoSignedUrl,
} from './useSetVideo';
import { supabase } from '../lib/supabase';
import { reportError } from '../lib/errorReporter';
import { useAuth } from './useAuth';

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false },
    },
  });
}
function withClient(qc) {
  return ({ children }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  useAuth.mockReturnValue({ user: { id: 'u-1' } });
});

describe('useSetVideos', () => {
  it('is disabled when no slotIds', async () => {
    const qc = makeClient();
    const { result } = renderHook(() => useSetVideos('s-1', []), {
      wrapper: withClient(qc),
    });
    await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));
    expect(supabase.from).not.toHaveBeenCalled();
  });

  it('fetches videos in one join and flattens slot/set numbers onto each row', async () => {
    const videosChain = {
      select: vi.fn().mockReturnThis(),
      in: vi.fn().mockResolvedValue({
        data: [
          {
            id: 'v-1',
            set_log_id: 'l-1',
            storage_path: 'p/1.mp4',
            set_log: { exercise_slot_id: 'sl-1', set_number: 2 },
          },
        ],
        error: null,
      }),
    };
    supabase.from.mockReturnValue(videosChain);

    const qc = makeClient();
    const { result } = renderHook(() => useSetVideos('s-1', ['sl-1']), {
      wrapper: withClient(qc),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(supabase.from).toHaveBeenCalledTimes(1);
    expect(supabase.from).toHaveBeenCalledWith('set_log_videos');
    expect(videosChain.in).toHaveBeenCalledWith('set_log.exercise_slot_id', ['sl-1']);
    // The embedded row is flattened away, not left nested.
    expect(result.current.data).toEqual([
      {
        id: 'v-1',
        set_log_id: 'l-1',
        storage_path: 'p/1.mp4',
        exercise_slot_id: 'sl-1',
        set_number: 2,
      },
    ]);
  });
});

// Everything the two mutations send, in the order they send it: the reads and
// writes of `set_log_videos` and the calls to the bucket share one log, so a
// test states an order as a list.
function backend({
  existing = null,
  existError = null,
  upload = { data: { path: 'p' }, error: null },
  write = { data: { id: 'v-saved' }, error: null },
  deleted = { data: [{ id: 'v-old' }], error: null },
  remove = () => ({ data: [{ name: 'file' }], error: null }),
} = {}) {
  const log = [];
  const sent = { uploads: [], updated: null, inserted: null, deletedWhere: null };

  supabase.from.mockImplementation((table) => {
    if (table !== 'set_log_videos') throw new Error(`unexpected table ${table}`);
    return {
      select: () => ({
        eq: (column, value) => ({
          maybeSingle: async () => {
            log.push('read row');
            sent.readWhere = [column, value];
            return { data: existing, error: existError };
          },
        }),
      }),
      update: (fields) => ({
        eq: (column, value) => ({
          select: () => ({
            single: async () => {
              log.push('update row');
              sent.updated = { fields, where: [column, value] };
              return write;
            },
          }),
        }),
      }),
      insert: (fields) => ({
        select: () => ({
          single: async () => {
            log.push('insert row');
            sent.inserted = fields;
            return write;
          },
        }),
      }),
      delete: () => ({
        eq: (column, value) => ({
          select: async () => {
            log.push('delete row');
            sent.deletedWhere = [column, value];
            return deleted;
          },
        }),
      }),
    };
  });

  supabase.storage.from.mockImplementation((bucket) => {
    if (bucket !== 'set-videos') throw new Error(`unexpected bucket ${bucket}`);
    return {
      upload: async (path, body, options) => {
        log.push('upload');
        sent.uploads.push({ path, body, options });
        return typeof upload === 'function' ? upload(path) : upload;
      },
      remove: async ([path]) => {
        log.push(`remove ${path}`);
        return remove(path);
      },
    };
  });

  return { log, sent };
}

const OLD = { id: 'v-old', storage_path: 'u-1/sl-1/2-old.mp4' };

function mp4(size) {
  const file = new File(['x'], 'clip.mp4', { type: 'video/mp4' });
  if (size != null) Object.defineProperty(file, 'size', { value: size });
  return file;
}

async function runUpload(variables) {
  const qc = makeClient();
  const invalidate = vi.spyOn(qc, 'invalidateQueries');
  const { result } = renderHook(() => useUploadSetVideo(), { wrapper: withClient(qc) });
  result.current.mutate({ setLogId: 'l-1', exerciseSlotId: 'sl-1', setNumber: 2, ...variables });
  await waitFor(() => expect(result.current.isIdle || result.current.isPending).toBe(false));
  return { result, invalidate };
}

describe('useUploadSetVideo — before anything is sent', () => {
  it('rejects when not signed in', async () => {
    const { log } = backend();
    useAuth.mockReturnValue({ user: null });
    const { result } = await runUpload({ file: mp4() });
    expect(result.current.error.message).toMatch(/not signed in/i);
    expect(log).toEqual([]);
  });

  it('rejects when file is missing', async () => {
    const { log } = backend();
    const { result } = await runUpload({});
    expect(result.current.error.message).toMatch(/no file/i);
    expect(log).toEqual([]);
  });

  // The bucket takes video/mp4, video/quicktime and video/webm. Anything else
  // used to be uploaded in full and refused by the server — after the previous
  // video had been deleted.
  it.each([['video/3gpp'], ['']])('refuses the type %j without a single request', async (type) => {
    const { log } = backend({ existing: OLD });
    const { result } = await runUpload({ file: new File(['x'], 'clip', { type }) });
    expect(result.current.isError).toBe(true);
    expect(result.current.error.videoProblem).toBe('type');
    expect(log).toEqual([]);
    expect(supabase.from).not.toHaveBeenCalled();
    expect(supabase.storage.from).not.toHaveBeenCalled();
  });

  it('refuses a clip above 25 MB without a single request', async () => {
    const { log } = backend({ existing: OLD });
    const { result } = await runUpload({ file: mp4(25 * 1024 * 1024 + 1) });
    expect(result.current.error.videoProblem).toBe('size');
    expect(result.current.error.message).toMatch(/25 MB/);
    expect(log).toEqual([]);
  });

  it('refuses an empty file without a single request', async () => {
    const { log } = backend();
    const { result } = await runUpload({ file: mp4(0) });
    expect(result.current.error.videoProblem).toBe('empty');
    expect(log).toEqual([]);
  });
});

describe('useUploadSetVideo — a set without a video', () => {
  it('uploads, then inserts the row of the set', async () => {
    const { log, sent } = backend();
    const file = mp4();
    const { result, invalidate } = await runUpload({ setNumber: 1, file });

    expect(result.current.isSuccess).toBe(true);
    expect(log).toEqual(['read row', 'upload', 'insert row']);
    expect(sent.readWhere).toEqual(['set_log_id', 'l-1']);

    // <athlete>/<slot of the set>/<set>-<uuid>.<ext>: the database refuses a
    // row whose path is anywhere else.
    const { path, body, options } = sent.uploads[0];
    expect(path).toMatch(/^u-1\/sl-1\/1-[0-9a-f-]+\.mp4$/);
    expect(body).toBe(file);
    expect(options).toMatchObject({ upsert: false });

    expect(sent.inserted).toEqual({
      set_log_id: 'l-1',
      storage_path: path,
      mime_type: 'video/mp4',
      size_bytes: file.size,
    });
    expect(result.current.data).toEqual({ id: 'v-saved' });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['set-videos'] });
  });

  it('a row the database refuses takes its file back out of the bucket', async () => {
    const refusal = { code: '42501', message: 'new row violates row-level security policy' };
    const { log, sent } = backend({ write: { data: null, error: refusal } });
    const { result } = await runUpload({ file: mp4() });

    expect(result.current.error).toBe(refusal);
    expect(log).toEqual(['read row', 'upload', 'insert row', `remove ${sent.uploads[0].path}`]);
  });

  it('a failed upload writes no row', async () => {
    const { log } = backend({ upload: { data: null, error: new Error('network') } });
    const { result, invalidate } = await runUpload({ file: mp4() });

    expect(result.current.error.message).toBe('network');
    expect(log).toEqual(['read row', 'upload']);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('stores the bare type of a file whose type has parameters, and sends it under that type', async () => {
    const { sent } = backend();
    const file = new File(['abcdef'], 'clip.webm', { type: 'video/webm;codecs=vp9' });
    await runUpload({ file });

    expect(sent.uploads[0].path).toMatch(/\.webm$/);
    expect(sent.uploads[0].body.type).toBe('video/webm');
    expect(sent.uploads[0].body.size).toBe(file.size);
    expect(sent.inserted.mime_type).toBe('video/webm');
  });
});

describe('useUploadSetVideo — replacing a video', () => {
  // The order that loses nothing: the new file exists before the row leaves
  // the old one, and the old file goes last.
  it('uploads the new file, points the row at it, then removes the old file', async () => {
    const { log, sent } = backend({ existing: OLD });
    const file = new File(['x'], 'clip.webm', { type: 'video/webm' });
    const { result, invalidate } = await runUpload({ file });

    expect(result.current.isSuccess).toBe(true);
    expect(log).toEqual(['read row', 'upload', 'update row', `remove ${OLD.storage_path}`]);

    const { path } = sent.uploads[0];
    expect(path).toMatch(/^u-1\/sl-1\/2-[0-9a-f-]+\.webm$/);
    expect(path).not.toBe(OLD.storage_path);
    // The row is changed in place: `set_log_id` is UNIQUE, there is no second
    // row to insert.
    expect(sent.updated).toEqual({
      fields: { storage_path: path, mime_type: 'video/webm', size_bytes: file.size },
      where: ['id', 'v-old'],
    });
    expect(sent.inserted).toBeNull();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['set-videos'] });
  });

  // The finding (P29): the old file and its row used to be deleted first, so a
  // failed upload left the set with no video at all.
  it('a failed upload leaves the previous video: no row write, nothing removed', async () => {
    const { log } = backend({
      existing: OLD,
      upload: { data: null, error: { statusCode: '415', message: 'mime type not supported' } },
    });
    const { result } = await runUpload({ file: mp4() });

    expect(result.current.isError).toBe(true);
    expect(log).toEqual(['read row', 'upload']);
    expect(log.some((entry) => entry.startsWith('remove'))).toBe(false);
  });

  it('a row update the database refuses removes the NEW file and keeps the old one', async () => {
    const refusal = { code: '42501', message: 'new row violates row-level security policy' };
    const { log, sent } = backend({ existing: OLD, write: { data: null, error: refusal } });
    const { result, invalidate } = await runUpload({ file: mp4() });

    expect(result.current.error).toBe(refusal);
    expect(log).toEqual(['read row', 'upload', 'update row', `remove ${sent.uploads[0].path}`]);
    expect(log).not.toContain(`remove ${OLD.storage_path}`);
    expect(invalidate).not.toHaveBeenCalled();
  });

  // An update that reaches no row (the session was closed in between) comes
  // back from `.single()` as PGRST116: nothing changed.
  it('a row update that reaches no row removes the NEW file and keeps the old one', async () => {
    const noRow = { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' };
    const { log, sent } = backend({ existing: OLD, write: { data: null, error: noRow } });
    const { result } = await runUpload({ file: mp4() });

    expect(result.current.error).toBe(noRow);
    expect(log).toEqual(['read row', 'upload', 'update row', `remove ${sent.uploads[0].path}`]);
  });

  // No answer is not a refusal: the row may name the new file by now, and a
  // file a row names is never removed.
  it('a row update that got no answer removes neither file, and is reported', async () => {
    const lost = { code: '', message: 'TypeError: Failed to fetch' };
    const { log, sent } = backend({ existing: OLD, write: { data: null, error: lost } });
    const { result } = await runUpload({ file: mp4() });

    expect(result.current.error).toBe(lost);
    expect(log).toEqual(['read row', 'upload', 'update row']);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0][1]).toContain(sent.uploads[0].path);
  });

  it('an old file that cannot be removed does not fail the replace, and is reported', async () => {
    const { log } = backend({
      existing: OLD,
      remove: () => ({ data: null, error: { message: 'storage is down' } }),
    });
    const { result, invalidate } = await runUpload({ file: mp4() });

    expect(result.current.isSuccess).toBe(true);
    expect(log.at(-1)).toBe(`remove ${OLD.storage_path}`);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['set-videos'] });
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0][1]).toContain(OLD.storage_path);
    expect(reportError.mock.calls[0][1]).toContain('storage is down');
  });

  // Storage does not say "refused": a file its policy keeps out of reach comes
  // back as an empty list of removed files.
  it('an old file that storage did not remove is reported as left behind', async () => {
    backend({ existing: OLD, remove: () => ({ data: [], error: null }) });
    const { result } = await runUpload({ file: mp4() });

    expect(result.current.isSuccess).toBe(true);
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0][1]).toContain(OLD.storage_path);
  });

  it('a remove that throws does not fail the replace either', async () => {
    backend({
      existing: OLD,
      remove: () => {
        throw new Error('offline');
      },
    });
    const { result } = await runUpload({ file: mp4() });

    expect(result.current.isSuccess).toBe(true);
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it('a clean replace reports nothing', async () => {
    backend({ existing: OLD });
    await runUpload({ file: mp4() });
    expect(reportError).not.toHaveBeenCalled();
  });

  it('stops at the read of the row when that read fails', async () => {
    const { log } = backend({ existError: { code: 'PGRST301', message: 'JWT expired' } });
    const { result } = await runUpload({ file: mp4() });
    expect(result.current.isError).toBe(true);
    expect(log).toEqual(['read row']);
  });
});

describe('useDeleteSetVideo', () => {
  async function runDelete(options) {
    const { log, sent } = backend(options);
    const qc = makeClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useDeleteSetVideo(), { wrapper: withClient(qc) });
    result.current.mutate({ videoId: 'v-old', storagePath: OLD.storage_path });
    await waitFor(() => expect(result.current.isIdle || result.current.isPending).toBe(false));
    return { result, invalidate, log, sent };
  }

  it('deletes the row, then removes its file', async () => {
    const { result, invalidate, log, sent } = await runDelete();

    expect(result.current.isSuccess).toBe(true);
    expect(log).toEqual(['delete row', `remove ${OLD.storage_path}`]);
    expect(sent.deletedWhere).toEqual(['id', 'v-old']);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['set-videos'] });
  });

  // The other half of P29: the file used to go first, so a row delete that
  // failed left a row pointing at nothing.
  it('a row delete that fails leaves the file where it is', async () => {
    const failure = { code: '', message: 'TypeError: Failed to fetch' };
    const { result, log } = await runDelete({ deleted: { data: null, error: failure } });

    expect(result.current.error).toBe(failure);
    expect(log).toEqual(['delete row']);
  });

  // The database answers an athlete's delete on a reviewed or archived
  // session by reaching no row, without an error.
  it('a row delete that reaches no row leaves the file where it is', async () => {
    const { result, invalidate, log } = await runDelete({ deleted: { data: [], error: null } });

    expect(result.current.isSuccess).toBe(true);
    expect(result.current.data).toEqual({ deleted: false });
    expect(log).toEqual(['delete row']);
    // The list is read again: it shows the video that is still there.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['set-videos'] });
  });

  it('a file that cannot be removed does not fail the delete, and is reported', async () => {
    const { result } = await runDelete({
      remove: () => ({ data: null, error: { message: 'storage is down' } }),
    });

    expect(result.current.isSuccess).toBe(true);
    expect(result.current.data).toEqual({ deleted: true });
    expect(reportError).toHaveBeenCalledTimes(1);
    expect(reportError.mock.calls[0][1]).toContain(OLD.storage_path);
  });
});

describe('useSetVideoSignedUrl', () => {
  it('is disabled when storagePath is falsy', async () => {
    const qc = makeClient();
    const { result } = renderHook(() => useSetVideoSignedUrl(null), {
      wrapper: withClient(qc),
    });
    await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));
  });

  it('calls createSignedUrl with the bucket and a TTL', async () => {
    const bucket = {
      createSignedUrl: vi.fn().mockResolvedValue({
        data: { signedUrl: 'https://x/signed' },
        error: null,
      }),
    };
    supabase.storage.from.mockReturnValue(bucket);

    const qc = makeClient();
    const { result } = renderHook(() => useSetVideoSignedUrl('p/1.mp4'), {
      wrapper: withClient(qc),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(bucket.createSignedUrl).toHaveBeenCalledWith('p/1.mp4', 60 * 60);
    expect(result.current.data).toBe('https://x/signed');
  });
});
