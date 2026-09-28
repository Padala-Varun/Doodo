import { inkPath } from "../board/freehand";
import type { BoardElement, Stroke } from "../board/types";

export const SVG_NS = "http://www.w3.org/2000/svg";
export const FALLBACK_FONT = "'Segoe Print', 'Bradley Hand', 'Comic Sans MS', 'Chalkboard SE', cursive";

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
}

// ---------------------------------------------------------------------------
// Math SVG sanitiser: rebuild only a small allow-list of elements/attributes.
// ---------------------------------------------------------------------------

const ALLOWED_TAGS = new Set(["svg", "g", "path", "rect", "line", "polyline", "polygon", "circle", "ellipse"]);
const ALLOWED_ATTRS = new Set([
  "d", "transform", "x", "y", "x1", "y1", "x2", "y2", "width", "height", "viewBox", "fill", "stroke",
  "stroke-width", "points", "cx", "cy", "r", "rx", "ry",
]);
const sanitizedCache = new Map<string, SVGElement | null>();

function safeValue(v: string): boolean {
  const low = v.toLowerCase();
  return !low.includes("url(") && !low.includes("javascript:") && !low.includes("expression(") && v.length < 200_000;
}

function rebuild(node: Element): SVGElement | null {
  const tag = node.localName;
  if (!ALLOWED_TAGS.has(tag)) return null;
  const out = document.createElementNS(SVG_NS, tag);
  for (const a of Array.from(node.attributes)) {
    if (ALLOWED_ATTRS.has(a.name) && safeValue(a.value)) out.setAttribute(a.name, a.value);
  }
  for (const child of Array.from(node.children)) {
    const c = rebuild(child);
    if (c) out.appendChild(c);
  }
  return out;
}

export function sanitizeSvg(markup: string): SVGElement | null {
  const cached = sanitizedCache.get(markup);
  if (cached !== undefined) return cached ? (cached.cloneNode(true) as SVGElement) : null;
  let result: SVGElement | null = null;
  try {
    const doc = new DOMParser().parseFromString(markup, "image/svg+xml");
    const root = doc.documentElement;
    if (root && root.localName === "svg" && !doc.getElementsByTagName("parsererror").length) result = rebuild(root);
  } catch {
    result = null;
  }
  if (sanitizedCache.size > 300) sanitizedCache.clear();
  sanitizedCache.set(markup, result);
  return result ? (result.cloneNode(true) as SVGElement) : null;
}

// ---------------------------------------------------------------------------

/** Create the final-state DOM node for a stroke. */
export function strokeNode(s: Stroke): SVGElement {
  switch (s.t) {
    case "path": {
      const n = el("path", {
        d: s.d, fill: "none", stroke: s.color, "stroke-width": s.width,
        "stroke-linecap": "round", "stroke-linejoin": "round",
      });
      if (s.opacity !== undefined) n.setAttribute("opacity", String(s.opacity));
      if (s.dash) n.setAttribute("stroke-dasharray", `${s.width * 4} ${s.width * 3}`);
      if (s.blend) n.style.mixBlendMode = "multiply";
      return n;
    }
    case "ink": {
      const n = el("path", { d: inkPath(s.pts, s.size, s.taper), fill: s.color });
      if (s.opacity !== undefined) n.setAttribute("opacity", String(s.opacity));
      if (s.blend) n.style.mixBlendMode = "multiply";
      return n;
    }
    case "fill": {
      const n = el("path", { d: s.d, fill: s.color });
      if (s.opacity !== undefined) n.setAttribute("opacity", String(s.opacity));
      return n;
    }
    case "svg": {
      const g = el("g", { transform: `translate(${s.box.x} ${s.box.y})` });
      g.style.color = s.color;
      const svg = sanitizeSvg(s.markup);
      if (svg) {
        svg.setAttribute("width", String(s.box.w));
        svg.setAttribute("height", String(s.box.h));
        svg.setAttribute("overflow", "visible");
        g.appendChild(svg);
      }
      return g;
    }
    case "text": {
      const n = el("text", { x: s.x, y: s.y, "font-size": s.size, fill: s.color, "font-family": FALLBACK_FONT });
      n.textContent = s.text;
      return n;
    }
    case "image": {
      const n = el("image", { x: s.box.x, y: s.box.y, width: s.box.w, height: s.box.h, preserveAspectRatio: "none" });
      n.setAttribute("href", s.href);
      return n;
    }
  }
}

/** Fills, shading, highlights and images live in the board-wide under layer, below all ink. */
export function isUnderStroke(s: Stroke): boolean {
  return s.t === "image" || ("z" in s && s.z === "under");
}

/**
 * Build an element's group: fills/shading in an "under" layer, ink on top.
 * Returns the group and its two layers.
 */
export function elementGroup(elm: BoardElement): { g: SVGGElement; under: SVGGElement; over: SVGGElement } {
  const g = el("g", { "data-id": elm.id, "data-author": elm.author });
  const under = el("g", {});
  const over = el("g", {});
  g.append(under, over);
  return { g, under, over };
}

export function renderElement(elm: BoardElement): SVGGElement {
  const { g, under, over } = elementGroup(elm);
  for (const s of elm.strokes) {
    const n = strokeNode(s);
    if (isUnderStroke(s)) under.appendChild(n);
    else over.appendChild(n);
  }
  return g;
}
