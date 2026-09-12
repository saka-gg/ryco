import { expect, it, vi } from "vitest";
import type { ProcessRunResult, runProcess } from "../processRunner.ts";
import { shareDeviceHelperBuilds } from "./localDeviceHost.ts";

it("shares simultaneous native builds while preserving separate device commands and later retries", async () => {
  let finish!: (result: ProcessRunResult) => void;
  const pending = new Promise<ProcessRunResult>((resolve) => {
    finish = resolve;
  });
  const run = vi.fn<typeof runProcess>(() => pending);
  const shared = shareDeviceHelperBuilds(run);
  const first = shared("/bin/sh", ["/helper/build.sh", "/cache/xcode-source"]);
  const second = shared("/bin/sh", ["/helper/build.sh", "/cache/xcode-source"]);
  expect(run).toHaveBeenCalledTimes(1);
  void shared("xcrun", ["simctl", "boot", "first"]);
  void shared("xcrun", ["simctl", "boot", "second"]);
  expect(run).toHaveBeenCalledTimes(3);
  finish({ code: 1, stdout: "", stderr: "build failed", signal: null, timedOut: false });
  await Promise.all([first, second]);
  await shared("/bin/sh", ["/helper/build.sh", "/cache/xcode-source"]);
  expect(run).toHaveBeenCalledTimes(4);
});
