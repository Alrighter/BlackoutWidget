// Regenerates src/main/providers/cvoe/settlements.data.json from the Chernivtsioblenergo search pages (UTF-8 HTML).
// Live only, read-only: GET https://oblenergo.cv.ua/shutdowns-search/{N}/ for N = 2..12 (about 1.3 s apart), reading the
// <s> settlement of every row of #obl_tbl. District 1 is the city (no settlement column) and is added by hand.
// Each district's rows are grouped by settlementKey: one entry per settlement, shown as its spelling with the most rows.
// Usage: node scripts/gen-cvoe-settlements.mjs
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const URL_OF = (n) => `https://oblenergo.cv.ua/shutdowns-search/${n}/`;
const OUT = new URL('../src/main/providers/cvoe/settlements.data.json', import.meta.url);
const GAP_MS = 1300;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// COPY of nameKey and nameWords in src/main/providers/names.ts (the Latin look-alike table, the apostrophe fold, single
// spaces, lower case; the words split on anything but letters, digits and ’, without a number's ending).
// Keep them in step: if names.ts changes, change this too.
const LOOK_ALIKES = {
  a: 'а', c: 'с', e: 'е', i: 'і', o: 'о', p: 'р', x: 'х', y: 'у',
  A: 'А', B: 'В', C: 'С', E: 'Е', H: 'Н', I: 'І', K: 'К', M: 'М', O: 'О', P: 'Р', T: 'Т', X: 'Х', Y: 'У',
};
const LATIN = /[aceiopxyABCEHIKMOPTXY]/g;
const APOSTROPHES = /['ʼ’]/g;
const nameKey = (s) => s.trim().replace(LATIN, (ch) => LOOK_ALIKES[ch])
  .replace(/\s+/g, ' ').replace(APOSTROPHES, '’').toLowerCase();
const NUMBER_ENDINGS = new Set(['й', 'ий', 'а', 'я']);
function nameWords(s) {
  const tokens = nameKey(s).split(/[^\p{L}\p{N}’]+/u).filter((t) => t !== '');
  return tokens.filter((t, i) => !(i > 0 && /^\d+$/.test(tokens[i - 1]) && NUMBER_ENDINGS.has(t)));
}

// COPY of settlementKey in src/main/providers/cvoe/parse.ts, rule for rule: the leading type words (с, ще, село,
// селище, смт, м, місто; «с-ще» splits into с and ще) folded to м, else смт, else с, then the other words in order.
// Keep them in step: tests/scripts/gen-cvoe-settlements.test.ts compares the two.
const PLACE_TYPES = new Set(['с', 'ще', 'село', 'селище', 'смт', 'м', 'місто']);
export function settlementKey(name) {
  const words = nameWords(name);
  let i = 0;
  while (i < words.length && PLACE_TYPES.has(words[i])) i++;
  const lead = new Set(words.slice(0, i));
  const type = lead.has('м') || lead.has('місто') ? 'м'
    : lead.has('ще') || lead.has('селище') || lead.has('смт') ? 'смт'
      : lead.has('с') || lead.has('село') ? 'с' : '';
  const rest = words.slice(i);
  return (type ? [type, ...rest] : rest).join(' ');
}

// One district's settlements from its rows' names (page order): grouped by settlementKey, each shown as its spelling
// with the most rows (ties: the first seen).
export function districtSettlements(names) {
  const groups = new Map(); // key -> Map(spelling -> count), both in first-seen order
  for (const name of names) {
    const k = settlementKey(name);
    if (!groups.has(k)) groups.set(k, new Map());
    const spell = groups.get(k);
    spell.set(name, (spell.get(name) ?? 0) + 1);
  }
  return [...groups.values()].map((spell) => {
    let best;
    let bestCount = 0;
    for (const [name, c] of spell) if (c > bestCount) { best = name; bestCount = c; }
    return best;
  });
}

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

async function main() {
  const out = [];
  const stats = [];
  let total = 0;
  for (let n = 2; n <= 12; n++) {
    if (n > 2) await sleep(GAP_MS);
    const { html, bytes } = await page(n);
    const names = settlementsOf(n, html);
    if (names.some((name) => !name)) throw new Error(`district ${n}: empty settlement name`);
    if (names.some((name) => !settlementKey(name))) throw new Error(`district ${n}: a settlement name without words`);
    const settlements = districtSettlements(names);
    for (const name of settlements) out.push({ district: n, name });
    stats.push({ n, status: 200, bytes, rows: names.length, settlements: settlements.length });
    total += names.length;
  }
  out.push({ district: 1, name: 'м. Чернівці' });

  // Check what we write: the expected count, one entry per settlement of a district, no empty names.
  if (out.length < 400 || out.length > 650) throw new Error(`unexpected total ${out.length}`);
  const keys = new Set(out.map((r) => `${r.district}|${settlementKey(r.name)}`));
  if (keys.size !== out.length) throw new Error('a district holds one settlement twice');
  if (out.some((r) => !r.name)) throw new Error('empty name');

  out.sort((a, b) => a.district - b.district);
  writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
  for (const s of stats) console.log(`district ${s.n}: ${s.status}, ${s.bytes} bytes, ${s.rows} rows, ${s.settlements} settlements`);
  console.log(`total: ${total} rows, ${out.length} entries (incl. the city)`);
}

// Only when run as a script: importing it (the tests do) neither fetches nor writes.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
