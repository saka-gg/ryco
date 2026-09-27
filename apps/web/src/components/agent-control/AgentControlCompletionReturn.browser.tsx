import "../../index.css";
import { AgentControlProposal, EnvironmentId } from "@ryco/contracts";
import {
  applyAgentControlStreamEvent,
  EMPTY_AGENT_CONTROL_QUEUE_STATE,
  buildAgentControlProposalCardModel,
} from "@ryco/client-runtime/state/agentControl";
import { Schema } from "effect";
import { expect, it } from "vite-plus/test";
import { render } from "vitest-browser-react";
import { AgentControlProposalCard } from "./AgentControlProposalCard";

it("shows separate completion return status and actionable child/origin links without approval actions", async () => {
  const proposal = Schema.decodeUnknownSync(AgentControlProposal)({
    proposalId: "proposal",
    requestId: "request",
    principal: { kind: "provider-session", threadId: "parent", providerInstanceId: "codex" },
    planVersion: 1,
    plan: {
      kind: "createThreads",
      entries: [
        {
          projectId: "project",
          title: "Fixture task",
          prompt: "Fixture prompt",
          runtimeMode: "approval-required",
          envMode: "local",
          modelSelection: { instanceId: "codex", model: "fixture" },
          returnToOrigin: true,
        },
      ],
    },
    planDigest: "a".repeat(64),
    riskTags: [],
    promptSummary: "Create a delegated task",
    status: "completed",
    createdAt: "2026-09-27T00:00:00.000Z",
    updatedAt: "2026-09-27T00:00:00.000Z",
    expiresAt: "2026-09-28T00:00:00.000Z",
    decidedAt: null,
    result: null,
    completionReturns: [
      {
        childThreadId: "child",
        initialMessageId: "initial",
        parentThreadId: "parent",
        parentTurnId: "origin-turn",
        childTurnId: "child-turn",
        revision: 2,
        status: "uncertain",
        detail: "Check the parent before sending manually; automatic retry could duplicate it.",
        updatedAt: "2026-09-27T00:00:00.000Z",
      },
    ],
  });
  let state = applyAgentControlStreamEvent(EMPTY_AGENT_CONTROL_QUEUE_STATE, {
    version: 1,
    type: "snapshot",
    queue: {
      revision: 0,
      active: [
        {
          ...proposal,
          completionReturns: [
            {
              ...proposal.completionReturns![0]!,
              revision: 1,
              status: "waiting",
              detail: "Waiting for the initial run.",
            },
          ],
        },
      ],
      recent: [],
    },
  });
  const card = () => (
    <AgentControlProposalCard
      model={buildAgentControlProposalCardModel(state.proposalsById[proposal.proposalId]!)}
      environmentId={EnvironmentId.make("fixture-env")}
      isSubmitting={false}
      decisionError={null}
      disabledReason={null}
      onAccept={() => {
        throw new Error("must not approve");
      }}
      onReject={() => {}}
    />
  );
  const screen = await render(card());
  await expect.element(screen.getByText("Completion return · waiting")).toBeVisible();
  state = applyAgentControlStreamEvent(state, {
    version: 1,
    type: "proposal",
    revision: 1,
    proposal,
  });
  await screen.rerender(card());
  await expect.element(screen.getByText("Completion return · uncertain")).toBeVisible();
  await expect.element(screen.getByText(/Check the parent before sending manually/)).toBeVisible();
  await expect
    .element(screen.getByRole("link", { name: "Open child task" }))
    .toHaveAttribute("href", "/fixture-env/child");
  await expect
    .element(screen.getByRole("link", { name: "Open originating chat" }))
    .toHaveAttribute("href", "/fixture-env/parent");
  await expect.element(screen.getByRole("button", { name: "Approve" })).not.toBeInTheDocument();
});
