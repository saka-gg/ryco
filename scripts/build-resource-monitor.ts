import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildCachedNativeBinary,
  fingerprint,
  nativeBuildEnvironment,
  sourceTreeFingerprint,
  swiftToolchainIdentity,
} from "./lib/native-build-cache.ts";
import { resourceMonitorBuildTarget } from "./resource-monitor-target.ts";

const scriptPath = fileURLToPath(import.meta.url);

export function buildResourceMonitor({
  root = fileURLToPath(new URL("..", import.meta.url)),
  architecture = process.arch,
  platform = process.platform,
}: {
  readonly root?: string;
  readonly architecture?: string;
  readonly platform?: string;
} = {}): void {
  const source = path.join(root, "native/resource-monitor");
  const toolchain = readFileSync(path.join(source, "rust-toolchain.toml"), "utf8").match(
    /channel\s*=\s*"([^"]+)"/u,
  )?.[1];
  if (!toolchain) throw new Error("Missing pinned resource monitor Rust toolchain");
  const binaryName = platform === "win32" ? "ryco-resource-monitor.exe" : "ryco-resource-monitor";
  const target = resourceMonitorBuildTarget(platform, architecture);
  const destination = path.join(root, "apps/server/dist/resource-monitor");
  mkdirSync(destination, { recursive: true });
  const binary = path.join(destination, binaryName);
  buildCachedNativeBinary({
    name: `resource-monitor-${target}`,
    key: fingerprint(
      "resource-monitor-v1",
      target,
      sourceTreeFingerprint(source),
      toolchain,
      // Cargo links with the host's Xcode SDK on macOS; the desktop helper keys
      // include the same identity.
      process.platform === "darwin" ? swiftToolchainIdentity() : [],
      nativeBuildEnvironment(),
      readFileSync(scriptPath),
    ),
    // Staged outside Cargo's target directory: Cargo trusts its own fingerprints,
    // so a restored file there could later be cached under another key.
    output: binary,
    // Cross-compiled targets cannot run here; the cache verifies the checksum.
    validate: (candidate) => statSync(candidate).size > 0,
    build(candidate) {
      execFileSync(
        "rustup",
        ["run", toolchain, "cargo", "build", "--locked", "--release", "--target", target],
        {
          cwd: source,
          stdio: "inherit",
        },
      );
      copyFileSync(path.join(source, "target", target, "release", binaryName), candidate);
    },
  });
  chmodSync(binary, 0o755);
  copyFileSync(path.join(source, "LICENSE"), path.join(destination, "LICENSE"));
  // npm distributions carry all supported targets; desktop also keeps its local binary.
  const platformDestination = path.join(destination, `${platform}-${architecture}`);
  mkdirSync(platformDestination, { recursive: true });
  copyFileSync(binary, path.join(platformDestination, binaryName));
  copyFileSync(path.join(source, "LICENSE"), path.join(platformDestination, "LICENSE"));
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  buildResourceMonitor({
    architecture: process.argv[2] ?? process.arch,
    platform: process.argv[3] ?? process.platform,
  });
}
