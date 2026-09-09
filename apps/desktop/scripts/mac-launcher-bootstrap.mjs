import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

export function writeMacAppBootstrap(appBundlePath, isDevelopment) {
  const appResourcesDir = join(appBundlePath, "Contents", "Resources", "app");
  mkdirSync(appResourcesDir, { recursive: true });
  writeFileSync(
    join(appResourcesDir, "package.json"),
    `${JSON.stringify({ name: "ryco-desktop-launcher", main: "main.cjs" }, null, 2)}\n`,
  );
  // Keep checkout paths and launch environment outside the signed bundle. A
  // worktree/port change must not change its ad-hoc designated requirement.
  writeFileSync(
    join(appResourcesDir, "main.cjs"),
    `
const fs = require("node:fs");
const path = require("node:path");
const rootArgument = process.argv.find((value) => value.startsWith("--ryco-dev-root="));
if (${JSON.stringify(isDevelopment)} && rootArgument) {
  require(path.join(rootArgument.slice("--ryco-dev-root=".length), "dist-electron", "main.cjs"));
} else {
  const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../../..", "launch.json"), "utf8"));
  Object.assign(process.env, config.environment);
  if (${JSON.stringify(isDevelopment)}) process.env.RYCO_DESKTOP_CALLBACK_RELAY = "1";
  require(config.desktopMainPath);
}
`,
  );
}

export function writeMacLaunchConfiguration(runtimeDir, environment, desktopMainPath) {
  const target = join(runtimeDir, "launch.json");
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ environment, desktopMainPath })}\n`, {
    mode: 0o600,
  });
  renameSync(temporary, target);
}
