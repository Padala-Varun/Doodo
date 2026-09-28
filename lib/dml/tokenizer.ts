/**
 * Streaming, character-level tokenizer for Doodo Markup Language (DML).
 *
 * DML is a forgiving XML-like dialect that an LLM streams token by token. The
 * tokenizer is a pure state machine: it can be fed arbitrary chunks (a tag may
 * be split anywhere, even inside an attribute value or an entity) and produces
 * exactly the same tokens as if the whole document had been fed at once.
 *
 * Design rules:
 *  - Never throws on malformed input. Anything that cannot be a tag is text.
 *  - "Raw text" elements (voice, write, math, ...) only end at their exact
 *    closing tag, so content such as `i<n` or `<stdio.h>` is preserved verbatim.
 *  - Bounded memory: an unterminated tag longer than MAX_TAG_LENGTH is
 *    demoted to text instead of buffering forever.
 */

import { own } from "../own";

export type DmlToken =
  | { type: "text"; text: string }
  | { type: "open"; name: string; attrs: Record<string, string>; selfClosing: boolean }
  | { type: "close"; name: string };

const MAX_TAG_LENGTH = 16_384;

const enum S {
  Text,
  TagOpen, // saw '<'
  TagName,
  CloseTagStart, // saw '</'
  CloseTagName,
  CloseTagEnd, // after close tag name, waiting for '>'
  BeforeAttr,
  AttrName,
  AfterAttrName,
  BeforeAttrValue,
  AttrValueDq,
  AttrValueSq,
  AttrValueUnquoted,
  UnquotedSlash, // saw '/' inside an unquoted value
  SelfCloseSlash, // saw '/' where '>' should follow
  Bang, // saw '<!'
  Comment, // inside <!-- -->
  Raw, // inside a raw-text element, looking for its closing tag
}

function isNameStart(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95; // A-Z a-z _
}

function isNameChar(c: number): boolean {
  return isNameStart(c) || (c >= 48 && c <= 57) || c === 45 || c === 46 || c === 58; // 0-9 - . :
}

function isSpace(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 12;
}

export class DmlTokenizer {
  private state: S = S.Text;
  private text = "";
  /** Raw source of the tag being read; replayed as text if the tag turns out to be invalid. */
  private tagSource = "";
  private tagName = "";
  private attrs: Record<string, string> = {};
  private attrName = "";
  private attrValue = "";
  private commentTail = "";
  /** Name of the raw-text element we are inside (lower-case), or "". */
  private rawName = "";
  /** How many characters of `</rawName` (plus trailing space and '>') have matched. */
  private rawMatch = "";
  private readonly rawElements: ReadonlySet<string>;
  private out: DmlToken[] = [];

  constructor(rawElements: Iterable<string>) {
    this.rawElements = new Set(Array.from(rawElements, (n) => n.toLowerCase()));
  }

  /** Feed a chunk and return the tokens completed by it. */
  write(chunk: string): DmlToken[] {
    for (let i = 0; i < chunk.length; i++) this.step(chunk[i], chunk.charCodeAt(i));
    return this.drain();
  }

  /** Signal end of input: flush pending text; an incomplete tag is emitted as text. */
  end(): DmlToken[] {
    switch (this.state) {
      case S.Raw:
        this.text += this.rawMatch;
        this.rawMatch = "";
        break;
      case S.Text:
      case S.Comment:
      case S.Bang:
        break;
      default:
        // Incomplete tag at end of stream. If it at least had a complete name and
        // is not a close tag, treat it as a self-closing element so that a
        // trailing `<clear` or `<pause ms="300"` still works.
        if (
          this.tagName &&
          this.state !== S.TagName &&
          this.state !== S.CloseTagStart &&
          this.state !== S.CloseTagName &&
          this.state !== S.CloseTagEnd
        ) {
          if (this.state === S.AttrName || this.state === S.AfterAttrName) this.commitAttr("");
          if (
            this.state === S.AttrValueUnquoted ||
            this.state === S.AttrValueDq ||
            this.state === S.AttrValueSq
          )
            this.commitAttr(this.attrValue);
          this.emitOpen(true);
        } else {
          this.text += this.tagSource;
        }
    }
    this.flushText();
    this.state = S.Text;
    this.tagSource = "";
    return this.drain();
  }

  private drain(): DmlToken[] {
    const out = this.out;
    this.out = [];
    return out;
  }

  private flushText(): void {
    if (this.text.length > 0) {
      this.out.push({ type: "text", text: decodeEntities(this.text) });
      this.text = "";
    }
  }

  private abortTag(ch: string): void {
    // Not a tag after all: the '<' and everything read so far is literal text.
    this.text += this.tagSource;
    this.tagSource = "";
    this.state = S.Text;
    this.resetTag();
    // Re-process the current character in Text state ('<' may start a new tag).
    this.step(ch, ch.charCodeAt(0));
  }

  private resetTag(): void {
    this.tagName = "";
    this.attrs = {};
    this.attrName = "";
    this.attrValue = "";
  }

  private commitAttr(value: string): void {
    const name = this.attrName.toLowerCase();
    if (name && !(name in this.attrs)) this.attrs[name] = decodeEntities(value);
    this.attrName = "";
    this.attrValue = "";
  }

  private emitOpen(selfClosing: boolean): void {
    const name = this.tagName.toLowerCase();
    this.flushText();
    this.out.push({ type: "open", name, attrs: this.attrs, selfClosing });
    this.tagSource = "";
    this.resetTag();
    if (!selfClosing && this.rawElements.has(name)) {
      this.rawName = name;
      this.rawMatch = "";
      this.state = S.Raw;
    } else {
      this.state = S.Text;
    }
  }

  private emitClose(): void {
    const name = this.tagName.toLowerCase();
    this.flushText();
    this.out.push({ type: "close", name });
    this.tagSource = "";
    this.resetTag();
    this.state = S.Text;
  }

  private step(ch: string, c: number): void {
    if (this.state !== S.Text && this.state !== S.Raw && this.state !== S.Comment) {
      this.tagSource += ch;
      if (this.tagSource.length > MAX_TAG_LENGTH) {
        this.text += this.tagSource;
        this.tagSource = "";
        this.resetTag();
        this.state = S.Text;
        return;
      }
    }

    switch (this.state) {
      case S.Text:
        if (c === 60 /* < */) {
          this.state = S.TagOpen;
          this.tagSource = "<";
        } else {
          this.text += ch;
        }
        return;

      case S.TagOpen:
        if (isNameStart(c)) {
          this.tagName = ch;
          this.state = S.TagName;
        } else if (c === 47 /* / */) {
          this.state = S.CloseTagStart;
        } else if (c === 33 /* ! */) {
          this.state = S.Bang;
        } else {
          this.tagSource = "<";
          this.abortTag(ch);
        }
        return;

      case S.TagName:
        if (isNameChar(c)) this.tagName += ch;
        else if (isSpace(c)) this.state = S.BeforeAttr;
        else if (c === 62 /* > */) this.emitOpen(false);
        else if (c === 47) this.state = S.SelfCloseSlash;
        else this.abortInvalid(ch);
        return;

      case S.BeforeAttr:
        if (isSpace(c)) return;
        if (c === 62) this.emitOpen(false);
        else if (c === 47) this.state = S.SelfCloseSlash;
        else if (isNameStart(c) || c === 64 /* @ */) {
          this.attrName = ch;
          this.state = S.AttrName;
        } else if (c === 44 /* , */ || c === 59 /* ; */) {
          // Tolerate stray separators some models put between attributes.
        } else this.abortInvalid(ch);
        return;

      case S.AttrName:
        if (isNameChar(c)) this.attrName += ch;
        else if (c === 61 /* = */) this.state = S.BeforeAttrValue;
        else if (isSpace(c)) this.state = S.AfterAttrName;
        else if (c === 62) {
          this.commitAttr("");
          this.emitOpen(false);
        } else if (c === 47) {
          this.commitAttr("");
          this.state = S.SelfCloseSlash;
        } else this.abortInvalid(ch);
        return;

      case S.AfterAttrName:
        if (isSpace(c)) return;
        if (c === 61) this.state = S.BeforeAttrValue;
        else if (c === 62) {
          this.commitAttr("");
          this.emitOpen(false);
        } else if (c === 47) {
          this.commitAttr("");
          this.state = S.SelfCloseSlash;
        } else if (isNameStart(c)) {
          this.commitAttr("");
          this.attrName = ch;
          this.state = S.AttrName;
        } else this.abortInvalid(ch);
        return;

      case S.BeforeAttrValue:
        if (isSpace(c)) return;
        if (c === 34 /* " */) this.state = S.AttrValueDq;
        else if (c === 39 /* ' */) this.state = S.AttrValueSq;
        else if (c === 62) {
          this.commitAttr("");
          this.emitOpen(false);
        } else {
          this.attrValue = ch;
          this.state = S.AttrValueUnquoted;
        }
        return;

      case S.AttrValueDq:
        if (c === 34) {
          this.commitAttr(this.attrValue);
          this.state = S.BeforeAttr;
        } else this.attrValue += ch;
        return;

      case S.AttrValueSq:
        if (c === 39) {
          this.commitAttr(this.attrValue);
          this.state = S.BeforeAttr;
        } else this.attrValue += ch;
        return;

      case S.AttrValueUnquoted:
        if (isSpace(c)) {
          this.commitAttr(this.attrValue);
          this.state = S.BeforeAttr;
        } else if (c === 62) {
          this.commitAttr(this.attrValue);
          this.emitOpen(false);
        } else if (c === 47) {
          this.state = S.UnquotedSlash;
        } else this.attrValue += ch;
        return;

      case S.UnquotedSlash:
        if (c === 62) {
          this.commitAttr(this.attrValue);
          this.emitOpen(true);
        } else {
          this.attrValue += "/";
          this.state = S.AttrValueUnquoted;
          // Re-run this char in the unquoted state (without re-appending to tagSource).
          this.tagSource = this.tagSource.slice(0, -1);
          this.step(ch, c);
        }
        return;

      case S.SelfCloseSlash:
        if (c === 62) this.emitOpen(true);
        else if (isSpace(c)) return;
        else {
          // `<a / b="1">` — ignore the stray slash.
          this.state = S.BeforeAttr;
          this.tagSource = this.tagSource.slice(0, -1);
          this.step(ch, c);
        }
        return;

      case S.CloseTagStart:
        if (isNameStart(c)) {
          this.tagName = ch;
          this.state = S.CloseTagName;
        } else this.abortInvalid(ch);
        return;

      case S.CloseTagName:
        if (isNameChar(c)) this.tagName += ch;
        else if (c === 62) this.emitClose();
        else if (isSpace(c)) this.state = S.CloseTagEnd;
        else this.abortInvalid(ch);
        return;

      case S.CloseTagEnd:
        if (c === 62) this.emitClose();
        else if (!isSpace(c)) this.abortInvalid(ch);
        return;

      case S.Bang:
        // Only comments are supported: `<!--`. Anything else (<!DOCTYPE, CDATA) is skipped to '>'.
        if (this.tagSource === "<!--") {
          this.state = S.Comment;
          this.commentTail = "";
          this.tagSource = "";
        } else if (c === 62) {
          this.tagSource = "";
          this.state = S.Text;
        } else if (this.tagSource.length >= 4 && !this.tagSource.startsWith("<!-")) {
          // e.g. <!DOCTYPE ...>: keep consuming until '>'
        }
        return;

      case S.Comment:
        this.commentTail = (this.commentTail + ch).slice(-3);
        if (this.commentTail === "-->") {
          this.state = S.Text;
          this.commentTail = "";
        }
        return;

      case S.Raw:
        this.stepRaw(ch, c);
        return;
    }
  }

  /** Inside a tag, a character that cannot belong to a tag: the whole thing was text. */
  private abortInvalid(ch: string): void {
    // tagSource already contains `ch`; remove it so abortTag can re-process it.
    this.tagSource = this.tagSource.slice(0, -1);
    this.abortTag(ch);
  }

  private stepRaw(ch: string, c: number): void {
    const target = "</" + this.rawName;
    const m = this.rawMatch;
    if (m.length < target.length) {
      const expected = target.charCodeAt(m.length);
      if (lower(c) === expected) {
        this.rawMatch = m + ch;
        return;
      }
    } else {
      // Full `</name` matched: allow whitespace, then require '>'.
      if (c === 62) {
        this.flushText();
        this.out.push({ type: "close", name: this.rawName });
        this.rawName = "";
        this.rawMatch = "";
        this.state = S.Text;
        return;
      }
      if (isSpace(c)) {
        this.rawMatch = m + ch;
        return;
      }
    }
    // Mismatch: the partial match is literal text. The current char may begin a new match.
    if (m.length > 0) {
      this.text += m;
      this.rawMatch = "";
      this.stepRaw(ch, c);
      return;
    }
    this.text += ch;
  }
}

function lower(c: number): number {
  return c >= 65 && c <= 90 ? c + 32 : c;
}

const NAMED_ENTITIES: Record<string, string> = {
  lt: "<",
  gt: ">",
  amp: "&",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/** Decode XML entities by scanning; unknown or malformed entities are kept literally. */
export function decodeEntities(s: string): string {
  if (s.indexOf("&") === -1) return s;
  let out = "";
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c !== 38 /* & */) {
      out += s[i++];
      continue;
    }
    const semi = s.indexOf(";", i + 1);
    if (semi === -1 || semi - i > 10) {
      out += s[i++];
      continue;
    }
    const body = s.slice(i + 1, semi);
    let decoded: string | undefined;
    if (body.length > 1 && body.charCodeAt(0) === 35 /* # */) {
      const hex = body.charCodeAt(1) === 120 || body.charCodeAt(1) === 88;
      const digits = hex ? body.slice(2) : body.slice(1);
      const code = parseIntStrict(digits, hex ? 16 : 10);
      if (code !== null && code > 0 && code <= 0x10ffff) decoded = String.fromCodePoint(code);
    } else {
      decoded = own(NAMED_ENTITIES, body);
    }
    if (decoded === undefined) {
      out += s[i++];
    } else {
      out += decoded;
      i = semi + 1;
    }
  }
  return out;
}

function parseIntStrict(s: string, radix: 10 | 16): number | null {
  if (s.length === 0) return null;
  let v = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let d: number;
    if (c >= 48 && c <= 57) d = c - 48;
    else if (radix === 16 && c >= 97 && c <= 102) d = c - 87;
    else if (radix === 16 && c >= 65 && c <= 70) d = c - 55;
    else return null;
    v = v * radix + d;
  }
  return v;
}
