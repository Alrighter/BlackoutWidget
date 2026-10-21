// Regenerates src/main/providers/ztoe/settlements.data.json from the operator's address form (windows-1251 HTML).
// Read-only: GET the page for the rem_id list, then POST rem_id=N for each REM, one second apart.
// Falls back to the saved 2026-10-20 research capture only when the site cannot be reached, by a network error or an
// HTTP error status (and says so on stdout). An answer of another shape or count stops the run with its own reason.
// Usage: node scripts/gen-ztoe-settlements.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PAGE = 'https://www.ztoe.com.ua/unhooking-search.php';
const OUT = new URL('../src/main/providers/ztoe/settlements.data.json', import.meta.url);
const RAW = new URL('../docs/superpowers/research/2026-10-20-outage-sources-step2/zhytomyr-raw/settlements-by-rem-2026-10-20.json', import.meta.url);
const REM_PAGE = new URL('../tests/fixtures/ztoe/unhooking-search-2026-10-20-1728-live-cp1251.html', import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cp1251 = new TextDecoder('windows-1251');

function decodeEntities(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', nbsp: ' ' };
  return s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|nbsp));/gi, (m, d, h, n) => {
    if (n) return named[n.toLowerCase()];
    const cp = d ? Number(d) : parseInt(h, 16);
    return cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
  });
}

// The options of <select name="..."> without the placeholder (value 0); a missing or disabled select is an error.
function options(html, name) {
  const m = new RegExp(String.raw`<select\s+name="${name}"([^>]*)>([\s\S]*?)</select>`).exec(html);
  if (!m || /\bdisabled\b/.test(m[1])) throw new Error(`no usable select ${name}`);
  const out = [];
  for (const o of m[2].matchAll(/<option\s+value="(\d+)"[^>]*>([^<]*)/g)) {
    if (Number(o[1]) !== 0) out.push({ id: Number(o[1]), name: decodeEntities(o[2]).replace(/\s+/g, ' ').trim() });
  }
  return out;
}

/** The site could not be reached: a network error or an HTTP error status. Only this falls back to the saved capture. */
class Unreachable extends Error {}

async function request(fetchFn, body) {
  const method = body === undefined ? 'GET' : 'POST';
  let res;
  let bytes;
  try {
    res = await fetchFn(PAGE, body === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body,
    });
    // The body too: a connection dropped while it is read is the site unreachable.
    if (res.ok) bytes = await res.arrayBuffer();
  } catch (e) {
    throw new Unreachable(`${method}: ${e.message}`);
  }
  if (!res.ok) throw new Unreachable(`${method} -> ${res.status}`);
  return cp1251.decode(bytes);
}

async function live(fetchFn, pause) {
  const rems = options(await request(fetchFn), 'rem_id');
  if (rems.length !== 19) throw new Error(`expected 19 REMs, got ${rems.length}`);
  const rows = [];
  for (const rem of rems) {
    await pause(1000);
    const list = options(await request(fetchFn, new URLSearchParams({ rem_id: String(rem.id) }).toString()), 'naspunkt_id');
    for (const n of list) rows.push({ id: n.id, name: n.name, remId: rem.id, rem: rem.name });
  }
  return rows;
}

function fallback() {
  const rems = options(cp1251.decode(readFileSync(REM_PAGE)), 'rem_id');
  const byRem = JSON.parse(readFileSync(RAW, 'utf8')).byRem;
  const rows = [];
  for (const rem of rems) {
    for (const [id, label] of byRem[String(rem.id)] ?? []) {
      rows.push({ id: Number(id), name: decodeEntities(label).replace(/\s+/g, ' ').trim(), remId: rem.id, rem: rem.name });
    }
  }
  return { rows, remCount: rems.length };
}

/**
 * The settlements live, or from the saved capture when the site cannot be reached. Any other failure of the live run (an
 * answer of another shape or count) is thrown with its own reason. `fetch`, `sleep` and `fallback` are for the tests.
 */
export async function settlementRows({ fetch: fetchFn = fetch, sleep: pause = sleep, fallback: saved = fallback } = {}) {
  try {
    return { rows: await live(fetchFn, pause), source: 'live' };
  } catch (e) {
    if (!(e instanceof Unreachable)) throw e;
    return { rows: saved().rows, source: `fallback (site unreachable: ${e.message})` };
  }
}

async function main() {
  const { rows, source } = await settlementRows();

  // Check what we write.
  const perRem = new Map();
  for (const r of rows) perRem.set(r.remId, (perRem.get(r.remId) ?? 0) + 1);
  if (perRem.size !== 19) throw new Error(`expected settlements in 19 REMs, got ${perRem.size}`);
  if (new Set(rows.map((r) => r.id)).size !== rows.length) throw new Error('repeated settlement ids');
  if (rows.some((r) => !r.name || !r.rem)) throw new Error('empty name');
  if (rows.length < 1700 || rows.length > 1800) throw new Error(`unexpected total ${rows.length}`);

  rows.sort((a, b) => a.id - b.id);
  writeFileSync(OUT, JSON.stringify(rows, null, 1) + '\n');
  console.log(`${source}: ${perRem.size} REM, ${rows.length} settlements`);
}

// Only when run as a script: importing it (the tests do) neither fetches nor writes.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
