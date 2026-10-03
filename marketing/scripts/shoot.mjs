/**
 * Capture showcase screenshots of every version.
 * Boots `vite preview` on :4173, then shoots `/` and `/changelog` at desktop +
 * mobile widths into ./screenshots. Requires Playwright chromium.
 *
 *   bunx playwright install chromium
 *   node scripts/shoot.mjs
 */
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

const BASE = "http://localhost:4173";
const ROUTES = process.env.ROUTES ? process.env.ROUTES.split(",") : ["/", "/changelog"];
const OUT = new URL("../screenshots/", import.meta.url).pathname;

async function waitForServer(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error("preview server never came up");
}

const server = spawn("npx", ["vite", "preview", "--port", "4173", "--host"], {
  cwd: new URL("..", import.meta.url).pathname,
  stdio: "inherit",
});

try {
  await mkdir(OUT, { recursive: true });
  await waitForServer(BASE);
  const browser = await chromium.launch();

  const REDUCED = process.env.MOTION === "off";
  for (const [label, vp] of [
    ["desktop", { width: 1440, height: 900 }],
    ["mobile", { width: 390, height: 844 }],
  ]) {
    const ctx = await browser.newContext({
      viewport: vp,
      deviceScaleFactor: 2,
      // Reduced motion renders the fully-settled static layout — ideal for
      // verifying every section is present (scroll-reveal pages otherwise
      // capture empty because a full-page shot never scrolls).
      reducedMotion: REDUCED ? "reduce" : "no-preference",
    });
    const page = await ctx.newPage();
    for (const route of ROUTES) {
      const slug = route === "/" ? "index" : route.slice(1);
      await page.goto(`${BASE}${route}`, { waitUntil: "networkidle" });
      // Scroll through to trigger any scroll-driven reveals, then return to top.
      await page.evaluate(async () => {
        const step = window.innerHeight * 0.8;
        for (let y = 0; y < document.body.scrollHeight; y += step) {
          window.scrollTo(0, y);
          await new Promise((r) => setTimeout(r, 120));
        }
        window.scrollTo(0, 0);
      });
      await sleep(900); // let entrance animations settle
      await page.screenshot({ path: `${OUT}${slug}-${label}.png`, fullPage: label === "desktop" });
      // eslint-disable-next-line no-console
      console.log(`shot ${slug}-${label}`);
    }
    await ctx.close();
  }
  await browser.close();
} finally {
  server.kill("SIGTERM");
}
