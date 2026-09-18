import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { isLoggedIn, parseDailyDownloads } from '../src/scrape.js';

const fixture = readFileSync(new URL('./fixtures/user-daily.html', import.meta.url), 'utf8');

test('reads the daily counter from the real page', () => {
  const r = parseDailyDownloads(fixture);
  expect(r).not.toBeNull();
  expect(r!.used).toBeTypeOf('number');
  expect(r!.limit).toBeGreaterThan(0);
  expect(r!.used).toBeLessThanOrEqual(r!.limit);
});

test('handles the counter with varied spacing and surrounding markup', () => {
  expect(parseDailyDownloads('<b>הורדות יומיות:</b> 3 / 10')).toEqual({ used: 3, limit: 10 });
  expect(parseDailyDownloads('הורדות יומיות:0/5')).toEqual({ used: 0, limit: 5 });
});

test('returns null rather than guessing when the line is absent', () => {
  expect(parseDailyDownloads('<html>nothing here</html>')).toBeNull();
  expect(parseDailyDownloads('')).toBeNull();
});

test('isLoggedIn keys on the logout link, as Jackett does', () => {
  expect(isLoggedIn('<a href="/logout.php?auth=deadbeef">logout</a>')).toBe(true);
  expect(isLoggedIn('<form id="loginform">')).toBe(false);
  expect(isLoggedIn('')).toBe(false);
});
