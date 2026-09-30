import "../../index.css";
import { AgentControlProposal, EnvironmentId, ThreadId } from "@ryco/contracts";
import { useAgentControlStore } from "@ryco/client-runtime/state/agentControl";
import { Schema } from "effect";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { AgentControlApprovals } from "./AgentControlApprovals";

const fixture = vi.hoisted(() => ({
  acceptProposal: vi.fn().mockResolvedValue(undefined),
  rejectProposal: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../environmentApi", () => ({
  readEnvironmentApi: () => ({ agentControl: fixture }),
  readEnvironmentApiForConnection: () => null,
}));
vi.mock("../../environments/runtime", () => ({
  readEnvironmentConnection: () => null,
  subscribeEnvironmentConnections: () => () => {},
}));
vi.mock("../../hostedHub/capabilities", () => ({
  useHostedRpcCapability: () => ({ allowed: true, reason: null }),
}));
vi.mock("../../store", () => ({
  useStore: () => undefined,
}));
vi.mock("../../composerDraftStore", () => import("@ryco/client-runtime/state/composer"));

const environmentId = EnvironmentId.make("external-approval-env");
afterEach(() => {
  useAgentControlStore.getState().clearEnvironment(environmentId);
  vi.clearAllMocks();
});

it("keeps external approvals actionable with no active thread and after switching chats", async () => {
  const external = Schema.decodeUnknownSync(AgentControlProposal)({
    proposalId: "external-request",
    requestId: "external-request-id",
    principal: {
      kind: "external-integration",
      integrationId: "integration",
      label: "Terminal agent",
    },
    planVersion: 1,
    plan: {
      kind: "createThreads",
      entries: [
        {
          projectId: "project",
          title: "External task",
          prompt: "Hidden external prompt",
          modelSelection: { instanceId: "codex", model: "fixture" },
          runtimeMode: "approval-required",
          envMode: "local",
        },
      ],
    },
    planDigest: "a".repeat(64),
    riskTags: [],
    promptSummary: "Create an external task",
    status: "pending-user-approval",
    createdAt: "2026-09-30T00:00:00.000Z",
    updatedAt: "2026-09-30T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    decidedAt: null,
    result: null,
  });
  useAgentControlStore.getState().applyStreamEvent(environmentId, {
    version: 1,
    type: "snapshot",
    queue: {
      revision: 0,
      active: [
        external,
        {
          ...external,
          proposalId: "unrelated-request" as never,
          principal: {
            kind: "provider-session",
            threadId: ThreadId.make("unrelated"),
            providerInstanceId: "codex" as never,
          },
          promptSummary: "Unrelated thread request",
        },
      ],
      recent: [],
    },
  });
  const view = (activeThreadId: ThreadId | null) => (
    <AgentControlApprovals environmentId={environmentId} activeThreadId={activeThreadId} />
  );
  const screen = await render(view(null));
  await expect
    .element(screen.getByRole("region", { name: "External Agent Control approval requests" }))
    .toBeVisible();
  await expect.element(screen.getByText("External integration Terminal agent")).toBeVisible();
  await expect.element(screen.getByText("Unrelated thread request")).not.toBeInTheDocument();
  await expect.element(screen.getByText("Hidden external prompt")).not.toBeInTheDocument();
  await screen.getByRole("button", { name: "Approve", exact: true }).click();
  expect(fixture.acceptProposal).toHaveBeenCalledWith({ proposalId: "external-request" });
  await screen.rerender(view(ThreadId.make("another-chat")));
  await screen.getByRole("button", { name: "Reject", exact: true }).click();
  expect(fixture.rejectProposal).toHaveBeenCalledWith({ proposalId: "external-request" });
});
