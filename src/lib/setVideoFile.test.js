import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  ACCEPTED_VIDEO_TYPES,
  MAX_VIDEO_BYTES,
  videoMimeType,
  videoExtension,
  videoFileProblem,
  videoFileError,
  videoUploadBody,
} from './setVideoFile';

// A File of any size without allocating it.
function fileOf(type, size = 1024, name = 'clip') {
  const file = new File(['x'], name, { type });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

describe('videoFileProblem', () => {
  it.each(['video/mp4', 'video/quicktime', 'video/webm'])('accepts %s', (type) => {
    expect(videoFileProblem(fileOf(type))).toBeNull();
  });

  it.each([
    ['video/3gpp'],
    ['video/x-matroska'],
    ['image/jpeg'],
    ['application/octet-stream'],
    [''],
  ])('refuses the type %j', (type) => {
    expect(videoFileProblem(fileOf(type))).toEqual({ code: 'type', type });
  });

  it('reads the type without its parameters and in lower case', () => {
    expect(videoFileProblem(fileOf('video/webm;codecs=vp9'))).toBeNull();
    expect(videoFileProblem(fileOf('Video/MP4'))).toBeNull();
    expect(videoMimeType(fileOf('video/webm; codecs="vp8, opus"'))).toBe('video/webm');
  });

  it('accepts a file of exactly 25 MB and refuses one byte more', () => {
    expect(videoFileProblem(fileOf('video/mp4', MAX_VIDEO_BYTES))).toBeNull();
    expect(videoFileProblem(fileOf('video/mp4', MAX_VIDEO_BYTES + 1))).toMatchObject({
      code: 'size',
      maxMegabytes: 25,
    });
  });

  it('gives the size of an oversize file in megabytes, to one decimal', () => {
    const problem = videoFileProblem(fileOf('video/mp4', 26.34 * 1024 * 1024));
    expect(problem).toEqual({ code: 'size', megabytes: '26.3', maxMegabytes: 25 });
  });

  // `size_bytes` is CHECK (size_bytes > 0): the row of an empty file is
  // refused after the upload.
  it('refuses an empty file', () => {
    expect(videoFileProblem(fileOf('video/mp4', 0))).toEqual({ code: 'empty' });
  });

  it('refuses a missing file as a type problem rather than throwing', () => {
    expect(videoFileProblem(undefined)).toEqual({ code: 'type', type: '' });
  });

  it('names the type before the size: an oversize file of the wrong type is a wrong type', () => {
    expect(videoFileProblem(fileOf('video/3gpp', MAX_VIDEO_BYTES * 2)).code).toBe('type');
  });
});

describe('videoFileError', () => {
  it('is an Error that carries the code of the problem', () => {
    const error = videoFileError({ code: 'size' });
    expect(error).toBeInstanceOf(Error);
    expect(error.videoProblem).toBe('size');
    expect(error.message).toMatch(/25 MB/);
  });
});

describe('videoExtension', () => {
  it('maps the three types and nothing else', () => {
    expect(videoExtension('video/mp4')).toBe('mp4');
    expect(videoExtension('video/quicktime')).toBe('mov');
    expect(videoExtension('video/webm')).toBe('webm');
    expect(videoExtension('video/3gpp')).toBe('bin');
  });
});

describe('videoUploadBody', () => {
  it('is the file itself when its type is already one of the list', () => {
    const file = new File(['abc'], 'clip.mp4', { type: 'video/mp4' });
    expect(videoUploadBody(file)).toBe(file);
  });

  it('is the same bytes under the bare type when the type has parameters', () => {
    const file = new File(['abcdef'], 'clip.webm', { type: 'video/webm;codecs=vp9' });
    const body = videoUploadBody(file);
    expect(body).not.toBe(file);
    expect(body.type).toBe('video/webm');
    expect(body.size).toBe(file.size);
  });
});

// The client's list is a copy of the bucket's. Nothing else holds the two
// together: a type added to one side only is either refused by the server
// after a full upload, or never offered.
describe('the list is the bucket’s', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const schema = readFileSync(resolve(here, '../../supabase/schema.sql'), 'utf8');
  const bucket = schema.match(
    /INSERT INTO storage\.buckets[\s\S]*?'set-videos',\s*'set-videos',\s*false,\s*(\d+),\s*ARRAY\[([^\]]*)\]/,
  );

  it('found the bucket in schema.sql', () => {
    expect(bucket).not.toBeNull();
  });

  it('accepts exactly the types the bucket allows', () => {
    const allowed = [...bucket[2].matchAll(/'([^']+)'/g)].map((m) => m[1]);
    expect([...ACCEPTED_VIDEO_TYPES].sort()).toEqual(allowed.sort());
  });

  it('stops below the size the bucket allows', () => {
    expect(MAX_VIDEO_BYTES).toBeLessThanOrEqual(Number(bucket[1]));
  });
});
