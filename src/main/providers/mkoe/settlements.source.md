# Mykolaiv settlement list

- Source: the operator's public address API, read live on 2026-10-20 with `scripts/gen-mkoe-settlements.mjs`:
  `GET https://off.energy.mk.ua/api/addr/filii` (20 дільниць), then `GET /api/addr/filii/{id}/ns` for each.
- Counts: 20 дільниць, 890 settlements (`idnaspunkt` values are unique).
- `settlements.data.json`: `{ id, name, filiiId, filii }` sorted by `id`; `name` is exactly as the operator writes it (untrimmed), `filii` is the дільниця `fullname`.
- Labels are made in `settlements.ts` with `uniqueLabels` (a shared name gets ` (дільниця)`), trimmed.
- Regenerate: `node scripts/gen-mkoe-settlements.mjs` (21 requests, one second apart), then run `tests/providers/mkoe-settlements.test.ts`.
