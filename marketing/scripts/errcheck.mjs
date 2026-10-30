/** Load every route with motion ON, scroll through, report console errors. */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const BASE = "http://localhost:4173";
const ROUTES = process.env.ROUTES ? process.env.ROUTES.split(",") : ["/", "/changelog"];
const server = spawn("npx", ["vite", "preview", "--port", "4173"], {
  cwd: new URL("..", import.meta.url).pathname,
  stdio: "ignore",
});
async function up(u, n = 60) {
  for (let i = 0; i < n; i++) {
    try {
      if ((await fetch(u)).ok) return;
    } catch {}
    await sleep(500);
  }
  throw new Error("no server");
}
try {
  await up(BASE);
  const b = await chromium.launch();
  const page = await (await b.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  let total = 0;
  for (const r of ROUTES) {
    const errs = [];
    page.removeAllListeners("console");
    page.removeAllListeners("pageerror");
    page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
    page.on("pageerror", (e) => errs.push("PAGEERROR " + e.message));
    await page.goto(`${BASE}${r}`, { waitUntil: "networkidle" });
    await page.evaluate(async () => {
      for (let y = 0; y < document.body.scrollHeight; y += window.innerHeight * 0.6) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 150));
      }
    });
    await sleep(600);
    total += errs.length;
    console.log(`${r.padEnd(4)} ${errs.length ? "✗ " + errs.length + " errors" : "✓ clean"}`);
    errs.slice(0, 4).forEach((e) => console.log("     " + e.slice(0, 140)));
  }
  console.log(total === 0 ? "\nALL CLEAN" : `\n${total} TOTAL ERRORS`);
  if (total > 0) process.exitCode = 1;
  await b.close();
} finally {
  server.kill("SIGTERM");
}
