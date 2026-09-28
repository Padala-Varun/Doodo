/**
 * Typed attribute-value grammars for DML, implemented as small character
 * scanners (no regular expressions). Every parser returns `null` on invalid
 * input instead of throwing, so one bad attribute never breaks a lesson.
 */

import { own } from "../own";

export interface Point {
  x: number;
  y: number;
}

export type Ref = {
  /** "anchor" = grounded object / user mark (`@name`), "el" = a board element id. */
  ns: "anchor" | "el";
  id: string;
  /** Optional sub-anchor: top, left, center, a, bc, start, end, ... */
  sub?: string;
};

export type PointOrRef = { kind: "point"; point: Point } | { kind: "ref"; ref: Ref };

export type PathSeg =
  | { c: "M"; x: number; y: number }
  | { c: "L"; x: number; y: number }
  | { c: "C"; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { c: "Q"; x1: number; y1: number; x: number; y: number }
  | { c: "Z" };

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

function isDigit(c: number): boolean {
  return c >= 48 && c <= 57;
}

function isWs(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 12;
}

class Scanner {
  i = 0;
  constructor(readonly s: string) {}

  get done(): boolean {
    return this.i >= this.s.length;
  }

  peek(): number {
    return this.i < this.s.length ? this.s.charCodeAt(this.i) : -1;
  }

  skipWs(): void {
    while (this.i < this.s.length && isWs(this.s.charCodeAt(this.i))) this.i++;
  }

  /** Skip whitespace and any of the given separator char codes. */
  skipSep(seps: readonly number[]): void {
    while (this.i < this.s.length) {
      const c = this.s.charCodeAt(this.i);
      if (isWs(c) || seps.includes(c)) this.i++;
      else break;
    }
  }

  /**
   * Read a floating point number: [+-]? (digits [. digits?] | . digits) ([eE] [+-]? digits)?
   * Returns null (and does not advance) if there is no number here.
   */
  number(): number | null {
    const s = this.s;
    const start = this.i;
    let j = this.i;
    if (j < s.length && (s.charCodeAt(j) === 43 || s.charCodeAt(j) === 45)) j++;
    let digits = 0;
    while (j < s.length && isDigit(s.charCodeAt(j))) {
      j++;
      digits++;
    }
    // A '.' belongs to the number unless it starts a ".." range separator.
    if (j < s.length && s.charCodeAt(j) === 46 /* . */ && s.charCodeAt(j + 1) !== 46) {
      j++;
      while (j < s.length && isDigit(s.charCodeAt(j))) {
        j++;
        digits++;
      }
    }
    if (digits === 0) return null;
    if (j < s.length && (s.charCodeAt(j) === 101 || s.charCodeAt(j) === 69)) {
      let k = j + 1;
      if (k < s.length && (s.charCodeAt(k) === 43 || s.charCodeAt(k) === 45)) k++;
      let expDigits = 0;
      while (k < s.length && isDigit(s.charCodeAt(k))) {
        k++;
        expDigits++;
      }
      if (expDigits > 0) j = k;
    }
    const v = Number(s.slice(start, j));
    if (!Number.isFinite(v)) return null;
    this.i = j;
    return v;
  }

  /** Read an SVG path flag (a single '0' or '1'). */
  flag(): number | null {
    const c = this.peek();
    if (c === 48 || c === 49) {
      this.i++;
      return c - 48;
    }
    return null;
  }
}

const COMMA = 44;
const SEMI = 59;

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

/** Parse a whole string as a single number (surrounding whitespace allowed, optional "px"). */
export function parseNumber(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const sc = new Scanner(raw);
  sc.skipWs();
  const v = sc.number();
  if (v === null) return null;
  sc.skipWs();
  if (!sc.done) {
    const rest = raw.slice(sc.i).trim().toLowerCase();
    if (rest !== "px" && rest !== "%" && rest !== "ms" && rest !== "s") return null;
    if (rest === "s") return v * 1000;
  }
  return v;
}

export function parseBool(raw: string | undefined): boolean | null {
  if (raw === undefined) return null;
  const v = raw.trim().toLowerCase();
  if (v === "" || v === "true" || v === "yes" || v === "1" || v === "on") return true;
  if (v === "false" || v === "no" || v === "0" || v === "off") return false;
  return null;
}

/** Read every number in a string separated by whitespace, commas or semicolons. */
export function parseNumberList(raw: string | undefined, max = 4096): number[] | null {
  if (raw === undefined) return null;
  const sc = new Scanner(raw);
  const out: number[] = [];
  sc.skipSep([COMMA, SEMI]);
  while (!sc.done && out.length < max) {
    const v = sc.number();
    if (v === null) return null;
    out.push(v);
    sc.skipSep([COMMA, SEMI]);
  }
  return out;
}

export function parsePoint(raw: string | undefined): Point | null {
  const nums = parseNumberList(raw, 3);
  if (!nums || nums.length !== 2) return null;
  return { x: nums[0], y: nums[1] };
}

/** "x,y x,y ..." (any separator mix); an odd trailing number is dropped. */
export function parsePointList(raw: string | undefined, maxPoints = 2000): Point[] | null {
  const nums = parseNumberList(raw, maxPoints * 2);
  if (!nums) return null;
  const pts: Point[] = [];
  for (let i = 0; i + 1 < nums.length; i += 2) pts.push({ x: nums[i], y: nums[i + 1] });
  return pts;
}

/** "a,b" or "a..b" or "a:b" */
export function parseRange(raw: string | undefined): [number, number] | null {
  if (raw === undefined) return null;
  const sc = new Scanner(raw);
  sc.skipWs();
  const a = sc.number();
  if (a === null) return null;
  sc.skipWs();
  // separators: ',', ':', '..', ';', 'to'
  const rest = raw.slice(sc.i);
  let skip = 0;
  if (rest.startsWith("..")) skip = 2;
  else if (rest.startsWith(",") || rest.startsWith(":") || rest.startsWith(";")) skip = 1;
  else if (rest.toLowerCase().startsWith("to")) skip = 2;
  else return null;
  sc.i += skip;
  sc.skipWs();
  const b = sc.number();
  if (b === null) return null;
  sc.skipWs();
  if (!sc.done) return null;
  if (a === b) return null;
  return a < b ? [a, b] : [b, a];
}

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

function isIdChar(c: number): boolean {
  return (
    (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || isDigit(c) || c === 95 /* _ */ || c === 45 /* - */
  );
}

/** Normalise an identifier: keeps [A-Za-z0-9_-], lower-cased. Returns null if empty. */
export function parseId(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const t = raw.trim();
  if (t.length === 0 || t.length > 64) return null;
  for (let i = 0; i < t.length; i++) if (!isIdChar(t.charCodeAt(i))) return null;
  return t.toLowerCase();
}

/** `@mango1`, `@mango1.left`, `t1`, `t1.bc` */
export function parseRef(raw: string | undefined): Ref | null {
  if (raw === undefined) return null;
  let t = raw.trim();
  if (t.length === 0) return null;
  let ns: Ref["ns"] = "el";
  if (t.charCodeAt(0) === 64 /* @ */) {
    ns = "anchor";
    t = t.slice(1);
  } else if (t.charCodeAt(0) === 35 /* # */) {
    t = t.slice(1);
  }
  const dot = t.indexOf(".");
  const idPart = dot === -1 ? t : t.slice(0, dot);
  const subPart = dot === -1 ? undefined : t.slice(dot + 1);
  const id = parseId(idPart);
  if (!id) return null;
  if (subPart !== undefined) {
    const sub = parseId(subPart);
    if (!sub) return null;
    return { ns, id, sub };
  }
  return { ns, id };
}

export function parsePointOrRef(raw: string | undefined): PointOrRef | null {
  if (raw === undefined) return null;
  const t = raw.trim();
  if (t.length === 0) return null;
  const c = t.charCodeAt(0);
  if (isDigit(c) || c === 45 || c === 43 || c === 46) {
    const p = parsePoint(t);
    return p ? { kind: "point", point: p } : null;
  }
  const r = parseRef(t);
  return r ? { kind: "ref", ref: r } : null;
}

export function refToString(r: Ref): string {
  return (r.ns === "anchor" ? "@" : "") + r.id + (r.sub ? "." + r.sub : "");
}

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

export const PALETTE = {
  black: "#1f2328",
  blue: "#1e5bd8",
  red: "#d6336c",
  green: "#2b8a3e",
  orange: "#e8590c",
  purple: "#7048e8",
  gray: "#6b7280",
  brown: "#8d5524",
  teal: "#0c8599",
  white: "#ffffff",
  yellow: "#f2c200",
  pink: "#e64980",
} as const;

export type PaletteName = keyof typeof PALETTE;

function isHex(c: number): boolean {
  return isDigit(c) || (c >= 97 && c <= 102) || (c >= 65 && c <= 70);
}

/** Named palette colour or #rgb / #rrggbb. Returns a hex string. */
export function parseColor(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const t = raw.trim().toLowerCase();
  if (t.length === 0) return null;
  if (t === "grey") return PALETTE.gray;
  const named = own<string>(PALETTE, t);
  if (named !== undefined) return named;
  if (t.charCodeAt(0) === 35 && (t.length === 4 || t.length === 7)) {
    for (let i = 1; i < t.length; i++) if (!isHex(t.charCodeAt(i))) return null;
    if (t.length === 4) return "#" + t[1] + t[1] + t[2] + t[2] + t[3] + t[3];
    return t;
  }
  return null;
}

export function parseEnum<T extends string>(raw: string | undefined, values: readonly T[]): T | null {
  if (raw === undefined) return null;
  const t = raw.trim().toLowerCase();
  for (const v of values) if (v === t) return v;
  return null;
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/** "a|b|c ; d|e|f" or newline-separated rows. */
export function parseRows(raw: string | undefined, maxRows = 40, maxCols = 12): string[][] | null {
  if (raw === undefined) return null;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  const pushCell = () => {
    if (row.length < maxCols) row.push(cell.trim());
    cell = "";
  };
  const pushRow = () => {
    pushCell();
    if (row.some((c) => c.length > 0) && rows.length < maxRows) rows.push(row);
    row = [];
  };
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (c === 124 /* | */) pushCell();
    else if (c === SEMI || c === 10) pushRow();
    else if (c !== 13) cell += raw[i];
  }
  pushRow();
  return rows.length > 0 ? rows : null;
}

// ---------------------------------------------------------------------------
// SVG path data
// ---------------------------------------------------------------------------

function isCommand(c: number): boolean {
  switch (c) {
    case 77: case 109: // M m
    case 76: case 108: // L l
    case 72: case 104: // H h
    case 86: case 118: // V v
    case 67: case 99: // C c
    case 83: case 115: // S s
    case 81: case 113: // Q q
    case 84: case 116: // T t
    case 65: case 97: // A a
    case 90: case 122: // Z z
      return true;
    default:
      return false;
  }
}

/**
 * Parse SVG path data into absolute M/L/C/Q/Z segments.
 * H/V become L, S/T are expanded with reflected control points and arcs are
 * converted to cubic Béziers. Returns null if nothing drawable was found.
 */
export function parsePathData(raw: string | undefined, maxSegs = 5000): PathSeg[] | null {
  if (raw === undefined) return null;
  const sc = new Scanner(raw);
  const out: PathSeg[] = [];
  let cx = 0, cy = 0; // current point
  let sx = 0, sy = 0; // subpath start
  let lastCtrlX = 0, lastCtrlY = 0;
  let lastCmd = 0; // char code of the last command (upper-case)
  let cmd = -1;

  const nextNum = (): number | null => {
    sc.skipSep([COMMA]);
    return sc.number();
  };

  while (out.length < maxSegs) {
    sc.skipSep([COMMA]);
    if (sc.done) break;
    const c = sc.peek();
    if (isCommand(c)) {
      cmd = c;
      sc.i++;
    } else if (cmd === -1) {
      return out.length ? out : null; // garbage before any command
    }
    // else: implicit repetition of the previous command
    const rel = cmd >= 97;
    const up = rel ? cmd - 32 : cmd;
    const ox = rel ? cx : 0;
    const oy = rel ? cy : 0;

    if (up === 90 /* Z */) {
      out.push({ c: "Z" });
      cx = sx;
      cy = sy;
      lastCmd = up;
      // Z takes no args; a following number would be garbage unless a command follows.
      cmd = -1;
      continue;
    }

    const before = sc.i;
    let ok = true;
    switch (up) {
      case 77: { // M
        const x = nextNum(), y = nextNum();
        if (x === null || y === null) { ok = false; break; }
        cx = ox + x; cy = oy + y; sx = cx; sy = cy;
        out.push({ c: "M", x: cx, y: cy });
        cmd = rel ? 108 : 76; // subsequent pairs are implicit L
        break;
      }
      case 76: { // L
        const x = nextNum(), y = nextNum();
        if (x === null || y === null) { ok = false; break; }
        cx = ox + x; cy = oy + y;
        out.push({ c: "L", x: cx, y: cy });
        break;
      }
      case 72: { // H
        const x = nextNum();
        if (x === null) { ok = false; break; }
        cx = ox + x;
        out.push({ c: "L", x: cx, y: cy });
        break;
      }
      case 86: { // V
        const y = nextNum();
        if (y === null) { ok = false; break; }
        cy = (rel ? cy : 0) + y;
        out.push({ c: "L", x: cx, y: cy });
        break;
      }
      case 67: { // C
        const a = [nextNum(), nextNum(), nextNum(), nextNum(), nextNum(), nextNum()];
        if (a.some((v) => v === null)) { ok = false; break; }
        const [x1, y1, x2, y2, x, y] = a as number[];
        out.push({ c: "C", x1: ox + x1, y1: oy + y1, x2: ox + x2, y2: oy + y2, x: ox + x, y: oy + y });
        lastCtrlX = ox + x2; lastCtrlY = oy + y2;
        cx = ox + x; cy = oy + y;
        break;
      }
      case 83: { // S
        const a = [nextNum(), nextNum(), nextNum(), nextNum()];
        if (a.some((v) => v === null)) { ok = false; break; }
        const [x2, y2, x, y] = a as number[];
        const x1 = lastCmd === 67 || lastCmd === 83 ? 2 * cx - lastCtrlX : cx;
        const y1 = lastCmd === 67 || lastCmd === 83 ? 2 * cy - lastCtrlY : cy;
        out.push({ c: "C", x1, y1, x2: ox + x2, y2: oy + y2, x: ox + x, y: oy + y });
        lastCtrlX = ox + x2; lastCtrlY = oy + y2;
        cx = ox + x; cy = oy + y;
        break;
      }
      case 81: { // Q
        const a = [nextNum(), nextNum(), nextNum(), nextNum()];
        if (a.some((v) => v === null)) { ok = false; break; }
        const [x1, y1, x, y] = a as number[];
        out.push({ c: "Q", x1: ox + x1, y1: oy + y1, x: ox + x, y: oy + y });
        lastCtrlX = ox + x1; lastCtrlY = oy + y1;
        cx = ox + x; cy = oy + y;
        break;
      }
      case 84: { // T
        const x = nextNum(), y = nextNum();
        if (x === null || y === null) { ok = false; break; }
        const x1 = lastCmd === 81 || lastCmd === 84 ? 2 * cx - lastCtrlX : cx;
        const y1 = lastCmd === 81 || lastCmd === 84 ? 2 * cy - lastCtrlY : cy;
        out.push({ c: "Q", x1, y1, x: ox + x, y: oy + y });
        lastCtrlX = x1; lastCtrlY = y1;
        cx = ox + x; cy = oy + y;
        break;
      }
      case 65: { // A
        sc.skipSep([COMMA]);
        const rx = sc.number();
        const ry = nextNum();
        const rot = nextNum();
        sc.skipSep([COMMA]);
        const large = sc.flag();
        sc.skipSep([COMMA]);
        const sweep = sc.flag();
        const x = nextNum(), y = nextNum();
        if (rx === null || ry === null || rot === null || large === null || sweep === null || x === null || y === null) {
          ok = false;
          break;
        }
        const ex = ox + x, ey = oy + y;
        for (const seg of arcToCubics(cx, cy, rx, ry, rot, large === 1, sweep === 1, ex, ey)) out.push(seg);
        cx = ex; cy = ey;
        break;
      }
      default:
        ok = false;
    }
    if (!ok) {
      // Malformed arguments: stop parsing and keep what we have.
      sc.i = before;
      break;
    }
    lastCmd = up;
  }
  // Must contain at least one drawing segment.
  if (!out.some((s) => s.c !== "M" && s.c !== "Z")) return null;
  if (out[0].c !== "M") out.unshift({ c: "M", x: 0, y: 0 });
  return out;
}

/** Endpoint-parameterised elliptical arc → cubic Béziers (SVG spec F.6). */
export function arcToCubics(
  x1: number, y1: number, rxIn: number, ryIn: number, phiDeg: number,
  largeArc: boolean, sweep: boolean, x2: number, y2: number,
): PathSeg[] {
  if (x1 === x2 && y1 === y2) return [];
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx === 0 || ry === 0) return [{ c: "L", x: x2, y: y2 }];
  const phi = (phiDeg * Math.PI) / 180;
  const cosP = Math.cos(phi), sinP = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cosP * dx + sinP * dy;
  const y1p = -sinP * dx + cosP * dy;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let coef = den === 0 ? 0 : Math.sqrt(Math.max(0, num / den));
  if (largeArc === sweep) coef = -coef;
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const cx = cosP * cxp - sinP * cyp + (x1 + x2) / 2;
  const cy = sinP * cxp + cosP * cyp + (y1 + y2) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    let a = Math.acos(Math.min(1, Math.max(-1, dot / len)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const theta1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dTheta = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI;
  if (sweep && dTheta < 0) dTheta += 2 * Math.PI;
  const n = Math.max(1, Math.ceil(Math.abs(dTheta) / (Math.PI / 2)));
  const delta = dTheta / n;
  const t = (4 / 3) * Math.tan(delta / 4);
  const segs: PathSeg[] = [];
  let th = theta1;
  for (let i = 0; i < n; i++) {
    const c1 = Math.cos(th), s1 = Math.sin(th);
    const c2 = Math.cos(th + delta), s2 = Math.sin(th + delta);
    const p = (ex: number, ey: number) => ({ x: cx + rx * ex * cosP - ry * ey * sinP, y: cy + rx * ex * sinP + ry * ey * cosP });
    const a1 = p(c1 - t * s1, s1 + t * c1);
    const a2 = p(c2 + t * s2, s2 - t * c2);
    const e = p(c2, s2);
    segs.push({ c: "C", x1: a1.x, y1: a1.y, x2: a2.x, y2: a2.y, x: e.x, y: e.y });
    th += delta;
  }
  return segs;
}

/** Serialise absolute segments back to compact SVG path data. */
export function pathSegsToD(segs: readonly PathSeg[], fmt: (n: number) => string = fmt2): string {
  let d = "";
  for (const s of segs) {
    switch (s.c) {
      case "M": d += `M${fmt(s.x)} ${fmt(s.y)}`; break;
      case "L": d += `L${fmt(s.x)} ${fmt(s.y)}`; break;
      case "C": d += `C${fmt(s.x1)} ${fmt(s.y1)} ${fmt(s.x2)} ${fmt(s.y2)} ${fmt(s.x)} ${fmt(s.y)}`; break;
      case "Q": d += `Q${fmt(s.x1)} ${fmt(s.y1)} ${fmt(s.x)} ${fmt(s.y)}`; break;
      case "Z": d += "Z"; break;
    }
  }
  return d;
}

export function fmt2(n: number): string {
  return (Math.round(n * 100) / 100).toString();
}
