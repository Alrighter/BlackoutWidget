// Regenerates src/main/providers/ztoe/settlements.data.json from the operator's address form (windows-1251 HTML).
// Read-only: GET the page for the rem_id list, then POST rem_id=N for each REM, one second apart.
// Falls back to the saved 2026-10-20 research capture when the site cannot be reached (and says so on stdout).
// Usage: node scripts/gen-ztoe-settlements.mjs
import { readFileSync, writeFileSync } from 'node:fs';

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

async function request(body) {
  const res = await fetch(PAGE, body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body,
  });
  if (!res.ok) throw new Error(`${body === undefined ? 'GET' : 'POST'} -> ${res.status}`);
  return cp1251.decode(await res.arrayBuffer());
}

async function live() {
  const rems = options(await request(), 'rem_id');
  if (rems.length !== 19) throw new Error(`expected 19 REMs, got ${rems.length}`);
  const rows = [];
  for (const rem of rems) {
    await sleep(1000);
    const list = options(await request(new URLSearchParams({ rem_id: String(rem.id) }).toString()), 'naspunkt_id');
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

let rows;
let source = 'live';
try {
  rows = await live();
} catch (e) {
  source = `fallback (site unreachable: ${e.message})`;
  rows = fallback().rows;
}

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
