import { z } from "zod";
import ky, { HTTPError } from "ky";
import pThrottle from "p-throttle";
//#region src/errors.ts
/** Base for everything this package throws. Consumers branch on the subclass. */
var HebitsError = class extends Error {
	constructor(message, options) {
		super(message, options);
		this.name = new.target.name;
	}
};
/** The cookie is dead or was redirected to the login page. NEVER retried: retrying a
*  dead cookie just hammers the tracker. The operator must paste a fresh one. */
var LoginExpiredError = class extends HebitsError {};
/** The tracker asked us to slow down. */
var RateLimitedError = class extends HebitsError {};
/** The API answered, but not in a shape we accept: a non-success status, or a response
*  that failed schema validation. A schema failure here means the tracker changed. */
var ApiError = class extends HebitsError {};
/** A .torrent download returned something that is not bencode — Hebits serves an HTML
*  page when it refuses a download. */
var NotATorrentError = class extends HebitsError {};
//#endregion
//#region src/normalise.ts
function imdbFromCatalogue(url) {
	return url?.match(/\b(tt\d+)\b/)?.[1];
}
/** The API returns an unzoned local timestamp. Israel observes DST, so a fixed +02:00
*  offset is wrong for half the year — Jackett hardcodes it and is an hour out each
*  summer.
*
*  Resolve the real offset with Intl.formatToParts. Do NOT use the
*  `new Date(d.toLocaleString('en-US', {timeZone}))` trick: it is correct only when the
*  host machine runs in UTC, because the re-parse interprets the formatted string in the
*  MACHINE's zone. Measured: on a host in Asia/Jerusalem it is 2h out in winter and 3h
*  out in summer; in America/New_York, 5h out. That would silently corrupt any caller
*  filtering on "uploaded in the last N hours". */
function zoneOffsetMs(at, timeZone) {
	const fmt = new Intl.DateTimeFormat("en-US", {
		timeZone,
		hour12: false,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit"
	});
	const p = Object.fromEntries(fmt.formatToParts(at).map((x) => [x.type, x.value]));
	return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second)) - at.getTime();
}
/** Two-pass offset resolution. A single sample at the naive-as-UTC instant is wrong near
*  a DST transition, because the offset it reads is the one in force AT THAT INSTANT,
*  not the one in force at the wall-clock time the string actually names. Sampling a
*  second time at `naive - o1` — i.e. at our first guess of the real UTC instant —
*  converges on the right offset on both sides of a transition.
*
*  Two wall-clock windows are genuinely unrecoverable from an unzoned string alone, and
*  two-pass resolves them the same way every other DST-aware parser does rather than
*  producing garbage:
*   - Spring forward (e.g. 03-27 02:00-02:59 in 2026): these wall times never occur.
*     Two-pass maps them forward into 03:xx IDT — the "compatible" disambiguation
*     `Temporal` also uses.
*   - Fall back (e.g. 10-25 01:00-01:59 in 2026): these wall times occur twice. Two-pass
*     resolves to the LATER (IST) reading, so a torrent uploaded in the first occurrence
*     of that hour can read up to an hour newer than it really is. Not recoverable — the
*     information needed to pick the earlier one is not in the data. */
function parseHebitsTime(s) {
	const naive = Date.parse(`${s.replace(" ", "T")}Z`);
	if (Number.isNaN(naive)) throw new ApiError(`unparseable timestamp from Hebits: ${JSON.stringify(s)}`);
	const o1 = zoneOffsetMs(new Date(naive), "Asia/Jerusalem");
	const o2 = zoneOffsetMs(new Date(naive - o1), "Asia/Jerusalem");
	return new Date(naive - o2);
}
/** Collapse the tracker's seven boolean flags into the two numbers consumers reason
*  about, so nobody has to remember that isQuarterLeech means 0.25.
*
*  Ordering is deliberate: freeleech beats half- and quarter-leech, and between those
*  two, the cheaper one wins over a torrent somehow flagged both (quarter overrides
*  half). Neutral overrides everything else — it means neither side counts, regardless
*  of what else is set. */
function factorsFor(f) {
	let downloadFactor = 1;
	if (f.isHalfFreeleech) downloadFactor = .5;
	if (f.isQuarterLeech) downloadFactor = .25;
	if (f.isFreeleech || f.isPersonalFreeleech) downloadFactor = 0;
	let uploadFactor = 1;
	if (f.isUploadX2) uploadFactor = 2;
	if (f.isUploadX3) uploadFactor = 3;
	if (f.isNeutralLeech) return {
		downloadFactor: 0,
		uploadFactor: 0
	};
	return {
		downloadFactor,
		uploadFactor
	};
}
function flattenGroups(groups) {
	const out = [];
	for (const g of groups) {
		const imdb = imdbFromCatalogue(g.catalogue);
		for (const t of g.torrents) out.push({
			id: t.torrentId,
			groupId: g.groupId,
			name: t.release ?? g.groupName,
			groupName: g.groupName,
			categoryId: g.categoryID,
			imdb,
			cover: g.cover,
			tags: g.tags ?? [],
			size: t.size,
			fileCount: t.fileCount,
			seeders: t.seeders,
			leechers: t.leechers,
			snatches: t.snatches,
			uploadedAt: parseHebitsTime(t.time),
			resolution: t.resolution,
			codec: t.codec,
			audio: t.audio,
			container: t.container,
			...factorsFor(t),
			canUseToken: t.canUseToken,
			hasSnatched: t.hasSnatched
		});
	}
	return out;
}
//#endregion
//#region src/schemas.ts
/** A single torrent inside a group. Field types confirmed against the live API on
*  2026-09-18: the is* flags really are booleans, and `time` really is an unzoned string.
*  `language` is confirmed against the fixtures to come back as JSON `null` (not omitted)
*  on almost every torrent, so it is nullable as well as optional. */
const rawTorrentSchema = z.object({
	torrentId: z.number(),
	release: z.string().optional(),
	container: z.string().optional(),
	codec: z.string().optional(),
	resolution: z.string().optional(),
	audio: z.string().optional(),
	subbing: z.string().optional(),
	language: z.string().nullable().optional(),
	fileCount: z.number(),
	time: z.string(),
	size: z.number(),
	snatches: z.number(),
	seeders: z.number(),
	leechers: z.number(),
	isFreeleech: z.boolean(),
	isHalfFreeleech: z.boolean(),
	isQuarterLeech: z.boolean(),
	isNeutralLeech: z.boolean(),
	isPersonalFreeleech: z.boolean(),
	isUploadX2: z.boolean(),
	isUploadX3: z.boolean(),
	canUseToken: z.boolean(),
	hasSnatched: z.boolean()
});
/** A release group: one film or show, holding several encodes. */
const rawGroupSchema = z.object({
	groupId: z.number(),
	groupName: z.string(),
	groupNameAlt: z.string().optional(),
	categoryID: z.number(),
	categoryName: z.string().optional(),
	cover: z.string().optional(),
	tags: z.array(z.string()).optional(),
	catalogue: z.string().optional(),
	groupYear: z.number().optional(),
	torrents: z.array(rawTorrentSchema)
});
const browseResponseSchema = z.object({
	status: z.literal("success"),
	response: z.object({ results: z.array(rawGroupSchema) })
});
const rawUserStatsSchema = z.object({
	uploaded: z.number(),
	downloaded: z.number(),
	ratio: z.number(),
	requiredratio: z.number(),
	class: z.string()
});
const indexResponseSchema = z.object({
	status: z.literal("success"),
	response: z.object({
		id: z.number(),
		username: z.string().optional(),
		userstats: rawUserStatsSchema
	})
});
/** Parse, or throw an ApiError that names the endpoint and the offending fields.
*  A failure here means the tracker changed its API — that is the signal this package
*  exists to give, in place of the community maintenance Jackett used to provide. */
function parseOrThrow(schema, data, endpoint) {
	const result = schema.safeParse(data);
	if (result.success) return result.data;
	throw new ApiError(`${endpoint} response did not match the expected shape — ${result.error.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
}
//#endregion
//#region src/scrape.ts
/** The profile page carries the daily download allowance as a Hebrew line:
*  "הורדות יומיות: 3 / 10". Strip tags first so markup between the numbers cannot
*  break the match. Returns null rather than guessing — a wrong limit here would let
*  a caller spend downloads it does not have. */
function parseDailyDownloads(html) {
	const m = html.replace(/<[^>]+>/g, " ").match(/הורדות יומיות:\s*(\d+)\s*\/\s*(\d+)/);
	if (!m) return null;
	return {
		used: Number(m[1]),
		limit: Number(m[2])
	};
}
/** A logged-in page carries a logout link with an auth token. This is the same test
*  Jackett's own indexer definition uses. */
function isLoggedIn(html) {
	return /logout\.php\?auth=/.test(html);
}
//#endregion
//#region src/transport.ts
const VERSION = "0.1.0";
const LOGIN_MARKERS = [/id=["']loginform["']/i, /action=["']login\.php/i];
const RETRYABLE_STATUS = /* @__PURE__ */ new Set([
	408,
	500,
	502,
	503,
	504
]);
const SNIFF_BYTES = 4096;
/** A redirect to login, or a login form served with 200, both mean the cookie is dead.
*  Matches the response URL's PATH only, not the full URL — a search for the literal
*  string "login.php" (`browse({ query: 'login.php' })`) must not trip this. */
function assertNotLoginPage(url, body) {
	if ((() => {
		try {
			return new URL(url).pathname;
		} catch {
			return url;
		}
	})().endsWith("login.php") || LOGIN_MARKERS.some((re) => re.test(body))) throw new LoginExpiredError("Hebits returned the login page — the cookie has expired");
}
/** Decode enough of a byte body to run the same login-page check text responses get.
*  A .torrent file never decodes into anything matching LOGIN_MARKERS. */
function sniff(body) {
	return typeof body === "string" ? body : new TextDecoder().decode(body.slice(0, SNIFF_BYTES));
}
function createTransport(opts) {
	const { cookie, baseUrl = "https://hebits.net", userAgent = `hebits-client/${VERSION}`, rateLimit = {
		limit: 1,
		interval: 2e3
	}, cacheTtlMs = 6e5, cacheMaxEntries = 200, retry = 2, timeoutMs = 3e4 } = opts;
	const client = ky.create({
		baseUrl,
		timeout: timeoutMs,
		redirect: "manual",
		retry: 0,
		headers: {
			"user-agent": userAgent,
			...typeof cookie === "string" ? { cookie } : {}
		},
		...typeof cookie === "function" ? { hooks: { beforeRequest: [({ request }) => {
			request.headers.set("cookie", cookie());
		}] } } : {}
	});
	const throttledAttempt = pThrottle(rateLimit)(async (path, sp, responseType) => {
		const res = await client.get(path, sp ? { searchParams: sp } : void 0);
		return {
			res,
			body: responseType === "text" ? await res.text() : new Uint8Array(await res.arrayBuffer())
		};
	});
	async function request(path, sp, responseType, retriesLeft = retry) {
		try {
			const { res, body } = await throttledAttempt(path, sp, responseType);
			assertNotLoginPage(res.url, sniff(body));
			return body;
		} catch (e) {
			if (e instanceof HTTPError) {
				const { status, headers } = e.response;
				if (status === 429) throw new RateLimitedError("Hebits asked us to slow down", { cause: e });
				if (status >= 300 && status < 400 && /login\.php/.test(headers.get("location") ?? "")) throw new LoginExpiredError("Hebits redirected to login — the cookie has expired", { cause: e });
				if (RETRYABLE_STATUS.has(status) && retriesLeft > 0) return request(path, sp, responseType, retriesLeft - 1);
				throw new ApiError(`Hebits returned HTTP ${status} for ${path}`, { cause: e });
			}
			throw e;
		}
	}
	const cache = /* @__PURE__ */ new Map();
	const pending = /* @__PURE__ */ new Map();
	function pruneCache() {
		if (cacheTtlMs > 0) {
			const now = Date.now();
			for (const [k, v] of cache) if (now - v.at >= cacheTtlMs) cache.delete(k);
		}
		while (cache.size > cacheMaxEntries) {
			const oldest = cache.keys().next().value;
			if (oldest === void 0) break;
			cache.delete(oldest);
		}
	}
	function cacheGet(key) {
		const hit = cache.get(key);
		if (!hit || Date.now() - hit.at >= cacheTtlMs) return void 0;
		cache.delete(key);
		cache.set(key, hit);
		return hit.body;
	}
	function cacheSet(key, body) {
		cache.delete(key);
		cache.set(key, {
			at: Date.now(),
			body
		});
		pruneCache();
	}
	async function fetchBody(path, sp, opts) {
		const key = `${path}?${new URLSearchParams(Object.entries(sp ?? {}).map(([k, v]) => [k, String(v)])).toString()}`;
		if (cacheTtlMs > 0 && !opts?.bypassCache) {
			const hit = cacheGet(key);
			if (hit !== void 0) return hit;
		}
		const inFlight = pending.get(key);
		if (inFlight) return inFlight;
		const run = request(path, sp, "text").then((body) => {
			if (cacheTtlMs > 0) cacheSet(key, body);
			pending.delete(key);
			return body;
		}, (err) => {
			pending.delete(key);
			throw err;
		});
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
			return request(path, sp, "bytes");
		}
	};
}
//#endregion
//#region src/client.ts
var Hebits = class {
	#transport;
	#userId;
	constructor(options) {
		this.#transport = createTransport(options);
	}
	async stats() {
		const raw = await this.#transport.json("ajax.php", { action: "index" });
		const { response } = parseOrThrow(indexResponseSchema, raw, "ajax.php?action=index");
		this.#userId = response.id;
		const u = response.userstats;
		return {
			userId: response.id,
			uploaded: u.uploaded,
			downloaded: u.downloaded,
			ratio: u.ratio,
			requiredRatio: u.requiredratio,
			userClass: u.class
		};
	}
	/** The endpoint is user.php?id=N, so an id is needed. Resolves one via stats() when
	*  not supplied, so the common call takes no arguments. */
	async dailyDownloads(userId) {
		const id = userId ?? this.#userId ?? (await this.stats()).userId;
		const parsed = parseDailyDownloads(await this.#transport.text("user.php", { id }, { bypassCache: true }));
		if (!parsed) throw new ApiError("could not find the daily download counter on the profile page");
		return parsed;
	}
	async checkLogin() {
		if (!isLoggedIn(await this.#transport.text("", void 0, { bypassCache: true }))) throw new LoginExpiredError("no logout link on the front page — the cookie has expired");
	}
	async browse(options = {}) {
		const sp = {
			action: "browse",
			group_results: 0
		};
		const terms = [options.imdb ?? options.query, options.season ? `S${String(options.season).padStart(2, "0")}` : void 0].filter(Boolean).join(" ");
		if (terms) sp.searchstr = terms;
		if (options.freeleechOnly) sp.freetorrent = 1;
		if (options.orderBy) sp.order_by = options.orderBy;
		if (options.orderWay) sp.order_way = options.orderWay;
		for (const c of options.categories ?? []) sp[`filter_cat[${c}]`] = 1;
		const raw = await this.#transport.json("ajax.php", sp);
		const flat = flattenGroups(parseOrThrow(browseResponseSchema, raw, "ajax.php?action=browse").response.results);
		return options.limit === void 0 ? flat : flat.slice(0, options.limit);
	}
	/** Hebits serves an HTML page when it refuses a download, so validate before returning. */
	async downloadTorrent(id) {
		const bytes = await this.#transport.bytes("torrents.php", {
			action: "download",
			id
		});
		if (bytes[0] !== 100) throw new NotATorrentError(`Hebits refused the download for torrent ${id}: ${new TextDecoder().decode(bytes.slice(0, 200)).replace(/\s+/g, " ")}`);
		return bytes;
	}
};
//#endregion
export { ApiError, Hebits, HebitsError, LoginExpiredError, NotATorrentError, RateLimitedError };

//# sourceMappingURL=index.js.map