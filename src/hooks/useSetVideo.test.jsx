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

import {
  useSetVideos,
  useUploadSetVideo,
  useDeleteSetVideo,
  useSetVideoSignedUrl,
} from './useSetVideo';
import { supabase } from '../lib/supabase';
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

  it('joins set_logs to set_log_videos and decorates with slot/set numbers', async () => {
    const logsChain = {
      select: vi.fn().mockReturnThis(),
      in: vi.fn().mockResolvedValue({
        data: [
          { id: 'l-1', exercise_slot_id: 'sl-1', set_number: 2 },
        ],
        error: null,
      }),
    };
    const videosChain = {
      select: vi.fn().mockReturnThis(),
      in: vi.fn().mockResolvedValue({
        data: [
          { id: 'v-1', set_log_id: 'l-1', storage_path: 'p/1.mp4' },
        ],
        error: null,
      }),
    };
    let call = 0;
    supabase.from.mockImplementation(() => (call++ === 0 ? logsChain : videosChain));

    const qc = makeClient();
    const { result } = renderHook(() => useSetVideos('s-1', ['sl-1']), {
      wrapper: withClient(qc),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
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

describe('useUploadSetVideo', () => {
  function makeStorageBucket() {
    return {
      upload: vi.fn().mockResolvedValue({ error: null }),
      remove: vi.fn().mockResolvedValue({ error: null }),
      createSignedUrl: vi.fn(),
    };
  }

  it('rejects when not signed in', async () => {
    useAuth.mockReturnValue({ user: null });
    const qc = makeClient();
    const { result } = renderHook(() => useUploadSetVideo(), {
      wrapper: withClient(qc),
    });
    result.current.mutate({
      setLogId: 'l-1',
      exerciseSlotId: 'sl-1',
      setNumber: 1,
      file: new File(['x'], 'clip.mp4', { type: 'video/mp4' }),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error.message).toMatch(/not signed in/i);
  });

  it('rejects when file is missing', async () => {
    const qc = makeClient();
    const { result } = renderHook(() => useUploadSetVideo(), {
      wrapper: withClient(qc),
    });
    result.current.mutate({ setLogId: 'l-1', exerciseSlotId: 'sl-1', setNumber: 1 });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error.message).toMatch(/no file/i);
  });

  it('rejects clips above 25 MB with a friendly message', async () => {
    const qc = makeClient();
    const { result } = renderHook(() => useUploadSetVideo(), {
      wrapper: withClient(qc),
    });
    const big = new File([new Uint8Array(26 * 1024 * 1024)], 'big.mp4', {
      type: 'video/mp4',
    });
    result.current.mutate({
      setLogId: 'l-1',
      exerciseSlotId: 'sl-1',
      setNumber: 1,
      file: big,
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error.message).toMatch(/25 MB/);
  });

  it('uploads and inserts a set_log_videos row when no existing video', async () => {
    const existCheck = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    };
    const insertRow = {
      insert: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi
        .fn()
        .mockResolvedValue({ data: { id: 'v-new' }, error: null }),
    };
    let call = 0;
    supabase.from.mockImplementation(() => (call++ === 0 ? existCheck : insertRow));

    const bucket = makeStorageBucket();
    supabase.storage.from.mockReturnValue(bucket);

    const qc = makeClient();
    const { result } = renderHook(() => useUploadSetVideo(), {
      wrapper: withClient(qc),
    });
    const file = new File(['x'], 'clip.mp4', { type: 'video/mp4' });
    result.current.mutate({
      setLogId: 'l-1',
      exerciseSlotId: 'sl-1',
      setNumber: 1,
      file,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(bucket.upload).toHaveBeenCalled();
    const path = bucket.upload.mock.calls[0][0];
    expect(path.startsWith('u-1/sl-1/1-')).toBe(true);
    expect(path.endsWith('.mp4')).toBe(true);
  });

  it('replaces an existing video by removing storage and deleting the old row first', async () => {
    const existCheck = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({
        data: { id: 'v-old', storage_path: 'old/path.mp4' },
        error: null,
      }),
    };
    const deleteOld = {
      delete: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ error: null }),
    };
    const insertNew = {
      insert: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: { id: 'v-new' }, error: null }),
    };
    const seq = [existCheck, deleteOld, insertNew];
    let i = 0;
    supabase.from.mockImplementation(() => seq[i++]);

    const bucket = makeStorageBucket();
    supabase.storage.from.mockReturnValue(bucket);

    const qc = makeClient();
    const { result } = renderHook(() => useUploadSetVideo(), {
      wrapper: withClient(qc),
    });
    const file = new File(['x'], 'clip.webm', { type: 'video/webm' });
    result.current.mutate({
      setLogId: 'l-1',
      exerciseSlotId: 'sl-1',
      setNumber: 2,
      file,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(bucket.remove).toHaveBeenCalledWith(['old/path.mp4']);
    expect(deleteOld.eq).toHaveBeenCalledWith('id', 'v-old');
    const newPath = bucket.upload.mock.calls[0][0];
    expect(newPath.endsWith('.webm')).toBe(true);
  });
});

describe('useDeleteSetVideo', () => {
  it('removes from storage then deletes the row', async () => {
    const bucket = {
      remove: vi.fn().mockResolvedValue({ error: null }),
      upload: vi.fn(),
    };
    supabase.storage.from.mockReturnValue(bucket);
    const chain = {
      delete: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ error: null }),
    };
    supabase.from.mockReturnValue(chain);

    const qc = makeClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useDeleteSetVideo(), {
      wrapper: withClient(qc),
    });
    result.current.mutate({ videoId: 'v-1', storagePath: 'p/1.mp4' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(bucket.remove).toHaveBeenCalledWith(['p/1.mp4']);
    expect(chain.eq).toHaveBeenCalledWith('id', 'v-1');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['set-videos'] });
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
