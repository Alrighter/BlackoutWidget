'use strict';
/**
 * Tray icons: the state glyphs of docs/superpowers/specs/assets/design-2026-10-18/tray-menu.html (D5), rendered by
 * Chromium in a hidden offscreen window and saved as resources/tray/<state>.png (16 px) and <state>@2x.png (32 px).
 * Electron's nativeImage picks up the @2x file next to the 1x one by itself.
 *
 *   npm run tray:icons
 *   npm run tray:icons -- --preview <file.png>   also saves a sheet of the written icons over a dark and a light panel
 *
 * Like scripts/ui-capture: a throwaway profile, software rendering at scale 1, never the screen.
 */
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const OUT = path.resolve(__dirname, '../resources/tray');

/**
 * The mockup's «Світла панель» icons (20-unit view box): of its two sets, the one that still reads on a dark panel
 * (the dark set's #5dffa8 disc all but vanishes on a light taskbar). The discs are THEMES.light on / offDot / emergency
 * / unknown of src/shared/design-tokens.ts.
 */
const ICONS = {
  on: '<circle cx="10" cy="10" r="9" fill="#1fbf72"/><path d="M11 3.8 5.8 11h3.6l-.8 5.2 5.2-7.2h-3.6z" fill="#06210f"/>',
  off: '<circle cx="10" cy="10" r="9" fill="#ee4b3c"/><path d="M11 3.8 5.8 11h3.6l-.8 5.2 5.2-7.2h-3.6z" fill="#2a0b07"/>'
    + '<path d="M4.6 4.6l10.8 10.8" style="stroke: #2a0b07; stroke-width: 1.6; stroke-linecap: round"/>',
  emergency: '<circle cx="10" cy="10" r="9" fill="#e3261e"/>'
    + '<path d="M10 5v6" style="stroke: #ffffff; stroke-width: 2.2; stroke-linecap: round"/><circle cx="10" cy="14.6" r="1.3" fill="#ffffff"/>',
  unknown: '<circle cx="10" cy="10" r="9" fill="#8a90a6"/>'
    + '<path d="M7.7 7.7a2.4 2.4 0 1 1 3.3 2.2c-.6.3-1 .8-1 1.5v.4" style="fill: none; stroke: #ffffff; stroke-width: 1.8; stroke-linecap: round"/>'
    + '<circle cx="10" cy="14.6" r="1.1" fill="#ffffff"/>',
};
const NAMES = Object.keys(ICONS);
/** 1x and @2x; each icon is drawn in its own CELL × CELL slot of one page and cropped out of one capture. */
const SIZES = [[16, ''], [32, '@2x']];
const CELL = 40;

const page = body => `data:text/html;charset=utf-8,${encodeURIComponent(
  `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:transparent}</style>${body}`)}`;

const iconsPage = () => page(SIZES.flatMap(([size], row) => NAMES.map((name, col) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 20 20" style="position:absolute;left:${col * CELL}px;top:${row * CELL}px">`
  + `${ICONS[name]}</svg>`)).join(''));

/** The written files over the mockup's dark and light panels: at size, then magnified with hard pixels. */
const PANELS = [['Темна панель', '#1c1d22', '#9ca2b3'], ['Світла панель', '#f3f3f5', '#474c59']];
const VIEWS = [['1x', '', 16], ['@2x', '@2x', 32], ['1x ×8', '', 128], ['@2x ×4', '@2x', 128]];
const PREVIEW_SIZE = [1320, 420];
function previewPage() {
  const src = file => `data:image/png;base64,${fs.readFileSync(path.join(OUT, file)).toString('base64')}`;
  const img = (file, px) => `<img src="${src(file)}" width="${px}" height="${px}" style="image-rendering:pixelated">`;
  return page(`<div style="display:flex;font:12px 'Segoe UI', sans-serif">${PANELS.map(([label, bg, ink]) =>
    `<div style="display:grid;grid-template-columns:48px repeat(${NAMES.length}, 128px);gap:12px;align-items:center;`
    + `justify-items:center;padding:16px;background:${bg};color:${ink}"><span style="grid-column:1/-1;justify-self:start">${label}</span>`
    + VIEWS.map(([view, suffix, px]) => `<span>${view}</span>${NAMES.map(n => img(`${n}${suffix}.png`, px)).join('')}`).join('')
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

  const sheet = await render(iconsPage(), [NAMES.length * CELL, SIZES.length * CELL]);
  fs.mkdirSync(OUT, { recursive: true });
  SIZES.forEach(([size, suffix], row) => NAMES.forEach((name, col) => {
    const icon = sheet.crop({ x: col * CELL, y: row * CELL, width: size, height: size });
    const { width, height } = icon.getSize();
    if (width !== size || height !== size) throw new Error(`${name}${suffix}: ${width}×${height}, expected ${size}×${size}`);
    fs.writeFileSync(path.join(OUT, `${name}${suffix}.png`), icon.toPNG());
  }));
  // What src/main/tray.ts does: one path, both scales.
  for (const name of NAMES) {
    const scales = nativeImage.createFromPath(path.join(OUT, `${name}.png`)).getScaleFactors();
    if (scales.join() !== '1,2') throw new Error(`${name}.png loads with scale factors [${scales}], expected [1, 2]`);
  }
  console.log(`Wrote ${NAMES.length * SIZES.length} icons to ${OUT} (each loads at scales 1 and 2)`);

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
