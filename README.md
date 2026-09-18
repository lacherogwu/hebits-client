# hebits-client

A TypeScript client for [Hebits](https://hebits.net)'s JSON API — a private, invite-only
Gazelle-based BitTorrent tracker. It wraps `ajax.php`, the browse/search endpoint, account
stats, the daily download counter, and `.torrent` downloads, and validates every response
with [zod](https://zod.dev) so a change on the tracker's side surfaces as a typed error
instead of silent `undefined`.

## Before you start: you need a session cookie, not a password

Hebits has no API key and no username/password login you can automate: the login form is
behind a captcha. The only way to get a valid session is to log in with a real browser and
copy the session cookie out of it (DevTools → Application/Storage → Cookies, or your
browser's cookie export). Pass that cookie string to the client:

```ts
new Hebits({ cookie: 'session=abcdef...' });
```

The cookie eventually expires or gets invalidated server-side. When that happens, every
call throws `LoginExpiredError` — see [Errors](#errors) below. There is no way to refresh
it from inside this package; you have to log in again in a browser and supply a new one.

## Install

```sh
npm install hebits-client
```

Requires Node.js 22+. The package ships as ESM only (no CommonJS build) with bundled
TypeScript types.

## Quick example

```ts
import { Hebits, LoginExpiredError, NotATorrentError } from 'hebits-client';

const hebits = new Hebits({ cookie: process.env.HEBITS_COOKIE! });

const account = await hebits.stats();
console.log(`${account.userClass}, ratio ${account.ratio}`);

const results = await hebits.browse({ imdb: 'tt0944947', season: 3, freeleechOnly: true });
for (const torrent of results) {
  console.log(torrent.name, torrent.size, torrent.seeders, torrent.downloadFactor);
}

try {
  const bytes = await hebits.downloadTorrent(results[0]!.id);
  // write `bytes` (a Uint8Array) to a .torrent file, or hand it to your client
} catch (e) {
  if (e instanceof NotATorrentError) {
    // Hebits served an HTML refusal page instead of a torrent file
  }
  if (e instanceof LoginExpiredError) {
    // the cookie is dead — go get a new one from the browser
  }
  throw e;
}
```

## API

### `new Hebits(options)`

| option        | type                                  | default                    |
| ------------- | ------------------------------------- | --------------------------- |
| `cookie`      | `string`                               | required                    |
| `baseUrl`     | `string`                               | `https://hebits.net`        |
| `userAgent`   | `string`                               | `hebits-client/<version>`   |
| `rateLimit`   | `{ limit: number; interval: number }`  | `{ limit: 1, interval: 2000 }` |
| `cacheTtlMs`  | `number`                               | `600000` (10 minutes); `0` disables |
| `cacheMaxEntries` | `number`                           | `200` — an LRU cap on how many distinct query keys the response cache holds at once |
| `retry`       | `number`                               | `2`                          |
| `timeoutMs`   | `number`                               | `30000`                     |

`userAgent` exists for the rare case you need a different string; the default is honest on
purpose (see [Rate limiting and identification](#rate-limiting-and-identification)), and
you shouldn't change it to make requests look like they came from a browser.

### `hebits.stats(): Promise<AccountStats>`

Calls `ajax.php?action=index`. Returns:

```ts
interface AccountStats {
  userId: number;
  uploaded: number;
  downloaded: number;
  ratio: number;
  requiredRatio: number;
  userClass: string;
}
```

### `hebits.dailyDownloads(userId?: number): Promise<{ used: number; limit: number }>`

Reads the per-day download counter off the user's profile page (`user.php?id=N`). If you
don't pass a `userId`, it resolves one for you by calling `stats()` first, so the common
case is just `await hebits.dailyDownloads()`. This call always bypasses the response
cache — a stale counter could let you exceed the tracker's daily allowance.

### `hebits.checkLogin(): Promise<void>`

Fetches the front page and checks for a logout link. Resolves silently if the cookie is
still valid; throws `LoginExpiredError` if not. Useful as a cheap health check before a
batch of other calls. This call always bypasses the response cache, so it never reports a
dead cookie as valid just because a cached page is still within its TTL.

### `hebits.browse(options?: BrowseOptions): Promise<HebitsTorrent[]>`

Calls `ajax.php?action=browse` and flattens the tracker's group/torrent nesting into a
single array of `HebitsTorrent` (see below) — one entry per torrent, not per release
group.

```ts
interface BrowseOptions {
  query?: string;          // free-text search; an IMDb id works here too
  imdb?: string;            // convenience: sets `query` to this IMDb id
  season?: number;          // appended to the query — Gazelle has no season parameter
  freeleechOnly?: boolean;
  categories?: number[];    // 1 Movies, 2 TV, 8 Movie packs — see the tracker's own category list
  orderBy?: 'time' | 'size' | 'seeders' | 'snatches';
  orderWay?: 'asc' | 'desc';
  limit?: number;           // caps the flattened array; the API itself pages at 50 groups
}
```

### `hebits.search(options: BrowseOptions): Promise<HebitsTorrent[]>`

Same endpoint as `browse`, kept as a separate method because call sites read better as
"search" when there's a concrete query. Unlike `browse`, `options` is required here.

### `hebits.downloadTorrent(id: number): Promise<Uint8Array>`

Downloads the `.torrent` file for a torrent id. Hebits serves an HTML page instead of a
torrent file when it refuses a download (e.g. insufficient ratio, wrong class); this
method checks the first byte for bencode's leading `d` and throws `NotATorrentError` with
a snippet of the refusal page if the check fails, rather than handing you an HTML blob
that looks like a file.

## The `HebitsTorrent` shape

Every torrent `browse`/`search` returns has this shape — the group it belongs to (film or
show) is folded into each torrent, so you never deal with the tracker's nested
group/torrent structure directly:

```ts
interface HebitsTorrent {
  id: number;
  groupId: number;
  name: string;
  groupName: string;
  categoryId: number;
  imdb?: string;
  cover?: string;
  tags: string[];
  size: number;
  fileCount: number;
  seeders: number;
  leechers: number;
  snatches: number;
  uploadedAt: Date;           // corrected to real UTC — see note below
  resolution?: string;
  codec?: string;
  audio?: string;
  container?: string;
  downloadFactor: number;     // 1 = full cost, 0.5 = half, 0.25 = quarter, 0 = free/neutral
  uploadFactor: number;       // 1 = normal, 2 / 3 = upload bonus, 0 = neutral
  canUseToken: boolean;
  hasSnatched: boolean;
}
```

`uploadedAt` is computed from the tracker's unzoned local timestamp, corrected for
Israel's actual DST offset on that date (not a fixed offset), so filtering on "uploaded in
the last N hours" is correct year-round.

`downloadFactor` and `uploadFactor` collapse the tracker's seven separate freeleech/upload
boolean flags into two numbers: freeleech beats half- and quarter-leech, and a
neutral-leech flag overrides everything else to `0`/`0`.

## Responses are validated, not trusted

> Responses are validated with zod at the boundary. If Hebits changes its API, you get a
> clear `ApiError` naming the field rather than `undefined` propagating into your own
> logic.

## Errors

All errors extend `HebitsError` (itself an `Error`), so you can catch that base class or
branch on the specific subclass:

| class                | when it fires |
| --------------------- | ------------- |
| `LoginExpiredError`   | The response is a redirect to `login.php`, or a login form was served with a 200 — either way, the cookie is dead. This applies uniformly to every call this client makes, including `downloadTorrent`: a dead cookie on the download endpoint raises this too, not a generic error. Never retried automatically: retrying a dead cookie just hammers the tracker for no gain. |
| `RateLimitedError`    | The tracker answered with HTTP 429 — on any endpoint, including downloads. |
| `ApiError`            | Any other non-success HTTP status, a non-JSON body where JSON was expected, or a JSON body that fails the zod schema (the tracker's API shape changed). The message names the offending field(s). |
| `NotATorrentError`    | `downloadTorrent` got a body that isn't bencode and isn't a login page either — Hebits served some other HTML refusal instead (e.g. insufficient ratio, wrong class). |

## Rate limiting and identification

This client is deliberately slow and honest, not fast and stealthy:

- **One request in flight at a time**, throttled to roughly **one request every two
  seconds** by default (`rateLimit: { limit: 1, interval: 2000 }`). Nothing this package
  does is latency-sensitive. This is a single shared throttle across every call this
  client makes — `browse`/`stats`/etc. AND `downloadTorrent` AND each retry attempt of
  any of them — so browsing and downloading interleaving, or a burst of retried 5xxs,
  never doubles the real request rate.
- **Responses are cached for 10 minutes** by default (`cacheTtlMs`), capped at 200
  distinct query keys by default (`cacheMaxEntries`, an LRU bound), so repeating the same
  `browse`/`stats`/etc. call within that window returns the cached body instead of hitting
  the tracker again. `checkLogin` and `dailyDownloads` always bypass this cache, since a
  stale answer from either is actively wrong to act on.
- **Concurrent identical requests are collapsed into one.** If two calls for the exact
  same path and parameters overlap in flight, the second one just awaits the first's
  in-flight promise instead of firing its own request.
- **Requests identify themselves honestly.** The default User-Agent is
  `hebits-client/<version>` — this client does not pretend to be a browser. A tracker
  operator should be able to see a scripted client for what it is and rate-limit it
  fairly, rather than have it blend into ordinary browser traffic.

If your integration needs results faster than this, that's a sign to raise it with the
tracker rather than to turn the throttle up.

## What this package deliberately does not do

- It never spends freeleech tokens on your behalf — nothing in this client calls a
  token-spending action; that decision stays with you.
- It never decides what's worth downloading — `browse`/`search` hand you data, you choose
  what to call `downloadTorrent` with.
- It does not store your cookie anywhere. It's held in memory for the lifetime of the
  `Hebits` instance and sent as a request header; persisting it (env var, secrets
  manager, wherever) is your responsibility.

## License

MIT
