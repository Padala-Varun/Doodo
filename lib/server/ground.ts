import type { Anchor, Box } from "../protocol";
import { config } from "./config";
import { complete, extractJson, type ChatMessage } from "./openrouter";
import { GROUNDING_SYSTEM, groundingUserPrompt, REFINE_SYSTEM, refineUserPrompt } from "./prompts/vision";

/**
 * Visual grounding: turn the teacher's `<find id desc>` requests into precise
 * board-space boxes.
 *
 *  1. Coarse pass — one vision call for a batch of targets on the full
 *     snapshot, Gemini-style `box_2d: [ymin, xmin, ymax, xmax]` in 0..1000.
 *  2. Zoom pass — small targets (< ~5% of the image area) are re-detected in
 *     an up-scaled crop around the coarse box, which removes most of the
 *     few-percent drift VLM boxes have on small objects.
 */

export interface FindTarget {
  id: string;
  desc: string;
  kind: "object" | "text" | "region";
}

export interface Snapshot {
  bytes: Buffer;
  mime: string;
  width: number;
  height: number;
  /** Board rectangle the snapshot covers. */
  region: Box;
}

export type GroundResult = { id: string; anchor: Anchor } | { id: string; error: string };

type Norm = [number, number, number, number]; // ymin, xmin, ymax, xmax in 0..1000

const RESULT_SCHEMA = {
  type: "object",
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          found: { type: "boolean" },
          label: { type: "string" },
          box_2d: { type: "array", items: { type: "number" } },
        },
        required: ["id", "found", "box_2d"],
        additionalProperties: false,
      },
    },
  },
  required: ["results"],
  additionalProperties: false,
} as const;

export function decodeDataUrl(dataUrl: string): { bytes: Buffer; mime: string } {
  const comma = dataUrl.indexOf(",");
  const header = dataUrl.slice(5, comma); // after "data:"
  const semi = header.indexOf(";");
  return { mime: semi === -1 ? header : header.slice(0, semi), bytes: Buffer.from(dataUrl.slice(comma + 1), "base64") };
}

function toDataUrl(bytes: Buffer, mime: string): string {
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

function validNorm(b: unknown): Norm | null {
  if (!Array.isArray(b) || b.length !== 4) return null;
  const n = b.map((v) => (typeof v === "number" ? v : Number(v)));
  if (n.some((v) => !Number.isFinite(v))) return null;
  let [ymin, xmin, ymax, xmax] = n.map((v) => Math.min(1000, Math.max(0, v)));
  if (ymin > ymax) [ymin, ymax] = [ymax, ymin];
  if (xmin > xmax) [xmin, xmax] = [xmax, xmin];
  if (ymax - ymin < 1 || xmax - xmin < 1) return null;
  return [ymin, xmin, ymax, xmax];
}

async function visionCall(system: string, user: string, image: string, signal?: AbortSignal) {
  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: [{ type: "image_url", image_url: { url: image, detail: "high" } }, { type: "text", text: user }] },
  ];
  const { text } = await complete({
    model: config.visionModel,
    fallbacks: config.visionFallbacks,
    messages,
    temperature: 0,
    maxTokens: 4000,
    reasoning: { effort: "low" },
    responseFormat: { type: "json_schema", json_schema: { name: "grounding", strict: true, schema: RESULT_SCHEMA } },
    signal,
  });
  const parsed = extractJson(text) as { results?: { id?: unknown; found?: unknown; label?: unknown; box_2d?: unknown }[] };
  return Array.isArray(parsed.results) ? parsed.results : [];
}

/** Map a normalised box in a sub-rectangle of the snapshot (in snapshot px) to board coordinates. */
function normToBoard(n: Norm, snap: Snapshot, sub: { x: number; y: number; w: number; h: number }): Box {
  const [ymin, xmin, ymax, xmax] = n;
  const px0 = sub.x + (xmin / 1000) * sub.w;
  const py0 = sub.y + (ymin / 1000) * sub.h;
  const px1 = sub.x + (xmax / 1000) * sub.w;
  const py1 = sub.y + (ymax / 1000) * sub.h;
  const sx = snap.region.w / snap.width;
  const sy = snap.region.h / snap.height;
  return {
    x: snap.region.x + px0 * sx,
    y: snap.region.y + py0 * sy,
    w: (px1 - px0) * sx,
    h: (py1 - py0) * sy,
  };
}

async function refine(target: FindTarget, coarse: Norm, snap: Snapshot, signal?: AbortSignal): Promise<Box | null> {
  const sharp = (await import("sharp")).default;
  const [ymin, xmin, ymax, xmax] = coarse;
  const bw = ((xmax - xmin) / 1000) * snap.width;
  const bh = ((ymax - ymin) / 1000) * snap.height;
  const cx = ((xmin + xmax) / 2000) * snap.width;
  const cy = ((ymin + ymax) / 2000) * snap.height;
  // Context window: 3x the box, at least 22% of the image side, clamped to the image.
  const cw = Math.min(snap.width, Math.max(bw * 3, snap.width * 0.22, 96));
  const ch = Math.min(snap.height, Math.max(bh * 3, snap.height * 0.22, 96));
  const left = Math.round(Math.min(Math.max(0, cx - cw / 2), snap.width - cw));
  const top = Math.round(Math.min(Math.max(0, cy - ch / 2), snap.height - ch));
  const width = Math.max(1, Math.round(Math.min(cw, snap.width - left)));
  const height = Math.max(1, Math.round(Math.min(ch, snap.height - top)));
  const crop = await sharp(snap.bytes)
    .extract({ left, top, width, height })
    .resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: false })
    .jpeg({ quality: 90 })
    .toBuffer();
  const results = await visionCall(REFINE_SYSTEM, refineUserPrompt(target), toDataUrl(crop, "image/jpeg"), signal);
  const r = results.find((x) => x.found === true) ?? results[0];
  if (!r || r.found !== true) return null;
  const n = validNorm(r.box_2d);
  if (!n) return null;
  return normToBoard(n, snap, { x: left, y: top, w: width, h: height });
}

/**
 * Ground a batch of targets. Never throws: every target yields either an
 * anchor or an error entry.
 */
export async function groundTargets(
  targets: FindTarget[],
  snap: Snapshot,
  question: string,
  signal?: AbortSignal,
): Promise<GroundResult[]> {
  if (targets.length === 0) return [];
  const image = toDataUrl(snap.bytes, snap.mime);
  let results: Awaited<ReturnType<typeof visionCall>>;
  try {
    results = await visionCall(GROUNDING_SYSTEM, groundingUserPrompt(targets, question), image, signal);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "grounding failed";
    return targets.map((t) => ({ id: t.id, error: msg }));
  }
  const byId = new Map<string, (typeof results)[number]>();
  for (const r of results) if (typeof r.id === "string") byId.set(r.id.toLowerCase(), r);

  const full = { x: 0, y: 0, w: snap.width, h: snap.height };
  return Promise.all(
    targets.map(async (t): Promise<GroundResult> => {
      const r = byId.get(t.id);
      if (!r || r.found !== true) return { id: t.id, error: "not found in image" };
      const n = validNorm(r.box_2d);
      if (!n) return { id: t.id, error: "invalid box" };
      let box = normToBoard(n, snap, full);
      const areaFrac = ((n[2] - n[0]) * (n[3] - n[1])) / 1e6;
      if (areaFrac < 0.05) {
        try {
          const refined = await refine(t, n, snap, signal);
          // Accept the refinement only if it is consistent with the coarse box.
          if (refined && overlapRatio(refined, box) > 0.2) box = refined;
        } catch {
          /* keep coarse box */
        }
      }
      const label = typeof r.label === "string" && r.label.trim() ? r.label.trim().slice(0, 80) : t.desc.slice(0, 80);
      return { id: t.id, anchor: { id: t.id, label, kind: t.kind === "text" ? "text" : t.kind === "region" ? "region" : "object", box } };
    }),
  );
}

function overlapRatio(a: Box, b: Box): number {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const smaller = Math.min(a.w * a.h, b.w * b.h);
  return smaller > 0 ? inter / smaller : 0;
}
