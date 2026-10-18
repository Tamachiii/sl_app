import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockUpload = { mutate: vi.fn(), isPending: false };
const mockDelete = { mutate: vi.fn(), isPending: false };

vi.mock('../../hooks/useSetVideo', () => ({
  useUploadSetVideo: () => mockUpload,
  useDeleteSetVideo: () => mockDelete,
  // A signed address for every file, so that the player draws its <video>.
  useSetVideoSignedUrl: (path) => ({ data: `https://signed.example/${path}`, isLoading: false }),
}));

import VideoUploadButton from './VideoUploadButton';
import { Sheet } from '../parc';
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

const VIDEO = { id: 'v-1', storage_path: 'p/1.mp4' };

// A File of any size and type, without allocating it.
function clip(type = 'video/mp4', size) {
  const file = new File(['x'], 'clip', { type });
  if (size != null) Object.defineProperty(file, 'size', { value: size });
  return file;
}

function pick(container, file) {
  fireEvent.change(container.querySelector('input[type="file"]'), { target: { files: [file] } });
}

const sendButton = () => screen.getByRole('button', { name: 'Send a video' });
const cancelButton = () => screen.getByRole('button', { name: 'Cancel upload' });
// The lightbox is the one dialog drawn by a <div>: a sheet is a <dialog>.
const lightbox = () => document.querySelector('div[role="dialog"]');

describe('<VideoUploadButton />', () => {
  it('offers "Send a video" when the set has none', () => {
    render(
      <VideoUploadButton setLogId="l-1" exerciseSlotId="sl-1" setNumber={1} />,
    );
    expect(sendButton()).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Watch the video' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete the video' })).not.toBeInTheDocument();
  });

  it('offers to watch, replace and delete the video a set has', () => {
    render(
      <VideoUploadButton setLogId="l-1" exerciseSlotId="sl-1" setNumber={1} existingVideo={VIDEO} />,
    );
    expect(screen.getByRole('button', { name: 'Watch the video' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Replace the video' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Delete the video' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Send a video' })).not.toBeInTheDocument();
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

  // A deleted video is gone for the coach too, and nothing brings it back:
  // the button asks first, in a sheet, instead of the browser's `confirm()`.
  describe('deleting the video asks first', () => {
    const askDelete = () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete the video' }));
      return screen.getByRole('dialog', { name: 'Delete this video?' });
    };

    it('the button opens the question, which says the coach will no longer see it, and deletes nothing', () => {
      render(
        <VideoUploadButton setLogId="l-1" exerciseSlotId="sl-1" setNumber={1} existingVideo={VIDEO} />,
      );
      const sheet = askDelete();
      expect(sheet).toHaveTextContent('Your coach will no longer see it.');
      expect(mockDelete.mutate).not.toHaveBeenCalled();
    });

    it('"Keep the video" deletes nothing and closes it', () => {
      render(
        <VideoUploadButton setLogId="l-1" exerciseSlotId="sl-1" setNumber={1} existingVideo={VIDEO} />,
      );
      const sheet = askDelete();
      fireEvent.click(within(sheet).getByRole('button', { name: 'Keep the video' }));
      expect(mockDelete.mutate).not.toHaveBeenCalled();
      expect(screen.queryByRole('dialog', { name: 'Delete this video?' })).not.toBeInTheDocument();
    });

    it('the answer deletes the video by its row and its file, and closes it', () => {
      render(
        <VideoUploadButton
          setLogId="l-1"
          exerciseSlotId="sl-1"
          setNumber={1}
          existingVideo={{ id: 'v-9', storage_path: 'p/9.mp4' }}
        />,
      );
      const sheet = askDelete();
      fireEvent.click(within(sheet).getByRole('button', { name: 'Delete the video' }));
      expect(mockDelete.mutate).toHaveBeenCalledTimes(1);
      expect(mockDelete.mutate).toHaveBeenCalledWith({
        videoId: 'v-9',
        storagePath: 'p/9.mp4',
      });
      expect(screen.queryByRole('dialog', { name: 'Delete this video?' })).not.toBeInTheDocument();
    });

    it('while the delete is sent, the button says so and nothing else can be started', () => {
      mockDelete.isPending = true;
      render(
        <VideoUploadButton setLogId="l-1" exerciseSlotId="sl-1" setNumber={1} existingVideo={VIDEO} />,
      );
      expect(screen.getByRole('button', { name: 'Deleting the video…' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Watch the video' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Replace the video' })).toBeDisabled();
    });
  });

  it('disables the upload and says why when the device is offline', () => {
    setOnline(false);
    const { container } = render(
      <VideoUploadButton setLogId="l-1" exerciseSlotId="sl-1" setNumber={1} />,
    );
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    // A click should be a no-op while offline, and the line under the button
    // says what it waits for.
    expect(sendButton()).toBeDisabled();
    expect(screen.getByText('Connect to record video')).toBeInTheDocument();
    const fileInput = container.querySelector('input[type="file"]');
    expect(fileInput).toBeDisabled();
  });

  // A video already sent is watched from the cache of signed addresses, with
  // or without a network.
  it('offline: the video a set has can still be watched', () => {
    setOnline(false);
    render(
      <VideoUploadButton setLogId="l-1" exerciseSlotId="sl-1" setNumber={1} existingVideo={VIDEO} />,
    );
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    expect(screen.getByRole('button', { name: 'Watch the video' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Replace the video' })).toBeDisabled();
  });

  // `disabled` is how a locked set reaches this button (the set's sheet
  // passes its `locked`). The video of a locked set can be watched, not
  // replaced or deleted — a session the coach has reviewed keeps the video
  // the coach saw.
  it('disabled: the video can still be watched, but neither replaced nor deleted', () => {
    render(
      <VideoUploadButton setLogId="l-1" exerciseSlotId="sl-1" setNumber={1} existingVideo={VIDEO} disabled />,
    );
    expect(screen.getByRole('button', { name: 'Watch the video' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Replace the video' })).toBeDisabled();
    const del = screen.getByRole('button', { name: 'Delete the video' });
    expect(del).toBeDisabled();
    fireEvent.click(del);
    expect(screen.queryByRole('dialog', { name: 'Delete this video?' })).not.toBeInTheDocument();
    expect(mockDelete.mutate).not.toHaveBeenCalled();
    // A locked set is not waiting for a network: no line says it is.
    expect(screen.queryByText('Connect to record video')).not.toBeInTheDocument();
  });
});

describe('<VideoUploadButton /> — watching the video', () => {
  it('opens the player over the page, and its close button closes it', () => {
    render(
      <VideoUploadButton setLogId="l-1" exerciseSlotId="sl-1" setNumber={1} existingVideo={VIDEO} />,
    );
    expect(lightbox()).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Watch the video' }));

    expect(lightbox()).not.toBeNull();
    expect(lightbox().parentElement).toBe(document.body);
    expect(lightbox().querySelector('video')).toHaveAttribute('src', 'https://signed.example/p/1.mp4');

    fireEvent.click(within(lightbox()).getByRole('button', { name: 'Close' }));
    expect(lightbox()).toBeNull();
  });

  // The button lives in the set's sheet, a modal <dialog>: the page behind it
  // is inert and under it. A player drawn on the <body> would be both — seen
  // behind the sheet, and deaf to the taps meant for it.
  it('opened from a sheet, the player is drawn inside that sheet', () => {
    render(
      <Sheet open onClose={() => {}} title="Set 2, done">
        <VideoUploadButton setLogId="l-1" exerciseSlotId="sl-1" setNumber={2} existingVideo={VIDEO} />
      </Sheet>,
    );
    const sheet = screen.getByRole('dialog', { name: 'Set 2, done' });

    fireEvent.click(within(sheet).getByRole('button', { name: 'Watch the video' }));

    expect(lightbox()).not.toBeNull();
    expect(sheet).toContainElement(lightbox());
    expect(within(lightbox()).getByRole('button', { name: 'Close' })).toBeInTheDocument();
    expect(lightbox().querySelector('video')).toHaveAttribute('src', 'https://signed.example/p/1.mp4');

    // Closing the player leaves the sheet open, on the set.
    fireEvent.click(within(lightbox()).getByRole('button', { name: 'Close' }));
    expect(lightbox()).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Set 2, done' })).toBeInTheDocument();
  });

  // Escape closes the layer on top, and that one only: the player, not the
  // sheet under it as well — the athlete who closes the video is still on
  // the set, about to replace or delete it.
  it('opened from a sheet, Escape closes the player and leaves the sheet open', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Sheet open onClose={onClose} title="Set 2, done">
        <VideoUploadButton setLogId="l-1" exerciseSlotId="sl-1" setNumber={2} existingVideo={VIDEO} />
      </Sheet>,
    );
    await user.click(screen.getByRole('button', { name: 'Watch the video' }));
    expect(lightbox()).not.toBeNull();

    await user.keyboard('{Escape}');

    expect(lightbox()).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Set 2, done' })).toBeInTheDocument();
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
      <VideoUploadButton setLogId="l-1" exerciseSlotId="sl-1" setNumber={1} existingVideo={VIDEO} />,
    );
    pick(container, clip('video/3gpp'));
    expect(mockUpload.mutate).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Watch the video' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Replace the video' })).toBeEnabled();
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
    expect(sendButton()).toBeEnabled();
  });

  it('offers Cancel in place of Send, and Cancel stops the upload of this set', () => {
    const running = beginVideoUpload('l-1');
    const other = beginVideoUpload('l-2');
    render(<VideoUploadButton setLogId="l-1" exerciseSlotId="sl-1" setNumber={1} />);

    expect(screen.queryByRole('button', { name: 'Send a video' })).not.toBeInTheDocument();
    const cancel = cancelButton();
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
    fireEvent.click(cancelButton());
    act(() => running.end());

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(sendButton()).toBeEnabled();
    expect(getVideoUpload('l-1')).toBeNull();
  });

  // The set's sheet renders its content only while it is open: closing it
  // unmounts this button while the upload goes on. The button of the sheet
  // opened again must show it and be able to stop it, not offer a second
  // upload beside it.
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

    fireEvent.click(cancelButton());
    expect(running.signal.aborted).toBe(true);
  });

  it('the upload of another set shows nothing here', () => {
    beginVideoUpload('l-2');
    render(<VideoUploadButton setLogId="l-1" exerciseSlotId="sl-1" setNumber={1} />);
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(sendButton()).toBeEnabled();
  });

  it('a pending mutation shows the progress before its first byte', () => {
    mockUpload.isPending = true;
    render(<VideoUploadButton setLogId="l-1" exerciseSlotId="sl-1" setNumber={1} />);
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
    expect(cancelButton()).toBeEnabled();
  });

  it('while replacing: the previous video cannot be deleted, and Cancel takes the place of Replace', () => {
    beginVideoUpload('l-1');
    render(
      <VideoUploadButton setLogId="l-1" exerciseSlotId="sl-1" setNumber={1} existingVideo={VIDEO} />,
    );
    expect(screen.queryByRole('button', { name: 'Replace the video' })).not.toBeInTheDocument();
    expect(cancelButton()).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Delete the video' })).toBeDisabled();
  });

  // Stopping needs neither a connection nor a writable session.
  it('Cancel stays enabled offline and on a set that was locked in the meantime', () => {
    const running = beginVideoUpload('l-1');
    setOnline(false);
    render(<VideoUploadButton setLogId="l-1" exerciseSlotId="sl-1" setNumber={1} disabled />);
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    const cancel = cancelButton();
    expect(cancel).toBeEnabled();
    fireEvent.click(cancel);
    expect(running.signal.aborted).toBe(true);
  });

  // The button that opened the file picker is the one that becomes Cancel:
  // the focus the picker gave back is still on it.
  it('keeps the focus on the button when the upload starts', () => {
    render(<VideoUploadButton setLogId="l-1" exerciseSlotId="sl-1" setNumber={1} />);
    const send = sendButton();
    send.focus();
    act(() => {
      beginVideoUpload('l-1');
    });
    const cancel = cancelButton();
    expect(cancel).toBe(send);
    expect(document.activeElement).toBe(cancel);
  });

  // The progress and the refusal are lines of their own under the buttons:
  // among them, on a phone, they would push a button onto a line of its own.
  it('the progress line and the refusal sit under the buttons, not between them', () => {
    beginVideoUpload('l-1');
    const first = render(<VideoUploadButton setLogId="l-1" exerciseSlotId="sl-1" setNumber={1} />);
    const bar = screen.getByRole('progressbar');
    const buttons = cancelButton().parentElement;
    expect(buttons).not.toContainElement(bar);
    expect(buttons.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    first.unmount();

    const { container } = render(
      <VideoUploadButton setLogId="l-9" exerciseSlotId="sl-1" setNumber={1} />,
    );
    pick(container, clip('video/3gpp'));
    const alert = screen.getByRole('alert');
    const row = sendButton().parentElement;
    expect(row).not.toContainElement(alert);
    expect(row.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // jsdom lays nothing out: the 44 px are the class of a Parc button, whose
  // min-height and min-width are the target size.
  it('the tap target stays 44px while it is the cancel button', () => {
    beginVideoUpload('l-1');
    render(<VideoUploadButton setLogId="l-1" exerciseSlotId="sl-1" setNumber={1} />);
    expect(cancelButton()).toHaveClass('pk-btn');
  });
});
