import { describe, expect, it } from "vitest";
import { DmlStreamParser, parseDml } from "@/lib/dml/parser";
import { DmlTokenizer } from "@/lib/dml/tokenizer";
import { parseColor, parsePathData, parsePointList, parseRange, parseRef } from "@/lib/dml/values";

const LESSON = `Sure! \`\`\`xml
<voice>Let's take a right triangle &amp; label it.</voice>
<title id="h1">Pythagoras' Theorem</title>
<tri id="t" a="300,650" b="700,650" c="300,350" right="a" color="blue"/>
<voice>Is a < b? For i<n we loop. The side opposite the right angle is the hypotenuse.</voice>
<label target="t.bc" color="red">c (hypotenuse)</label>
<write below="h1" gap=30 size=m>a² + b² = c²</write>
<arrow from="t.c" to="@mango1.left" curve=0.3 label="look"/>
<sketch x="900" y="300" w="300" h="300">
  <s d="10,80 30,20 50,80"/>
  <s d="M 20 60 L 40 60 C 45 60 50 65 50 70" color="red"/>
</sketch>
<math right-of="t" gap="80">\\frac{a}{b} < c</math>
<write>#include <stdio.h></write>
<!-- a comment <voice>not spoken</voice> -->
<plot fn="sin(x); cos(x)" x=900 y=500 xr="-6.28,6.28" yr="-1.5..1.5"/>
<find id="mango1">the yellow mango at the bottom left</find>
<callout target="@mango1">This is a mango</callout>
<pause ms=300/>
<voice>And that's it
`;

function feedChunks(doc: string, sizes: number[]) {
  const p = new DmlStreamParser();
  const ops = [];
  let i = 0;
  let k = 0;
  while (i < doc.length) {
    const n = Math.max(1, sizes[k++ % sizes.length]);
    ops.push(...p.feed(doc.slice(i, i + n)));
    i += n;
  }
  ops.push(...p.end());
  return ops;
}

describe("DML parser", () => {
  const whole = parseDml(LESSON);

  it("parses the reference lesson", () => {
    const kinds = whole.ops.map((o) => o.op);
    expect(kinds).toEqual([
      "voice", "write", "poly", "voice", "label", "write", "line", "sketch", "math", "write",
      "plot", "find", "callout", "pause", "voice",
    ]);
    const v0 = whole.ops[0];
    expect(v0.op === "voice" && v0.text).toBe("Let's take a right triangle & label it.");
    const v1 = whole.ops[3];
    expect(v1.op === "voice" && v1.text).toContain("Is a < b? For i<n we loop.");
    const code = whole.ops[9];
    expect(code.op === "write" && code.text).toBe("#include <stdio.h>");
    const math = whole.ops[8];
    expect(math.op === "math" && math.tex).toBe("\\frac{a}{b} < c");
    const sketch = whole.ops[7];
    expect(sketch.op === "sketch" && sketch.strokes.length).toBe(2);
    const plot = whole.ops[10];
    expect(plot.op === "plot" && plot.fns).toEqual(["sin(x)", "cos(x)"]);
    expect(plot.op === "plot" && plot.yr).toEqual([-1.5, 1.5]);
    const last = whole.ops[14];
    expect(last.op === "voice" && last.text).toBe("And that's it"); // repaired unclosed voice
  });

  it("is independent of chunk boundaries (every 2-way split)", () => {
    const ref = JSON.stringify(whole.ops);
    for (let cut = 1; cut < LESSON.length; cut++) {
      const p = new DmlStreamParser();
      const ops = [...p.feed(LESSON.slice(0, cut)), ...p.feed(LESSON.slice(cut)), ...p.end()];
      expect(JSON.stringify(ops)).toBe(ref);
    }
  });

  it("is independent of chunk boundaries (char-by-char and random sizes)", () => {
    const ref = JSON.stringify(whole.ops);
    expect(JSON.stringify(feedChunks(LESSON, [1]))).toBe(ref);
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % 9) + 1;
    for (let t = 0; t < 50; t++) {
      const sizes = Array.from({ length: 30 }, rnd);
      expect(JSON.stringify(feedChunks(LESSON, sizes))).toBe(ref);
    }
  });

  it("never throws on garbage", () => {
    let seed = 42;
    const alphabet = `<>/="' \n&;#abcvoicewrite@.,0123456789-`;
    for (let t = 0; t < 300; t++) {
      let s = "";
      for (let i = 0; i < 200; i++) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        s += alphabet[seed % alphabet.length];
      }
      expect(() => parseDml(s)).not.toThrow();
    }
  });

  it("implicitly closes a top-level element when a new one starts", () => {
    const { ops } = parseDml(`<voice>First part<write x=10 y=20>Hi</write>`);
    // voice is raw text: it swallows until </voice>; unclosed => repaired at end
    expect(ops.length).toBe(1);
    const { ops: ops2 } = parseDml(`<box x=1 y=2 w=10 h=10><arrow from="1,1" to="5,5"/>`);
    expect(ops2.map((o) => o.op)).toEqual(["shape", "line"]);
  });

  it("repairs a truncated self-closing tag at end of stream", () => {
    const { ops } = parseDml(`<pause ms="300"`);
    expect(ops).toEqual([{ op: "pause", ms: 300 }]);
  });

  it("reports invalid elements without failing", () => {
    const { ops, issues } = parseDml(`<arrow from="x"/><voice>ok</voice><tri a="1,2"/>`);
    expect(ops.map((o) => o.op)).toEqual(["voice"]);
    expect(issues.length).toBe(2);
  });
});

describe("tokenizer", () => {
  it("handles entities and unquoted values with slashes", () => {
    const t = new DmlTokenizer([]);
    const toks = [...t.write(`<a href=x/y b=1/><c d="&lt;&#65;&#x42;&bogus;"/>`), ...t.end()];
    expect(toks[0]).toEqual({ type: "open", name: "a", attrs: { href: "x/y", b: "1" }, selfClosing: true });
    expect(toks[1]).toEqual({ type: "open", name: "c", attrs: { d: "<AB&bogus;" }, selfClosing: true });
  });
});

describe("value grammars", () => {
  it("parses refs", () => {
    expect(parseRef("@Mango1.left")).toEqual({ ns: "anchor", id: "mango1", sub: "left" });
    expect(parseRef("t.bc")).toEqual({ ns: "el", id: "t", sub: "bc" });
    expect(parseRef("bad id")).toBeNull();
  });
  it("parses point lists with mixed separators", () => {
    expect(parsePointList("1,2 3 4;5,6,7")).toEqual([{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 6 }]);
    expect(parsePointList("1,a")).toBeNull();
  });
  it("parses ranges and colours", () => {
    expect(parseRange("-1..2")).toEqual([-1, 2]);
    expect(parseRange("3,1")).toEqual([1, 3]);
    expect(parseColor("#abc")).toBe("#aabbcc");
    expect(parseColor("#12345g")).toBeNull();
  });
  it("parses path data with relative, implicit and arc commands", () => {
    const segs = parsePathData("m 0,0 c 1,1 2,2 3,3 1,1 2,2 3,3 h 5 v 5 a 5 5 0 0 1 10 0 z");
    expect(segs).not.toBeNull();
    const cs = segs!.filter((s) => s.c === "C");
    expect(cs.length).toBeGreaterThanOrEqual(3);
    expect(cs[1]).toMatchObject({ x: 6, y: 6 });
    const last = segs![segs!.length - 2];
    expect(last.c === "C" && Math.round(last.x)).toBe(21);
    expect(parsePathData("M10 10")).toBeNull();
    expect(parsePathData("M0 0 L 10 10 L")).toHaveLength(2);
  });
});
