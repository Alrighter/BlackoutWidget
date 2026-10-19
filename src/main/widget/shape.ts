import type { Rectangle } from 'electron';

/**
 * The card's rounded rectangle as the horizontal strips BrowserWindow.setShape takes (DIP, window coordinates). Each
 * strip spans every pixel the card touches in its rows, so the shape never cuts into the card's anti-aliased edge;
 * rows with the same inset share a strip.
 */
export function roundedShape(width: number, height: number, radius: number): Rectangle[] {
  const r = Math.min(radius, width / 2, height / 2);
  const band = Math.ceil(r);
  const top: Rectangle[] = [];
  for (let y = 0; y < band; y++) {
    // A row reaches furthest out at its lower edge, the one nearer the corner circle's centre.
    const dy = r - Math.min(y + 1, r);
    const inset = Math.floor(r - Math.sqrt(r * r - dy * dy));
    const last = top[top.length - 1];
    if (last && last.x === inset) last.height++;
    else top.push({ x: inset, y, width: width - 2 * inset, height: 1 });
  }
  const bottom = top.map(s => ({ ...s, y: height - s.y - s.height })).reverse();
  const middle = height - 2 * band > 0 ? [{ x: 0, y: band, width, height: height - 2 * band }] : [];
  return [...top, ...middle, ...bottom];
}
