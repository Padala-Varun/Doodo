import type { PathSeg, Point } from "./dml/values";
import type { Box } from "./protocol";

export type { Point, Box };

// ---------------------------------------------------------------------------
// Boxes
// ---------------------------------------------------------------------------

export function boxRight(b: Box): number {
  return b.x + b.w;
}

export function boxBottom(b: Box): number {
  return b.y + b.h;
}

export function boxCenter(b: Box): Point {
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
}

export function inflate(b: Box, d: number): Box {
  return { x: b.x - d, y: b.y - d, w: b.w + 2 * d, h: b.h + 2 * d };
}

export function translateBox(b: Box, dx: number, dy: number): Box {
  return { x: b.x + dx, y: b.y + dy, w: b.w, h: b.h };
}

export function unionBox(a: Box | null, b: Box): Box {
  if (!a) return { ...b };
  const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.w, b.x + b.w), y1 = Math.max(a.y + a.h, b.y + b.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function intersectArea(a: Box, b: Box): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

export function boxesOverlap(a: Box, b: Box, margin = 0): boolean {
  return intersectArea(inflate(a, margin), b) > 0;
}

export function containsPoint(b: Box, p: Point): boolean {
  return p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
}

export function pointsBox(pts: readonly Point[]): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  if (!Number.isFinite(x0)) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Point where the ray from the box centre towards `toward` leaves the box
 * (+ an outward gap). Used for diagram-style connectors.
 */
export function boxBoundaryToward(b: Box, toward: Point, gap = 0): Point {
  const c = boxCenter(b);
  const dx = toward.x - c.x;
  const dy = toward.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const hw = b.w / 2 + gap;
  const hh = b.h / 2 + gap;
  const tx = dx !== 0 ? hw / Math.abs(dx) : Infinity;
  const ty = dy !== 0 ? hh / Math.abs(dy) : Infinity;
  const t = Math.min(tx, ty);
  return { x: c.x + dx * t, y: c.y + dy * t };
}

/** Point on an ellipse inscribed in the box, in the direction of `toward`. */
export function ellipseBoundaryToward(b: Box, toward: Point, gap = 0): Point {
  const c = boxCenter(b);
  const a = Math.atan2(toward.y - c.y, toward.x - c.x);
  return { x: c.x + Math.cos(a) * (b.w / 2 + gap), y: c.y + Math.sin(a) * (b.h / 2 + gap) };
}

// ---------------------------------------------------------------------------
// Points & polylines
// ---------------------------------------------------------------------------

export function dist(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function lerp(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

export function polylineLength(pts: readonly Point[]): number {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += dist(pts[i - 1], pts[i]);
  return L;
}

/** Resample a polyline so consecutive points are ~`spacing` apart. */
export function resample(pts: readonly Point[], spacing: number): Point[] {
  if (pts.length < 2) return pts.slice();
  const out: Point[] = [pts[0]];
  let need = spacing; // distance still to travel before the next sample
  for (let i = 1; i < pts.length; i++) {
    let a = pts[i - 1];
    const b = pts[i];
    let d = dist(a, b);
    while (d >= need && d > 0) {
      a = lerp(a, b, need / d);
      out.push(a);
      d = dist(a, b);
      need = spacing;
    }
    need -= d;
  }
  const last = pts[pts.length - 1];
  if (dist(out[out.length - 1], last) > spacing * 0.25) out.push(last);
  return out;
}

// ---------------------------------------------------------------------------
// Curves
// ---------------------------------------------------------------------------

/** Centripetal-ish Catmull-Rom through points → cubic Bézier segments. */
export function catmullRom(points: readonly Point[], closed: boolean, tension = 0.5): PathSeg[] {
  const n = points.length;
  if (n === 0) return [];
  const segs: PathSeg[] = [{ c: "M", x: points[0].x, y: points[0].y }];
  if (n === 1) return segs;
  if (n === 2 && !closed) {
    segs.push({ c: "L", x: points[1].x, y: points[1].y });
    return segs;
  }
  const get = (i: number): Point => {
    if (closed) return points[((i % n) + n) % n];
    return points[Math.max(0, Math.min(n - 1, i))];
  };
  const count = closed ? n : n - 1;
  const k = tension / 3; // 0.5 tension ~ classic Catmull-Rom (1/6 factor)
  for (let i = 0; i < count; i++) {
    const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
    segs.push({
      c: "C",
      x1: p1.x + (p2.x - p0.x) * k,
      y1: p1.y + (p2.y - p0.y) * k,
      x2: p2.x - (p3.x - p1.x) * k,
      y2: p2.y - (p3.y - p1.y) * k,
      x: p2.x,
      y: p2.y,
    });
  }
  return segs;
}

function cubicAt(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}

function quadAt(p0: number, p1: number, p2: number, t: number): number {
  const u = 1 - t;
  return u * u * p0 + 2 * u * t * p1 + t * t * p2;
}

/** Flatten path segments to polylines (one per subpath), ~`step` px apart. */
export function flatten(segs: readonly PathSeg[], step = 3): Point[][] {
  const out: Point[][] = [];
  let cur: Point[] = [];
  let cx = 0, cy = 0, sx = 0, sy = 0;
  for (const s of segs) {
    switch (s.c) {
      case "M":
        if (cur.length > 1) out.push(cur);
        cur = [{ x: s.x, y: s.y }];
        cx = sx = s.x;
        cy = sy = s.y;
        break;
      case "L":
        if (cur.length === 0) cur.push({ x: cx, y: cy });
        cur.push({ x: s.x, y: s.y });
        cx = s.x;
        cy = s.y;
        break;
      case "C": {
        if (cur.length === 0) cur.push({ x: cx, y: cy });
        const approx = Math.hypot(s.x1 - cx, s.y1 - cy) + Math.hypot(s.x2 - s.x1, s.y2 - s.y1) + Math.hypot(s.x - s.x2, s.y - s.y2);
        const n = Math.max(2, Math.min(200, Math.ceil(approx / step)));
        for (let i = 1; i <= n; i++) {
          const t = i / n;
          cur.push({ x: cubicAt(cx, s.x1, s.x2, s.x, t), y: cubicAt(cy, s.y1, s.y2, s.y, t) });
        }
        cx = s.x;
        cy = s.y;
        break;
      }
      case "Q": {
        if (cur.length === 0) cur.push({ x: cx, y: cy });
        const approx = Math.hypot(s.x1 - cx, s.y1 - cy) + Math.hypot(s.x - s.x1, s.y - s.y1);
        const n = Math.max(2, Math.min(200, Math.ceil(approx / step)));
        for (let i = 1; i <= n; i++) {
          const t = i / n;
          cur.push({ x: quadAt(cx, s.x1, s.x, t), y: quadAt(cy, s.y1, s.y, t) });
        }
        cx = s.x;
        cy = s.y;
        break;
      }
      case "Z":
        if (cur.length > 0) cur.push({ x: sx, y: sy });
        cx = sx;
        cy = sy;
        break;
    }
  }
  if (cur.length > 1) out.push(cur);
  return out;
}

export function mapSegs(segs: readonly PathSeg[], f: (p: Point) => Point): PathSeg[] {
  return segs.map((s) => {
    switch (s.c) {
      case "M":
      case "L": {
        const p = f(s);
        return { c: s.c, x: p.x, y: p.y };
      }
      case "C": {
        const a = f({ x: s.x1, y: s.y1 }), b = f({ x: s.x2, y: s.y2 }), p = f(s);
        return { c: "C", x1: a.x, y1: a.y, x2: b.x, y2: b.y, x: p.x, y: p.y };
      }
      case "Q": {
        const a = f({ x: s.x1, y: s.y1 }), p = f(s);
        return { c: "Q", x1: a.x, y1: a.y, x: p.x, y: p.y };
      }
      case "Z":
        return s;
    }
  });
}

export function polylineD(pts: readonly Point[], closed = false): string {
  if (pts.length === 0) return "";
  let d = `M${r2(pts[0].x)} ${r2(pts[0].y)}`;
  for (let i = 1; i < pts.length; i++) d += `L${r2(pts[i].x)} ${r2(pts[i].y)}`;
  if (closed) d += "Z";
  return d;
}

export function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Deterministic randomness
// ---------------------------------------------------------------------------

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 PRNG → [0, 1) */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
