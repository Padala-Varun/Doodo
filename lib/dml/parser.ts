import { DmlTreeBuilder } from "./builder";
import { CONTAINERS, RAW_TEXT_TAGS, TOP_LEVEL_TAGS, convertElement, type ConvertContext } from "./convert";
import type { Op } from "./ops";
import { DmlTokenizer } from "./tokenizer";

export interface ParseIssue {
  element: string;
  issue: string;
}

/**
 * Incremental DML parser: feed LLM output chunks as they stream in and receive
 * validated ops as soon as each element closes. Chunk boundaries never change
 * the result.
 */
export class DmlStreamParser {
  private readonly tokenizer = new DmlTokenizer(RAW_TEXT_TAGS);
  private readonly builder = new DmlTreeBuilder({ topLevel: TOP_LEVEL_TAGS, containers: CONTAINERS });
  private readonly counters = new Map<string, number>();
  private readonly ctx: ConvertContext;
  readonly issues: ParseIssue[] = [];
  private ended = false;

  constructor(idPrefix = "") {
    this.ctx = {
      nextId: (prefix: string) => {
        const n = (this.counters.get(prefix) ?? 0) + 1;
        this.counters.set(prefix, n);
        // Leading "_" keeps auto ids disjoint from ids the model chooses.
        return `_${idPrefix}${prefix}${n}`;
      },
    };
  }

  feed(chunk: string): Op[] {
    if (this.ended || chunk.length === 0) return [];
    return this.convert(this.builder.push(this.tokenizer.write(chunk)));
  }

  end(): Op[] {
    if (this.ended) return [];
    this.ended = true;
    const els = this.builder.push(this.tokenizer.end());
    return this.convert([...els, ...this.builder.end()]);
  }

  private convert(els: ReturnType<DmlTreeBuilder["push"]>): Op[] {
    const ops: Op[] = [];
    for (const el of els) {
      const r = convertElement(el, this.ctx);
      if (r.ok) ops.push(r.op);
      else if (this.issues.length < 200) this.issues.push({ element: el.name, issue: r.issue });
    }
    return ops;
  }
}

/** Convenience: parse a complete document. */
export function parseDml(doc: string): { ops: Op[]; issues: ParseIssue[] } {
  const p = new DmlStreamParser();
  const ops = [...p.feed(doc), ...p.end()];
  return { ops, issues: p.issues };
}
