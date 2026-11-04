import { describe, expect, it } from "vite-plus/test";
import { renderToStaticMarkup } from "react-dom/server";
import { Schema } from "effect";
import {
  AgentControlActionPlan,
  AgentControlProposalId,
  AgentControlRequestId,
  AgentControlRiskTag,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type AgentControlProposal,
  type AgentControlProposalView,
} from "@ryco/contracts";

import {
  AgentControlClientExecutorContext,
  type AgentControlClientExecutionPreviewState,
  type AgentControlClientExecutor,
} from "./agentControlClientExecutor";
import { AgentControlProposalCard } from "./AgentControlProposalCard";
import { buildAgentControlProposalCardModel } from "@ryco/client-runtime/state/agentControl";

const SECRET_PROMPT = "SECRET-PROMPT-TOKEN: rotate the API keys in vault";

function makeProposal(overrides: Partial<AgentControlProposal> = {}): AgentControlProposal {
  return {
    proposalId: AgentControlProposalId.make("proposal-1"),
    requestId: AgentControlRequestId.make("request-1"),
    principal: {
      kind: "provider-session",
      threadId: ThreadId.make("thread-caller-1234"),
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    planVersion: 1,
    plan: {
      kind: "createThreads",
      entries: [
        {
          projectId: ProjectId.make("project-1"),
          title: "Fix the flaky test",
          prompt: SECRET_PROMPT,
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6" },
          runtimeMode: "full-access",
          envMode: "worktree",
        },
      ],
    },
    planDigest: "a".repeat(64),
    riskTags: [AgentControlRiskTag.make("creates-threads")],
    promptSummary: "Create 1 thread in project-1",
    status: "pending-user-approval",
    createdAt: "2026-08-17T00:00:00.000Z",
    updatedAt: "2026-08-17T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    decidedAt: null,
    result: null,
    ...overrides,
  };
}

function renderCard(input: {
  proposal?: AgentControlProposalView;
  isSubmitting?: boolean;
  decisionError?: string | null;
  disabledReason?: string | null;
  clientExecutor?: AgentControlClientExecutor;
}): string {
  const proposal = input.proposal ?? makeProposal();
  return renderToStaticMarkup(
    <AgentControlClientExecutorContext.Provider value={input.clientExecutor ?? null}>
      <AgentControlProposalCard
        model={buildAgentControlProposalCardModel(proposal)}
        proposal={proposal}
        environmentId={"local" as never}
        isSubmitting={input.isSubmitting ?? false}
        decisionError={input.decisionError ?? null}
        disabledReason={input.disabledReason ?? null}
        onAccept={() => {}}
        onReject={() => {}}
      />
    </AgentControlClientExecutorContext.Provider>,
  );
}

const copyProjectPlan = Schema.decodeUnknownSync(AgentControlActionPlan)({
  kind: "copyProjectToNode",
  source: {
    kind: "project",
    projectId: "project-1",
    title: "ryco",
    expectedUpdatedAt: "2026-10-22T00:00:00.000Z",
  },
  target: { environmentId: "env-mac-mini", label: "Mac mini" },
  destination: { kind: "default" },
  bringCommits: false,
  bringChanges: false,
  copySettings: true,
  setup: { command: "bun install", saveAsScript: false },
  followUpThread: null,
});

describe("AgentControlProposalCard", () => {
  it("shows a pending proposal with origin, action, risk, expiry, and decisions", () => {
    const markup = renderCard({});
    expect(markup).toContain("Agent Control");
    expect(markup).toContain("Awaiting approval");
    expect(markup).toContain("Create 1 thread");
    expect(markup).toContain("Agent in thread thread-c…");
    expect(markup).toContain("full-access · worktree");
    expect(markup).toContain("creates threads");
    expect(markup).toContain("Create 1 thread in project-1");
    expect(markup).toContain("Expires in");
    expect(markup).toContain(">Approve<");
    expect(markup).toContain(">Reject<");
  });

  it("never renders the full prompt without deliberate expansion", () => {
    const markup = renderCard({});
    expect(markup).not.toContain(SECRET_PROMPT);
    expect(markup).toContain("Show plan details");
  });

  it("makes project unlink proposals visibly destructive", () => {
    const markup = renderCard({
      proposal: makeProposal({
        plan: {
          kind: "removeProject",
          projectId: ProjectId.make("project-1"),
          expected: {
            title: "Project one",
            workspaceRoot: "/workspace/project-one",
            repositoryIdentityKey: null,
            updatedAt: "2026-08-17T00:00:00.000Z",
          },
          expectedThreadIds: [],
          force: false,
        },
        riskTags: [AgentControlRiskTag.make("removes-project")],
      }),
    });
    expect(markup).toContain("Unlink project");
    expect(markup).toContain("Destructive · Ryco records only");
    expect(markup).toContain("border-destructive/70");
  });

  it("makes open-world Simulator URL approval visibly high risk", () => {
    const markup = renderCard({
      proposal: makeProposal({
        plan: {
          kind: "deviceOpenUrl",
          threadId: ThreadId.make("thread-caller-1234"),
          projectId: ProjectId.make("project-1"),
          expectedProjectUpdatedAt: "2026-08-18T00:00:00.000Z",
          providerInstanceId: ProviderInstanceId.make("codex"),
          udid: "FAKE-0001" as never,
          expectedThreadDeviceVersion: 3,
          expectedAttachedDeviceUdid: "FAKE-0001" as never,
          expectedDeviceState: "booted",
          expectedDeviceBootSource: "user",
          expectedRecording: false,
          executionSummary: "Open an approved URL or deep link",
          riskClass: "open-world",
          url: "https://example.test/path",
        },
        riskTags: [AgentControlRiskTag.make("device-open-world")],
      }),
    });
    expect(markup).toContain("High risk · opens an external URL or deep link");
    expect(markup).toContain("border-destructive/70");
  });

  it("disables decisions while a decision is submitting", () => {
    const markup = renderCard({ isSubmitting: true });
    const disabledButtons = markup.match(/ disabled=""/g) ?? [];
    // Reject and Approve are both disabled; the detail toggle stays usable.
    expect(disabledButtons.length).toBe(2);
  });

  it("disables decisions and explains why when the capability is missing", () => {
    const markup = renderCard({ disabledReason: "Owner role required." });
    expect(markup).toContain("Owner role required.");
    expect((markup.match(/ disabled=""/g) ?? []).length).toBe(2);
  });

  it("shows an approved proposal without decision actions", () => {
    const markup = renderCard({
      proposal: makeProposal({
        status: "approved",
        decidedAt: "2026-08-17T00:05:00.000Z",
      }),
    });
    expect(markup).toContain("Approved · awaiting executor");
    expect(markup).not.toContain(">Approve<");
    expect(markup).not.toContain(">Reject<");
  });

  it("shows a rejected proposal with its terminal result", () => {
    const markup = renderCard({
      proposal: makeProposal({
        status: "rejected",
        decidedAt: "2026-08-17T00:05:00.000Z",
        result: {
          outcome: "failed",
          error: { code: "rejected" as never, message: "Proposal was rejected", retryable: false },
          failedAt: "2026-08-17T00:05:00.000Z",
        },
      }),
    });
    expect(markup).toContain("Rejected");
    expect(markup).toContain("rejected: Proposal was rejected");
    expect(markup).not.toContain(">Approve<");
  });

  it("shows durable execution progress and links affected Ryco threads", () => {
    const markup = renderCard({
      proposal: makeProposal({
        status: "completed",
        result: {
          outcome: "completed",
          execution: {
            operationId: "operation-123456789" as never,
            commands: [
              {
                commandId: "command-1" as never,
                commandType: "thread.turn.start",
                sequence: 12,
              },
            ],
            affectedThreadIds: [ThreadId.make("thread-created-1234")],
            worktreeIds: [],
          },
          completedAt: "2026-08-17T00:10:00.000Z",
        },
      }),
    });
    expect(markup).toContain("Operation operatio… · 1 command");
    expect(markup).toContain('href="/local/thread-created-1234"');
    expect(markup).toContain("Open thread thread-c…");
  });

  it("shows an expired proposal with its terminal result", () => {
    const markup = renderCard({
      proposal: makeProposal({
        status: "expired",
        expiresAt: "2026-08-17T01:00:00.000Z",
        result: {
          outcome: "failed",
          error: {
            code: "expired" as never,
            message: "Proposal expired at 2026-08-17T01:00:00.000Z",
            retryable: true,
          },
          failedAt: "2026-08-17T01:00:00.000Z",
        },
      }),
    });
    expect(markup).toContain("Expired");
    expect(markup).toContain("expired: Proposal expired");
    expect(markup).not.toContain("Expires in");
  });

  it("surfaces a failed decision as an alert on the pending card", () => {
    const markup = renderCard({
      decisionError: "Decision no longer applies to the proposal's current state.",
    });
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Decision no longer applies");
    // The card stays decidable so the user can retry after the queue syncs.
    expect(markup).toContain(">Approve<");
  });

  it("offers only Reject and Update Ryco for a request this build cannot read", () => {
    const markup = renderCard({
      proposal: {
        ...makeProposal({ promptSummary: null }),
        plan: { kind: "unsupported", originalKind: "mirrorRepository" },
      },
      // Even a client that runs client-executed plans cannot approve it.
      clientExecutor: { canExecute: () => true, approve: async () => {} },
    });
    expect(markup).toContain("Unsupported request · mirrorRepository");
    expect(markup).toContain("Update Ryco to review this request.");
    expect(markup).toContain(">Reject<");
    expect(markup).toContain(">Update Ryco<");
    expect(markup).not.toContain(">Approve<");
  });

  it("sends a client-executed copy to a computer that can run it", () => {
    const proposal = makeProposal({ plan: copyProjectPlan, promptSummary: null });
    const markup = renderCard({ proposal });
    expect(markup).toContain("Copy to Mac mini · ryco");
    expect(markup).toContain("Approve in Ryco on a computer connected to Mac mini");
    expect(markup).toContain(">Reject<");
    expect(markup).not.toContain(">Approve<");
    expect(markup).not.toContain(">Update Ryco<");

    const targets: string[] = [];
    const runnable = renderCard({
      proposal,
      clientExecutor: {
        canExecute: (target) => {
          targets.push(target.label);
          return true;
        },
        approve: async () => {},
      },
    });
    expect(runnable).toContain(">Approve<");
    expect(runnable).not.toContain("Approve in Ryco on a computer connected to");
    expect(targets).toEqual(["Mac mini"]);
  });

  it("shows where a copy lands on its target and the setup thread's model before Approve", () => {
    const proposal = makeProposal({ plan: copyProjectPlan, promptSummary: null });
    const ready: AgentControlClientExecutionPreviewState = {
      status: "ready",
      preview: {
        targetLabel: "Mac mini",
        destination: {
          path: "/Users/me/Code/ryco",
          tag: "new folder",
          note: "Mac mini's code directory.",
        },
        followUpModel: "Opus 5.5 · Claude",
        problem: null,
      },
    };
    const executor = (
      state: AgentControlClientExecutionPreviewState,
    ): AgentControlClientExecutor => ({
      canExecute: () => true,
      approve: async () => {},
      previews: { load: () => {}, read: () => state, subscribe: () => () => {} },
    });

    const markup = renderCard({ proposal, clientExecutor: executor(ready) });
    expect(markup).toContain('data-testid="agent-control-execution-preview"');
    expect(markup).toContain("On Mac mini");
    // The path wraps between its folders.
    expect(markup.replaceAll(/<[^>]+>/gu, "")).toContain("/Users/me/Code/ryconew folder");
    expect(markup).toContain(">new folder<");
    expect(markup).toContain("Mac mini&#x27;s code directory.");
    expect(markup).toContain("Opus 5.5 · Claude");

    const blocked = renderCard({
      proposal,
      clientExecutor: executor({
        status: "ready",
        preview: { ...ready.preview, problem: "No agent provider is ready on Mac mini." },
      }),
    });
    expect(blocked).toContain("No agent provider is ready on Mac mini.");
    expect(renderCard({ proposal, clientExecutor: executor({ status: "loading" }) })).toContain(
      "Checking Mac mini…",
    );

    // A client that can't run it (or shows no preview) resolves nothing.
    expect(
      renderCard({
        proposal,
        clientExecutor: { ...executor(ready), canExecute: () => false },
      }),
    ).not.toContain("agent-control-execution-preview");
    expect(renderCard({ proposal })).not.toContain("agent-control-execution-preview");
    // Once decided, there is nothing left to preview.
    expect(
      renderCard({
        proposal: { ...proposal, status: "approved" },
        clientExecutor: executor(ready),
      }),
    ).not.toContain("agent-control-execution-preview");
  });
});
