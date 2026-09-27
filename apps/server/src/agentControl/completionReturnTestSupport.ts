import {
  AgentControlProposalId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
} from "@ryco/contracts";
import type { CompletionReturnRecord } from "../persistence/Layers/AgentControlCompletionReturns.ts";

export const completionFixtureTime = "2026-09-27T10:00:00.000Z";
export const completionFixture = (
  overrides: Partial<CompletionReturnRecord> = {},
): CompletionReturnRecord => ({
  proposalId: AgentControlProposalId.make("delegation-proposal"),
  childThreadId: ThreadId.make("child"),
  initialMessageId: MessageId.make("child-initial"),
  parentThreadId: ThreadId.make("parent"),
  parentTurnId: TurnId.make("parent-turn"),
  childTurnId: null,
  projectId: ProjectId.make("project-1"),
  parentRuntimeSessionId: RuntimeSessionId.make("parent-runtime"),
  parentProviderInstanceId: ProviderInstanceId.make("codex"),
  parentRuntimeMode: "approval-required",
  parentWorktreePath: null,
  status: "waiting",
  detail: "Waiting for initial child run.",
  revision: 0,
  createdAt: completionFixtureTime,
  updatedAt: completionFixtureTime,
  nextCheckAt: completionFixtureTime,
  settled: null,
  command: null,
  ...overrides,
});
