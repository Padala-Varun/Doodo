import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { DmlStreamParser } from "@/lib/dml/parser";
import type { Op } from "@/lib/dml/ops";
import { lessonRequestSchema, type LessonEvent } from "@/lib/protocol";
import { encodeSse, SSE_KEEPALIVE } from "@/lib/sse";
import { config } from "@/lib/server/config";
import { decodeDataUrl, groundTargets, type FindTarget, type Snapshot } from "@/lib/server/ground";
import { OpenRouterError, streamChat, type ChatMessage, type ContentPart } from "@/lib/server/openrouter";
import { buildTeacherUserMessage, TEACHER_SYSTEM } from "@/lib/server/prompts/teacher";
import { renderTex } from "@/lib/server/tex";
import { SarvamTts } from "@/lib/server/tts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const FIND_BATCH_MS = 120;
const MAX_HISTORY = 8;

const MAX_BODY_BYTES = 16 * 1024 * 1024;

export async function POST(req: NextRequest): Promise<Response> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return Response.json({ error: "request too large" }, { status: 413 });
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = lessonRequestSchema.safeParse(json);
  if (!parsed.success) {
    return Response.json({ error: "invalid request", details: parsed.error.issues.slice(0, 5) }, { status: 400 });
  }
  const body = parsed.data;
  const lessonId = randomUUID();
  const abort = new AbortController();
  req.signal.addEventListener("abort", () => abort.abort(), { once: true });

  const encoder = new TextEncoder();
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (ev: LessonEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(encodeSse(ev)));
        } catch {
          closed = true;
        }
      };
      const keepAlive = setInterval(() => {
        if (!closed) {
          try {
            controller.enqueue(encoder.encode(SSE_KEEPALIVE));
          } catch {
            closed = true;
          }
        }
      }, 15_000);

      const tts = body.settings.voice
        ? new SarvamTts(
            {
              pcm: (voiceId, seq, pcm, sampleRate) => send({ t: "audio", voiceId, seq, pcm, sampleRate }),
              wav: (voiceId, wav) => send({ t: "audio_wav", voiceId, wav }),
              end: (voiceId, ok) => send({ t: "audio_end", voiceId, ok }),
            },
            { speaker: body.settings.speaker, pace: body.settings.pace, language: body.settings.language },
          )
        : null;
      tts?.warmUp();

      let snapshot: Snapshot | null = null;
      if (body.snapshot) {
        const { bytes, mime } = decodeDataUrl(body.snapshot.dataUrl);
        snapshot = { bytes, mime, width: body.snapshot.width, height: body.snapshot.height, region: body.snapshot.region };
      }

      // --- grounding: batch <find> ops and resolve them concurrently with the lesson ---
      const groundingJobs: Promise<void>[] = [];
      let findBatch: FindTarget[] = [];
      let findTimer: ReturnType<typeof setTimeout> | null = null;
      const knownAnchors = new Set(body.anchors.map((a) => a.id));
      const flushFinds = () => {
        if (findTimer) clearTimeout(findTimer);
        findTimer = null;
        const batch = findBatch;
        findBatch = [];
        if (batch.length === 0) return;
        if (!snapshot) {
          for (const t of batch) send({ t: "anchor_fail", id: t.id, reason: "no image on the board" });
          return;
        }
        send({ t: "status", stage: "grounding", message: `Looking at ${batch.map((b) => b.id).join(", ")}` });
        groundingJobs.push(
          groundTargets(batch, snapshot, body.question, abort.signal).then((results) => {
            for (const r of results) {
              if ("anchor" in r) send({ t: "anchor", anchor: r.anchor });
              else send({ t: "anchor_fail", id: r.id, reason: r.error });
            }
          }),
        );
      };

      // --- ordered op pipeline (math rendering is async, order must be preserved) ---
      let chain: Promise<void> = Promise.resolve();
      const handleOp = (op: Op) => {
        if (op.op === "find") {
          if (knownAnchors.has(op.id)) return; // already located in an earlier turn
          knownAnchors.add(op.id);
          send({ t: "op", op }); // lets the client know this anchor is pending
          findBatch.push({ id: op.id, desc: op.desc, kind: op.kind });
          if (!findTimer) findTimer = setTimeout(flushFinds, FIND_BATCH_MS);
          return;
        }
        if (findBatch.length > 0) flushFinds(); // a drawing op follows: start grounding now
        if (op.op === "voice") tts?.enqueue(op.id, op.text);
        chain = chain.then(async () => {
          if (op.op === "math") {
            const svg = await renderTex(op.tex, op.size);
            if (svg) op.svg = svg;
          }
          send({ t: "op", op });
        });
      };

      const parser = new DmlStreamParser();
      let dml = "";
      let issuesSent = 0;
      const reportIssues = () => {
        while (issuesSent < parser.issues.length && issuesSent < 50) {
          const is = parser.issues[issuesSent++];
          send({ t: "issue", element: is.element, issue: is.issue });
        }
      };

      const model = body.settings.deep ? config.deepModel : config.teacherModel;
      const fallbacks = body.settings.deep ? config.deepFallbacks : config.teacherFallbacks;
      send({ t: "start", lessonId, model });
      send({ t: "status", stage: "thinking" });

      let usage: { prompt: number; completion: number; cost?: number } | undefined;
      try {
        const messages = buildMessages(body, model);
        let first = true;
        for await (const chunk of streamChat({
          model,
          fallbacks,
          messages,
          maxTokens: 8000,
          temperature: 0.6,
          reasoning: { effort: "low" },
          signal: abort.signal,
          firstByteTimeoutMs: 30_000,
        })) {
          if (chunk.type === "usage") {
            usage = chunk.usage;
            continue;
          }
          if (first) {
            first = false;
            send({ t: "status", stage: "drawing" });
          }
          dml += chunk.text;
          for (const op of parser.feed(chunk.text)) handleOp(op);
          reportIssues();
        }
        for (const op of parser.end()) handleOp(op);
        reportIssues();
        flushFinds();
        await chain;
        await Promise.allSettled(groundingJobs);
        await tts?.drain();
        send({ t: "done", dml, usage });
      } catch (e) {
        if (!abort.signal.aborted) {
          const message =
            e instanceof OpenRouterError ? e.message : e instanceof Error ? `Lesson failed: ${e.message}` : "Lesson failed";
          console.error("[lesson]", lessonId, e);
          // Still deliver whatever was already parsed.
          try {
            await chain;
            await tts?.drain();
          } catch {
            /* ignore */
          }
          send({ t: "error", message, dml });
        }
      } finally {
        clearInterval(keepAlive);
        if (findTimer) clearTimeout(findTimer);
        tts?.close();
        if (!closed) {
          closed = true;
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      }
    },
    cancel() {
      closed = true;
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

function buildMessages(body: ReturnType<typeof lessonRequestSchema.parse>, model: string): ChatMessage[] {
  const isAnthropic = model.startsWith("anthropic/");
  const system: ChatMessage = isAnthropic
    ? { role: "system", content: [{ type: "text", text: TEACHER_SYSTEM, cache_control: { type: "ephemeral" } }] }
    : { role: "system", content: TEACHER_SYSTEM };
  const history: ChatMessage[] = body.history.slice(-MAX_HISTORY * 2).map((m) => ({
    role: m.role,
    content: m.role === "assistant" ? m.content.slice(-16_000) : m.content.slice(0, 4000),
  }));
  const userParts: ContentPart[] = [];
  if (body.snapshot) userParts.push({ type: "image_url", image_url: { url: body.snapshot.dataUrl, detail: "high" } });
  userParts.push({ type: "text", text: buildTeacherUserMessage(body, []) });
  return [system, ...history, { role: "user", content: userParts }];
}
