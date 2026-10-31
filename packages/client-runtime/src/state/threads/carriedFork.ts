/**
 * Shared client side of "Continue on another machine" (`threads.forkCarried`,
 * docs/thread-forks.md#continue-on-another-machine): the client is the only carrier. It reads the
 * conversation from the source node with its own access there, and sends it to the target node,
 * which creates the fork with the user's own access there. The nodes never talk to each other.
 *
 * Which machines can take the fork, the branch rule, the model mapping, the carried conversation,
 * the fork key a retry reuses and one guarded call live here, so web and mobile behave the same.
 * Loaded only with the fork dialog (subpath `@ryco/client-runtime/state/threads/carriedFork`).
 */
import type {
  EnvironmentApi,
  EnvironmentId,
  MessageId,
  ModelSelection,
  OrchestrationLatestTurn,
  OrchestrationMessage,
  OrchestrationProposedPlan,
  OrchestrationThread,
  ProjectId,
  RepositoryIdentity,
  ThreadForkKey,
  ThreadForkResult,
  ThreadId,
} from "@ryco/contracts";
import { THREAD_FORKED_ACTIVITY_KIND } from "@ryco/contracts/thread-fork";
import {
  CARRIED_THREAD_HISTORY_MAX_BYTES,
  CARRIED_THREAD_HISTORY_MAX_MESSAGES,
  CARRIED_THREAD_HISTORY_MAX_PLANS,
  CARRIED_THREAD_TEXT_MAX_CHARS,
  type CarriedThreadHistory,
  type CarriedThreadSource,
  type CarriedThreadTurnOutcome,
  type ThreadForkCarriedDestination,
  ThreadForkCarriedInput,
} from "@ryco/contracts/thread-fork-carried";
import {
  CARRIED_FORK_REMOTE,
  type CarriedForkInstanceCandidate,
  isValidCarriedBranchName,
  pickCarriedForkInstance,
} from "@ryco/shared/carriedFork";
import { readThreadForkedActivity } from "@ryco/shared/threadFork";
import * as Schema from "effect/Schema";

import { collectThreadHistory, type ThreadHistoryCopy } from "../../connection/threadHistory.ts";
import { deriveLogicalProjectKey } from "../workspace/logicalProjects.ts";
import { classifyThreadForkError, THREAD_FORK_COPY, type ThreadForkOutcome } from "./threadFork.ts";

/** Platform-neutral wording for the "Another machine" part of the fork dialog. */
export const CARRIED_FORK_COPY = {
  machineHeading: "Continue on",
  thisMachine: "This machine",
  thisMachineDescription: "Fork into this machine's project, as before.",
  otherMachine: "Another machine",
  otherMachineDescription:
    "Carry this conversation to another of your machines and continue it there.",
  noOtherMachine: "None of your other connected machines has this project.",
  targetHeading: "Machine",
  targetNoProvider: (driver: string) => `No ${driver} provider is turned on there.`,
  targetModel: (instance: string, model: string) => `Continues with ${model} on ${instance}.`,
  targetChat: "A new chat with an empty folder.",
  branch: {
    loading: "Checking this branch…",
    ready: (baseRef: string) => `Starts a new worktree there from ${baseRef}.`,
    unpushed: (branch: string, count: number) =>
      `${branch} has ${count} ${count === 1 ? "commit" : "commits"} that aren't pushed. Push first: the other machine starts from origin.`,
    noUpstream: (branch: string) =>
      `${branch} isn't pushed to origin yet. Push it first: the other machine starts from origin.`,
    noBranch: "The other machine needs a branch pushed to origin. Check out a branch and push it.",
  },
  stays:
    "Uncommitted changes, attachments, tool activity and checkpoints stay on this machine. The other machine's agent receives this conversation as context.",
  archiveOriginal: "Archive the original afterwards",
  archiveOriginalDescription: "Only once the fork exists on the other machine.",
  busy: {
    reading: "Reading the conversation…",
    creating: (machine: string) => `Creating the fork on ${machine}…`,
  },
  tooLong:
    "This conversation is too long to continue on another machine. Fork from an earlier reply.",
  sourceChanged:
    "The conversation or connection changed while it was read. Nothing was sent; try again.",
  archiveFailed:
    "The fork was created, but the original couldn't be archived. Archive it yourself.",
} as const;

// ── Targets ────────────────────────────────────────────────────────────

/** What a client knows about one other machine, assembled by the platform. */
export interface CarriedForkTargetCandidate {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** A live connection whose shell snapshot is current. */
  readonly connected: boolean;
  /**
   * The shared capability policy lets this session run `threads.forkCarried` there now: its role
   * is operator or owner and, when hosted, its own relay session is ready for mutations.
   */
  readonly allowed: boolean;
  /** The node advertises `threadForkCarried`. */
  readonly supported: boolean;
  readonly chatsAvailable: boolean;
  readonly providers: ReadonlyArray<CarriedForkInstanceCandidate & { readonly label?: string }>;
  readonly projects: ReadonlyArray<{
    readonly id: ProjectId;
    readonly cwd: string;
    readonly repositoryIdentity: RepositoryIdentity | null;
    readonly isChat: boolean;
  }>;
}

export interface CarriedForkTarget {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** The target's own copy of the project; null for a chat. */
  readonly projectId: ProjectId | null;
  /** The target's instance the fork runs on; null when it has none of the source's driver. */
  readonly instance: { readonly instanceId: string; readonly label: string } | null;
  readonly enabled: boolean;
  readonly disabledReason?: string;
}

/**
 * The machines a fork can continue on. A machine is left out when it is the source, offline, not
 * allowed (viewer, or a hosted session not ready), older than carried forks, or has no copy of
 * the project: exactly one project of the same repository and folder (two make it ambiguous), or
 * chats for a chat. One without an enabled instance of the source's driver is listed, disabled.
 */
export function listCarriedForkTargets(input: {
  readonly sourceEnvironmentId: EnvironmentId;
  readonly source:
    | { readonly isChat: true }
    | {
        readonly isChat: false;
        readonly projectId: ProjectId;
        readonly cwd: string;
        readonly repositoryIdentity: RepositoryIdentity | null;
      };
  readonly driver: string | null;
  readonly candidates: ReadonlyArray<CarriedForkTargetCandidate>;
}): ReadonlyArray<CarriedForkTarget> {
  const { source } = input;
  const projectKey = (
    environmentId: string,
    project: {
      readonly id: string;
      readonly cwd: string;
      readonly repositoryIdentity: RepositoryIdentity | null;
    },
  ) =>
    project.repositoryIdentity?.canonicalKey
      ? deriveLogicalProjectKey(
          {
            environmentId,
            id: project.id,
            cwd: project.cwd,
            repositoryIdentity: project.repositoryIdentity,
          },
          { groupingMode: "repository_path" },
        )
      : null;
  const sourceKey = source.isChat
    ? null
    : projectKey(input.sourceEnvironmentId, {
        id: source.projectId,
        cwd: source.cwd,
        repositoryIdentity: source.repositoryIdentity,
      });
  const targets: CarriedForkTarget[] = [];
  for (const candidate of input.candidates) {
    if (
      candidate.environmentId === input.sourceEnvironmentId ||
      !candidate.connected ||
      !candidate.allowed ||
      !candidate.supported
    ) {
      continue;
    }
    let projectId: ProjectId | null = null;
    if (source.isChat) {
      if (!candidate.chatsAvailable) continue;
    } else {
      if (sourceKey === null) continue;
      const copies = candidate.projects.filter(
        (project) => !project.isChat && projectKey(candidate.environmentId, project) === sourceKey,
      );
      if (copies.length !== 1) continue;
      projectId = copies[0]!.id;
    }
    const instance =
      input.driver === null ? null : pickCarriedForkInstance(candidate.providers, input.driver);
    targets.push({
      environmentId: candidate.environmentId,
      label: candidate.label,
      projectId,
      instance:
        instance === null
          ? null
          : { instanceId: instance.instanceId, label: instance.label ?? instance.instanceId },
      enabled: instance !== null,
      ...(instance === null
        ? { disabledReason: CARRIED_FORK_COPY.targetNoProvider(input.driver ?? "matching") }
        : {}),
    });
  }
  return targets.toSorted(
    (left, right) =>
      left.label.localeCompare(right.label) ||
      left.environmentId.localeCompare(right.environmentId),
  );
}

/** The source's model by driver: instance ids are machine-local, so the target maps the driver. */
export function carriedForkModel(
  modelSelection: Pick<ModelSelection, "instanceId" | "model">,
  sourceProviders: ReadonlyArray<{ readonly instanceId: string; readonly driver: string }>,
): CarriedThreadHistory["model"] | null {
  const driver = sourceProviders.find(
    (provider) => provider.instanceId === modelSelection.instanceId,
  )?.driver;
  return driver === undefined
    ? null
    : ({ driver, model: modelSelection.model } as CarriedThreadHistory["model"]);
}

// ── Branch ─────────────────────────────────────────────────────────────

export type CarriedForkBranch =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly branch: string; readonly baseRef: string }
  | { readonly kind: "unpushed"; readonly branch: string; readonly aheadCount: number }
  | { readonly kind: "no-upstream"; readonly branch: string }
  | { readonly kind: "no-branch" };

/**
 * Where the target's worktree starts: the source checkout's branch as it is on origin, which
 * needs the branch pushed with nothing left to push. Uncommitted changes never travel.
 */
export function carriedForkBranch(
  status:
    | {
        readonly isRepo: boolean;
        readonly refName: string | null;
        readonly hasUpstream: boolean;
        readonly aheadCount: number;
      }
    | null
    | undefined,
): CarriedForkBranch {
  if (status === null || status === undefined) return { kind: "loading" };
  const branch = status.refName?.trim() ?? "";
  if (!status.isRepo || branch.length === 0 || !isValidCarriedBranchName(branch)) {
    return { kind: "no-branch" };
  }
  if (!status.hasUpstream) return { kind: "no-upstream", branch };
  if (status.aheadCount > 0) return { kind: "unpushed", branch, aheadCount: status.aheadCount };
  return { kind: "ready", branch, baseRef: `${CARRIED_FORK_REMOTE}/${branch}` };
}

export function carriedForkBranchLine(branch: CarriedForkBranch): string {
  const copy = CARRIED_FORK_COPY.branch;
  switch (branch.kind) {
    case "loading":
      return copy.loading;
    case "ready":
      return copy.ready(branch.baseRef);
    case "unpushed":
      return copy.unpushed(branch.branch, branch.aheadCount);
    case "no-upstream":
      return copy.noUpstream(branch.branch);
    case "no-branch":
      return copy.noBranch;
  }
}

// ── Conversation ───────────────────────────────────────────────────────

type SourceMessage = Pick<
  OrchestrationMessage,
  "id" | "role" | "text" | "turnId" | "createdAt" | "streaming"
>;
type SourcePlan = Pick<
  OrchestrationProposedPlan,
  "id" | "turnId" | "planMarkdown" | "createdAt" | "implementedAt"
>;

const TRUNCATED_SUFFIX = "\n\n[Shortened when it was carried to another machine.]";

function boundedText(text: string): string {
  if (text.length <= CARRIED_THREAD_TEXT_MAX_CHARS) return text;
  let end = CARRIED_THREAD_TEXT_MAX_CHARS - TRUNCATED_SUFFIX.length;
  const last = text.charCodeAt(end - 1);
  // Never cut between the two halves of a surrogate pair.
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}${TRUNCATED_SUFFIX}`;
}

const byHistoryOrder = <T extends { readonly createdAt: string; readonly id: string }>(
  left: T,
  right: T,
) =>
  left.createdAt < right.createdAt
    ? -1
    : left.createdAt > right.createdAt
      ? 1
      : left.id < right.id
        ? -1
        : left.id > right.id
          ? 1
          : 0;

const utf8 = new TextEncoder();

export type BuildCarriedThreadHistoryResult =
  | { readonly ok: true; readonly history: CarriedThreadHistory }
  | {
      readonly ok: false;
      readonly reason: "boundary-missing" | "too-large";
      readonly message: string;
    };

/**
 * The conversation a fork carries: every user and assistant message up to and including the
 * picked reply, in order, and nothing after it; the proposed plans of those turns (the newest
 * 200); and the carried turns the source knows did not complete. Texts over the per-text limit
 * are shortened with a note; a conversation over the message or size limit is refused.
 */
export function buildCarriedThreadHistory(input: {
  readonly messages: ReadonlyArray<SourceMessage>;
  readonly proposedPlans: ReadonlyArray<SourcePlan>;
  /** Turns of the source known not to have completed (its own provenance, its latest turn). */
  readonly turnOutcomes: ReadonlyArray<CarriedThreadTurnOutcome>;
  readonly boundaryMessageId: MessageId;
  readonly source: CarriedThreadSource;
  readonly model: CarriedThreadHistory["model"];
  readonly runtimeMode: CarriedThreadHistory["runtimeMode"];
  readonly interactionMode: CarriedThreadHistory["interactionMode"];
  readonly tokenMode?: CarriedThreadHistory["tokenMode"];
}): BuildCarriedThreadHistoryResult {
  const ordered = input.messages.toSorted(byHistoryOrder);
  const boundaryIndex = ordered.findIndex((message) => message.id === input.boundaryMessageId);
  const boundary = ordered[boundaryIndex];
  if (boundary === undefined || boundary.role !== "assistant" || !boundary.turnId) {
    return {
      ok: false,
      reason: "boundary-missing",
      message: THREAD_FORK_COPY.errors["boundary-stale"],
    };
  }
  const messages = ordered
    .slice(0, boundaryIndex + 1)
    .filter(
      (message) => !message.streaming && (message.role === "user" || message.role === "assistant"),
    )
    .map((message) => ({
      role: message.role as "user" | "assistant",
      text: boundedText(message.text),
      createdAt: new Date(message.createdAt).toISOString(),
      turnId: message.turnId,
    }));
  if (messages.length > CARRIED_THREAD_HISTORY_MAX_MESSAGES) {
    return { ok: false, reason: "too-large", message: CARRIED_FORK_COPY.tooLong };
  }
  const turns = new Set(messages.flatMap((message) => (message.turnId ? [message.turnId] : [])));
  const replied = new Set(
    messages.flatMap((message) =>
      message.role === "assistant" && message.turnId ? [message.turnId] : [],
    ),
  );
  const boundaryAt = new Date(boundary.createdAt).toISOString();
  const proposedPlans = input.proposedPlans
    .map((plan) => ({ ...plan, createdAt: new Date(plan.createdAt).toISOString() }))
    .filter((plan) => (plan.turnId ? turns.has(plan.turnId) : plan.createdAt <= boundaryAt))
    .toSorted(byHistoryOrder)
    .slice(-CARRIED_THREAD_HISTORY_MAX_PLANS)
    .map((plan) => {
      const implementedAt =
        plan.implementedAt === null ? null : new Date(plan.implementedAt).toISOString();
      return {
        turnId: plan.turnId,
        planMarkdown: boundedText(plan.planMarkdown),
        createdAt: plan.createdAt,
        // A plan carried out after the picked reply counts as not carried out in the fork.
        implementedAt: implementedAt !== null && implementedAt <= boundaryAt ? implementedAt : null,
      };
    });
  const outcomeTurns = new Set<string>();
  const turnOutcomes = input.turnOutcomes.filter((outcome) => {
    if (
      outcome.turnId === boundary.turnId ||
      !replied.has(outcome.turnId) ||
      outcomeTurns.has(outcome.turnId)
    ) {
      return false;
    }
    outcomeTurns.add(outcome.turnId);
    return true;
  });
  const history: CarriedThreadHistory = {
    schemaVersion: 1,
    source: input.source,
    messages,
    proposedPlans,
    turnOutcomes,
    model: input.model,
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode,
    ...(input.tokenMode !== undefined ? { tokenMode: input.tokenMode } : {}),
  };
  if (utf8.encode(JSON.stringify(history)).length > CARRIED_THREAD_HISTORY_MAX_BYTES) {
    return { ok: false, reason: "too-large", message: CARRIED_FORK_COPY.tooLong };
  }
  return { ok: true, history };
}

/**
 * The turns of a source thread that did not complete, as far as a client knows: those its own
 * fork provenance records (a fork of a fork) and its latest turn. The source node is not asked;
 * an older interrupted turn it alone knows is carried as completed.
 */
export function carriedForkKnownTurnOutcomes(input: {
  readonly activities: OrchestrationThread["activities"];
  readonly latestTurn: Pick<OrchestrationLatestTurn, "turnId" | "state"> | null | undefined;
}): ReadonlyArray<CarriedThreadTurnOutcome> {
  const outcomes: CarriedThreadTurnOutcome[] = [];
  for (const activity of input.activities) {
    if (activity.kind !== THREAD_FORKED_ACTIVITY_KIND) continue;
    outcomes.push(...(readThreadForkedActivity(activity)?.inheritedTurnOutcomes ?? []));
  }
  const latest = input.latestTurn;
  if (latest && (latest.state === "interrupted" || latest.state === "error")) {
    outcomes.push({ turnId: latest.turnId, state: latest.state });
  }
  return outcomes;
}

/** Retained history while reading a source thread: the export's bounds. */
const READ_MAX_RECORDS = 20_000;
const READ_MAX_BYTES = 16 * 1024 * 1024;

const CARRIED_HISTORY_COPY: ThreadHistoryCopy = {
  cancelled: "Cancelled. Nothing was sent.",
  changed: CARRIED_FORK_COPY.sourceChanged,
  timedOut: "Reading the conversation timed out. Nothing was sent; reconnect and try again.",
  unsupported: "This machine can't hand over its full conversation. Update it, then try again.",
  stalled: "Reading the conversation stalled. Nothing was sent; try again.",
  overlapping: () => "The conversation changed while it was read. Nothing was sent; try again.",
  emptyPage: "Reading the conversation stalled. Nothing was sent; try again.",
};

export interface CarriedForkSourceRead {
  readonly thread: Pick<
    OrchestrationThread,
    | "id"
    | "title"
    | "modelSelection"
    | "runtimeMode"
    | "interactionMode"
    | "tokenMode"
    | "latestTurn"
  >;
  readonly messages: ReadonlyArray<SourceMessage>;
  readonly proposedPlans: ReadonlyArray<SourcePlan>;
  readonly turnOutcomes: ReadonlyArray<CarriedThreadTurnOutcome>;
}

/**
 * Reads the source thread's messages and proposed plans from its own node, at one projection
 * sequence (`collectThreadHistory`). Reads only; nothing is written there.
 */
export async function readCarriedForkSource(input: {
  readonly api: EnvironmentApi;
  readonly threadId: ThreadId;
  readonly signal: AbortSignal;
  readonly isCurrent: () => boolean;
}): Promise<CarriedForkSourceRead> {
  const messages: SourceMessage[] = [];
  const proposedPlans: SourcePlan[] = [];
  let bytes = 0;
  let records = 0;
  const retain = (text: string) => {
    bytes += 256 + text.length * 2;
    records += 1;
    if (bytes > READ_MAX_BYTES || records > READ_MAX_RECORDS) {
      throw new Error(CARRIED_FORK_COPY.tooLong);
    }
  };
  let turnOutcomes: ReadonlyArray<CarriedThreadTurnOutcome> = [];
  const thread = await collectThreadHistory({
    ...input,
    collections: ["messages", "proposedPlans"],
    copy: CARRIED_HISTORY_COPY,
    project: (raw) => {
      turnOutcomes = carriedForkKnownTurnOutcomes(raw);
      return {
        id: raw.id,
        title: raw.title,
        modelSelection: raw.modelSelection,
        runtimeMode: raw.runtimeMode,
        interactionMode: raw.interactionMode,
        ...(raw.tokenMode !== undefined ? { tokenMode: raw.tokenMode } : {}),
        latestTurn: raw.latestTurn,
      };
    },
    onItem: (entry) => {
      if (entry.collection === "messages") {
        const { id, role, text, turnId, createdAt, streaming } = entry.item;
        retain(text);
        messages.push({ id, role, text, turnId, createdAt, streaming });
      } else if (entry.collection === "proposedPlans") {
        const { id, turnId, planMarkdown, createdAt, implementedAt } = entry.item;
        retain(planMarkdown);
        proposedPlans.push({ id, turnId, planMarkdown, createdAt, implementedAt });
      }
    },
  });
  return { thread, messages, proposedPlans, turnOutcomes };
}

// ── Request ────────────────────────────────────────────────────────────

const isCarriedInput = Schema.is(ThreadForkCarriedInput);

/** The `threads.forkCarried` payload for a target, a destination and a carried conversation. */
export function buildCarriedForkInput(input: {
  readonly forkKey: ThreadForkKey;
  readonly target: Pick<CarriedForkTarget, "projectId">;
  readonly branch: CarriedForkBranch | null;
  readonly history: CarriedThreadHistory;
}): ThreadForkCarriedInput | null {
  let destination: ThreadForkCarriedDestination;
  if (input.target.projectId === null) {
    destination = { kind: "new-chat" };
  } else {
    if (input.branch?.kind !== "ready") return null;
    destination = {
      kind: "new-worktree",
      start: { kind: "base-ref", baseRef: input.branch.baseRef },
    };
  }
  const request: ThreadForkCarriedInput = {
    forkKey: input.forkKey,
    projectId: input.target.projectId,
    destination,
    history: input.history,
  };
  return isCarriedInput(request) ? request : null;
}

/**
 * The fork key of one carried attempt: the same source reply, target, destination and
 * conversation keep it, so Retry never creates a second fork; any change mints a new one. Kept
 * while the app runs, like the local fork's attempt.
 */
const carriedForkKeys = new Map<string, ThreadForkKey>();

export function carriedForkSignature(input: {
  readonly sourceEnvironmentId: EnvironmentId;
  readonly sourceThreadId: ThreadId;
  readonly sourceMessageId: MessageId;
  readonly targetEnvironmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly baseRef: string | null;
}): string {
  return [
    input.sourceEnvironmentId,
    input.sourceThreadId,
    input.sourceMessageId,
    input.targetEnvironmentId,
    input.projectId ?? "",
    input.baseRef ?? "",
  ].join("\u0000");
}

export function carriedForkKey(signature: string, mint: () => ThreadForkKey): ThreadForkKey {
  const known = carriedForkKeys.get(signature);
  if (known !== undefined) return known;
  const key = mint();
  carriedForkKeys.set(signature, key);
  return key;
}

/**
 * Drops the remembered key once a new attempt is safe: the fork exists (a retry would only
 * replay it), or the node holds nothing that a new key could duplicate.
 */
export function settleCarriedForkKey(signature: string, outcome: ThreadForkOutcome): void {
  if (
    outcome.status === "succeeded" ||
    (outcome.status === "failed" &&
      !outcome.retryable &&
      outcome.attempt !== "running" &&
      outcome.reason !== "idempotency-conflict")
  ) {
    carriedForkKeys.delete(signature);
  }
}

/** The one method a carried fork needs on the target. */
export interface CarriedForkApi {
  readonly forkCarried: (input: ThreadForkCarriedInput) => Promise<ThreadForkResult>;
}

export function readCarriedForkApi(api: EnvironmentApi | null | undefined): CarriedForkApi | null {
  const threads = api?.threads;
  return threads?.forkCarried ? (threads as CarriedForkApi) : null;
}

/**
 * Sends one carried fork to the target and classifies its outcome like `runThreadFork`; never
 * throws or retries. `assertMutationReady` (the target's reviewed send readiness) runs right
 * before sending.
 */
export async function runCarriedFork(input: {
  readonly api: CarriedForkApi;
  readonly input: ThreadForkCarriedInput;
  readonly assertMutationReady?: (() => void) | undefined;
}): Promise<ThreadForkOutcome> {
  try {
    input.assertMutationReady?.();
  } catch (error) {
    return {
      status: "refused",
      awaiting: true,
      message: THREAD_FORK_COPY.connectionChanged,
      error,
    };
  }
  try {
    return { status: "succeeded", result: await input.api.forkCarried(input.input) };
  } catch (error) {
    return classifyThreadForkError(error);
  }
}
