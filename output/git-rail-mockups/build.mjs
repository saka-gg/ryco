import { readFileSync, writeFileSync } from "node:fs";
const dir = new URL(".", import.meta.url).pathname;
const css = readFileSync(dir + "base.css", "utf8");
const engine = readFileSync(dir + "engine.js", "utf8");
for (const v of process.argv.slice(2)) {
  const js = readFileSync(`${dir}${v}.js`, "utf8");
  writeFileSync(
    `${dir}${v}.html`,
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><div id="root"></div><script>${engine}\n${js}</script></body></html>`,
  );
  const stub = `<style>:root{--background:#fff;--foreground:#18181b;--card:#fafafa;--muted:#f1f1f2;--muted-foreground:#71717a;--secondary:#f1f1f2;--secondary-foreground:#18181b;--border:#e4e4e7;--accent:#f4f4f5;--radius:12px}body{padding:0;width:760px;background:#fff}</style>`;
  writeFileSync(`${dir}test-${v}.html`, readFileSync(`${dir}${v}.html`, "utf8").replace("<head>", "<head>" + stub));
  console.log("built", v);
}
