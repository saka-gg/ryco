import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const kind = process.argv[2];
if (kind !== "browser" && kind !== "integration") throw new Error("Choose browser or integration.");
const cache = join(desktop, "node_modules/.cache");
mkdirSync(cache, { recursive: true });
const directory = mkdtempSync(join(cache, "computer-use-smoke-"));
const output = join(directory, "smoke.mjs");
function run(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    cwd: resolve(desktop, "../.."),
    stdio: "inherit",
    env,
  });
  if (result.error || result.status !== 0) throw new Error(`Computer-use ${kind} smoke failed.`);
}
try {
  run("bun", [
    "build",
    join(desktop, `scripts/computer-use-${kind}-smoke.ts`),
    "--target=node",
    "--format=esm",
    "--external",
    "electron",
    "--external",
    "ws",
    `--outfile=${output}`,
  ]);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  run(
    join(desktop, "node_modules/.bin", process.platform === "win32" ? "electron.cmd" : "electron"),
    [output],
    env,
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
