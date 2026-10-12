import type { EnvironmentApi, ProviderSessionPrewarmInput, ThreadId } from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  requestProviderSessionPrewarm,
  SESSION_PREWARM_MIN_INTERVAL_MS,
  SESSION_PREWARM_REPEAT_MS,
} from "./sessionPrewarm.ts";

const threadId = "thread-1" as ThreadId;

function makeApi() {
  const prewarmProviderSession = vi.fn((_: ProviderSessionPrewarmInput) =>
    Promise.resolve({ status: "started" as const }),
  );
  return {
    api: { server: { prewarmProviderSession } } as unknown as EnvironmentApi,
    prewarmProviderSession,
  };
}

describe("requestProviderSessionPrewarm", () => {
  it("sends nothing unless the node advertises it and the transport has the method", () => {
    const { api, prewarmProviderSession } = makeApi();
    expect(requestProviderSessionPrewarm({ api, supported: false, request: { threadId } })).toBe(
      false,
    );
    expect(
      requestProviderSessionPrewarm({
        api: { server: {} } as unknown as EnvironmentApi,
        supported: true,
        request: { threadId },
      }),
    ).toBe(false);
    expect(
      requestProviderSessionPrewarm({ api: undefined, supported: true, request: { threadId } }),
    ).toBe(false);
    expect(prewarmProviderSession).not.toHaveBeenCalled();
  });

  it("throttles repeats per thread and lets a changed request through after the short interval", () => {
    const { api, prewarmProviderSession } = makeApi();
    const send = (nowMs: number, model = "gpt-5") =>
      requestProviderSessionPrewarm({
        api,
        supported: true,
        nowMs,
        request: { threadId, modelSelection: { instanceId: "codex", model } as never },
      });
    expect(send(1_000)).toBe(true);
    expect(send(2_000)).toBe(false);
    expect(send(1_000 + SESSION_PREWARM_MIN_INTERVAL_MS, "gpt-5-mini")).toBe(true);
    expect(send(1_000 + SESSION_PREWARM_MIN_INTERVAL_MS * 2, "gpt-5-mini")).toBe(false);
    expect(
      send(1_000 + SESSION_PREWARM_MIN_INTERVAL_MS + SESSION_PREWARM_REPEAT_MS, "gpt-5-mini"),
    ).toBe(true);
    // Other threads are independent.
    expect(
      requestProviderSessionPrewarm({
        api,
        supported: true,
        nowMs: 2_000,
        request: { threadId: "thread-2" as ThreadId },
      }),
    ).toBe(true);
    expect(prewarmProviderSession).toHaveBeenCalledTimes(4);
  });

  it("swallows a failed request", async () => {
    const prewarmProviderSession = vi.fn(() => Promise.reject(new Error("offline")));
    const api = { server: { prewarmProviderSession } } as unknown as EnvironmentApi;
    expect(requestProviderSessionPrewarm({ api, supported: true, request: { threadId } })).toBe(
      true,
    );
    await Promise.resolve();
  });
});
