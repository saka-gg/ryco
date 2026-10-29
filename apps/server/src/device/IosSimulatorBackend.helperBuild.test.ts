/**
 * A helper that cannot build on this toolchain.
 *
 * Agent device tools read the accessibility tree around every action, so on a
 * Mac whose helper does not build, each read used to rerun the build only to
 * fail the same way. The failure now answers for itself for a while.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProcessRunResult } from "../processRunner.ts";
import { IosSimulatorBackend } from "./IosSimulatorBackend.ts";

const DEVICE = "AAAA-1111";

const ok = (stdout: string): ProcessRunResult => ({
  stdout,
  stderr: "",
  code: 0,
  signal: null,
  timedOut: false,
});

let cacheRoot: string | null = null;
afterEach(async () => {
  vi.useRealTimers();
  if (cacheRoot) await rm(cacheRoot, { recursive: true, force: true });
  cacheRoot = null;
});

async function unbuildableBackend() {
  // An empty cache: no helper binary, so the first read has to build one.
  cacheRoot = await mkdtemp(path.join(tmpdir(), "ryco-helper-build-"));
  let builds = 0;
  const backend = new IosSimulatorBackend({
    platform: "darwin",
    helperCacheRoot: cacheRoot,
    makeHelperClient: () => {
      throw new Error("the helper never builds, so no client starts");
    },
    run: async (command, args) => {
      if (command === "/bin/sh") {
        builds += 1;
        return { ...ok(""), code: 1, stderr: "error: SimulatorKit.framework not found" };
      }
      if (command === "xcode-select") return ok("/Applications/Xcode.app/Contents/Developer");
      if (command === "xcodebuild") {
        return args.includes("-license") ? ok("") : ok("Xcode 26.3\nBuild version 17D1");
      }
      return ok("");
    },
  });
  return { backend, builds: () => builds };
}

describe("a helper build that fails", () => {
  it("is not rerun by every read on the same toolchain, and is retried later", async () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    const { backend, builds } = await unbuildableBackend();

    await expect(backend.describeUi(DEVICE)).rejects.toThrow(
      /^Device helper build failed: error: SimulatorKit\.framework not found\./u,
    );
    await expect(backend.describeUi(DEVICE)).rejects.toThrow(/^Device helper build failed/u);
    await expect(backend.tap(DEVICE, 10, 10)).rejects.toThrow(/^Device helper build failed/u);

    expect(builds()).toBe(1);
    expect((await backend.availability()).kind).toBe("helper-unavailable");

    // A fix that keeps the same Xcode is picked up after the retry window.
    vi.advanceTimersByTime(60_001);
    await expect(backend.describeUi(DEVICE)).rejects.toThrow(/^Device helper build failed/u);
    expect(builds()).toBe(2);
  });

  it("is tried again at once when a device is attached", async () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    const { backend, builds } = await unbuildableBackend();

    await expect(backend.describeUi(DEVICE)).rejects.toThrow(/^Device helper build failed/u);
    expect(builds()).toBe(1);
    // The user fixed what the error named and attaches the device again within the window.
    await expect(backend.attachStream(DEVICE, () => undefined)).rejects.toThrow(
      /^Device helper build failed/u,
    );
    expect(builds()).toBe(2);
  });
});
