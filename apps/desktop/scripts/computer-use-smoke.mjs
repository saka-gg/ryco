import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const kind = process.argv[2];
const scripts = {
  browser: "scripts/computer-use-browser-smoke.ts",
  integration: "scripts/computer-use-integration-smoke.ts",
  project: "scripts/project-browser-smoke.ts",
  signin: "scripts/sign-in-popup-smoke.ts",
  // Hidden windows and its own loopback fixture pages only (no native helper).
  "tab-budget": "scripts/browser-tab-budget-smoke.ts",
};
if (!Object.hasOwn(scripts, kind ?? ""))
  throw new Error("Choose browser, integration, project, signin or tab-budget.");
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
    join(desktop, scripts[kind]),
    "--target=node",
    "--format=esm",
    "--external",
    "electron",
    "--external",
    "ws",
    `--outfile=${output}`,
  ]);
  // RYCO_SMOKE_TMP: where a smoke that reads it creates its temporary profile (this run's directory
  // unless the caller chose one).
  const env = { RYCO_SMOKE_TMP: directory, ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  run(
    join(desktop, "node_modules/.bin", process.platform === "win32" ? "electron.cmd" : "electron"),
    [output],
    env,
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
