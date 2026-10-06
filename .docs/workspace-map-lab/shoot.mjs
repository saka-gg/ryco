// Screenshot a direction of the lab (and surface page errors).
//   node shoot.mjs <A|B|C|D> [out.png] [query]   e.g. node shoot.mjs A shots/a.png "theme=light&t=8"
// Serves the lab itself on a free port; uses the repo's Playwright.
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, "../../apps/web/package.json"));
const { chromium } = require("playwright");

const [dir = "A", out = `shots/${dir.toLowerCase()}.png`, query = "paused=1"] =
  process.argv.slice(2);
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
};
const server = createServer(async (req, res) => {
  try {
    const path = join(
      here,
      decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/$/, "/index.html"),
    );
    res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" });
    res.end(await readFile(path));
  } catch {
    res.writeHead(404);
    res.end();
  }
}).listen(0);
const port = server.address().port;
const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1520, height: 980 },
  deviceScaleFactor: 2,
});
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto(`http://127.0.0.1:${port}/index.html?${query}#${dir}`);
await page.waitForTimeout(Number(process.env.SHOOT_WAIT ?? 1400));
if (process.env.SHOOT_CLICK) {
  await page.click(process.env.SHOOT_CLICK);
  await page.waitForTimeout(900);
}
if (errors.length) console.log(`page errors:\n${errors.join("\n")}`);
await page.locator(".app").screenshot({ path: join(here, out), timeout: 8000 });
await browser.close();
server.close();
console.log(errors.length ? `saved ${out} with errors:\n${errors.join("\n")}` : `saved ${out}`);
