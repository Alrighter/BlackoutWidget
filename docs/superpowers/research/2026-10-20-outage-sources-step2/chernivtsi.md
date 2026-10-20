# Chernivtsioblenergo (АТ «Чернівціобленерго», Chernivtsi oblast): outage sources

Research date: 2026-10-20 (about 17:30 Kyiv). All live requests came from a Ukrainian residential connection, with at least 1 s between them.

Legend:
- **[VERIFIED]**: I fetched it today and saw the response.
- **[READ]**: seen only in third-party code, saved third-party snapshots or docs; not confirmed live.

Fixtures are in `docs/superpowers/research/2026-10-20-outage-sources-step2/chernivtsi-raw/` (list in §8).
Scratch scripts: `C:\Users\roman\AppData\Local\Temp\claude\C--Users-roman-source-repos-BlackoutWidget\cca11217-ee57-4ad5-8ca6-1ed7e3708675\scratchpad\step2\chernivtsi\` (`analyze.mjs`, `an2.mjs`, `cur*.mjs`).

---

## TL;DR

Verdict: **medium** (easy parsing; the work is in the address data and the quiet-day rule).

1. **Schedule** = server-rendered HTML at `GET https://oblenergo.cv.ua/shutdowns/`. There is **no date parameter**. The page shows exactly one day's table, dated inside it (`#gsv > ul > p`, `DD.MM.YYYY`). Tomorrow is `GET /shutdowns/?next`, and it exists only while the default page links to it.
   - 12 groups "1"–"12", 48 half-hour cells each: `<u>з</u>` = on, `<o>в</o>` = off, `<s>мз</s>` = maybe.
   - The only update time is `Графік актуальний станом на <b>HH:MM</b>` (no date).
2. **Quiet day.** The operator **does not publish a "no outages" table**; it leaves the last table up. Today, 20.10, the page still serves a table dated **18.10** (all «з»). So "table date < today" = nothing published for today. A real failure looks different: no `#gsv` and no emergency article, a wrong cell count, or an unknown tag or letter.
   - When the operator drops the schedule for an emergency, `#gsv` disappears and `article.wrap_article_v2_emergency` (an image) appears [READ, saved snapshot].
3. **Past day with real outages:** there is no archive or date query on the site. The best fixture is a saved real page of **05.11.2025** with 52 off and 22 maybe cells (from an MIT repo, §8). Live pages today are all «з».
4. **Address → group:** `GET /shutdowns-search/{1..12}/` returns the whole district as HTML (one `<div>` per house). 12 pages, **241,818 rows, 23 MB uncompressed, ~1.8 MB gzip**.
   - There is no smaller query: filtering is client-side, and every query parameter is ignored.
   - Only the oblast districts have a settlement column. The city has none.
   - Groups are district-specific: city = 2, 4, 6, 8, 10, 12; districts mostly odd. About 0.4% of houses sit on two or three groups (one row per group).
   - Spelling is dirty (Latin «I», case mix, trailing spaces, `буд.` prefixes).
5. **Current outage: yes, per address.**
   - `POST /shutdowns/planovi_avarijni_result.php` (form fields, JSON reply with an HTML table) returns **emergency** (`v_type=0`) and **planned** (`v_type=1`) outages.
   - Planned outages (repair works) were live today for 21–23.10; emergency was empty.
   - Search is by substring, with a 3-character minimum for settlement and street.
6. **Access:** no WAF challenge for a residential IP; plain `fetch` with any UA works. Datacenter IPs (GitHub Actions) get a Cloudflare "Sorry, you have been blocked" page, which is irrelevant to a desktop app but a risk for corporate VPNs. No CORS headers needed (main-process fetch). UTF-8.

---

## 1. Schedule page

### 1.1 Endpoint [VERIFIED]

- `GET https://oblenergo.cv.ua/shutdowns/` → 200, `text/html; charset=UTF-8`, ~24.7 KB, `server: cloudflare`, `x-powered-by: PHP/5.6.40`, `cf-cache-status: DYNAMIC`. No cookies or special headers are required.
- No JSON behind it. The page JS (`/shutdowns/script.js`, `/shutdowns/script2.js`) only does presentation (highlight a group, hide past cells) and the current-outage form (§3). There is no XHR for the schedule. The table is in the HTML.
- `robots.txt` does not exist (the URL returns the HTML home page with 200).

### 1.2 Structure [VERIFIED live; `?next` and emergency structure also [READ]]

```html
<div id="gsv_t" class="gsv_info"><div> …day switcher… </div></div>
<div id="gsv_a" class="gsv_info"><p>Графік актуальний станом на <b>17:00</b><span id="refresh_page">…</span></p></div>
<div id="gsv_actual" class="gsv_info">Сторінку відкрито 20.10.2026 о 17:28</div>   <!-- server clock, Kyiv -->
<div id="gsv" highlight="0">
  <ul><p>18.10.2026\n</p>                         <!-- DATE OF THE TABLE -->
     <li id="grp1" data-id="1">Група<b>1</b></li> … <li id="grp12" data-id="12">…</ul>
  <div>
    <p> …48 header cells… </p>                    <!-- time header -->
    <div id="inf1" data-id="1"><u>з</u><u>з</u>… (48 cells)</div>
    … id="inf2" … id="inf12"
  </div>
</div>
```

- Group = `div#infN[data-id=N]` inside `#gsv`; N in 1..12. All 12 present; **every one has exactly 48 cells** [VERIFIED live and in the 2025-11-05 snapshot]. Cell i (0-based) = half-hour starting at `00:00 + 30 min × i`.
- Time header: `<u><b>HH<em>:00</em></b><u>HH<em>:30</em></u></u>`. The last cell has an extra `<b>00<em>:00</em></b>` (24:00 marker). **Don't parse the header**; the index is enough.
- **Cell codes** (tag + letter; CSS colours `o`=red `#DC7463`, `u`=green `#C7D39F`, `s`=grey `#B0BEC5`):

  | tag | text | legend text | `Slot` |
  |---|---|---|---|
  | `<o>` | `в` | «Відключені» | `off` |
  | `<u>` | `з` | «Заживлені» | `on` |
  | `<s>` | `мз` | «Можливо заживлені» | `maybe-off` |

  Counts in the 05.11.2025 snapshot: 502 `з`, 52 `в`, 22 `мз` (total 576 = 12 × 48). The legend in the page repeats `<u>` for «Заживлені» (outside `#gsv`; scope selectors to `#gsv`).
- The operator's own wording: grey = time when the group *may* be powered depending on limits, also used as a buffer for switching between groups. In practice `мз` sits at the edges of off blocks (e.g. `…з мз в в в в в мз з…`). Map it to `maybe-off`.
- `#active_h` (`<div id="active_h" data-id="12">` + current-hour marker) is injected only when the table shown is for **today** [READ: appears in the 2025-10-31 snapshot; absent in today's stale live page]. The JS then deletes past cells client-side. The server HTML always carries all 48. A parser must not rely on `#active_h`, but its absence is a corroborating "table is not for today" signal.

### 1.3 Date of the table, today vs tomorrow

- The date is the text of `#gsv > ul > p` (`DD.MM.YYYY` plus whitespace/newline) [VERIFIED live: `18.10.2026`].
- **No date parameter** [VERIFIED]: `?date=17.10.2026`, `?d=2026-10-17`, `?day=1` all return the same table (only the cache-busting `?v=<unix>` in `<link>` tags differs). There is no selector for past dates.
- **Tomorrow = `GET /shutdowns/?next`** [READ: three independent repos use it; the operator's own switcher]. Today's live `?next` returns the same 18.10 table, because nothing newer is published. So `?next` only means "tomorrow" when the default page offers it.
- The day switcher in `#gsv_t > div` [READ: the saved 05.11.2025 page and the sso-notifier parser's `hasNextDaySchedule`]:
  - With tomorrow published, the default page has `<b>today</b><a href="/shutdowns/?next">tomorrow</a>`. This layout is inferred from Kolokol2002/TurnOffOnLight, which looks for `a[href="/shutdowns/?next"]`. I could not see it live today.
  - The `?next` view has `<a href="/shutdowns/">today</a><b>tomorrow</b>` (saved page: `<a href="/shutdowns/">04.11.2025</a><b>05.11.2025</b>`, table date 05.11.2025).
  - With one day only: `<b>31.10.2025</b>` alone.
  - Live today (stale table): `#gsv_t` is **empty**.
- Not verified: what the default page shows around midnight (does it flip to the new date by itself or wait for the operator?). Treat the table date as the only truth: match it against Kyiv today/tomorrow, never assume the page is "today".

### 1.4 Update time

- `#gsv_a b` = `HH:MM` only, no date: «Графік актуальний станом на 17:00» [VERIFIED]. Live today it says 17:00 while the table is dated 18.10, so the time presumably belongs to the last operator edit of that table; the date of that edit is not stated.
- The 2025 snapshots show `20:00` and `12:30`. The operator promises 30-minute refreshes during outages (page text, [VERIFIED]: «Законодавство зобов'язує нас оновлювати інформацію кожні 30 хв»).
- Mapping for `sourceUpdatedAt`: `HH:MM` + table date (`HH:MM DD.MM.YYYY`). Caveat: a table for tomorrow edited at 20:00 today would be stamped with tomorrow's date. Simplest: use the table date and accept the approximation, or for a tomorrow table use today's Kyiv date when `HH:MM` is not later than the server clock. Flag as open.
- `#gsv_actual` = «Сторінку відкрито 20.10.2026 о 17:28» is the **server clock in Kyiv time** (UTC 14:28 at fetch). Useful as a clock-skew-free "now" and a freshness check.
- Several revisions per day: yes in principle (30-min promise), not observable today.

### 1.5 Quiet day vs broken source (the fail-closed rule)

The operator never publishes an "all on" table. When outages stop it leaves the old table. Today: dated 18.10, all 576 cells «з». Proposed classification of a fetch:

| fetch result | meaning |
|---|---|
| HTTP ≠ 200, network error, Cloudflare block page (no `#gsv`, no `.wrap_article_v2_emergency`, title `Attention Required`) | **error** (fail closed) |
| `#gsv` present, 12 × `div#infN` all with 48 cells made only of `<o>в`/`<u>з`/`<s>мз`, date parses, `gsv_a b` parses | **valid table** |
| valid table, date == Kyiv today | today's schedule |
| valid table, date < today | **quiet day**: «світло є» + note «Графік на сьогодні не публікувався (останній — DD.MM)» |
| valid table, date == tomorrow on `?next` | tomorrow's schedule |
| `#gsv` missing but `article.wrap_article_v2_emergency` present | **emergency mode**: the schedule is void. Not an error; surface as `currentOutage.kind = 'emergency'` with a generic text (the article is an image, no text). [READ] |
| `#gsv` present but anything structurally off (cell count ≠ 48, other tags, missing groups, no date, no `gsv_a`) | **error** |

The risk that a moved page turns into a false quiet day is covered because "quiet" requires a structurally perfect 12 × 48 table. Add a sanity bound: a table dated more than ~30 days back, or in the future beyond tomorrow, is an error.

---

## 2. Address → group

### 2.1 Endpoints [VERIFIED]

- `GET https://oblenergo.cv.ua/shutdowns-search/` is only the shell (6.3 KB): a `<select name="diln">` of districts, then client-side filtering.
- `GET https://oblenergo.cv.ua/shutdowns-search/{N}/` returns **all rows** of that district: 200, `text/html; charset=utf-8`, `Cache-Control: no-store`, no cookies. `{N}` outside 1..12 (e.g. 0, 13) returns the empty shell (6.2 KB, 200), not 404.
- **No smaller query exists** [VERIFIED]: `?street=…`, `?city=…&street=…&house=…`, a path segment, a POST body: all return the identical full page. The site filters in the browser (`/shutdowns-search/script.js?v=1.03`). So a provider must download a whole district and cache it.
- Sizes (bytes, uncompressed / gzip download) and row counts (my parse):

  | N | district | uncompressed | gzip | rows | settlements |
  |---|---|---|---|---|---|
  | 1 | ЧЕРНІВЦІ (city) | 1,558,158 | 86,153 | 25,964 | none (city) |
  | 2 | Вижницька | 2,121,660 | 173,766 | 20,994 | 48 |
  | 3 | Герцаївська | 642,012 | 43,249 | 6,817 | 32 |
  | 4 | Глибоцька | 1,972,248 | 153,691 | 20,005 | 41 |
  | 5 | Заставнівська | 1,864,646 | 134,002 | 18,732 | 45 |
  | 6 | Кіцманська | 2,486,336 | 210,228 | 24,686 | 50 |
  | 7 | Кельменецька | 1,763,838 | 115,145 | 17,682 | 41 |
  | 8 | Новоселицька | 2,751,704 | 210,326 | 28,164 | 55 |
  | 9 | Путильська | 873,674 | 59,504 | 7,872 | 74 |
  | 10 | Сокирянська | 1,764,390 | 120,252 | 17,460 | 34 |
  | 11 | Сторожинецька | 3,295,938 | 270,137 | 31,057 | 49 |
  | 12 | Хотинська | 2,321,989 | 181,721 | 22,385 | 60 |
  | | total | 23.4 MB | ~1.76 MB | 241,818 | ~437 distinct names |

  (The survey said 25,966 rows for the city; I count 25,964 `<div>` rows after `#city_tbl`.)
- The select's order is not numeric: the option with value 7 (Кельменецька) comes before 6 (Кіцманська). The values are stable ids 1..12. (Note: the *current-outage* form uses **different** district ids, §3.)
- The district list is static: ЧЕРНІВЦІ (city) + 11 districts. Hard-code it. Note the 11 oblast districts here are **operator service areas** (Вижницька, Герцаївська, …), not the 3 administrative raions. Coverage = the whole oblast.

### 2.2 Row format [VERIFIED]

City (`N=1`, container `#city_tbl`, class `res_tbl`): **no settlement column**.
```html
<div><p>ГОСТОМЕЛЬСЬКИЙ ПРОВ.</p><b>52А</b><u>8</u></div>      <!-- street, house, group -->
```
Districts (`N=2..12`, container `#obl_tbl`): **settlement is a fourth element**.
```html
<div><s>с. БАНИЛІВ</s><p>вул. НАДРІЧНА</p><b>буд. 12</b><u>7</u></div>   <!-- settlement, street, house, group -->
```
(Parse with a regex or DOM on `div > [s?, p, b, u]`; the `<s>` tag here is the settlement, unrelated to the schedule's `<s>` cell.)

The city's row is the whole city (the oblast capital). There is **no "Чернівці" label** in the data. The provider must supply it ("м. Чернівці") for district 1.

### 2.3 Cascade for the wizard

- **Settlements:** the union over `N=1..12` of the `<s>` values plus the city. There is **no settlement-list endpoint**; deriving it needs all 12 pages (~1.8 MB gzip, 23 MB parsed). Options: (a) bundle a generated settlement→district list in the app (437 names, a few KB, refresh by script); (b) lazy-load: the user picks a district first (12 items), then the app fetches only that page. Recommended (b) or a hybrid: bundle the settlement→district index, and fetch one district page on demand.
- **Streets and houses:** straight from the district page filtered by settlement/street. No further requests.
- **Queue:** the `<u>` value, a bare integer string.

### 2.4 Several groups per house [VERIFIED]

- Yes. A house with N groups appears as N rows with the same address and different `<u>`. Distinct houses with ≥2 groups: 131 (city) and 944 in the districts, 1,075 in total (0.4%); 12 houses have ≥3 (e.g. `с-ще ЛУЖАНИ | вул. Незалежності | буд. 53 → 3, 7, 11`; city `ВІКТОРА РЕДЬКИНА 5 → 8, 12`).
- Pairs are not random: in the city 8/12, 6/12, 2/4; in the districts 1/3, 1/5, 3/5, 1/11, 9/10, 3/11.
- 80 rows are exact duplicates; dedupe.
- Semantics are not stated by the operator. Safest: expose one `LineInfo` per group (`index` = order, `groupId` = "8", `label` = «Група 8»). The widget already supports several lines per house.
- "Not in the schedule": there is **no such value**. Every `<u>` is numeric (0 non-numeric rows). An address missing from the list is simply absent.
- Group-number ranges differ by district [VERIFIED]: city 2, 4, 6, 8, 10, 12 (even); Вижницька, Герцаївська, Глибоцька, Заставнівська, Кіцманська, Новоселицька (mostly odd, a few even); Кельменецька 3/7/11. The page that shows the schedule has 12 rows for all, so the group id maps directly to `div#infN`.
- Stray low-count groups (e.g. group 7 in Заставнівська = 2 rows, group 1 in Новоселицька = 81 rows) look like data-entry tails, but they are valid group ids.

### 2.5 Spelling and format issues [VERIFIED by analysis of all 241,818 rows]

- **Settlement label** (districts): prefix `м.` (21,043 rows), `с.` (181,047), `с-ще` (8,109), `селище` (5,653), `смт` (1), plus one with no prefix. Case is mixed: `с. БАНИЛІВ` / `с. Банилів` / `м. ВИЖНИЦЯ` / `м. Вижниця` are the same place inside one district (49 such pairs). Trailing spaces in 371 rows (`м. Новодністровськ `). Some carry notes: `с. Магала (Остриця)`, `с. ст.Ларга`, `с. В.КУЗЬМІН`, `с. Ст. ВОВЧИНЕЦЬ`. → Normalise: trim, collapse spaces, case-fold; key on the lower-cased form, display Title-Case or the first spelling.
- **Namesakes across districts:** 12+ settlement names occur in 2–3 districts (Остриця in 3 and 8; Берегомет in 2 and 6; Вашківці 2 and 10; Чернівці as a **village** in districts 3, 4 and 8, besides the city). The wizard needs the district in the label, e.g. "с. Остриця (Герцаївська)", and the city should be "м. Чернівці (місто)".
- **Street**: city streets have no uniform prefix (UPPER CASE `ГОСТОМЕЛЬСЬКИЙ ПРОВ.`, `ПР НЕЗАЛЕЖНОСТІ`, `1-й ПРОВ.ТАДЖИЦЬКИЙ`, some `вул. ГОЛОВНА ` with prefix, 1,856 rows with lower-case letters). District streets almost always start with `вул. ` (210,660 of the district rows, even for provinces/alleys: `вул. Провулок Заводський`, `вул. РУСЬКА, вул. Зубринецька`). Trailing spaces in 3,005 street values. Unusual characters: `' ` U+0027 (4,915; **no U+2019 or U+02BC at all**), backtick U+0060 (10), `*` (1), `{`/`}` (37), `:` (766, in cadastral numbers like `9:3:4:1`), `№` (3), `?` (4).
- **Latin look-alikes:** 1,622 rows have Latin `I` inside Cyrillic words (`НАДРIЧНА`, `МОЛОДIЖНА`, `ЮРКIВСЬКА`; 38 distinct words), plus a few `c`, `C`, `l`. Normalise Latin → Cyrillic before comparing (I→І, i→і, c→с, C→С, a→а, o→о, p→р, e→е, x→х, B→В, K→К, M→М, H→Н, T→Т, A→А, O→О, P→Р, E→Е, X→Х, y→у). 106 distinct house strings mix a Latin letter with digits (`50A`, `63A`, `10 B`, `134-147A`, `n4`, `77v`).
- **House formats:**
  - City: bare numbers and letters. `12` (19,525), `12А` (5,315), `12а` (562), `12-А` (243), `12 А` (114), `12 а`, `9/9`, `9-9`, `9А/9`, `9"А"`, `9,9`, some with text such as `вул. … "…"`.
  - Districts: always `буд. ` plus the same variants (`буд. 12`, `буд. 12А`, `12 А`, `12-А`, `12а`, `12/А`, `12.А`, `12,А`, `12_`, `12:3:4:1`, `12 "Б"`, `001`, `1/1`), plus a few `сад. 5`, `сад 5`, `1 `, `буд. 3-5`.
  - `12-А` and `12А` and `12 А` are all separate rows of the same house in places (the same house keyed in both spellings). Normalise the house key: upper-case, strip `буд.`/`сад.`, drop spaces, hyphens, dots, commas, underscores and quotes, convert Latin to Cyrillic; keep `/`.
  - Leading zeros exist (`001`).
- **User-facing list:** the wizard can show the cleaned strings. Matching the user's choice back to a row must use the same normalisation, or (better) store the **normalised triple** and the district id in the saved address and resolve the group again on refresh.

---

## 3. Current outage (emergency and planned) per address

**Yes: an official endpoint exists** [VERIFIED].

- The page `https://oblenergo.cv.ua/shutdowns/` embeds a search block `#pa_search` (tabs «Аварійні» / «Планові»); its JS (`/shutdowns/script2.js`) calls it.
- `POST https://oblenergo.cv.ua/shutdowns/planovi_avarijni_result.php`, `application/x-www-form-urlencoded`, UTF-8, no cookie or header needed (an `x-requested-with: XMLHttpRequest` header is harmless).

  | field | meaning |
  |---|---|
  | `v_type` | `0` emergency (Аварійні), `1` planned (Планові) |
  | `v_diln` | district, **different ids from the search pages**: 1 Чернівецький, 2 Герцаївський, 3 Путильський, 4 Сторожинецький, 5 Новоселицький, 6 Вижницький, 7 Кіцманський, 8 Сокирянський, 9 Хотинський, 10 Заставнівський, 11 Кельменецький, 12 Глибоцький (from `#v_diln`; `0` = all, but it is rejected) |
  | `v_city` | substring of the settlement, **≥ 3 chars required** |
  | `v_street` | substring of the street, **≥ 3 chars required** |
  | `v_house` | substring, optional |
  | `v_date` | `DD.MM.YYYY`; the datepicker allows today … today+6 |
  | `v_sort_field` (`4` = start time; 6 publish, 1 district, 2 settlement, 3 address, 5 end), `v_sort_type` (0 asc, 1 desc), `v_page` (1-based) | sort and paging |

- Reply: `200`, `Content-Type: text/html; charset=utf-8` (really JSON): `{"test":"=…","data":"<tbody>…</tbody>"}`. Validation failure: `{"required_error":1,"required_error_text":"Оберіть дільницю.\nВкажіть населений пункт.\nВкажіть вулицю."}` (also for strings shorter than 3 chars).
- **Nothing found:** `{"test":"=","data":"<tbody><tr><td colspan=\"6\" class=\"empty_shutdowns\"><p><i>search_off</i>Нічого не знайдено</p></td></tr></tbody>"}`.
- **Rows** (6 columns: published, district, settlement, address+houses, off time, on time), sample for `v_type=1&v_diln=1&v_city=Чер&v_street=вул&v_date=21.10.2026`; the matched substring is wrapped in `<b>`:

```html
<tr><td>2026-10-12 15:06:18</td><td>Чернівецький</td><td>м. <b>Чер</b>нівці</td>
<td><b>вул</b>. КАДЕНЮКА ЛЕОНІДА,<br><span>буд. 10, буд. 11, буд. 12, буд. 13, буд. 13-В, … буд. 22А, … буд. б/н</span></td>
<td>2026-10-21 09:00:00</td><td>2026-10-21 20:00:00</td></tr>
…
<tr><td colspan="6"><div class="shop_pages" id="pages_list"><div><p>1</p><a data-page="2">2</a>…</div></div></td></tr>
```
- Live picture on 20.10 [VERIFIED]:
  - Planned (`v_type=1`, city, street substring «вул»): **21.10** (6 pages, 20 rows each, 09:00–20:00), **22.10**, **23.10**, **25.10** (e.g. КАДЕНЮКА ЛЕОНІДА, `буд. 13, буд. 22А, буд. 24`) had rows. No rows for 19.10, 20.10, 28.10, or 10.10 (the endpoint holds only today and future).
  - Emergency (`v_type=0`): empty for city + all 11 districts today.
- Row semantics: one row = one street with a list of houses, the interval `[off, on]` and the publication time. A house can be in several rows (several dates are queried separately by `v_date`).
- Matching a saved address: query with `v_city`+`v_street`(+`v_house`) per date (today, tomorrow; plus the next few days if "planned" notices should show ahead), then match the house **by token** in the `<span>` list (the server's house filter is substring: house `5` also matched a row containing `15`, `22А` vs `22а` is case-insensitive). The street text in this form is **not** guaranteed to equal the one in the group search (`КАДЕНЮКА ЛЕОНІДА` vs search-page spelling): use the street's key words and compare normalised.
- Map to `CurrentOutage`: kind `emergency` for `v_type=0`, `planned` for `v_type=1`; `start`/`end` = columns 5/6 (Kyiv local, `YYYY-MM-DD HH:MM:SS`); text = «Планові роботи» / «Аварійне відключення» + the interval.
- The emergency row shape was **not observed** (nothing live today); it is presumably identical, since both types use the same template [READ: same handler, shared `#pa_result` table]. Verify when an emergency appears.
- Personal data: none (streets and house numbers only).

---

## 4. Access

- Cloudflare in front ([VERIFIED] `server: cloudflare`). No JS challenge for a residential IP with curl's default UA, a `node` UA and a browser UA alike.
- **Datacenter IPs are blocked** [READ + corroborated]: a GitHub Actions snapshot from 2026-03-01 is Cloudflare's "Sorry, you have been blocked" page, the repo's author gave up ("archive cos i'm too lazy to fight captcha"), and the Wayback CDX shows only 403 captures. sso-notifier (a bot) sends an `X-Proxy-Token` through a proxy. A desktop app on a home or mobile connection is fine; a company VPN or datacenter proxy may hit the block.
- No CORS headers [VERIFIED], so fetch from the Electron main process (`net.fetch`). No cookies required. `Cache-Control: no-store` on the search pages (the `last-modified` is fake: always ~4 days back).
- Encoding: UTF-8 everywhere (the `/shutdowns/` page declares `charset=UTF-8`; the search pages `utf-8`; CRLF line endings in the search pages). The current-outage JSON escapes Cyrillic as `\uXXXX`.
- Rate limits: none seen over ~45 requests spaced 1.2 s.
- No `robots.txt` (the site returns its home page with 200 at that URL).
- No API key in use. One of the third-party repos (the Telegram bot Kolokol2002/TurnOffOnLight) contains a leaked jsonbin master key; **not used and not recorded here**.

---

## 5. Other sources

- No JSON behind the schedule page (checked all page scripts) [VERIFIED].
- Third-party Chernivtsi data (no need for the widget, listed for completeness): svitlo-proxy "new" worker (`chernivetska`, 1–12 groups, 1/2 per half-hour, stale at 17.10), per the survey §3.2 [READ]; no open dataset keeps history. The Chernivtsi history repos on GitHub (`chernivtsi-power-outages-history`) are archived and empty (only a Cloudflare block page).
- Reference parsers [READ]: Roma7-7-7/sso-notifier (Go, MIT, `internal/providers/chernivtsi.go`), DrSmile444/blackout-ua-core (TS), imaksb/lightCEbot, MouseGerry/shutdowns-bot, Kolokol2002/TurnOffOnLight (`?next` logic). Elvis129/prosvitlo-addresses-db ("one page per district, 12 requests") confirms the address approach.

---

## 6. Risks and open questions

1. **Quiet-day detection depends on the stale-table behaviour** seen today (table dated 18.10 on 20.10). If the operator ever removes `#gsv` on quiet days, the page would look like "no schedule, no emergency" = error under my rules. Treat a missing `#gsv` **plus** a missing emergency article as an error with a clear message rather than a quiet day (fail closed is the decided rule).
2. **Day switching live is unseen.** The default-page "tomorrow" link (`a[href="/shutdowns/?next"]`) comes from third-party code only. Re-verify on the first real outage day; parse by table date, not by position.
3. **Midnight rollover and update stamp:** the HH:MM has no date (§1.4). `sourceUpdatedAt` is approximate.
4. **District data is 1.8 MB gzip per full refresh**, 23 MB of HTML to parse (a 3.3 MB page in the worst district). Parse one district at a time and cache the compact result (≈ 240k rows, mostly repeated strings; a per-district index keyed by normalised settlement/street/house is small). The data changes rarely, so a weekly refresh is plenty.
5. **Dirty spelling** (§2.5): a saved address can break when the operator edits a street or house spelling. Re-resolve with normalised keys and surface "address no longer found" explicitly.
6. **Namesake settlements and the unlabelled city** need the district shown in the wizard.
7. **Multi-group houses** (about 0.4%): semantics undefined by the operator; show both lines.
8. **Groups 7 in district 5 (2 rows), 1 in district 8 (81 rows)** etc. look like typos but are valid group ids; no way to tell.
9. **Cloudflare/datacenter IP block** may hit users behind VPNs (§4).
10. **Emergency-mode page** is a banner image; no text to read. Only "emergency, schedule suspended" can be said.
11. **Current-outage endpoint**: minimum 3 characters (a street like "Ліс" or a 2-letter settlement can't be searched), 20 rows per page, substring semantics; emergency row shape unobserved.
12. The 2025 fixtures come from a third party, not from today's live site; the layout may have changed since (the 2026-10-20 live page has the same `#gsv` structure, so likely not).

---

## 7. Recommended provider design

- **Schedule:** fetch `/shutdowns/` with `net.fetch` in the main process. Parse with a strict DOM or regex over `#gsv`: date from `ul > p`, update `HH:MM` from `#gsv_a b`, 12 × 48 cells by tag (`o`/`u`/`s`) and letter, validating both. Cell index i → slot i. If an `a[href="/shutdowns/?next"]` exists, fetch `/shutdowns/?next` too and read **its** table date (it must equal Kyiv tomorrow, else ignore it). Classify per §1.5 (error / quiet day / emergency / today / tomorrow).
- **Quiet day:** table date < Kyiv today → all `on` for today with the note; tomorrow stays unpublished.
- **Emergency:** no `#gsv` + `.wrap_article_v2_emergency` → no schedule, `currentOutage {kind:'emergency'}` and a note; not an error.
- **Address:** `listCities()` = bundled `settlement → district id` index (generated by a script from the 12 pages; ~437 names; city = "м. Чернівці") with the district shown for namesakes. `listStreets` / `listHouses` = fetch `/shutdowns-search/{N}/` once per district, parse with a normalising pass (§2.5), cache on disk (weekly), keep only the chosen district in memory. A house's `lines` = all rows with the same normalised key (`groupId` = the `<u>` integer, label «Група N»).
- **Current outage:** after the schedule, for the saved address call `planovi_avarijni_result.php` for `v_type` 0 and 1, `v_date` today (and tomorrow for planned), with the saved settlement/street as `v_city`/`v_street`; token-match the house in the `<span>` list; build `CurrentOutage`. Treat `required_error` and non-JSON as "unknown", never as "no outage". Throttle to once per refresh.
- **Normaliser shared by the wizard and the matcher:** trim, collapse whitespace, case-fold, Latin→Cyrillic homoglyphs, drop `буд.`/`сад.`, keep apostrophes as U+0027 and also fold U+2019/U+02BC to it.

---

## 8. Fixtures (`docs/superpowers/research/2026-10-20-outage-sources-step2/chernivtsi-raw/`)

| file | what | origin |
|---|---|---|
| `schedule_2026-10-20_live_table-dated-18.10_all-on.html` | the live `/shutdowns/` page on 2026-10-20: stale table, all «з», empty `#gsv_t` | [VERIFIED] |
| `schedule_2025-11-05_next-view_with-outages_from-sso-notifier-MIT.html` | a real `?next` page with outages (52 `в`, 22 `мз`), `gsv_t` = `<a href="/shutdowns/">04.11.2025</a><b>05.11.2025</b>`, "станом на 20:00" | [READ] from Roma7-7-7/sso-notifier test data (MIT); not fetched from the live site |
| `schedule_2025-10-31_today-only_from-sso-notifier-MIT.html` | today-only page with `#active_h`, `gsv_t` = `<b>31.10.2025</b>`, "станом на 12:30" | [READ] same repo |
| `schedule_emergency-mode_no-gsv_from-sso-notifier-MIT.html` | emergency mode: no `#gsv`, `article.wrap_article_v2_emergency` | [READ] same repo |
| `search_index_district-list_2026-10-20.html` | `/shutdowns-search/` shell with the 12 district options | [VERIFIED] |
| `search_d1_Chernivtsi-city_TRIMMED-first-1500-of-25964-rows.html` | city rows (street, house, group), cut to valid HTML | [VERIFIED], trimmed |
| `search_d3_Hertsa_TRIMMED-first-1500-of-6817-rows.html` | district rows with the settlement column | [VERIFIED], trimmed |
| `search_d8_Novoselytsia_TRIMMED-first-1200-of-28164-rows.html` | another district (mixed case, namesakes, several groups) | [VERIFIED], trimmed |
| `current_planned_2026-10-21_cherniv_Cher-vul_page1.json` | real planned outages (JSON with HTML `data`), page 1 of 6, with the pager row | [VERIFIED] |
| `current_empty_nothing-found.json` | «Нічого не знайдено» reply | [VERIFIED] |
| `current_required-error.json` | validation error reply | [VERIFIED] |

No fixture exists for a live outage day on the schedule page itself (the operator keeps only the current table and nothing is published today); the 2025-11-05 snapshot is the closest real thing. No personal data in any fixture.
