// Regenerates src/main/providers/cvoe/settlements.data.json from the Chernivtsioblenergo search pages (UTF-8 HTML).
// Live only, read-only: GET https://oblenergo.cv.ua/shutdowns-search/{N}/ for N = 2..12 (about 1.3 s apart), reading the
// <s> settlement of every row of #obl_tbl. District 1 is the city (no settlement column) and is added by hand.
// Usage: node scripts/gen-cvoe-settlements.mjs
import { writeFileSync } from 'node:fs';

const URL_OF = (n) => `https://oblenergo.cv.ua/shutdowns-search/${n}/`;
const OUT = new URL('../src/main/providers/cvoe/settlements.data.json', import.meta.url);
const GAP_MS = 1300;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// COPY of nameKey in src/main/providers/names.ts (same Latin look-alike table, apostrophe fold, single spaces, lower case).
// Keep the two in step: if names.ts changes, change this too.
const LOOK_ALIKES = {
  a: 'а', c: 'с', e: 'е', i: 'і', o: 'о', p: 'р', x: 'х', y: 'у',
  A: 'А', B: 'В', C: 'С', E: 'Е', H: 'Н', I: 'І', K: 'К', M: 'М', O: 'О', P: 'Р', T: 'Т', X: 'Х', Y: 'У',
};
const LATIN = /[aceiopxyABCEHIKMOPTXY]/g;
const APOSTROPHES = /['ʼ’]/g;
const nameKey = (s) => s.trim().replace(LATIN, (ch) => LOOK_ALIKES[ch])
  .replace(/\s+/g, ' ').replace(APOSTROPHES, '’').toLowerCase();

function decodeEntities(s) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(amp|lt|gt|quot|apos|nbsp));/gi, (m, d, h, n) => {
    if (n) return named[n.toLowerCase()];
    const cp = d ? Number(d) : parseInt(h, 16);
    return cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
  });
}

async function page(n) {
  const res = await fetch(URL_OF(n));
  const bytes = new Uint8Array(await res.arrayBuffer());
  const html = new TextDecoder('utf-8').decode(bytes);
  if (!res.ok) {
    const title = /<title>([^<]*)/i.exec(html)?.[1]?.trim();
    throw new Error(`district ${n}: GET -> ${res.status}${title ? ` (title: ${title})` : ''}`);
  }
  return { html, bytes: bytes.length };
}

// The <s> texts of the rows after #obl_tbl, in page order.
function settlementsOf(n, html) {
  const at = html.search(/<div\s+id="obl_tbl"/);
  if (at < 0) throw new Error(`district ${n}: no #obl_tbl`);
  const names = [];
  for (const m of html.slice(at).matchAll(/<div><s>([\s\S]*?)<\/s>/g)) {
    names.push(decodeEntities(m[1]).replace(/\s+/g, ' ').trim());
  }
  if (names.length === 0) throw new Error(`district ${n}: no rows`);
  return names;
}

const out = [];
const stats = [];
let total = 0;
for (let n = 2; n <= 12; n++) {
  if (n > 2) await sleep(GAP_MS);
  const { html, bytes } = await page(n);
  const names = settlementsOf(n, html);
  const groups = new Map(); // key -> Map(spelling -> count), first-seen order
  for (const name of names) {
    if (!name) throw new Error(`district ${n}: empty settlement name`);
    const k = nameKey(name);
    if (!groups.has(k)) groups.set(k, new Map());
    const spell = groups.get(k);
    spell.set(name, (spell.get(name) ?? 0) + 1);
  }
  const seen = new Set();
  for (const [k, spell] of groups) {
    if (seen.has(k)) throw new Error(`district ${n}: repeated key`);
    seen.add(k);
    let best, bestCount = 0;
    for (const [name, c] of spell) if (c > bestCount) { best = name; bestCount = c; } // ties: first seen
    out.push({ district: n, name: best });
  }
  stats.push({ n, status: 200, bytes, rows: names.length, settlements: groups.size });
  total += names.length;
}
out.push({ district: 1, name: 'м. Чернівці' });

if (out.length < 400 || out.length > 650) throw new Error(`unexpected total ${out.length}`);
out.sort((a, b) => a.district - b.district);
writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
for (const s of stats) console.log(`district ${s.n}: ${s.status}, ${s.bytes} bytes, ${s.rows} rows, ${s.settlements} settlements`);
console.log(`total: ${total} rows, ${out.length} entries (incl. the city)`);
