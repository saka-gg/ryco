import "../../index.css";
import {
  AGENT_CONTROL_WS_METHODS,
  AgentControlProposal,
  EnvironmentId,
  ThreadId,
} from "@ryco/contracts";
import { useAgentControlStore } from "@ryco/client-runtime/state/agentControl";
import { Schema } from "effect";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { AgentControlApprovals } from "./AgentControlApprovals";

const fixture = vi.hoisted(() => ({
  acceptProposal: vi.fn().mockResolvedValue(undefined),
  rejectProposal: vi.fn().mockResolvedValue(undefined),
  capability: vi.fn((_method: string, _environmentId?: string | null) => ({
    allowed: true,
    reason: null,
  })),
}));
vi.mock("../../environmentApi", () => ({
  readEnvironmentApi: () => ({ agentControl: fixture }),
  readEnvironmentApiForConnection: () => null,
}));
vi.mock("../../environments/runtime", () => ({
  readEnvironmentConnection: () => null,
  subscribeEnvironmentConnections: () => () => {},
  useSavedEnvironmentRuntimeStore: (selector: (state: { byId: object }) => unknown) =>
    selector({ byId: {} }),
}));
vi.mock("../../hostedHub/capabilities", () => ({ useHostedRpcCapability: fixture.capability }));
// Node labels come from the hosted directory; the decisions only need the copy rule.
vi.mock("../../hostedHub/state", () => ({
  useHostedHubStore: (selector: (state: object) => unknown) =>
    selector({ nodes: [], selectedNode: null }),
}));
vi.mock("../../hostedHub/switchTarget", () => ({
  hostedCapabilityCopy: (capability: { readonly reason: string | null }) => capability.reason,
  hostedSwitchTargetLabel: () => null,
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

it("keeps external approvals actionable and other threads' requests out of the block", async () => {
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
  const view = () => <AgentControlApprovals environmentId={environmentId} />;
  const screen = await render(view());
  // The decision is gated by the role on the environment the proposal belongs to.
  expect(fixture.capability).toHaveBeenCalledWith(
    AGENT_CONTROL_WS_METHODS.acceptProposal,
    environmentId,
  );
  await expect
    .element(screen.getByRole("region", { name: "External Agent Control approval requests" }))
    .toBeVisible();
  await expect
    .element(screen.getByText("External integration Terminal agent", { exact: false }))
    .toBeVisible();
  await expect.element(screen.getByText("Unrelated thread request")).not.toBeInTheDocument();
  await expect.element(screen.getByText("Hidden external prompt")).not.toBeInTheDocument();
  await screen.getByRole("button", { name: "Approve", exact: true }).click();
  expect(fixture.acceptProposal).toHaveBeenCalledWith({ proposalId: "external-request" });
  await screen.rerender(view());
  await screen.getByRole("button", { name: "Reject", exact: true }).click();
  expect(fixture.rejectProposal).toHaveBeenCalledWith({ proposalId: "external-request" });
});
