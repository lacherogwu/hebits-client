/** Base for everything this package throws. Consumers branch on the subclass. */
export class HebitsError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The cookie is dead or was redirected to the login page. NEVER retried: retrying a
 *  dead cookie just hammers the tracker. The operator must paste a fresh one. */
export class LoginExpiredError extends HebitsError {}

/** The tracker asked us to slow down. */
export class RateLimitedError extends HebitsError {}

/** The API answered, but not in a shape we accept: a non-success status, or a response
 *  that failed schema validation. A schema failure here means the tracker changed. */
export class ApiError extends HebitsError {}

/** A .torrent download returned something that is not bencode — Hebits serves an HTML
 *  page when it refuses a download. */
export class NotATorrentError extends HebitsError {}
