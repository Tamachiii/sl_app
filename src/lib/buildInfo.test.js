import { describe, it, expect } from 'vitest';
import {
  BUILD_ID,
  BUILD_META,
  NO_BUILD,
  buildMetaTag,
  makeBuildId,
  readBuildId,
} from './buildInfo';

function documentWith(head) {
  return new DOMParser().parseFromString(`<!doctype html><html><head>${head}</head><body></body></html>`, 'text/html');
}

describe('makeBuildId — the id a build gives itself', () => {
  it('is the UTC time the build started, to the second', () => {
    expect(makeBuildId({ now: new Date('2026-10-13T14:23:55.678Z') })).toBe('20261013142355');
    expect(makeBuildId({ env: { SL_BUILD_ID: '   ' }, now: new Date('2026-01-02T03:04:05Z') })).toBe(
      '20260102030405',
    );
  });

  it('sorts, as a string, in the order of the builds', () => {
    const times = [
      '2026-10-13T23:59:59Z',
      '2026-10-14T00:00:00Z',
      '2026-11-01T09:00:00Z',
      '2027-01-01T00:00:00Z',
    ];
    const ids = times.map((t) => makeBuildId({ now: new Date(t) }));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids.map((id) => id.length))).toEqual(new Set([14]));
  });

  it('is the one the environment gives, when it gives one', () => {
    expect(makeBuildId({ env: { SL_BUILD_ID: ' 20261013142355-r7 ' } })).toBe('20261013142355-r7');
  });

  it('refuses an id that could not be written into a tag or a file name', () => {
    expect(() => makeBuildId({ env: { SL_BUILD_ID: '"><script>' } })).toThrow(/SL_BUILD_ID/);
    expect(() => makeBuildId({ env: { SL_BUILD_ID: 'a b' } })).toThrow(/SL_BUILD_ID/);
    expect(() => makeBuildId({ env: { SL_BUILD_ID: 'x'.repeat(65) } })).toThrow(/SL_BUILD_ID/);
  });
});

describe('the id in index.html', () => {
  it('is written as a meta tag in the head', () => {
    expect(buildMetaTag('20261013142355')).toEqual({
      tag: 'meta',
      attrs: { name: BUILD_META, content: '20261013142355' },
      injectTo: 'head',
    });
  });

  it('is read back by the page', () => {
    const tag = buildMetaTag('20261013142355');
    const doc = documentWith(`<meta name="${tag.attrs.name}" content="${tag.attrs.content}">`);
    expect(readBuildId(doc)).toBe('20261013142355');
  });

  it('is NO_BUILD for a page no build wrote, or where there is no page', () => {
    expect(readBuildId(documentWith(''))).toBe(NO_BUILD);
    expect(readBuildId(documentWith(`<meta name="${BUILD_META}" content="  ">`))).toBe(NO_BUILD);
    expect(readBuildId(null)).toBe(NO_BUILD);
    expect(BUILD_ID).toBe(NO_BUILD); // vitest's document has no build
  });
});
