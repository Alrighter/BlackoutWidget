# Zhytomyr settlement list

- Source: the operator's address form, read live on 2026-10-21 with `scripts/gen-ztoe-settlements.mjs`:
  `GET https://www.ztoe.com.ua/unhooking-search.php` for the `rem_id` select (19 РЕМ), then
  `POST rem_id=N` (form-urlencoded) for each, one second apart, reading `naspunkt_id`. The pages are windows-1251.
- Counts: 19 РЕМ, 1758 settlements (`naspunkt_id` values are unique across РЕМ).
- `settlements.data.json`: `{ id, name, remId, rem }` sorted by `id`; `name` is entity-decoded and trimmed, `rem` is the
  select's text («Хорошівський», without «РЕМ»).
- Labels are made in `settlements.ts` with `labeled` (a name shared by several settlements gets ` (Х РЕМ)`).
- Regenerate: `node scripts/gen-ztoe-settlements.mjs` (20 requests, one second apart), then run
  `tests/providers/ztoe-settlements.test.ts`. If the site is unreachable the script falls back to the saved 2026-10-20
  research capture and says so on stdout.
