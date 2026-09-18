# Fixtures

These are real Hebits API responses, recorded on 2026-09-18 against the live tracker.

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
- `user-daily.html` — a single line extracted from the account's `user.php` page (the
  daily-downloads counter the scraper needs). The rest of that page is personal and was
  discarded.

`scripts/record-fixtures.mjs` (run on the machine holding the tracker cookie) and
`scripts/scrub-fixtures.mjs` regenerate these from scratch if the API shape changes.
