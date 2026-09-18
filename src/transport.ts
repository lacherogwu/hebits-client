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
  retry?: number;
  timeoutMs?: number;
}

export interface Transport {
  json(path: string, searchParams?: Record<string, string | number>): Promise<unknown>;
  text(path: string, searchParams?: Record<string, string | number>): Promise<string>;
  bytes(path: string, searchParams?: Record<string, string | number>): Promise<Uint8Array>;
}

// Duplicates the version in package.json. Reading package.json from source would need an
// import attribute and complicate the bundle for a string used in one header — accepted wart.
const VERSION = '0.1.0';
const LOGIN_MARKERS = [/id=["']loginform["']/i, /action=["']login\.php/i];

/** A redirect to login, or a login form served with 200, both mean the cookie is dead. */
function assertNotLoginPage(url: string, body: string): void {
  if (/login\.php/.test(url) || LOGIN_MARKERS.some((re) => re.test(body))) {
    throw new LoginExpiredError('Hebits returned the login page — the cookie has expired');
  }
}

export function createTransport(opts: TransportOptions): Transport {
  const {
    cookie,
    baseUrl = 'https://hebits.net',
    userAgent = `hebits-client/${VERSION}`,
    rateLimit = { limit: 1, interval: 2000 },
    cacheTtlMs = 10 * 60 * 1000,
    retry = 2,
    timeoutMs = 30_000,
  } = opts;

  const client: KyInstance = ky.create({
    baseUrl,
    timeout: timeoutMs,
    redirect: 'manual',
    retry: {
      limit: retry,
      methods: ['get'],
      statusCodes: [408, 500, 502, 503, 504],
    },
    headers: { cookie, 'user-agent': userAgent },
  });

  const throttled = pThrottle(rateLimit)(async (path: string, sp?: Record<string, string | number>) => {
    try {
      const res = await client.get(path, sp ? { searchParams: sp as Record<string, string | number> } : undefined);
      const body = await res.text();
      assertNotLoginPage(res.url, body);
      return { body, res };
    } catch (e) {
      if (e instanceof HTTPError) {
        const { status, headers } = e.response;
        if (status === 429) throw new RateLimitedError('Hebits asked us to slow down', { cause: e });
        if (status >= 300 && status < 400 && /login\.php/.test(headers.get('location') ?? '')) {
          throw new LoginExpiredError('Hebits redirected to login — the cookie has expired', { cause: e });
        }
        throw new ApiError(`Hebits returned HTTP ${status} for ${path}`, { cause: e });
      }
      throw e;
    }
  });

  const throttledBytes = pThrottle(rateLimit)(async (path: string, sp?: Record<string, string | number>) => {
    const res = await client.get(path, sp ? { searchParams: sp as Record<string, string | number> } : undefined);
    return new Uint8Array(await res.arrayBuffer());
  });

  // key -> settled value with its expiry, and key -> in-flight promise.
  const cache = new Map<string, { at: number; body: string }>();
  const pending = new Map<string, Promise<string>>();

  async function fetchBody(path: string, sp?: Record<string, string | number>): Promise<string> {
    const key = `${path}?${new URLSearchParams(Object.entries(sp ?? {}).map(([k, v]) => [k, String(v)])).toString()}`;
    const hit = cache.get(key);
    if (cacheTtlMs > 0 && hit && Date.now() - hit.at < cacheTtlMs) return hit.body;
    const inFlight = pending.get(key);
    if (inFlight) return inFlight;

    // Attach the settle handler in the same statement that creates the promise, so the
    // stored promise always has a handler and a rejection is never unobserved.
    const run = throttled(path, sp).then(
      ({ body }) => {
        if (cacheTtlMs > 0) cache.set(key, { at: Date.now(), body });
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
    async json(path, sp) {
      const body = await fetchBody(path, sp);
      try {
        return JSON.parse(body);
      } catch (e) {
        throw new ApiError(`${path} did not return JSON`, { cause: e });
      }
    },
    text: (path, sp) => fetchBody(path, sp),
    async bytes(path, sp) {
      // Binary bodies skip the text CACHE — .torrent files are large and fetched once
      // each — but must still go through the THROTTLE. A download is a tracker request
      // like any other, and letting it bypass rate limiting would defeat the point of
      // having the throttle at all.
      return throttledBytes(path, sp);
    },
  };
}
