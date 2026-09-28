import type { RawElement } from "./builder";
import { own } from "../own";
import {
  BOARD_MAX_HEIGHT, BOARD_WIDTH, FILL_STYLES, REGIONS, SIDES, TEXT_SIZES,
  type ArrowHeads, type FillStyle, type Op, type Placement, type ShapeKind, type SketchStroke, type Style,
} from "./ops";
import {
  PALETTE, parseBool, parseColor, parseEnum, parseId, parseNumber, parsePathData, parsePoint, parsePointList,
  parsePointOrRef, parseRange, parseRef, parseRows, type PointOrRef, type Ref,
} from "./values";

export type ConvertResult = { ok: true; op: Op } | { ok: false; issue: string };

export interface ConvertContext {
  nextId(prefix: string): string;
}

const MAX_TEXT = 400;
const MAX_VOICE = 1500;

/** All tag names (and aliases) the converter understands at the top level. */
export const TOP_LEVEL_TAGS: ReadonlySet<string> = new Set([
  "voice", "say",
  "write", "text", "title", "heading",
  "box", "rect", "node", "ellipse", "circle", "diamond",
  "line", "arrow", "connector", "edge",
  "tri", "triangle", "poly", "polygon", "polyline", "curve", "spline",
  "path", "sketch",
  "label", "callout",
  "underline", "highlight", "strike",
  "brace",
  "math", "latex", "formula",
  "plot", "graph",
  "table",
  "find",
  "erase", "clear",
  "pause", "wait",
  "point", "pointer", "tap",
]);

/** Elements whose content is raw text (only their exact closing tag ends them). */
export const RAW_TEXT_TAGS: ReadonlySet<string> = new Set([
  "voice", "say", "write", "text", "title", "heading", "math", "latex", "formula",
  "label", "callout", "find", "table",
]);

export const CONTAINERS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["sketch", new Set(["s", "stroke", "path"])],
  ["box", new Set<string>()],
]);

// ---------------------------------------------------------------------------

function clampNum(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

const clampX = (v: number) => clampNum(v, -400, BOARD_WIDTH + 400);
const clampY = (v: number) => clampNum(v, -400, BOARD_MAX_HEIGHT);

/** Collapse runs of whitespace into single spaces and trim — by scanning. */
export function normalizeSpace(s: string, max: number): string {
  let out = "";
  let pendingSpace = false;
  for (let i = 0; i < s.length && out.length < max; i++) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 0xa0) {
      pendingSpace = out.length > 0;
    } else {
      if (pendingSpace) out += " ";
      pendingSpace = false;
      out += s[i];
    }
  }
  return out;
}

/** Like normalizeSpace but keeps explicit line breaks (for multi-line write / table). */
function normalizeLines(s: string, max: number): string {
  const lines: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 10) {
      lines.push(cur);
      cur = "";
    } else cur += s[i];
  }
  lines.push(cur);
  const kept = lines.map((l) => normalizeSpace(l, max)).filter((l) => l.length > 0);
  return kept.join("\n").slice(0, max);
}

function attr(el: RawElement, ...names: string[]): string | undefined {
  for (const n of names) {
    const v = el.attrs[n];
    if (v !== undefined) return v;
  }
  return undefined;
}

function num(el: RawElement, ...names: string[]): number | null {
  return parseNumber(attr(el, ...names));
}

/** Models sometimes write a literal backslash-n for a line break; turn it into a real one. */
function unescapeNewlines(s: string): string {
  if (s.indexOf("\\n") === -1) return s;
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 92 /* \ */ && s.charCodeAt(i + 1) === 110 /* n */) {
      out += "\n";
      i++;
    } else out += s[i];
  }
  return out;
}

function textOf(el: RawElement, max = MAX_TEXT): string {
  const fromAttr = attr(el, "text", "value");
  const t = normalizeLines(unescapeNewlines(el.text), max);
  if (t.length > 0) return t;
  return fromAttr ? normalizeLines(unescapeNewlines(fromAttr), max) : "";
}

function sizeOf(el: RawElement, fallback: number): number {
  const raw = attr(el, "size", "font-size", "fontsize");
  if (raw === undefined) return fallback;
  const key = raw.trim().toLowerCase();
  const named = own<number>(TEXT_SIZES, key);
  if (named !== undefined) return named;
  if (key === "small") return TEXT_SIZES.s;
  if (key === "medium") return TEXT_SIZES.m;
  if (key === "large" || key === "big") return TEXT_SIZES.l;
  const n = parseNumber(raw);
  return n === null ? fallback : clampNum(n, 14, 140);
}

function styleOf(el: RawElement, defaults: Partial<Style> = {}): Style {
  const color = parseColor(attr(el, "color", "stroke", "colour")) ?? defaults.color ?? PALETTE.black;
  const w = num(el, "w-stroke", "stroke-width", "thickness", "weight");
  const fillRaw = attr(el, "fill");
  let fill: FillStyle = defaults.fill ?? "none";
  let fillColor: string | undefined = defaults.fillColor;
  if (fillRaw !== undefined) {
    const fs = parseEnum(fillRaw, FILL_STYLES);
    if (fs) fill = fs;
    else {
      // `fill="yellow"` means a hachure fill in that colour.
      const fc = parseColor(fillRaw);
      if (fc) {
        fill = "hachure";
        fillColor = fc;
      }
    }
  }
  const fc = parseColor(attr(el, "fill-color", "fillcolor"));
  if (fc) fillColor = fc;
  return {
    color,
    width: w === null ? defaults.width ?? 3 : clampNum(w, 1, 16),
    fill,
    fillColor,
    dash: parseBool(attr(el, "dash", "dashed")) ?? defaults.dash ?? false,
  };
}

function refAttr(el: RawElement, ...names: string[]): Ref | null {
  return parseRef(attr(el, ...names));
}

function placementOf(el: RawElement): Placement {
  const p: Placement = {};
  const x = num(el, "x", "left");
  const y = num(el, "y", "top");
  if (x !== null) p.x = clampX(x);
  if (y !== null) p.y = clampY(y);
  const atRaw = attr(el, "at", "region", "pos", "position");
  if (atRaw !== undefined) {
    const region = parseEnum(atRaw, REGIONS);
    if (region) p.at = region;
    else {
      const pt = parsePoint(atRaw);
      if (pt) {
        p.x = clampX(pt.x);
        p.y = clampY(pt.y);
      }
    }
  }
  const below = refAttr(el, "below", "under");
  const above = refAttr(el, "above", "over");
  const rightOf = refAttr(el, "right-of", "rightof", "right_of", "after");
  const leftOf = refAttr(el, "left-of", "leftof", "left_of", "before");
  if (below) p.below = below;
  if (above) p.above = above;
  if (rightOf) p.rightOf = rightOf;
  if (leftOf) p.leftOf = leftOf;
  const gap = num(el, "gap", "margin");
  if (gap !== null) p.gap = clampNum(gap, 0, 400);
  const align = parseEnum(attr(el, "align"), ["start", "center", "end", "left", "right", "middle"] as const);
  if (align) p.align = align === "left" ? "start" : align === "right" ? "end" : align === "middle" ? "center" : align;
  return p;
}

function idOf(el: RawElement, ctx: ConvertContext, prefix: string): string {
  return parseId(attr(el, "id", "name")) ?? ctx.nextId(prefix);
}

function headsOf(el: RawElement, fallback: ArrowHeads): ArrowHeads {
  const h = parseEnum(attr(el, "heads", "head", "arrow", "arrows"), ["none", "end", "start", "both"] as const);
  if (h) return h;
  const b = parseBool(attr(el, "arrow"));
  if (b === true) return "end";
  if (b === false) return "none";
  return fallback;
}

function fail(issue: string): ConvertResult {
  return { ok: false, issue };
}

function ok(op: Op): ConvertResult {
  return { ok: true, op };
}

function endpoint(el: RawElement, key: "from" | "to", xk: string, yk: string): PointOrRef | null {
  const r = parsePointOrRef(attr(el, key, key === "from" ? "start" : "end", key === "from" ? "a" : "b"));
  if (r) {
    if (r.kind === "point") r.point = { x: clampX(r.point.x), y: clampY(r.point.y) };
    return r;
  }
  const x = num(el, xk);
  const y = num(el, yk);
  if (x !== null && y !== null) return { kind: "point", point: { x: clampX(x), y: clampY(y) } };
  return null;
}

// ---------------------------------------------------------------------------

export function convertElement(el: RawElement, ctx: ConvertContext): ConvertResult {
  switch (el.name) {
    case "voice":
    case "say": {
      const text = normalizeSpace(el.text || attr(el, "text") || "", MAX_VOICE);
      if (!text) return fail("empty voice");
      return ok({ op: "voice", id: ctx.nextId("v"), text });
    }

    case "write":
    case "text":
    case "title":
    case "heading": {
      const text = textOf(el);
      if (!text) return fail(`empty ${el.name}`);
      const isTitle = el.name === "title" || el.name === "heading";
      const place = placementOf(el);
      if (isTitle && place.x === undefined && place.y === undefined && !place.at && !place.below && !place.above && !place.rightOf && !place.leftOf) {
        place.at = "top";
      }
      const maxW = num(el, "max-w", "maxw", "max-width", "width");
      return ok({
        op: "write",
        id: idOf(el, ctx, "w"),
        text,
        size: sizeOf(el, isTitle ? TEXT_SIZES.l : TEXT_SIZES.m),
        place,
        style: styleOf(el),
        maxWidth: maxW === null ? undefined : clampNum(maxW, 80, BOARD_WIDTH),
      });
    }

    case "box":
    case "rect":
    case "node":
    case "ellipse":
    case "circle":
    case "diamond": {
      const target = refAttr(el, "target", "around", "on", "of");
      if (target) {
        const pad = num(el, "pad", "padding");
        return ok({
          op: "enclose",
          id: idOf(el, ctx, "c"),
          kind: el.name === "rect" || el.name === "box" ? "rect" : "circle",
          target,
          pad: pad === null ? 10 : clampNum(pad, -20, 120),
          style: styleOf(el, { color: PALETTE.red }),
        });
      }
      const place = placementOf(el);
      let w = num(el, "w", "width");
      let h = num(el, "h", "height");
      let kind: ShapeKind =
        el.name === "ellipse" || el.name === "circle" ? "ellipse" : el.name === "diamond" ? "diamond" : "rect";
      const shapeAttr = parseEnum(attr(el, "shape"), ["rect", "round", "ellipse", "circle", "diamond"] as const);
      if (shapeAttr) kind = shapeAttr === "circle" ? "ellipse" : shapeAttr;
      if (el.name === "box" || el.name === "node") {
        if (!shapeAttr) kind = "round";
      }
      if (el.name === "circle") {
        const cx = num(el, "cx"), cy = num(el, "cy"), r = num(el, "r", "radius");
        const c = parsePoint(attr(el, "center", "c"));
        const ccx = cx ?? c?.x ?? null;
        const ccy = cy ?? c?.y ?? null;
        if (r !== null) {
          const rr = clampNum(Math.abs(r), 2, 2000);
          w = h = rr * 2;
          if (ccx !== null && ccy !== null) {
            place.x = clampX(ccx - rr);
            place.y = clampY(ccy - rr);
          }
        }
      }
      if (el.name === "ellipse") {
        const cx = num(el, "cx"), cy = num(el, "cy"), rx = num(el, "rx"), ry = num(el, "ry");
        if (rx !== null && ry !== null) {
          w = clampNum(Math.abs(rx), 2, 2000) * 2;
          h = clampNum(Math.abs(ry), 2, 2000) * 2;
          if (cx !== null && cy !== null) {
            place.x = clampX(cx - w / 2);
            place.y = clampY(cy - h / 2);
          }
        }
      }
      const text = textOf(el) || undefined;
      if (!text && (w === null || h === null)) return fail(`${el.name} needs w,h (or r) or text`);
      return ok({
        op: "shape",
        id: idOf(el, ctx, "s"),
        kind,
        place,
        w: w === null ? undefined : clampNum(Math.abs(w), 4, BOARD_WIDTH),
        h: h === null ? undefined : clampNum(Math.abs(h), 4, 4000),
        text,
        size: sizeOf(el, TEXT_SIZES.s),
        style: styleOf(el),
      });
    }

    case "line":
    case "arrow":
    case "connector":
    case "edge": {
      const from = endpoint(el, "from", "x1", "y1");
      const to = endpoint(el, "to", "x2", "y2");
      if (!from || !to) return fail(`${el.name} needs from and to`);
      const curve = num(el, "curve", "bend");
      const label = textOf(el) || undefined;
      return ok({
        op: "line",
        id: idOf(el, ctx, "l"),
        from,
        to,
        heads: headsOf(el, el.name === "line" ? "none" : "end"),
        curve: curve === null ? 0 : clampNum(curve, -1, 1),
        label,
        size: sizeOf(el, TEXT_SIZES.s),
        style: styleOf(el),
      });
    }

    case "tri":
    case "triangle": {
      const a = parsePoint(attr(el, "a", "p1")), b = parsePoint(attr(el, "b", "p2")), c = parsePoint(attr(el, "c", "p3"));
      let points = a && b && c ? [a, b, c] : parsePointList(attr(el, "points"));
      if (!points || points.length !== 3) return fail("tri needs a, b, c");
      points = points.map((p) => ({ x: clampX(p.x), y: clampY(p.y) }));
      const right = parseEnum(attr(el, "right", "right-angle"), ["a", "b", "c"] as const) ?? undefined;
      return ok({
        op: "poly", id: idOf(el, ctx, "t"), points, closed: true, smooth: false, heads: "none",
        names: ["a", "b", "c"], rightAngle: right, style: styleOf(el),
      });
    }

    case "poly":
    case "polygon":
    case "polyline":
    case "curve":
    case "spline": {
      const pts = parsePointList(attr(el, "points", "pts", "d"));
      if (!pts || pts.length < 2) return fail(`${el.name} needs at least 2 points`);
      const smooth = el.name === "curve" || el.name === "spline" || parseBool(attr(el, "smooth")) === true;
      const closedDefault = el.name === "polygon" || el.name === "poly";
      return ok({
        op: "poly",
        id: idOf(el, ctx, "p"),
        points: pts.map((p) => ({ x: clampX(p.x), y: clampY(p.y) })),
        closed: parseBool(attr(el, "closed")) ?? closedDefault,
        smooth,
        heads: headsOf(el, "none"),
        style: styleOf(el),
      });
    }

    case "path": {
      const segs = parsePathData(attr(el, "d"));
      if (!segs) return fail("path needs valid d");
      return ok({ op: "path", id: idOf(el, ctx, "p"), segs, style: styleOf(el) });
    }

    case "sketch": {
      const place = placementOf(el);
      const w = num(el, "w", "width") ?? 300;
      const h = num(el, "h", "height") ?? w;
      const style = styleOf(el);
      const strokes: SketchStroke[] = [];
      for (const child of el.children) {
        const s = sketchStroke(child);
        if (s) strokes.push(s);
      }
      if (strokes.length === 0) return fail("sketch has no valid strokes");
      return ok({
        op: "sketch", id: idOf(el, ctx, "k"), place,
        w: clampNum(Math.abs(w), 10, BOARD_WIDTH), h: clampNum(Math.abs(h), 10, 4000), strokes, style,
      });
    }

    case "label": {
      const target = refAttr(el, "target", "for", "on", "of");
      const text = textOf(el);
      if (!target || !text) return fail("label needs target and text");
      return ok({
        op: "label", id: idOf(el, ctx, "lb"), target, text,
        side: parseEnum(attr(el, "side", "dir"), SIDES) ?? undefined,
        size: sizeOf(el, TEXT_SIZES.s), style: styleOf(el),
      });
    }

    case "callout": {
      const target = refAttr(el, "target", "for", "on", "of", "to");
      const text = textOf(el);
      if (!target || !text) return fail("callout needs target and text");
      return ok({
        op: "callout", id: idOf(el, ctx, "co"), target, text,
        side: parseEnum(attr(el, "side", "dir"), SIDES) ?? undefined,
        size: sizeOf(el, TEXT_SIZES.s), style: styleOf(el, { color: PALETTE.red }),
      });
    }

    case "underline":
    case "highlight":
    case "strike": {
      const target = refAttr(el, "target", "on", "of");
      if (!target) return fail(`${el.name} needs target`);
      const defaults: Partial<Style> =
        el.name === "highlight" ? { color: PALETTE.yellow, width: 22 } : { color: el.name === "strike" ? PALETTE.red : PALETTE.blue };
      return ok({ op: "mark", id: idOf(el, ctx, "m"), kind: el.name, target, style: styleOf(el, defaults) });
    }

    case "brace": {
      const target = refAttr(el, "target", "on", "of");
      if (!target) return fail("brace needs target");
      return ok({
        op: "brace", id: idOf(el, ctx, "b"), target,
        side: parseEnum(attr(el, "side"), ["left", "right", "top", "bottom"] as const) ?? "right",
        text: textOf(el) || undefined, size: sizeOf(el, TEXT_SIZES.s), style: styleOf(el),
      });
    }

    case "math":
    case "latex":
    case "formula": {
      const tex = (el.text || attr(el, "tex") || "").trim().slice(0, 600);
      if (!tex) return fail("empty math");
      return ok({ op: "math", id: idOf(el, ctx, "mx"), tex, size: sizeOf(el, TEXT_SIZES.m), place: placementOf(el), style: styleOf(el) });
    }

    case "plot":
    case "graph": {
      const fnRaw = attr(el, "fn", "f", "y", "fns") ?? "";
      const fns: string[] = [];
      for (const part of fnRaw.split(";")) {
        const f = part.trim();
        if (f && fns.length < 4) fns.push(f.slice(0, 200));
      }
      const w = num(el, "w", "width") ?? 480;
      const h = num(el, "h", "height") ?? 320;
      const place = placementOf(el);
      // In a plot, `y` is the function, not a coordinate.
      if (attr(el, "y") !== undefined && parseNumber(attr(el, "y")) === null) delete place.y;
      return ok({
        op: "plot", id: idOf(el, ctx, "g"), fns, place,
        w: clampNum(w, 120, BOARD_WIDTH), h: clampNum(h, 80, 2000),
        xr: parseRange(attr(el, "xr", "x-range", "xrange", "domain")) ?? [-5, 5],
        yr: parseRange(attr(el, "yr", "y-range", "yrange", "range")) ?? [-5, 5],
        grid: parseBool(attr(el, "grid")) ?? false,
        xlabel: attr(el, "xlabel", "x-label")?.slice(0, 40),
        ylabel: attr(el, "ylabel", "y-label")?.slice(0, 40),
        style: styleOf(el, { color: PALETTE.blue }),
      });
    }

    case "table": {
      const rows = parseRows(attr(el, "rows") ?? el.text);
      if (!rows) return fail("table has no rows");
      return ok({ op: "table", id: idOf(el, ctx, "tb"), rows, place: placementOf(el), size: sizeOf(el, TEXT_SIZES.s), style: styleOf(el) });
    }

    case "find": {
      const id = parseId(attr(el, "id", "name"));
      const desc = normalizeSpace(el.text || attr(el, "desc", "description", "what") || "", 300);
      if (!id || !desc) return fail("find needs id and desc");
      return ok({ op: "find", id, desc, kind: parseEnum(attr(el, "kind", "type"), ["object", "text", "region"] as const) ?? "object" });
    }

    case "erase": {
      const raw = attr(el, "target", "id", "of");
      if (raw === undefined || raw.trim().toLowerCase() === "all") return ok({ op: "erase", target: null });
      const target = parseRef(raw);
      if (!target) return fail("erase needs a valid target");
      return ok({ op: "erase", target });
    }
    case "clear":
      return ok({ op: "erase", target: null });

    case "pause":
    case "wait": {
      const ms = num(el, "ms", "duration", "for") ?? 500;
      return ok({ op: "pause", ms: clampNum(ms, 0, 4000) });
    }

    case "point":
    case "pointer":
    case "tap": {
      const target = parsePointOrRef(attr(el, "target", "at", "to", "on"));
      if (!target) return fail("point needs target");
      const ms = num(el, "ms", "duration") ?? 900;
      return ok({ op: "point", target, ms: clampNum(ms, 200, 4000) });
    }
  }
  return fail(`unknown element <${el.name}>`);
}

function sketchStroke(child: RawElement): SketchStroke | null {
  const color = parseColor(attr(child, "color", "stroke")) ?? undefined;
  const width = parseNumber(attr(child, "w", "width", "stroke-width"));
  const fillRaw = attr(child, "fill");
  let fill: FillStyle | undefined;
  let fillColor: string | undefined;
  if (fillRaw !== undefined) {
    fill = parseEnum(fillRaw, FILL_STYLES) ?? undefined;
    if (!fill) {
      const fc = parseColor(fillRaw);
      if (fc) {
        fill = "hachure";
        fillColor = fc;
      }
    }
  }
  const closed = parseBool(attr(child, "closed", "close")) ?? false;
  const base = { closed, color, width: width === null ? undefined : clampNum(width, 1, 16), fill, fillColor };
  const raw = (attr(child, "d", "points", "pts") ?? child.text).trim();
  if (!raw) return null;
  const first = raw.charCodeAt(0);
  const looksLikePath = child.name === "path" || (first >= 65 && first <= 90) || (first >= 97 && first <= 122);
  if (looksLikePath) {
    const segs = parsePathData(raw, 2000);
    return segs ? { ...base, segs } : null;
  }
  const points = parsePointList(raw, 800);
  if (!points || points.length < 1) return null;
  // Local frame is 0..100 (allow a little overshoot).
  return { ...base, points: points.map((p) => ({ x: clampNum(p.x, -20, 120), y: clampNum(p.y, -20, 120) })) };
}
