import "../../index.css";
import { Schema } from "effect";
import {
  AgentControlAutomationId,
  AgentControlAutomationRunId,
  EnvironmentId,
  ProjectId,
  ServerProvider,
  type AutomationCentreSnapshot,
} from "@ryco/contracts";
import { page } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import { AutomationCentreView, type AutomationCentreViewProps } from "./AutomationCentreView";

const projectId = ProjectId.make("project-automation-browser");
const environmentId = EnvironmentId.make("local");
const provider = Schema.decodeUnknownSync(ServerProvider)({
  instanceId: "codex",
  driver: "codex",
  displayName: "Codex",
  enabled: true,
  installed: true,
  version: "1",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-15T00:00:00.000Z",
  models: [{ slug: "test-model", name: "Test model", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
});
const at = new Date(Date.now() + 3600000).toISOString();
const definition = {
  enabled: true,
  schedule: { kind: "once" as const, runAt: at },
  execution: {
    projectId,
    title: "Check dependency updates",
    prompt: "Review dependency changes and report findings.",
    modelSelection: { instanceId: provider.instanceId, model: "test-model" },
    runtimeMode: "approval-required" as const,
    envMode: "worktree" as const,
  },
};
const automationId = AgentControlAutomationId.make("automation-browser");
const snapshot: AutomationCentreSnapshot = {
  automations: [
    {
      automationId,
      projectId,
      providerInstanceId: provider.instanceId,
      principal: {
        kind: "automation-owner",
        projectId,
        runtimeMode: "approval-required",
        envMode: "worktree",
      },
      definition,
      revision: 1,
      enabled: true,
      cancelled: false,
      cancelledAt: null,
      nextRunAt: at,
      createdAt: at,
      updatedAt: at,
    },
  ],
  runs: (["completed", "failed", "expired"] as const).map((status) => ({
    run: {
      runId: AgentControlAutomationRunId.make(`run-${status}`),
      automationId,
      automationRevision: 1,
      projectId,
      providerInstanceId: provider.instanceId,
      scheduledFor: at,
      coalescedOccurrences: 0,
      status,
      proposalId: null,
      safeFailureDetail: status === "failed" ? "Approved run failed safely." : null,
      createdAt: at,
      updatedAt: at,
      completedAt: at,
    },
    execution: definition.execution,
    threadIds: [],
    unread: true,
    retryOfRunId: null,
  })),
  proposals: [],
  unavailableRecords: 0,
  historyLimit: 50,
};
function mount(overrides: Partial<AutomationCentreViewProps> = {}) {
  const props = {
    environmentId,
    projectId,
    snapshot,
    providers: [provider],
    busy: false,
    error: null,
    disabledReason: null,
    onRefresh: vi.fn(),
    onCommand: vi.fn().mockResolvedValue(true),
    onDecision: vi.fn(),
    ...overrides,
  };
  render(
    <main className="mx-auto max-w-[580px] bg-background p-6 text-foreground">
      <AutomationCentreView {...props} />
    </main>,
  );
  return props;
}

describe("automation centre", () => {
  it("authors once and fixed interval schedules with explicit provider selection", async () => {
    await page.viewport(1280, 900);
    const props = mount();
    await page.getByRole("button", { name: "New schedule" }).click();
    await page.getByRole("textbox", { name: "Title", exact: true }).fill("Review dependencies");
    await page.getByRole("textbox", { name: "Task prompt" }).fill("Inspect the dependency report.");
    await page.getByRole("combobox", { name: "Provider instance" }).selectOptions("codex");
    await page.getByRole("combobox", { name: "Model", exact: true }).selectOptions("test-model");
    await page.screenshot({ path: "../../../../../output/automation-centre-editor.png" });
    await page.getByRole("button", { name: "Review schedule" }).click();
    expect(props.onCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "save",
        expectedRevision: null,
        definition: expect.objectContaining({
          schedule: expect.objectContaining({ kind: "once" }),
          execution: expect.objectContaining({
            modelSelection: { instanceId: "codex", model: "test-model" },
          }),
        }),
      }),
    );
    await page.getByRole("button", { name: "Edit", exact: true }).click();
    await page
      .getByRole("combobox", { name: "Schedule", exact: true })
      .selectOptions("fixed-interval");
    await page.getByRole("spinbutton", { name: "Every (minutes)" }).fill("30");
    await page.getByRole("button", { name: "Review schedule" }).click();
    expect(props.onCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({
        expectedRevision: 1,
        definition: expect.objectContaining({
          schedule: expect.objectContaining({ kind: "fixed-interval", intervalMs: 1800000 }),
        }),
      }),
    );
  });
  it("triages runs without claiming task success or retrying uncertain failures", async () => {
    await page.viewport(1280, 800);
    const props = mount({ snapshot: { ...snapshot, unavailableRecords: 1 } });
    await page.getByRole("button", { name: /Runs ·/ }).click();
    await expect.element(page.getByText("Completion policy: dispatch only.")).toBeVisible();
    await expect.element(page.getByText("Dispatched", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Failed", exact: true }).click();
    await expect.element(page.getByText("Dispatch failed", { exact: true })).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Retry with approval" }))
      .not.toBeInTheDocument();
    await page.getByRole("button", { name: "Mark read", exact: true }).click();
    expect(props.onCommand).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "read", runId: "run-failed", unread: false }),
    );
    await page.getByRole("button", { name: "All", exact: true }).click();
    await page.getByRole("button", { name: "Retry with approval" }).click();
    expect(props.onCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "retry", runId: "run-expired" }),
    );
    await page.screenshot({ path: "../../../../../output/automation-centre-runs.png" });
  });
  it("disables changes while hosted mutation authority is unavailable", async () => {
    const props = mount({ disabledReason: "Reconnecting. Wait for a current session." });
    await expect.element(page.getByRole("button", { name: "New schedule" })).toBeDisabled();
    await expect.element(page.getByRole("button", { name: "Cancel schedule…" })).toBeDisabled();
    expect(props.onCommand).not.toHaveBeenCalled();
    await page.screenshot({ path: "../../../../../output/automation-centre-schedules.png" });
  });
});
