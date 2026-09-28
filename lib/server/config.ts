/** Server-side configuration. Never import this from client components. */

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v !== undefined && v.trim() !== "") return v.trim();
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required environment variable ${name}`);
}

function list(name: string, fallback: string[]): string[] {
  const v = process.env[name];
  if (!v) return fallback;
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

export const config = {
  get openrouterKey() {
    return env("OPENROUTER_API_KEY");
  },
  get sarvamKey() {
    return env("SARVAM_API_KEY");
  },
  openrouterBase: env("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),
  appUrl: env("DOODO_APP_URL", "http://localhost:3000"),

  /** Fast teacher: streams the lesson. */
  teacherModel: env("DOODO_TEACHER_MODEL", "google/gemini-3.7-flash"),
  teacherFallbacks: list("DOODO_TEACHER_FALLBACKS", ["google/gemini-3.8-flash", "anthropic/claude-sonnet-5.5"]),
  /** "Deep mode" teacher: slower, higher quality. */
  deepModel: env("DOODO_DEEP_MODEL", "openai/gpt-5.5"),
  deepFallbacks: list("DOODO_DEEP_FALLBACKS", ["anthropic/claude-sonnet-5.5", "google/gemini-3.7-flash"]),
  /** Vision grounding (bounding boxes). */
  visionModel: env("DOODO_VISION_MODEL", "google/gemini-3.8-flash"),
  visionFallbacks: list("DOODO_VISION_FALLBACKS", ["google/gemini-3.7-flash"]),

  ttsModel: env("DOODO_TTS_MODEL", "bulbul:v3"),
  ttsSpeaker: env("DOODO_TTS_SPEAKER", "shubh"),
  ttsPace: Number(env("DOODO_TTS_PACE", "1.05")),
  ttsSampleRate: 24000,
};
