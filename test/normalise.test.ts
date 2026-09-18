import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { browseResponseSchema } from '../src/schemas.js';
import { factorsFor, flattenGroups, imdbFromCatalogue, parseHebitsTime } from '../src/normalise.js';
import { ApiError } from '../src/errors.js';

const parsed = browseResponseSchema.parse(
  JSON.parse(readFileSync(new URL('./fixtures/browse-freeleech.json', import.meta.url), 'utf8')),
);

test('imdbFromCatalogue extracts the id, with or without a trailing slash', () => {
  expect(imdbFromCatalogue('https://www.imdb.com/title/tt6820256')).toBe('tt6820256');
  expect(imdbFromCatalogue('https://www.imdb.com/title/tt32093575/')).toBe('tt32093575');
  expect(imdbFromCatalogue(undefined)).toBeUndefined();
  expect(imdbFromCatalogue('')).toBeUndefined();
  expect(imdbFromCatalogue('not a url')).toBeUndefined();
});

test('parseHebitsTime reads the unzoned string as Israel time, not UTC', () => {
  // 2026-01-15 is winter: Israel is UTC+2, so 12:00 local is 10:00Z
  expect(parseHebitsTime('2026-01-15 12:00:00').toISOString()).toBe('2026-01-15T10:00:00.000Z');
  // 2026-07-15 is summer: Israel is UTC+3, so 12:00 local is 09:00Z
  expect(parseHebitsTime('2026-07-15 12:00:00').toISOString()).toBe('2026-07-15T09:00:00.000Z');
});

test('parseHebitsTime does not depend on the machine timezone', () => {
  // The obvious implementation (re-parsing toLocaleString output) passes only on a UTC
  // host. This test fails it on any developer laptop, which is the point.
  const original = process.env['TZ'];
  try {
    for (const tz of ['UTC', 'Asia/Jerusalem', 'America/New_York', 'Australia/Sydney']) {
      process.env['TZ'] = tz;
      expect(parseHebitsTime('2026-01-15 12:00:00').toISOString(), `winter under TZ=${tz}`)
        .toBe('2026-01-15T10:00:00.000Z');
      expect(parseHebitsTime('2026-07-15 12:00:00').toISOString(), `summer under TZ=${tz}`)
        .toBe('2026-07-15T09:00:00.000Z');
    }
  } finally {
    if (original === undefined) delete process.env['TZ']; else process.env['TZ'] = original;
  }
});

test('an unparseable timestamp raises ApiError rather than an Invalid Date', () => {
  expect(() => parseHebitsTime('not a date')).toThrow(/unparseable timestamp/);
});

test('factorsFor maps every flag combination the tracker uses', () => {
  const base = {
    isFreeleech: false, isHalfFreeleech: false, isQuarterLeech: false,
    isNeutralLeech: false, isPersonalFreeleech: false, isUploadX2: false, isUploadX3: false,
  };
  expect(factorsFor({ ...base })).toEqual({ downloadFactor: 1, uploadFactor: 1 });
  expect(factorsFor({ ...base, isFreeleech: true })).toEqual({ downloadFactor: 0, uploadFactor: 1 });
  expect(factorsFor({ ...base, isPersonalFreeleech: true })).toEqual({ downloadFactor: 0, uploadFactor: 1 });
  expect(factorsFor({ ...base, isHalfFreeleech: true })).toEqual({ downloadFactor: 0.5, uploadFactor: 1 });
  expect(factorsFor({ ...base, isQuarterLeech: true })).toEqual({ downloadFactor: 0.25, uploadFactor: 1 });
  expect(factorsFor({ ...base, isUploadX2: true })).toEqual({ downloadFactor: 1, uploadFactor: 2 });
  expect(factorsFor({ ...base, isUploadX3: true })).toEqual({ downloadFactor: 1, uploadFactor: 3 });
  // neutral means neither side counts
  expect(factorsFor({ ...base, isNeutralLeech: true })).toEqual({ downloadFactor: 0, uploadFactor: 0 });
});

test('flattenGroups pushes group fields down onto every torrent', () => {
  const flat = flattenGroups(parsed.response.results);
  expect(flat.length).toBeGreaterThan(0);
  const t = flat[0]!;
  expect(t.id).toBeTypeOf('number');
  expect(t.groupId).toBeTypeOf('number');
  expect(t.size).toBeTypeOf('number');
  expect(t.uploadedAt).toBeInstanceOf(Date);
  expect(t.downloadFactor).toBeTypeOf('number');
  // every fixture row is freeleech, so none should cost download quota
  expect(flat.every((x) => x.downloadFactor === 0)).toBe(true);
});

test('flattenGroups produces one row per torrent, not per group', () => {
  const groups = parsed.response.results;
  const expected = groups.reduce((n, g) => n + g.torrents.length, 0);
  expect(flattenGroups(groups).length).toBe(expected);
});

test('a group with no torrents contributes nothing and does not throw', () => {
  expect(flattenGroups([{ ...parsed.response.results[0]!, torrents: [] }])).toEqual([]);
});
