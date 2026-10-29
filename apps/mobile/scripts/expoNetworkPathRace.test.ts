/// <reference types="node" />
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

/**
 * patches/expo-network@57.0.1.patch: expo-network's one-shot path query let a
 * monitor update write the path while the caller read it, and kept writing
 * after cancel(). The app queries on every subscribe and every return from
 * background. This compiles the installed (patched) query against a scripted
 * monitor under the Thread Sanitizer, which halts on any data race.
 */

const hasSwift =
  process.platform === "darwin" && spawnSync("xcrun", ["--find", "swiftc"]).status === 0;

function extractPathQuery(source: string): string {
  const start = source.indexOf("  private func getNetworkPathAsync()");
  if (start === -1) throw new Error("expo-network's path query was not found");
  const end = source.indexOf("\n  }\n", start);
  if (end === -1) throw new Error("expo-network's path query has no end");
  return source.slice(start, end + "\n  }\n".length);
}

describe.skipIf(!hasSwift)("expo-network path query (patched)", () => {
  let directory = "";
  let executable = "";

  beforeAll(() => {
    const requireFromApp = createRequire(join(import.meta.dirname, "..", "package.json"));
    const moduleSource = readFileSync(
      join(dirname(requireFromApp.resolve("expo-network/package.json")), "ios/NetworkModule.swift"),
      "utf8",
    );
    directory = mkdtempSync(join(tmpdir(), "ryco-expo-network-"));
    const harness = join(directory, "NetworkModule.swift");
    writeFileSync(
      harness,
      [
        "import Foundation",
        "final class NetworkModule {",
        "  private let monitorQueue = DispatchQueue.global(qos: .default)",
        extractPathQuery(moduleSource),
        "  func query() -> NWPath? { getNetworkPathAsync() }",
        "}",
        "",
      ].join("\n"),
    );
    // Top-level statements are only allowed in main.swift.
    const main = join(directory, "main.swift");
    writeFileSync(
      main,
      readFileSync(join(import.meta.dirname, "fixtures/NetworkPathRegression.swift"), "utf8"),
    );
    executable = join(directory, "network-path-regression");
    execFileSync(
      "xcrun",
      ["swiftc", "-swift-version", "5", "-sanitize=thread", harness, main, "-o", executable],
      { timeout: 120_000, encoding: "utf8" },
    );
  }, 150_000);

  afterAll(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it.each([
    ["first", "keeps the first path when several updates arrive before the query returns"],
    ["concurrent", "reads paths during overlapping queries and late updates without a data race"],
  ])("%s: %s", (scenario) => {
    expect(
      execFileSync(executable, [scenario], {
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env, TSAN_OPTIONS: "halt_on_error=1" },
      }).trim(),
    ).toBe("passed");
  });
});
