// Temporary pickers probe: serves the lab, runs steps, prints evaluated results and page errors.
//   node .docs/automations-lab/shots/pk-probe.mjs '<steps json>' '<js expression>'
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, dirname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const here = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(here, "../../apps/web/package.json"));
const { chromium } = require("playwright");
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
const server = createServer(async (req, res) => {
  const rel = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(
    /^\/$/,
    "/index.html",
  );
  try {
    const body = await readFile(normalize(join(here, rel)));
    res.writeHead(200, { "content-type": types[extname(rel)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
}).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1520, height: 980 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e.stack ?? e)));
page.on("console", (m) => m.type() === "error" && !/404/.test(m.text()) && errors.push(m.text()));
await page.goto(
  `http://127.0.0.1:${server.address().port}/index.html?${process.argv[4] ?? "paused=1"}#D`,
);
await page.waitForTimeout(900);
for (const s of JSON.parse(process.argv[2] ?? "[]")) {
  if (s.click) await page.click(s.click);
  else if (s.press) await page.keyboard.press(s.press);
  else if (s.type) await page.keyboard.type(s.type, { delay: 15 });
  else if (s.fill) await page.fill(s.fill[0], s.fill[1]);
  else if (s.wait) await page.waitForTimeout(s.wait);
  if (!s.wait) await page.waitForTimeout(60);
}
if (process.argv[3]) console.log(JSON.stringify(await page.evaluate(process.argv[3]), null, 1));
console.log(errors.length ? `ERRORS:\n${errors.join("\n")}` : "no page errors");
await browser.close();
server.close();
