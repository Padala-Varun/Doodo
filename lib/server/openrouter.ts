import { SseDecoder } from "../sse";
import { config } from "./config";

export type ContentPart =
  | { type: "text"; text: string; cache_control?: { type: "ephemeral" } }
  | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } };

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
}

export interface ChatOptions {
  model: string;
  /** OpenRouter model fallbacks, tried in order if the primary fails. */
  fallbacks?: string[];
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  reasoning?: { effort: "minimal" | "low" | "medium" | "high" };
  responseFormat?: { type: "json_schema"; json_schema: { name: string; strict: boolean; schema: object } };
  signal?: AbortSignal;
  /** Abort if no first byte arrives within this many ms. */
  firstByteTimeoutMs?: number;
}

export interface Usage {
  prompt: number;
  completion: number;
  cost?: number;
}

export type StreamChunk = { type: "text"; text: string } | { type: "usage"; usage: Usage; model?: string };

export class OpenRouterError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "OpenRouterError";
  }
}

function body(opts: ChatOptions, stream: boolean) {
  const models = [opts.model, ...(opts.fallbacks ?? []).filter((m) => m !== opts.model)];
  return JSON.stringify({
    model: opts.model,
    models: models.length > 1 ? models : undefined,
    messages: opts.messages,
    stream,
    max_tokens: opts.maxTokens,
    temperature: opts.temperature,
    reasoning: opts.reasoning,
    response_format: opts.responseFormat,
    usage: { include: true },
  });
}

async function post(opts: ChatOptions, stream: boolean): Promise<Response> {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(opts.signal?.reason);
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = opts.firstByteTimeoutMs ? setTimeout(() => ctrl.abort(new Error("first byte timeout")), opts.firstByteTimeoutMs) : undefined;
  try {
    const res = await fetch(`${config.openrouterBase}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.openrouterKey}`,
        "content-type": "application/json",
        "HTTP-Referer": config.appUrl,
        "X-Title": "Doodo",
      },
      body: body(opts, stream),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      let msg = `OpenRouter HTTP ${res.status}`;
      try {
        const j = (await res.json()) as { error?: { message?: string } };
        if (j.error?.message) msg += `: ${j.error.message}`;
      } catch {
        /* non-JSON error body */
      }
      throw new OpenRouterError(msg, res.status);
    }
    return res;
  } finally {
    if (timer) clearTimeout(timer);
    // Keep forwarding caller aborts for the lifetime of the body stream.
  }
}

/** Stream a chat completion as text deltas. Throws OpenRouterError on HTTP or mid-stream errors. */
export async function* streamChat(opts: ChatOptions): AsyncGenerator<StreamChunk> {
  const res = await post(opts, true);
  if (!res.body) throw new OpenRouterError("empty response body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const sse = new SseDecoder();
  const abortReader = () => void reader.cancel().catch(() => {});
  opts.signal?.addEventListener("abort", abortReader, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      const events = done ? sse.end() : sse.push(decoder.decode(value, { stream: true }));
      for (const ev of events) {
        if (ev.data === "[DONE]") continue;
        let j: {
          model?: string;
          error?: { message?: string };
          choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
        };
        try {
          j = JSON.parse(ev.data);
        } catch {
          continue; // malformed event: skip
        }
        if (j.error) throw new OpenRouterError(j.error.message ?? "stream error");
        const text = j.choices?.[0]?.delta?.content;
        if (text) yield { type: "text", text };
        if (j.usage) {
          yield {
            type: "usage",
            model: j.model,
            usage: { prompt: j.usage.prompt_tokens ?? 0, completion: j.usage.completion_tokens ?? 0, cost: j.usage.cost },
          };
        }
      }
      if (done) break;
    }
  } finally {
    opts.signal?.removeEventListener("abort", abortReader);
    reader.releaseLock();
  }
}

/** Non-streaming completion returning the message text. */
export async function complete(opts: ChatOptions): Promise<{ text: string; usage?: Usage }> {
  const res = await post(opts, false);
  const j = (await res.json()) as {
    error?: { message?: string };
    choices?: { message?: { content?: string | null } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
  };
  if (j.error) throw new OpenRouterError(j.error.message ?? "completion error");
  const text = j.choices?.[0]?.message?.content ?? "";
  return {
    text,
    usage: j.usage ? { prompt: j.usage.prompt_tokens ?? 0, completion: j.usage.completion_tokens ?? 0, cost: j.usage.cost } : undefined,
  };
}

/**
 * Extract the first complete top-level JSON value from model text (models
 * sometimes wrap JSON in prose or code fences). Bracket-matching scanner that
 * respects strings; no regex.
 */
export function extractJson(text: string): unknown {
  for (let start = 0; start < text.length; start++) {
    const c = text[start];
    if (c !== "{" && c !== "[") continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(start, i + 1));
          } catch {
            break; // try the next opening bracket
          }
        }
      }
    }
  }
  throw new OpenRouterError("no JSON found in model output");
}
