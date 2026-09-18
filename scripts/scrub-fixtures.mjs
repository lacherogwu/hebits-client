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

// The HTML page: keep only the daily-downloads line the scraper needs.
const html = readFileSync(`${RAW}/user.html`, 'utf8');
const m = html.match(/[^<>]*הורדות יומיות:[^<>]*/);
if (!m) throw new Error('daily-downloads line not found — the page changed');
writeFileSync(`${OUT}user-daily.html`, `<html><body><span>${m[0].trim()}</span></body></html>\n`);
console.log('scrubbed to', OUT);
