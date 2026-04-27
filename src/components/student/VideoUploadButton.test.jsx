import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const mockUpload = { mutate: vi.fn(), isPending: false };
const mockDelete = { mutate: vi.fn(), isPending: false };

vi.mock('../../hooks/useSetVideo', () => ({
  useUploadSetVideo: () => mockUpload,
  useDeleteSetVideo: () => mockDelete,
  useSetVideoSignedUrl: () => ({ data: null, isLoading: false }),
}));

import VideoUploadButton from './VideoUploadButton';

beforeEach(() => {
  mockUpload.mutate.mockReset();
  mockDelete.mutate.mockReset();
});

describe('<VideoUploadButton />', () => {
  it('renders an "Upload video" CTA when no existing video', () => {
    render(
      <VideoUploadButton setLogId="l-1" exerciseSlotId="sl-1" setNumber={1} />,
    );
    expect(screen.getByText(/Upload video/i)).toBeInTheDocument();
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
    expect(screen.getByText('PLAY')).toBeInTheDocument();
    expect(screen.getByText('Replace')).toBeInTheDocument();
    expect(screen.getByText('Delete')).toBeInTheDocument();
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
    fireEvent.click(screen.getByText('Delete'));
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
    fireEvent.click(screen.getByText('Delete'));
    expect(mockDelete.mutate).toHaveBeenCalledWith({
      videoId: 'v-9',
      storagePath: 'p/9.mp4',
    });
    confirmSpy.mockRestore();
  });
});
