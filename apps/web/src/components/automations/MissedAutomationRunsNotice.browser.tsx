import "../../index.css";
import { EnvironmentId, type AgentControlProposal, type EnvironmentApi } from "@ryco/contracts";
import { useAgentControlStore } from "@ryco/client-runtime/state/agentControl";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useParams: () => ({}),
}));
/* One connected device. Its queue is seeded below; no real connection opens. */
vi.mock("./data/useConnectedEnvironmentIds", () => {
  const connected = ["env-missed"];
  return { useConnectedEnvironmentIds: () => connected };
});

import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../environmentApi";
import { ToastProvider } from "../ui/toast";
import {
  MissedAutomationRunsNotice,
  resetNoticedMissedRunsForTests,
} from "./MissedAutomationRunsNotice";

const ENV = EnvironmentId.make("env-missed");
const HOUR_MS = 60 * 60_000;

/** A run due three hours ago that the device's scheduler proposed a minute ago. */
function catchUpRun(): AgentControlProposal {
  const now = Date.now();
  return {
    proposalId: "proposal-missed",
    status: "pending-user-approval",
    createdAt: new Date(now - 60_000).toISOString(),
    updatedAt: new Date(now - 60_000).toISOString(),
    plan: {
      kind: "automationRun",
      automationId: "automation-missed",
      runId: "run-missed",
      scheduledFor: new Date(now - 3 * HOUR_MS).toISOString(),
      coalescedOccurrences: 0,
      execution: { projectId: "project-missed", title: "Nightly triage" },
    },
  } as unknown as AgentControlProposal;
}

afterEach(() => {
  useAgentControlStore.getState().clearEnvironment(ENV);
  resetNoticedMissedRunsForTests();
  __resetEnvironmentApiOverridesForTests();
  document.body.innerHTML = "";
});

describe("MissedAutomationRunsNotice", () => {
  it("tells a waiting catch-up run once its words load, and runs it from the notice", async () => {
    // The frozen phone tier shows no notice.
    await page.viewport(1_280, 720);
    const acceptProposal = vi.fn(async (_input: { readonly proposalId: string }) => undefined);
    __setEnvironmentApiOverrideForTests(ENV, {
      agentControl: { acceptProposal },
    } as unknown as EnvironmentApi);
    const screen = await render(
      <ToastProvider>
        <MissedAutomationRunsNotice />
      </ToastProvider>,
    );
    // The device's queue arrives after the shell mounted, as it does at launch.
    useAgentControlStore.getState().applyStreamEvent(ENV, {
      version: 1,
      type: "snapshot",
      queue: { revision: 1, active: [catchUpRun()], recent: [] },
    });

    await expect.element(page.getByText("Missed run · Nightly triage")).toBeVisible();
    await expect
      .element(page.getByText(/^Due .* while Ryco was offline\. Run it now\?$/u))
      .toBeVisible();
    await page.getByRole("button", { name: "Run now", exact: true }).click();
    await vi.waitFor(() =>
      expect(acceptProposal).toHaveBeenCalledExactlyOnceWith({ proposalId: "proposal-missed" }),
    );
    await expect.element(page.getByText("Missed run · Nightly triage")).not.toBeInTheDocument();
    await screen.unmount();
  });

  it("takes the notice back when the run is answered elsewhere", async () => {
    await page.viewport(1_280, 720);
    const run = catchUpRun();
    const screen = await render(
      <ToastProvider>
        <MissedAutomationRunsNotice />
      </ToastProvider>,
    );
    useAgentControlStore.getState().applyStreamEvent(ENV, {
      version: 1,
      type: "snapshot",
      queue: { revision: 1, active: [run], recent: [] },
    });
    await expect.element(page.getByText("Missed run · Nightly triage")).toBeVisible();

    useAgentControlStore.getState().applyStreamEvent(ENV, {
      version: 1,
      type: "proposal",
      revision: 2,
      proposal: { ...run, status: "approved" } as AgentControlProposal,
    });
    await expect.element(page.getByText("Missed run · Nightly triage")).not.toBeInTheDocument();
    await screen.unmount();
  });
});
