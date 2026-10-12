import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type EnvironmentApi,
  type ServerConfig,
} from "@ryco/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../environmentApi";
import { useUsageLimitBannerItem, type UsageLimitBannerThread } from "./usageLimitBanner";

const ENVIRONMENT_ID = EnvironmentId.make("environment-usage-limit");
const CLAUDE = ProviderInstanceId.make("claudeAgent");
const SERVER_CONFIG = {
  settings: { autoResumeLimitedThreads: false },
  environment: { capabilities: { usageLimitRecovery: true, threadSnooze: true } },
} as unknown as ServerConfig;
const SNOOZE_ELIGIBILITY = { canSnooze: true };

function limitedThread(id: string): UsageLimitBannerThread {
  const now = Date.now();
  return {
    id: ThreadId.make(id),
    title: id,
    modelSelection: { instanceId: CLAUDE, model: "claude-sonnet" },
    runtimeMode: "full-access",
    interactionMode: "default",
    snoozedUntil: null,
    usageLimit: {
      limitId: `usage-limit:${id}:turn-1`,
      provider: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: CLAUDE,
      turnId: TurnId.make("turn-1"),
      message: "Claude usage limit reached.",
      limitedAt: new Date(now - 60_000).toISOString(),
      resetAt: new Date(now + 3_600_000).toISOString(),
      autoResume: null,
      updatedAt: new Date(now - 60_000).toISOString(),
    },
  };
}

function Banner(props: { readonly thread: UsageLimitBannerThread }) {
  const item = useUsageLimitBannerItem({
    thread: props.thread,
    environmentId: ENVIRONMENT_ID,
    serverConfig: SERVER_CONFIG,
    dispatchAllowed: true,
    snoozeEligibility: SNOOZE_ELIGIBILITY,
  });
  return <div data-testid="usage-limit-actions">{item?.actions}</div>;
}

function snoozeButton(): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
    (candidate) => candidate.textContent === "Snooze until reset",
  );
  if (!button) throw new Error("Snooze until reset is not offered.");
  return button;
}

describe("useUsageLimitBannerItem", () => {
  afterEach(() => {
    __resetEnvironmentApiOverridesForTests();
  });

  it("keeps a newer thread's action pending when one from before a thread switch settles", async () => {
    const settles: Array<() => void> = [];
    const dispatchCommand = vi.fn(
      () =>
        new Promise<{ sequence: number }>((resolve) => {
          settles.push(() => resolve({ sequence: 1 }));
        }),
    );
    __setEnvironmentApiOverrideForTests(ENVIRONMENT_ID, {
      orchestration: { dispatchCommand },
    } as unknown as EnvironmentApi);

    const first = limitedThread("thread-first");
    const second = limitedThread("thread-second");
    const screen = await render(<Banner thread={first} />);

    try {
      snoozeButton().click();
      await vi.waitFor(() => expect(snoozeButton().disabled).toBe(true));

      // ChatView keeps the hook across thread switches.
      await screen.rerender(<Banner thread={second} />);
      expect(snoozeButton().disabled).toBe(false);
      snoozeButton().click();
      await vi.waitFor(() => expect(dispatchCommand).toHaveBeenCalledTimes(2));
      expect(snoozeButton().disabled).toBe(true);

      // The first thread's snooze settles: the second's is still in flight.
      settles[0]?.();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(snoozeButton().disabled).toBe(true);

      settles[1]?.();
      await vi.waitFor(() => expect(snoozeButton().disabled).toBe(false));
    } finally {
      await screen.unmount();
    }
  });
});
