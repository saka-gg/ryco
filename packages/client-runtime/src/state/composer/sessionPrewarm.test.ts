import type {
  AgentTokenMode,
  EnvironmentApi,
  ModelSelection,
  ProjectId,
  ProviderSessionPrewarmInput,
  ServerConfig,
  ThreadId,
} from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  requestProviderSessionPrewarm,
  resolveProviderSessionPrewarmRequest,
  selectProviderSessionPrewarmSupported,
  SESSION_PREWARM_MIN_INTERVAL_MS,
  SESSION_PREWARM_REPEAT_MS,
  type ProviderSessionPrewarmContext,
} from "./sessionPrewarm.ts";

const threadId = "thread-1" as ThreadId;

function makeApi() {
  const prewarmProviderSession = vi.fn<
    (input: ProviderSessionPrewarmInput) => Promise<{ status: "started" }>
  >(() => Promise.resolve({ status: "started" as const }));
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

describe("resolveProviderSessionPrewarmRequest", () => {
  const projectId = "project-1" as ProjectId;
  const modelSelection = { instanceId: "claude-1", model: "claude-opus" } as ModelSelection;
  const context = (
    overrides: Partial<ProviderSessionPrewarmContext> = {},
  ): ProviderSessionPrewarmContext => ({
    thread: { id: threadId, projectId, session: null },
    isServerThread: true,
    dispatchAllowed: true,
    modelSelection,
    runtimeMode: "full-access",
    tokenMode: "default" as AgentTokenMode,
    ...overrides,
  });

  it("asks for the session a server thread's next send would start", () => {
    expect(resolveProviderSessionPrewarmRequest(context())).toEqual({
      threadId,
      modelSelection,
      runtimeMode: "full-access",
      tokenMode: "default",
    });
  });

  it("names the project for a draft and leaves out a missing model", () => {
    expect(
      resolveProviderSessionPrewarmRequest(
        context({ isServerThread: false, modelSelection: undefined }),
      ),
    ).toEqual({ threadId, projectId, runtimeMode: "full-access", tokenMode: "default" });
  });

  it("prewarms a stopped session but never a live one", () => {
    expect(
      resolveProviderSessionPrewarmRequest(
        context({
          thread: { id: threadId, projectId, session: { orchestrationStatus: "stopped" } },
        }),
      ),
    ).not.toBeNull();
    // Anything but stopped counts as live, interrupted and errored sessions included.
    for (const orchestrationStatus of [
      "ready",
      "running",
      "starting",
      "idle",
      "interrupted",
      "error",
    ] as const) {
      expect(
        resolveProviderSessionPrewarmRequest(
          context({ thread: { id: threadId, projectId, session: { orchestrationStatus } } }),
        ),
      ).toBeNull();
    }
  });

  it("skips when there is no thread or sending is not allowed now", () => {
    expect(resolveProviderSessionPrewarmRequest(context({ thread: null }))).toBeNull();
    expect(resolveProviderSessionPrewarmRequest(context({ dispatchAllowed: false }))).toBeNull();
    expect(resolveProviderSessionPrewarmRequest(context({ hostedTargetPending: true }))).toBeNull();
    expect(
      resolveProviderSessionPrewarmRequest(
        context({ isPendingChat: false, hostedTargetPending: false }),
      ),
    ).not.toBeNull();
  });

  it("skips sends that first create the directory they run in", () => {
    expect(resolveProviderSessionPrewarmRequest(context({ isPendingChat: true }))).toBeNull();
    expect(
      resolveProviderSessionPrewarmRequest(
        context({
          worktreePlan: {
            shouldCreateWorktree: true,
            shouldMaterializeLegacyBranchWorktree: false,
          },
        }),
      ),
    ).toBeNull();
    expect(
      resolveProviderSessionPrewarmRequest(
        context({
          worktreePlan: {
            shouldCreateWorktree: false,
            shouldMaterializeLegacyBranchWorktree: true,
          },
        }),
      ),
    ).toBeNull();
    expect(
      resolveProviderSessionPrewarmRequest(
        context({
          worktreePlan: {
            shouldCreateWorktree: false,
            shouldMaterializeLegacyBranchWorktree: false,
          },
        }),
      ),
    ).not.toBeNull();
  });
});

describe("selectProviderSessionPrewarmSupported", () => {
  it("is true only when the node advertises the capability", () => {
    const withCapability = (providerSessionPrewarm: boolean | undefined) =>
      ({ environment: { capabilities: { providerSessionPrewarm } } }) as unknown as ServerConfig;
    expect(selectProviderSessionPrewarmSupported(null)).toBe(false);
    expect(selectProviderSessionPrewarmSupported(withCapability(undefined))).toBe(false);
    expect(selectProviderSessionPrewarmSupported(withCapability(false))).toBe(false);
    expect(selectProviderSessionPrewarmSupported(withCapability(true))).toBe(true);
  });
});
