/**
 * Shared rules of the two cross-node project plans: `importProject`, which this node executes
 * through the import job, and `copyProjectToNode`, which the owner client that approves it runs
 * against the target node and reports back. The validator, the executor, the approval RPCs and
 * the MCP tools all read them from here: import ids, the client executor binding and its
 * deadlines, bounded credential-free text, and default folder names.
 *
 * @module agentControl/projectCopyControl
 */
import { createHash, timingSafeEqual } from "node:crypto";

import {
  AGENT_CONTROL_CLIENT_EXECUTED_PLAN_KINDS,
  AGENT_CONTROL_ERROR_MESSAGE_MAX_CHARS,
  type AgentControlActionPlan,
  type AgentControlClientExecutedPlanKind,
  type AgentControlClientExecutorId,
  type AgentControlImportProjectPlan,
  type AgentControlOperation,
  type AgentControlProposalId,
} from "@ryco/contracts";
import {
  PROJECT_IMPORT_UNINSPECTED_CLONE_STEPS,
  ProjectCopyDirectoryName,
  ProjectImportId,
  type ProjectDestinationPreview,
  type ProjectImportStartInput,
} from "@ryco/contracts/project-copy";
import { redactDiagnosticText } from "@ryco/shared/diagnosticRedaction";
import { redactGitCredentials, repositoryFolderName } from "@ryco/shared/gitRemoteUrl";
import { Schema } from "effect";

import { redactAgentControlSecretText } from "./secretRedaction.ts";

export type AgentControlProjectCopyPlan = Extract<
  AgentControlActionPlan,
  { kind: "importProject" | "copyProjectToNode" }
>;

export const isAgentControlProjectCopyPlan = (
  plan: AgentControlActionPlan,
): plan is AgentControlProjectCopyPlan =>
  plan.kind === "importProject" || plan.kind === "copyProjectToNode";

const CLIENT_EXECUTED_KINDS: ReadonlySet<string> = new Set(
  AGENT_CONTROL_CLIENT_EXECUTED_PLAN_KINDS,
);

/** Kinds the approving client executes; the node's executor never runs them. */
export const isAgentControlClientExecutedKind = (
  kind: string,
): kind is AgentControlClientExecutedPlanKind => CLIENT_EXECUTED_KINDS.has(kind);

// ── Client executor binding ───────────────────────────────────────────

/** Without a report by then, the copy fails (A1). */
export const AGENT_CONTROL_CLIENT_EXECUTION_DEADLINE_MS = 2 * 60 * 60_000;
/** A `started` report (the import runs on the target) extends the deadline to this. */
export const AGENT_CONTROL_CLIENT_EXECUTION_STARTED_DEADLINE_MS = 6 * 60 * 60_000;

/** The only form of the executor id the node keeps: sha-256 hex. */
export const agentControlClientExecutorIdHash = (executorId: AgentControlClientExecutorId) =>
  createHash("sha256").update(executorId).digest("hex");

/** Constant-time check of a presented executor id against the stored hash. */
export const agentControlClientExecutorMatches = (
  executorIdHash: string,
  executorId: AgentControlClientExecutorId,
): boolean => {
  const expected = Buffer.from(executorIdHash, "hex");
  const actual = Buffer.from(agentControlClientExecutorIdHash(executorId), "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
};

/** Whether a client-executed run's report deadline passed (ISO timestamps compare as text). */
export const isPastAgentControlClientExecutionDeadline = (
  operation: Pick<AgentControlOperation, "state">,
  now: string,
): boolean =>
  operation.state.clientExecution !== undefined &&
  operation.state.clientExecution.deadlineAt <= now;

export const agentControlClientExecutionMissedDeadlineMessage = (targetLabel: string) =>
  `The app that approved this request did not report back; check ${targetLabel}.`;

// ── Import ids ────────────────────────────────────────────────────────

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * RFC 4122 version 5 UUID of `name` in `namespace`. A namespace that is not itself a UUID (test
 * and legacy operation ids) is first hashed to 16 bytes, so every input has one stable answer.
 */
export const uuidV5 = (namespace: string, name: string): string => {
  const namespaceBytes = UUID_PATTERN.test(namespace)
    ? Buffer.from(namespace.replaceAll("-", ""), "hex")
    : createHash("sha1").update(namespace).digest().subarray(0, 16);
  const bytes = createHash("sha1").update(namespaceBytes).update(name).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** The import an approved `importProject` runs: a retried or recovered execution finds the same job. */
export const agentControlProjectImportId = (operationId: string): ProjectImportId =>
  ProjectImportId.make(uuidV5(operationId, "project-import"));

/**
 * The import job input for an approved `importProject`: a clone of the plan's repository into
 * its previewed folder, ending on its branch (or the remote's default), with its pinned setup
 * command and follow-up thread. The destination re-checks everything; `origin` is display-only.
 */
export const agentControlProjectImportInput = (
  plan: AgentControlImportProjectPlan,
  input: { readonly importId: ProjectImportId; readonly proposalId: AgentControlProposalId },
): ProjectImportStartInput => ({
  importId: input.importId,
  projectId: plan.projectId,
  title: plan.title,
  destinationPath: plan.destinationPath,
  source: { kind: "clone", remoteUrl: plan.remoteUrl, remoteName: "origin" },
  remotes: [],
  commits: null,
  checkout: plan.branch === null ? null : { branch: plan.branch, headOid: null },
  changes: null,
  relativeRootInRepository: "",
  // Both steps only warn: a private submodule or a missing git-lfs never fails the import.
  ...PROJECT_IMPORT_UNINSPECTED_CLONE_STEPS,
  settings: null,
  avatarTransferId: null,
  setup: plan.setup,
  followUpThread: plan.followUpThread,
  origin: { kind: "agent-control", sourceLabel: null, proposalId: input.proposalId },
});

// ── Bounded text ──────────────────────────────────────────────────────

/**
 * Text from another node or a client (errors, warnings) as Agent Control keeps it: tokens and
 * URL credentials redacted, at most `AGENT_CONTROL_ERROR_MESSAGE_MAX_CHARS`, never empty.
 */
export const boundedProjectCopyText = (text: string | null | undefined, fallback: string) => {
  const redacted = redactAgentControlSecretText(
    redactDiagnosticText(redactGitCredentials(text ?? "")),
  ).trim();
  const bounded = redacted.slice(0, AGENT_CONTROL_ERROR_MESSAGE_MAX_CHARS).trim();
  return bounded.length > 0 ? bounded : fallback;
};

// ── Names and destinations ────────────────────────────────────────────

const isDirectoryName = Schema.is(ProjectCopyDirectoryName);

/**
 * The folder a clone of `remoteUrl` gets by default: its last path segment without `.git`
 * (`git@host:owner/repo.git` → `repo`), reduced to a portable folder name; null when nothing is
 * left.
 */
export const projectCopyFolderNameFromRemote = (remoteUrl: string): string | null => {
  const name = (repositoryFolderName(remoteUrl) ?? "")
    .replaceAll(/[^A-Za-z0-9._-]+/gu, "-")
    .replace(/^[^A-Za-z0-9]+/u, "")
    .slice(0, 128);
  return isDirectoryName(name) ? name : null;
};

/** A destination path segment of `..`: never sent to another node, whatever it resolves to. */
export const hasParentDirectorySegment = (path: string): boolean =>
  path.split(/[\\/]/u).some((segment) => segment === "..");

/** Why a folder on this node cannot take a new clone, with the free alternative when known. */
export const describeProjectDestinationProblem = (preview: ProjectDestinationPreview): string => {
  const where = preview.resolvedPath.length > 0 ? preview.resolvedPath : "The folder";
  const reason = (() => {
    switch (preview.state) {
      case "exists-not-empty":
        return `${where} already exists and is not empty.`;
      case "is-git-repository":
        return preview.existingProjectId === null
          ? `${where} is already a git repository.`
          : `${where} is already the project ${preview.existingProjectId}.`;
      case "retired-checkout":
        return `${where} is under a retired checkout, where Ryco refuses to run turns.`;
      case "access-denied":
        return `${where} is outside the folders Ryco may use on this node.`;
      case "invalid":
        return `${where} is not a usable absolute folder path.`;
      case "available":
      case "exists-empty":
        return `${where} cannot take a new project.`;
    }
  })();
  return [
    reason,
    ...(preview.detail === null ? [] : [preview.detail]),
    ...(preview.suggestedPath === null ? [] : [`${preview.suggestedPath} is free.`]),
  ].join(" ");
};
