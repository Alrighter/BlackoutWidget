'use strict';
/**
 * Preload of the UI capture rig, standing in for src/preload/index.ts: a fake window.api over the state capture.cjs
 * built, and a frozen clock. Sandboxed like the real preload, so everything arrives in one sync IPC call.
 */
const { contextBridge, ipcRenderer } = require('electron');

const cfg = ipcRenderer.sendSync('ui-capture:config');

// The page's clock (main world; the preload's own Date is a different object under context isolation).
contextBridge.executeInMainWorld({
  func: fixed => {
    const RealDate = Date;
    class FrozenDate extends RealDate {
      constructor(...args) { if (args.length) super(...args); else super(fixed); }
      static now() { return fixed; }
    }
    globalThis.Date = FrozenDate;
  },
  args: [cfg.nowMs],
});

/** CSS linear-gradient(deg, ...) over the whole canvas. */
function linear(ctx, w, h, deg, stops) {
  const a = (deg * Math.PI) / 180, dx = Math.sin(a), dy = -Math.cos(a);
  const half = (Math.abs(w * dx) + Math.abs(h * dy)) / 2;
  const g = ctx.createLinearGradient(w / 2 - dx * half, h / 2 - dy * half, w / 2 + dx * half, h / 2 + dy * half);
  for (const [at, color] of stops) g.addColorStop(at, color);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
}

/** CSS radial-gradient(rx ry at cx cy, from 0%, to end), all as fractions of the canvas. */
function radial(ctx, w, h, [rx, ry, cx, cy], from, to, end) {
  ctx.save();
  ctx.translate(cx * w, cy * h);
  ctx.scale(rx * w, ry * h);
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
  g.addColorStop(0, from);
  g.addColorStop(end, to);
  ctx.fillStyle = g;
  ctx.fillRect(-cx / rx, -cy / ry, 1 / rx, 1 / ry);
  ctx.restore();
}

/** The mockup's wallpapers (WP in widget-compact-states.html); layers painted bottom-up. */
const WALLPAPERS = {
  light(ctx, w, h) {
    linear(ctx, w, h, 170, [[0, '#f7f3ee'], [1, '#eef1f7']]);
    radial(ctx, w, h, [0.7, 0.6, 0.55, 1.05], '#e2d6ff', 'rgba(226, 214, 255, 0)', 0.7);
    radial(ctx, w, h, [0.5, 0.65, 0.88, 0.22], '#c4defc', 'rgba(196, 222, 252, 0)', 0.7);
    radial(ctx, w, h, [0.55, 0.7, 0.12, 0.18], '#ffd6bd', 'rgba(255, 214, 189, 0)', 0.7);
  },
  dark(ctx, w, h) {
    linear(ctx, w, h, 180, [[0, '#0b0e18'], [1, '#10131f']]);
    radial(ctx, w, h, [0.55, 0.6, 0.08, 0.92], 'rgba(255, 92, 160, 0.32)', 'rgba(255, 92, 160, 0)', 0.7);
    radial(ctx, w, h, [0.45, 0.6, 0.82, 0.12], 'rgba(92, 112, 255, 0.55)', 'rgba(92, 112, 255, 0)', 0.7);
    ctx.fillStyle = 'rgba(255, 255, 255, 0.75)'; // 1.2 px stars every 74 x 62 px
    for (let y = 22; y < h; y += 62) for (let x = 18; x < w; x += 74) { ctx.beginPath(); ctx.arc(x, y, 1.2, 0, 2 * Math.PI); ctx.fill(); }
  },
  busy(ctx, w, h) {
    const conic = ctx.createConicGradient(((200 - 90) * Math.PI) / 180, 0.38 * w, 0.46 * h);
    ['#ff4e50', '#fc913a', '#f9d423', '#34e89e', '#0f9bff', '#8e54e9', '#ff4e50'].forEach((c, i) => conic.addColorStop(i / 6, c));
    ctx.fillStyle = conic;
    ctx.fillRect(0, 0, w, h);
    // repeating-linear-gradient(118deg, ...): a light and a dark hairline every 39 px along the gradient line.
    const a = (118 * Math.PI) / 180, dx = Math.sin(a), dy = -Math.cos(a);
    const half = (Math.abs(w * dx) + Math.abs(h * dy)) / 2;
    ctx.save();
    ctx.translate(w / 2 - dx * half, h / 2 - dy * half);
    ctx.rotate(Math.atan2(dy, dx));
    for (let s = 0; s < 2 * half; s += 39) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.6)';
      ctx.fillRect(s + 16, -2 * half, 3, 4 * half);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.38)';
      ctx.fillRect(s + 36, -2 * half, 3, 4 * half);
    }
    ctx.restore();
  },
};

let background;
/** What main's glass updater would send: the wallpaper under the widget, or the flat tint. */
function widgetBackground() {
  if (background) return background;
  const { kind, width, height } = cfg.wallpaper;
  if (kind === 'none') return (background = { kind: 'tint' });
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  WALLPAPERS[kind](canvas.getContext('2d'), width, height);
  return (background = { kind: 'image', dataUrl: canvas.toDataURL('image/png') });
}

const noop = () => {};
const soon = fn => { setTimeout(fn, 0); return noop; };
const done = value => Promise.resolve(value);
/** A stubbed result; "pending" never settles, so the page stays in its working state. */
const reply = value => (value === 'pending' ? new Promise(noop) : done(value));
const stubs = cfg.stubs;

contextBridge.exposeInMainWorld('api', {
  getState: () => done(cfg.state),
  onState: () => noop,
  onBackground: cb => soon(() => cb(widgetBackground())),
  listProviders: () => done(stubs.providers),
  listCities: () => done(stubs.cities),
  listStreets: () => done(stubs.streets),
  listHouses: () => done(stubs.houses),
  previewLines: () => done(stubs.previewLines),
  saveAddress: () => done(undefined),
  setWidgetStyle: () => done(undefined),
  setAutostart: () => done(undefined),
  refreshNow: () => done(undefined),
  solveCaptcha: () => done(undefined),
  openMainWindow: noop,
  onNavigate: () => noop,
  widgetContextMenu: noop,
  widgetDrag: noop,
  onMoveMode: cb => (cfg.moveMode ? soon(() => cb(true)) : noop),
  endMoveMode: noop,
  ecoflowTest: () => reply(stubs.ecoflowTest),
  ecoflowScan: () => reply(stubs.ecoflowScan),
  ecoflowPreview: () => reply(stubs.ecoflowPreview),
  ecoflowSave: () => reply(stubs.ecoflowSave),
  actualDisconnect: () => done(undefined),
  openEcoflowHelp: noop,
  openDtekSite: noop,
});
