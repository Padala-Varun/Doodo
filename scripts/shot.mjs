// Visual check: open Doodo, ask a question (optionally upload an image first), take screenshots.
// Usage: node scripts/shot.mjs "question" outPrefix [imagePath] [waitSeconds]
import { chromium } from "playwright-core";
const [question, out = "shot", imagePath, waitS = "45", port = "3100"] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(`http://localhost:${port}/`, { waitUntil: "networkidle" });
if (imagePath) {
  await page.setInputFiles('input[type="file"]', imagePath);
  await page.waitForTimeout(1500);
}
if (process.env.DRAW) {
  // Draw a user circle at given board-ish screen coords "x,y,r"
  const [x, y, r] = process.env.DRAW.split(",").map(Number);
  await page.click('button[aria-label="Pen"]');
  await page.mouse.move(x + r, y);
  await page.mouse.down();
  for (let a = 0; a <= Math.PI * 2.1; a += 0.15) await page.mouse.move(x + r * Math.cos(a), y + r * Math.sin(a));
  await page.mouse.up();
}
await page.fill('textarea[aria-label="Your question"]', question);
await page.click('button.ask-btn');
const total = Number(waitS);
for (let t = 5; t <= total; t += Number(process.env.EVERY || 15)) {
  await page.waitForTimeout((Number(process.env.EVERY || 15)) * 1000 - (t === 5 ? 10000 : 0));
  await page.screenshot({ path: `${out}-${t}s.png` });
}
await page.screenshot({ path: `${out}-final.png` });
const state = await page.evaluate(() => ({ caption: document.querySelector(".caption")?.textContent ?? "", err: document.querySelector(".toast")?.textContent ?? "", els: document.querySelectorAll("g[data-id]").length }));
console.log(JSON.stringify(state));
console.log(logs.filter((l) => !l.includes("[debug]")).slice(-30).join("\n"));
await browser.close();
