import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { StrokeFont, CAP_HEIGHT, glyphStrokes } from "@/lib/hand/font";
import { flatten, pointsBox } from "@/lib/geom";

const json = JSON.parse(fs.readFileSync(path.join(__dirname, "../public/fonts/shadows-into-light.json"), "utf8"));
const font = StrokeFont.fromVara(json);

function inkBox(ch: string) {
  const g = font.get(ch)!;
  return pointsBox(g.strokes.flatMap((s) => flatten(s, 0.01).flat()));
}

describe("stroke font", () => {
  it("normalises metrics", () => {
    const H = inkBox("H");
    expect(Math.abs(H.y + CAP_HEIGHT)).toBeLessThan(0.03);
    expect(Math.abs(H.y + H.h)).toBeLessThan(0.05);
    const x = inkBox("x");
    console.log("x-height", -x.y, "ascent", font.ascent, "descent", font.descent, "space", font.spaceWidth, "H w", font.get("H")!.width, "i w", font.get("i")!.width);
    expect(-x.y).toBeGreaterThan(0.25);
    expect(-x.y).toBeLessThan(0.65);
  });
  it("lays out and wraps text", () => {
    const l = font.layout("Pythagoras theorem is great", 36);
    expect(l.lines).toHaveLength(1);
    console.log("width", l.width, "height", l.height);
    const w = font.layout("Pythagoras theorem is great", 36, 200);
    expect(w.lines.length).toBeGreaterThan(1);
    for (const line of w.lines) expect(line.width).toBeLessThanOrEqual(200 + 1);
  });
  it("handles symbols, superscripts and accents", () => {
    const l = font.layout("a² + b² = c² → π√x é ₹", 36);
    const missing = l.lines[0].glyphs.filter((g) => !g.glyph).map((g) => g.char);
    expect(missing).toEqual([]);
    const strokes = glyphStrokes(l.lines[0].glyphs[0], 100, 100);
    expect(strokes.length).toBeGreaterThan(0);
  });
});
