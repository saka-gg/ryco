// FILE: agentControlCopyPlan.ts
// Purpose: Turns a `copyProjectToNode` proposal into the run plan the copy
//          coordinator executes, and into the preview its card shows before
//          Approve: the destination resolved on the target (its path hints
//          and destination previews), the setup thread's model resolved from
//          the target's config, and why the copy can't run as approved. The
//          plan's options are applied exactly: nothing beyond what the user
//          approves is sent, and the setup command is the approved one (A18).
// Layer: Web Agent Control executor, loaded with `agentControlCopyExecutor`'s
//        first preview or approval. `planAgentControlCopy` is pure;
//        `resolveAgentControlCopy` reads the two nodes through their APIs.

import {
  buildProjectCopyRunPlan,
  copyDestinationCandidate,
  judgeCopyDestination,
  nodePathBasename,
  planProjectCopyOptions,
  projectCopySourceCanonicalKey,
  repositoryFolderName,
  resolveCopyDestination,
  resolveFollowUpModelSelection,
  type CopyDestinationRequest,
  type CopyDestinationSuggestion,
  type ProjectCopyChoices,
  type ProjectCopyOptionsPlan,
  type ProjectCopyRunPlan,
  type ProjectCopySourceFacts,
  type ProjectCopySupport,
  type ProjectCopyTargetFacts,
  type ProjectCopyTransport,
} from "@ryco/client-runtime/projectCopy";
import type {
  AgentControlCopyProjectToNodePlan,
  EnvironmentApi,
  EnvironmentId,
  ExecutionEnvironmentPlatformOs,
  ModelSelection,
  ServerConfig,
} from "@ryco/contracts";
import {
  ProjectImportFollowUpThread,
  ProjectImportSetup,
  type NodePathHints,
  type ProjectCheckRemoteAccessResult,
  type ProjectDestinationPreview,
  type ProjectDestinationPreviewInput,
  type ProjectExportInspection,
} from "@ryco/contracts/project-copy";
import { getModelDisplayName } from "@ryco/shared/model";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { deriveProviderInstanceEntries } from "../../providerInstances";
import type { AgentControlClientExecutionPreview } from "../agent-control/agentControlClientExecutor";

// ── Facts ──

/** A node of the copy as the executor read it. */
export interface AgentControlCopyNodeFacts {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly platformOs: ExecutionEnvironmentPlatformOs | null;
  /** Null while not connected. */
  readonly transport: ProjectCopyTransport | null;
}

/** Everything the run plan and the preview are made from, read from the two nodes. */
export interface AgentControlCopyFacts {
  readonly plan: AgentControlCopyProjectToNodePlan;
  readonly proposalId: string;
  /** The proposal's node: the agent's, and a project source's. */
  readonly source: AgentControlCopyNodeFacts;
  /** `projects.exportInspect` of a project source; null for a repository source. */
  readonly inspection: ProjectExportInspection | null;
  readonly target: AgentControlCopyNodeFacts & {
    readonly projectCopySupport: ProjectCopySupport;
  };
  readonly targetPathSeparator: NodePathHints["pathSeparator"];
  readonly remoteAccess: ProjectCheckRemoteAccessResult | null;
  /** Null when the plan's destination names no folder. */
  readonly destination: CopyDestinationSuggestion | null;
  /** The target's server config, for the setup thread's default model. */
  readonly targetConfig: Pick<ServerConfig, "providers" | "settings"> | null;
}

export type AgentControlCopyResolution =
  | {
      readonly ok: true;
      readonly runPlan: ProjectCopyRunPlan;
      readonly preview: AgentControlClientExecutionPreview;
    }
  | { readonly ok: false; readonly preview: AgentControlClientExecutionPreview };

/** The plan's source as the coordinator's planning sees it; null for a project not read yet. */
export function agentControlCopySourceFacts(
  facts: Pick<AgentControlCopyFacts, "plan" | "inspection" | "source">,
): ProjectCopySourceFacts | null {
  const { plan, inspection, source } = facts;
  if (plan.source.kind === "repository") {
    return { kind: "repository", remoteUrl: plan.source.remoteUrl, title: plan.source.title };
  }
  if (inspection === null) return null;
  return {
    kind: "inspected",
    environmentId: source.environmentId,
    label: source.label,
    platformOs: source.platformOs,
    transport: source.transport,
    checkoutPath: null,
    inspection,
  };
}

// ── Destination ──

/** A project source's repository root, in its own node's separator. */
export interface AgentControlCopySourceRepository {
  readonly rootPath: string;
  readonly pathSeparator: NodePathHints["pathSeparator"];
}

/**
 * Where the plan's destination points on the target: the agent's `default`
 * and `child-of-default` go into the target's default project directory (A35,
 * placement `default`), named after the source repository or by the agent; a
 * `path` is taken as given.
 */
export function agentControlCopyDestinationRequest(input: {
  readonly plan: AgentControlCopyProjectToNodePlan;
  readonly sourceRepository: AgentControlCopySourceRepository | null;
  readonly targetHints: NodePathHints;
}):
  | { readonly kind: "candidate"; readonly request: CopyDestinationRequest }
  | { readonly kind: "path"; readonly path: string } {
  const { plan, sourceRepository, targetHints } = input;
  const destination = plan.destination;
  if (destination.kind === "path") return { kind: "path", path: destination.path };
  const leafName =
    destination.kind === "child-of-default"
      ? destination.name
      : plan.source.kind === "repository"
        ? repositoryFolderName(plan.source.remoteUrl)
        : sourceRepository === null
          ? null
          : nodePathBasename(sourceRepository.rootPath, sourceRepository.pathSeparator);
  return {
    kind: "candidate",
    request: {
      sourceRoot: null,
      sourceHints: null,
      destHints: targetHints,
      leafName,
      placement: "default",
    },
  };
}

/** Previews the plan's destination on the target and judges it for this source. */
export async function resolveAgentControlCopyDestination(input: {
  readonly plan: AgentControlCopyProjectToNodePlan;
  readonly sourceRepository: AgentControlCopySourceRepository | null;
  readonly targetHints: NodePathHints;
  readonly sourceCanonicalKey: string | null;
  readonly preview: (input: ProjectDestinationPreviewInput) => Promise<ProjectDestinationPreview>;
}): Promise<CopyDestinationSuggestion | null> {
  const where = agentControlCopyDestinationRequest(input);
  if (where.kind === "path") {
    return judgeCopyDestination({
      preview: await input.preview({ path: where.path }),
      sourceCanonicalKey: input.sourceCanonicalKey,
    });
  }
  if (copyDestinationCandidate(where.request).leaf === null) return null;
  return resolveCopyDestination(where.request, {
    preview: input.preview,
    sourceCanonicalKey: input.sourceCanonicalKey,
  });
}

// ── Options ──

/**
 * The plan's options as copy choices. Ignored files are never opted in (an
 * agent can't ask for them); the avatar is part of the project settings. A
 * checkout of the same repository at the destination is linked (A27).
 */
export function agentControlCopyRequestedChoices(
  plan: AgentControlCopyProjectToNodePlan,
  destination: CopyDestinationSuggestion | null,
): Partial<ProjectCopyChoices> {
  return {
    mode: destination?.status === "link" ? "link" : "clone",
    bringCommits: plan.bringCommits,
    bringChanges: plan.bringChanges,
    ignoredPaths: [],
    copySettings: plan.copySettings,
    copyAvatar: plan.copySettings,
  };
}

/** An agent's copy only clones; sending the files is the copy dialog's to offer. */
const sendFilesInstead = (reason: string): string =>
  /send the files/iu.test(reason)
    ? `${reason} Copy it from the Projects page to do that.`
    : `${reason} Copy it from the Projects page to send the files instead.`;

const cantBring = (what: string, reason: string | null): string =>
  reason === null ? `Can't bring ${what}.` : `Can't bring ${what}: ${reason}`;

/**
 * Why the copy can't run exactly as approved, or null. Something the plan
 * asks for that is simply absent (no unpushed commits, no changes) is not a
 * problem; something it can't send is, and so is anything it would have to
 * send beyond the plan (the whole repository, commits the plan leaves out).
 */
export function agentControlCopyOptionsProblem(input: {
  readonly plan: AgentControlCopyProjectToNodePlan;
  readonly options: ProjectCopyOptionsPlan;
  readonly inspection: ProjectExportInspection | null;
  readonly remoteAccess: ProjectCheckRemoteAccessResult | null;
  readonly targetLabel: string;
}): string | null {
  const { plan, options, inspection, targetLabel } = input;
  if (options.blockedReason !== null) return options.blockedReason;
  const { choices, modes } = options;
  if (choices.mode === "send-files") {
    return sendFilesInstead(modes.clone.reason ?? `${targetLabel} can't clone it.`);
  }
  if (choices.mode === "clone" && modes.clone.reachable === false) {
    const detail = input.remoteAccess?.detail ?? null;
    return sendFilesInstead(
      `${targetLabel} can't reach the remote${detail === null ? "." : ` (${detail}).`}`,
    );
  }
  if (
    plan.bringCommits &&
    !choices.bringCommits &&
    (inspection?.pushedState.unpushedCommitCount ?? 0) > 0
  ) {
    return cantBring("the unpushed commits", options.bringCommits.reason);
  }
  if (!plan.bringCommits && choices.bringCommits) {
    return "The uncommitted changes need the unpushed commits, which this request does not bring.";
  }
  const workingTree = inspection?.workingTree;
  const changeCount = (workingTree?.trackedChangeCount ?? 0) + (workingTree?.untrackedCount ?? 0);
  if (plan.bringChanges && !choices.bringChanges && changeCount > 0) {
    return cantBring("the uncommitted changes", options.bringChanges.reason);
  }
  // Another branch is checked out from the remote; the changes belong to the source's own.
  const sourceBranch = inspection?.repository.branch ?? null;
  if (
    plan.branch != null &&
    choices.mode !== "link" &&
    plan.bringChanges &&
    changeCount > 0 &&
    plan.source.kind === "project" &&
    plan.branch !== sourceBranch
  ) {
    return `The uncommitted changes are on ${sourceBranch ?? "a detached HEAD"}, not ${plan.branch}; they can't come along to another branch.`;
  }
  if (plan.copySettings && !choices.copySettings) {
    return cantBring("the project settings", options.copySettings.reason);
  }
  return null;
}

// ── Setup and the setup thread ──

const decodeSetup = Schema.decodeUnknownOption(ProjectImportSetup);
const isImportFollowUpThread = Schema.is(ProjectImportFollowUpThread);

/**
 * Null when the setup the run plan sends is the approved one, as the target
 * decodes it; why not otherwise. The executor never sends a command other than
 * the one the card showed (A18).
 */
export function agentControlSetupMismatch(
  approved: AgentControlCopyProjectToNodePlan["setup"],
  sent: ProjectCopyRunPlan["setup"],
): string | null {
  if (approved === null && sent === null) return null;
  const decoded = sent === null ? null : Option.getOrNull(decodeSetup(sent));
  if (
    approved !== null &&
    decoded !== null &&
    decoded.command === approved.command &&
    decoded.saveAsScript === approved.saveAsScript
  ) {
    return null;
  }
  return "The setup command this copy would run differs from the approved one, so nothing was run.";
}

/** "Opus 5.5 · Claude": the model's name and the provider instance it runs on, on the target. */
export function followUpModelLabel(
  selection: ModelSelection,
  config: Pick<ServerConfig, "providers"> | null,
): string {
  const entry = config
    ? deriveProviderInstanceEntries(config.providers).find(
        (candidate) => candidate.instanceId === selection.instanceId,
      )
    : undefined;
  const model = entry?.models.find((candidate) => candidate.slug === selection.model);
  const name = model ? getModelDisplayName(model) : selection.model;
  return entry ? `${name} · ${entry.displayName}` : name;
}

// ── Plan ──

function destinationPreview(
  destination: CopyDestinationSuggestion | null,
  targetLabel: string,
): AgentControlClientExecutionPreview["destination"] {
  if (destination === null) return null;
  const chosenBy =
    destination.basis === "explicit"
      ? "The folder the agent asked for."
      : `${targetLabel}'s code directory.`;
  switch (destination.status) {
    case "available":
      return {
        path: destination.path,
        tag: destination.preview.state === "exists-empty" ? "empty folder" : "new folder",
        note: chosenBy,
      };
    case "renamed":
      return {
        path: destination.path,
        tag: "renamed, folder exists",
        note: `${destination.takenPath ?? "The folder"} is taken on ${targetLabel}.`,
      };
    case "link":
      return {
        path: destination.path,
        tag: "existing checkout",
        note: "A checkout of this repository is already there; it becomes the project as it is.",
      };
    case "existing-project":
    case "blocked":
      return { path: destination.path, tag: "unavailable", note: null };
  }
}

/**
 * The run plan for a `copyProjectToNode` proposal and the preview its card
 * shows, from what the executor read on the two nodes. Fails, with the
 * preview naming why, whenever the copy would not do exactly what the plan
 * says: an option it can't honour, a folder it can't use, a setup thread
 * with no model, a setup command that would change on the way.
 */
export function planAgentControlCopy(facts: AgentControlCopyFacts): AgentControlCopyResolution {
  const { plan, target, targetConfig } = facts;
  const source = agentControlCopySourceFacts(facts);
  const preview: AgentControlClientExecutionPreview = {
    targetLabel: target.label,
    destination: destinationPreview(facts.destination, target.label),
    followUpModel: null,
    problem: null,
  };
  if (source === null) {
    return {
      ok: false,
      preview: {
        ...preview,
        problem: `${plan.source.title} could not be read on ${facts.source.label}.`,
      },
    };
  }
  const planning = {
    source,
    target: {
      label: target.label,
      platformOs: target.platformOs,
      projectCopySupport: target.projectCopySupport,
      transport: target.transport,
      remoteAccess: facts.remoteAccess,
      destination: facts.destination,
    } satisfies ProjectCopyTargetFacts,
  };
  const options = planProjectCopyOptions(
    planning,
    agentControlCopyRequestedChoices(plan, facts.destination),
  );

  let problem =
    facts.destination === null
      ? `No folder name follows from ${plan.source.title}; the agent has to name one.`
      : agentControlCopyOptionsProblem({
          plan,
          options,
          inspection: facts.inspection,
          remoteAccess: facts.remoteAccess,
          targetLabel: target.label,
        });
  let followUpModel: string | null = null;
  let followUpThread: ProjectCopyRunPlan["followUpThread"] = null;
  if (plan.followUpThread !== null) {
    // Null takes the target's default, which the card shows before Approve (A19).
    const modelSelection =
      plan.followUpThread.modelSelection ?? resolveFollowUpModelSelection(targetConfig);
    if (modelSelection === null) {
      problem ??= `No agent provider is ready on ${target.label}, so the setup thread can't start.`;
    } else {
      followUpModel = followUpModelLabel(modelSelection, targetConfig);
      const thread = {
        title: plan.followUpThread.title,
        prompt: plan.followUpThread.prompt,
        runtimeMode: plan.followUpThread.runtimeMode,
        envMode: plan.followUpThread.envMode,
        modelSelection,
      };
      if (isImportFollowUpThread(thread)) followUpThread = thread;
      else problem ??= `The setup thread's title or prompt is too long for ${target.label}.`;
    }
  }
  const resolved = { ...preview, followUpModel, problem };
  if (problem !== null) return { ok: false, preview: resolved };

  const built = buildProjectCopyRunPlan({
    planning,
    options,
    target: { environmentId: target.environmentId, pathSeparator: facts.targetPathSeparator },
    title: plan.source.title,
    setup: plan.setup,
    followUpThread,
    checkoutBranch: plan.branch ?? null,
    origin: {
      kind: "agent-control",
      sourceLabel: facts.source.label,
      proposalId: facts.proposalId,
    },
  });
  if (!built.ok) return { ok: false, preview: { ...resolved, problem: built.reason } };
  const mismatch = agentControlSetupMismatch(plan.setup, built.plan.setup);
  if (mismatch !== null) return { ok: false, preview: { ...resolved, problem: mismatch } };
  // A clone the target can't reach is never retried by sending the whole repository.
  return { ok: true, runPlan: { ...built.plan, sendFilesFallback: false }, preview: resolved };
}

/** Whether a preview still says what another one said. */
export function sameAgentControlCopyPreview(
  left: AgentControlClientExecutionPreview,
  right: AgentControlClientExecutionPreview,
): boolean {
  return (
    left.targetLabel === right.targetLabel &&
    left.followUpModel === right.followUpModel &&
    left.problem === right.problem &&
    left.destination?.path === right.destination?.path &&
    left.destination?.tag === right.destination?.tag
  );
}

// ── Reading the nodes ──

/** A node's API as the executor holds it for reading. */
export interface AgentControlCopyNodeReader extends AgentControlCopyNodeFacts {
  readonly api: EnvironmentApi;
}

function need<T>(member: T | undefined, label: string): T {
  if (member === undefined) throw new Error(`Update Ryco on ${label} to copy projects.`);
  return member;
}

/**
 * Reads what planning needs from the two nodes and plans: the source's
 * inspection and path separator, the target's path hints, remote access,
 * destination preview and config. Rejects with a message the card can show
 * when a node does not answer.
 */
export async function resolveAgentControlCopy(input: {
  readonly plan: AgentControlCopyProjectToNodePlan;
  readonly proposalId: string;
  /** The proposal's node; a repository source reads nothing there (`api` null). */
  readonly source: AgentControlCopyNodeFacts & { readonly api: EnvironmentApi | null };
  readonly target: AgentControlCopyNodeReader & {
    readonly projectCopySupport: ProjectCopySupport;
  };
  readonly readTargetConfig: () => Promise<ServerConfig | null>;
}): Promise<AgentControlCopyResolution> {
  const { plan, proposalId, source, target } = input;
  if (target.projectCopySupport === "no") {
    return {
      ok: false,
      preview: {
        targetLabel: target.label,
        destination: null,
        followUpModel: null,
        problem: `Update Ryco on ${target.label} to copy projects here.`,
      },
    };
  }
  const targetProjects = target.api.projects;
  const pathHints = need(targetProjects.pathHints, target.label);
  const previewDestination = need(targetProjects.previewDestination, target.label);
  let readSource: Promise<{
    readonly inspection: ProjectExportInspection;
    readonly hints: NodePathHints;
  } | null> = Promise.resolve(null);
  if (plan.source.kind === "project") {
    const projects = source.api?.projects;
    if (!projects) throw new Error(`${source.label} is not connected here.`);
    const exportInspect = need(projects.exportInspect, source.label);
    const sourcePathHints = need(projects.pathHints, source.label);
    const projectId = plan.source.projectId;
    readSource = Promise.all([exportInspect({ projectId }), sourcePathHints({})]).then(
      ([inspection, hints]) => ({ inspection, hints }),
    );
  }
  const [targetHints, sourceRead, targetConfig] = await Promise.all([
    pathHints({}),
    readSource,
    input.readTargetConfig(),
  ]);
  const inspection = sourceRead?.inspection ?? null;
  const sourceFacts = agentControlCopySourceFacts({ plan, inspection, source });
  // The remote the target would clone, checked there before anything else (A12).
  const clone =
    sourceFacts === null
      ? null
      : planProjectCopyOptions({
          source: sourceFacts,
          target: {
            label: target.label,
            platformOs: target.platformOs,
            projectCopySupport: target.projectCopySupport,
            transport: target.transport,
            remoteAccess: null,
            destination: null,
          },
        }).modes.clone;
  const checkRemoteAccess = targetProjects.checkRemoteAccess;
  const [remoteAccess, destination] = await Promise.all([
    clone === null || !clone.available || clone.remoteUrl === null || !checkRemoteAccess
      ? null
      : checkRemoteAccess({ remoteUrl: clone.remoteUrl }).catch(() => null),
    resolveAgentControlCopyDestination({
      plan,
      sourceRepository:
        sourceRead === null
          ? null
          : {
              rootPath: sourceRead.inspection.repository.rootPath,
              pathSeparator: sourceRead.hints.pathSeparator,
            },
      targetHints,
      sourceCanonicalKey: sourceFacts === null ? null : projectCopySourceCanonicalKey(sourceFacts),
      preview: previewDestination,
    }),
  ]);
  return planAgentControlCopy({
    plan,
    proposalId,
    source,
    inspection,
    target,
    targetPathSeparator: targetHints.pathSeparator,
    remoteAccess,
    destination,
    targetConfig,
  });
}
