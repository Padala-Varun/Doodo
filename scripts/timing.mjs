// Measures client-side latency: time from clicking Ask to first caption / first drawn element.
import { chromium } from "playwright-core";
const [question = "What is photosynthesis?", port = "3100"] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(`http://localhost:${port}/`, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
await page.fill('textarea[aria-label="Your question"]', question);
const t = await page.evaluate(() => {
  const w = window;
  w.__t = { click: performance.now() };
  const obs = new MutationObserver(() => {
    const now = performance.now();
    if (!w.__t.caption && document.querySelector(".caption")) w.__t.caption = now;
    if (!w.__t.live && document.querySelector("svg path[stroke-dasharray], svg path[fill]:not([d=''])")) w.__t.live = now;
    if (!w.__t.el && document.querySelector('g[data-part="over"]')) w.__t.el = now;
  });
  obs.observe(document.body, { subtree: true, childList: true, attributes: true });
  return true;
});
const origFetch = await page.evaluate(() => {
  const f = window.fetch;
  window.fetch = async (...a) => { window.__t.fetch = performance.now(); const r = await f(...a); window.__t.headers = performance.now(); return r; };
  return true;
});
await page.evaluate(() => { window.__t.click = performance.now(); });
await page.click("button.ask-btn");
await page.waitForTimeout(12000);
const r = await page.evaluate(() => { const t = window.__t; const o = {}; for (const k in t) o[k] = Math.round(t[k] - t.click); return o; });
console.log(JSON.stringify(r));
console.log(logs.slice(-15).join("\n"));
await browser.close();
