/** The profile page carries the daily download allowance as a Hebrew line:
 *  "הורדות יומיות: 3 / 10". Strip tags first so markup between the numbers cannot
 *  break the match. Returns null rather than guessing — a wrong limit here would let
 *  a caller spend downloads it does not have. */
export function parseDailyDownloads(html: string): { used: number; limit: number } | null {
  const text = html.replace(/<[^>]+>/g, ' ');
  const m = text.match(/הורדות יומיות:\s*(\d+)\s*\/\s*(\d+)/);
  if (!m) return null;
  return { used: Number(m[1]), limit: Number(m[2]) };
}

/** A logged-in page carries a logout link with an auth token. This is the same test
 *  Jackett's own indexer definition uses. */
export function isLoggedIn(html: string): boolean {
  return /logout\.php\?auth=/.test(html);
}
