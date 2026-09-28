/**
 * Safe math-expression compiler for <plot fn="...">. Recursive-descent parser
 * producing a closure; no eval / Function, no property access, bounded size.
 *
 * Grammar:
 *   expr    := term (('+' | '-') term)*
 *   term    := unary (('*' | '/' | implicit) unary)*
 *   unary   := ('-' | '+') unary | power
 *   power   := call ('^' unary)?          (right-assoc; also '**')
 *   call    := ident '(' args ')' | ident | number | '(' expr ')' | '|' expr '|'
 */

import { own } from "../own";

export type Fn1 = (x: number) => number;

const FUNCS: Record<string, (...a: number[]) => number> = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan,
  asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs, exp: Math.exp,
  ln: Math.log, log: Math.log10, log10: Math.log10, log2: Math.log2,
  floor: Math.floor, ceil: Math.ceil, round: Math.round, sign: Math.sign,
  min: Math.min, max: Math.max, pow: Math.pow,
  sec: (x) => 1 / Math.cos(x), csc: (x) => 1 / Math.sin(x), cot: (x) => 1 / Math.tan(x),
};

const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E, tau: Math.PI * 2 };

type Node = (x: number) => number;

class Parser {
  i = 0;
  constructor(private readonly s: string) {}

  fail(msg: string): never {
    throw new Error(`${msg} at ${this.i}`);
  }

  ws(): void {
    while (this.i < this.s.length && (this.s[this.i] === " " || this.s[this.i] === "\t")) this.i++;
  }

  peek(): string {
    this.ws();
    return this.s[this.i] ?? "";
  }

  eat(ch: string): boolean {
    if (this.peek() === ch) {
      this.i++;
      return true;
    }
    return false;
  }

  parse(): Node {
    const n = this.expr();
    if (this.peek() !== "") this.fail("unexpected input");
    return n;
  }

  expr(): Node {
    let left = this.term();
    for (;;) {
      if (this.eat("+")) {
        const a = left, b = this.term();
        left = (x) => a(x) + b(x);
      } else if (this.eat("-")) {
        const a = left, b = this.term();
        left = (x) => a(x) - b(x);
      } else return left;
    }
  }

  term(): Node {
    let left = this.unary();
    for (;;) {
      const c = this.peek();
      if (c === "*" && this.s[this.i + 1] !== "*") {
        this.i++;
        const a = left, b = this.unary();
        left = (x) => a(x) * b(x);
      } else if (c === "/") {
        this.i++;
        const a = left, b = this.unary();
        left = (x) => a(x) / b(x);
      } else if (c === "(" || isAlpha(c) || isDigit(c) || c === ".") {
        // implicit multiplication: 2x, 3(x+1), x sin(x)
        const a = left, b = this.power();
        left = (x) => a(x) * b(x);
      } else return left;
    }
  }

  unary(): Node {
    if (this.eat("-")) {
      const a = this.unary();
      return (x) => -a(x);
    }
    if (this.eat("+")) return this.unary();
    return this.power();
  }

  power(): Node {
    const base = this.atom();
    const c = this.peek();
    if (c === "^" || (c === "*" && this.s[this.i + 1] === "*")) {
      this.i += c === "^" ? 1 : 2;
      const exp = this.unary();
      return (x) => Math.pow(base(x), exp(x));
    }
    return base;
  }

  atom(): Node {
    const c = this.peek();
    if (c === "(") {
      this.i++;
      const n = this.expr();
      if (!this.eat(")")) this.fail("missing )");
      return n;
    }
    if (c === "|") {
      this.i++;
      const n = this.expr();
      if (!this.eat("|")) this.fail("missing |");
      return (x) => Math.abs(n(x));
    }
    if (isDigit(c) || c === ".") return this.number();
    if (isAlpha(c)) return this.ident();
    return this.fail("unexpected token");
  }

  number(): Node {
    const start = this.i;
    while (this.i < this.s.length && (isDigit(this.s[this.i]) || this.s[this.i] === ".")) this.i++;
    if (this.s[this.i] === "e" || this.s[this.i] === "E") {
      const save = this.i;
      this.i++;
      if (this.s[this.i] === "+" || this.s[this.i] === "-") this.i++;
      if (!isDigit(this.s[this.i] ?? "")) this.i = save;
      else while (isDigit(this.s[this.i] ?? "")) this.i++;
    }
    const v = Number(this.s.slice(start, this.i));
    if (!Number.isFinite(v)) this.fail("bad number");
    return () => v;
  }

  ident(): Node {
    const start = this.i;
    while (this.i < this.s.length && (isAlpha(this.s[this.i]) || isDigit(this.s[this.i]))) this.i++;
    const name = this.s.slice(start, this.i).toLowerCase();
    if (name === "x") return (x) => x;
    const v = own(CONSTS, name);
    if (v !== undefined) return () => v;
    const f = own(FUNCS, name);
    if (f) {
      if (!this.eat("(")) {
        // sin x  (function applied to the next power term)
        const arg = this.power();
        return (x) => f(arg(x));
      }
      const args: Node[] = [];
      if (!this.eat(")")) {
        do args.push(this.expr());
        while (this.eat(","));
        if (!this.eat(")")) this.fail("missing )");
      }
      if (args.length === 1) {
        const a = args[0];
        return (x) => f(a(x));
      }
      return (x) => f(...args.map((a) => a(x)));
    }
    // "xsin" style concatenations: split a leading x
    if (name.startsWith("x") && name.length > 1) {
      this.i = start + 1;
      return (x) => x;
    }
    return this.fail(`unknown identifier ${name}`);
  }
}

function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}

function isAlpha(c: string): boolean {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "π";
}

/** Normalise common LLM spellings: "y = x^2", "f(x)=...", "π", "×", "·", "−". */
function normalize(src: string): string {
  let s = src.trim();
  const eq = s.indexOf("=");
  if (eq !== -1) s = s.slice(eq + 1);
  let out = "";
  for (const ch of s) {
    if (ch === "π") out += "pi";
    else if (ch === "×" || ch === "·" || ch === "⋅") out += "*";
    else if (ch === "−" || ch === "–") out += "-";
    else if (ch === "÷") out += "/";
    else if (ch === "²") out += "^2";
    else if (ch === "³") out += "^3";
    else out += ch;
  }
  return out;
}

/** Compile an expression in x. Returns null if invalid. */
export function compileExpr(src: string): Fn1 | null {
  if (src.length === 0 || src.length > 300) return null;
  try {
    const node = new Parser(normalize(src)).parse();
    return (x: number) => {
      const y = node(x);
      return Number.isFinite(y) ? y : NaN;
    };
  } catch {
    return null;
  }
}
