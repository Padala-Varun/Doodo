import type { PathSeg, Point, PointOrRef, Ref } from "./values";

/** Logical board width. Height grows as the lesson needs it. */
export const BOARD_WIDTH = 1600;
export const BOARD_MIN_HEIGHT = 900;
export const BOARD_MAX_HEIGHT = 12_000;

export type Region =
  | "top" | "top-left" | "top-right"
  | "left" | "center" | "right"
  | "bottom" | "bottom-left" | "bottom-right"
  | "left-panel" | "right-panel";

export const REGIONS: readonly Region[] = [
  "top", "top-left", "top-right", "left", "center", "right",
  "bottom", "bottom-left", "bottom-right", "left-panel", "right-panel",
];

export type Side = "top" | "bottom" | "left" | "right" | "top-left" | "top-right" | "bottom-left" | "bottom-right";
export const SIDES: readonly Side[] = ["top", "bottom", "left", "right", "top-left", "top-right", "bottom-left", "bottom-right"];

export type FillStyle = "none" | "hachure" | "solid" | "cross-hatch" | "dots" | "zigzag";
export const FILL_STYLES: readonly FillStyle[] = ["none", "hachure", "solid", "cross-hatch", "dots", "zigzag"];

export interface Style {
  color: string;
  /** Stroke width in board px. */
  width: number;
  fill: FillStyle;
  fillColor?: string;
  dash: boolean;
}

/** How to position an element whose size is known (text, box, math, table, sketch frame). */
export interface Placement {
  x?: number;
  y?: number;
  at?: Region;
  below?: Ref;
  above?: Ref;
  rightOf?: Ref;
  leftOf?: Ref;
  gap?: number;
  align?: "start" | "center" | "end";
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type ShapeKind = "rect" | "round" | "ellipse" | "diamond";
export type ArrowHeads = "none" | "end" | "start" | "both";

export interface SketchStroke {
  /** Polyline in the sketch's local 0..100 frame (smoothed at render time) ... */
  points?: Point[];
  /** ... or SVG path data in the local frame. */
  segs?: PathSeg[];
  closed: boolean;
  color?: string;
  width?: number;
  fill?: FillStyle;
  fillColor?: string;
}

export interface MathSvg {
  /** Serialized <svg> (pure paths, currentColor) produced by MathJax on the server. */
  markup: string;
  /** Size in board px at the requested font size. */
  width: number;
  height: number;
  /** Distance of the baseline from the top, in board px. */
  baseline: number;
}

export type Op =
  | { op: "voice"; id: string; text: string }
  | { op: "write"; id: string; text: string; size: number; place: Placement; style: Style; maxWidth?: number }
  | { op: "shape"; id: string; kind: ShapeKind; place: Placement; w?: number; h?: number; text?: string; size: number; style: Style }
  | { op: "enclose"; id: string; kind: "circle" | "rect"; target: Ref; pad: number; style: Style }
  | {
      op: "line"; id: string; from: PointOrRef; to: PointOrRef; heads: ArrowHeads;
      curve: number; label?: string; size: number; style: Style;
    }
  | {
      op: "poly"; id: string; points: Point[]; closed: boolean; smooth: boolean; heads: ArrowHeads;
      /** Optional vertex names (tri: a, b, c) usable as sub-anchors. */
      names?: string[]; rightAngle?: string; style: Style;
    }
  | { op: "path"; id: string; segs: PathSeg[]; style: Style }
  | { op: "sketch"; id: string; place: Placement; w: number; h: number; strokes: SketchStroke[]; style: Style }
  | { op: "label"; id: string; target: Ref; text: string; side?: Side; size: number; style: Style }
  | { op: "callout"; id: string; target: Ref; text: string; side?: Side; size: number; style: Style }
  | { op: "mark"; id: string; kind: "underline" | "highlight" | "strike"; target: Ref; style: Style }
  | { op: "brace"; id: string; target: Ref; side: "left" | "right" | "top" | "bottom"; text?: string; size: number; style: Style }
  | { op: "math"; id: string; tex: string; size: number; place: Placement; style: Style; svg?: MathSvg }
  | {
      op: "plot"; id: string; fns: string[]; place: Placement; w: number; h: number;
      xr: [number, number]; yr: [number, number]; grid: boolean; xlabel?: string; ylabel?: string; style: Style;
    }
  | { op: "table"; id: string; rows: string[][]; place: Placement; size: number; style: Style }
  | { op: "find"; id: string; desc: string; kind: "object" | "text" | "region" }
  | { op: "erase"; target: Ref | null }
  | { op: "pause"; ms: number }
  | { op: "point"; target: PointOrRef; ms: number };

export type OpKind = Op["op"];
export type OpOf<K extends OpKind> = Extract<Op, { op: K }>;

/** Ops that create a visible, addressable board element. */
export type DrawOp = Exclude<Op, { op: "voice" } | { op: "find" } | { op: "erase" } | { op: "pause" } | { op: "point" }>;

export function isDrawOp(op: Op): op is DrawOp {
  return op.op !== "voice" && op.op !== "find" && op.op !== "erase" && op.op !== "pause" && op.op !== "point";
}

export const TEXT_SIZES = { xs: 22, s: 28, m: 36, l: 48, xl: 64 } as const;
