import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId, type ServerLifecycleWelcomePayload } from "@ryco/contracts";

import {
  expectsPrimaryShellPaint,
  resolveCanonicalPrimaryEnvironmentId,
  shouldApplyBootstrapThreadRedirect,
  warmBootstrapThread,
} from "./RootAppShell.logic";

const HUB_ENVIRONMENT_ID = EnvironmentId.make("env_aaaaaaaaaaaaaaaaaaaaaa");
const SERVER_ENVIRONMENT_ID = EnvironmentId.make("server-environment-id");

describe("shouldApplyBootstrapThreadRedirect", () => {
  it("keeps hosted home in place while discovering device thread lists", () => {
    expect(
      shouldApplyBootstrapThreadRedirect({ pathname: "/", tier: "desktop", hostedHome: true }),
    ).toBe(false);
  });
  it("keeps the desktop last-thread redirect at the logical root", () => {
    expect(shouldApplyBootstrapThreadRedirect({ pathname: "/", tier: "desktop" })).toBe(true);
  });

  it("never redirects away from a non-root route", () => {
    expect(shouldApplyBootstrapThreadRedirect({ pathname: "/env_a/t_1", tier: "desktop" })).toBe(
      false,
    );
    expect(shouldApplyBootstrapThreadRedirect({ pathname: "/env_a/t_1", tier: "phone" })).toBe(
      false,
    );
  });

  it("keeps the phone tier on Home instead of the last thread", () => {
    expect(shouldApplyBootstrapThreadRedirect({ pathname: "/", tier: "phone" })).toBe(false);
  });
});

describe("resolveCanonicalPrimaryEnvironmentId", () => {
  it("uses the server-reported identity for a direct connection", () => {
    expect(
      resolveCanonicalPrimaryEnvironmentId({
        hosted: false,
        primaryEnvironmentId: HUB_ENVIRONMENT_ID,
        serverEnvironmentId: SERVER_ENVIRONMENT_ID,
      }),
    ).toBe(SERVER_ENVIRONMENT_ID);
  });

  it("keeps the Hub identity canonical when the hosted server reports a different identity", () => {
    expect(
      resolveCanonicalPrimaryEnvironmentId({
        hosted: true,
        primaryEnvironmentId: HUB_ENVIRONMENT_ID,
        serverEnvironmentId: SERVER_ENVIRONMENT_ID,
      }),
    ).toBe(HUB_ENVIRONMENT_ID);
  });

  it("does not fall back to the server identity before hosted lifecycle ownership is published", () => {
    expect(
      resolveCanonicalPrimaryEnvironmentId({
        hosted: true,
        primaryEnvironmentId: null,
        serverEnvironmentId: SERVER_ENVIRONMENT_ID,
      }),
    ).toBeNull();
  });
});

describe("warmBootstrapThread", () => {
  const environmentId = EnvironmentId.make("environment-local");
  const welcome = (bootstrapThreadId?: string): ServerLifecycleWelcomePayload => ({
    environment: {
      environmentId,
      label: "Local",
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "0.0.0-test",
      capabilities: {
        repositoryIdentity: true,
        threadSettlement: false,
        threadPriorityRanking: false,
      },
    },
    cwd: "/tmp/workspace",
    projectName: "ryco",
    ...(bootstrapThreadId ? { bootstrapThreadId: ThreadId.make(bootstrapThreadId) } : {}),
  });

  function setup(input: { readonly pathname: string; readonly tier: "desktop" | "phone" }) {
    let finishShell!: () => void;
    const order: string[] = [];
    const deps = {
      ...input,
      preloadShell: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishShell = () => {
              order.push("shell");
              resolve();
            };
          }),
      ),
      preloadThreadRoute: vi.fn(() => order.push("thread-route")),
      prewarmThreadDetail: vi.fn(() => order.push("thread-detail")),
    };
    return { deps, order, finishShell: () => finishShell() };
  }

  it("loads the thread route after the shell graph and opens its detail stream now", async () => {
    const { deps, order, finishShell } = setup({ pathname: "/", tier: "desktop" });

    expect(warmBootstrapThread(welcome("thread-1"), deps)).toBe(true);
    expect(deps.prewarmThreadDetail).toHaveBeenCalledWith(environmentId, "thread-1");
    expect(deps.preloadThreadRoute).not.toHaveBeenCalled();

    finishShell();
    await vi.waitFor(() => expect(deps.preloadThreadRoute).toHaveBeenCalledOnce());
    expect(order).toEqual(["thread-detail", "shell", "thread-route"]);
  });

  it("leaves a deep link, the phone tier and a welcome without a thread alone", () => {
    for (const [pathname, tier, threadId] of [
      ["/env_a/t_1", "desktop", "thread-1"],
      ["/", "phone", "thread-1"],
      ["/", "desktop", undefined],
    ] as const) {
      const { deps } = setup({ pathname, tier });
      expect(warmBootstrapThread(welcome(threadId), deps)).toBe(false);
      expect(deps.preloadShell).not.toHaveBeenCalled();
      expect(deps.prewarmThreadDetail).not.toHaveBeenCalled();
    }
  });
});

describe("expectsPrimaryShellPaint", () => {
  it("expects a shell for a standard session and a hosted session on a routed node", () => {
    expect(expectsPrimaryShellPaint({ status: "authenticated", routedHostedNodeId: null })).toBe(
      true,
    );
    expect(expectsPrimaryShellPaint({ status: "hosted-hub", routedHostedNodeId: "node_1" })).toBe(
      true,
    );
  });

  it("expects none for hosted-static and a hosted session without a node", () => {
    expect(expectsPrimaryShellPaint({ status: "hosted-hub", routedHostedNodeId: null })).toBe(
      false,
    );
    expect(expectsPrimaryShellPaint({ status: "hosted-static", routedHostedNodeId: null })).toBe(
      false,
    );
  });
});
