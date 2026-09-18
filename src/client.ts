import { ApiError, LoginExpiredError, NotATorrentError } from './errors';
import { flattenGroups, type HebitsTorrent } from './normalise';
import { browseResponseSchema, indexResponseSchema, parseOrThrow } from './schemas';
import { isLoggedIn, parseDailyDownloads } from './scrape';
import { createTransport, type Transport, type TransportOptions } from './transport';

export interface AccountStats {
  userId: number;
  uploaded: number;
  downloaded: number;
  ratio: number;
  requiredRatio: number;
  userClass: string;
}

export interface BrowseOptions {
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

export type HebitsOptions = TransportOptions;

export class Hebits {
  readonly #transport: Transport;
  #userId: number | undefined;

  constructor(options: HebitsOptions) {
    this.#transport = createTransport(options);
  }

  async stats(): Promise<AccountStats> {
    const raw = await this.#transport.json('ajax.php', { action: 'index' });
    const { response } = parseOrThrow(indexResponseSchema, raw, 'ajax.php?action=index');
    this.#userId = response.id;
    const u = response.userstats;
    return {
      userId: response.id,
      uploaded: u.uploaded,
      downloaded: u.downloaded,
      ratio: u.ratio,
      requiredRatio: u.requiredratio,
      userClass: u.class,
    };
  }

  /** The endpoint is user.php?id=N, so an id is needed. Resolves one via stats() when
   *  not supplied, so the common call takes no arguments. */
  async dailyDownloads(userId?: number): Promise<{ used: number; limit: number }> {
    const id = userId ?? this.#userId ?? (await this.stats()).userId;
    // Freshness-critical: a stale count could let a caller exceed the tracker's daily
    // download allowance, so this always reads through to the tracker.
    const html = await this.#transport.text('user.php', { id }, { bypassCache: true });
    const parsed = parseDailyDownloads(html);
    if (!parsed) throw new ApiError('could not find the daily download counter on the profile page');
    return parsed;
  }

  async checkLogin(): Promise<void> {
    // Freshness-critical: a cached page could report a dead cookie as valid for up to
    // `cacheTtlMs`, defeating the point of a health check.
    const html = await this.#transport.text('', undefined, { bypassCache: true });
    if (!isLoggedIn(html)) throw new LoginExpiredError('no logout link on the front page — the cookie has expired');
  }

  async browse(options: BrowseOptions = {}): Promise<HebitsTorrent[]> {
    const sp: Record<string, string | number> = { action: 'browse', group_results: 0 };
    const terms = [options.imdb ?? options.query, options.season ? `S${String(options.season).padStart(2, '0')}` : undefined]
      .filter(Boolean)
      .join(' ');
    if (terms) sp['searchstr'] = terms;
    if (options.freeleechOnly) sp['freetorrent'] = 1;
    if (options.orderBy) sp['order_by'] = options.orderBy;
    if (options.orderWay) sp['order_way'] = options.orderWay;
    for (const c of options.categories ?? []) sp[`filter_cat[${c}]`] = 1;

    const raw = await this.#transport.json('ajax.php', sp);
    const parsed = parseOrThrow(browseResponseSchema, raw, 'ajax.php?action=browse');
    const flat = flattenGroups(parsed.response.results);
    return options.limit === undefined ? flat : flat.slice(0, options.limit);
  }

  /** The same endpoint as browse; separate because the call sites read differently. */
  search(options: BrowseOptions): Promise<HebitsTorrent[]> {
    return this.browse(options);
  }

  /** Hebits serves an HTML page when it refuses a download, so validate before returning. */
  async downloadTorrent(id: number): Promise<Uint8Array> {
    const bytes = await this.#transport.bytes('torrents.php', { action: 'download', id });
    if (bytes[0] !== 0x64 /* 'd' */) {
      const head = new TextDecoder().decode(bytes.slice(0, 200)).replace(/\s+/g, ' ');
      throw new NotATorrentError(`Hebits refused the download for torrent ${id}: ${head}`);
    }
    return bytes;
  }
}
