# Is the outage-data-ua mirror a faithful, fresh copy of DTEK?

Checked 2026-10-22 at 01:35 Kyiv time (2026-10-21 22:35Z).

## Method

- **Live DTEK.** I opened each of the four DTEK `/ua/shutdowns` pages in a hidden Electron window. The window used a throwaway profile and the app's own session options: allowed host only, the page's polls blocked, timers neutralised. I read `DisconSchedule.fact` and `DisconSchedule.preset.sch_names`. That is one load per site, and none hit a verification.
- **Mirror.** Right after each page, I fetched `https://raw.githubusercontent.com/Baskerville42/outage-data-ua/main/data/<file>.json`. The files are `kyiv-region` (KREM), `kyiv` (KEM), `dnipro` (DNEM) and `odesa` (OEM).
- **Kyiv.** Right after the KEM page, I also fetched YASNO `regions/25/dsos/902/planned-outages`.
- **Comparison.** I compared `fact.data`, `fact.update`, `fact.today` and `sch_names` as deep-equal values, ignoring key order. Those are the only fields `dtek/parse.ts` reads. The mirror sorts its group keys, so a byte compare would fail on order alone.

## Fidelity: exact copy, all four sites

| Site | DTEK `update` | Mirror `update` | Days | Groups | `data` equal | `sch_names` equal |
|---|---|---|---|---|---|---|
| dtek-krem | 21.10.2026 19:20 | same | 2026-10-22 | 12 | yes | yes |
| dtek-kem | 21.10.2026 20:31 | same | 2026-10-22 | 60 | yes | yes |
| dtek-dnem | 17.10.2026 09:55 | same | none (quiet) | 0 | yes | yes |
| dtek-oem | 17.10.2026 09:54 | same | none (quiet) | 0 | yes | yes |

- The `fact` objects have the same keys on both sides (`data, today, update`). `factToDays`, `isQuietToday` and `deriveLines` therefore give the same result from the mirror as from the page.
- The hour statuses seen today were `yes`, `no`, `first` and `second`.
- The quiet Dnipro and Odesa state is copied faithfully: empty `data`, with the 17.10 stamp on both sides.
- **YASNO vs DTEK-KEM today:** 60 of 60 groups are identical, half-hour for half-hour. YASNO has no tomorrow yet (`WaitingForSchedule`), which matches DTEK, whose `fact` has only today too. YASNO `updatedOn` is 17:45Z and DTEK's `update` is 20:31 Kyiv (17:31Z).

## Freshness: KREM history, 2026-10-15 to 2026-10-21

The source is the GitHub commit history of `data/kyiv-region.json`: 1984 commits. I read the raw file at every 6th commit and found each change of `fact.update` down to the exact commit.

- **Run spacing:** the median is 5.0 min, p90 5.7, p99 6.8 and the maximum 18 min. Only one gap exceeded 15 min (2026-10-19 15:30Z).
- **Lag behind DTEK:** DTEK changed its `update` stamp 43 times in those 7 days. The mirror carried every change **6–11 min** after DTEK's stated update time. The typical lag is 8–10 min, and no change was missed.
- **Tomorrow:** the evening updates carry two days (for example, `21.10 19:20` holds 2026-10-21 and 2026-10-22). Tomorrow is mirrored as soon as DTEK publishes it.
- **Failed runs:** 6 of the 452 sampled files have `lastUpdateStatus {ok:false, code:422}`. The message is like ``Marker `DisconSchedule.fact =` not found``, meaning DTEK's WAF or a maintenance page beat the scraper. Each failure was a single run, and the next run recovered.
- **Staleness signal:** on a failed run the old `fact` is kept, `lastUpdateStatus.at` moves on and `lastUpdated` stays at the last successful parse. So `now − lastUpdated` is the age of the data. Example: failed at 19:48Z with `lastUpdated` 19:36Z, then recovered at 19:51Z.
- **CDN:** `raw.githubusercontent.com` serves `Cache-Control: max-age=300` with an ETag. Polling more often than every 5 min gains nothing.

## What the mirror does not have

- **No per-house data.** It has no `getHomeNum`, so no house list, no house lines (`sub_type_reason`) and no current-outage fields (`type`, `sub_type`, `start_date`, `end_date`). Those still need the DTEK page.
- **One maintainer.** The project is one person's GitHub Actions pipeline, and its source URLs are kept in a private secret. It can stop or change without notice. The data is MIT code over DTEK's scraped content.

## Conclusion

- The mirror is an exact copy of DTEK's own schedule objects for KREM, KEM, DNEM and OEM. Over the last week it was 6–11 min behind DTEK and never missed an update.
- It is fit to be the routine refresh source for those sites. The DTEK page stays as the fallback and remains the only source of house-level data.
- YASNO matches DTEK-KEM exactly for Kyiv city.
