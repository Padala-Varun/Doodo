import type { DmlToken } from "./tokenizer";

/** A fully-closed DML element, before type validation. */
export interface RawElement {
  name: string;
  attrs: Record<string, string>;
  /** Concatenated direct text content. */
  text: string;
  children: RawElement[];
}

export interface BuilderOptions {
  /** Elements recognised at the top level. Everything else at depth 0 is ignored. */
  topLevel: ReadonlySet<string>;
  /** For container elements: which child element names they accept. */
  containers: ReadonlyMap<string, ReadonlySet<string>>;
  /** Hard limit on children per container to bound memory. */
  maxChildren?: number;
}

/**
 * Turns a token stream into complete top-level elements.
 *
 * - An element is emitted as soon as it closes (or self-closes).
 * - A close tag for an element deeper in the stack implicitly closes everything
 *   above it; a close tag that matches nothing is ignored.
 * - An opening tag of a *top-level* kind while another top-level element is open
 *   (e.g. the model forgot `</voice>`) implicitly closes the open one, because
 *   DML top-level elements never nest.
 * - `end()` closes everything still open, so a truncated stream still yields
 *   its last element.
 */
export class DmlTreeBuilder {
  private stack: RawElement[] = [];
  private readonly maxChildren: number;

  constructor(private readonly opts: BuilderOptions) {
    this.maxChildren = opts.maxChildren ?? 2000;
  }

  push(tokens: DmlToken[]): RawElement[] {
    const done: RawElement[] = [];
    for (const t of tokens) this.consume(t, done);
    return done;
  }

  end(): RawElement[] {
    const done: RawElement[] = [];
    while (this.stack.length > 0) this.popInto(done);
    return done;
  }

  get depth(): number {
    return this.stack.length;
  }

  private consume(t: DmlToken, done: RawElement[]): void {
    switch (t.type) {
      case "text": {
        const top = this.stack[this.stack.length - 1];
        if (top) top.text += t.text;
        return;
      }
      case "open": {
        const el: RawElement = { name: t.name, attrs: t.attrs, text: "", children: [] };
        if (this.stack.length === 0) {
          if (!this.opts.topLevel.has(t.name)) return; // unknown top-level tag: ignore
          if (t.selfClosing) done.push(el);
          else this.stack.push(el);
          return;
        }
        const parent = this.stack[this.stack.length - 1];
        const allowed = this.opts.containers.get(parent.name);
        if (allowed && allowed.has(t.name)) {
          if (t.selfClosing) {
            if (parent.children.length < this.maxChildren) parent.children.push(el);
          } else {
            this.stack.push(el);
          }
          return;
        }
        if (this.opts.topLevel.has(t.name)) {
          // A new top-level element while one is still open: close the open ones.
          while (this.stack.length > 0) this.popInto(done);
          if (t.selfClosing) done.push(el);
          else this.stack.push(el);
          return;
        }
        // Unknown nested tag (e.g. <b> inside a label): ignore the tag, keep its text.
        return;
      }
      case "close": {
        let idx = -1;
        for (let i = this.stack.length - 1; i >= 0; i--) {
          if (this.stack[i].name === t.name) {
            idx = i;
            break;
          }
        }
        if (idx === -1) return;
        while (this.stack.length > idx) this.popInto(done);
        return;
      }
    }
  }

  private popInto(done: RawElement[]): void {
    const el = this.stack.pop();
    if (!el) return;
    const parent = this.stack[this.stack.length - 1];
    if (parent) {
      if (parent.children.length < this.maxChildren) parent.children.push(el);
    } else {
      done.push(el);
    }
  }
}
