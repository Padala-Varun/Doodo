import rough from "roughjs";
import { own } from "../own";
import type { Options as RoughOptions } from "roughjs/bin/core";
import {
  BOARD_WIDTH, TEXT_SIZES, type Op, type OpOf, type Placement, type Style,
} from "../dml/ops";
import { PALETTE, parsePathData, pathSegsToD, type PathSeg, type PointOrRef, type Ref } from "../dml/values";
import {
  boxBoundaryToward, boxCenter, catmullRom, dist, ellipseBoundaryToward, flatten, hashString, inflate,
  intersectArea, mapSegs, pointsBox, polylineLength, resample, rng, unionBox, type Box, type Point,
} from "../geom";
import { glyphStrokes, type StrokeFont, type TextLayout } from "../hand/font";
import { compileExpr } from "../math/expr";
import type { Anchor } from "../protocol";
import type { BoardElement, ElementKind, Stroke } from "./types";

export interface CompileEnv {
  font: StrokeFont;
  /** All elements currently on the board (user + doodo), including ones added this lesson. */
  elements: Map<string, BoardElement>;
  anchors: Map<string, Anchor>;
  /** Top of the "screen" this lesson draws on (0 for a fresh board). */
  lessonTop: number;
  /** Where the next un-positioned <write> goes. Mutated by compile(). */
  flow: { x: number; y: number; lastId?: string } | null;
  nextSeq: () => number;
}

export type Compiled =
  | { type: "element"; el: BoardElement }
  | { type: "erase"; ids: string[] }
  | { type: "point"; at: Point; ms: number }
  | { type: "pause"; ms: number }
  | { type: "skip"; reason: string };

const MARGIN = 40;
const RIGHT_LIMIT = BOARD_WIDTH - MARGIN;
const gen = rough.generator();

// ---------------------------------------------------------------------------
// Stroke builders
// ---------------------------------------------------------------------------

function isUnder(s: Stroke): boolean {
  return "z" in s && s.z === "under";
}

function dLength(d: string): number {
  const segs = parsePathData(d);
  if (!segs) return 0;
  return segsLength(segs);
}

function segsLength(segs: readonly PathSeg[]): number {
  let L = 0;
  for (const line of flatten(segs, 4)) L += polylineLength(line);
  return L;
}

function pathStroke(segs: PathSeg[], color: string, width: number, extra: Partial<Extract<Stroke, { t: "path" }>> = {}): Stroke {
  return { t: "path", d: pathSegsToD(segs), color, width, len: segsLength(segs), ...extra };
}

/** Marker stroke through points (already in board coords). */
function ink(points: Point[], color: string, width: number, extra: Partial<Extract<Stroke, { t: "ink" }>> = {}): Stroke | null {
  if (points.length === 0) return null;
  const pts = points.length === 1 ? [points[0], { x: points[0].x + 0.5, y: points[0].y + 0.5 }] : resample(points, 2.5);
  return {
    t: "ink",
    pts: pts.map((p) => [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10] as [number, number]),
    color,
    size: width * 1.45 + 0.8,
    len: Math.max(1, polylineLength(pts)),
    ...extra,
  };
}

function inkSegs(segs: PathSeg[], color: string, width: number, extra: Partial<Extract<Stroke, { t: "ink" }>> = {}): Stroke[] {
  const out: Stroke[] = [];
  for (const line of flatten(segs, 2)) {
    const s = ink(line, color, width, extra);
    if (s) out.push(s);
  }
  return out;
}

function roughOpts(id: string, style: Style, extra: RoughOptions = {}): RoughOptions {
  return {
    seed: (hashString(id) % 2_000_000) + 1,
    roughness: 1.05,
    bowing: 1,
    stroke: style.color,
    strokeWidth: style.width,
    strokeLineDash: style.dash ? [12, 10] : undefined,
    disableMultiStrokeFill: true,
    preserveVertices: false,
    ...extra,
  };
}

/** Outline + optional fill of a rough.js shape, as separate strokes (outline first). */
function roughShape(
  make: (o: RoughOptions) => ReturnType<typeof gen.rectangle>,
  id: string,
  style: Style,
  box: Box,
  extra: RoughOptions = {},
): Stroke[] {
  const out: Stroke[] = [];
  const outline = gen.toPaths(make(roughOpts(id, style, { ...extra, fill: undefined })));
  for (const p of outline) {
    if (p.stroke === "none") continue;
    out.push({ t: "path", d: p.d, color: style.color, width: style.width, len: dLength(p.d), dash: style.dash });
  }
  if (style.fill !== "none") {
    const fillColor = style.fillColor ?? style.color;
    const fillOpts = roughOpts(id + ":fill", style, {
      ...extra,
      stroke: "none",
      fill: fillColor,
      fillStyle: style.fill === "solid" ? "solid" : style.fill,
      hachureGap: 9,
      fillWeight: Math.max(1.2, style.width * 0.55),
    });
    for (const p of gen.toPaths(make(fillOpts))) {
      if (p.fill && p.fill !== "none") out.push({ t: "fill", d: p.d, color: fillColor, opacity: 0.75, box, z: "under" });
      else if (p.stroke && p.stroke !== "none") {
        out.push({ t: "path", d: p.d, color: fillColor, width: Math.max(1.2, style.width * 0.55), len: dLength(p.d), z: "under", opacity: 0.85 });
      }
    }
  }
  return out;
}

function textWidthPx(size: number): number {
  return Math.max(1.7, size * 0.068);
}

/** Handwritten text strokes for a layout placed with its top-left at (x, y). */
function textStrokes(layout: TextLayout, x: number, y: number, color: string, align: "start" | "center" = "start", boxW = layout.width): Stroke[] {
  const out: Stroke[] = [];
  const w = textWidthPx(layout.size);
  for (const line of layout.lines) {
    const dx = align === "center" ? (boxW - line.width) / 2 : 0;
    for (const g of line.glyphs) {
      if (g.glyph) {
        for (const segs of glyphStrokes(g, x + dx, y)) out.push(pathStroke(segs, color, w));
      } else {
        const gx = x + dx + g.x;
        const gy = y + g.y;
        out.push({ t: "text", text: g.char, x: gx, y: gy, size: layout.size * 0.8, color, box: { x: gx, y: gy - layout.ascent, w: g.width, h: layout.size } });
      }
    }
  }
  return out;
}

/** Soft white backing behind text that sits on top of an image, for legibility. */
function halo(box: Box): Stroke {
  const b = inflate(box, 6);
  const r = 10;
  const d =
    `M${b.x + r} ${b.y}L${b.x + b.w - r} ${b.y}Q${b.x + b.w} ${b.y} ${b.x + b.w} ${b.y + r}` +
    `L${b.x + b.w} ${b.y + b.h - r}Q${b.x + b.w} ${b.y + b.h} ${b.x + b.w - r} ${b.y + b.h}` +
    `L${b.x + r} ${b.y + b.h}Q${b.x} ${b.y + b.h} ${b.x} ${b.y + b.h - r}L${b.x} ${b.y + r}Q${b.x} ${b.y} ${b.x + r} ${b.y}Z`;
  return { t: "fill", d, color: "#ffffff", opacity: 0.82, box: b, z: "under" };
}

function arrowHead(tip: Point, from: Point, color: string, width: number): Stroke[] {
  const a = Math.atan2(tip.y - from.y, tip.x - from.x);
  const L = 14 + width * 2.2;
  const spread = (27 * Math.PI) / 180;
  const p1 = { x: tip.x - L * Math.cos(a - spread), y: tip.y - L * Math.sin(a - spread) };
  const p2 = { x: tip.x - L * Math.cos(a + spread), y: tip.y - L * Math.sin(a + spread) };
  const out: Stroke[] = [];
  const s1 = ink([p1, tip], color, width);
  const s2 = ink([tip, p2], color, width);
  if (s1) out.push(s1);
  if (s2) out.push(s2);
  return out;
}

/** A natural hand-drawn loop around a box (slightly more than one turn, wobbly). */
function handLoop(box: Box, seedKey: string, color: string, width: number): Stroke | null {
  const r = rng(hashString(seedKey));
  const c = boxCenter(box);
  const rx = box.w / 2;
  const ry = box.h / 2;
  const start = -Math.PI * (0.55 + r() * 0.2);
  const turns = 1.08 + r() * 0.05;
  const n = 64;
  const ph1 = r() * Math.PI * 2, ph2 = r() * Math.PI * 2;
  const pts: Point[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = start + t * turns * Math.PI * 2;
    const wob = 1 + 0.035 * Math.sin(a * 2 + ph1) + 0.02 * Math.sin(a * 3 + ph2) + t * 0.04;
    pts.push({ x: c.x + Math.cos(a) * rx * wob, y: c.y + Math.sin(a) * ry * wob });
  }
  const segs = catmullRom(pts, false);
  const flat = flatten(segs, 2)[0] ?? pts;
  return ink(flat, color, width);
}

function wobblyLine(a: Point, b: Point, seedKey: string, amp = 1.2): Point[] {
  const r = rng(hashString(seedKey));
  const L = dist(a, b);
  const n = Math.max(2, Math.ceil(L / 60));
  const nx = -(b.y - a.y) / (L || 1), ny = (b.x - a.x) / (L || 1);
  const pts: Point[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const off = i === 0 || i === n ? 0 : (r() - 0.5) * 2 * amp;
    pts.push({ x: a.x + (b.x - a.x) * t + nx * off, y: a.y + (b.y - a.y) * t + ny * off });
  }
  return flatten(catmullRom(pts, false), 2)[0] ?? pts;
}

// ---------------------------------------------------------------------------
// Reference resolution
// ---------------------------------------------------------------------------

interface Target {
  box: Box;
  /** Exact point if the ref had a sub-anchor (or the target is point-like). */
  point?: Point;
  /** Outward normal at `point` when known (polygon edges). */
  normal?: Point;
  outline: "box" | "ellipse";
  isImageAnchor: boolean;
  elementId?: string;
}

function lookup(ref: Ref, env: CompileEnv): { el?: BoardElement; anchor?: Anchor } | null {
  if (ref.ns === "anchor") {
    const a = env.anchors.get(ref.id);
    if (a) return { anchor: a };
    const el = env.elements.get(ref.id);
    if (el) return { el };
  } else {
    const el = env.elements.get(ref.id);
    if (el) return { el };
    const a = env.anchors.get(ref.id);
    if (a) return { anchor: a };
  }
  return null;
}

function boxPoint(b: Box, sub: string): Point | null {
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  switch (sub) {
    case "center": case "c": case "middle": return { x: cx, y: cy };
    case "top": case "n": return { x: cx, y: b.y };
    case "bottom": case "s": return { x: cx, y: b.y + b.h };
    case "left": case "w": return { x: b.x, y: cy };
    case "right": case "e": return { x: b.x + b.w, y: cy };
    case "top-left": case "tl": case "nw": return { x: b.x, y: b.y };
    case "top-right": case "tr": case "ne": return { x: b.x + b.w, y: b.y };
    case "bottom-left": case "bl": case "sw": return { x: b.x, y: b.y + b.h };
    case "bottom-right": case "br": case "se": return { x: b.x + b.w, y: b.y + b.h };
    default: return null;
  }
}

const SUB_NORMALS: Record<string, Point> = {
  top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 },
  "top-left": { x: -0.7071, y: -0.7071 }, "top-right": { x: 0.7071, y: -0.7071 },
  "bottom-left": { x: -0.7071, y: 0.7071 }, "bottom-right": { x: 0.7071, y: 0.7071 },
};

function resolveTarget(ref: Ref, env: CompileEnv): Target | null {
  const hit = lookup(ref, env);
  if (!hit) return null;
  const box = hit.el ? hit.el.box : hit.anchor!.box;
  const outline: Target["outline"] = hit.el?.outline ?? (hit.anchor && hit.anchor.kind === "object" ? "ellipse" : "box");
  const t: Target = { box, outline, isImageAnchor: !!hit.anchor && hit.anchor.kind !== "user", elementId: hit.el?.id };
  if (ref.sub) {
    const named = hit.el?.points ? own(hit.el.points, ref.sub) : undefined;
    const p = named ?? boxPoint(box, ref.sub);
    if (p) {
      t.point = p;
      const n = (hit.el?.normals ? own(hit.el.normals, ref.sub) : undefined) ?? own(SUB_NORMALS, ref.sub);
      if (n) t.normal = n;
      else if (named) {
        // Normal = from element centre to the point.
        const c = boxCenter(box);
        const L = dist(c, p);
        if (L > 1) t.normal = { x: (p.x - c.x) / L, y: (p.y - c.y) / L };
      }
    }
  }
  return t;
}

function resolvePoint(por: PointOrRef, env: CompileEnv): Point | null {
  if (por.kind === "point") return por.point;
  const t = resolveTarget(por.ref, env);
  if (!t) return null;
  return t.point ?? boxCenter(t.box);
}

// ---------------------------------------------------------------------------
// Placement & collision avoidance
// ---------------------------------------------------------------------------

type Obstacle = { box: Box; image: boolean; textual: boolean; id: string };

function obstacles(env: CompileEnv, ignore: ReadonlySet<string>, textOnly = false): Obstacle[] {
  const out: Obstacle[] = [];
  for (const el of env.elements.values()) {
    if (ignore.has(el.id) || el.passive) continue;
    if (textOnly && !el.textual) continue;
    const image = el.kind === "image";
    const textual = !!el.textual;
    for (const box of el.occupied ?? [el.box]) out.push({ box, image, textual, id: el.id });
  }
  return out;
}

function overlapCost(b: Box, obs: Obstacle[], imageWeight: number, textWeight = 1): number {
  let cost = 0;
  const pad = inflate(b, 8);
  for (const o of obs) {
    const a = intersectArea(pad, o.box);
    if (a > 0) cost += a * (o.image ? imageWeight : o.textual ? textWeight : 1);
  }
  return cost;
}

function inBoard(b: Box): boolean {
  return b.x >= 12 && b.x + b.w <= BOARD_WIDTH - 12 && b.y >= 4;
}

/**
 * Keep a new sized element from landing on existing content.
 *  - "flow": like writing down the board — slide down (then right) to the first free spot.
 *  - "explicit": the model chose the position, so only avoid other *text*, with the
 *    smallest nudge in any direction (a label inside a drawn box stays inside it).
 */
function avoid(box: Box, env: CompileEnv, ignore: ReadonlySet<string>, mode: "flow" | "explicit" = "flow"): Box {
  if (mode === "explicit") {
    const obs = obstacles(env, ignore, true);
    if (overlapCost(box, obs, 1) === 0) return box;
    const dirs = [[0, 1], [1, 0], [0, -1], [-1, 0], [0.7, 0.7], [-0.7, 0.7], [0.7, -0.7], [-0.7, -0.7]];
    for (let r = 10; r <= 420; r += 10) {
      for (const [dx, dy] of dirs) {
        const b = { ...box, x: box.x + dx * r, y: box.y + dy * r };
        if (inBoard(b) && overlapCost(b, obs, 1) === 0) return b;
      }
    }
    return box;
  }
  const obs = obstacles(env, ignore);
  if (overlapCost(box, obs, 1) === 0) return box;
  // Prefer free space outside images; accept overlapping an image only as a last resort.
  for (const imageWeight of [1, 0]) {
    for (let dy = 16; dy <= 640; dy += 16) {
      const b = { ...box, y: box.y + dy };
      if (overlapCost(b, obs, imageWeight) === 0) return b;
    }
    for (let dx = 24; dx <= 600; dx += 24) {
      const b = { ...box, x: box.x + dx };
      if (b.x + b.w > RIGHT_LIMIT) break;
      if (overlapCost(b, obs, imageWeight) === 0) return b;
    }
  }
  return box;
}

/** Small boxes along a polyline, so thin diagonal strokes don't block their whole bounding box. */
function pathOccupancy(pts: Point[], width: number): Box[] {
  const out: Box[] = [];
  const dense = resample(pts, 22);
  const r = width / 2 + 5;
  for (const p of dense) out.push({ x: p.x - r, y: p.y - r, w: 2 * r, h: 2 * r });
  return out;
}

function regionOrigin(at: NonNullable<Placement["at"]>, w: number, h: number, top: number): Point {
  const screenH = 900;
  switch (at) {
    case "top": return { x: (BOARD_WIDTH - w) / 2, y: top + 32 };
    case "top-left": return { x: 60, y: top + 32 };
    case "top-right": return { x: RIGHT_LIMIT - w, y: top + 32 };
    case "left": return { x: 60, y: top + (screenH - h) / 2 };
    case "center": return { x: (BOARD_WIDTH - w) / 2, y: top + (screenH - h) / 2 };
    case "right": return { x: RIGHT_LIMIT - w, y: top + (screenH - h) / 2 };
    case "bottom": return { x: (BOARD_WIDTH - w) / 2, y: top + screenH - 60 - h };
    case "bottom-left": return { x: 60, y: top + screenH - 60 - h };
    case "bottom-right": return { x: RIGHT_LIMIT - w, y: top + screenH - 60 - h };
    case "left-panel": return { x: 60, y: top + 140 };
    case "right-panel": return { x: 860, y: top + 140 };
  }
}

/**
 * Resolve where a w×h element goes. Returns the top-left and whether the
 * position was explicit (explicit positions are respected exactly).
 */
function place(p: Placement, w: number, h: number, env: CompileEnv): { x: number; y: number; explicit: boolean } {
  const gap = p.gap;
  const alignX = (ref: Box) => (p.align === "center" ? ref.x + (ref.w - w) / 2 : p.align === "end" ? ref.x + ref.w - w : ref.x);
  const alignY = (ref: Box) => (p.align === "center" ? ref.y + (ref.h - h) / 2 : p.align === "end" ? ref.y + ref.h - h : ref.y);
  const rel = (r: Ref | undefined) => (r ? resolveTarget(r, env) : null);

  const below = rel(p.below), above = rel(p.above), rightOf = rel(p.rightOf), leftOf = rel(p.leftOf);
  let x: number | undefined = p.x;
  let y: number | undefined = p.y;
  if (below) {
    y ??= below.box.y + below.box.h + (gap ?? 24);
    x ??= alignX(below.box);
  }
  if (above) {
    y ??= above.box.y - (gap ?? 24) - h;
    x ??= alignX(above.box);
  }
  if (rightOf) {
    x ??= rightOf.box.x + rightOf.box.w + (gap ?? 36);
    y ??= alignY(rightOf.box);
  }
  if (leftOf) {
    x ??= leftOf.box.x - (gap ?? 36) - w;
    y ??= alignY(leftOf.box);
  }
  if ((x === undefined || y === undefined) && p.at) {
    const o = regionOrigin(p.at, w, h, env.lessonTop);
    x ??= o.x;
    y ??= o.y;
  }
  const explicit = p.x !== undefined && p.y !== undefined;
  if (x === undefined || y === undefined) {
    const f = env.flow ?? { x: 80, y: env.lessonTop + 130 };
    x ??= f.x;
    y ??= f.y;
  }
  // Keep inside the board horizontally.
  if (x + w > RIGHT_LIMIT) x = Math.max(MARGIN, RIGHT_LIMIT - w);
  if (x < MARGIN / 2) x = MARGIN / 2;
  if (y < 10) y = 10;
  return { x, y, explicit };
}

function imageUnder(box: Box, env: CompileEnv): boolean {
  for (const el of env.elements.values()) if (el.kind === "image" && intersectArea(box, el.box) > 0) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Element factory
// ---------------------------------------------------------------------------

function strokesBox(strokes: Stroke[], fallback: Box | null = null): Box {
  let b: Box | null = fallback;
  for (const s of strokes) {
    switch (s.t) {
      case "ink": {
        const pts = s.pts.map(([x, y]) => ({ x, y }));
        b = unionBox(b, inflate(pointsBox(pts), s.size / 2));
        break;
      }
      case "path": {
        const segs = parsePathData(s.d);
        if (segs) b = unionBox(b, inflate(pointsBox(flatten(segs, 6).flat()), s.width / 2));
        break;
      }
      case "fill": case "svg": case "text": case "image":
        b = unionBox(b, s.box);
        break;
    }
  }
  return b ?? { x: 0, y: 0, w: 0, h: 0 };
}

function element(
  env: CompileEnv, id: string, kind: ElementKind, strokes: Stroke[],
  extra: Partial<BoardElement> = {},
): Compiled {
  const box = extra.box ?? strokesBox(strokes);
  return { type: "element", el: { id, author: "doodo", kind, strokes, seq: env.nextSeq(), ...extra, box } };
}

// ---------------------------------------------------------------------------
// Per-op compilers
// ---------------------------------------------------------------------------

function compileWrite(op: OpOf<"write">, env: CompileEnv): Compiled {
  const font = env.font;
  let layout = font.layout(op.text, op.size, op.maxWidth ?? 1200);
  let pos = place(op.place, layout.width, layout.height, env);
  const maxW = Math.max(240, RIGHT_LIMIT - pos.x);
  if (layout.width > maxW) {
    layout = font.layout(op.text, op.size, maxW);
    pos = place(op.place, layout.width, layout.height, env);
  }
  let box: Box = { x: pos.x, y: pos.y, w: layout.width, h: layout.height };
  box = avoid(box, env, new Set([op.id]), pos.explicit ? "explicit" : "flow");
  const strokes = textStrokes(layout, box.x, box.y, op.style.color);
  if (imageUnder(box, env)) strokes.unshift(halo(box));
  env.flow = { x: box.x, y: box.y + box.h + Math.round(op.size * 0.45), lastId: op.id };
  return element(env, op.id, "write", strokes, { box, text: op.text, textual: true });
}

function shapeStrokes(id: string, kind: "rect" | "round" | "ellipse" | "diamond", b: Box, style: Style, roughness = 1): Stroke[] {
  switch (kind) {
    case "rect":
      return roughShape((o) => gen.rectangle(b.x, b.y, b.w, b.h, o), id, style, b, { roughness });
    case "ellipse":
      return roughShape((o) => gen.ellipse(b.x + b.w / 2, b.y + b.h / 2, b.w, b.h, o), id, style, b, { roughness });
    case "diamond":
      return roughShape(
        (o) => gen.polygon([[b.x + b.w / 2, b.y], [b.x + b.w, b.y + b.h / 2], [b.x + b.w / 2, b.y + b.h], [b.x, b.y + b.h / 2]], o),
        id, style, b, { roughness },
      );
    case "round": {
      const r = Math.min(18, b.w / 4, b.h / 4);
      const d =
        `M${b.x + r} ${b.y} L${b.x + b.w - r} ${b.y} Q${b.x + b.w} ${b.y} ${b.x + b.w} ${b.y + r} ` +
        `L${b.x + b.w} ${b.y + b.h - r} Q${b.x + b.w} ${b.y + b.h} ${b.x + b.w - r} ${b.y + b.h} ` +
        `L${b.x + r} ${b.y + b.h} Q${b.x} ${b.y + b.h} ${b.x} ${b.y + b.h - r} L${b.x} ${b.y + r} Q${b.x} ${b.y} ${b.x + r} ${b.y} Z`;
      return roughShape((o) => gen.path(d, o), id, style, b, { roughness: roughness * 0.8 });
    }
  }
}

function compileShape(op: OpOf<"shape">, env: CompileEnv): Compiled {
  const font = env.font;
  let layout: TextLayout | null = null;
  let w = op.w, h = op.h;
  if (op.text) {
    const inner = w ? Math.max(60, w - 28) : 380;
    layout = font.layout(op.text, op.size, inner);
    const k = op.kind === "ellipse" ? 1.42 : op.kind === "diamond" ? 1.9 : 1;
    w ??= Math.max(op.kind === "ellipse" ? 90 : 80, layout.width * k + 36);
    h ??= Math.max(op.kind === "ellipse" ? 64 : 52, layout.height * k + 26);
  }
  if (w === undefined || h === undefined) return { type: "skip", reason: "shape without size" };
  const pos = place(op.place, w, h, env);
  let box: Box = { x: pos.x, y: pos.y, w, h };
  if (!pos.explicit) box = avoid(box, env, new Set([op.id]));
  else if (layout) box = avoid(box, env, new Set([op.id]), "explicit");
  const strokes = shapeStrokes(op.id, op.kind, box, op.style, layout ? 0.9 : 1.05);
  if (layout) {
    const tx = box.x + (box.w - layout.width) / 2;
    const ty = box.y + (box.h - layout.height) / 2;
    strokes.push(...textStrokes(layout, tx, ty, op.style.color, "center", layout.width));
  }
  if (!pos.explicit && layout) env.flow = { x: box.x, y: box.y + box.h + 20, lastId: op.id };
  return element(env, op.id, "shape", strokes, {
    box, text: op.text, outline: op.kind === "ellipse" ? "ellipse" : "box", textual: !!layout,
  });
}

function compileEnclose(op: OpOf<"enclose">, env: CompileEnv): Compiled {
  const t = resolveTarget(op.target, env);
  if (!t) return { type: "skip", reason: `unknown target ${op.target.id}` };
  let b = t.point ? { x: t.point.x - 14, y: t.point.y - 14, w: 28, h: 28 } : t.box;
  const color = op.style.color;
  const width = Math.max(2.5, op.style.width);
  if (op.kind === "circle") {
    // An ellipse that comfortably contains the box: scale by ~√2 on the short side.
    const pad = op.pad;
    const rx = b.w / 2 * 1.16 + pad;
    const ry = Math.max(b.h / 2 * 1.32 + pad, b.h / 2 + pad + 8);
    const c = boxCenter(b);
    const loopBox = { x: c.x - rx, y: c.y - ry, w: rx * 2, h: ry * 2 };
    const s = handLoop(loopBox, op.id, color, width);
    if (!s) return { type: "skip", reason: "degenerate loop" };
    return element(env, op.id, "enclose", [s], { outline: "ellipse", passive: true });
  }
  b = inflate(b, op.pad);
  const strokes = roughShape((o) => gen.rectangle(b.x, b.y, b.w, b.h, o), op.id, { ...op.style, width, fill: "none" }, b, { roughness: 1.3 });
  return element(env, op.id, "enclose", strokes, { outline: "box", passive: true });
}

function endpointTarget(por: PointOrRef, env: CompileEnv): { p: Point; target?: Target } | null {
  if (por.kind === "point") return { p: por.point };
  const t = resolveTarget(por.ref, env);
  if (!t) return null;
  return { p: t.point ?? boxCenter(t.box), target: t.point ? undefined : t };
}

function attach(end: { p: Point; target?: Target }, toward: Point, gap: number): Point {
  if (!end.target) return end.p;
  return end.target.outline === "ellipse"
    ? ellipseBoundaryToward(end.target.box, toward, gap)
    : boxBoundaryToward(end.target.box, toward, gap);
}

function linePath(a: Point, b: Point, curve: number, seedKey: string): { pts: Point[]; mid: Point; ctrl: Point | null } {
  const L = dist(a, b);
  if (curve === 0) {
    return { pts: wobblyLine(a, b, seedKey, Math.min(1.5, L / 150)), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, ctrl: null };
  }
  const nx = -(b.y - a.y) / L, ny = (b.x - a.x) / L;
  const k = curve * L * 0.45;
  const c = { x: (a.x + b.x) / 2 + nx * k, y: (a.y + b.y) / 2 + ny * k };
  const pts = flatten([{ c: "M", x: a.x, y: a.y }, { c: "Q", x1: c.x, y1: c.y, x: b.x, y: b.y }], 2)[0];
  return { pts, mid: { x: 0.25 * a.x + 0.5 * c.x + 0.25 * b.x, y: 0.25 * a.y + 0.5 * c.y + 0.25 * b.y }, ctrl: c };
}

/** How badly a path runs through other content (samples inside obstacle boxes). */
function crossings(pts: Point[], obs: Obstacle[]): number {
  let hits = 0;
  const dense = resample(pts, 10);
  // Skip samples next to the endpoints: they sit on the endpoints' own boundaries.
  for (let i = 3; i < dense.length - 3; i++) {
    const p = dense[i];
    for (const o of obs) {
      if (o.image) continue;
      const b = o.box;
      if (p.x > b.x - 3 && p.x < b.x + b.w + 3 && p.y > b.y - 3 && p.y < b.y + b.h + 3) {
        hits += o.textual ? 2 : 1;
        break;
      }
    }
  }
  return hits;
}

function compileLine(op: OpOf<"line">, env: CompileEnv): Compiled {
  const a0 = endpointTarget(op.from, env);
  const b0 = endpointTarget(op.to, env);
  if (!a0 || !b0) return { type: "skip", reason: "unknown line endpoint" };
  const a = attach(a0, b0.p, 8);
  const b = attach(b0, a0.p, op.heads === "end" || op.heads === "both" ? 6 : 8);
  const L = dist(a, b);
  if (L < 4) return { type: "skip", reason: "zero-length line" };
  const color = op.style.color;
  const width = op.style.width;

  // Route: try the requested bend first, then alternatives; keep the one that crosses least.
  const ignore = new Set<string>([op.id]);
  for (const end of [op.from, op.to]) {
    if (end.kind === "ref") {
      const t = resolveTarget(end.ref, env);
      if (t?.elementId) ignore.add(t.elementId);
    }
  }
  const obs = obstacles(env, ignore);
  const curves = [op.curve, ...[0, 0.22, -0.22, 0.4, -0.4].filter((c) => c !== op.curve)];
  let route = linePath(a, b, curves[0], op.id);
  let best = crossings(route.pts, obs);
  for (const c of curves.slice(1)) {
    if (best === 0) break;
    const r = linePath(a, b, c, op.id);
    const h = crossings(r.pts, obs);
    if (h < best) {
      best = h;
      route = r;
    }
  }
  const { pts: pathPts, mid } = route;
  const tangentEnd = route.ctrl ?? a;
  const tangentStart = route.ctrl ?? b;

  const strokes: Stroke[] = [];
  if (op.style.dash) {
    const dense = resample(pathPts, 3);
    for (let i = 0; i < dense.length; i += 8) {
      const s = ink(dense.slice(i, i + 5), color, width);
      if (s) strokes.push(s);
    }
  } else {
    const s = ink(pathPts, color, width);
    if (s) strokes.push(s);
  }
  if (op.heads === "end" || op.heads === "both") strokes.push(...arrowHead(b, tangentEnd, color, width));
  if (op.heads === "start" || op.heads === "both") strokes.push(...arrowHead(a, tangentStart, color, width));

  const occupied = pathOccupancy(pathPts, width);
  const points: Record<string, Point> = { start: a, end: b, mid };
  if (op.label) {
    const layout = env.font.layout(op.label, op.size, 300);
    const lw = layout.width, lh = layout.height;
    const dense = resample(pathPts, 4);
    const at = (t: number) => dense[Math.min(dense.length - 1, Math.max(0, Math.round(t * (dense.length - 1))))];
    const allObs = obstacles(env, new Set([op.id]));
    let bestBox: Box | null = null;
    let bestCost = Infinity;
    [0.5, 0.4, 0.6, 0.3, 0.7].forEach((t, ti) => {
      const p = at(t);
      const q = at(Math.min(1, t + 0.02));
      const dx = q.x - p.x, dy = q.y - p.y;
      const dl = Math.hypot(dx, dy) || 1;
      const nx = -dy / dl, ny = dx / dl;
      for (const sgn of [1, -1]) {
        const off = 12 + Math.abs(nx) * lw / 2 + Math.abs(ny) * lh / 2;
        const c = { x: p.x + nx * off * sgn - lw / 2, y: p.y + ny * off * sgn - lh / 2, w: lw, h: lh };
        if (!inBoard(c)) continue;
        let cost = overlapCost(c, allObs, 0.5, 4) + ti * 40;
        for (const o of occupied) cost += intersectArea(c, o) * 2;
        if (cost < bestCost) {
          bestCost = cost;
          bestBox = c;
        }
      }
    });
    const lb: Box = bestBox ?? { x: mid.x - lw / 2, y: mid.y - lh - 10, w: lw, h: lh };
    if (imageUnder(lb, env)) strokes.push(halo(lb));
    strokes.push(...textStrokes(layout, lb.x, lb.y, color));
    occupied.push(lb);
  }
  return element(env, op.id, "line", strokes, { points, text: op.label, occupied, textual: !!op.label });
}

function compilePoly(op: OpOf<"poly">, env: CompileEnv): Compiled {
  const pts = op.points;
  const color = op.style.color;
  const strokes: Stroke[] = [];
  const box = pointsBox(pts);
  if (op.closed && !op.smooth) {
    strokes.push(...roughShape((o) => gen.polygon(pts.map((p) => [p.x, p.y] as [number, number]), o), op.id, op.style, box, { roughness: 0.9 }));
  } else if (op.smooth) {
    const segs = catmullRom(pts, op.closed);
    strokes.push(...inkSegs(segs, color, op.style.width));
    if (op.closed && op.style.fill !== "none") {
      const flat = flatten(segs, 4)[0] ?? pts;
      strokes.push(...roughShape((o) => gen.polygon(flat.map((p) => [p.x, p.y] as [number, number]), o), op.id, { ...op.style }, box).filter(isUnder));
    }
  } else {
    const s = ink(pts, color, op.style.width);
    if (s) strokes.push(s);
  }
  if (!op.closed && pts.length >= 2) {
    const n = pts.length;
    if (op.heads === "end" || op.heads === "both") strokes.push(...arrowHead(pts[n - 1], pts[n - 2], color, op.style.width));
    if (op.heads === "start" || op.heads === "both") strokes.push(...arrowHead(pts[0], pts[1], color, op.style.width));
  }
  const points: Record<string, Point> = {};
  const normals: Record<string, Point> = {};
  const centroid = { x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length };
  pts.forEach((p, i) => {
    points[`p${i}`] = p;
    const L = dist(centroid, p);
    if (L > 0) normals[`p${i}`] = { x: (p.x - centroid.x) / L, y: (p.y - centroid.y) / L };
  });
  if (op.names) {
    const names = op.names;
    names.forEach((nm, i) => {
      if (i >= pts.length) return;
      points[nm] = pts[i];
      normals[nm] = normals[`p${i}`];
      const j = (i + 1) % pts.length;
      const q = pts[j];
      const edge = nm + (names[j] ?? `p${j}`);
      const m = { x: (pts[i].x + q.x) / 2, y: (pts[i].y + q.y) / 2 };
      points[edge] = m;
      points[(names[j] ?? `p${j}`) + nm] = m;
      // Outward normal: perpendicular to the edge, pointing away from the centroid.
      const ex = q.x - pts[i].x, ey = q.y - pts[i].y;
      const EL = Math.hypot(ex, ey) || 1;
      let nx = -ey / EL, ny = ex / EL;
      if ((m.x - centroid.x) * nx + (m.y - centroid.y) * ny < 0) {
        nx = -nx;
        ny = -ny;
      }
      normals[edge] = { x: nx, y: ny };
      normals[(names[j] ?? `p${j}`) + nm] = { x: nx, y: ny };
    });
  }
  if (op.rightAngle && points[op.rightAngle]) {
    const i = op.names ? op.names.indexOf(op.rightAngle) : -1;
    if (i >= 0) {
      const v = pts[i];
      const p1 = pts[(i + 1) % pts.length], p2 = pts[(i + pts.length - 1) % pts.length];
      const u1 = { x: (p1.x - v.x) / (dist(v, p1) || 1), y: (p1.y - v.y) / (dist(v, p1) || 1) };
      const u2 = { x: (p2.x - v.x) / (dist(v, p2) || 1), y: (p2.y - v.y) / (dist(v, p2) || 1) };
      const s = 24;
      const sq = ink(
        [{ x: v.x + u1.x * s, y: v.y + u1.y * s }, { x: v.x + (u1.x + u2.x) * s, y: v.y + (u1.y + u2.y) * s }, { x: v.x + u2.x * s, y: v.y + u2.y * s }],
        color, Math.max(1.5, op.style.width * 0.7),
      );
      if (sq) strokes.push(sq);
    }
  }
  return element(env, op.id, "poly", strokes, { points, normals, outline: "box" });
}

function compilePath(op: OpOf<"path">, env: CompileEnv): Compiled {
  const strokes = inkSegs(op.segs, op.style.color, op.style.width);
  if (op.style.fill !== "none") {
    const d = pathSegsToD(op.segs);
    const box = pointsBox(flatten(op.segs, 4).flat());
    strokes.push(...roughShape((o) => gen.path(d, o), op.id, op.style, box).filter(isUnder));
  }
  return element(env, op.id, "path", strokes);
}

function compileSketch(op: OpOf<"sketch">, env: CompileEnv): Compiled {
  const pos = place(op.place, op.w, op.h, env);
  const frame = { x: pos.x, y: pos.y, w: op.w, h: op.h };
  const map = (p: Point): Point => ({ x: frame.x + (p.x / 100) * frame.w, y: frame.y + (p.y / 100) * frame.h });
  const outlines: Stroke[] = [];
  const fills: Stroke[] = [];
  op.strokes.forEach((s, i) => {
    const color = s.color ?? op.style.color;
    const width = s.width ?? op.style.width;
    let segs: PathSeg[];
    if (s.segs) segs = mapSegs(s.segs, map);
    else {
      const pts = s.points!.map(map);
      segs = pts.length >= 3 ? catmullRom(pts, s.closed, 0.5) : [{ c: "M", x: pts[0].x, y: pts[0].y }, ...pts.slice(1).map((p) => ({ c: "L" as const, x: p.x, y: p.y }))];
      if (pts.length === 1) segs = [{ c: "M", x: pts[0].x, y: pts[0].y }, { c: "L", x: pts[0].x + 0.5, y: pts[0].y + 0.5 }];
    }
    outlines.push(...inkSegs(segs, color, width));
    const fill = s.fill ?? "none";
    if (fill !== "none") {
      const flat = flatten(segs, 4)[0];
      if (flat && flat.length >= 3) {
        const box = pointsBox(flat);
        const style: Style = { color, width, fill, fillColor: s.fillColor ?? color, dash: false };
        fills.push(...roughShape((o) => gen.polygon(flat.map((p) => [p.x, p.y] as [number, number]), o), `${op.id}:${i}`, style, box).filter(isUnder));
      }
    }
  });
  // Outline first, then shading (drawn underneath).
  const strokes = [...outlines, ...fills];
  return element(env, op.id, "sketch", strokes, { box: strokesBox(strokes) });
}

/** Candidate label boxes around a target, best first. */
function labelCandidates(t: Target, w: number, h: number, side: string | undefined, distances: number[]): Box[] {
  const dirs: Record<string, Point> = {
    right: { x: 1, y: 0 }, left: { x: -1, y: 0 }, top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 },
    "top-right": { x: 0.7071, y: -0.7071 }, "top-left": { x: -0.7071, y: -0.7071 },
    "bottom-right": { x: 0.7071, y: 0.7071 }, "bottom-left": { x: -0.7071, y: 0.7071 },
  };
  let order = Object.keys(dirs);
  if (side && own(dirs, side)) order = [side];
  else if (t.normal) {
    const n = t.normal;
    order.sort((a, b) => (dirs[b].x * n.x + dirs[b].y * n.y) - (dirs[a].x * n.x + dirs[a].y * n.y));
  }
  const out: Box[] = [];
  const base = t.point ? { x: t.point.x, y: t.point.y, w: 0, h: 0 } : t.box;
  for (const d of distances) {
    for (const k of order) {
      const v = dirs[k];
      // Anchor point on the target boundary in direction v, then offset label so its near edge is `d` away.
      const c = boxCenter(base);
      const edge = { x: c.x + v.x * base.w / 2, y: c.y + v.y * base.h / 2 };
      const ext = Math.abs(v.x) * w / 2 + Math.abs(v.y) * h / 2;
      const cx = edge.x + v.x * (d + ext);
      const cy = edge.y + v.y * (d + ext);
      out.push({ x: cx - w / 2, y: cy - h / 2, w, h });
    }
  }
  return out;
}

function segmentHitsBox(a: Point, b: Point, box: Box): boolean {
  const n = 12;
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t;
    if (x > box.x && x < box.x + box.w && y > box.y && y < box.y + box.h) return true;
  }
  return false;
}

function compileLabel(op: OpOf<"label">, env: CompileEnv): Compiled {
  const t = resolveTarget(op.target, env);
  if (!t) return { type: "skip", reason: `unknown target ${op.target.id}` };
  const layout = env.font.layout(op.text, op.size, 360);
  const ignore = new Set<string>(t.elementId ? [t.elementId] : []);
  const obs = obstacles(env, ignore);
  const dists = t.point ? [10, 26, 48] : [12, 30, 56];
  const cands = labelCandidates(t, layout.width, layout.height, op.side, dists);
  let best = cands[0];
  let bestCost = Infinity;
  const consider = (c: Box, penalty: number) => {
    // Text on text is the worst outcome; overlapping plain ink is tolerable.
    let cost = overlapCost(c, obs, 0.25, 6) + penalty;
    if (c.x < 10 || c.x + c.w > BOARD_WIDTH - 10 || c.y < 5) cost += 1e9;
    // Don't sit on the target element's own ink (polygon interior is fine to avoid via box when no point).
    if (!t.point) cost += intersectArea(c, t.box) * 4;
    if (cost < bestCost) {
      bestCost = cost;
      best = c;
    }
  };
  cands.forEach((c, i) => consider(c, i * 6));
  // The requested side is blocked: fall back to the best other side rather than overprint.
  if (op.side && bestCost > 400) {
    labelCandidates(t, layout.width, layout.height, undefined, dists).forEach((c, i) => consider(c, 400 + i * 6));
  }
  const strokes = textStrokes(layout, best.x, best.y, op.style.color);
  if (imageUnder(best, env)) strokes.unshift(halo(best));
  return element(env, op.id, "label", strokes, { box: best, text: op.text, textual: true });
}

function compileCallout(op: OpOf<"callout">, env: CompileEnv): Compiled {
  const t = resolveTarget(op.target, env);
  if (!t) return { type: "skip", reason: `unknown target ${op.target.id}` };
  const layout = env.font.layout(op.text, op.size, 380);
  const w = layout.width, h = layout.height;
  const ignore = new Set<string>(t.elementId ? [t.elementId] : []);
  const obs = obstacles(env, ignore);
  const anchorBoxes = [...env.anchors.values()].filter((a) => a.kind !== "user").map((a) => a.box);
  const targetBox = t.point ? { x: t.point.x - 4, y: t.point.y - 4, w: 8, h: 8 } : t.box;
  const cands = labelCandidates(t, w, h, op.side, [55, 95, 150, 220, 300, 400, 520, 680]);
  let best: Box | null = null;
  let bestCost = Infinity;
  cands.forEach((c, i) => {
    if (c.x < 16 || c.x + c.w > BOARD_WIDTH - 16 || c.y < 8) return;
    const cc = boxCenter(c);
    const tc = t.point ?? boxCenter(t.box);
    // Writing over the picture hides what we are explaining: allowed only when nothing better exists.
    let cost = overlapCost(c, obs, 1.2) * 2;
    cost += intersectArea(inflate(c, 10), targetBox) * 50;
    for (const ab of anchorBoxes) cost += intersectArea(inflate(c, 6), ab) * 6;
    // Arrow should not cross other objects.
    for (const ab of anchorBoxes) {
      if (ab === t.box) continue;
      if (segmentHitsBox(cc, tc, ab)) cost += 3000;
    }
    for (const o of obs) if (!o.image && segmentHitsBox(cc, tc, o.box)) cost += 1500;
    cost += dist(cc, tc) * 1.2 + i * 2;
    if (cost < bestCost) {
      bestCost = cost;
      best = c;
    }
  });
  if (!best) best = cands[0];
  const lb: Box = best;
  const color = op.style.color;
  const strokes: Stroke[] = [];
  if (imageUnder(lb, env)) strokes.push(halo(lb));
  strokes.push(...textStrokes(layout, lb.x, lb.y, color));
  // Leader arrow: from the label edge to the target boundary.
  const tc = t.point ?? boxCenter(t.box);
  const start = boxBoundaryToward(lb, tc, 8);
  const end = t.point
    ? (() => {
        const L = dist(start, t.point!);
        return L > 10 ? { x: t.point!.x - ((t.point!.x - start.x) / L) * 6, y: t.point!.y - ((t.point!.y - start.y) / L) * 6 } : t.point!;
      })()
    : t.outline === "ellipse"
      ? ellipseBoundaryToward(t.box, start, 2)
      : boxBoundaryToward(t.box, start, 4);
  const L = dist(start, end);
  if (L > 12) {
    const bend = 0.12 * (start.x < end.x ? 1 : -1);
    const nx = -(end.y - start.y) / L, ny = (end.x - start.x) / L;
    const c = { x: (start.x + end.x) / 2 + nx * bend * L, y: (start.y + end.y) / 2 + ny * bend * L };
    const pts = flatten([{ c: "M", x: start.x, y: start.y }, { c: "Q", x1: c.x, y1: c.y, x: end.x, y: end.y }], 2)[0];
    const s = ink(pts, color, Math.max(2.5, op.style.width));
    if (s) strokes.push(s);
    strokes.push(...arrowHead(end, c, color, Math.max(2.5, op.style.width)));
  }
  const arrowPts = strokes.filter((st): st is Extract<Stroke, { t: "ink" }> => st.t === "ink").flatMap((st) => st.pts.map(([x, y]) => ({ x, y })));
  const occupied = [lb, ...pathOccupancy(arrowPts.length ? arrowPts : [start, end], 3)];
  return element(env, op.id, "callout", strokes, { text: op.text, points: { label: boxCenter(lb), tip: end }, occupied, textual: true });
}

function compileMark(op: OpOf<"mark">, env: CompileEnv): Compiled {
  const t = resolveTarget(op.target, env);
  if (!t) return { type: "skip", reason: `unknown target ${op.target.id}` };
  const b = t.box;
  const color = op.style.color;
  if (op.kind === "underline") {
    const y = b.y + b.h + 6;
    const pts = wobblyLine({ x: b.x - 4, y: y + 1 }, { x: b.x + b.w + 6, y: y - 1 }, op.id, 1.4);
    const s = ink(pts, color, Math.max(2.5, op.style.width), { taper: true });
    return element(env, op.id, "mark", s ? [s] : [], { passive: true });
  }
  if (op.kind === "strike") {
    const y = b.y + b.h * 0.55;
    const pts = wobblyLine({ x: b.x - 4, y }, { x: b.x + b.w + 4, y: y - 2 }, op.id, 1);
    const s = ink(pts, color, Math.max(2.5, op.style.width));
    return element(env, op.id, "mark", s ? [s] : [], { passive: true });
  }
  // highlight: thick translucent marker across the middle
  const y = b.y + b.h / 2;
  const size = Math.max(14, Math.min(b.h * 0.95, 80));
  const pts = [{ x: b.x - 2, y: y + 1 }, { x: b.x + b.w * 0.5, y: y - 1 }, { x: b.x + b.w + 2, y }];
  const s = ink(flatten(catmullRom(pts, false), 3)[0] ?? pts, color, 1, { opacity: 0.38, blend: true, taper: false, z: "under" });
  if (s && s.t === "ink") s.size = size;
  return element(env, op.id, "mark", s ? [s] : [], { passive: true });
}

function compileBrace(op: OpOf<"brace">, env: CompileEnv): Compiled {
  const t = resolveTarget(op.target, env);
  if (!t) return { type: "skip", reason: `unknown target ${op.target.id}` };
  const b = t.box;
  const depth = 16;
  const vertical = op.side === "left" || op.side === "right";
  const sgn = op.side === "right" || op.side === "bottom" ? 1 : -1;
  // Build in a local frame: along = 0..L, across = 0..depth (outward).
  const L = vertical ? b.h : b.w;
  const base = vertical ? (op.side === "right" ? b.x + b.w + 10 : b.x - 10) : op.side === "bottom" ? b.y + b.h + 10 : b.y - 10;
  const start = vertical ? b.y : b.x;
  const toBoard = (along: number, across: number): Point =>
    vertical ? { x: base + sgn * across, y: start + along } : { x: start + along, y: base + sgn * across };
  const h = depth / 2;
  const segs: PathSeg[] = [
    { c: "M", ...toBoard(0, 0) },
    { c: "C", ...cp(toBoard(0, h), toBoard(L * 0.12, h), toBoard(L * 0.25, h)) },
    { c: "C", ...cp(toBoard(L * 0.38, h), toBoard(L * 0.5, h), toBoard(L * 0.5, depth)) },
    { c: "C", ...cp(toBoard(L * 0.5, h), toBoard(L * 0.62, h), toBoard(L * 0.75, h)) },
    { c: "C", ...cp(toBoard(L * 0.88, h), toBoard(L, h), toBoard(L, 0)) },
  ];
  const strokes = inkSegs(segs, op.style.color, op.style.width);
  const tip = toBoard(L * 0.5, depth);
  if (op.text) {
    const layout = env.font.layout(op.text, op.size, 360);
    const lx = vertical ? (sgn > 0 ? tip.x + 12 : tip.x - 12 - layout.width) : tip.x - layout.width / 2;
    const ly = vertical ? tip.y - layout.height / 2 : sgn > 0 ? tip.y + 8 : tip.y - 8 - layout.height;
    strokes.push(...textStrokes(layout, lx, ly, op.style.color));
  }
  return element(env, op.id, "brace", strokes, { text: op.text, points: { tip }, textual: !!op.text });
}

function cp(c1: Point, c2: Point, p: Point) {
  return { x1: c1.x, y1: c1.y, x2: c2.x, y2: c2.y, x: p.x, y: p.y };
}

function compileMath(op: OpOf<"math">, env: CompileEnv): Compiled {
  if (!op.svg) {
    // Server could not render the TeX: write it by hand instead.
    return compileWrite({ op: "write", id: op.id, text: texToPlain(op.tex), size: op.size, place: op.place, style: op.style }, env);
  }
  const { width: w, height: h } = op.svg;
  const pos = place(op.place, w, h, env);
  let box: Box = { x: pos.x, y: pos.y, w, h };
  box = avoid(box, env, new Set([op.id]), pos.explicit ? "explicit" : "flow");
  env.flow = { x: box.x, y: box.y + box.h + 20, lastId: op.id };
  const strokes: Stroke[] = [];
  if (imageUnder(box, env)) strokes.push(halo(box));
  strokes.push({ t: "svg", markup: op.svg.markup, color: op.style.color, box });
  return element(env, op.id, "math", strokes, { box, text: op.tex, textual: true });
}

/** Very small TeX → readable plain text fallback. */
function texToPlain(tex: string): string {
  let out = "";
  for (let i = 0; i < tex.length; i++) {
    const c = tex[i];
    if (c === "{" || c === "}" || c === "$") continue;
    if (c === "\\") {
      let j = i + 1;
      while (j < tex.length && ((tex[j] >= "a" && tex[j] <= "z") || (tex[j] >= "A" && tex[j] <= "Z"))) j++;
      const cmd = tex.slice(i + 1, j);
      const map: Record<string, string> = {
        frac: "", sqrt: "√", pi: "π", theta: "θ", alpha: "α", beta: "β", times: "×", cdot: "·", le: "≤", ge: "≥",
        leq: "≤", geq: "≥", neq: "≠", approx: "≈", infty: "∞", int: "∫", sum: "Σ", Delta: "Δ", delta: "δ", lambda: "λ",
        mu: "μ", sigma: "σ", omega: "ω", to: "→", rightarrow: "→", pm: "±", partial: "∂", in: "∈",
      };
      out += own(map, cmd) ?? (cmd ? "" : tex[j] ?? "");
      i = cmd ? j - 1 : j;
      continue;
    }
    out += c;
  }
  return out.trim() || tex;
}

function niceStep(range: number, target: number): number {
  const raw = range / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  const step = n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10;
  return step * mag;
}

function fmtTick(v: number): string {
  if (Math.abs(v) < 1e-9) return "0";
  const r = Math.round(v * 1000) / 1000;
  return String(r);
}

function compilePlot(op: OpOf<"plot">, env: CompileEnv): Compiled {
  const pos = place(op.place, op.w, op.h, env);
  const f = { x: pos.x, y: pos.y, w: op.w, h: op.h };
  const [x0, x1] = op.xr;
  const [y0, y1] = op.yr;
  const X = (x: number) => f.x + ((x - x0) / (x1 - x0)) * f.w;
  const Y = (y: number) => f.y + f.h - ((y - y0) / (y1 - y0)) * f.h;
  const strokes: Stroke[] = [];
  const axisColor = PALETTE.black;
  const tickSize = TEXT_SIZES.xs;
  const ax = y0 <= 0 && y1 >= 0 ? Y(0) : f.y + f.h;
  const ay = x0 <= 0 && x1 >= 0 ? X(0) : f.x;
  if (op.grid) {
    const gx = niceStep(x1 - x0, 8), gy = niceStep(y1 - y0, 6);
    for (let v = Math.ceil(x0 / gx) * gx; v <= x1 + 1e-9; v += gx) {
      const s = ink([{ x: X(v), y: f.y }, { x: X(v), y: f.y + f.h }], PALETTE.gray, 1, { opacity: 0.3 });
      if (s) strokes.push(s);
    }
    for (let v = Math.ceil(y0 / gy) * gy; v <= y1 + 1e-9; v += gy) {
      const s = ink([{ x: f.x, y: Y(v) }, { x: f.x + f.w, y: Y(v) }], PALETTE.gray, 1, { opacity: 0.3 });
      if (s) strokes.push(s);
    }
  }
  const xAxis = ink(wobblyLine({ x: f.x - 6, y: ax }, { x: f.x + f.w + 14, y: ax }, op.id + "x", 1), axisColor, 2.5);
  const yAxis = ink(wobblyLine({ x: ay, y: f.y + f.h + 6 }, { x: ay, y: f.y - 14 }, op.id + "y", 1), axisColor, 2.5);
  if (xAxis) strokes.push(xAxis, ...arrowHead({ x: f.x + f.w + 14, y: ax }, { x: f.x, y: ax }, axisColor, 2.5));
  if (yAxis) strokes.push(yAxis, ...arrowHead({ x: ay, y: f.y - 14 }, { x: ay, y: f.y + f.h }, axisColor, 2.5));
  // Ticks + labels (at most ~6 per axis).
  const sx = niceStep(x1 - x0, 6);
  for (let v = Math.ceil(x0 / sx) * sx; v <= x1 + 1e-9; v += sx) {
    if (Math.abs(v) < 1e-9 && ay !== f.x) continue;
    const px = X(v);
    const t = ink([{ x: px, y: ax - 5 }, { x: px, y: ax + 5 }], axisColor, 1.8);
    if (t) strokes.push(t);
    const lay = env.font.layout(fmtTick(v), tickSize);
    strokes.push(...textStrokes(lay, px - lay.width / 2, ax + 9, PALETTE.gray));
  }
  const sy = niceStep(y1 - y0, 5);
  for (let v = Math.ceil(y0 / sy) * sy; v <= y1 + 1e-9; v += sy) {
    if (Math.abs(v) < 1e-9) continue;
    const py = Y(v);
    const t = ink([{ x: ay - 5, y: py }, { x: ay + 5, y: py }], axisColor, 1.8);
    if (t) strokes.push(t);
    const lay = env.font.layout(fmtTick(v), tickSize);
    strokes.push(...textStrokes(lay, ay - 10 - lay.width, py - lay.height / 2, PALETTE.gray));
  }
  if (op.xlabel) {
    const lay = env.font.layout(op.xlabel, TEXT_SIZES.s);
    strokes.push(...textStrokes(lay, f.x + f.w + 20, ax - lay.height / 2, axisColor));
  }
  if (op.ylabel) {
    const lay = env.font.layout(op.ylabel, TEXT_SIZES.s);
    strokes.push(...textStrokes(lay, ay - lay.width / 2, f.y - 24 - lay.height, axisColor));
  }
  // Curves
  const colors = [op.style.color, PALETTE.red, PALETTE.green, PALETTE.orange];
  op.fns.forEach((src, k) => {
    const fn = compileExpr(src);
    if (!fn) return;
    const color = colors[k % colors.length];
    const N = 320;
    let piece: Point[] = [];
    const flush = () => {
      if (piece.length >= 2) {
        const s = ink(piece, color, Math.max(2.5, op.style.width));
        if (s) strokes.push(s);
      }
      piece = [];
    };
    let prevY: number | null = null;
    let last: Point | null = null;
    for (let i = 0; i <= N; i++) {
      const x = x0 + ((x1 - x0) * i) / N;
      const y = fn(x);
      if (!Number.isFinite(y) || y < y0 - (y1 - y0) * 0.02 || y > y1 + (y1 - y0) * 0.02) {
        flush();
        prevY = null;
        continue;
      }
      if (prevY !== null && Math.abs(y - prevY) > (y1 - y0) * 0.5) flush(); // discontinuity (tan, 1/x)
      const p = { x: X(x), y: Y(y) };
      piece.push(p);
      last = p;
      prevY = y;
    }
    flush();
    if (op.fns.length > 1 && last) {
      const lay = env.font.layout(src, TEXT_SIZES.xs);
      strokes.push(...textStrokes(lay, Math.min(last.x + 8, BOARD_WIDTH - lay.width - 20), last.y - lay.height - 4, color));
    }
  });
  env.flow = { x: f.x, y: f.y + f.h + 50, lastId: op.id };
  return element(env, op.id, "plot", strokes, { box: inflate(f, 16), points: { origin: { x: ay, y: ax } } });
}

function compileTable(op: OpOf<"table">, env: CompileEnv): Compiled {
  const rows = op.rows;
  const cols = Math.max(...rows.map((r) => r.length));
  const layouts = rows.map((r) => Array.from({ length: cols }, (_, j) => env.font.layout(r[j] ?? "", op.size, 360)));
  const colW = Array.from({ length: cols }, (_, j) => Math.max(...layouts.map((r) => r[j].width)) + 32);
  const rowH = layouts.map((r) => Math.max(...r.map((l) => l.height), op.size * 0.8) + 20);
  const W = colW.reduce((a, b) => a + b, 0);
  const H = rowH.reduce((a, b) => a + b, 0);
  const pos = place(op.place, W, H, env);
  let box: Box = { x: pos.x, y: pos.y, w: W, h: H };
  box = avoid(box, env, new Set([op.id]), pos.explicit ? "explicit" : "flow");
  const color = op.style.color;
  const strokes: Stroke[] = [];
  strokes.push(...roughShape((o) => gen.rectangle(box.x, box.y, W, H, o), op.id, { ...op.style, fill: "none", width: 2.2 }, box, { roughness: 0.7 }));
  let yy = box.y;
  rows.forEach((_, i) => {
    if (i > 0) {
      const s = ink(wobblyLine({ x: box.x, y: yy }, { x: box.x + W, y: yy }, `${op.id}r${i}`, 0.8), color, i === 1 ? 2.4 : 1.6);
      if (s) strokes.push(s);
    }
    yy += rowH[i];
  });
  let xx = box.x;
  colW.forEach((cw, j) => {
    if (j > 0) {
      const s = ink(wobblyLine({ x: xx, y: box.y }, { x: xx, y: box.y + H }, `${op.id}c${j}`, 0.8), color, 1.6);
      if (s) strokes.push(s);
    }
    xx += cw;
  });
  yy = box.y;
  rows.forEach((_, i) => {
    xx = box.x;
    colW.forEach((cw, j) => {
      const l = layouts[i][j];
      strokes.push(...textStrokes(l, xx + (cw - l.width) / 2, yy + (rowH[i] - l.height) / 2, i === 0 ? PALETTE.blue : color));
      xx += cw;
    });
    yy += rowH[i];
  });
  env.flow = { x: box.x, y: box.y + H + 30, lastId: op.id };
  return element(env, op.id, "table", strokes, { box, text: rows.map((r) => r.join(" | ")).join("; "), textual: true });
}

// ---------------------------------------------------------------------------

/** Compile one op against the current board. Never throws for bad content. */
export function compileOp(op: Op, env: CompileEnv): Compiled {
  try {
    switch (op.op) {
      case "write": return compileWrite(op, env);
      case "shape": return compileShape(op, env);
      case "enclose": return compileEnclose(op, env);
      case "line": return compileLine(op, env);
      case "poly": return compilePoly(op, env);
      case "path": return compilePath(op, env);
      case "sketch": return compileSketch(op, env);
      case "label": return compileLabel(op, env);
      case "callout": return compileCallout(op, env);
      case "mark": return compileMark(op, env);
      case "brace": return compileBrace(op, env);
      case "math": return compileMath(op, env);
      case "plot": return compilePlot(op, env);
      case "table": return compileTable(op, env);
      case "erase": {
        if (!op.target) return { type: "erase", ids: [...env.elements.values()].filter((e) => e.author === "doodo").map((e) => e.id) };
        const hit = lookup(op.target, env);
        return hit?.el ? { type: "erase", ids: [hit.el.id] } : { type: "skip", reason: "nothing to erase" };
      }
      case "pause": return { type: "pause", ms: op.ms };
      case "point": {
        const p = resolvePoint(op.target, env);
        return p ? { type: "point", at: p, ms: op.ms } : { type: "skip", reason: "unknown point target" };
      }
      case "voice":
      case "find":
        return { type: "skip", reason: "not a drawing op" };
    }
  } catch (e) {
    return { type: "skip", reason: e instanceof Error ? e.message : "compile error" };
  }
}

/** Refs an op depends on (to wait for grounding before drawing). */
export function opRefs(op: Op): Ref[] {
  const out: Ref[] = [];
  const add = (r: Ref | undefined | null) => {
    if (r) out.push(r);
  };
  const addPor = (p: PointOrRef) => {
    if (p.kind === "ref") out.push(p.ref);
  };
  switch (op.op) {
    case "enclose": case "label": case "callout": case "mark": case "brace": add(op.target); break;
    case "line": addPor(op.from); addPor(op.to); break;
    case "point": addPor(op.target); break;
    case "erase": add(op.target); break;
    default: break;
  }
  if ("place" in op && op.place) {
    add(op.place.below);
    add(op.place.above);
    add(op.place.rightOf);
    add(op.place.leftOf);
  }
  return out;
}

/** Rough drawing time estimate (ms at speed 1) used for pacing beats against audio. */
export function estimateDrawMs(el: BoardElement): number {
  let ms = 0;
  for (const s of el.strokes) ms += strokeDurationMs(s, 1) + 45;
  return ms;
}

/** Base pen speeds (px/s) — text is written a little slower than shapes are drawn. */
export function strokeDurationMs(s: Stroke, speed: number): number {
  switch (s.t) {
    case "path": return Math.max(45, (s.len / (s.width < 3.5 ? 620 : 1100)) * 1000) / speed;
    case "ink": return Math.max(60, (s.len / (s.size > 12 ? 1500 : 950)) * 1000) / speed;
    case "fill": return Math.min(700, 200 + s.box.w * 0.6) / speed;
    case "svg": return Math.min(1600, 300 + s.box.w * 2.2) / speed;
    case "text": return 120 / speed;
    case "image": return 450 / speed;
  }
}

// ---------------------------------------------------------------------------
// User-drawn elements (editor tools) — same look as Doodo's ink.
// ---------------------------------------------------------------------------

export type UserTool = "pen" | "highlighter" | "rect" | "ellipse" | "arrow" | "line";

export function buildUserStroke(
  tool: UserTool, id: string, seq: number, pts: Point[], color: string, width: number,
): BoardElement | null {
  const style: Style = { color, width, fill: "none", dash: false };
  let strokes: Stroke[] = [];
  let kind: ElementKind = "ink";
  let outline: BoardElement["outline"] = "box";
  if (tool === "pen" || tool === "highlighter") {
    if (pts.length === 0) return null;
    const s =
      tool === "pen"
        ? ink(pts, color, width)
        : ink(pts, color, 1, { opacity: 0.35, blend: true, z: "under" });
    if (!s) return null;
    if (tool === "highlighter" && s.t === "ink") s.size = Math.max(14, width * 6);
    strokes = [s];
    kind = tool === "pen" ? "ink" : "highlight";
  } else {
    if (pts.length < 2) return null;
    const a = pts[0], b = pts[pts.length - 1];
    if (dist(a, b) < 6) return null;
    const box = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
    if (tool === "rect") {
      strokes = shapeStrokes(id, "rect", box, style);
      kind = "rect";
    } else if (tool === "ellipse") {
      strokes = shapeStrokes(id, "ellipse", box, style);
      kind = "ellipse";
      outline = "ellipse";
    } else {
      const s = ink(wobblyLine(a, b, id, 1), color, width);
      if (s) strokes.push(s);
      if (tool === "arrow") strokes.push(...arrowHead(b, a, color, width));
      kind = "arrow";
    }
  }
  const box = strokesBox(strokes);
  return { id, author: "user", kind, strokes, box, seq, outline, points: tool === "arrow" || tool === "line" ? { start: pts[0], end: pts[pts.length - 1] } : undefined };
}

export function buildUserText(font: StrokeFont, id: string, seq: number, text: string, at: Point, size: number, color: string): BoardElement | null {
  const t = text.trim();
  if (!t) return null;
  const layout = font.layout(t, size, Math.max(200, RIGHT_LIMIT - at.x));
  const strokes = textStrokes(layout, at.x, at.y, color);
  return { id, author: "user", kind: "text", strokes, box: { x: at.x, y: at.y, w: layout.width, h: layout.height }, seq, text: t };
}

export function buildImage(id: string, seq: number, href: string, box: Box, label?: string): BoardElement {
  return { id, author: "user", kind: "image", strokes: [{ t: "image", href, box }], box, seq, text: label };
}
