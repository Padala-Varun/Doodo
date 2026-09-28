import { inkPath } from "../board/freehand";
import { strokeDurationMs } from "../board/compile";
import type { BoardElement, Stroke } from "../board/types";
import { dist, type Box, type Point } from "../geom";
import type { LessonClock } from "./clock";
import { isUnderStroke, strokeNode, SVG_NS } from "./svgRender";

export interface AnimatorHooks {
  /** Called every frame with the pen position (board coords) while drawing. */
  onPen(p: Point): void;
}

const ease = (t: number) => {
  // Mostly linear with soft start/stop — reads like a steady hand.
  const s = t * t * (3 - 2 * t);
  return 0.35 * s + 0.65 * t;
};

let clipCounter = 0;

/**
 * Draws board elements stroke by stroke into a live SVG layer, moving an
 * animated marker pen along each stroke. Uses the pausable lesson clock.
 */
export class Animator {
  /** User speed multiplier (applied on top of per-call pacing). */
  userSpeed = 1;
  private pen: SVGGElement;
  private penBody: SVGGElement;
  private penPos: Point = { x: 800, y: 300 };
  private penVisible = false;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private live = new Map<string, SVGGElement[]>();
  private tilt = 0;

  constructor(
    private readonly liveUnder: SVGGElement,
    private readonly liveLayer: SVGGElement,
    penLayer: SVGGElement,
    private readonly clock: LessonClock,
    private readonly hooks: AnimatorHooks,
  ) {
    this.pen = document.createElementNS(SVG_NS, "g");
    this.pen.setAttribute("class", "doodo-pen");
    this.penBody = document.createElementNS(SVG_NS, "g");
    // A marker pen, tip at (0,0), body pointing up-right.
    this.penBody.innerHTML = `
      <g transform="rotate(-38)">
        <path d="M-5 -8 L0 0 L5 -8 Z" fill="#374151"/>
        <rect x="-7" y="-58" width="14" height="50" rx="4" fill="#fbbf24" stroke="#92400e" stroke-width="1.5"/>
        <rect x="-7" y="-24" width="14" height="8" fill="#f59e0b"/>
        <rect data-cap x="-6.5" y="-66" width="13" height="10" rx="3" fill="#1f2328"/>
      </g>`;
    this.pen.appendChild(this.penBody);
    this.pen.style.opacity = "0";
    this.pen.style.transition = "opacity 220ms ease";
    penLayer.appendChild(this.pen);
  }

  destroy(): void {
    this.pen.remove();
    this.releaseAll();
  }

  // -------------------------------------------------------------------------
  // Pen

  private showPen(color?: string): void {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = null;
    if (!this.penVisible) {
      this.penVisible = true;
      this.pen.style.opacity = "1";
    }
    if (color) this.penBody.querySelector("[data-cap]")?.setAttribute("fill", color);
  }

  /** Hide the pen after a moment of inactivity. */
  idle(): void {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      this.penVisible = false;
      this.pen.style.opacity = "0";
    }, 900);
  }

  private movePen(p: Point, lifted: boolean, t: number): void {
    const dx = p.x - this.penPos.x;
    const dy = p.y - this.penPos.y;
    // Tilt follows horizontal motion a little; slight bob keeps it alive.
    const targetTilt = Math.max(-10, Math.min(10, dx * 0.9));
    this.tilt += (targetTilt - this.tilt) * 0.2;
    const bob = lifted ? -6 : Math.sin(t / 90) * 0.8;
    const scale = lifted ? 1.06 : 1;
    this.penPos = p;
    this.pen.setAttribute(
      "transform",
      `translate(${p.x.toFixed(1)} ${(p.y + bob).toFixed(1)}) rotate(${this.tilt.toFixed(1)}) scale(${scale})`,
    );
    if (Math.abs(dx) + Math.abs(dy) > 0.01) this.hooks.onPen(p);
  }

  private async travel(to: Point, speed: number): Promise<void> {
    const from = this.penPos;
    const d = dist(from, to);
    if (d < 3) {
      this.movePen(to, false, this.clock.now());
      return;
    }
    const dur = Math.min(240, Math.max(35, d / 3.4)) / speed;
    const t0 = this.clock.now();
    for (;;) {
      const now = await this.clock.frame();
      const k = Math.min(1, (now - t0) / dur);
      const e = k * k * (3 - 2 * k);
      // Arc slightly while travelling (pen lifted).
      const lift = Math.sin(Math.PI * k) * Math.min(18, d * 0.08);
      this.movePen({ x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e - lift }, true, now);
      if (k >= 1) break;
    }
  }

  // -------------------------------------------------------------------------
  // Drawing

  /** Draw an element progressively. Resolves when every stroke is on the board. */
  async draw(elm: BoardElement, pace: number): Promise<void> {
    const under = document.createElementNS(SVG_NS, "g");
    const over = document.createElementNS(SVG_NS, "g");
    this.liveUnder.appendChild(under);
    this.liveLayer.appendChild(over);
    this.live.set(elm.id, [under, over]);
    try {
      for (const s of elm.strokes) {
        const speed = Math.max(0.2, pace * this.userSpeed);
        await this.drawStroke(s, isUnderStroke(s) ? under : over, speed);
      }
    } finally {
      this.idle();
    }
  }

  /** Instantly complete an element that was mid-animation (interrupt). */
  finishInstantly(elm: BoardElement): void {
    const gs = this.live.get(elm.id);
    if (!gs) return;
    const [under, over] = gs;
    under.replaceChildren();
    over.replaceChildren();
    for (const s of elm.strokes) (isUnderStroke(s) ? under : over).appendChild(strokeNode(s));
  }

  /** Remove the live copy once the static element has rendered. */
  release(id: string): void {
    const gs = this.live.get(id);
    if (gs) {
      for (const g of gs) g.remove();
      this.live.delete(id);
    }
  }

  releaseAll(): void {
    for (const gs of this.live.values()) for (const g of gs) g.remove();
    this.live.clear();
  }

  private startPoint(s: Stroke): Point | null {
    switch (s.t) {
      case "ink": return s.pts.length ? { x: s.pts[0][0], y: s.pts[0][1] } : null;
      case "fill": case "svg": return { x: s.box.x, y: s.box.y + s.box.h / 2 };
      case "text": return { x: s.x, y: s.y };
      case "image": return null;
      case "path": return null; // resolved from the DOM node
    }
  }

  private async drawStroke(s: Stroke, layer: SVGGElement, speed: number): Promise<void> {
    const dur = strokeDurationMs(s, speed);
    switch (s.t) {
      case "path": return this.drawPath(s, layer, dur, speed);
      case "ink": return this.drawInk(s, layer, dur, speed);
      case "fill":
      case "svg": return this.wipe(s, layer, dur, speed);
      case "text":
      case "image": return this.fadeIn(s, layer, dur);
    }
  }

  private async drawPath(s: Extract<Stroke, { t: "path" }>, layer: SVGGElement, dur: number, speed: number): Promise<void> {
    const node = strokeNode(s) as SVGPathElement;
    let len = 0;
    try {
      layer.appendChild(node);
      len = node.getTotalLength();
    } catch {
      len = s.len;
    }
    if (!Number.isFinite(len) || len <= 0.5) return;
    const dash = node.getAttribute("stroke-dasharray");
    node.setAttribute("stroke-dasharray", `${len} ${len + 2}`);
    node.setAttribute("stroke-dashoffset", String(len + 1));
    this.showPen(s.color);
    await this.travel(node.getPointAtLength(0), speed);
    const t0 = this.clock.now();
    for (;;) {
      const now = await this.clock.frame();
      const k = Math.min(1, (now - t0) / dur);
      const e = ease(k);
      node.setAttribute("stroke-dashoffset", String(len * (1 - e) + (k < 1 ? 1 : 0)));
      const p = node.getPointAtLength(len * e);
      this.movePen(p, false, now);
      if (k >= 1) break;
    }
    if (dash) node.setAttribute("stroke-dasharray", dash);
    else node.removeAttribute("stroke-dasharray");
    node.removeAttribute("stroke-dashoffset");
  }

  private async drawInk(s: Extract<Stroke, { t: "ink" }>, layer: SVGGElement, dur: number, speed: number): Promise<void> {
    const node = document.createElementNS(SVG_NS, "path");
    node.setAttribute("fill", s.color);
    if (s.opacity !== undefined) node.setAttribute("opacity", String(s.opacity));
    if (s.blend) node.style.mixBlendMode = "multiply";
    layer.appendChild(node);
    const pts = s.pts;
    if (pts.length === 0) return;
    this.showPen(s.color);
    await this.travel({ x: pts[0][0], y: pts[0][1] }, speed);
    const t0 = this.clock.now();
    let shown = 0;
    for (;;) {
      const now = await this.clock.frame();
      const k = Math.min(1, (now - t0) / dur);
      const n = Math.max(1, Math.ceil(pts.length * ease(k)));
      if (n !== shown) {
        shown = n;
        node.setAttribute("d", inkPath(pts.slice(0, n), s.size, s.taper, k >= 1));
        const p = pts[n - 1];
        this.movePen({ x: p[0], y: p[1] }, false, now);
      }
      if (k >= 1) break;
    }
    node.setAttribute("d", inkPath(pts, s.size, s.taper, true));
  }

  private async wipe(s: Extract<Stroke, { t: "fill" | "svg" }>, layer: SVGGElement, dur: number, speed: number): Promise<void> {
    const node = strokeNode(s);
    const b: Box = s.box;
    const id = `doodo-wipe-${++clipCounter}`;
    const clip = document.createElementNS(SVG_NS, "clipPath");
    clip.setAttribute("id", id);
    clip.setAttribute("clipPathUnits", "userSpaceOnUse");
    const rect = document.createElementNS(SVG_NS, "rect");
    rect.setAttribute("x", String(b.x - 4));
    rect.setAttribute("y", String(b.y - 4));
    rect.setAttribute("height", String(b.h + 8));
    rect.setAttribute("width", "0");
    clip.appendChild(rect);
    layer.appendChild(clip);
    node.setAttribute("clip-path", `url(#${id})`);
    layer.appendChild(node);
    const isSvg = s.t === "svg";
    if (isSvg) {
      this.showPen(s.color);
      await this.travel({ x: b.x, y: b.y + b.h * 0.6 }, speed);
    }
    const t0 = this.clock.now();
    for (;;) {
      const now = await this.clock.frame();
      const k = Math.min(1, (now - t0) / dur);
      const w = (b.w + 8) * ease(k);
      rect.setAttribute("width", String(w));
      if (isSvg) {
        // Zig-zag like writing along the line.
        const zig = Math.sin(k * Math.PI * 14) * b.h * 0.25;
        this.movePen({ x: b.x + w, y: b.y + b.h * 0.55 + zig }, false, now);
      }
      if (k >= 1) break;
    }
    node.removeAttribute("clip-path");
    clip.remove();
  }

  private async fadeIn(s: Stroke, layer: SVGGElement, dur: number): Promise<void> {
    const node = strokeNode(s);
    node.style.opacity = "0";
    layer.appendChild(node);
    const start = this.startPoint(s);
    if (start && s.t === "text") {
      this.showPen(s.color);
      this.movePen(start, false, this.clock.now());
    }
    const t0 = this.clock.now();
    for (;;) {
      const now = await this.clock.frame();
      const k = Math.min(1, (now - t0) / dur);
      node.style.opacity = String(k);
      if (k >= 1) break;
    }
    node.style.opacity = "";
  }

  // -------------------------------------------------------------------------
  // Teaching gestures

  /** Tap the pen on a point with a ripple. */
  async point(p: Point, ms: number): Promise<void> {
    this.showPen();
    await this.travel(p, 1.2);
    const ring = document.createElementNS(SVG_NS, "circle");
    ring.setAttribute("cx", String(p.x));
    ring.setAttribute("cy", String(p.y));
    ring.setAttribute("fill", "none");
    ring.setAttribute("stroke", "#f59e0b");
    ring.setAttribute("stroke-width", "3");
    this.liveLayer.appendChild(ring);
    const t0 = this.clock.now();
    try {
      for (;;) {
        const now = await this.clock.frame();
        const k = Math.min(1, (now - t0) / ms);
        const tap = Math.abs(Math.sin(k * Math.PI * 3));
        this.movePen({ x: p.x, y: p.y - tap * 10 }, true, now);
        const rk = (k * 3) % 1;
        ring.setAttribute("r", String(6 + rk * 26));
        ring.setAttribute("opacity", String(1 - rk));
        if (k >= 1) break;
      }
    } finally {
      ring.remove();
      this.idle();
    }
  }

  /** Wipe elements off the board (they fade while the pen scrubs over them). */
  async erase(nodes: SVGGElement[], boxes: Box[]): Promise<void> {
    if (nodes.length === 0) return;
    let all: Box | null = null;
    for (const b of boxes) all = all ? union(all, b) : { ...b };
    this.showPen("#9ca3af");
    const dur = 650;
    if (all) await this.travel({ x: all.x, y: all.y }, 1.5);
    const t0 = this.clock.now();
    try {
      for (;;) {
        const now = await this.clock.frame();
        const k = Math.min(1, (now - t0) / dur);
        for (const n of nodes) n.style.opacity = String(1 - k);
        if (all) {
          const zx = all.x + all.w * ((Math.sin(k * Math.PI * 6) + 1) / 2);
          this.movePen({ x: zx, y: all.y + all.h * k }, false, now);
        }
        if (k >= 1) break;
      }
    } finally {
      this.idle();
    }
  }
}

function union(a: Box, b: Box): Box {
  const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y);
  return { x: x0, y: y0, w: Math.max(a.x + a.w, b.x + b.w) - x0, h: Math.max(a.y + a.h, b.y + b.h) - y0 };
}
