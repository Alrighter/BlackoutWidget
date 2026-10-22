'use strict';
/**
 * The app icon from the Claude Design file «Blackout Widget icon» (2026-10-22): a navy rounded square, a 24-hour ring of
 * green (power on) and orange (outage) arcs, a white bolt. The design has two details: `full` for 64 px and up (Dock,
 * Finder, large Explorer icons) and `small` (a bigger square, a thicker ring, a bigger bolt) for 32 px and down, which
 * this script also uses at 48. Rendered by Chromium in a hidden offscreen window, each size from the vector, into:
 *
 *   build/icon.png   1024 px, `full`: electron-builder makes the macOS .icns from it
 *   build/icon.ico   16, 24, 32, 48 (`small`) and 64, 128, 256 (`full`): the Windows exe and installer icon
 *
 *   npm run app:icon
 *   npm run app:icon -- --preview <file.png>   also saves a sheet of the .ico sizes on a dark and a light panel
 *
 * Like gen-tray-icons.cjs: a throwaway profile, software rendering at scale 1, never the screen.
 */
const { app, BrowserWindow, nativeImage } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const OUT = path.resolve(__dirname, '../build');
const BG = '#161B2E';
const ON = '#1FBF72';
const OFF = '#F28C0F';
const BOLT = '#FFFFFF';

function pt(a, r) {
  const t = (a - 90) * Math.PI / 180;
  return [512 + r * Math.cos(t), 512 + r * Math.sin(t)];
}
function arc(a0, a1, r) {
  const [x0, y0] = pt(a0, r);
  const [x1, y1] = pt(a1, r);
  return `M${x0.toFixed(1)} ${y0.toFixed(1)} A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(1)} ${y1.toFixed(1)}`;
}

/** The design's AppIcon, in its 1024 view box: degrees clockwise from 12 o'clock, a small gap at each arc end. */
function iconSvg(detail, size) {
  const small = detail === 'small';
  const r = small ? 262 : 256;
  const w = small ? 132 : 104;
  const gap = small ? 4.5 : 3;
  const inset = small ? 40 : 100;
  const side = 1024 - inset * 2;
  const arcs = [[ON, -75, 60], [ON, 120, 225], [OFF, 60, 120], [OFF, 225, 285]]
    .map(([colour, a0, a1]) => `<path d="${arc(a0 + gap, a1 - gap, r)}" fill="none" stroke="${colour}" stroke-width="${w}"/>`);
  const scale = small ? 0.84 : 0.86;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 1024 1024">`
    + `<rect x="${inset}" y="${inset}" width="${side}" height="${side}" rx="${Math.round(side * 0.2237)}" fill="${BG}"/>`
    + arcs.join('')
    + `<g transform="translate(512 512) scale(${scale}) translate(-514 -512)">`
    + `<path d="M548 312 404 548h96l-42 164 166-252H526l74-148z" fill="${BOLT}" stroke="${BOLT}" stroke-width="14" stroke-linejoin="round"/></g>`
    + '</svg>';
}

/** [size, detail]: `small` up to 48, as the design shows it at 32, 24 (the Windows 11 taskbar) and 16. */
const ICO_SIZES = [[16, 'small'], [24, 'small'], [32, 'small'], [48, 'small'], [64, 'full'], [128, 'full'], [256, 'full']];

const page = body => `data:text/html;charset=utf-8,${encodeURIComponent(
  `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:transparent}svg{position:absolute;display:block}</style>${body}`)}`;

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

/** One size, cropped out of a capture of its own: exactly size × size, or the script stops. */
async function renderIcon(size, detail) {
  const sheet = await render(page(iconSvg(detail, size)), [Math.max(size, 64), Math.max(size, 64)]);
  const icon = sheet.crop({ x: 0, y: 0, width: size, height: size });
  const got = icon.getSize();
  if (got.width !== size || got.height !== size) throw new Error(`${size} px: ${got.width}×${got.height}`);
  return icon;
}

/**
 * Straight-alpha BGRA rows, top to bottom. Chromium's bitmap (nativeImage.toBitmap) is BGRA with premultiplied alpha
 * on Windows; an icon's DIB wants it straight.
 */
function straightBgra(image) {
  const px = Buffer.from(image.toBitmap());
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3];
    if (a === 0 || a === 255) continue;
    for (let c = 0; c < 3; c++) px[i + c] = Math.min(255, Math.round(px[i + c] * 255 / a));
  }
  return px;
}

/** A 32-bit DIB icon image: BITMAPINFOHEADER (height doubled for the AND mask), bottom-up BGRA rows, an empty mask. */
function dib(image, size) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  const rows = straightBgra(image);
  const stride = size * 4;
  const xor = Buffer.alloc(rows.length);
  for (let y = 0; y < size; y++) rows.copy(xor, (size - 1 - y) * stride, y * stride, (y + 1) * stride);
  const and = Buffer.alloc(Math.ceil(size / 32) * 4 * size); // the alpha channel decides; every mask bit 0
  return Buffer.concat([header, xor, and]);
}

/** ICO: DIB images below 256 px (what every reader takes), PNG at 256 (the Vista form, as Windows' own icons do). */
function ico(images) {
  const dir = Buffer.alloc(6 + 16 * images.length);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(images.length, 4);
  let offset = dir.length;
  const blobs = images.map(({ size, image }, i) => {
    const blob = size >= 256 ? image.toPNG() : dib(image, size);
    const at = 6 + 16 * i;
    dir.writeUInt8(size >= 256 ? 0 : size, at);
    dir.writeUInt8(size >= 256 ? 0 : size, at + 1);
    dir.writeUInt16LE(1, at + 4);
    dir.writeUInt16LE(32, at + 6);
    dir.writeUInt32LE(blob.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += blob.length;
    return blob;
  });
  return Buffer.concat([dir, ...blobs]);
}

/** The ring's top (12 o'clock, an `on` arc) must read #1FBF72: catches a wrong channel order in the DIBs. */
function checkChannels(image) {
  const { width } = image.getSize();
  const px = straightBgra(image);
  const i = (Math.round(width * 256 / 1024) * width + Math.round(width / 2)) * 4;
  const rgb = [px[i + 2], px[i + 1], px[i]];
  if (Math.abs(rgb[0] - 0x1f) > 4 || Math.abs(rgb[1] - 0xbf) > 4 || Math.abs(rgb[2] - 0x72) > 4) {
    throw new Error(`the ring's top reads rgb(${rgb}), expected #1FBF72: check the bitmap channel order`);
  }
}

/** The .ico sizes at 1x, magnified with hard pixels too, on the design's dark and light tiles. */
function previewPage(images) {
  const src = image => `data:image/png;base64,${image.toPNG().toString('base64')}`;
  const tile = (bg, ink) => `<div style="display:flex;align-items:flex-end;gap:24px;padding:24px;background:${bg};color:${ink}">`
    + images.map(({ size, image }) => `<div style="display:flex;flex-direction:column;align-items:center;gap:8px">`
      + `<img src="${src(image)}" width="${size}" height="${size}">`
      + `<img src="${src(image)}" width="${Math.min(size * 4, 256)}" height="${Math.min(size * 4, 256)}" style="image-rendering:pixelated">`
      + `<span>${size}</span></div>`).join('')
    + '</div>';
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><meta charset="utf-8"><style>html,body{margin:0}</style>`
    + `<div style="font:12px 'Segoe UI', sans-serif">${tile('#0b0d12', '#9ba1b3')}${tile('#eef0f4', '#474c59')}</div>`)}`;
}

async function main() {
  const at = process.argv.indexOf('--preview');
  const preview = at === -1 ? null : path.resolve(process.argv[at + 1] ?? '');
  if (preview !== null && !process.argv[at + 1]) throw new Error('--preview needs a file');

  fs.mkdirSync(OUT, { recursive: true });
  const big = await renderIcon(1024, 'full');
  checkChannels(big);
  fs.writeFileSync(path.join(OUT, 'icon.png'), big.toPNG());

  const images = [];
  for (const [size, detail] of ICO_SIZES) images.push({ size, image: await renderIcon(size, detail) });
  checkChannels(images.find(i => i.size === 256).image);
  const icoFile = path.join(OUT, 'icon.ico');
  fs.writeFileSync(icoFile, ico(images));
  const back = nativeImage.createFromPath(icoFile);
  if (back.isEmpty()) throw new Error('build/icon.ico does not load back');
  console.log(`Wrote ${path.join(OUT, 'icon.png')} (1024) and ${icoFile} (${ICO_SIZES.map(([s]) => s).join(', ')})`);

  if (preview) {
    fs.mkdirSync(path.dirname(preview), { recursive: true });
    fs.writeFileSync(preview, (await render(previewPage(images), [1480, 1240])).toPNG());
    console.log(`Preview: ${preview}`);
  }
}

// A throwaway profile, never the app's (or Electron's default) user data.
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bw-app-icon-'));
app.setPath('userData', profile);
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => { /* the script quits itself */ });

function finish(code) {
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* Chromium may still hold files */ }
  app.exit(code);
}

app.whenReady().then(main).then(() => finish(0), err => {
  console.error(`gen-app-icon: ${err.stack ?? err}`);
  finish(1);
});
