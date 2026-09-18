#!/usr/bin/env node
// Strips account-identifying data from recorded fixtures. The browse responses describe
// public torrent listings and need only the account id removed; the index response is
// almost entirely personal and is replaced with plausible constants.
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';

const RAW = '/tmp/fixtures-raw';
const OUT = new URL('../test/fixtures/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const FAKE_ID = 1234;

for (const file of readdirSync(RAW).filter((f) => f.endsWith('.json'))) {
  const j = JSON.parse(readFileSync(`${RAW}/${file}`, 'utf8'));
  if (file === 'index.json') {
    // Replace every personal figure with a fixed, obviously-synthetic one.
    j.response.id = FAKE_ID;
    j.response.username = 'example';
    j.response.userstats = {
      uploaded: 25_000_000_000,
      downloaded: 20_000_000_000,
      ratio: 1.25,
      requiredratio: 0.4375,
      class: 'Heb User',
    };
    delete j.response.authkey;
    delete j.response.passkey;
    delete j.response.notifications;
  }
  // Browse/search responses are otherwise-public torrent listings, but each group/torrent
  // also carries this account's personal interaction with it (has it been bookmarked or
  // snatched, is it personally freeleeched) — that's real behavioral data about the owner's
  // account, not something a public repo should ship. Normalize it to a fixed, non-identifying
  // value; it's per-viewer state anyway, not something a client library's tests should assert on.
  for (const group of j.response?.results ?? []) {
    if ('bookmarked' in group) group.bookmarked = false;
    for (const torrent of group.torrents ?? []) {
      if ('hasSnatched' in torrent) torrent.hasSnatched = false;
      if ('isPersonalFreeleech' in torrent) torrent.isPersonalFreeleech = false;
    }
  }
  writeFileSync(`${OUT}${file}`, JSON.stringify(j, null, 2) + '\n');
}

// The HTML page: keep only the daily-downloads widget the scraper needs, as its real
// markup — not a hand-cleaned string. On this page the label and the counter live in
// separate nested elements (<li id="comm_daily_downloads">label<span>used/limit (pct%)
// </span></li>); a window that stops at the first tag boundary keeps the label and loses
// the numbers, which is exactly the bug this script used to have. Cut the whole element
// instead. If the page no longer has that id, fall back to a wide character window
// around the Hebrew label so there's still something to inspect and re-cut by hand.
const html = readFileSync(`${RAW}/user.html`, 'utf8');
const startTag = '<li id="comm_daily_downloads">';
const start = html.indexOf(startTag);
let windowHtml;
if (start !== -1) {
  const end = html.indexOf('</li>', start) + '</li>'.length;
  windowHtml = html.slice(start, end);
} else {
  const needleIdx = html.indexOf('הורדות יומיות:');
  if (needleIdx === -1) throw new Error('daily-downloads line not found — the page changed');
  windowHtml = html.slice(Math.max(0, needleIdx - 200), needleIdx + 400);
}
const wrapped = `<html><body><ul>${windowHtml}</ul></body></html>\n`;

// Assert it actually parses before writing it out — this mirrors parseDailyDownloads
// in src/scrape.ts (tag-strip, then match) and must be kept in sync with it.
const stripped = wrapped.replace(/<[^>]+>/g, ' ');
const parsed = stripped.match(/הורדות יומיות:\s*(\d+)\s*\/\s*(\d+)/);
if (!parsed || !(Number(parsed[1]) <= Number(parsed[2])) || !(Number(parsed[2]) > 0)) {
  throw new Error('windowed HTML does not parse to two sane numbers — widen the window and rerun on /tmp/fixtures-raw/user.html (do not re-fetch)');
}

writeFileSync(`${OUT}user-daily.html`, wrapped);
console.log('scrubbed to', OUT);
