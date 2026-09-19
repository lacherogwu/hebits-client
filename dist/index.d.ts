import { z } from "zod";
//#region src/normalise.d.ts
/** One torrent, with its group's context folded in. This is the package's central type
 *  and the only shape consumers see. */
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
  uploadedAt: Date;
  resolution?: string;
  codec?: string;
  audio?: string;
  container?: string;
  downloadFactor: number;
  uploadFactor: number;
  canUseToken: boolean;
  hasSnatched: boolean;
}
//#endregion
//#region src/transport.d.ts
interface TransportOptions {
  /** Session cookie for hebits.net. A string is sent as-is on every request — the usual
   *  case. Pass a function instead when the cookie can change while this client keeps
   *  running (an operator pastes a fresh one after the old one expired): it is called
   *  fresh before every request, so a new value takes effect on the very next call, with
   *  no restart and no code watching for rotation. Called synchronously — read a file or
   *  other cached value, don't do I/O inline. If it throws, the throw propagates to the
   *  caller of whichever call triggered it, same as any other broken input; an empty
   *  string is sent as-is, same as passing `cookie: ''` directly. */
  cookie: string | (() => string);
  baseUrl?: string;
  userAgent?: string;
  /** Default 1 request per 2s. That assumes background/batch work, where nothing is
   *  latency-sensitive — fine for something like an account builder. A consumer with a
   *  person waiting on the result (listing or streaming to a UI, say) should pass its
   *  own, tighter value; left at the default, requests serialise and a single screen
   *  can take many seconds to fill. Raising it is a decision to make with the tracker,
   *  not a free performance knob — a banned account is not recoverable. */
  rateLimit?: {
    limit: number;
    interval: number;
  };
  /** Default 10 minutes. Set 0 to disable. */
  cacheTtlMs?: number;
  /** Caps how many distinct query keys the response cache holds at once — a modest LRU
   *  bound, so a long-lived process issuing many distinct queries (e.g. one IMDb id per
   *  browse call) doesn't grow the cache without limit. Default 200. */
  cacheMaxEntries?: number;
  retry?: number;
  timeoutMs?: number;
}
//#endregion
//#region src/client.d.ts
interface AccountStats {
  userId: number;
  uploaded: number;
  downloaded: number;
  ratio: number;
  requiredRatio: number;
  userClass: string;
}
interface BrowseOptions {
  /** Free-text search. An IMDb id works here — it is what Jackett sends too. Ignored if
   *  `imdb` is also set — see `imdb` below. */
  query?: string;
  /** Convenience: sets `query` to this IMDb id. Takes precedence over `query`: passing
   *  both silently discards `query`. */
  imdb?: string;
  /** Appended to the query; Gazelle has no season parameter. */
  season?: number;
  freeleechOnly?: boolean;
  /** 1 Movies, 2 TV, 8 Movie packs — see the tracker's category list. */
  categories?: number[];
  orderBy?: 'time' | 'size' | 'seeders' | 'snatches';
  orderWay?: 'asc' | 'desc';
  /** Cap applied after flattening. The API itself pages at 50 groups. */
  limit?: number;
}
type HebitsOptions = TransportOptions;
export declare class Hebits {
  #private;
  constructor(options: HebitsOptions);
  stats(): Promise<AccountStats>;
  /** The endpoint is user.php?id=N, so an id is needed. Resolves one via stats() when
   *  not supplied, so the common call takes no arguments. */
  dailyDownloads(userId?: number): Promise<{
    used: number;
    limit: number;
  }>;
  checkLogin(): Promise<void>;
  browse(options?: BrowseOptions): Promise<HebitsTorrent[]>;
  /** Hebits serves an HTML page when it refuses a download, so validate before returning. */
  downloadTorrent(id: number): Promise<Uint8Array>;
}
//#endregion
//#region src/errors.d.ts
/** Base for everything this package throws. Consumers branch on the subclass. */
export declare class HebitsError extends Error {
  constructor(message: string, options?: {
    cause?: unknown;
  });
}
/** The cookie is dead or was redirected to the login page. NEVER retried: retrying a
 *  dead cookie just hammers the tracker. The operator must paste a fresh one. */
export declare class LoginExpiredError extends HebitsError {}
/** The tracker asked us to slow down. */
export declare class RateLimitedError extends HebitsError {}
/** The API answered, but not in a shape we accept: a non-success status, or a response
 *  that failed schema validation. A schema failure here means the tracker changed. */
export declare class ApiError extends HebitsError {}
/** A .torrent download returned something that is not bencode — Hebits serves an HTML
 *  page when it refuses a download. */
export declare class NotATorrentError extends HebitsError {}
//#endregion
export type { AccountStats, BrowseOptions, HebitsOptions, HebitsTorrent };
//# sourceMappingURL=index.d.ts.map