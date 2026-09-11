import { describe, expect, it } from "vite-plus/test";
import { captureShellEnvironment } from "./captureShellEnvironment.ts";

const worker = (source: string) => new URL(`data:text/javascript,${encodeURIComponent(source)}`);

describe("captureShellEnvironment", () => {
  it("returns a captured environment without changing the caller's environment", async () => {
    const env = { PATH: "/original" };
    const result = await captureShellEnvironment({
      env,
      workerPath: worker(`
        import { parentPort, workerData } from 'node:worker_threads';
        workerData.env.PATH = '/captured';
        parentPort.postMessage({ environment: workerData.env, warnings: [] });
      `),
    });
    expect(result).toEqual({ environment: { PATH: "/captured" }, warnings: [] });
    expect(env.PATH).toBe("/original");
  });

  it("keeps timers responsive and releases startup when shell discovery blocks", async () => {
    let responsive = false;
    const timer = setTimeout(() => {
      responsive = true;
    }, 10);
    try {
      const result = await captureShellEnvironment({
        env: {},
        workerPath: worker("Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);"),
        timeoutMs: 100,
      });
      expect(result).toBeNull();
      expect(responsive).toBe(true);
    } finally {
      clearTimeout(timer);
    }
  });

  it("abandons startup work on quit and tolerates a failed worker", async () => {
    const controller = new AbortController();
    const result = captureShellEnvironment({
      env: {},
      workerPath: worker("Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);"),
      signal: controller.signal,
    });
    controller.abort();
    await expect(result).resolves.toBeNull();
    await expect(
      captureShellEnvironment({
        env: {},
        workerPath: worker("throw new Error('broken profile');"),
      }),
    ).resolves.toBeNull();
  });
});
