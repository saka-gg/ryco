import "../../index.css";

import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import type { SubagentStopAction } from "@ryco/client-runtime/state/session/subagentStop";
import { EnvironmentId, OrchestrationStopBackgroundTaskError, ThreadId } from "@ryco/contracts";
import { page } from "vite-plus/test/browser";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { toastManager } from "~/components/ui/toast";
import { deriveAgentPanelModel, type RuntimeSubagent } from "../../threadWorkspaceViewModel";
import { AgentRosterProvider, AgentRow, AgentRowList } from "./agentRoster";
import { makeRuntimeAgent } from "./agentRosterTestFixtures";
import { AgentStopButton, makeAgentStopDecorator } from "./AgentStopButton";
import { STOP_UNCONFIRMED_MS } from "./agentStop.logic";

const THREAD_REF = scopeThreadRef(
  EnvironmentId.make("env_stop_button_test"),
  ThreadId.make("thread-stop"),
);

function stopAction(overrides: Partial<SubagentStopAction> = {}): SubagentStopAction {
  return {
    threadRef: THREAD_REF,
    runtimeSessionId: "rt-1",
    unavailableReason: null,
    stop: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

const live = makeRuntimeAgent("live", { runtimeSessionId: "rt-1", canStop: true });

function Roster({
  agents,
  action,
  onOpenAgent = null,
}: {
  agents: ReadonlyArray<RuntimeSubagent>;
  action: SubagentStopAction | null;
  onOpenAgent?: ((agentId: string) => void) | null;
}) {
  return (
    <AgentRosterProvider
      model={deriveAgentPanelModel({ agents })}
      onOpenAgent={onOpenAgent}
      decorateRow={makeAgentStopDecorator(action)}
    >
      <AgentRowList>
        {agents.map((agent) => (
          <AgentRow key={agent.id} agent={agent} />
        ))}
      </AgentRowList>
    </AgentRosterProvider>
  );
}

function stopButtons(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>("button[aria-label^='Stop']")];
}

describe("AgentStopButton", () => {
  let mounted: Awaited<ReturnType<typeof render>> | null = null;

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await mounted?.unmount().catch(() => {});
    mounted = null;
    document.body.innerHTML = "";
  });

  it("reveals Stop beside a stoppable row and stops it without opening the agent", async () => {
    const action = stopAction();
    const onOpenAgent = vi.fn();
    mounted = await render(
      <Roster
        agents={[
          live,
          makeRuntimeAgent("done", {
            status: "completed",
            runtimeSessionId: "rt-1",
            canStop: true,
            completedAt: "2026-08-10T10:01:00.000Z",
          }),
          makeRuntimeAgent("earlier-runtime", { runtimeSessionId: "rt-0", canStop: true }),
          makeRuntimeAgent("not-flagged", { runtimeSessionId: "rt-1" }),
        ]}
        action={action}
        onOpenAgent={onOpenAgent}
      />,
    );

    expect(stopButtons()).toHaveLength(1);
    expect(document.querySelectorAll("[data-agent-row]")).toHaveLength(4);
    // Stop takes the place of the row's time only while the row is hovered.
    const slotOpacity = () => getComputedStyle(stopButtons()[0]!.parentElement!).opacity;
    const asideOpacity = () =>
      getComputedStyle(document.querySelector("[data-agent-row-aside]")!).opacity;
    expect(slotOpacity()).toBe("0");
    await page.getByRole("button", { name: "Open Task for live transcript. Running." }).hover();
    await vi.waitFor(() => {
      expect(slotOpacity()).toBe("1");
      expect(asideOpacity()).toBe("0");
    });

    await page.getByRole("button", { name: "Stop Task for live" }).click();
    expect(action.stop).toHaveBeenCalledExactlyOnceWith({
      taskId: "live",
      runtimeSessionId: "rt-1",
      attempt: 0,
    });
    expect(onOpenAgent).not.toHaveBeenCalled();
    await expect.element(page.getByRole("button", { name: /^Stopping / })).toBeDisabled();
  });

  it("reports a failed stop on its thread and offers Stop again", async () => {
    const add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    const action = stopAction({
      stop: vi.fn(() =>
        Promise.reject(
          new OrchestrationStopBackgroundTaskError({
            reason: "stop-failed",
            threadId: "thread-stop",
            taskId: "live",
          }),
        ),
      ),
    });
    mounted = await render(<Roster agents={[live]} action={action} />);

    stopButtons()[0]?.click();

    await vi.waitFor(() =>
      expect(add).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "error",
          title: "Could not stop agent",
          description: "The agent did not stop. Try again.",
          data: expect.objectContaining({ threadRef: THREAD_REF }),
        }),
      ),
    );
    await expect.element(page.getByRole("button", { name: /^Stop / })).toBeEnabled();
  });

  it("offers Stop again when the stop is not confirmed in time", async () => {
    vi.useFakeTimers();
    const add = vi.spyOn(toastManager, "add").mockReturnValue("toast");
    const action = stopAction();
    mounted = await render(<Roster agents={[live]} action={action} />);

    stopButtons()[0]?.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(stopButtons()[0]?.disabled).toBe(true);
    expect(add).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(STOP_UNCONFIRMED_MS);
    expect(add).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "warning",
        title: "Stop not confirmed",
        data: expect.objectContaining({ threadRef: THREAD_REF }),
      }),
    );
    expect(stopButtons()[0]?.disabled).toBe(false);
    expect(action.stop).toHaveBeenCalledOnce();
  });

  it("disables Stop with the reason while it can't be used", async () => {
    const action = stopAction({ unavailableReason: "Not connected to this environment." });
    mounted = await render(<Roster agents={[live]} action={action} />);

    const [button] = stopButtons();
    expect(button?.disabled).toBe(true);
    expect(button?.title).toBe("Not connected to this environment.");
    button?.click();
    expect(action.stop).not.toHaveBeenCalled();
  });

  it("leaves rows as they are without a stop action", async () => {
    mounted = await render(<Roster agents={[live]} action={null} />);

    expect(stopButtons()).toHaveLength(0);
    expect(document.querySelector("[data-agent-row]")?.parentElement?.className).toContain(
      "divide-y",
    );
  });

  it("labels Stop in a header and renders nothing for an agent it can't stop", async () => {
    const action = stopAction();
    const settled = makeRuntimeAgent("settled", {
      status: "interrupted",
      runtimeSessionId: "rt-1",
      canStop: true,
    });
    mounted = await render(
      <AgentRosterProvider model={deriveAgentPanelModel({ agents: [live, settled] })}>
        <AgentStopButton agent={live} action={action} variant="labeled" />
        <AgentStopButton agent={settled} action={action} variant="labeled" />
      </AgentRosterProvider>,
    );

    expect(stopButtons()).toHaveLength(1);
    await page.getByRole("button", { name: /^Stop / }).click();
    await expect
      .element(page.getByRole("button", { name: /^Stopping / }))
      .toHaveTextContent("Stopping…");
  });
});
