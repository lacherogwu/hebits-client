# Fixtures

These are real Hebits API responses, recorded on 2026-09-19 against the live tracker.

- `browse-freeleech.json`, `browse-latest.json`, `search-imdb.json` — `ajax.php?action=browse`
  responses. Torrent listings on a private tracker are visible to any logged-in member; the
  content here is public tracker data. Per-viewer personal-interaction flags on each
  group/torrent (`bookmarked`, `hasSnatched`, `isPersonalFreeleech`) have been normalized to
  `false`, since those reflect the recording account's real download history and aren't
  something a client library's tests should depend on.
- `index.json` — `ajax.php?action=index` response. Every account-identifying value
  (`username`, `id`, `userstats.{uploaded,downloaded,ratio,requiredratio,class}`) has been
  replaced with a fixed, obviously-synthetic value; `authkey`, `passkey`, and `notifications`
  have been removed entirely. None of these numbers are the account owner's real figures.
- `user-daily.html` — a small, self-contained element (`<li id="comm_daily_downloads">…</li>`)
  cut out of the account's `user.php` page: the label and the counter live in separate nested
  tags on the real page, so this keeps the real markup rather than a hand-cleaned string — the
  fixture needs that nesting to actually exercise the scraper's tag-stripping. Everything else
  on that page (ratio, upload/download totals in GiB, and other personal widgets) sits in a
  neighboring block and was excluded; only the daily-downloads widget is present.

`scripts/record-fixtures.mjs` (run on the machine holding the tracker cookie) and
`scripts/scrub-fixtures.mjs` regenerate these from scratch if the API shape changes.
