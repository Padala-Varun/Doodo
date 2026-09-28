import type { FindTarget } from "../ground";

export const GROUNDING_SYSTEM = `You are a precise visual grounding engine. You locate described targets in an image and return tight bounding boxes.

Output JSON only: {"results":[{"id":string,"found":boolean,"label":string,"box_2d":[ymin,xmin,ymax,xmax]}]}
- box_2d uses coordinates normalized to 0-1000 relative to the full image (0,0 = top-left). Order is [ymin, xmin, ymax, xmax].
- The box must tightly enclose the visible extent of the target — not the surrounding area, not a larger group.
- For text targets, box the exact line/word(s) of text described (tight around the glyphs).
- If several objects match, pick the one that best matches the description (position hints like "left", "top" matter).
- If the target is not visible, return found=false and box_2d=[0,0,0,0].
- label: 1-4 words naming what you boxed.
- Return one result per requested id, in the same order.`;

export function groundingUserPrompt(targets: FindTarget[], question: string): string {
  const lines = targets.map((t) => `- id="${t.id}" kind=${t.kind}: ${t.desc}`);
  return `Context (the user's question about this image): ${question.slice(0, 500)}

Locate these targets:
${lines.join("\n")}`;
}

export const REFINE_SYSTEM = `You are a precise visual grounding engine. The image is a zoomed-in crop. Locate the single described target and return its tight bounding box.

Output JSON only: {"results":[{"id":string,"found":boolean,"label":string,"box_2d":[ymin,xmin,ymax,xmax]}]}
- box_2d normalized to 0-1000 relative to THIS crop, order [ymin, xmin, ymax, xmax].
- The box must tightly enclose the target's visible pixels. For text, tightly box the glyphs.
- If the target is not visible, return found=false.`;

export function refineUserPrompt(t: FindTarget): string {
  return `Target id="${t.id}" kind=${t.kind}: ${t.desc}`;
}
