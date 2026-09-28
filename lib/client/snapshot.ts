import type { BoardElement } from "../board/types";
import type { Box } from "../geom";
import { SVG_NS } from "./svgRender";

const imageCache = new Map<string, Promise<HTMLImageElement>>();

function loadImage(src: string): Promise<HTMLImageElement> {
  let p = imageCache.get(src);
  if (!p) {
    p = new Promise((resolve, reject) => {
      const img = new Image();
      img.decoding = "async";
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("image failed to load"));
      img.src = src;
    });
    if (imageCache.size > 40) imageCache.clear();
    imageCache.set(src, p);
  }
  return p;
}

export interface Snapshot {
  dataUrl: string;
  width: number;
  height: number;
  region: Box;
}

/**
 * Rasterise a region of the board exactly as the user sees it.
 *
 * Raster images are drawn straight onto the canvas (never through an SVG
 * image, so the canvas is never tainted); the vector content layer is then
 * serialised to a standalone SVG and composited on top.
 */
export async function captureSnapshot(
  contentLayers: SVGGElement[],
  elements: BoardElement[],
  region: Box,
  maxPx: number,
): Promise<Snapshot> {
  const scale = Math.min(maxPx / region.w, maxPx / region.h, 2);
  const W = Math.max(1, Math.round(region.w * scale));
  const H = Math.max(1, Math.round(region.h * scale));
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas unavailable");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);

  // 1) Raster images, in z-order.
  for (const el of elements) {
    for (const s of el.strokes) {
      if (s.t !== "image") continue;
      try {
        const img = await loadImage(s.href);
        ctx.drawImage(img, (s.box.x - region.x) * scale, (s.box.y - region.y) * scale, s.box.w * scale, s.box.h * scale);
      } catch {
        /* skip broken image */
      }
    }
  }

  // 2) Vector ink on top.
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("xmlns", SVG_NS);
  svg.setAttribute("width", String(W));
  svg.setAttribute("height", String(H));
  svg.setAttribute("viewBox", `${region.x} ${region.y} ${region.w} ${region.h}`);
  for (const layer of contentLayers) {
    const clone = layer.cloneNode(true) as SVGGElement;
    for (const img of Array.from(clone.querySelectorAll("image"))) img.remove();
    svg.appendChild(clone);
  }
  const markup = new XMLSerializer().serializeToString(svg);
  const url = URL.createObjectURL(new Blob([markup], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const overlay = await loadImageUncached(url);
    ctx.drawImage(overlay, 0, 0, W, H);
  } finally {
    URL.revokeObjectURL(url);
  }
  let dataUrl: string;
  try {
    dataUrl = canvas.toDataURL("image/jpeg", 0.9);
  } catch {
    throw new Error("could not export the board snapshot");
  }
  return { dataUrl, width: W, height: H, region };
}

function loadImageUncached(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("overlay failed to render"));
    img.src = src;
  });
}

/** Downscale an uploaded image so requests stay small; returns a JPEG/PNG data URL and size. */
export async function prepareUpload(file: Blob, maxSide = 2200): Promise<{ href: string; w: number; h: number }> {
  const src = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error("could not read file"));
    r.readAsDataURL(file);
  });
  const img = await loadImageUncached(src);
  const s = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * s));
  const h = Math.max(1, Math.round(img.naturalHeight * s));
  if (s === 1 && (file.type === "image/jpeg" || file.type === "image/png") && file.size < 3_000_000) return { href: src, w, h };
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (!ctx) return { href: src, w, h };
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return { href: c.toDataURL("image/jpeg", 0.9), w, h };
}
