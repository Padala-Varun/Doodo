import { getStroke } from "perfect-freehand";

/** perfect-freehand options tuned for a whiteboard marker. */
export function markerOptions(size: number, taper = false, last = true) {
  return {
    size,
    thinning: 0.38,
    smoothing: 0.6,
    streamline: 0.35,
    simulatePressure: true,
    start: { taper: taper ? size * 2 : 0, cap: true },
    end: { taper: taper ? size * 2 : 0, cap: true },
    last,
  };
}

/** Outline polygon → smooth closed SVG path (quadratic midpoints). */
export function outlineToPath(points: number[][]): string {
  const n = points.length;
  if (n < 2) return "";
  const r = (v: number) => Math.round(v * 10) / 10;
  let d = `M${r(points[0][0])} ${r(points[0][1])}Q`;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[(i + 1) % n];
    d += `${r(x0)} ${r(y0)} ${r((x0 + x1) / 2)} ${r((y0 + y1) / 2)} `;
  }
  return d + "Z";
}

/** Filled outline path for a marker stroke through `pts`. */
export function inkPath(pts: readonly [number, number][], size: number, taper = false, complete = true): string {
  if (pts.length === 0) return "";
  return outlineToPath(getStroke(pts as [number, number][], markerOptions(size, taper, complete)));
}
