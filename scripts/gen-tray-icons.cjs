'use strict';
/**
 * Tray icons: the state glyphs of docs/superpowers/specs/assets/design-2026-10-18/tray-menu.html (D5), in the colours
 * of its light panel (resources/tray/<state>.png) and its dark panel (<state>-dark.png), rendered by Chromium in a hidden
 * offscreen window at 16 px, plus 32 px <…>@2x.png files that Electron's nativeImage picks up next to the 1x ones.
 *
 *   npm run tray:icons
 *   npm run tray:icons -- --preview <file.png>   also saves a sheet of the written icons, each set on its own panel
 *
 * Like scripts/ui-capture: a throwaway profile, software rendering at scale 1, never the screen.
 */
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const OUT = path.resolve(__dirname, '../resources/tray');

/** The mockup's glyphs (20-unit view box) in a disc colour and an ink colour. */
const BOLT = '<path d="M11 3.8 5.8 11h3.6l-.8 5.2 5.2-7.2h-3.6z" fill="INK"/>';
const GLYPHS = {
  on: `<circle cx="10" cy="10" r="9" fill="DISC"/>${BOLT}`,
  off: `<circle cx="10" cy="10" r="9" fill="DISC"/>${BOLT}<path d="M4.6 4.6l10.8 10.8" style="stroke: INK; stroke-width: 1.6; stroke-linecap: round"/>`,
  emergency: '<circle cx="10" cy="10" r="9" fill="DISC"/>'
    + '<path d="M10 5v6" style="stroke: INK; stroke-width: 2.2; stroke-linecap: round"/><circle cx="10" cy="14.6" r="1.3" fill="INK"/>',
  unknown: '<circle cx="10" cy="10" r="9" fill="DISC"/>'
    + '<path d="M7.7 7.7a2.4 2.4 0 1 1 3.3 2.2c-.6.3-1 .8-1 1.5v.4" style="fill: none; stroke: INK; stroke-width: 1.8; stroke-linecap: round"/>'
    + '<circle cx="10" cy="14.6" r="1.1" fill="INK"/>',
};
const NAMES = Object.keys(GLYPHS);
/**
 * [file suffix, disc and ink per state]: the mockup's «Світла панель» row (its discs are THEMES.light on / offDot /
 * emergency / unknown of src/shared/design-tokens.ts) and its «Темна панель» row. src/main/tray-menu.ts trayIconFile
 * picks one by the taskbar's theme.
 */
const SETS = [
  ['', { on: ['#1fbf72', '#06210f'], off: ['#ee4b3c', '#2a0b07'], emergency: ['#e3261e', '#ffffff'], unknown: ['#8a90a6', '#ffffff'] }],
  ['-dark', { on: ['#5dffa8', '#0d2a1a'], off: ['#ff6b5b', '#2a0b07'], emergency: ['#ff4d4d', '#ffffff'], unknown: ['#9aa0b4', '#1a1c22'] }],
];
const ICONS = SETS.flatMap(([suffix, colours]) => NAMES.map(name => ({
  file: `${name}${suffix}`, svg: GLYPHS[name].replaceAll('DISC', colours[name][0]).replaceAll('INK', colours[name][1]),
})));
/** 1x and @2x; each icon is drawn in its own CELL × CELL slot of one page and cropped out of one capture. */
const SIZES = [[16, ''], [32, '@2x']];
const CELL = 40;

const page = body => `data:text/html;charset=utf-8,${encodeURIComponent(
  `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:transparent}</style>${body}`)}`;

const iconsPage = () => page(SIZES.flatMap(([size], row) => ICONS.map(({ svg }, col) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 20 20" style="position:absolute;left:${col * CELL}px;top:${row * CELL}px">`
  + `${svg}</svg>`)).join(''));

/** The written files, each set over its own panel of the mockup: at size, then magnified with hard pixels. */
const PANELS = [['Темна панель', '#1c1d22', '#9ca2b3', '-dark'], ['Світла панель', '#f3f3f5', '#474c59', '']];
const VIEWS = [['1x', '', 16], ['@2x', '@2x', 32], ['1x ×8', '', 128], ['@2x ×4', '@2x', 128]];
const PREVIEW_SIZE = [1320, 420];
function previewPage() {
  const src = file => `data:image/png;base64,${fs.readFileSync(path.join(OUT, file)).toString('base64')}`;
  const img = (file, px) => `<img src="${src(file)}" width="${px}" height="${px}" style="image-rendering:pixelated">`;
  return page(`<div style="display:flex;font:12px 'Segoe UI', sans-serif">${PANELS.map(([label, bg, ink, set]) =>
    `<div style="display:grid;grid-template-columns:48px repeat(${NAMES.length}, 128px);gap:12px;align-items:center;`
    + `justify-items:center;padding:16px;background:${bg};color:${ink}"><span style="grid-column:1/-1;justify-self:start">${label}</span>`
    + VIEWS.map(([view, suffix, px]) => `<span>${view}</span>${NAMES.map(n => img(`${n}${set}${suffix}.png`, px)).join('')}`).join('')
    + '</div>').join('')}</div>`);
}

async function render(url, [width, height]) {
  const win = new BrowserWindow({
    width, height, useContentSize: true, show: false, frame: false, transparent: true, backgroundColor: '#00000000',
    webPreferences: { offscreen: { deviceScaleFactor: 1 }, sandbox: true, contextIsolation: true },
  });
  try {
    await win.loadURL(url);
    await win.webContents.executeJavaScript('Promise.all([...document.images].map(i => i.decode())).then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))');
    const image = await win.webContents.capturePage();
    if (image.isEmpty()) throw new Error('the capture is empty');
    return image;
  } finally {
    win.destroy();
  }
}

async function main() {
  const at = process.argv.indexOf('--preview');
  const preview = at === -1 ? null : path.resolve(process.argv[at + 1] ?? '');
  if (preview !== null && !process.argv[at + 1]) throw new Error('--preview needs a file');

  const sheet = await render(iconsPage(), [ICONS.length * CELL, SIZES.length * CELL]);
  fs.mkdirSync(OUT, { recursive: true });
  SIZES.forEach(([size, suffix], row) => ICONS.forEach(({ file }, col) => {
    const icon = sheet.crop({ x: col * CELL, y: row * CELL, width: size, height: size });
    const { width, height } = icon.getSize();
    if (width !== size || height !== size) throw new Error(`${file}${suffix}: ${width}×${height}, expected ${size}×${size}`);
    fs.writeFileSync(path.join(OUT, `${file}${suffix}.png`), icon.toPNG());
  }));
  // What src/main/tray.ts does: one path, both scales.
  for (const { file } of ICONS) {
    const scales = nativeImage.createFromPath(path.join(OUT, `${file}.png`)).getScaleFactors();
    if (scales.join() !== '1,2') throw new Error(`${file}.png loads with scale factors [${scales}], expected [1, 2]`);
  }
  console.log(`Wrote ${ICONS.length * SIZES.length} icons to ${OUT} (each loads at scales 1 and 2)`);

  if (preview) {
    fs.mkdirSync(path.dirname(preview), { recursive: true });
    fs.writeFileSync(preview, (await render(previewPage(), PREVIEW_SIZE)).toPNG());
    console.log(`Preview: ${preview}`);
  }
}

// A throwaway profile, never the app's (or Electron's default) user data.
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-tray-icons-'));
app.setPath('userData', profile);
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => { /* the script quits itself */ });

function finish(code) {
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* Chromium may still hold files */ }
  app.exit(code);
}

app.whenReady().then(main).then(() => finish(0), err => {
  console.error(`gen-tray-icons: ${err.stack ?? err}`);
  finish(1);
});
