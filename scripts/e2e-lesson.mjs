// End-to-end check of /api/lesson: prints event timeline summary.
// Usage: node scripts/e2e-lesson.mjs "question" [imagePath] [port]
import fs from "node:fs";
const [question = "Explain the Pythagorean theorem", imagePath, port = "3100"] = process.argv.slice(2);
const body = {
  question,
  history: [],
  scene: { width: 1600, height: 900, items: [], freeY: 0 },
  anchors: [],
  settings: { voice: true, language: "en-IN", deep: process.env.DEEP === "1" },
};
if (imagePath) {
  const buf = fs.readFileSync(imagePath);
  const mime = imagePath.endsWith(".png") ? "image/png" : "image/jpeg";
  const w = Number(process.env.IMG_W || 1000), h = Number(process.env.IMG_H || 750);
  body.snapshot = { dataUrl: `data:${mime};base64,${buf.toString("base64")}`, width: w, height: h, region: { x: 0, y: 0, w: 1600 * 0 + w, h }, hasImage: true };
  body.scene.items.push({ id: "u1", author: "user", type: "image", box: { x: 0, y: 0, w, h }, text: "uploaded image" });
}
const t0 = Date.now();
const res = await fetch(`http://localhost:${port}/api/lesson`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
console.log("HTTP", res.status);
const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
const counts = {}; let firstOp = 0, firstVoice = 0, firstAudio = 0; const audioBytes = {}; const lines = [];
for (;;) {
  const { done, value } = await reader.read(); if (done) break;
  buf += dec.decode(value, { stream: true });
  let i; while ((i = buf.indexOf("\n\n")) !== -1) {
    const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
    if (!chunk.startsWith("data: ")) continue;
    const ev = JSON.parse(chunk.slice(6)); const ms = Date.now() - t0;
    counts[ev.t] = (counts[ev.t] || 0) + 1;
    if (ev.t === "op") { if (!firstOp) firstOp = ms; if (ev.op.op === "voice" && !firstVoice) firstVoice = ms; lines.push(`${ms}ms op ${ev.op.op} ${ev.op.id ?? ""} ${(ev.op.text ?? ev.op.desc ?? ev.op.tex ?? "").slice(0, 60)}${ev.op.svg ? " [svg " + Math.round(ev.op.svg.width) + "x" + Math.round(ev.op.svg.height) + "]" : ""}`); }
    else if (ev.t === "audio") { if (!firstAudio) firstAudio = ms; audioBytes[ev.voiceId] = (audioBytes[ev.voiceId] || 0) + ev.pcm.length * 0.75; }
    else if (ev.t === "audio_end") lines.push(`${ms}ms audio_end ${ev.voiceId} ok=${ev.ok} ${(audioBytes[ev.voiceId] / 48000 || 0).toFixed(1)}s`);
    else if (ev.t === "anchor") lines.push(`${ms}ms ANCHOR ${ev.anchor.id} ${JSON.stringify(ev.anchor.box)}`);
    else if (ev.t !== "audio") lines.push(`${ms}ms ${ev.t} ${JSON.stringify(ev).slice(0, 200)}`);
  }
}
console.log(lines.join("\n"));
console.log({ counts, firstOp, firstVoice, firstAudio, total: Date.now() - t0 });
