import { flatten, mapSegs, pointsBox, rng, hashString } from "../geom";
import { own } from "../own";
import { parsePathData, type PathSeg, type Point } from "../dml/values";
import { SYMBOL_GLYPHS, SUPERSCRIPTS, SUBSCRIPTS, ASCII_EQUIVALENTS, COMBINING_MARKS } from "./symbols";

/**
 * Single-stroke handwriting font.
 *
 * Glyph data are pen centre-lines (Vara JSON format), so text can be *written*
 * stroke by stroke rather than faded in. All glyphs are normalised to em
 * units: x from 0 (left edge of ink), y = 0 at the baseline, y < 0 upwards,
 * cap height = CAP_HEIGHT em.
 */

export const CAP_HEIGHT = 0.68;
/** px per em for a given text `size` (size ≈ height of a line of lowercase + ascenders + descenders). */
export const EM_PER_SIZE = 0.85;

export interface Glyph {
  /** Pen strokes in em units. */
  strokes: PathSeg[][];
  /** Advance width in em (ink width; tracking is added by layout). */
  width: number;
}

interface VaraPath {
  mx: number;
  my: number;
  d: string;
}

interface VaraJson {
  c: Record<string, { paths: VaraPath[]; w: number }>;
  p: { space: number };
}

export interface PlacedGlyph {
  char: string;
  /** Offset of the glyph origin (left, baseline) from the text box's top-left, in px. */
  x: number;
  y: number;
  /** Final px per em for this glyph (super/subscripts are smaller). */
  scale: number;
  glyph: Glyph | null;
  /** Width in px occupied by this glyph (without tracking). */
  width: number;
  /** Jitter: rotation in radians around the glyph centre. */
  rot: number;
}

export interface TextLayout {
  lines: { glyphs: PlacedGlyph[]; width: number; text: string }[];
  width: number;
  height: number;
  /** px from the top of a line box to its baseline. */
  ascent: number;
  lineHeight: number;
  size: number;
}

export class StrokeFont {
  private readonly glyphs = new Map<string, Glyph>();
  readonly spaceWidth: number;
  /** Max ink extents over all glyphs (em). */
  readonly ascent: number;
  readonly descent: number;

  private constructor(glyphs: Map<string, Glyph>, spaceWidth: number) {
    this.glyphs = glyphs;
    this.spaceWidth = spaceWidth;
    let asc = CAP_HEIGHT, desc = 0.2;
    for (const [ch, g] of glyphs) {
      if (ch.length !== 1 || ch.charCodeAt(0) > 126) continue;
      for (const s of g.strokes) {
        for (const line of flatten(s, 0.05)) {
          for (const p of line) {
            if (-p.y > asc) asc = -p.y;
            if (p.y > desc) desc = p.y;
          }
        }
      }
    }
    this.ascent = Math.min(asc, 1.1);
    this.descent = Math.min(desc, 0.5);
  }

  static fromVara(json: VaraJson): StrokeFont {
    // 1) Parse every glyph into absolute font-unit segments.
    const raw = new Map<string, { strokes: PathSeg[][]; box: { x: number; y: number; w: number; h: number } }>();
    for (const [code, g] of Object.entries(json.c)) {
      const ch = String.fromCharCode(Number(code));
      const strokes: PathSeg[][] = [];
      const pts: Point[] = [];
      for (const p of g.paths) {
        const segs = parsePathData(p.d);
        if (!segs) continue;
        const abs = mapSegs(segs, (q) => ({ x: q.x + p.mx, y: q.y - p.my }));
        strokes.push(abs);
        for (const line of flatten(abs, 0.5)) pts.push(...line);
      }
      if (strokes.length) raw.set(ch, { strokes, box: pointsBox(pts) });
    }
    // 2) Metrics from reference letters.
    const bottoms: number[] = [];
    for (const ch of "acemnorsuvwxzABDEHIKLMNRUVWXZ") {
      const r = raw.get(ch);
      if (r) bottoms.push(r.box.y + r.box.h);
    }
    bottoms.sort((a, b) => a - b);
    const baseline = bottoms.length ? bottoms[Math.floor(bottoms.length / 2)] : 0;
    const capTops: number[] = [];
    for (const ch of "HIEKLT") {
      const r = raw.get(ch);
      if (r) capTops.push(r.box.y);
    }
    capTops.sort((a, b) => a - b);
    const capTop = capTops.length ? capTops[Math.floor(capTops.length / 2)] : baseline - 30;
    const em = CAP_HEIGHT / Math.max(1e-6, baseline - capTop);

    // 3) Normalise to em units.
    const glyphs = new Map<string, Glyph>();
    for (const [ch, r] of raw) {
      const x0 = r.box.x;
      glyphs.set(ch, {
        strokes: r.strokes.map((s) => mapSegs(s, (q) => ({ x: (q.x - x0) * em, y: (q.y - baseline) * em }))),
        width: Math.max(r.box.w * em, 0.12),
      });
    }
    // 4) Hand-made symbol glyphs (arrows, math, Greek, ₹ …), defined in 1/100 em.
    for (const [ch, def] of Object.entries(SYMBOL_GLYPHS)) {
      if (glyphs.has(ch)) continue;
      const strokes: PathSeg[][] = [];
      for (const d of def.d) {
        const segs = parsePathData(d);
        if (segs) strokes.push(mapSegs(segs, (q) => ({ x: q.x / 100, y: q.y / 100 })));
      }
      if (strokes.length) glyphs.set(ch, { strokes, width: def.w / 100 });
    }
    return new StrokeFont(glyphs, json.p.space * em * 0.9);
  }

  has(ch: string): boolean {
    return this.glyphs.has(ch);
  }

  get(ch: string): Glyph | null {
    return this.glyphs.get(ch) ?? null;
  }

  /**
   * Resolve a character to one or more renderable glyph pieces, handling
   * super/subscripts, ASCII equivalents (curly quotes, dashes) and accents.
   */
  private pieces(ch: string): { glyph: Glyph | null; scale: number; dy: number; char: string; overlay?: boolean }[] {
    const direct = this.glyphs.get(ch);
    if (direct) return [{ glyph: direct, scale: 1, dy: 0, char: ch }];
    const sup = own(SUPERSCRIPTS, ch);
    if (sup && this.glyphs.get(sup)) return [{ glyph: this.glyphs.get(sup)!, scale: 0.6, dy: -0.42, char: ch }];
    const sub = own(SUBSCRIPTS, ch);
    if (sub && this.glyphs.get(sub)) return [{ glyph: this.glyphs.get(sub)!, scale: 0.6, dy: 0.14, char: ch }];
    const eq = own(ASCII_EQUIVALENTS, ch);
    if (eq !== undefined) {
      return Array.from(eq).flatMap((c) => this.pieces(c));
    }
    // Accented letters: decompose into base + combining marks.
    const nfd = ch.normalize("NFD");
    if (nfd.length > 1) {
      const base = this.glyphs.get(nfd[0]);
      if (base) {
        const out: { glyph: Glyph | null; scale: number; dy: number; char: string; overlay?: boolean }[] = [
          { glyph: base, scale: 1, dy: 0, char: nfd[0] },
        ];
        const upper = nfd[0] !== nfd[0].toLowerCase();
        for (const mark of nfd.slice(1)) {
          const m = own(COMBINING_MARKS, mark);
          const mg = m ? this.glyphs.get(m) : undefined;
          if (mg) out.push({ glyph: mg, scale: 1, dy: upper ? -0.3 : 0, char: mark, overlay: true });
        }
        return out;
      }
    }
    return [{ glyph: null, scale: 1, dy: 0, char: ch }];
  }

  /** Lay out text at `size` px (≈ line height of the letters), wrapping at `maxWidth` px. */
  layout(text: string, size: number, maxWidth = Infinity, seed = 0): TextLayout {
    const em = size * EM_PER_SIZE;
    const tracking = 0.07 * em;
    const lineHeight = (this.ascent + this.descent) * em * 1.15;
    const ascentPx = this.ascent * em;
    const rand = rng(seed || hashString(text));
    const fallbackW = 0.5 * em;

    const measureWord = (word: string): number => {
      let w = 0;
      for (const ch of word) {
        for (const p of this.pieces(ch)) {
          if (p.overlay) continue;
          w += (p.glyph ? p.glyph.width * em * p.scale : fallbackW) + tracking;
        }
      }
      return w;
    };

    const lines: TextLayout["lines"] = [];
    const space = this.spaceWidth * em;
    for (const para of text.split("\n")) {
      // Word wrap on spaces.
      let lineWords: string[] = [];
      let lineW = 0;
      const flush = () => {
        lines.push(this.placeLine(lineWords.join(" "), em, tracking, rand));
        lineWords = [];
        lineW = 0;
      };
      for (const word of para.split(" ")) {
        const ww = measureWord(word);
        if (lineWords.length > 0 && lineW + space + ww > maxWidth) flush();
        if (lineWords.length === 0 && ww > maxWidth && word.length > 1) {
          // Break an over-long word by characters.
          let chunk = "";
          for (const ch of word) {
            if (chunk && measureWord(chunk + ch) > maxWidth) {
              lineWords = [chunk];
              flush();
              chunk = "";
            }
            chunk += ch;
          }
          lineWords = [chunk];
          lineW = measureWord(chunk);
          continue;
        }
        lineW += (lineWords.length > 0 ? space : 0) + ww;
        lineWords.push(word);
      }
      flush();
    }
    // Position lines vertically.
    let width = 0;
    lines.forEach((l, i) => {
      for (const g of l.glyphs) g.y += ascentPx + i * lineHeight;
      width = Math.max(width, l.width);
    });
    const height = lines.length === 0 ? 0 : ascentPx + (lines.length - 1) * lineHeight + this.descent * em;
    return { lines, width, height, ascent: ascentPx, lineHeight, size };
  }

  private placeLine(text: string, em: number, tracking: number, rand: () => number): TextLayout["lines"][number] {
    const glyphs: PlacedGlyph[] = [];
    let x = 0;
    const space = this.spaceWidth * em;
    for (const ch of text) {
      if (ch === " ") {
        x += space;
        continue;
      }
      let prevStart = x;
      let prevWidth = 0;
      for (const p of this.pieces(ch)) {
        const s = em * p.scale;
        const jitterY = (rand() - 0.5) * 0.04 * em;
        const rot = ((rand() - 0.5) * 3.2 * Math.PI) / 180;
        if (p.overlay && p.glyph) {
          // Centre the accent over the previous glyph.
          const w = p.glyph.width * s;
          glyphs.push({ char: p.char, x: prevStart + (prevWidth - w) / 2, y: p.dy * em, scale: s, glyph: p.glyph, width: w, rot: 0 });
          continue;
        }
        const w = p.glyph ? p.glyph.width * s : 0.5 * em;
        glyphs.push({ char: p.char, x, y: p.dy * em + jitterY, scale: s, glyph: p.glyph, width: w, rot });
        prevStart = x;
        prevWidth = w;
        x += w + tracking;
      }
    }
    return { glyphs, width: Math.max(0, x - tracking), text };
  }
}

/** Glyph strokes → absolute board-space path segments for a placed glyph. */
export function glyphStrokes(pg: PlacedGlyph, originX: number, originY: number): PathSeg[][] {
  if (!pg.glyph) return [];
  const s = pg.scale;
  const cx = pg.glyph.width / 2;
  const cy = -CAP_HEIGHT / 2;
  const cos = Math.cos(pg.rot), sin = Math.sin(pg.rot);
  return pg.glyph.strokes.map((segs) =>
    mapSegs(segs, (q) => {
      const dx = q.x - cx, dy = q.y - cy;
      const rx = cx + dx * cos - dy * sin;
      const ry = cy + dx * sin + dy * cos;
      return { x: originX + pg.x + rx * s, y: originY + pg.y + ry * s };
    }),
  );
}
