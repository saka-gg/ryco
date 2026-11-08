// FILE: agentControlExecutor.ts
// Purpose: The Agent Control client executor for `copyProjectToNode`
//          proposals: decides whether this client can run a proposal's copy
//          against its target, resolves what approving would do there for the
//          card to show first (the folder, the setup thread's model), and
//          approving accepts with `executeOnClient` (sent again with the same
//          executor when its answer is lost), waits until the node runs the
//          proposal (`executing`) and runs the copy through the app's copy
//          manager, which reports `started` / `completed` / `failed` to the
//          proposal's node; an approval whose copy can't start reports
//          `failed` instead. After a restart it rebuilds the plan of a copy
//          whose upload was cut off.
// Layer: Client runtime. Each app starts it with its reads and its copy
//        manager (`AgentControlCopyExecutorDeps`); the planning loads on first use.

import {
  agentControlClientExecutorRequiredLabel,
  type AgentControlClientExecutionCheck,
} from "../state/agentControl/index.ts";
import {
  projectCopyNodeRefusal,
  type AcquiredNode,
  type NodeCatalogSnapshot,
} from "../state/nodes/index.ts";
import type {
  AgentControlCopyProjectTarget,
  AgentControlCopyProjectToNodePlan,
  AgentControlProposalId,
  AgentControlProposalReceiptView,
  AgentControlProposalStatus,
  AgentControlProposalView,
  EnvironmentApi,
  EnvironmentId,
  ProjectId,
  ServerConfig,
} from "@ryco/contracts";
import {
  AGENT_CONTROL_TERMINAL_PROPOSAL_STATUSES,
  AgentControlClientExecutorId,
} from "@ryco/contracts/agent-control";
import { ExecutionEnvironmentPlatformOs } from "@ryco/contracts/environment";
import type { ProjectCopyJobRecord } from "./jobRecord.ts";
import type { ProjectCopyRunPlan } from "./plan.ts";
import { isTagged } from "effect/Predicate";
import * as Schema from "effect/Schema";

import { isAgentControlNodeAnswer } from "./agentControlReports.ts";
import type { AgentControlCopyResolution } from "./agentControlPlan.ts";
import type {
  AgentControlCopyStartHold,
  ManagedProjectCopy,
  ProjectCopyAgentControlContext,
  StartProjectCopyOptions,
} from "./manager.ts";

// ── The executor as a client's cards read it ──

/** One client-executed proposal of the node `environmentId` (the agent's node). */
export interface AgentControlClientExecutionInput {
  readonly environmentId: EnvironmentId;
  readonly proposal: AgentControlProposalView;
}

/**
 * What approving a client-executed proposal would do on its target, resolved
 * there before approval: the plan names the target's "default" folder and its
 * "default" model, this names the folder and the model.
 */
export interface AgentControlClientExecutionPreview {
  readonly targetLabel: string;
  /** The folder on the target; null when it could not be resolved. */
  readonly destination: {
    readonly path: string;
    /** "new folder", "empty folder", "renamed, folder exists" or "existing checkout". */
    readonly tag: string;
    /** How the folder was chosen, e.g. "Mac mini's code directory."; null when nothing to add. */
    readonly note: string | null;
  } | null;
  /**
   * What the copy sends when the plan's own words would mislead (a plain folder's files rather
   * than uncommitted changes); absent otherwise.
   */
  readonly sends?: string;
  /** The setup thread's model on the target; null when the request starts no thread. */
  readonly followUpModel: string | null;
  /** Why approving would fail now. Approving says the same and changes nothing. */
  readonly problem: string | null;
}

export type AgentControlClientExecutionPreviewState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly preview: AgentControlClientExecutionPreview };

/** Previews shared by every card of a proposal, resolved once each. */
export interface AgentControlClientExecutionPreviews {
  /** Starts resolving the proposal's preview, unless it has one or one is on its way. */
  readonly load: (input: AgentControlClientExecutionInput) => void;
  /** Null until `load` was called for it (or after it was dropped to be resolved again). */
  readonly read: (
    proposalId: AgentControlProposalId,
  ) => AgentControlClientExecutionPreviewState | null;
  readonly subscribe: (listener: () => void) => () => void;
}

/**
 * Runs client-executed Agent Control proposals (`copyProjectToNode`) from this
 * client: it accepts with `executeOnClient` and then runs the copy against the
 * target. Without one (mobile-like) every such card shows "Approve in Ryco on
 * a computer connected to <target>" in place of Approve.
 */
export interface AgentControlClientExecutor {
  /** Whether this client can run a client-executed plan against `target` now. */
  readonly canExecute: AgentControlClientExecutionCheck;
  /**
   * Approves the proposal and runs it here. Rejects with an `Error` whose
   * message the card shows.
   */
  readonly approve: (input: AgentControlClientExecutionInput) => Promise<void>;
  /**
   * What approving would do on the target, for the card to show before
   * Approve. Approving refuses when it would do something other than the
   * preview the card last showed.
   */
  readonly previews?: AgentControlClientExecutionPreviews;
}

/**
 * The app's executor, as `useAgentControlClientExecutor` reads it: it re-reads
 * `getExecutor()` whenever `subscribe` fires, so an executor whose answers
 * change (a node connected, the tier changed) hands out a new object then and
 * the cards re-render.
 */
export interface AgentControlCopyExecutorSource {
  readonly getExecutor: () => AgentControlClientExecutor;
  readonly subscribe: (listener: () => void) => () => void;
}

/** What the executor reads and calls; the app's by default, fakes in tests. */
export interface AgentControlCopyExecutorDeps {
  readonly readCatalog: () => NodeCatalogSnapshot;
  readonly subscribeCatalog: (listener: () => void) => () => void;
  /** The client's presentation tier; the web's frozen `phone` tier never runs copies (A2(4)). */
  readonly readTier: () => string;
  readonly subscribeTier: (listener: () => void) => () => void;
  /** The client reaches `environmentId` through the Hub, where writes need owner access. */
  readonly isHosted: (environmentId: EnvironmentId) => boolean;
  /** Holds a node to read from it (`acquireNode`, purpose `follow`); the caller releases it. */
  readonly acquireForRead: (environmentId: EnvironmentId, copyId: string) => Promise<AcquiredNode>;
  /** The node's server config: what its connection reported, else read from `node`. */
  readonly readServerConfig: (
    environmentId: EnvironmentId,
    node: AcquiredNode,
  ) => Promise<ServerConfig | null>;
  /** The project's `updatedAt` as this client last saw it; null when it does not know. */
  readonly readProjectUpdatedAt: (
    environmentId: EnvironmentId,
    projectId: ProjectId,
  ) => string | null;
  readonly readAgentControlApi: (environmentId: EnvironmentId) => EnvironmentApi["agentControl"];
  /**
   * Follows one proposal on its node's proposal stream (as the snapshot has it,
   * then every change); the returned function stops following.
   */
  readonly followProposal: (
    environmentId: EnvironmentId,
    proposalId: AgentControlProposalId,
    onProposal: (proposal: AgentControlProposalView) => void,
  ) => () => void;
  readonly startCopy: (options: StartProjectCopyOptions) => Promise<ManagedProjectCopy>;
  /**
   * Holds an approval from before its accept until its copy runs
   * (`copyManager.holdAgentControlCopyStart`), so a proposal the accept may
   * have bound to this executor is always ended, after a reload too.
   */
  readonly holdCopyStart: (
    context: ProjectCopyAgentControlContext,
  ) => Promise<AgentControlCopyStartHold>;
  readonly uuid: () => string;
  /** How long approving waits for the node to run the proposal. */
  readonly executingTimeoutMs: number;
  /** The first pause before an accept whose answer did not arrive is sent again; it doubles. */
  readonly acceptRetryDelayMs: number;
}

/** How long approving waits for the node to run the proposal, by default. */
export const AGENT_CONTROL_COPY_EXECUTING_TIMEOUT_MS = 30_000;
/** The first pause before an unanswered accept is sent again, by default; it doubles. */
export const AGENT_CONTROL_COPY_ACCEPT_RETRY_DELAY_MS = 1_000;
/** Accepts sent with one executor before approving gives up (the node may still have bound it). */
const ACCEPT_ATTEMPTS = 4;

// ── Shared rules ──

const isPlatformOs = Schema.is(ExecutionEnvironmentPlatformOs);
const TERMINAL_STATUSES: ReadonlySet<AgentControlProposalStatus> = new Set(
  AGENT_CONTROL_TERMINAL_PROPOSAL_STATUSES,
);

function copyPlanOf(proposal: AgentControlProposalView): AgentControlCopyProjectToNodePlan {
  if (proposal.plan.kind !== "copyProjectToNode") {
    throw new Error("This request is not one this app runs.");
  }
  return proposal.plan;
}

/**
 * Whether this client can run a copy against `target`: never on the phone
 * tier (A2(4)); otherwise the target must be in this client's own catalog
 * (A24), not refuse copies, and be a node this client may write to or try to
 * connect to (`projectCopyNodeRefusal`, the rule acquiring it applies).
 */
export function canExecuteAgentControlCopy(
  deps: Pick<AgentControlCopyExecutorDeps, "readCatalog" | "readTier" | "isHosted">,
  target: AgentControlCopyProjectTarget,
): boolean {
  if (deps.readTier() === "phone") return false;
  const catalog = deps.readCatalog();
  const node = catalog.nodes.find((entry) => entry.environmentId === target.environmentId);
  if (!node || node.projectCopySupport === "no") return false;
  return (
    projectCopyNodeRefusal(node, {
      hosted: deps.isHosted(node.environmentId),
      owner: catalog.ownerEnvironmentIds.has(node.environmentId),
    }) === null
  );
}

/** A resolution, and whether it failed because a node did not answer. */
type ExecutorResolution = AgentControlCopyResolution & { readonly unreachable?: boolean };

const unresolved = (
  targetLabel: string,
  problem: string,
  unreachable = false,
): ExecutorResolution => ({
  ok: false,
  preview: { targetLabel, destination: null, followUpModel: null, problem },
  unreachable,
});

const errorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;

/**
 * Reads the proposal's two nodes and plans its copy (`agentControlCopyPlan`):
 * the target is resolved in this client's own catalog only (A24), and a
 * project source must not have changed since the agent asked.
 */
async function resolveAgentControlCopyWith(
  deps: AgentControlCopyExecutorDeps,
  input: AgentControlClientExecutionInput,
): Promise<ExecutorResolution> {
  const { environmentId, proposal } = input;
  const plan = copyPlanOf(proposal);
  const target = plan.target;
  const catalog = deps.readCatalog();
  const targetEntry = catalog.nodes.find((node) => node.environmentId === target.environmentId);
  if (!targetEntry) {
    return unresolved(target.label, `${target.label} is not a device Ryco knows here.`, true);
  }
  const sourceEntry = catalog.nodes.find((node) => node.environmentId === environmentId);
  const sourceLabel = sourceEntry?.label ?? "the agent's device";
  if (plan.source.kind === "project") {
    // The node checks this again on accept; a project already newer here fails early.
    const updatedAt = deps.readProjectUpdatedAt(environmentId, plan.source.projectId);
    if (updatedAt !== null && Date.parse(updatedAt) > Date.parse(plan.source.expectedUpdatedAt)) {
      return unresolved(
        target.label,
        `${plan.source.title} changed on ${sourceLabel} since the agent asked. Ask it again.`,
      );
    }
  }

  const planner = await import("./agentControlPlan.ts");
  const copyId = deps.uuid();
  const [targetHold, sourceHold] = await Promise.allSettled([
    deps.acquireForRead(target.environmentId, copyId),
    plan.source.kind === "project" ? deps.acquireForRead(environmentId, copyId) : null,
  ]);
  const holds = [targetHold, sourceHold].flatMap((hold) =>
    hold.status === "fulfilled" && hold.value !== null ? [hold.value] : [],
  );
  try {
    if (targetHold.status === "rejected") {
      return unresolved(
        target.label,
        errorMessage(targetHold.reason, `${target.label} did not answer.`),
        true,
      );
    }
    if (sourceHold.status === "rejected") {
      return unresolved(
        target.label,
        errorMessage(sourceHold.reason, `${sourceLabel} did not answer.`),
        true,
      );
    }
    const targetNode = targetHold.value;
    const sourceNode = sourceHold.value;
    // Connected now, the node's own descriptor says whether it copies.
    const support =
      deps.readCatalog().nodes.find((node) => node.environmentId === target.environmentId)
        ?.projectCopySupport ?? targetEntry.projectCopySupport;
    return await planner.resolveAgentControlCopy({
      plan,
      proposalId: proposal.proposalId,
      source: {
        environmentId,
        label: sourceLabel,
        platformOs: isPlatformOs(sourceEntry?.platformOs) ? sourceEntry.platformOs : null,
        transport: sourceNode?.transport ?? sourceEntry?.transport ?? null,
        api: sourceNode?.api ?? null,
      },
      target: {
        environmentId: target.environmentId,
        label: target.label,
        platformOs: isPlatformOs(targetEntry.platformOs) ? targetEntry.platformOs : null,
        transport: targetNode.transport,
        api: targetNode.api,
        projectCopySupport:
          support === "no" ? "no" : targetNode.api.projects.pathHints ? "yes" : "no",
      },
      readTargetConfig: () => deps.readServerConfig(target.environmentId, targetNode),
    });
  } catch (error) {
    return unresolved(target.label, errorMessage(error, `${target.label} did not answer.`), true);
  } finally {
    for (const hold of holds) hold.release();
  }
}

type AgentControlApi = NonNullable<EnvironmentApi["agentControl"]>;

/** The proposal ended (failed, rejected, expired) before its copy could start; nothing runs for it. */
class AgentControlProposalEndedError extends Error {}

/**
 * The node judged an accept: its Agent Control answer (except a storage
 * failure, which may come after the decision committed) or an auth refusal.
 * Nothing else tells whether the accept arrived.
 */
const isDefiniteAcceptAnswer = (error: unknown): boolean =>
  isAgentControlNodeAnswer(error) || isTagged(error, "AuthRpcError");

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    globalThis.setTimeout(() => resolve(), Math.max(0, ms));
  });

/**
 * Accepts with this approval's executor. An answer that did not arrive (a
 * relay drop, a reconnect) or a storage failure is sent again with the same
 * executor, through the node's current connection: the node then answers with
 * the proposal it already bound to it, or finishes binding one a failure left
 * `approved` (A1(2)). Only the node's own answer, or running out of attempts,
 * ends it early.
 */
async function acceptWithExecutor(
  deps: AgentControlCopyExecutorDeps,
  input: {
    readonly environmentId: EnvironmentId;
    readonly proposalId: AgentControlProposalId;
    readonly executorId: AgentControlClientExecutorId;
    readonly api: AgentControlApi;
  },
): Promise<AgentControlProposalReceiptView> {
  for (let attempt = 1; ; attempt += 1) {
    const api = deps.readAgentControlApi(input.environmentId) ?? input.api;
    try {
      return await api.acceptProposal({
        proposalId: input.proposalId,
        executeOnClient: { executorId: input.executorId },
      });
    } catch (error) {
      if (isDefiniteAcceptAnswer(error) || attempt >= ACCEPT_ATTEMPTS) throw error;
      await sleep(deps.acceptRetryDelayMs * 2 ** (attempt - 1));
    }
  }
}

/**
 * Resolves once the node runs the proposal (`executing`), as its accept
 * receipt or its proposal stream says first. A terminal status fails with the
 * node's reason (`AgentControlProposalEndedError`); after the timeout the node
 * is asked once, and a proposal a crash left `approved` is accepted again with
 * the same executor, which makes the node finish binding it (A1(2)).
 */
async function waitForExecuting(
  deps: AgentControlCopyExecutorDeps,
  input: {
    readonly environmentId: EnvironmentId;
    readonly proposalId: AgentControlProposalId;
    readonly receipt: AgentControlProposalReceiptView;
    readonly api: AgentControlApi;
    readonly executorId: AgentControlClientExecutorId;
  },
): Promise<void> {
  const { environmentId, proposalId } = input;
  const settled = (
    status: AgentControlProposalStatus,
    result: AgentControlProposalReceiptView["result"],
  ): "executing" | Error | null => {
    if (status === "executing") return "executing";
    if (!TERMINAL_STATUSES.has(status)) return null;
    return new AgentControlProposalEndedError(
      result?.outcome === "failed"
        ? result.error.message
        : `The request was ${status} before the copy could start.`,
    );
  };
  let outcome = settled(input.receipt.status, input.receipt.result);
  if (outcome === null) {
    outcome = await new Promise<"executing" | Error | null>((resolve) => {
      let finished = false;
      let stop: (() => void) | null = null;
      const finish = (value: "executing" | Error | null) => {
        if (finished) return;
        finished = true;
        globalThis.clearTimeout(timer);
        stop?.();
        resolve(value);
      };
      const timer = globalThis.setTimeout(() => finish(null), deps.executingTimeoutMs);
      const unsubscribe = deps.followProposal(environmentId, proposalId, (proposal) => {
        const next = settled(proposal.status, proposal.result);
        if (next !== null) finish(next);
      });
      // The stream may have answered while subscribing.
      if (finished) unsubscribe();
      else stop = unsubscribe;
    });
  }
  if (outcome === null) {
    // The stream said nothing in time: ask the node, finishing a bind a crash cut short.
    const api = deps.readAgentControlApi(environmentId) ?? input.api;
    const current = (await api.getProposal({ proposalId })).proposal;
    if (current?.status === "approved") {
      const again = await acceptWithExecutor(deps, { ...input, api });
      outcome = settled(again.status, again.result);
    } else if (current) {
      outcome = settled(current.status, current.result);
    }
  }
  if (outcome === "executing") return;
  throw outcome ?? new Error("The request did not start in time. Check it on its device.");
}

// ── Executor ──

/** Called once, the first time the executor is needed; lives for the app's lifetime. */
export function startAgentControlCopyExecutor(
  deps: AgentControlCopyExecutorDeps,
): AgentControlCopyExecutorSource {
  const listeners = new Set<() => void>();

  // ── Previews ──
  interface PreviewEntry {
    readonly state: AgentControlClientExecutionPreviewState;
    /**
     * Set when the target did not answer: the preview is resolved again once
     * the target comes online (not on every change, so a node that keeps
     * failing is not asked in a loop).
     */
    readonly retry: { readonly target: EnvironmentId; readonly wasOnline: boolean } | null;
  }
  const previewEntries = new Map<AgentControlProposalId, PreviewEntry>();
  const previewListeners = new Set<() => void>();
  const notifyPreviews = () => {
    for (const listener of Array.from(previewListeners)) listener();
  };
  const setPreview = (proposalId: AgentControlProposalId, entry: PreviewEntry | null) => {
    if (entry === null) previewEntries.delete(proposalId);
    else previewEntries.set(proposalId, entry);
    notifyPreviews();
  };
  const isOnline = (environmentId: EnvironmentId) =>
    deps
      .readCatalog()
      .nodes.some((node) => node.environmentId === environmentId && node.presence === "online");
  const ready = (
    preview: AgentControlClientExecutionPreview,
    proposal: AgentControlProposalView,
    unreachable: boolean | undefined,
  ): PreviewEntry => {
    const target =
      unreachable === true && proposal.plan.kind === "copyProjectToNode"
        ? proposal.plan.target.environmentId
        : null;
    return {
      state: { status: "ready", preview },
      retry: target === null ? null : { target, wasOnline: isOnline(target) },
    };
  };

  const previews: AgentControlClientExecutionPreviews = {
    load: (input) => {
      const { proposalId } = input.proposal;
      if (previewEntries.has(proposalId)) return;
      const entry: PreviewEntry = { state: { status: "loading" }, retry: null };
      setPreview(proposalId, entry);
      void resolveAgentControlCopyWith(deps, input)
        .catch((error: unknown) =>
          unresolved(
            input.proposal.plan.kind === "copyProjectToNode"
              ? input.proposal.plan.target.label
              : "the target",
            errorMessage(error, "The target did not answer."),
          ),
        )
        .then((resolution) => {
          // A newer load or an approval replaced it meanwhile.
          if (previewEntries.get(proposalId) !== entry) return;
          setPreview(proposalId, ready(resolution.preview, input.proposal, resolution.unreachable));
        });
    },
    read: (proposalId) => previewEntries.get(proposalId)?.state ?? null,
    subscribe: (listener) => {
      previewListeners.add(listener);
      return () => {
        previewListeners.delete(listener);
      };
    },
  };

  /** Drops the previews whose target did not answer and is online now, to resolve them again. */
  const dropReachablePreviews = () => {
    let dropped = false;
    for (const [proposalId, entry] of previewEntries) {
      if (entry.retry !== null && !entry.retry.wasOnline && isOnline(entry.retry.target)) {
        previewEntries.delete(proposalId);
        dropped = true;
      }
    }
    if (dropped) notifyPreviews();
  };

  // ── Approving ──
  const canExecute = (target: AgentControlCopyProjectTarget) =>
    canExecuteAgentControlCopy(deps, target);

  const approve = async (input: AgentControlClientExecutionInput): Promise<void> => {
    const { environmentId, proposal } = input;
    const { proposalId } = proposal;
    const plan = copyPlanOf(proposal);
    if (proposal.status !== "pending-user-approval") {
      throw new Error("This request is no longer waiting for approval.");
    }
    if (!canExecute(plan.target)) {
      throw new Error(agentControlClientExecutorRequiredLabel(plan.target));
    }
    const shown = previews.read(proposalId);
    const resolution = await resolveAgentControlCopyWith(deps, input);
    setPreview(proposalId, ready(resolution.preview, proposal, resolution.unreachable));
    if (!resolution.ok) {
      throw new Error(resolution.preview.problem ?? "The copy can't run as asked.");
    }
    // The user approves what the card showed; anything else is shown first.
    const { sameAgentControlCopyPreview } = await import("./agentControlPlan.ts");
    if (
      shown?.status !== "ready" ||
      !sameAgentControlCopyPreview(shown.preview, resolution.preview)
    ) {
      throw new Error(
        `Check where the copy goes on ${plan.target.label} (updated above), then approve again.`,
      );
    }

    const api = deps.readAgentControlApi(environmentId);
    if (!api) throw new Error("The agent's device is not connected here.");
    // One executor for this approval: every accept it sends carries it (A1(2)).
    const executorId = AgentControlClientExecutorId.make(deps.uuid());
    const context: ProjectCopyAgentControlContext = { environmentId, proposalId, executorId };
    // From the accept on, the node may run the proposal for this executor, so
    // the hold makes every way out end it rather than its 2 h deadline.
    const hold = await deps.holdCopyStart(context);
    try {
      const receipt = await acceptWithExecutor(deps, {
        environmentId,
        proposalId,
        executorId,
        api,
      });
      await waitForExecuting(deps, { environmentId, proposalId, receipt, api, executorId });
      await deps.startCopy({ plan: resolution.runPlan, agentControl: context });
    } catch (error) {
      if (isDefiniteAcceptAnswer(error) || error instanceof AgentControlProposalEndedError) {
        // The node refused the accept, or ended the proposal: nothing runs for this executor.
        hold.release();
        throw error;
      }
      const message = errorMessage(error, "The copy did not start.");
      hold.reportNotStarted(message);
      throw new Error(message, { cause: error });
    }
    // The copy's own record carries the executor now.
    hold.release();
    setPreview(proposalId, null);
  };

  // ── Generations ──
  let tier = deps.readTier();
  let catalog = deps.readCatalog();
  let executor: AgentControlClientExecutor = { canExecute, approve, previews };
  const refresh = () => {
    const nextTier = deps.readTier();
    const nextCatalog = deps.readCatalog();
    if (nextTier === tier && nextCatalog === catalog) return;
    tier = nextTier;
    catalog = nextCatalog;
    // `canExecute` reads the catalog when called; a new object makes the cards ask again.
    executor = { canExecute, approve, previews };
    dropReachablePreviews();
    for (const listener of Array.from(listeners)) listener();
  };
  deps.subscribeCatalog(refresh);
  deps.subscribeTier(refresh);

  return {
    getExecutor: () => executor,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

// ── Resume ──

/**
 * After a reload: the plan of an Agent Control copy whose upload (or import
 * request) did not finish, rebuilt from its proposal while the node still runs
 * it (`executing`, the same target). Null otherwise, and the copy then cleans
 * up and reports `failed`.
 */
export async function rebuildAgentControlCopyPlanWith(
  deps: AgentControlCopyExecutorDeps,
  record: ProjectCopyJobRecord,
  context: ProjectCopyAgentControlContext,
): Promise<ProjectCopyRunPlan | null> {
  const hold = await deps.acquireForRead(context.environmentId, deps.uuid());
  let proposal: AgentControlProposalView | null;
  try {
    const getProposal = hold.api.agentControl?.getProposal;
    if (!getProposal) return null;
    proposal = (await getProposal({ proposalId: context.proposalId })).proposal;
  } finally {
    hold.release();
  }
  if (
    proposal === null ||
    proposal.status !== "executing" ||
    proposal.plan.kind !== "copyProjectToNode" ||
    proposal.plan.target.environmentId !== record.targetEnvironmentId
  ) {
    return null;
  }
  const resolution = await resolveAgentControlCopyWith(deps, {
    environmentId: context.environmentId,
    proposal,
  });
  return resolution.ok ? resolution.runPlan : null;
}
