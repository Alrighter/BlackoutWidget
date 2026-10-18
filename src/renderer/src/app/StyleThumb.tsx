import { useId, type ComponentType, type ReactNode } from 'react';
import type { WidgetStyle } from '../../../shared/types';
import { STYLES } from './widget-styles';

/*
 * Style thumbnails (D7): static, simplified drawings of the three widgets, not live widgets (the app and widget
 * bundles don't import each other). Each is drawn in the widget's own px and scaled; the colours are the theme's
 * --bw-* tokens, so a thumbnail follows the system theme. Data: the scenarios main-settings.html shows (compact
 * «on» at 11:50, ring «off» at 17:55, timeline «ecoMatch» at 17:20).
 */

type Cell = 'on' | 'off' | 'maybe';

/** 48 half-hour cells: on, with [fromHour, toHour, kind] spans painted over (the mockup's sched()). */
function day(spans: [number, number, Cell][]): Cell[] {
  const cells = new Array<Cell>(48).fill('on');
  for (const [from, to, kind] of spans) for (let i = from * 2; i < to * 2; i++) cells[i] = kind;
  return cells;
}
const T_A = day([[4, 7.5, 'off'], [15, 19, 'off'], [22, 24, 'maybe']]);
const T_C = day([[12, 14.5, 'off'], [20, 23.5, 'off']]);
const M_A = day([[1, 4.5, 'off'], [11, 14, 'maybe'], [19, 22.5, 'off']]);

/** Fill of cell `i`: an off run is one off-a → off-b gradient along its length, as in the widgets. */
function cellFill(cells: Cell[], i: number, hatch: string): string {
  if (cells[i] === 'on') return 'var(--bw-on)';
  if (cells[i] === 'maybe') return `url(#${hatch})`;
  let s = i; while (s > 0 && cells[s - 1] === 'off') s--;
  let e = i; while (e < 47 && cells[e + 1] === 'off') e++;
  return `color-mix(in srgb, var(--bw-off-a), var(--bw-off-b) ${Math.round(((i - s + 0.5) / (e - s + 1)) * 100)}%)`;
}

/** A day's cells in a row; cells before `past` are dimmed. */
function Strip({ cells, x, y, width, height, past = 0, hatch }: {
  cells: Cell[]; x: number; y: number; width: number; height: number; past?: number; hatch: string;
}) {
  const gap = 1.5;
  const w = (width - gap * 47) / 48;
  return (
    <g>
      {cells.map((_, i) => (
        <rect key={i} x={x + i * (w + gap)} y={y} width={w} height={height} rx={1}
          style={{ fill: cellFill(cells, i, hatch), opacity: i < past ? 0.4 : 1 }} />
      ))}
    </g>
  );
}

/** A grey bar standing in for a line of small text. */
const Bar = ({ x, y, w, h = 8 }: { x: number; y: number; w: number; h?: number }) => (
  <rect className="st-thumb-bar" x={x} y={y} width={w} height={h} rx={h / 2} />
);

/** The glass card with its state tint from the top left (D1), and the state dot. */
function Card({ width, height, radius, tone, uid, children }: {
  width: number; height: number; radius: number; tone: string; uid: string; children: ReactNode;
}) {
  return (
    <>
      <defs>
        <radialGradient id={`${uid}-tint`} cx="0" cy="0" r="1.2">
          <stop offset="0" style={{ stopColor: tone, stopOpacity: 'var(--bw-tint-a)' }} />
          <stop offset="0.6" style={{ stopColor: tone, stopOpacity: 0 }} />
        </radialGradient>
        <pattern id={`${uid}-hatch`} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="5" height="5" style={{ fill: 'rgb(from var(--bw-maybe) r g b / 0.28)' }} />
          <rect width="2.5" height="5" style={{ fill: 'var(--bw-maybe)' }} />
        </pattern>
      </defs>
      <rect className="st-thumb-glass" x="0.5" y="0.5" width={width - 1} height={height - 1} rx={radius} />
      <rect x="0.5" y="0.5" width={width - 1} height={height - 1} rx={radius} fill={`url(#${uid}-tint)`} />
      {children}
    </>
  );
}

const Dot = ({ cx, cy, r, tone }: { cx: number; cy: number; r: number; tone: string }) => (
  <>
    <circle cx={cx} cy={cy} r={r * 1.7} style={{ fill: tone, opacity: 0.2 }} />
    <circle cx={cx} cy={cy} r={r} style={{ fill: tone }} />
  </>
);

function Compact({ uid }: { uid: string }) {
  const nowX = 16 + 258 * (710 / 1440);
  return (
    <Card width={290} height={150} radius={22} tone="var(--bw-on)" uid={uid}>
      <Dot cx={25} cy={31} r={6} tone="var(--bw-on)" />
      <text className="st-thumb-title" x={40} y={39}>Світло є</text>
      <Bar x={16} y={53} w={178} h={9} />
      <Strip cells={T_A} x={16} y={90} width={258} height={22} past={23} hatch={`${uid}-hatch`} />
      <rect className="st-thumb-now" x={nowX - 1} y={86} width={2} height={30} rx={1} />
      <Bar x={16} y={127} w={160} />
    </Card>
  );
}

function Ring({ uid }: { uid: string }) {
  const [cx, cy, r] = [118, 124, 90];
  const nowAngle = (1075 / 1440) * 2 * Math.PI;
  return (
    <Card width={236} height={260} radius={26} tone="var(--bw-off-dot)" uid={uid}>
      {T_A.map((_, i) => (
        <rect key={i} x={cx - 4.5} y={cy - r - 8} width={9} height={16} rx={2.5} transform={`rotate(${(i + 0.5) * 7.5} ${cx} ${cy})`}
          style={{ fill: cellFill(T_A, i, `${uid}-hatch`), opacity: i < 35 ? 0.4 : 1 }} />
      ))}
      <circle className="st-thumb-marker" cx={cx + r * Math.sin(nowAngle)} cy={cy - r * Math.cos(nowAngle)} r={7} />
      <Dot cx={86} cy={96} r={5} tone="var(--bw-off-dot)" />
      <Bar x={97} y={91} w={56} h={10} />
      <text className="st-thumb-count" x={cx} y={146} textAnchor="middle" fontSize={44}>1:05</text>
      <Bar x={74} y={156} w={88} />
      <Bar x={50} y={237} w={136} />
    </Card>
  );
}

function Timeline({ uid }: { uid: string }) {
  const [x0, width] = [110, 274];
  const at = (min: number) => x0 + (width * min) / 1440;
  /** EcoFlow line of the day so far: [fromMin, toMin, power]. */
  const actual: [number, number, string][] = [
    [0, 130, 'rgb(from var(--bw-on) r g b / 0.65)'], [130, 220, 'rgb(from var(--bw-unknown) r g b / 0.6)'],
    [220, 724, 'rgb(from var(--bw-on) r g b / 0.65)'], [724, 872, 'var(--bw-off-dot)'], [872, 1040, 'rgb(from var(--bw-on) r g b / 0.65)'],
  ];
  return (
    <Card width={400} height={200} radius={24} tone="var(--bw-on)" uid={uid}>
      <Dot cx={25} cy={31} r={6} tone="var(--bw-on)" />
      <text className="st-thumb-title" x={40} y={39}>Світло є</text>
      <text className="st-thumb-count" x={384} y={46} textAnchor="end" fontSize={36}>2:40</text>
      <Bar x={16} y={53} w={190} h={9} />
      <Bar x={290} y={57} w={94} h={7} />
      <Bar x={16} y={114} w={56} />
      <Bar x={16} y={144} w={52} />
      <Strip cells={T_C} x={x0} y={110} width={width} height={16} past={34} hatch={`${uid}-hatch`} />
      <rect className="st-thumb-track" x={x0} y={129} width={width} height={4} rx={2} />
      {actual.map(([from, to, fill]) => <rect key={from} x={at(from)} y={129} width={at(to) - at(from)} height={4} style={{ fill }} />)}
      <Strip cells={M_A} x={x0} y={140} width={width} height={16} hatch={`${uid}-hatch`} />
      <rect className="st-thumb-now" x={at(1040) - 1} y={106} width={2} height={30} rx={1} />
      <Bar x={16} y={177} w={220} />
    </Card>
  );
}

const DRAW: Record<WidgetStyle, ComponentType<{ uid: string }>> = { compact: Compact, ring: Ring, timeline: Timeline };

/** The thumbnail at `scale` of the widget's size; it shrinks further to fit a narrower box. */
export function StyleThumb({ style, scale }: { style: WidgetStyle; scale: number }) {
  const uid = `st${useId().replace(/[^\w-]/g, '')}`;
  const [w, h] = STYLES.find(s => s.id === style)!.size;
  const Draw = DRAW[style];
  return (
    <svg className="st-thumb-art" width={w * scale} height={h * scale} viewBox={`0 0 ${w} ${h}`} aria-hidden="true" data-capture={`thumb-${style}`}>
      <Draw uid={uid} />
    </svg>
  );
}
