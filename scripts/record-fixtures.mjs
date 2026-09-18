#!/usr/bin/env node
// Records Hebits API responses for use as test fixtures. Run on the machine that
// holds the cookie. One request per endpoint, spaced out; nothing is cached or retried.
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const OUT = '/tmp/fixtures-raw';
mkdirSync(OUT, { recursive: true });

const indexerConfig = process.env.HEBITS_INDEXER_CONFIG
  ?? `${process.env.HOME}/Library/Application Support/Jackett/Indexers/hebits.json`;
const cookie = JSON.parse(readFileSync(indexerConfig, 'utf8')).find((x) => x.id === 'cookie').value;

const get = async (path) => {
  const res = await fetch(`https://hebits.net/${path}`, {
    headers: { cookie, 'user-agent': 'hebits-client/0.1.0', accept: 'application/json' },
    redirect: 'manual',
  });
  return { status: res.status, body: await res.text() };
};

const jobs = [
  ['browse-freeleech', 'ajax.php?action=browse&freetorrent=1&group_results=0'],
  ['browse-latest', 'ajax.php?action=browse&group_results=0'],
  ['search-imdb', 'ajax.php?action=browse&searchstr=tt0944947&group_results=0'],
  ['index', 'ajax.php?action=index'],
];

for (const [name, path] of jobs) {
  const { status, body } = await get(path);
  writeFileSync(`${OUT}/${name}.json`, body);
  console.log(`${name}: HTTP ${status}, ${body.length} bytes`);
  await sleep(2000);
}

// The daily-downloads page is HTML, and needs the account id from index
const id = JSON.parse(readFileSync(`${OUT}/index.json`, 'utf8')).response.id;
const user = await get(`user.php?id=${id}`);
writeFileSync(`${OUT}/user.html`, user.body);
console.log(`user.html: HTTP ${user.status}, ${user.body.length} bytes`);
