'use strict';
/**
 * UI capture rig: renders the built renderer pages (out/renderer) offscreen with a fake window.api, a frozen clock and
 * a temporary profile, then saves a PNG and a JSON of the [data-capture] elements' boxes. Usage: README.md.
 */
const { app, BrowserWindow, ipcMain, nativeImage, nativeTheme } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SCENARIO_NAMES, buildScenario } = require('./scenarios.cjs');

const ROOT = path.resolve(__dirname, '../..');
/** = WIDGET_SIZES in src/main/widget/position.ts. */
const WIDGET_SIZES = { compact: [290, 150], ring: [236, 260], timeline: [400, 200] };
/** Content area of the real 900×640 main window on Windows 11 (frame and title bar taken off). */
const APP_SIZE = [886, 604];
/** Stands in for Mica behind the main window's transparent page: the middle stop of the mockup's window background. */
const WINDOW_BG = { light: '#eef0f5', dark: '#1e2028' };
const CHOICES = {
  target: ['widget', 'app'], style: Object.keys(WIDGET_SIZES), scenario: SCENARIO_NAMES, theme: ['light', 'dark'],
  view: ['schedule', 'settings', 'setup'],
};
const DEFAULTS = {
  target: 'widget', style: 'compact', scenario: 'on', theme: 'dark', view: 'schedule',
  out: '.superpowers/design-refresh/captures', wallpaper: 'auto', delay: '300', scale: '1',
};
const WALLPAPERS = ['auto', 'light', 'dark', 'busy', 'none'];
const FLAGS = new Set(['move-mode']);
const JOB_TIMEOUT_MS = 30_000;

function parseArgs(argv) {
  const start = argv.findIndex(a => a.endsWith('capture.cjs'));
  const args = argv.slice(start + 1);
  const opts = { ...DEFAULTS };
  for (let i = 0; i < args.length; i++) {
    const m = /^--([\w-]+)(?:=(.*))?$/s.exec(args[i]);
    if (!m) throw new Error(`unexpected argument "${args[i]}"`);
    const [, key, inline] = m;
    if (FLAGS.has(key)) { opts[key] = true; continue; }
    if (!Object.hasOwn(DEFAULTS, key) && !['now', 'patch', 'exec', 'tag'].includes(key)) throw new Error(`unknown option --${key}`);
    const value = inline ?? args[++i];
    if (value === undefined) throw new Error(`--${key} needs a value`);
    opts[key] = value;
  }
  for (const key of Object.keys(CHOICES)) {
    opts[key] = opts[key] === 'all' ? CHOICES[key] : opts[key].split(',');
    for (const v of opts[key]) if (!CHOICES[key].includes(v)) throw new Error(`--${key} ${v}: one of ${CHOICES[key].join(', ')}, all`);
  }
  if (!WALLPAPERS.includes(opts.wallpaper)) throw new Error(`--wallpaper: one of ${WALLPAPERS.join(', ')}`);
  for (const key of ['delay', 'scale']) {
    opts[key] = Number(opts[key]);
    if (!(opts[key] >= 0)) throw new Error(`--${key} needs a number`);
  }
  if (opts.patch) opts.patch = JSON.parse(opts.patch);
  opts.out = path.resolve(opts.out);
  return opts;
}

function jobsOf(opts) {
  const jobs = [];
  for (const target of opts.target) for (const style of opts.style) for (const theme of opts.theme) {
    for (const scenario of opts.scenario) for (const view of target === 'app' ? opts.view : [null]) {
      jobs.push({ target, style, theme, scenario, view });
    }
  }
  return jobs;
}

function fileBase(job, opts) {
  const parts = [job.target, job.target === 'widget' ? job.style : job.view];
  if (job.target === 'app' && opts.style.length > 1) parts.push(job.style);
  parts.push(job.scenario, job.theme);
  if (opts.wallpaper !== 'auto') parts.push(`wp-${opts.wallpaper}`);
  if (opts['move-mode']) parts.push('move');
  if (opts.tag) parts.push(opts.tag);
  return parts.join('-');
}

// Runs in the page. The page's Date is frozen, so waits use performance.now().
const READY_JS = `(async () => {
  const t0 = performance.now();
  while (!document.querySelector('#root > *')) {
    if (performance.now() - t0 > 10000) throw new Error('nothing rendered into #root');
    await new Promise(r => setTimeout(r, 25));
  }
  await document.fonts.ready;
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
})()`;

const MEASURE_JS = `(() => {
  const vw = innerWidth, vh = innerHeight, r = v => Math.round(v * 100) / 100;
  const elements = [...document.querySelectorAll('[data-capture]')].map(el => {
    const b = el.getBoundingClientRect();
    return {
      name: el.getAttribute('data-capture'), x: r(b.x), y: r(b.y), width: r(b.width), height: r(b.height),
      scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight,
      overflowX: el.scrollWidth > el.clientWidth, overflowY: el.scrollHeight > el.clientHeight,
      outside: b.left < 0 || b.top < 0 || b.right > vw || b.bottom > vh,
      text: (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 160),
    };
  });
  const de = document.documentElement;
  return { viewport: { width: vw, height: vh }, document: { scrollWidth: de.scrollWidth, scrollHeight: de.scrollHeight }, elements };
})()`;

const configs = new Map();
ipcMain.on('ui-capture:config', e => { e.returnValue = configs.get(e.sender.id) ?? null; });

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function capture(job, opts) {
  nativeTheme.themeSource = job.theme;
  const { nowMs, state, stubs } = buildScenario(job.scenario, { style: job.style, now: opts.now });
  if (opts.patch) {
    const { settings, ...rest } = opts.patch;
    Object.assign(state, rest);
    if (settings) Object.assign(state.settings, settings);
  }
  const widget = job.target === 'widget';
  const [width, height] = widget ? WIDGET_SIZES[job.style] : APP_SIZE;
  // Transparent for the app too: over an opaque base colour Chromium paints its own dark canvas (#121212) behind a
  // `color-scheme: dark` page. app.css keeps the page transparent for Mica; the rig assumes Mica shows through.
  const win = new BrowserWindow({
    width, height, useContentSize: true, show: false, frame: false, resizable: false,
    transparent: true, backgroundColor: '#00000000',
    webPreferences: {
      offscreen: { deviceScaleFactor: opts.scale }, preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  const wc = win.webContents;
  const errors = [];
  let timer;
  try {
    configs.set(wc.id, {
      nowMs, state, stubs, moveMode: opts['move-mode'] === true,
      wallpaper: { kind: opts.wallpaper === 'auto' ? job.theme : opts.wallpaper, width, height },
    });
    wc.on('console-message', e => { if (e.level === 'error') errors.push(e.message); });
    const failed = new Promise((_, reject) => {
      wc.on('preload-error', (_e, _path, err) => reject(new Error(`preload failed: ${err.stack ?? err}`)));
      wc.on('render-process-gone', (_e, d) => reject(new Error(`renderer gone: ${d.reason}`)));
    });
    const run = async () => {
      const page = path.join(ROOT, 'out/renderer', `${job.target}.html`);
      await win.loadFile(page, widget ? {} : { query: { view: job.view } });
      await wc.executeJavaScript(READY_JS);
      if (opts.exec) await wc.executeJavaScript(opts.exec);
      await sleep(opts.delay);
      const image = await wc.capturePage();
      if (image.isEmpty()) throw new Error('the capture is empty');
      return { image, measure: await wc.executeJavaScript(MEASURE_JS) };
    };
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${JOB_TIMEOUT_MS} ms`)), JOB_TIMEOUT_MS);
    });
    const { image: shot, measure } = await Promise.race([run(), failed, timeout]);
    const image = widget ? shot : flatten(shot, WINDOW_BG[job.theme]);
    const base = path.join(opts.out, fileBase(job, opts));
    fs.writeFileSync(`${base}.png`, image.toPNG());
    const size = image.getSize();
    const result = {
      file: `${base}.png`, ...job, now: new Date(nowMs).toISOString(), image: { width: size.width, height: size.height },
      ...measure, errors,
    };
    fs.writeFileSync(`${base}.json`, `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result));
  } finally {
    clearTimeout(timer);
    configs.delete(wc.id);
    win.destroy();
  }
}

/** The capture laid over a solid colour, as Mica sits behind the main window (bitmap: premultiplied BGRA). */
function flatten(image, hex) {
  const size = image.getSize();
  const px = image.toBitmap();
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  for (let o = 0; o < px.length; o += 4) {
    const k = (255 - px[o + 3]) / 255;
    px[o] += Math.round(b * k);
    px[o + 1] += Math.round(g * k);
    px[o + 2] += Math.round(r * k);
    px[o + 3] = 255;
  }
  return nativeImage.createFromBitmap(px, size);
}

// A throwaway profile, never the app's (or Electron's default) user data.
const PROFILE_PREFIX = 'bw-ui-capture-';
const removeDir = dir => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* files still held */ } };
// Profiles of earlier runs that Chromium still held open at exit; old enough not to be a run in progress.
for (const name of fs.readdirSync(os.tmpdir())) {
  const dir = path.join(os.tmpdir(), name);
  if (name.startsWith(PROFILE_PREFIX) && Date.now() - fs.statSync(dir).mtimeMs > 10 * 60_000) removeDir(dir);
}
const profile = fs.mkdtempSync(path.join(os.tmpdir(), PROFILE_PREFIX));
app.setPath('userData', profile);
// Window sizes in DIP must not be rounded through the display's scale (886×604 became 887×606 at 150 %);
// the output scale is the offscreen deviceScaleFactor (--scale).
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => { /* keep running between captures */ });

// app.exit() skips the quit events, so the profile goes here.
function finish(code) {
  removeDir(profile);
  app.exit(code);
}

app.whenReady().then(async () => {
  const opts = parseArgs(process.argv);
  for (const target of opts.target) {
    if (!fs.existsSync(path.join(ROOT, 'out/renderer', `${target}.html`))) throw new Error('out/renderer is missing: run `npm run build` first');
  }
  fs.mkdirSync(opts.out, { recursive: true });
  for (const job of jobsOf(opts)) await capture(job, opts);
  finish(0);
}).catch(err => {
  console.error(`ui-capture: ${err.stack ?? err}`);
  finish(1);
});
