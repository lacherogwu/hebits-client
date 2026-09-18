import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { createTransport } from '../src/transport.js';
import { LoginExpiredError, RateLimitedError } from '../src/errors.js';

let hits = 0;
const server = setupServer(
  http.get('https://hebits.net/ok.php', () => { hits++; return HttpResponse.json({ ok: true }); }),
  http.get('https://hebits.net/login.php', () => HttpResponse.text('<form id="loginform">', { status: 200 })),
  http.get('https://hebits.net/redirect.php', () => new HttpResponse(null, { status: 302, headers: { location: '/login.php' } })),
  http.get('https://hebits.net/slow.php', () => new HttpResponse(null, { status: 429 })),
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
