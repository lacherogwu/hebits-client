import { z } from 'zod';
import { ApiError } from './errors';

/** A single torrent inside a group. Field types confirmed against the live API on
 *  2026-09-18: the is* flags really are booleans, and `time` really is an unzoned string.
 *  `language` is confirmed against the fixtures to come back as JSON `null` (not omitted)
 *  on almost every torrent, so it is nullable as well as optional. */
export const rawTorrentSchema = z.object({
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
  hasSnatched: z.boolean(),
});

/** A release group: one film or show, holding several encodes. */
export const rawGroupSchema = z.object({
  groupId: z.number(),
  groupName: z.string(),
  groupNameAlt: z.string().optional(),
  categoryID: z.number(),
  categoryName: z.string().optional(),
  cover: z.string().optional(),
  tags: z.array(z.string()).optional(),
  catalogue: z.string().optional(),
  groupYear: z.number().optional(),
  torrents: z.array(rawTorrentSchema),
});

export const browseResponseSchema = z.object({
  status: z.literal('success'),
  response: z.object({ results: z.array(rawGroupSchema) }),
});

export const rawUserStatsSchema = z.object({
  uploaded: z.number(),
  downloaded: z.number(),
  ratio: z.number(),
  requiredratio: z.number(),
  class: z.string(),
});

export const indexResponseSchema = z.object({
  status: z.literal('success'),
  response: z.object({
    id: z.number(),
    username: z.string().optional(),
    userstats: rawUserStatsSchema,
  }),
});

export type RawTorrent = z.infer<typeof rawTorrentSchema>;
export type RawGroup = z.infer<typeof rawGroupSchema>;
export type RawUserStats = z.infer<typeof rawUserStatsSchema>;

/** Parse, or throw an ApiError that names the endpoint and the offending fields.
 *  A failure here means the tracker changed its API — that is the signal this package
 *  exists to give, in place of the community maintenance Jackett used to provide. */
export function parseOrThrow<T extends z.ZodTypeAny>(schema: T, data: unknown, endpoint: string): z.infer<T> {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const where = result.error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
  throw new ApiError(`${endpoint} response did not match the expected shape — ${where}`);
}
