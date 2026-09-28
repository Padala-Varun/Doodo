import type { Box, Point } from "../geom";

/**
 * A renderable, animatable piece of an element. Everything is vector data in
 * board coordinates so the board can be re-rendered, moved, snapshotted and
 * animated uniformly.
 */
export type Stroke =
  /** Stroked SVG path, revealed with dash-offset while the pen follows it. */
  | { t: "path"; d: string; color: string; width: number; len: number; opacity?: number; dash?: boolean; z?: "under"; blend?: boolean }
  /** Pressure-like marker stroke (perfect-freehand), revealed by growing the point list. */
  | { t: "ink"; pts: [number, number][]; color: string; size: number; len: number; opacity?: number; z?: "under"; blend?: boolean; taper?: boolean }
  /** Filled path revealed by a left-to-right wipe (solid fills, text halos). */
  | { t: "fill"; d: string; color: string; opacity?: number; box: Box; z?: "under" }
  /** Pre-rendered SVG markup (math), wiped in. */
  | { t: "svg"; markup: string; color: string; box: Box }
  /** Last-resort glyph in a system font (characters the stroke font lacks). */
  | { t: "text"; text: string; x: number; y: number; size: number; color: string; box: Box }
  /** Raster image (uploads). */
  | { t: "image"; href: string; box: Box };

export type ElementKind =
  | "write" | "shape" | "enclose" | "line" | "poly" | "path" | "sketch" | "label" | "callout" | "mark"
  | "brace" | "math" | "plot" | "table"
  // user-created
  | "ink" | "text" | "image" | "rect" | "ellipse" | "arrow" | "highlight";

export interface BoardElement {
  id: string;
  author: "user" | "doodo";
  kind: ElementKind;
  strokes: Stroke[];
  /** Bounding box (board coords) including all strokes. */
  box: Box;
  /** Named sub-anchors (a, b, c, ab, start, end, p0 …) in board coords. */
  points?: Record<string, Point>;
  /** Outward normals for edge sub-anchors, used to place labels outside shapes. */
  normals?: Record<string, Point>;
  /** Shape outline kind, for connector attachment. */
  outline?: "box" | "ellipse";
  text?: string;
  /** Creation order (z-order). */
  seq: number;
  /** Excluded from collision avoidance (highlights, underlines, pointers). */
  passive?: boolean;
  /** Precise regions the element occupies (for layout); defaults to [box]. */
  occupied?: Box[];
  /** Carries text, so other text must not be placed on top of it. */
  textual?: boolean;
}
