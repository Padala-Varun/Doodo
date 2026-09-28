import { parsePathData, pathSegsToD } from "../dml/values";
import { dist, mapSegs, translateBox, type Box, type Point } from "../geom";
import type { BoardElement, Stroke } from "./types";

/** Return a copy of the element moved by (dx, dy). */
export function translateElement(el: BoardElement, dx: number, dy: number): BoardElement {
  if (dx === 0 && dy === 0) return el;
  const mv = (p: Point): Point => ({ x: p.x + dx, y: p.y + dy });
  const strokes: Stroke[] = el.strokes.map((s) => {
    switch (s.t) {
      case "path":
      case "fill": {
        const segs = parsePathData(s.d);
        const d = segs ? pathSegsToD(mapSegs(segs, mv)) : s.d;
        return s.t === "fill" ? { ...s, d, box: translateBox(s.box, dx, dy) } : { ...s, d };
      }
      case "ink":
        return { ...s, pts: s.pts.map(([x, y]) => [x + dx, y + dy] as [number, number]) };
      case "svg":
      case "image":
        return { ...s, box: translateBox(s.box, dx, dy) };
      case "text":
        return { ...s, x: s.x + dx, y: s.y + dy, box: translateBox(s.box, dx, dy) };
    }
  });
  const mapRec = (r?: Record<string, Point>) => (r ? Object.fromEntries(Object.entries(r).map(([k, p]) => [k, mv(p)])) : undefined);
  return {
    ...el,
    strokes,
    box: translateBox(el.box, dx, dy),
    points: mapRec(el.points),
    normals: el.normals,
    occupied: el.occupied?.map((b) => translateBox(b, dx, dy)),
  };
}

/** Precise-ish hit test: box first, then distance to ink/path geometry for thin strokes. */
export function hitTest(el: BoardElement, p: Point, tolerance: number): boolean {
  const b = el.box;
  if (p.x < b.x - tolerance || p.x > b.x + b.w + tolerance || p.y < b.y - tolerance || p.y > b.y + b.h + tolerance) return false;
  // Filled/area-like elements: the box is a good enough hit region.
  if (el.kind === "image" || el.kind === "write" || el.kind === "text" || el.kind === "math" || el.kind === "table" || el.kind === "shape" || el.kind === "label") return true;
  for (const s of el.strokes) {
    if (s.t === "ink") {
      const r = s.size / 2 + tolerance;
      for (const [x, y] of s.pts) if (dist({ x, y }, p) <= r) return true;
    } else if (s.t === "fill" || s.t === "svg" || s.t === "image" || s.t === "text") {
      const sb: Box = s.box;
      if (p.x >= sb.x && p.x <= sb.x + sb.w && p.y >= sb.y && p.y <= sb.y + sb.h) return true;
    } else if (s.t === "path") {
      const segs = parsePathData(s.d);
      if (!segs) continue;
      for (const seg of segs) {
        if (seg.c !== "Z" && dist({ x: seg.x, y: seg.y }, p) <= tolerance + s.width + 6) return true;
      }
    }
  }
  return false;
}
