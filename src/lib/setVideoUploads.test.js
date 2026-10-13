import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  beginVideoUpload,
  cancelVideoUpload,
  getVideoUpload,
  subscribeVideoUploads,
  resetVideoUploads,
} from './setVideoUploads';

beforeEach(() => {
  resetVideoUploads();
});

describe('the uploads in flight', () => {
  it('has nothing for a set that is not uploading', () => {
    expect(getVideoUpload('l-1')).toBeNull();
  });

  it('begin registers the set at 0 %, end removes it', () => {
    const upload = beginVideoUpload('l-1');
    expect(getVideoUpload('l-1')).toMatchObject({ percent: 0, cancelled: false });
    upload.end();
    expect(getVideoUpload('l-1')).toBeNull();
  });

  it('refuses a second upload of the same set, and takes another set', () => {
    const first = beginVideoUpload('l-1');
    expect(beginVideoUpload('l-1')).toBeNull();
    expect(beginVideoUpload('l-2')).not.toBeNull();
    first.end();
    expect(beginVideoUpload('l-1')).not.toBeNull();
  });

  it('progress is a whole percent that only goes up', () => {
    const upload = beginVideoUpload('l-1');
    upload.progress(0.256);
    expect(getVideoUpload('l-1').percent).toBe(25);
    upload.progress(0.1);
    expect(getVideoUpload('l-1').percent).toBe(25);
    upload.progress(7);
    expect(getVideoUpload('l-1').percent).toBe(100);
    upload.progress(NaN);
    expect(getVideoUpload('l-1').percent).toBe(100);
  });

  it('the snapshot of a set is the same object until that set changes', () => {
    const one = beginVideoUpload('l-1');
    const two = beginVideoUpload('l-2');
    const before = getVideoUpload('l-1');
    two.progress(0.5);
    one.progress(0.001); // still 0 %
    expect(getVideoUpload('l-1')).toBe(before);
    one.progress(0.5);
    expect(getVideoUpload('l-1')).not.toBe(before);
  });

  it('tells its listeners once per percent, not once per event', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeVideoUploads(listener);
    const upload = beginVideoUpload('l-1');
    expect(listener).toHaveBeenCalledTimes(1);

    upload.progress(0.101);
    upload.progress(0.104);
    upload.progress(0.109);
    expect(listener).toHaveBeenCalledTimes(2);

    upload.end();
    expect(listener).toHaveBeenCalledTimes(3);

    unsubscribe();
    beginVideoUpload('l-9');
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('cancel aborts the signal of that set and marks the entry until the upload ends', () => {
    const one = beginVideoUpload('l-1');
    const two = beginVideoUpload('l-2');

    cancelVideoUpload('l-1');

    expect(one.signal.aborted).toBe(true);
    expect(two.signal.aborted).toBe(false);
    expect(getVideoUpload('l-1')).toMatchObject({ cancelled: true });

    one.end();
    expect(getVideoUpload('l-1')).toBeNull();
  });

  it('cancel of a set that is not uploading does nothing', () => {
    const listener = vi.fn();
    subscribeVideoUploads(listener);
    cancelVideoUpload('l-none');
    expect(listener).not.toHaveBeenCalled();
  });

  // An upload that unwinds late must not remove the entry of the one that
  // took its place.
  it('end and progress of a finished upload leave the next upload of the set alone', () => {
    const first = beginVideoUpload('l-1');
    first.end();
    const second = beginVideoUpload('l-1');
    second.progress(0.4);

    first.progress(0.9);
    first.end();

    expect(getVideoUpload('l-1')).toMatchObject({ percent: 40 });
    second.end();
  });
});
