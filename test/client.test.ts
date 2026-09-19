import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { Hebits } from '../src/client';
import { NotATorrentError } from '../src/errors';

const fx = (n: string) => readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8');
let lastUrl = '';

const server = setupServer(
  http.get('https://hebits.net/ajax.php', ({ request }) => {
    lastUrl = request.url;
    const action = new URL(request.url).searchParams.get('action');
    if (action === 'index') return HttpResponse.text(fx('index.json'), { headers: { 'content-type': 'application/json' } });
    return HttpResponse.text(fx('browse-freeleech.json'), { headers: { 'content-type': 'application/json' } });
  }),
  http.get('https://hebits.net/user.php', () => HttpResponse.html(fx('user-daily.html'))),
  http.get('https://hebits.net/', () => HttpResponse.html('<a href="/logout.php?auth=x">out</a>')),
  http.get('https://hebits.net/torrents.php', () => HttpResponse.arrayBuffer(new TextEncoder().encode('d4:infoe').buffer)),
);
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const hb = () => new Hebits({ cookie: 'sid=x', rateLimit: { limit: 100, interval: 1 }, cacheTtlMs: 0 });

test('stats returns normalised account figures', async () => {
  const s = await hb().stats();
  expect(s.uploaded).toBeTypeOf('number');
  expect(s.ratio).toBeTypeOf('number');
  expect(s.userClass).toBeTypeOf('string');
  expect(s.userId).toBeTypeOf('number');
});

test('browse returns flat torrents, not groups', async () => {
  const rows = await hb().browse();
  expect(rows.length).toBeGreaterThan(0);
  expect(rows[0]!.id).toBeTypeOf('number');
  expect(rows[0]!.uploadedAt).toBeInstanceOf(Date);
});

test('freeleechOnly sets freetorrent=1', async () => {
  await hb().browse({ freeleechOnly: true });
  expect(new URL(lastUrl).searchParams.get('freetorrent')).toBe('1');
});

test('imdb is sent as the search string', async () => {
  await hb().search({ imdb: 'tt0944947' });
  expect(new URL(lastUrl).searchParams.get('searchstr')).toContain('tt0944947');
});

test('a season is appended to the query, since Gazelle has no season parameter', async () => {
  await hb().search({ imdb: 'tt0944947', season: 3 });
  const s = new URL(lastUrl).searchParams.get('searchstr')!;
  expect(s).toContain('tt0944947');
  expect(s).toMatch(/S0?3|season 3/i);
});

test('categories become filter_cat entries', async () => {
  await hb().browse({ categories: [1, 2] });
  expect(lastUrl).toContain('filter_cat%5B1%5D=1');
  expect(lastUrl).toContain('filter_cat%5B2%5D=1');
});

test('limit caps the rows returned', async () => {
  const rows = await hb().browse({ limit: 3 });
  expect(rows.length).toBeLessThanOrEqual(3);
});

test('dailyDownloads resolves the account id by itself', async () => {
  const d = await hb().dailyDownloads();
  expect(d.limit).toBeGreaterThan(0);
});

test('checkLogin resolves on a page with a logout link', async () => {
  await expect(hb().checkLogin()).resolves.toBeUndefined();
});

test('downloadTorrent returns bytes', async () => {
  const b = await hb().downloadTorrent(1);
  expect(b).toBeInstanceOf(Uint8Array);
  expect(new TextDecoder().decode(b).startsWith('d')).toBe(true);
});

test('an HTML body from the download endpoint raises NotATorrentError', async () => {
  server.use(
    http.get('https://hebits.net/torrents.php', () => HttpResponse.arrayBuffer(new TextEncoder().encode('<html>no</html>').buffer)),
  );
  await expect(hb().downloadTorrent(1)).rejects.toThrow(NotATorrentError);
});
