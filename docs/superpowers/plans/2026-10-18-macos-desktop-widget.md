# macOS desktop widget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** on macOS the widget behaves like a desktop widget: it sits on the desktop under normal windows, on every Space, outside the Dock, Cmd+Tab and Mission Control, with native macOS glass. The user picked «варіант 1» (2026-10-18).

**Architecture:**
- **Pinner.** A `MacDesktopPinner` implements the existing `DesktopPinner` through koffi and the Objective-C runtime. It sets the NSWindow level just above the desktop icons and the collection behaviour to all Spaces + stationary + ignores cycle.
- **Glass.** It is native vibrancy on the widget window, with the window's content layer rounded to the card radius.
- **Renderer.** A new `WidgetBackground` kind, `native`, tells the renderer to drop its solid underlay so the native blur shows through.
- **Crash guard.** It disables pinning for the current app version if a native call ever kills the process.

**Tech Stack:** Electron 44 (macOS arm64), koffi (already a dependency), TypeScript, React 19, vitest.

**Spec:** `docs/superpowers/specs/2026-10-17-blackout-widget-design.md` §7.2–7.3 (macOS pinning and glass), plus the user's choice in chat:
- the widget lies on the desktop under windows, on all Spaces;
- it is not in the Dock or Cmd+Tab;
- it uses native glass;
- it is moved with our move mode;
- it is not a WidgetKit widget.

## Global Constraints
- **Windows unchanged.** Windows behaviour does not change; every existing test keeps passing.
- **Pure modules.** They never import electron.
- **Native code.**
  - It loads lazily, on darwin only, inside try/catch.
  - A JS-level failure falls back to `NoopPinner` and the `tint` background, with one log line each.
  - It must never take the app down.
- **koffi on arm64.** Declare every `objc_msgSend` variant with its exact non-variadic signature. Pass object pointers and selectors as `uintptr_t`. Read the NSView pointer from `getNativeWindowHandle()` with `readBigUInt64LE(0)`.
- **Mac testing.** No one on this side has a Mac. Everything must be unit-tested with fake bindings, and the user tests the CI build against a checklist.
- **Commits.** Subject and body only. No `Co-Authored-By` and no Claude attribution.
- **Safety.** Never run the installed app and never use the user's data. Any Electron run is offscreen with a temp userData, as in the capture rig.

## Review Focus
1. A wrong FFI signature crashes natively, where try/catch cannot help. The crash guard must stop a crash loop: one crash, then pinning stays off for that version.
2. The pinned widget must still get mouse input: click, right-click, drag in move mode. If it does not, spec §7.3 applies and the tray keeps every control. Make the level a single constant that is easy to change.
3. «Показати робочий стіл», Mission Control and switching Spaces must not move or hide the widget.
4. Style changes (compact ↔ ring ↔ timeline) must update the rounded corner radius as well as the size.
5. When vibrancy fails, the widget shows today's tint glass, not a transparent hole.

---

### Task 1: `MacDesktopPinner` and crash guard

**Files:**
- Create `src/main/widget/objc-darwin.ts`: the lazy koffi bindings.
- Create `src/main/widget/pin-darwin.ts`: the pinner.
- Create `src/main/widget/pin-guard.ts`: the crash guard; pure, fs injected.
- Modify `src/main/widget/desktop-pin.ts`: choose the darwin pinner.
- Modify `src/main/index.ts`: pass `userData` and the app version to `createDesktopPinner` if it needs them.
- Tests: `tests/main/widget/pin-darwin.test.ts` and `tests/main/widget/pin-guard.test.ts`.

**Interfaces:**
- `objc-darwin.ts` exports `loadObjc(): ObjcBindings` with:
  - `cls(name)`, `sel(name)`;
  - `msgId(obj, sel)`;
  - `msgVoidLong(obj, sel, n)`, `msgVoidULong(obj, sel, n)`, `msgVoidBool(obj, sel, b)`, `msgVoidDouble(obj, sel, d)`;
  - `windowLevelForKey(key)`, which wraps CoreGraphics `CGWindowLevelForKey`.
  
  The libraries are `/usr/lib/libobjc.A.dylib` and `/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics`. Every object and selector is a `bigint`.
- Constants:
  - `kCGDesktopIconWindowLevelKey = 18`.
  - `PIN_LEVEL_OFFSET = 1`, so the level is `windowLevelForKey(18) + 1`.
  - Collection behaviour `NSWindowCollectionBehaviorCanJoinAllSpaces (1<<0) | Stationary (1<<4) | IgnoresCycle (1<<6)`.
- `export class MacDesktopPinner implements DesktopPinner`, constructed as `(objc: ObjcBindings, guard: PinGuard)`:
  - `pin(win)`: NSView from the handle, then `[view window]`, then `setLevel:`, then `setCollectionBehavior:`, all inside `guard.run(...)`.
  - `unpin(win)`: level `0` (NSNormalWindowLevel) and behaviour `CanJoinAllSpaces`, for the §7.3 move-mode fallback.
  - `setBounds`: `win.setBounds`.
  - `pinned` reflects the last successful pin.
- `pin-guard.ts` exports `createPinGuard(fs, file, version)`:
  - `run(fn)` writes `{version}` to the marker file before `fn` and deletes it after.
  - `disabled` is true when the marker exists at start with the same version. That means the last native call never finished, and the process died. A different version or no marker means enabled; a stale marker from another version is deleted.
  - The marker file is `<userData>/pin-darwin.pending`.
- `createDesktopPinner(log, { userData, version })`:
  - on darwin, with the guard not disabled: `new MacDesktopPinner(loadObjc(), guard)`;
  - with the guard disabled: log a warning and use `NoopPinner`;
  - if `loadObjc` throws: log an error and use `NoopPinner`;
  - Windows is unchanged.

**Steps:**
- [ ] Write failing tests with fake bindings that record calls:
  - **pin.** `pin(win)` calls `msgId(view, sel('window'))`, then `msgVoidLong(nswin, sel('setLevel:'), L+1)` where `L = windowLevelForKey(18)`, then `msgVoidULong(nswin, sel('setCollectionBehavior:'), 81)`. 81 is `1|16|64`.
  - **Handle.** The handle Buffer `0x1234n` (little-endian u64) gives the view `0x1234n`.
  - **unpin.** It sets level 0 and behaviour 1.
  - **Guard, normal run.** `run` writes the marker before `fn` and removes it after.
  - **Guard, throw.** A throwing `fn` still removes the marker and rethrows, and the pinner then logs and stays unpinned.
  - **Guard, disabled.** A marker with the same version at start gives `disabled`. A marker with another version is deleted and gives enabled.
  - **createDesktopPinner.** Mock `process.platform`, or inject the platform: darwin with a disabled guard gives `NoopPinner` and one warning; darwin with a throwing `loadObjc` gives `NoopPinner`.
- [ ] Run the focused tests: they should FAIL.
- [ ] Implement.
- [ ] Run `npx vitest run`, `npm run typecheck` and `npm run build`: all PASS.
- [ ] Commit `Pin the widget to the macOS desktop`.

### Task 2: Native glass and rounded corners

**Files:**
- Modify `src/main/widget/widget-window.ts`: darwin window options, and pushing the corner radius on style change.
- Modify `src/main/widget/pin-darwin.ts`, or add a small `glass-darwin.ts` that uses the same bindings and guard.
- Modify `src/main/index.ts`: on darwin send `native` instead of starting the win32 glass updater.
- Modify `src/shared/types.ts`: `WidgetBackground` gains `{ kind: 'native' }`.
- Modify `src/renderer/src/widget/{Widget.tsx, WidgetRoot.tsx, widget.css}`.
- Modify `scripts/ui-capture/` (`--wallpaper native`).
- Tests: `tests/main/widget/glass-darwin.test.ts` and `tests/renderer/widget.test.tsx`.

**What:**
- **Window options.** On darwin the widget window is created with `vibrancy` and `visualEffectState: 'active'`, because the window is never key. The material is your choice: one that follows the system appearance and fits the mockup glass, e.g. `'hud'` or `'popover'`. Say why in the report. If Electron 44 documents that `transparent: true` conflicts with vibrancy, follow the documented combination and say so.
- **Corners.**
  - After `ready-to-show`, round the window's content: `[[nswin contentView] setWantsLayer:YES]`, then on its `layer` call `setCornerRadius:R` (double) and `setMasksToBounds:YES`.
  - R is the card radius of the current style: compact 22, ring 26, timeline 24. These come from `src/shared/design-tokens.ts` or a shared table; do not hard-code them twice.
  - Re-apply R on every style change.
  - Run every call inside the pin guard.
- **Background.**
  - When vibrancy and corners succeed, main sends `{ kind: 'native' }`.
  - When they fail, main sends `{ kind: 'tint' }` and logs one line.
  - The win32 glass updater stays Windows-only.
- **Renderer, `native` kind.**
  - The card draws no solid underlay. `--w-underlay` becomes transparent for `.w-native`.
  - It keeps the mockup's `--bw-glass` layer, the edge and the tone tint, over the native blur.
  - `tint` and `image` render exactly as today; prove it with byte-identical rig captures.
- **Rig.** `--wallpaper native` renders the `native` kind over the canvas wallpaper, as a stand-in for the blur.

**Steps:**
- [ ] Write failing tests:
  - Fake bindings record `setWantsLayer:` YES, then `layer`, then `setCornerRadius:` 22 and `setMasksToBounds:` YES for compact. A style change to ring re-sends 26.
  - A throwing binding results in a `tint` background and one log line.
  - The renderer with `native` has no underlay and keeps `.w-glass`.
  - `tint` and `image` are unchanged.
- [ ] Implement.
- [ ] Capture with the rig:
  - all three styles with `--wallpaper native`, both themes;
  - the existing `tint` and `image` captures, which must be byte-identical to a baseline taken before the change.
- [ ] Run `npx vitest run`, `npm run typecheck` and `npm run build`: all PASS.
- [ ] Commit `Give the macOS widget native glass`.

### After the tasks (controller)
- Run the macOS CI build (`gh workflow run build-mac.yml --ref <branch>`).
- Hand the user the dmg and this checklist:
  - the widget is visible on the desktop and stays under other windows;
  - «Показати робочий стіл» (F11 or the gesture), Mission Control and switching Spaces do not move or hide it;
  - clicking it opens the main window; right-click and move mode work;
  - the glass looks right in light and dark;
  - the corners match the card in all three styles;
  - after a style change the corners follow.
