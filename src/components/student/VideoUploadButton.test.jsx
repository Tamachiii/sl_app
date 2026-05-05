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
  setOnline(true);
});

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
