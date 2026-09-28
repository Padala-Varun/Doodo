import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { compileOp, type CompileEnv } from "@/lib/board/compile";
import type { BoardElement } from "@/lib/board/types";
import { parseDml } from "@/lib/dml/parser";
import { boxCenter, intersectArea } from "@/lib/geom";
import { StrokeFont } from "@/lib/hand/font";
import { compileExpr } from "@/lib/math/expr";
import type { Anchor } from "@/lib/protocol";
import { renderTex } from "@/lib/server/tex";

const font = StrokeFont.fromVara(JSON.parse(fs.readFileSync(path.join(__dirname, "../public/fonts/shadows-into-light.json"), "utf8")));

function makeEnv(anchors: Anchor[] = [], elements: BoardElement[] = []): CompileEnv {
  let seq = 0;
  return {
    font,
    elements: new Map(elements.map((e) => [e.id, e])),
    anchors: new Map(anchors.map((a) => [a.id, a])),
    lessonTop: 0,
    flow: null,
    nextSeq: () => ++seq,
  };
}

function run(dml: string, env: CompileEnv) {
  const { ops, issues } = parseDml(dml);
  expect(issues).toEqual([]);
  const results = [];
  for (const op of ops) {
    if (op.op === "voice" || op.op === "find") continue;
    const r = compileOp(op, env);
    if (r.type === "element") env.elements.set(r.el.id, r.el);
    results.push(r);
  }
  return results;
}

describe("compiler", () => {
  it("compiles a whiteboard lesson without skips", () => {
    const env = makeEnv();
    const res = run(
      `<title id="h">Pythagoras' Theorem</title>
       <tri id="t" a="250,700" b="650,700" c="250,400" right="a"/>
       <label target="t.ca" side="left" color="blue">a</label>
       <label target="t.ab" color="blue">b</label>
       <label target="t.bc" color="red">c</label>
       <callout target="t.bc" color="red">hypotenuse</callout>
       <write id="f" x="900" y="380" size="xl" color="green">a² + b² = c²</write>
       <rect target="f" color="green"/>
       <write id="ex1" below="f" gap="50">3² + 4² = 25</write>
       <write id="ex2">so c = 5</write>
       <underline target="ex2"/>
       <box id="b1" x="100" y="800">Input</box><box id="b2" right-of="b1" gap="200">Output</box>
       <arrow from="b1" to="b2">process</arrow>
       <sketch id="k" x="1100" y="600" w="200" h="200"><s d="10,10 50,90 90,10" closed="true" fill="hachure"/></sketch>
       <plot id="g" x="900" y="900" w="400" h="260" fn="sin(x); x^2/4" xr="-6,6" yr="-2,2" grid="true"/>
       <table id="tb" x="100" y="1000">x|y;1|2;3|4</table>
       <brace target="ex1" side="right">example</brace>
       <point target="t.a"/>`,
      env,
    );
    const skips = res.filter((r) => r.type === "skip");
    expect(skips).toEqual([]);
    const title = env.elements.get("h")!;
    expect(Math.abs(boxCenter(title.box).x - 800)).toBeLessThan(2); // centred at top
    // Flowing write goes below ex1, left-aligned with it.
    const ex1 = env.elements.get("ex1")!, ex2 = env.elements.get("ex2")!;
    expect(ex2.box.y).toBeGreaterThan(ex1.box.y + ex1.box.h - 1);
    expect(Math.abs(ex2.box.x - ex1.box.x)).toBeLessThan(1);
    // Arrow attaches to the box borders.
    const arrow = env.elements.get([...env.elements.keys()].find((k) => env.elements.get(k)!.kind === "line")!)!;
    const b1 = env.elements.get("b1")!;
    expect(arrow.points!.start.x).toBeGreaterThanOrEqual(b1.box.x + b1.box.w);
  });

  it("places edge labels outside the triangle", () => {
    const env = makeEnv();
    run(`<tri id="t" a="250,700" b="650,700" c="250,400"/><label id="la" target="t.ab">b</label><label id="lc" target="t.ca">a</label>`, env);
    const lb = env.elements.get("la")!, lc = env.elements.get("lc")!;
    expect(lb.box.y).toBeGreaterThan(700); // below the bottom edge
    expect(lc.box.x + lc.box.w).toBeLessThan(250); // left of the vertical edge
  });

  it("puts callout labels next to (not on) grounded objects", () => {
    const image: BoardElement = {
      id: "img1", author: "user", kind: "image", seq: 0,
      box: { x: 60, y: 60, w: 1000, h: 750 }, strokes: [{ t: "image", href: "data:,", box: { x: 60, y: 60, w: 1000, h: 750 } }],
    };
    const mango: Anchor = { id: "mango", label: "mango", kind: "object", box: { x: 300, y: 400, w: 160, h: 120 } };
    const apple: Anchor = { id: "apple", label: "apple", kind: "object", box: { x: 480, y: 400, w: 140, h: 130 } };
    const env = makeEnv([mango, apple], [image]);
    const [r] = run(`<callout id="co" target="@mango">This is a mango</callout>`, env);
    expect(r.type).toBe("element");
    const el = env.elements.get("co")!;
    const label = el.points!.label;
    const tip = el.points!.tip;
    // Label must not cover either fruit; arrow tip ends at the mango's boundary.
    const lbox = { x: label.x - 5, y: label.y - 5, w: 10, h: 10 };
    expect(intersectArea(lbox, mango.box)).toBe(0);
    expect(intersectArea(lbox, apple.box)).toBe(0);
    const dx = (tip.x - 380) / 80, dy = (tip.y - 460) / 60;
    expect(Math.abs(Math.hypot(dx, dy) - 1)).toBeLessThan(0.15);
  });

  it("nudges explicitly placed text off other text, but not out of plain shapes", () => {
    const env = makeEnv();
    run(`<write id="w1" x="200" y="200">Right Side (Blue: deoxygenated)</write><write id="w2" x="300" y="200">Left Side</write>
         <rect id="r" x="600" y="400" w="300" h="200"/><write id="w3" x="650" y="450">inside</write>`, env);
    const w1 = env.elements.get("w1")!, w2 = env.elements.get("w2")!, w3 = env.elements.get("w3")!;
    expect(intersectArea(w1.box, w2.box)).toBe(0);
    expect(w3.box.x).toBe(650);
    expect(w3.box.y).toBe(450);
  });

  it("routes arrows around boxes in the way", () => {
    const env = makeEnv();
    run(`<box id="a" x="100" y="400" w="120" h="60">A</box><box id="mid" x="500" y="400" w="120" h="60">Mid</box>
         <box id="b" x="900" y="400" w="120" h="60">B</box><arrow id="ab" from="a" to="b"/>`, env);
    const arrow = env.elements.get("ab")!;
    const mid = env.elements.get("mid")!.box;
    const ink = arrow.strokes.find((s) => s.t === "ink");
    expect(ink && ink.t === "ink").toBe(true);
    const inside = ink && ink.t === "ink" ? ink.pts.filter(([x, y]) => x > mid.x && x < mid.x + mid.w && y > mid.y && y < mid.y + mid.h).length : -1;
    expect(inside).toBe(0);
  });

  it("skips gracefully on unknown targets", () => {
    const env = makeEnv();
    const [r] = run(`<callout target="@ghost">boo</callout>`, env);
    expect(r.type).toBe("skip");
  });
});

describe("expressions", () => {
  it("compiles common forms", () => {
    expect(compileExpr("x^2")!(3)).toBe(9);
    expect(compileExpr("2x + 1")!(2)).toBe(5);
    expect(compileExpr("y = sin(x)")!(0)).toBe(0);
    expect(compileExpr("-x^2")!(2)).toBe(-4);
    expect(compileExpr("2^3^2")!(0)).toBe(512);
    expect(compileExpr("|x| + pi")!(-1)).toBeCloseTo(1 + Math.PI);
    expect(compileExpr("xsin(x)")!(Math.PI / 2)).toBeCloseTo(Math.PI / 2);
    expect(compileExpr("constructor")).toBeNull();
    expect(compileExpr("x +")).toBeNull();
  });
});

describe("tex", () => {
  it("renders TeX to pure-path SVG and rejects errors", async () => {
    const svg = await renderTex("\\frac{a}{b} = \\sqrt{c^2}", 36);
    expect(svg).not.toBeNull();
    expect(svg!.markup.startsWith("<svg")).toBe(true);
    expect(svg!.width).toBeGreaterThan(20);
    expect(svg!.markup.includes("<path")).toBe(true);
    expect(await renderTex("\\frac{a}{", 36)).toBeNull();
  }, 30_000);
});
