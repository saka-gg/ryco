import "../../index.css";
import { AgentControlProposal, EnvironmentId, MessageId, ThreadId, TurnId } from "@ryco/contracts";
import {
  applyAgentControlStreamEvent,
  EMPTY_AGENT_CONTROL_QUEUE_STATE,
  selectAgentControlThreadActivity,
} from "@ryco/client-runtime/state/agentControl";
import { Schema } from "effect";
import { expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";

import { AgentControlThreadActivity } from "./AgentControlThreadActivity";

const parent = ThreadId.make("parent-uuid");
const child = ThreadId.make("child-uuid");
const environmentId = EnvironmentId.make("fixture-env");
const titles: Record<string, string> = { [parent]: "Coordinator", [child]: "Fix the flaky test" };
const getThreadTitle = (id: ThreadId) => titles[id];

function proposal(index: number, status = "approved") {
  return Schema.decodeUnknownSync(AgentControlProposal)({
    proposalId: `proposal-${index}`,
    requestId: `request-${index}`,
    principal: { kind: "provider-session", threadId: parent, providerInstanceId: "codex" },
    planVersion: 1,
    plan: {
      kind: "sendMessage",
      threadId: child,
      text: "Hidden message prompt",
      delivery: "queue",
    },
    planDigest: "a".repeat(64),
    riskTags: ["starts-turn"],
    promptSummary: `Message ${index}`,
    status,
    createdAt: "2026-09-30T00:00:00.000Z",
    updatedAt: `2026-09-30T00:00:${String(index).padStart(2, "0")}.000Z`,
    expiresAt: "2099-01-01T00:00:00.000Z",
    decidedAt: null,
    result: null,
  });
}

function queue(proposals: AgentControlProposal[]) {
  return applyAgentControlStreamEvent(EMPTY_AGENT_CONTROL_QUEUE_STATE, {
    version: 1,
    type: "snapshot",
    queue: { revision: 0, active: proposals, recent: [] },
  });
}

it("keeps a busy managing thread compact and bounds expanded activity", async () => {
  const state = queue(Array.from({ length: 40 }, (_, index) => proposal(index)));
  const screen = await render(
    <AgentControlThreadActivity
      environmentId={environmentId}
      selection={selectAgentControlThreadActivity(state, parent)}
      getThreadTitle={getThreadTitle}
      submittingIds={[]}
      decisionErrorsById={{}}
      disabledReason={null}
      onDecide={() => {}}
    />,
  );
  const toggle = screen.getByRole("button", { name: "Agent Control activity · 40 actions" });
  await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
  await expect.element(screen.getByText(/Queue message · Fix the flaky test/)).toBeVisible();
  await expect.element(screen.getByTestId("agent-control-proposal-card")).not.toBeInTheDocument();
  expect(
    screen.getByTestId("agent-control-approvals").element().getBoundingClientRect().height,
  ).toBeLessThan(50);
  await toggle.click();
  await expect.element(toggle).toHaveAttribute("aria-expanded", "true");
  const details = screen.getByTestId("agent-control-activity-details").element();
  expect(details.scrollHeight).toBeGreaterThan(details.clientHeight);
  expect(details.clientHeight).toBeLessThanOrEqual(288);
  await expect.element(screen.getByText("Hidden message prompt")).not.toBeInTheDocument();
  await toggle.click();
  await expect
    .element(screen.getByTestId("agent-control-activity-details"))
    .not.toBeInTheDocument();
});

it("shows only a named manager notice in a managed thread and nothing in unrelated threads", async () => {
  const state = queue([proposal(1)]);
  const view = (threadId: ThreadId | null) => (
    <AgentControlThreadActivity
      key={threadId}
      environmentId={environmentId}
      selection={selectAgentControlThreadActivity(state, threadId)}
      getThreadTitle={getThreadTitle}
      submittingIds={[]}
      decisionErrorsById={{}}
      disabledReason={null}
      onDecide={() => {}}
    />
  );
  const screen = await render(view(child));
  await expect.element(screen.getByText("Managed by")).toBeVisible();
  await expect
    .element(screen.getByRole("link", { name: "Coordinator" }))
    .toHaveAttribute("href", "/fixture-env/parent-uuid");
  await expect.element(screen.getByTestId("agent-control-proposal-card")).not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("button", { name: /Agent Control activity/ }))
    .not.toBeInTheDocument();
  await screen.rerender(view(ThreadId.make("unrelated")));
  await expect.element(screen.getByTestId("agent-control-approvals")).not.toBeInTheDocument();
  await screen.rerender(view(parent));
  await screen.getByRole("button", { name: /Agent Control activity/ }).click();
  await expect.element(screen.getByTestId("agent-control-proposal-card")).toBeVisible();
  await screen.rerender(view(child));
  await screen.rerender(view(parent));
  await expect
    .element(screen.getByRole("button", { name: /Agent Control activity/ }))
    .toHaveAttribute("aria-expanded", "false");
});

it("keeps approvals actionable and flags failed activity while its details are collapsed", async () => {
  const state = queue([proposal(1, "pending-user-approval"), proposal(2, "failed")]);
  const onDecide = vi.fn();
  const screen = await render(
    <AgentControlThreadActivity
      environmentId={environmentId}
      selection={selectAgentControlThreadActivity(state, parent)}
      getThreadTitle={getThreadTitle}
      submittingIds={[]}
      decisionErrorsById={{}}
      disabledReason={null}
      onDecide={onDecide}
    />,
  );
  await expect.element(screen.getByText("1 needs attention")).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
  await screen.getByRole("button", { name: "Approve", exact: true }).click();
  expect(onDecide).toHaveBeenCalledWith("proposal-1", "accept");
  await screen.getByRole("button", { name: "Reject", exact: true }).click();
  expect(onDecide).toHaveBeenCalledWith("proposal-1", "reject");
});

it("keeps pending child results and uncertain delivery visible in the compact summary", async () => {
  const completed = proposal(1, "completed");
  const result = {
    revision: 1,
    childThreadId: child,
    initialMessageId: MessageId.make("initial"),
    parentThreadId: parent,
    parentTurnId: TurnId.make("origin-turn"),
    childTurnId: null,
    status: "waiting" as const,
    detail: "Waiting for the initial run",
    updatedAt: completed.updatedAt,
  };
  const state = queue([
    {
      ...completed,
      completionReturns: [
        result,
        {
          ...result,
          childThreadId: ThreadId.make("other-child"),
          status: "uncertain",
          detail: "Check before retrying",
        },
      ],
    },
  ]);
  const screen = await render(
    <div style={{ width: 440 }}>
      <AgentControlThreadActivity
        environmentId={environmentId}
        selection={selectAgentControlThreadActivity(state, parent)}
        getThreadTitle={getThreadTitle}
        submittingIds={[]}
        decisionErrorsById={{}}
        disabledReason={null}
        onDecide={() => {}}
      />
    </div>,
  );
  await expect.element(screen.getByText(/1 child result pending/)).toBeVisible();
  const pendingSummary = screen.getByText(/1 child result pending/).element();
  expect(pendingSummary.scrollWidth).toBeLessThanOrEqual(pendingSummary.clientWidth);
  await expect.element(screen.getByText("1 needs attention")).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: /Agent Control activity/ }))
    .toHaveAccessibleDescription("1 child result pending 1 needs attention");
  await expect.element(screen.getByTestId("agent-control-proposal-card")).not.toBeInTheDocument();
});

it("names the creating thread from server lineage alone", async () => {
  const screen = await render(
    <AgentControlThreadActivity
      environmentId={environmentId}
      selection={selectAgentControlThreadActivity(EMPTY_AGENT_CONTROL_QUEUE_STATE, child, {
        parentThreadId: parent,
        rootThreadId: parent,
        relationship: "delegated",
      })}
      getThreadTitle={getThreadTitle}
      submittingIds={[]}
      decisionErrorsById={{}}
      disabledReason={null}
      onDecide={() => {}}
    />,
  );
  await expect.element(screen.getByText("Delegated from")).toBeVisible();
  await expect
    .element(screen.getByRole("link", { name: "Coordinator" }))
    .toHaveAttribute("href", "/fixture-env/parent-uuid");
  await expect.element(screen.getByText("Managed by")).not.toBeInTheDocument();
});

it("shows the creator and a different current manager on one line", async () => {
  const reviewer = ThreadId.make("reviewer-uuid");
  const screen = await render(
    <AgentControlThreadActivity
      environmentId={environmentId}
      selection={{
        pending: [],
        activity: [],
        delegatedFromThreadId: parent,
        managerThreadId: reviewer,
      }}
      getThreadTitle={(id) => (id === reviewer ? "Reviewer" : getThreadTitle(id))}
      submittingIds={[]}
      decisionErrorsById={{}}
      disabledReason={null}
      onDecide={() => {}}
    />,
  );
  await expect
    .element(screen.getByTestId("agent-control-approvals"))
    .toHaveTextContent(/Delegated from\s*Coordinator\s*·\s*Managed by\s*Reviewer/);
  await expect
    .element(screen.getByRole("link", { name: "Reviewer" }))
    .toHaveAttribute("href", "/fixture-env/reviewer-uuid");
});
