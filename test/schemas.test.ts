import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { browseResponseSchema, indexResponseSchema, parseOrThrow } from '../src/schemas.js';
import { ApiError } from '../src/errors.js';

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

test.each(['browse-freeleech.json', 'browse-latest.json', 'search-imdb.json'])(
  '%s parses against the browse schema',
  (name) => {
    const r = browseResponseSchema.safeParse(fixture(name));
    if (!r.success) throw new Error(`${name} failed: ${JSON.stringify(r.error.issues.slice(0, 5), null, 2)}`);
    expect(r.success).toBe(true);
  },
);

test('index.json parses against the index schema', () => {
  const r = indexResponseSchema.safeParse(fixture('index.json'));
  if (!r.success) throw new Error(JSON.stringify(r.error.issues.slice(0, 5), null, 2));
  expect(r.data.response.userstats.ratio).toBeTypeOf('number');
});

test('a browse fixture yields at least one group with at least one torrent', () => {
  const parsed = browseResponseSchema.parse(fixture('browse-freeleech.json'));
  const group = parsed.response.results[0];
  expect(group).toBeDefined();
  expect(group!.torrents.length).toBeGreaterThan(0);
});

test('parseOrThrow turns a schema mismatch into ApiError naming the field', () => {
  expect(() => parseOrThrow(indexResponseSchema, { status: 'success', response: {} }, 'index'))
    .toThrow(ApiError);
  try {
    parseOrThrow(indexResponseSchema, { status: 'success', response: {} }, 'index');
  } catch (e) {
    expect((e as Error).message).toMatch(/index/);
    expect((e as Error).message).toMatch(/userstats|response/);
  }
});

test('a non-success status is rejected', () => {
  expect(browseResponseSchema.safeParse({ status: 'failure', response: { results: [] } }).success).toBe(false);
});

// canUseToken and hasSnatched are required, not optional: if the tracker ever drops one,
// this is the guard that actually fires, rather than every torrent silently reporting a
// plausible `false`.
test('a torrent missing hasSnatched is rejected with ApiError, not defaulted', () => {
  const group = {
    groupId: 1, groupName: 'g', categoryID: 1,
    torrents: [{
      torrentId: 1, fileCount: 1, time: '2026-01-15 12:00:00', size: 100,
      snatches: 0, seeders: 1, leechers: 0,
      isFreeleech: false, isHalfFreeleech: false, isQuarterLeech: false, isNeutralLeech: false,
      isPersonalFreeleech: false, isUploadX2: false, isUploadX3: false,
      canUseToken: true,
      // hasSnatched intentionally omitted
    }],
  };
  const data = { status: 'success', response: { results: [group] } };
  expect(() => parseOrThrow(browseResponseSchema, data, 'ajax.php?action=browse')).toThrow(ApiError);
  try {
    parseOrThrow(browseResponseSchema, data, 'ajax.php?action=browse');
  } catch (e) {
    expect((e as Error).message).toMatch(/hasSnatched/);
  }
});
