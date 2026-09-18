import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { createTransport } from '../src/transport';
import { LoginExpiredError, RateLimitedError } from '../src/errors';

let hits = 0;
const server = setupServer(
  http.get('https://hebits.net/ok.php', () => { hits++; return HttpResponse.json({ ok: true }); }),
  http.get('https://hebits.net/login.php', () => HttpResponse.text('<form id="loginform">', { status: 200 })),
  http.get('https://hebits.net/redirect.php', () => new HttpResponse(null, { status: 302, headers: { location: '/login.php' } })),
  http.get('https://hebits.net/slow.php', () => new HttpResponse(null, { status: 429 })),
  http.get('https://hebits.net/dl-redirect.php', () => new HttpResponse(null, { status: 302, headers: { location: '/login.php' } })),
  http.get('https://hebits.net/dl-slow.php', () => new HttpResponse(null, { status: 429 })),
  http.get('https://hebits.net/dl-loginpage.php', () =>
    HttpResponse.arrayBuffer(new TextEncoder().encode('<html><form id="loginform">login</form></html>').buffer, { status: 200 })),
);
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { server.resetHandlers(); hits = 0; });
afterAll(() => server.close());

const make = (over = {}) => createTransport({ cookie: 'sid=abc', rateLimit: { limit: 100, interval: 1 }, cacheTtlMs: 60_000, ...over });

test('sends the cookie and an honest user agent, never a browser one', async () => {
  let seen: Headers | undefined;
  server.use(http.get('https://hebits.net/ok.php', ({ request }) => { seen = request.headers; return HttpResponse.json({ ok: true }); }));
  await make().json('ok.php');
  expect(seen!.get('cookie')).toBe('sid=abc');
  expect(seen!.get('user-agent')).toMatch(/^hebits-client\//);
  expect(seen!.get('user-agent')).not.toMatch(/Mozilla/);
});

test('concurrent identical requests collapse to ONE network call', async () => {
  const t = make();
  await Promise.all([t.json('ok.php'), t.json('ok.php'), t.json('ok.php')]);
  expect(hits).toBe(1);
});

test('different query strings are not collapsed', async () => {
  const t = make();
  await Promise.all([t.json('ok.php', { a: 1 }), t.json('ok.php', { a: 2 })]);
  expect(hits).toBe(2);
});

test('a settled result is served from cache inside the TTL', async () => {
  const t = make();
  await t.json('ok.php');
  await t.json('ok.php');
  expect(hits).toBe(1);
});

test('the cache expires', async () => {
  vi.useFakeTimers();
  const t = make({ cacheTtlMs: 1000 });
  await t.json('ok.php');
  vi.advanceTimersByTime(1500);
  await t.json('ok.php');
  vi.useRealTimers();
  expect(hits).toBe(2);
});

test('a failure is NOT cached — the next call retries', async () => {
  let n = 0;
  server.use(http.get('https://hebits.net/flaky.php', () => {
    n++;
    return n === 1 ? new HttpResponse(null, { status: 500 }) : HttpResponse.json({ ok: true });
  }));
  const t = make({ retry: 0 });
  await expect(t.json('flaky.php')).rejects.toThrow();
  await expect(t.json('flaky.php')).resolves.toBeTruthy();
  expect(n).toBe(2);
});

test('a redirect to the login page becomes LoginExpiredError', async () => {
  await expect(make().json('redirect.php')).rejects.toThrow(LoginExpiredError);
});

test('a login form in a 200 body also becomes LoginExpiredError', async () => {
  await expect(make().text('login.php')).rejects.toThrow(LoginExpiredError);
});

test('429 becomes RateLimitedError', async () => {
  await expect(make({ retry: 0 }).json('slow.php')).rejects.toThrow(RateLimitedError);
});

test('LoginExpiredError is never retried — one attempt only', async () => {
  let n = 0;
  server.use(http.get('https://hebits.net/dead.php', () => { n++; return new HttpResponse(null, { status: 302, headers: { location: '/login.php' } }); }));
  await expect(make({ retry: 3 }).json('dead.php')).rejects.toThrow(LoginExpiredError);
  expect(n).toBe(1);
});

test('BYTE downloads go through the throttle too, not around it', async () => {
  server.use(http.get('https://hebits.net/dl.php', () => HttpResponse.arrayBuffer(new TextEncoder().encode('d4:infoe').buffer)));
  const t = createTransport({ cookie: 'x', rateLimit: { limit: 1, interval: 50 }, cacheTtlMs: 0 });
  const started = Date.now();
  await Promise.all([t.bytes('dl.php', { id: 1 }), t.bytes('dl.php', { id: 2 })]);
  expect(Date.now() - started).toBeGreaterThanOrEqual(45);
});

test('the throttle serialises requests', async () => {
  const t = createTransport({ cookie: 'x', rateLimit: { limit: 1, interval: 50 }, cacheTtlMs: 0 });
  const started = Date.now();
  await Promise.all([t.json('ok.php', { a: 1 }), t.json('ok.php', { a: 2 })]);
  expect(Date.now() - started).toBeGreaterThanOrEqual(45);
});

// Finding 3: one throttle instance for ALL requests. Browsing (json) and downloading
// (bytes) interleave in the account builder's normal loop, so they must share the rate
// limit rather than each getting their own — which would double the real request rate.
test('a JSON call and a byte call share the same throttle, not one each', async () => {
  server.use(http.get('https://hebits.net/dl-ok.php', () =>
    HttpResponse.arrayBuffer(new TextEncoder().encode('d4:infoe').buffer)));
  const t = createTransport({ cookie: 'x', rateLimit: { limit: 1, interval: 50 }, cacheTtlMs: 0 });
  const started = Date.now();
  await Promise.all([t.json('ok.php'), t.bytes('dl-ok.php')]);
  expect(Date.now() - started).toBeGreaterThanOrEqual(45);
});

// Findings 1 & 2: byte requests (downloadTorrent's transport) get the same error mapping
// and login-page detection as text/JSON requests, which previously had none.
test('a redirect to login on the download endpoint raises LoginExpiredError from bytes()', async () => {
  await expect(make().bytes('dl-redirect.php')).rejects.toThrow(LoginExpiredError);
});

test('a 429 on the download endpoint raises RateLimitedError from bytes()', async () => {
  await expect(make({ retry: 0 }).bytes('dl-slow.php')).rejects.toThrow(RateLimitedError);
});

test('a login page served with 200 on the download endpoint raises LoginExpiredError, not a generic body', async () => {
  await expect(make().bytes('dl-loginpage.php')).rejects.toThrow(LoginExpiredError);
});

// Finding 9: the login-page check must match the response URL's PATH, not the full URL
// (which includes the query string) — otherwise searching for the literal text
// "login.php" falsely looks like a dead cookie.
test('searching for the literal string "login.php" does not falsely trip LoginExpiredError', async () => {
  server.use(http.get('https://hebits.net/ok.php', ({ request }) => {
    const q = new URL(request.url).searchParams.get('searchstr');
    return HttpResponse.json({ ok: true, q });
  }));
  await expect(make().json('ok.php', { searchstr: 'login.php' })).resolves.toEqual({ ok: true, q: 'login.php' });
});

// Finding 4: the response cache must not grow without bound.
test('the response cache evicts once it exceeds cacheMaxEntries', async () => {
  let calls = 0;
  server.use(http.get('https://hebits.net/many.php', () => { calls++; return HttpResponse.json({ ok: true }); }));
  const t = createTransport({ cookie: 'x', rateLimit: { limit: 1000, interval: 1 }, cacheTtlMs: 60_000, cacheMaxEntries: 10 });
  for (let i = 0; i < 50; i++) await t.json('many.php', { i });
  expect(calls).toBe(50);
  // Re-request the very first key: if it survived uncapped, this would be a cache hit
  // and issue no new network call. It must have been evicted, so a fresh request goes out.
  const before = calls;
  await t.json('many.php', { i: 0 });
  expect(calls).toBe(before + 1);
});

// Finding 7: checkLogin/dailyDownloads read fresh; the transport-level knob they use.
test('bypassCache reads through even when a fresh cache entry exists', async () => {
  const t = make();
  await t.text('ok.php'); // populates the cache
  const before = hits;
  await t.text('ok.php', undefined, { bypassCache: true });
  expect(hits).toBe(before + 1);
});

// Finding 11: retries must not fire back-to-back inside one throttle slot — each retry
// attempt is its own throttled call, so a retry burst is still spaced like any other request.
test('a retried request is spaced by the throttle, not fired back-to-back', async () => {
  let n = 0;
  server.use(http.get('https://hebits.net/retry-spacing.php', () => {
    n++;
    return n < 3 ? new HttpResponse(null, { status: 500 }) : HttpResponse.json({ ok: true });
  }));
  const t = createTransport({ cookie: 'x', rateLimit: { limit: 1, interval: 60 }, cacheTtlMs: 0, retry: 2 });
  const started = Date.now();
  await expect(t.json('retry-spacing.php')).resolves.toEqual({ ok: true });
  expect(n).toBe(3);
  // Two retries after the first attempt means at least two throttle intervals elapsed.
  expect(Date.now() - started).toBeGreaterThanOrEqual(100);
});
