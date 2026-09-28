import { z } from "zod";
import type { Op } from "./dml/ops";

/** Axis-aligned box in board coordinates. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Anchor {
  /** Referenced in DML as `@id`. */
  id: string;
  label: string;
  kind: "object" | "text" | "region" | "user";
  box: Box;
  /** Optional tight outline polygon (board coords) for precise circling. */
  outline?: { x: number; y: number }[];
}

// ---------------------------------------------------------------------------
// Browser → server
// ---------------------------------------------------------------------------

const boxSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  w: z.number().finite().nonnegative(),
  h: z.number().finite().nonnegative(),
});

export const sceneItemSchema = z.object({
  id: z.string().min(1).max(64),
  author: z.enum(["user", "doodo"]),
  type: z.string().max(32),
  box: boxSchema,
  text: z.string().max(500).optional(),
});
export type SceneItem = z.infer<typeof sceneItemSchema>;

export const anchorSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().max(200),
  kind: z.enum(["object", "text", "region", "user"]),
  box: boxSchema,
});

const DATA_URL_MAX = 12 * 1024 * 1024;

export const lessonRequestSchema = z.object({
  question: z.string().trim().min(1).max(4000),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(40_000) }))
    .max(24)
    .default([]),
  snapshot: z
    .object({
      /** data:image/jpeg;base64,... or data:image/png;base64,... */
      dataUrl: z.string().max(DATA_URL_MAX).refine((s) => s.startsWith("data:image/jpeg;base64,") || s.startsWith("data:image/png;base64,") || s.startsWith("data:image/webp;base64,"), "unsupported image"),
      /** Pixel size of the snapshot image. */
      width: z.number().int().positive().max(8192),
      height: z.number().int().positive().max(8192),
      /** The board rectangle the snapshot covers (snapshot px = board px * width / region.w). */
      region: boxSchema,
      /** True when the board has an uploaded image, i.e. grounding is useful. */
      hasImage: z.boolean(),
    })
    .optional(),
  scene: z.object({
    width: z.number().positive(),
    height: z.number().positive(),
    items: z.array(sceneItemSchema).max(400),
    /** Next free y below existing content — where new content can go. */
    freeY: z.number().finite(),
  }),
  anchors: z.array(anchorSchema).max(200).default([]),
  settings: z
    .object({
      voice: z.boolean().default(true),
      speaker: z.string().max(32).optional(),
      pace: z.number().min(0.5).max(2).optional(),
      language: z.string().max(12).default("en-IN"),
      deep: z.boolean().default(false),
    })
    .default({ voice: true, language: "en-IN", deep: false }),
});
export type LessonRequest = z.infer<typeof lessonRequestSchema>;

// ---------------------------------------------------------------------------
// Server → browser (SSE `data:` JSON)
// ---------------------------------------------------------------------------

export type LessonEvent =
  | { t: "start"; lessonId: string; model: string }
  | { t: "status"; stage: "grounding" | "thinking" | "drawing"; message?: string }
  | { t: "op"; op: Op }
  | { t: "anchor"; anchor: Anchor }
  | { t: "anchor_fail"; id: string; reason: string }
  | { t: "audio"; voiceId: string; seq: number; pcm: string; sampleRate: number }
  | { t: "audio_wav"; voiceId: string; wav: string }
  | { t: "audio_end"; voiceId: string; ok: boolean }
  | { t: "issue"; element: string; issue: string }
  | { t: "done"; dml: string; usage?: { prompt: number; completion: number; cost?: number } }
  | { t: "error"; message: string; dml?: string };
