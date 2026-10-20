// Regenerates src/main/providers/mkoe/settlements.data.json from the operator's public address API.
// Read-only GETs: /api/addr/filii, then /api/addr/filii/{id}/ns for each filii, one second apart.
// Usage: node scripts/gen-mkoe-settlements.mjs
import { writeFileSync } from 'node:fs';

const BASE = 'https://off.energy.mk.ua/api/addr';
const OUT = new URL('../src/main/providers/mkoe/settlements.data.json', import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path) {
  const res = await fetch(BASE + path, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.json();
}

const filii = await get('/filii');
const out = [];
for (const f of filii) {
  await sleep(1000);
  const ns = await get(`/filii/${f.idfilial}/ns`);
  for (const n of ns) out.push({ id: n.idnaspunkt, name: n.naznaspunkt, filiiId: f.idfilial, filii: f.fullname });
}
out.sort((a, b) => a.id - b.id);
writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
console.log(`${filii.length} filii, ${out.length} settlements`);
