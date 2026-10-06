// Screenshot a direction of the automations lab and surface page errors.
//
//   node .docs/automations-lab/shoot.mjs <A|B|C|D> [out.png] [query]
//   e.g. node .docs/automations-lab/shoot.mjs A shots/a.png "paused=1&theme=dark"
//
// `out` is relative to this folder. Serves the lab itself on a free port and
// uses the repo's Playwright (apps/web). Env:
//   SHOOT_STEPS     JSON array run in order before the shot:
//                   {"click": sel} {"hover": sel} {"focus": sel} {"wait": ms}
//                   {"type": text} {"press": key} {"fill": [sel, text]}
//                   {"eval": "js expression"}  (runs in the page)
//   SHOOT_WAIT      ms to wait after load (default 1200)
//   SHOOT_SELECTOR  element to capture (default #app-window; "page" = full page)
//   SHOOT_VIEWPORT  "1520x980" (default)
// Missing optional files (a direction not built yet) are listed, not counted
// as errors. Exits 1 when the page threw or logged errors.
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { extname, join, dirname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "../../apps/web/package.json"));
const { chromium } = require("playwright");

const [dir = "A", out = `shots/${dir.toLowerCase()}.png`, query = "paused=1"] =
  process.argv.slice(2);
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};
const missing = new Set();
const server = createServer(async (req, res) => {
  const rel = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(
    /^\/$/,
    "/index.html",
  );
  const path = normalize(join(here, rel));
  if (!path.startsWith(here)) {
    res.writeHead(403);
    return res.end();
  }
  try {
    const body = await readFile(path);
    res.writeHead(200, {
      "content-type": types[extname(path)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    missing.add(rel.replace(/^\//, ""));
    res.writeHead(404);
    res.end();
  }
}).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const port = server.address().port;

const [vw, vh] = (process.env.SHOOT_VIEWPORT ?? "1520x980").split("x").map(Number);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: vw, height: vh }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.stack ?? e}`));
page.on("console", (m) => {
  if (m.type() !== "error") return;
  const text = m.text();
  // 404s for files that don't exist yet are reported separately below.
  if (/Failed to load resource: .*404/.test(text)) return;
  errors.push(`console.error: ${text}`);
});

let exitCode = 0;
try {
  await page.goto(`http://127.0.0.1:${port}/index.html?${query}#${dir}`, { waitUntil: "load" });
  await page.waitForTimeout(Number(process.env.SHOOT_WAIT ?? 1200));

  const steps = process.env.SHOOT_STEPS ? JSON.parse(process.env.SHOOT_STEPS) : [];
  for (const [i, s] of steps.entries()) {
    try {
      if (s.click) await page.click(s.click, { timeout: 4000 });
      else if (s.hover) await page.hover(s.hover, { timeout: 4000 });
      else if (s.focus) await page.focus(s.focus, { timeout: 4000 });
      else if (s.wait != null) await page.waitForTimeout(Number(s.wait));
      else if (s.type != null) await page.keyboard.type(String(s.type), { delay: 18 });
      else if (s.press) await page.keyboard.press(s.press);
      else if (s.fill) await page.fill(s.fill[0], String(s.fill[1]), { timeout: 4000 });
      else if (s.eval) await page.evaluate(s.eval);
      // Let a click/keypress settle before the next step unless the caller waits.
      if (s.wait == null) await page.waitForTimeout(80);
    } catch (err) {
      errors.push(`step ${i} ${JSON.stringify(s)} failed: ${err.message.split("\n")[0]}`);
    }
  }

  const sel = process.env.SHOOT_SELECTOR ?? "#app-window";
  const file = join(here, out);
  await mkdir(dirname(file), { recursive: true });
  if (sel === "page") await page.screenshot({ path: file, fullPage: true });
  else await page.locator(sel).first().screenshot({ path: file, timeout: 8000 });
} catch (err) {
  errors.push(`shoot failed: ${err.message.split("\n")[0]}`);
  exitCode = 1;
}
await browser.close();
server.close();

const optional = [...missing].filter((f) => !f.endsWith(".ico"));
if (optional.length) console.log(`not built yet: ${optional.join(", ")}`);
if (errors.length) {
  console.log(`page errors:\n${errors.join("\n")}`);
  exitCode = 1;
}
console.log(exitCode ? `saved ${out} (with errors)` : `saved ${out}`);
process.exit(exitCode);
