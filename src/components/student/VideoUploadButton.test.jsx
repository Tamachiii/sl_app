import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

const mockUpload = { mutate: vi.fn(), isPending: false };
const mockDelete = { mutate: vi.fn(), isPending: false };

vi.mock('../../hooks/useSetVideo', () => ({
  useUploadSetVideo: () => mockUpload,
  useDeleteSetVideo: () => mockDelete,
  useSetVideoSignedUrl: () => ({ data: null, isLoading: false }),
}));

import VideoUploadButton from './VideoUploadButton';
import {
  beginVideoUpload,
  getVideoUpload,
  resetVideoUploads,
} from '../../lib/setVideoUploads';

const onlineDescriptor = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(navigator),
  'onLine'
);

function setOnline(value) {
  Object.defineProperty(navigator, 'onLine', {
    configurable: true,
    get: () => value,
  });
}

afterEach(() => {
  if (onlineDescriptor) {
    Object.defineProperty(Object.getPrototypeOf(navigator), 'onLine', onlineDescriptor);
  }
});

beforeEach(() => {
  mockUpload.mutate.mockReset();
  mockDelete.mutate.mockReset();
  mockUpload.isPending = false;
  mockDelete.isPending = false;
  resetVideoUploads();
  setOnline(true);
});

// A File of any size and type, without allocating it.
function clip(type = 'video/mp4', size) {
  const file = new File(['x'], 'clip', { type });
  if (size != null) Object.defineProperty(file, 'size', { value: size });
  return file;
}

function pick(container, file) {
  fireEvent.change(container.querySelector('input[type="file"]'), { target: { files: [file] } });
}

describe('<VideoUploadButton />', () => {
  it('renders an "Upload video" CTA when no existing video', () => {
    render(
      <VideoUploadButton setLogId="l-1" exerciseSlotId="sl-1" setNumber={1} />,
    );
    expect(screen.getByRole('button', { name: /Upload video/i })).toBeInTheDocument();
  });

  it('renders Play / Replace / Delete buttons when an existing video is provided', () => {
    render(
      <VideoUploadButton
        setLogId="l-1"
        exerciseSlotId="sl-1"
        setNumber={1}
        existingVideo={{ id: 'v-1', storage_path: 'p/1.mp4' }}
      />,
    );
    expect(screen.getByRole('button', { name: /play video/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /replace video/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /delete video/i })).toBeInTheDocument();
  });

  it('selecting a file calls useUploadSetVideo with the slot+set metadata', () => {
    const { container } = render(
      <VideoUploadButton setLogId="l-1" exerciseSlotId="sl-1" setNumber={3} />,
    );
    const fileInput = container.querySelector('input[type="file"]');
    const file = new File(['x'], 'clip.mp4', { type: 'video/mp4' });
    fireEvent.change(fileInput, { target: { files: [file] } });
    expect(mockUpload.mutate).toHaveBeenCalledTimes(1);
    const [args] = mockUpload.mutate.mock.calls[0];
    expect(args).toMatchObject({
      setLogId: 'l-1',
      exerciseSlotId: 'sl-1',
      setNumber: 3,
    });
    expect(args.file).toBe(file);
  });

  // B30: a failed upload used to be told twice, by the query client's toast
  // and by an `onError` of this button that printed the raw message under the
  // set. The hook tells it now, once; the button passes nothing to hear it.
  it('leaves the telling of a failed upload to the hook: no callback of its own, no message', () => {
    const { container } = render(
      <VideoUploadButton setLogId="l-1" exerciseSlotId="sl-1" setNumber={3} />,
    );
    pick(container, clip());
    expect(mockUpload.mutate).toHaveBeenCalledTimes(1);
    expect(mockUpload.mutate.mock.calls[0]).toHaveLength(1);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('cancels delete when window.confirm returns false', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(
      <VideoUploadButton
        setLogId="l-1"
        exerciseSlotId="sl-1"
        setNumber={1}
        existingVideo={{ id: 'v-1', storage_path: 'p/1.mp4' }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /delete video/i }));
    expect(mockDelete.mutate).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('disables the upload CTA and surfaces an offline hint when the device is offline', () => {
    setOnline(false);
    const { container } = render(
      <VideoUploadButton setLogId="l-1" exerciseSlotId="sl-1" setNumber={1} />,
    );
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    // The CTA flips its accessible name to the offline-hint message and goes
    // disabled — a click should be a no-op while offline.
    const cta = screen.getByRole('button', { name: /Connect to record video/i });
    expect(cta).toBeDisabled();
    const fileInput = container.querySelector('input[type="file"]');
    expect(fileInput).toBeDisabled();
  });

  // `disabled` is how a locked set reaches this button (SetRow passes its
  // `locked`). The video of a locked set can be watched, not replaced or
  // deleted — a session the coach has reviewed keeps the video the coach saw.
  it('disabled: the video can still be played, but neither replaced nor deleted', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(
      <VideoUploadButton
        setLogId="l-1"
        exerciseSlotId="sl-1"
        setNumber={1}
        existingVideo={{ id: 'v-1', storage_path: 'p/1.mp4' }}
        disabled
      />,
    );
    expect(screen.getByRole('button', { name: /play video/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /replace video/i })).toBeDisabled();
    const del = screen.getByRole('button', { name: /delete video/i });
    expect(del).toBeDisabled();
    fireEvent.click(del);
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(mockDelete.mutate).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('calls useDeleteSetVideo when window.confirm returns true', () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(
      <VideoUploadButton
        setLogId="l-1"
        exerciseSlotId="sl-1"
        setNumber={1}
        existingVideo={{ id: 'v-9', storage_path: 'p/9.mp4' }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /delete video/i }));
    expect(mockDelete.mutate).toHaveBeenCalledWith({
      videoId: 'v-9',
      storagePath: 'p/9.mp4',
    });
    confirmSpy.mockRestore();
  });
});

describe('<VideoUploadButton /> — a file that cannot be sent', () => {
  // The bucket takes MP4, MOV and WebM. Anything else is refused on the
  // spot, before a single byte leaves.
  it.each([['video/3gpp'], ['image/jpeg'], ['']])(
    'refuses the type %j: no upload, and the reason under the set',
    (type) => {
      const { container } = render(
        <VideoUploadButton setLogId="l-1" exerciseSlotId="sl-1" setNumber={1} />,
      );
      pick(container, clip(type));
      expect(mockUpload.mutate).not.toHaveBeenCalled();
      expect(screen.getByRole('alert')).toHaveTextContent(/MP4, MOV or WebM/);
    },
  );

  it('refuses a clip above 25 MB with its size and the limit', () => {
    const { container } = render(
      <VideoUploadButton setLogId="l-1" exerciseSlotId="sl-1" setNumber={1} />,
    );
    pick(container, clip('video/mp4', 31.2 * 1024 * 1024));
    expect(mockUpload.mutate).not.toHaveBeenCalled();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('31.2 MB');
    expect(alert).toHaveTextContent('25 MB');
  });

  it('refuses an empty file', () => {
    const { container } = render(
      <VideoUploadButton setLogId="l-1" exerciseSlotId="sl-1" setNumber={1} />,
    );
    pick(container, clip('video/mp4', 0));
    expect(mockUpload.mutate).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/empty/i);
  });

  it('keeps the previous video and its buttons when the replacement is refused', () => {
    const { container } = render(
      <VideoUploadButton
        setLogId="l-1"
        exerciseSlotId="sl-1"
        setNumber={1}
        existingVideo={{ id: 'v-1', storage_path: 'p/1.mp4' }}
      />,
    );
    pick(container, clip('video/3gpp'));
    expect(mockUpload.mutate).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /play video/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /replace video/i })).toBeEnabled();
  });

  it('the reason goes away when a file that can be sent is picked', () => {
    const { container } = render(
      <VideoUploadButton setLogId="l-1" exerciseSlotId="sl-1" setNumber={1} />,
    );
    pick(container, clip('video/3gpp'));
    expect(screen.getByRole('alert')).toBeInTheDocument();
    pick(container, clip('video/quicktime'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(mockUpload.mutate).toHaveBeenCalledTimes(1);
  });
});

describe('<VideoUploadButton /> — while a clip is on its way', () => {
  it('shows how far the upload is, and follows it', () => {
    const running = beginVideoUpload('l-1');
    render(<VideoUploadButton setLogId="l-1" exerciseSlotId="sl-1" setNumber={1} />);

    const bar = screen.getByRole('progressbar', { name: /video upload/i });
    expect(bar).toHaveAttribute('aria-valuenow', '0');

    act(() => running.progress(0.42));
    expect(bar).toHaveAttribute('aria-valuenow', '42');
    expect(bar).toHaveTextContent('42%');

    act(() => running.end());
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /upload video/i })).toBeEnabled();
  });

  it('offers Cancel in place of Upload, and Cancel stops the upload of this set', () => {
    const running = beginVideoUpload('l-1');
    const other = beginVideoUpload('l-2');
    render(<VideoUploadButton setLogId="l-1" exerciseSlotId="sl-1" setNumber={1} />);

    expect(screen.queryByRole('button', { name: /upload video/i })).not.toBeInTheDocument();
    const cancel = screen.getByRole('button', { name: /cancel upload/i });
    expect(cancel).toBeEnabled();

    fireEvent.click(cancel);

    expect(running.signal.aborted).toBe(true);
    expect(other.signal.aborted).toBe(false);
    // Asked once: the button waits for the upload to unwind.
    expect(cancel).toBeDisabled();
    expect(screen.getByRole('progressbar')).toHaveTextContent(/cancelling/i);
  });

  // A cancelled upload is what the athlete asked for: nothing is shown for it.
  it('a cancelled upload leaves no message behind', () => {
    const running = beginVideoUpload('l-1');
    render(<VideoUploadButton setLogId="l-1" exerciseSlotId="sl-1" setNumber={1} />);
    fireEvent.click(screen.getByRole('button', { name: /cancel upload/i }));
    act(() => running.end());

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /upload video/i })).toBeEnabled();
    expect(getVideoUpload('l-1')).toBeNull();
  });

  // The card of an exercise unmounts its rows when it closes, and ticking the
  // last set closes it. The upload goes on; the button that comes back must
  // show it and be able to stop it, not offer a second upload beside it.
  it('a button that is mounted again finds the upload that was started before', () => {
    const first = render(<VideoUploadButton setLogId="l-1" exerciseSlotId="sl-1" setNumber={1} />);
    const running = beginVideoUpload('l-1');
    act(() => running.progress(0.3));
    first.unmount();
    act(() => running.progress(0.6));

    const { container } = render(
      <VideoUploadButton setLogId="l-1" exerciseSlotId="sl-1" setNumber={1} />,
    );
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '60');
    expect(container.querySelector('input[type="file"]')).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /cancel upload/i }));
    expect(running.signal.aborted).toBe(true);
  });

  it('the upload of another set shows nothing here', () => {
    beginVideoUpload('l-2');
    render(<VideoUploadButton setLogId="l-1" exerciseSlotId="sl-1" setNumber={1} />);
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /upload video/i })).toBeEnabled();
  });

  it('a pending mutation shows the progress before its first byte', () => {
    mockUpload.isPending = true;
    render(<VideoUploadButton setLogId="l-1" exerciseSlotId="sl-1" setNumber={1} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
    expect(screen.getByRole('button', { name: /cancel upload/i })).toBeEnabled();
  });

  it('while replacing: the previous video cannot be deleted, and Cancel takes the place of Replace', () => {
    beginVideoUpload('l-1');
    render(
      <VideoUploadButton
        setLogId="l-1"
        exerciseSlotId="sl-1"
        setNumber={1}
        existingVideo={{ id: 'v-1', storage_path: 'p/1.mp4' }}
      />,
    );
    expect(screen.queryByRole('button', { name: /replace video/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /cancel upload/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /delete video/i })).toBeDisabled();
  });

  // Stopping needs neither a connection nor a writable session.
  it('Cancel stays enabled offline and on a set that was locked in the meantime', () => {
    const running = beginVideoUpload('l-1');
    setOnline(false);
    render(<VideoUploadButton setLogId="l-1" exerciseSlotId="sl-1" setNumber={1} disabled />);
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    const cancel = screen.getByRole('button', { name: /cancel upload/i });
    expect(cancel).toBeEnabled();
    fireEvent.click(cancel);
    expect(running.signal.aborted).toBe(true);
  });

  // The button that opened the file picker is the one that becomes Cancel:
  // the focus the picker gave back is still on it.
  it('keeps the focus on the button when the upload starts', () => {
    render(<VideoUploadButton setLogId="l-1" exerciseSlotId="sl-1" setNumber={1} />);
    const uploadButton = screen.getByRole('button', { name: /upload video/i });
    uploadButton.focus();
    act(() => {
      beginVideoUpload('l-1');
    });
    const cancel = screen.getByRole('button', { name: /cancel upload/i });
    expect(cancel).toBe(uploadButton);
    expect(document.activeElement).toBe(cancel);
  });

  // This component renders INTO the set row's wrapping flex container, ahead
  // of the Actual and RPE pills. A full-width line in that place pushes the
  // pills under it; `order-last` puts the line under the whole row. jsdom
  // lays nothing out, so the class is what can be held.
  it('the progress line and the refusal sit under the whole row, not between its buttons', () => {
    beginVideoUpload('l-1');
    const first = render(<VideoUploadButton setLogId="l-1" exerciseSlotId="sl-1" setNumber={1} />);
    const bar = screen.getByRole('progressbar');
    expect(bar.className).toMatch(/\border-last\b/);
    expect(bar.className).toMatch(/\bbasis-full\b/);
    first.unmount();

    const { container } = render(
      <VideoUploadButton setLogId="l-9" exerciseSlotId="sl-1" setNumber={1} />,
    );
    pick(container, clip('video/3gpp'));
    const alert = screen.getByRole('alert');
    expect(alert.className).toMatch(/\border-last\b/);
    expect(alert.className).toMatch(/\bbasis-full\b/);
  });

  it('the tap target stays 44px while it is the cancel button', () => {
    beginVideoUpload('l-1');
    render(<VideoUploadButton setLogId="l-1" exerciseSlotId="sl-1" setNumber={1} />);
    const cancel = screen.getByRole('button', { name: /cancel upload/i });
    expect(cancel.className).toMatch(/\bw-11\b/);
    expect(cancel.className).toMatch(/\bh-11\b/);
  });
});
