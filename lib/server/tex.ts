import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { MathSvg } from "../dml/ops";

/**
 * TeX → self-contained SVG (pure <path>s, fill=currentColor) using MathJax 4
 * on the server, so the browser needs no math fonts and the snapshot
 * rasteriser sees only plain vector paths.
 */

type Converter = (tex: string) => Promise<{ markup: string; viewBox: [number, number, number, number] } | null>;

let converterPromise: Promise<Converter> | null = null;

async function createConverter(): Promise<Converter> {
  const { mathjax } = await import("@mathjax/src/js/mathjax.js");
  const { TeX } = await import("@mathjax/src/js/input/tex.js");
  const { SVG } = await import("@mathjax/src/js/output/svg.js");
  const { liteAdaptor } = await import("@mathjax/src/js/adaptors/liteAdaptor.js");
  const { RegisterHTMLHandler } = await import("@mathjax/src/js/handlers/html.js");
  await import("@mathjax/src/js/input/tex/base/BaseConfiguration.js");
  await import("@mathjax/src/js/input/tex/ams/AmsConfiguration.js");
  const { MathJaxNewcmFont } = await import("@mathjax/mathjax-newcm-font/js/svg.js");

  // MathJax lazily loads extra font data; resolve module names to file URLs (Windows-safe).
  const require = createRequire(import.meta.url);
  (mathjax as unknown as { asyncLoad: (name: string) => Promise<unknown> }).asyncLoad = async (name: string) => {
    const resolved = name.startsWith(".") || name.startsWith("/") ? name : require.resolve(name);
    return import(/* webpackIgnore: true */ pathToFileURL(resolved).href);
  };

  const adaptor = liteAdaptor();
  RegisterHTMLHandler(adaptor);
  const doc = mathjax.document("", {
    InputJax: new TeX({ packages: ["base", "ams"] }),
    OutputJax: new SVG({ fontCache: "none", fontData: MathJaxNewcmFont }),
  });

  return async (tex: string) => {
    const container = await doc.convertPromise(tex, { display: true });
    // container = <mjx-container><svg ...>...</svg></mjx-container>
    type LiteEl = Parameters<typeof adaptor.getAttribute>[0];
    const svg = adaptor.firstChild(container) as LiteEl | null;
    if (!svg || adaptor.kind(svg) !== "svg") return null;
    // Reject TeX errors (MathJax renders them as merror nodes).
    const markupAll = adaptor.outerHTML(svg);
    if (markupAll.includes('data-mml-node="merror"')) return null;
    const vb = adaptor.getAttribute(svg, "viewBox");
    const parts = String(vb).split(" ").map((n: string) => Number(n));
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
    adaptor.removeAttribute(svg, "style");
    adaptor.removeAttribute(svg, "role");
    adaptor.removeAttribute(svg, "focusable");
    return { markup: adaptor.outerHTML(svg), viewBox: parts as [number, number, number, number] };
  };
}

/** Render TeX at a given font size (board px). Returns null on invalid TeX. */
export async function renderTex(tex: string, sizePx: number): Promise<MathSvg | null> {
  converterPromise ??= createConverter();
  let conv: Converter;
  try {
    conv = await converterPromise;
  } catch {
    converterPromise = null;
    return null;
  }
  try {
    const r = await conv(tex);
    if (!r) return null;
    const [, minY, w, h] = r.viewBox;
    const scale = (sizePx * 0.92) / 1000; // viewBox units are 1/1000 em
    const width = w * scale;
    const height = h * scale;
    // Set explicit pixel size so the client can place it without measuring.
    return {
      markup: setSvgSize(r.markup, width, height),
      width,
      height,
      baseline: -minY * scale,
    };
  } catch {
    return null;
  }
}

/** Replace the root <svg>'s width/height attributes by scanning the opening tag. */
function setSvgSize(markup: string, width: number, height: number): string {
  const end = markup.indexOf(">");
  if (end === -1) return markup;
  const open = markup.slice(0, end);
  const rest = markup.slice(end);
  const attrs = dropAttr(dropAttr(open, "width"), "height");
  return `${attrs} width="${width.toFixed(2)}" height="${height.toFixed(2)}"${rest}`;
}

function dropAttr(tag: string, name: string): string {
  const key = ` ${name}="`;
  const i = tag.indexOf(key);
  if (i === -1) return tag;
  const j = tag.indexOf('"', i + key.length);
  if (j === -1) return tag;
  return tag.slice(0, i) + tag.slice(j + 1);
}
