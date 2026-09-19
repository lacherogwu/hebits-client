import { ApiError } from './errors';
import type { RawGroup, RawTorrent } from './schemas';

/** One torrent, with its group's context folded in. This is the package's central type
 *  and the only shape consumers see. */
export interface HebitsTorrent {
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

export function imdbFromCatalogue(url: string | undefined): string | undefined {
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
function zoneOffsetMs(at: Date, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p = Object.fromEntries(fmt.formatToParts(at).map((x) => [x.type, x.value])) as Record<string, string>;
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
  return asUtc - at.getTime();
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
export function parseHebitsTime(s: string): Date {
  const naive = Date.parse(`${s.replace(' ', 'T')}Z`);
  if (Number.isNaN(naive)) throw new ApiError(`unparseable timestamp from Hebits: ${JSON.stringify(s)}`);
  const o1 = zoneOffsetMs(new Date(naive), 'Asia/Jerusalem');
  const o2 = zoneOffsetMs(new Date(naive - o1), 'Asia/Jerusalem');
  return new Date(naive - o2);
}

type Flags = Pick<
  RawTorrent,
  'isFreeleech' | 'isHalfFreeleech' | 'isQuarterLeech' | 'isNeutralLeech' | 'isPersonalFreeleech' | 'isUploadX2' | 'isUploadX3'
>;

/** Collapse the tracker's seven boolean flags into the two numbers consumers reason
 *  about, so nobody has to remember that isQuarterLeech means 0.25.
 *
 *  Ordering is deliberate: freeleech beats half- and quarter-leech, and between those
 *  two, the cheaper one wins over a torrent somehow flagged both (quarter overrides
 *  half). Neutral overrides everything else — it means neither side counts, regardless
 *  of what else is set. */
export function factorsFor(f: Flags): { downloadFactor: number; uploadFactor: number } {
  let downloadFactor = 1;
  if (f.isHalfFreeleech) downloadFactor = 0.5;
  if (f.isQuarterLeech) downloadFactor = 0.25;
  if (f.isFreeleech || f.isPersonalFreeleech) downloadFactor = 0;

  let uploadFactor = 1;
  if (f.isUploadX2) uploadFactor = 2;
  if (f.isUploadX3) uploadFactor = 3;

  if (f.isNeutralLeech) return { downloadFactor: 0, uploadFactor: 0 };
  return { downloadFactor, uploadFactor };
}

export function flattenGroups(groups: RawGroup[]): HebitsTorrent[] {
  const out: HebitsTorrent[] = [];
  for (const g of groups) {
    const imdb = imdbFromCatalogue(g.catalogue);
    for (const t of g.torrents) {
      out.push({
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
        hasSnatched: t.hasSnatched,
      });
    }
  }
  return out;
}
