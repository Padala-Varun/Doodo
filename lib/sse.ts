/**
 * Server-Sent Events: a streaming line-based decoder (state machine, no regex)
 * and an encoder. Used for both OpenRouter's stream and Doodo's own
 * server → browser stream.
 *
 * Per the SSE spec: lines end with \n, \r\n or \r; lines starting with ':' are
 * comments (OpenRouter sends `: OPENROUTER PROCESSING` keep-alives); a blank
 * line dispatches the event; multiple `data:` lines are joined with '\n'.
 */

export interface SseEvent {
  event: string;
  data: string;
  id?: string;
}

export class SseDecoder {
  private line = "";
  private sawCR = false;
  private data: string[] = [];
  private event = "";
  private id: string | undefined;
  private hasData = false;

  push(chunk: string): SseEvent[] {
    const out: SseEvent[] = [];
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk.charCodeAt(i);
      if (c === 10 /* \n */) {
        if (this.sawCR) {
          this.sawCR = false; // \r\n: the \r already ended the line
          continue;
        }
        this.endLine(out);
      } else if (c === 13 /* \r */) {
        this.sawCR = true;
        this.endLine(out);
      } else {
        this.sawCR = false;
        this.line += chunk[i];
      }
    }
    return out;
  }

  /** Flush a final event that was not terminated by a blank line. */
  end(): SseEvent[] {
    const out: SseEvent[] = [];
    if (this.line.length > 0) this.endLine(out);
    this.dispatch(out);
    return out;
  }

  private endLine(out: SseEvent[]): void {
    const line = this.line;
    this.line = "";
    if (line.length === 0) {
      this.dispatch(out);
      return;
    }
    if (line.charCodeAt(0) === 58 /* : */) return; // comment / keep-alive
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.charCodeAt(0) === 32) value = value.slice(1);
    switch (field) {
      case "data":
        this.data.push(value);
        this.hasData = true;
        break;
      case "event":
        this.event = value;
        break;
      case "id":
        this.id = value;
        break;
      default:
        break; // retry and unknown fields are ignored
    }
  }

  private dispatch(out: SseEvent[]): void {
    if (this.hasData) {
      out.push({ event: this.event || "message", data: this.data.join("\n"), id: this.id });
    }
    this.data = [];
    this.hasData = false;
    this.event = "";
  }
}

/** Encode one JSON payload as an SSE `data:` event. JSON never contains raw newlines. */
export function encodeSse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export const SSE_KEEPALIVE = ": keep-alive\n\n";
