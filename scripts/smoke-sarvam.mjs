// Smoke test: Sarvam TTS latency + response shape. Usage: npm run smoke:sarvam
const key = process.env.SARVAM_API_KEY;
if (!key) throw new Error("SARVAM_API_KEY missing");
const body = {
  text: "Let's take a right triangle. The longest side is called the hypotenuse.",
  target_language_code: "en-IN",
  speaker: process.env.DOODO_TTS_SPEAKER || "shubh",
  model: process.env.DOODO_TTS_MODEL || "bulbul:v3",
  pace: 1.05,
  speech_sample_rate: 24000,
  output_audio_codec: "mp3",
};
const t0 = Date.now();
const res = await fetch("https://api.sarvam.ai/text-to-speech", {
  method: "POST",
  headers: { "api-subscription-key": key, "content-type": "application/json" },
  body: JSON.stringify(body),
});
const text = await res.text();
console.log("status", res.status, "ms", Date.now() - t0);
if (!res.ok) { console.log(text.slice(0, 800)); process.exit(1); }
const json = JSON.parse(text);
console.log("keys", Object.keys(json), "audios", json.audios?.length, "b64 bytes", json.audios?.[0]?.length, "head", json.audios?.[0]?.slice(0, 16));
