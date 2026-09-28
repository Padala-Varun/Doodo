import type { NextRequest } from "next/server";
import { config } from "@/lib/server/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED = ["audio/webm", "audio/ogg", "audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp4", "audio/aac"];

/** Push-to-talk transcription: browser audio blob → Sarvam speech-to-text. */
export async function POST(req: NextRequest): Promise<Response> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ error: "expected multipart form data" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof Blob)) return Response.json({ error: "missing file" }, { status: 400 });
  if (file.size === 0 || file.size > MAX_BYTES) return Response.json({ error: "audio too large or empty" }, { status: 413 });
  const baseType = file.type.split(";")[0].trim();
  if (!ALLOWED.includes(baseType)) return Response.json({ error: `unsupported audio type ${file.type}` }, { status: 415 });
  const language = typeof form.get("language") === "string" ? (form.get("language") as string).slice(0, 12) : "en-IN";

  const fd = new FormData();
  const ext = baseType.split("/")[1] ?? "webm";
  fd.append("file", new Blob([await file.arrayBuffer()], { type: baseType }), `speech.${ext}`);
  fd.append("model", process.env.DOODO_STT_MODEL || "saaras:v3");
  fd.append("language_code", language);

  try {
    const res = await fetch("https://api.sarvam.ai/speech-to-text", {
      method: "POST",
      headers: { "api-subscription-key": config.sarvamKey },
      body: fd,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.error("[stt]", res.status, detail.slice(0, 300));
      return Response.json({ error: `transcription failed (${res.status})` }, { status: 502 });
    }
    const j = (await res.json()) as { transcript?: string };
    return Response.json({ transcript: (j.transcript ?? "").trim() });
  } catch (e) {
    console.error("[stt]", e);
    return Response.json({ error: "transcription service unavailable" }, { status: 502 });
  }
}
