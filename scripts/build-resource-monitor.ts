import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resourceMonitorBuildTarget } from "./resource-monitor-target.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const source = path.join(root, "native/resource-monitor");
const toolchain = readFileSync(path.join(source, "rust-toolchain.toml"), "utf8").match(
  /channel\s*=\s*"([^"]+)"/u,
)?.[1];
if (!toolchain) throw new Error("Missing pinned resource monitor Rust toolchain");
const requestedArch = process.argv[2] ?? process.arch;
const requestedPlatform = process.argv[3] ?? process.platform;
const binaryName =
  requestedPlatform === "win32" ? "ryco-resource-monitor.exe" : "ryco-resource-monitor";
const target = resourceMonitorBuildTarget(requestedPlatform, requestedArch);
execFileSync(
  "rustup",
  ["run", toolchain, "cargo", "build", "--locked", "--release", "--target", target],
  {
    cwd: source,
    stdio: "inherit",
  },
);
const destination = path.join(root, "apps/server/dist/resource-monitor");
mkdirSync(destination, { recursive: true });
const binary = path.join(destination, binaryName);
copyFileSync(path.join(source, "target", target, "release", binaryName), binary);
chmodSync(binary, 0o755);
copyFileSync(path.join(source, "LICENSE"), path.join(destination, "LICENSE"));
// npm distributions carry all supported targets; desktop also keeps its local binary.
const platformDestination = path.join(destination, `${requestedPlatform}-${requestedArch}`);
mkdirSync(platformDestination, { recursive: true });
copyFileSync(binary, path.join(platformDestination, binaryName));
copyFileSync(path.join(source, "LICENSE"), path.join(platformDestination, "LICENSE"));
