// Ask a question, wait for the lesson to finish, ask a follow-up, screenshot.
import { chromium } from "playwright-core";
const [q1, q2, out] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const logs = [];
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") logs.push(`[${m.type()}] ${m.text()}`); });
await page.goto("http://localhost:3100/", { waitUntil: "networkidle" });
async function ask(q) {
  await page.fill('textarea[aria-label="Your question"]', q);
  await page.click("button.ask-btn");
  await page.waitForSelector("button.pill.danger", { timeout: 20000 });
  const t0 = Date.now();
  await page.waitForSelector("button.pill.danger", { state: "detached", timeout: 180000 });
  return Math.round((Date.now() - t0) / 1000);
}
const d1 = await ask(q1);
await page.screenshot({ path: `${out}-1.png` });
const d2 = await ask(q2);
await page.screenshot({ path: `${out}-2.png` });
const n = await page.evaluate(() => document.querySelectorAll('g[data-part="over"]').length);
console.log(JSON.stringify({ lesson1s: d1, lesson2s: d2, elements: n }));
console.log(logs.slice(-20).join("\n"));
await browser.close();
