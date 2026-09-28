"use client";

import { memo, useLayoutEffect, useRef } from "react";
import type { BoardElement } from "@/lib/board/types";
import { runtime } from "@/lib/client/runtime";
import { isUnderStroke, strokeNode } from "@/lib/client/svgRender";

/**
 * Static rendering of one layer ("under" = fills/shading/images, "over" = ink)
 * of a committed element. The DOM is built with the same node factory the live
 * animator uses, so the hand-off from the live copy is pixel-identical.
 */
function ElementPartInner({ el, part }: { el: BoardElement; part: "under" | "over" }) {
  const ref = useRef<SVGGElement>(null);

  useLayoutEffect(() => {
    const g = ref.current;
    if (!g) return;
    const nodes: SVGElement[] = [];
    for (const s of el.strokes) if (isUnderStroke(s) === (part === "under")) nodes.push(strokeNode(s));
    g.replaceChildren(...nodes);
    // Both parts commit in the same React pass; the "over" part runs last.
    if (part === "over") runtime.released(el.id);
  }, [el, part]);

  return <g ref={ref} data-id={el.id} data-author={el.author} data-part={part} />;
}

export const ElementPart = memo(ElementPartInner);
