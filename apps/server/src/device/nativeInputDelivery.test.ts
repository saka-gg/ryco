/**
 * Compiles and runs the device helper's offline input-delivery regression
 * (`native/device-helper/Tests/InputDeliveryTests.m`): the HID bridge's delivery
 * accounting against a stub dtuhidd transport, with no simulator and no
 * private framework loaded.
 *
 * macOS with Xcode only. CI's test legs run on Linux, so this runs locally.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HELPER_DIR = fileURLToPath(new URL("../../native/device-helper", import.meta.url));

const hasClang = (): boolean =>
  process.platform === "darwin" &&
  spawnSync("xcrun", ["--find", "clang"], { encoding: "utf8", timeout: 30_000 }).status === 0;

describe.skipIf(!hasClang())("device helper input delivery (native)", () => {
  // Created in a hook, not at collection time, so a skipped or filtered-out
  // run leaves no directory behind.
  let outDir: string | undefined;
  beforeAll(() => {
    outDir = mkdtempSync(join(tmpdir(), "ryco-input-delivery-"));
  });
  afterAll(() => {
    if (outDir !== undefined) rmSync(outDir, { recursive: true, force: true });
  });

  it("refuses, reports and cleans up undelivered input as the server expects", () => {
    const binary = join(outDir!, "input-delivery-tests");
    const compile = spawnSync(
      "xcrun",
      [
        "clang",
        "-fobjc-arc",
        "-fmodules",
        "-framework",
        "Foundation",
        "-framework",
        "CoreGraphics",
        "Sources/CoreSimulatorVersion.m",
        "Sources/DTUHIDTransport.m",
        "Sources/HIDBridge.m",
        "Tests/InputDeliveryTests.m",
        "-o",
        binary,
      ],
      { cwd: HELPER_DIR, encoding: "utf8", timeout: 90_000 },
    );
    expect(compile.status, compile.stderr).toBe(0);

    const run = spawnSync(binary, [], { encoding: "utf8", timeout: 60_000 });
    // The binary prints one FAIL line per broken check to stderr.
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("passed");
  }, 120_000);
});
