import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { browseResponseSchema, type RawGroup } from '../src/schemas';
import { factorsFor, flattenGroups, imdbFromCatalogue, parseHebitsTime } from '../src/normalise';
import { ApiError } from '../src/errors';

const parsed = browseResponseSchema.parse(JSON.parse(readFileSync(new URL('./fixtures/browse-freeleech.json', import.meta.url), 'utf8')));

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
      expect(parseHebitsTime('2026-01-15 12:00:00').toISOString(), `winter under TZ=${tz}`).toBe('2026-01-15T10:00:00.000Z');
      expect(parseHebitsTime('2026-07-15 12:00:00').toISOString(), `summer under TZ=${tz}`).toBe('2026-07-15T09:00:00.000Z');
    }
  } finally {
    if (original === undefined) delete process.env['TZ'];
    else process.env['TZ'] = original;
  }
});

test('an unparseable timestamp raises ApiError rather than an Invalid Date', () => {
  expect(() => parseHebitsTime('not a date')).toThrow(/unparseable timestamp/);
});

function formatJerusalem(d: Date): string {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jerusalem',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value])) as Record<string, string>;
  return `${p['year']}-${p['month']}-${p['day']} ${p['hour']}:${p['minute']}:${p['second']}`;
}

// Asia/Jerusalem's 2026 DST transitions: spring forward on 03-27 (02:00 IST -> 03:00
// IDT), fall back on 10-25 (02:00 IDT -> 01:00 IST). Every OTHER hour of both days must
// round-trip exactly: format the two-pass result back into Jerusalem wall time and get
// the input back. The two hours that can't are excluded here and covered by name below —
// see parseHebitsTime's doc comment for why each is unrecoverable from an unzoned string.
test('parseHebitsTime round-trips every hour across both 2026 DST transition days', () => {
  for (const day of ['2026-03-27', '2026-10-25']) {
    for (let h = 0; h < 24; h++) {
      if (day === '2026-03-27' && h === 2) continue; // 02:00-02:59 doesn't exist — see below
      if (day === '2026-10-25' && h === 1) continue; // 01:00-01:59 is ambiguous — see below
      const input = `${day} ${String(h).padStart(2, '0')}:30:00`;
      expect(formatJerusalem(parseHebitsTime(input)), input).toBe(input);
    }
  }
});

test('spring-forward gap (03-27 02:00-02:59, 2026): maps forward into 03:xx IDT', () => {
  // These wall times never occurred. Two-pass converges on the same "compatible"
  // disambiguation Temporal uses: push forward past the gap into the next real instant.
  expect(formatJerusalem(parseHebitsTime('2026-03-27 02:30:00'))).toBe('2026-03-27 03:30:00');
});

test('fall-back overlap (10-25 01:00-01:59, 2026): resolves to the later (IST) reading', () => {
  // This wall time occurs twice: once at 00:30Z+ (IDT, UTC+3) and once at 23:30Z- the
  // day before (IST, UTC+2). Two-pass always lands on the later reading — a torrent
  // uploaded in the FIRST occurrence of this hour can read up to an hour newer than it
  // really is. Not recoverable: the offset isn't in the data, only in which occurrence
  // it was. Documented, not silently wrong.
  expect(parseHebitsTime('2026-10-25 01:30:00').toISOString()).toBe('2026-10-24T23:30:00.000Z');
});

test('factorsFor maps every flag combination the tracker uses', () => {
  const base = {
    isFreeleech: false,
    isHalfFreeleech: false,
    isQuarterLeech: false,
    isNeutralLeech: false,
    isPersonalFreeleech: false,
    isUploadX2: false,
    isUploadX3: false,
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

test('factorsFor: the cheaper of half- and quarter-leech wins if a torrent is somehow flagged both', () => {
  const base = {
    isFreeleech: false,
    isHalfFreeleech: true,
    isQuarterLeech: true,
    isNeutralLeech: false,
    isPersonalFreeleech: false,
    isUploadX2: false,
    isUploadX3: false,
  };
  expect(factorsFor(base).downloadFactor).toBe(0.25);
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

// A hand-built literal, not a fixture: the fixture scrubber forces hasSnatched to false
// on every recorded torrent, so a fixture-based test could never exercise `true` here.
test('flattenGroups passes canUseToken and hasSnatched through as-is, including true', () => {
  const group: RawGroup = {
    groupId: 1,
    groupName: 'Test Group',
    categoryID: 1,
    torrents: [
      {
        torrentId: 1,
        fileCount: 1,
        time: '2026-01-15 12:00:00',
        size: 100,
        snatches: 0,
        seeders: 1,
        leechers: 0,
        isFreeleech: false,
        isHalfFreeleech: false,
        isQuarterLeech: false,
        isNeutralLeech: false,
        isPersonalFreeleech: false,
        isUploadX2: false,
        isUploadX3: false,
        canUseToken: true,
        hasSnatched: true,
      },
    ],
  };
  const [t] = flattenGroups([group]);
  expect(t!.canUseToken).toBe(true);
  expect(t!.hasSnatched).toBe(true);
});
