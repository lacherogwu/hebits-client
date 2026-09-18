import ky, { HTTPError, type KyInstance } from 'ky';
import pThrottle from 'p-throttle';
import { ApiError, LoginExpiredError, RateLimitedError } from './errors.js';

export interface TransportOptions {
  cookie: string;
  baseUrl?: string;
  userAgent?: string;
  /** Default 1 request per 2s. Nothing here is latency-sensitive. */
  rateLimit?: { limit: number; interval: number };
  /** Default 10 minutes. Set 0 to disable. */
  cacheTtlMs?: number;
  /** Caps how many distinct query keys the response cache holds at once — a modest LRU
   *  bound, so a long-lived process issuing many distinct queries (e.g. one IMDb id per
   *  browse call) doesn't grow the cache without limit. Default 200. */
  cacheMaxEntries?: number;
  retry?: number;
  timeoutMs?: number;
}

export interface RequestOptions {
  /** Skip the response cache for this call — read through to the tracker and still
   *  write the fresh result back to the cache for everyone else. For calls where a
   *  stale answer is actively wrong to act on (a login check, a daily quota count),
   *  not just inconvenient. */
  bypassCache?: boolean;
}

export interface Transport {
  json(path: string, searchParams?: Record<string, string | number>, opts?: RequestOptions): Promise<unknown>;
  text(path: string, searchParams?: Record<string, string | number>, opts?: RequestOptions): Promise<string>;
  bytes(path: string, searchParams?: Record<string, string | number>): Promise<Uint8Array>;
}

// Duplicates the version in package.json. Reading package.json from source would need an
// import attribute and complicate the bundle for a string used in one header — accepted wart.
const VERSION = '0.1.0';
const LOGIN_MARKERS = [/id=["']loginform["']/i, /action=["']login\.php/i];
const RETRYABLE_STATUS = new Set([408, 500, 502, 503, 504]);
// How much of a byte body to decode when sniffing for a login page. Login pages are
// small; a .torrent's bencode never starts with anything that decodes into this text.
const SNIFF_BYTES = 4096;

/** A redirect to login, or a login form served with 200, both mean the cookie is dead.
 *  Matches the response URL's PATH only, not the full URL — a search for the literal
 *  string "login.php" (`browse({ query: 'login.php' })`) must not trip this. */
function assertNotLoginPage(url: string, body: string): void {
  const path = (() => {
    try {
      return new URL(url).pathname;
    } catch {
      return url;
    }
  })();
  if (path.endsWith('login.php') || LOGIN_MARKERS.some((re) => re.test(body))) {
    throw new LoginExpiredError('Hebits returned the login page — the cookie has expired');
  }
}

/** Decode enough of a byte body to run the same login-page check text responses get.
 *  A .torrent file never decodes into anything matching LOGIN_MARKERS. */
function sniff(body: string | Uint8Array): string {
  return typeof body === 'string' ? body : new TextDecoder().decode(body.slice(0, SNIFF_BYTES));
}

export function createTransport(opts: TransportOptions): Transport {
  const {
    cookie,
    baseUrl = 'https://hebits.net',
    userAgent = `hebits-client/${VERSION}`,
    rateLimit = { limit: 1, interval: 2000 },
    cacheTtlMs = 10 * 60 * 1000,
    cacheMaxEntries = 200,
    retry = 2,
    timeoutMs = 30_000,
  } = opts;

  const client: KyInstance = ky.create({
    baseUrl,
    timeout: timeoutMs,
    redirect: 'manual',
    // ky's own retry is disabled: we retry ourselves, one attempt at a time through the
    // throttle below, so a retry burst is still spaced like any other request. Retrying
    // inside a single throttle slot (ky's default) would let a 5xx burst fire several
    // requests back to back.
    retry: 0,
    headers: { cookie, 'user-agent': userAgent },
  });

  // ONE throttle for every request this transport makes — text, JSON, bytes, and each
  // retry attempt of any of them. Two separate throttles (one per response type) would
  // let browsing and downloading interleave at double the configured rate.
  const throttledAttempt = pThrottle(rateLimit)(
    async (path: string, sp: Record<string, string | number> | undefined, responseType: 'text' | 'bytes') => {
      const res = await client.get(path, sp ? { searchParams: sp } : undefined);
      const body = responseType === 'text' ? await res.text() : new Uint8Array(await res.arrayBuffer());
      return { res, body };
    },
  );

  async function request(
    path: string,
    sp: Record<string, string | number> | undefined,
    responseType: 'text',
    retriesLeft?: number,
  ): Promise<string>;
  async function request(
    path: string,
    sp: Record<string, string | number> | undefined,
    responseType: 'bytes',
    retriesLeft?: number,
  ): Promise<Uint8Array>;
  async function request(
    path: string,
    sp: Record<string, string | number> | undefined,
    responseType: 'text' | 'bytes',
    retriesLeft: number = retry,
  ): Promise<string | Uint8Array> {
    try {
      const { res, body } = await throttledAttempt(path, sp, responseType);
      assertNotLoginPage(res.url, sniff(body));
      return body;
    } catch (e) {
      if (e instanceof HTTPError) {
        const { status, headers } = e.response;
        if (status === 429) throw new RateLimitedError('Hebits asked us to slow down', { cause: e });
        if (status >= 300 && status < 400 && /login\.php/.test(headers.get('location') ?? '')) {
          throw new LoginExpiredError('Hebits redirected to login — the cookie has expired', { cause: e });
        }
        if (RETRYABLE_STATUS.has(status) && retriesLeft > 0) {
          return request(path, sp, responseType as 'text', retriesLeft - 1);
        }
        throw new ApiError(`Hebits returned HTTP ${status} for ${path}`, { cause: e });
      }
      throw e;
    }
  }

  // key -> settled value with its expiry, and key -> in-flight promise. `cache` is a
  // Map, so iteration order is insertion order; entries are deleted-and-reinserted on
  // every touch (read or write) so the first key is always the least recently used one.
  const cache = new Map<string, { at: number; body: string }>();
  const pending = new Map<string, Promise<string>>();

  function pruneCache(): void {
    if (cacheTtlMs > 0) {
      const now = Date.now();
      for (const [k, v] of cache) {
        if (now - v.at >= cacheTtlMs) cache.delete(k);
      }
    }
    while (cache.size > cacheMaxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }

  function cacheGet(key: string): string | undefined {
    const hit = cache.get(key);
    if (!hit || Date.now() - hit.at >= cacheTtlMs) return undefined;
    cache.delete(key);
    cache.set(key, hit); // bump recency
    return hit.body;
  }

  function cacheSet(key: string, body: string): void {
    cache.delete(key);
    cache.set(key, { at: Date.now(), body });
    pruneCache();
  }

  async function fetchBody(
    path: string,
    sp: Record<string, string | number> | undefined,
    opts?: RequestOptions,
  ): Promise<string> {
    const key = `${path}?${new URLSearchParams(Object.entries(sp ?? {}).map(([k, v]) => [k, String(v)])).toString()}`;
    if (cacheTtlMs > 0 && !opts?.bypassCache) {
      const hit = cacheGet(key);
      if (hit !== undefined) return hit;
    }
    const inFlight = pending.get(key);
    if (inFlight) return inFlight;

    // Attach the settle handler in the same statement that creates the promise, so the
    // stored promise always has a handler and a rejection is never unobserved.
    const run = request(path, sp, 'text').then(
      (body) => {
        if (cacheTtlMs > 0) cacheSet(key, body);
        pending.delete(key);
        return body;
      },
      (err) => {
        pending.delete(key); // never cache a failure
        throw err;
      },
    );
    pending.set(key, run);
    return run;
  }

  return {
    async json(path, sp, opts) {
      const body = await fetchBody(path, sp, opts);
      try {
        return JSON.parse(body);
      } catch (e) {
        throw new ApiError(`${path} did not return JSON`, { cause: e });
      }
    },
    text: (path, sp, opts) => fetchBody(path, sp, opts),
    async bytes(path, sp) {
      // Binary bodies skip the text CACHE — .torrent files are large and fetched once
      // each — but go through the same throttle, retry and error mapping (including the
      // login-page check) as everything else. A download is a tracker request like any
      // other, and letting it bypass rate limiting or error handling would defeat the
      // point of having them at all.
      return request(path, sp, 'bytes');
    },
  };
}
