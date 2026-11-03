import { assert, describe, it } from "@effect/vitest";
import {
  AgentControlProposal,
  type AgentControlActionPlan,
  type AgentControlResultEnvelope,
} from "@ryco/contracts";
import { Schema } from "effect";

import { computeAgentControlPlanDigest } from "./planDigest.ts";
import {
  isSettledProjectCopyProposal,
  renderProjectCopyOutcome,
} from "./projectCopyOutcomeWake.ts";

const now = "2026-10-22T09:00:00.000Z";

const importPlan = (overrides: Record<string, unknown> = {}) =>
  ({
    kind: "importProject",
    projectId: "project-imported",
    title: "notes-app",
    destinationPath: "/Users/me/code/notes-app",
    remoteUrl: "git@github.com:me/notes-app.git",
    branch: null,
    setup: null,
    followUpThread: null,
    ...overrides,
  }) as unknown as AgentControlActionPlan;

const proposal = (
  plan: AgentControlActionPlan,
  status: AgentControlProposal["status"],
  result: AgentControlResultEnvelope | null,
  principal: Record<string, unknown> = {
    kind: "provider-session",
    threadId: "caller",
    providerInstanceId: "codex",
  },
) =>
  Schema.decodeUnknownSync(AgentControlProposal)({
    proposalId: "proposal-1",
    requestId: "request-1",
    principal,
    planVersion: 1,
    plan,
    planDigest: computeAgentControlPlanDigest(plan),
    riskTags: [],
    promptSummary: null,
    status,
    createdAt: now,
    updatedAt: now,
    expiresAt: now,
    decidedAt: now,
    result,
  });

const completed = (projectCopy?: unknown): AgentControlResultEnvelope =>
  ({
    outcome: "completed",
    createdProjectIds: ["project-imported"],
    ...(projectCopy === undefined ? {} : { projectCopy }),
    completedAt: now,
  }) as unknown as AgentControlResultEnvelope;

describe("renderProjectCopyOutcome", () => {
  it("says where an import landed, that no setup was asked for, and names the request", () => {
    const text = renderProjectCopyOutcome(
      proposal(
        importPlan(),
        "completed",
        completed({
          path: "/Users/me/code/notes-app",
          setup: null,
          followUpThreadId: null,
          warnings: [],
        }),
      ),
    );
    assert.strictEqual(
      text,
      [
        "[Ryco] Setting up notes-app on this node, which you asked for (request request-1), finished.",
        "Folder on this node: /Users/me/code/notes-app",
        "Project: project-imported on this node",
        "Setup: none was asked for.",
      ].join("\n"),
    );
  });

  it("names a long or multi-line command instead of quoting it, and a thread that did not start", () => {
    const text = renderProjectCopyOutcome(
      proposal(
        importPlan({
          setup: { command: "mise install\nbun install", saveAsScript: false },
          followUpThread: {
            title: "Finish",
            prompt: "Go.",
            runtimeMode: "approval-required",
            envMode: "local",
            modelSelection: { instanceId: "codex", model: "gpt-5.6" },
          },
        }),
        "completed",
        completed(),
      ),
    );
    assert.include(text, "Setup: the setup command ran; Ryco did not learn how it ended.");
    assert.include(text, 'Setup thread "Finish" did not start.');
  });

  it("only speaks for settled copies and imports an agent asked for", () => {
    const pending = proposal(importPlan(), "executing", null);
    assert.isNull(renderProjectCopyOutcome(pending));
    assert.isFalse(isSettledProjectCopyProposal(pending));
    assert.isFalse(
      isSettledProjectCopyProposal(
        proposal(importPlan(), "completed", completed(), {
          kind: "external-integration",
          integrationId: "integration-1",
        }),
      ),
    );
    assert.isTrue(isSettledProjectCopyProposal(proposal(importPlan(), "completed", completed())));
  });
});
