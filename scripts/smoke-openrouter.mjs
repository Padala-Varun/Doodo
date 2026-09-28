// Smoke test: OpenRouter streaming TTFT for candidate teacher models. Usage: npm run smoke:openrouter [model...]
const key = process.env.OPENROUTER_API_KEY;
if (!key) throw new Error("OPENROUTER_API_KEY missing");
const models = process.argv.slice(2).length ? process.argv.slice(2) : [process.env.DOODO_TEACHER_MODEL || "google/gemini-3.8-flash"];
for (const model of models) {
  const t0 = Date.now();
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json", "x-title": "Doodo smoke" },
    body: JSON.stringify({
      model, stream: true, max_tokens: 300, reasoning: { effort: "low" },
      messages: [{ role: "system", content: "Reply with <voice>one short sentence</voice> then <write>a 3 word title</write>." }, { role: "user", content: "Explain gravity" }],
    }),
  });
  if (!res.ok) { console.log(model, "HTTP", res.status, (await res.text()).slice(0, 300)); continue; }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "", first = 0, out = "", usage = null, provider = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      const j = JSON.parse(data);
      if (j.provider) provider = j.provider;
      const c = j.choices?.[0]?.delta?.content;
      if (c) { if (!first) first = Date.now() - t0; out += c; }
      if (j.usage) usage = j.usage;
      if (j.error) console.log("stream error", j.error);
    }
  }
  console.log(`${model} [${provider}] ttft=${first}ms total=${Date.now() - t0}ms usage=${JSON.stringify(usage)}\n  ${out.split("\n").join(" ").slice(0, 200)}`);
}
