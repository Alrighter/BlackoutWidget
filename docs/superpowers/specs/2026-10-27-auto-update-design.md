# Auto-update (OTA) — design

Date: 2026-10-27. Status: brainstormed with the user, waiting for approval.

## Intent

New versions are published as GitHub Releases (public repo `Alrighter/BlackoutWidget`; checked with `gh repo view` on
2026-10-27: `PUBLIC`. The "private-repo minutes" comment in `build-mac.yml` predates that and should be corrected). Today someone who already has the
widget never learns about them and must download and install by hand. The user wants the app to update itself with
one click: «якась кнопка в застосунку стрілочка вниз. натискає, автооновлюється застосунок і перезапускається».

Success: after a release, everyone running an OTA-capable version sees an arrow-down button in the app; one click
downloads, installs and restarts into the new version with their addresses, widgets and settings intact. This holds on
Windows and on macOS.

## What the user sees (decided)

- **Nothing until there is an update.** The app checks quietly. No dialogs, no notifications, no badge on the widget.
- **The button.** When a newer version exists, the main window's header shows a button with a down-arrow icon in
  `.app-tools`, next to the refresh button. It looks like the refresh button (same size and style). Tooltip and
  accessible name: «Оновити застосунок до <version>».
- **One click does everything:** download (progress shown on the button), install, restart. No confirmation dialog.
- **Download only after the click**, never in the background. During outages people are often on mobile internet;
  ~115 MB without asking is wrong. (Claude's call, stated to the user.)
- **The tray** gets an item «Оновити застосунок до <version>» while an update is available, doing the same as the
  button. (Claude's guess, stated to the user, not objected to.)

## Behaviour

**Checking.**
- First check a short while after startup (so it doesn't compete with the first schedule refresh), then every 6 hours.
  (Claude's call.)
- A failed check (offline, GitHub down, rate limit) is logged once and retried at the next interval. It never shows
  anything to the user.
- Only full releases count, not drafts or pre-releases.
- "Newer" means a higher semver than `app.getVersion()`.

**Button states** (copy is Claude's call; the builder may polish wording, not add steps):
- *available*: arrow-down icon, tooltip «Оновити застосунок до 1.0.2».
- *downloading*: the button shows progress (a ring or a percentage), tooltip «Завантаження оновлення… 42 %». It is
  disabled; a second click does nothing.
- *installing*: tooltip «Встановлення…», right before the app quits.
- *error*: the arrow comes back with a small error mark, tooltip «Не вдалося оновити. Натисніть, щоб спробувати
  ще раз». The reason goes to the log. A retry starts the whole download again.

The state lives in main and reaches the renderer like the rest of `AppState` (or a sibling field). The renderer never
talks to GitHub.

**After the restart**, the app starts exactly as after a normal launch: settings, `snapshots.json`, secrets and EcoFlow
history live in `userData` and are not touched by the update. Autostart registration must keep pointing at the app.

## Windows mechanism (decided)

- `electron-updater` with the NSIS target. The installer is `oneClick: true`, `perMachine: false` (per-user, no admin),
  which suits a silent update.
- Configure `publish: github` (owner `Alrighter`, repo `BlackoutWidget`) in `electron-builder.yml` so the build writes
  `latest.yml` and the `.blockmap`. The build itself stays `--publish never`; uploading stays a manual step of the
  release (below).
- `autoDownload: false`; the click calls `downloadUpdate()`, then `quitAndInstall(true, true)` (silent, run after).
- The installer is unsigned. Update signature verification must not block it: no `publisherName`, so electron-updater
  skips the Authenticode check. The update is still verified by the sha512 in `latest.yml`.
- Quitting for the install must go through the normal quit path: the widgets' close guard allows it once `quitting`
  is set, the BLE host is disposed, the EcoFlow session closes.

## macOS mechanism (decided: path A, the app replaces itself)

The user chose «шлях А» over opening the dmg or buying an Apple Developer ID. Squirrel.Mac (what electron-updater uses
on macOS) refuses an ad-hoc signed app, so the replacement is our own code.

- **Release files.** The mac build also produces a `zip` of the `.app` (electron-builder `zip` target next to `dmg`) and
  `latest-mac.yml` (version, file name, sha512, size). The workflow uploads them as artifacts with the dmg.
- **Check.** Read `latest-mac.yml` from the latest GitHub release (electron-updater's check may be reused for this, or a
  plain HTTPS fetch; builder's choice). Same rules as Windows.
- **Download.** On click, download the zip to a temp folder with progress, then verify size and sha512 against
  `latest-mac.yml`. A mismatch is an error, and nothing is replaced.
- **Prepare.** Unpack with `ditto -x -k` into a temp folder next to the download, and check that the result is one
  `Blackout Widget.app` whose `Info.plist` version is the expected one. Remove a quarantine attribute if present.
- **Replace and restart.** Find the running bundle (from `app.getPath('exe')` up to the `.app`). Start a small detached
  helper (shell script), then quit the app normally. The helper:
  1. waits until the old process (by pid) has exited;
  2. moves the old bundle aside;
  3. moves the new bundle into its place;
  4. on success, deletes the old bundle and opens the new one (`open`);
  5. on any failure, puts the old bundle back and opens it.

  The single-instance lock means the new app must not start before the old one has fully exited.
- **Where it can't replace.** If the bundle's folder isn't writable (for example, the app runs from the mounted dmg or
  from a folder the user can't write), fall back to path B for that case: download and open the dmg, and log why.
  (Claude's call.)
- **Never leave the user without an app.** Any failure before the quit keeps the current app running with the *error*
  state. Any failure in the helper restores the old bundle.

## Release process changes

- **Every release needs a new version** (`package.json` `version`). Re-publishing 1.0.0 as we did is no longer
  possible, because updaters compare versions. The first OTA-capable release is **1.0.1**.
- **1.0.0 can't update itself.** Everyone on 1.0.0 installs 1.0.1 by hand once. Later versions update themselves.
- **Release assets:**
  - Windows: `Blackout-Widget-Setup-<v>.exe`, its `.blockmap` and `latest.yml`.
  - macOS: the dmg, the zip and `latest-mac.yml`.

  The file names inside `latest*.yml` must match the uploaded asset names. Today we rename files to remove spaces, so
  either keep electron-builder's names or set `artifactName` without spaces. The builder picks one and makes the yml
  and the uploads agree.
- The README's Release section and the memory of how releases are made are updated accordingly.

## Constraints

- **The update must never break the app:** a failed check, download, verification or replacement leaves the current
  version running and working.
- No downloads without the click. No telemetry; the only new hosts are GitHub's release download hosts
  (`github.com`, `objects.githubusercontent.com` or whatever the release redirects to).
- The UI stays in Ukrainian; the README and release notes in English.
- No secrets are involved. The GitHub repo is public, so no token ships in the app.
- Pure logic is unit-tested with fakes: version comparison, state machine, yml parsing, sha512 check, and the helper
  script's command sequence. Native and OS steps sit behind small injectable seams, as `desktop-pin.ts` does.
- Claude never runs the installed or packaged app. End-to-end verification is the user's, on Windows and on the M1 Mac.

## Proving the updater before 1.0.1 is public (Claude's call)

A broken updater in 1.0.1 could not fix itself: everyone on it would have to install by hand again. So 1.0.1's
updater is proven first, against a feed nobody else sees:

- **Feed override.** The updater accepts a feed override (for example an environment variable or a build-time
  constant) that points it at a test feed instead of the latest full release. The test feed is a GitHub
  **pre-release** on the same repo, for example tag `update-test`, read with electron-updater's `generic` provider
  from its download URL. Normal builds ignore pre-releases, so ordinary users never see it.
- **Test versions.** The user installs a test build `1.0.1-test.1` by hand on Windows and on the Mac. The test feed
  offers `1.0.1-test.2`. One click must take both machines to `test.2` with everything intact.
- **Then publish.** The real 1.0.1 is a higher semver than `1.0.1-test.2`, so the test machines update to it like
  everyone else. That is a third proof of the path.
- **The override may not leak.** It must not be reachable in a normal release build (no UI, no settings key), or only
  through the environment, which ordinary users don't set. The builder picks which.

The user may overrule this and publish 1.0.1 directly, accepting a possible second manual install.

## Known effects to check (macOS)

- The app is ad-hoc signed, and the signature changes with every build. macOS may therefore ask again for Bluetooth
  permission after an update. It may also ask to let Blackout Widget use the «Blackout Widget Safe Storage» Keychain
  item (EcoFlow secrets).
- If the user refuses the Keychain prompt, decrypting fails. The app must then behave as it does today when secrets
  can't be read (ask to sign in again), not crash. The builder verifies this path in code; the user confirms it on
  the Mac.
- This is the same as a manual update today, so it is no new problem, but the release notes for 1.0.2 should mention
  it.

## Non-goals

- Android (a separate project, brainstormed next).
- Background or silent automatic updates, update channels, beta builds, release notes inside the app, rollback to an
  older version.
- Code signing or notarization (Apple Developer ID, Windows certificate).
- Showing the current version in Settings (nice, but not asked for).

## Left to the builder

- Whether macOS reuses electron-updater for the check or fetches `latest-mac.yml` directly.
- The exact progress visual on the button, and the icon drawing (in the style of the existing header icons).
- The startup delay before the first check.
- The module layout (e.g. `src/main/update/` with a platform seam), IPC names, and how the state joins `AppState`.
- How the helper script is written and where its log goes, provided its failures end up in the app log on the next
  start.
