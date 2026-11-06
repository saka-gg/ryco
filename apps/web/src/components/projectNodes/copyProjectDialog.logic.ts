// FILE: copyProjectDialog.logic.ts
// Purpose: What the "Copy <project> to another node" dialog shows, pure: the
//          From rows (the project's checkouts across nodes), the To cards, the
//          folder note and tag, the footer summary, the progress step list and
//          its overall percent, the connection cap (A22), and the Projects
//          page's Copies rows (A36(3)).
// Layer: Web UI logic over the node catalog, the coordinator's plan and
//        progress types and the import snapshot. The dialog and the Copies
//        block render these; the coordinator decides what is possible.

import type {
  CopyDestinationSuggestion,
  ProjectCopyJobRecord,
  ProjectCopyMode,
  ProjectCopyProgress,
} from "@ryco/client-runtime/projectCopy";
import type { NodeCatalogEntry } from "@ryco/client-runtime/state/nodes";
import type { EnvironmentId, ProjectId, ScopedProjectRef, VcsStatusResult } from "@ryco/contracts";
import type {
  ProjectImportSnapshot,
  ProjectImportStep,
  ProjectImportStepId,
} from "@ryco/contracts/project-copy";
import { displayRemoteUrl } from "@ryco/shared/gitRemoteUrl";

import {
  formatCopyTimeLeft,
  formatCopyTransfer,
  formatCopyUpload,
  lastOutputLine,
  projectCopyView,
  type ProjectCopyThroughput,
} from "./copyRuntime/projectCopyProgress.logic";
import { displayProjectPath } from "../../lib/projectPaths";
import { describeNodePresence, nodeOsLabel } from "./nodePicker.logic";

/** Text with its paths and commands marked, so the view sets them in mono. */
export interface CopyTextSegment {
  readonly text: string;
  readonly mono?: true;
}

const mono = (text: string): CopyTextSegment => ({ text, mono: true });
const plain = (text: string): CopyTextSegment => ({ text });

export function copySegmentsText(segments: ReadonlyArray<CopyTextSegment>): string {
  return segments.map((segment) => segment.text).join("");
}

/* ───────── From: the project's checkouts ───────── */

/** Branch, changed files and behind count, from VCS status this client already has. */
export interface CopyCheckoutMeta {
  readonly branch: string | null;
  readonly changed: number;
  readonly behind: number;
}

export const EMPTY_CHECKOUT_META: CopyCheckoutMeta = { branch: null, changed: 0, behind: 0 };

/**
 * What a checkout row says about its working copy. Only what is loaded counts:
 * a summary view knows the branch, the full view also the changes and, once its
 * remote half arrived, how far it is behind (A36(1)).
 */
export function copyCheckoutMeta(
  status: VcsStatusResult | null,
  options: { readonly remotePending?: boolean; readonly summaryOnly?: boolean } = {},
): CopyCheckoutMeta {
  if (status === null || !status.isRepo) return EMPTY_CHECKOUT_META;
  return {
    branch: status.refName,
    changed: options.summaryOnly ? 0 : status.workingTree.files.length,
    behind: options.summaryOnly || options.remotePending ? 0 : status.behindCount,
  };
}

/** One checkout of the project the copy can start from. */
export interface CopyCheckoutMember {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
  readonly cwd: string;
}

export interface CopySourceRow {
  readonly key: string;
  readonly ref: ScopedProjectRef;
  readonly label: string;
  readonly node: NodeCatalogEntry | null;
  readonly path: string;
  readonly displayPath: string;
  readonly selectable: boolean;
  /** Why the row can't be picked; null when it can. */
  readonly reason: string | null;
  readonly offline: boolean;
}

export function copyCheckoutKey(ref: ScopedProjectRef): string {
  return `${ref.environmentId}\u0000${ref.projectId}`;
}

/** The From rows: every checkout of the project, offline nodes disabled. */
export function copySourceRows(input: {
  readonly members: ReadonlyArray<CopyCheckoutMember>;
  readonly nodes: ReadonlyArray<NodeCatalogEntry>;
  readonly labelOf: (environmentId: EnvironmentId) => string;
}): CopySourceRow[] {
  return input.members.map((member) => {
    const node = input.nodes.find((entry) => entry.environmentId === member.environmentId) ?? null;
    const label = node?.label ?? input.labelOf(member.environmentId);
    const offline = node === null || node.presence === "offline";
    const ref = { environmentId: member.environmentId, projectId: member.id };
    return {
      key: copyCheckoutKey(ref),
      ref,
      label,
      node,
      path: member.cwd,
      displayPath: displayProjectPath(member.cwd),
      selectable: !offline,
      reason: offline ? `${label} is offline` : null,
      offline,
    };
  });
}

/** The source the dialog starts from: the one asked for when it is reachable, else the first that is. */
export function initialCopySource(
  rows: ReadonlyArray<CopySourceRow>,
  requested: ScopedProjectRef,
): CopySourceRow | null {
  const asked = rows.find((row) => row.key === copyCheckoutKey(requested));
  if (asked?.selectable) return asked;
  return rows.find((row) => row.selectable) ?? asked ?? null;
}

/* ───────── To: the destination nodes ───────── */

export type CopyTargetState =
  /** The project is already there. */
  | "has-it"
  | "offline"
  /** The node runs a Ryco without project copy. */
  | "outdated"
  /** This client can't change the node. */
  | "blocked"
  /** Not connected yet: picking it connects and checks (A23). */
  | "unknown"
  | "ready";

export interface CopyTargetCard {
  readonly node: NodeCatalogEntry;
  readonly state: CopyTargetState;
  readonly selectable: boolean;
  /** The card's second line, e.g. "has it · ~/dev/ryco", "offline since 09:05", "macOS". */
  readonly sub: string;
  /** The full reason for a disabled card (its tooltip). */
  readonly reason: string | null;
}

export function copyTargetUpdateReason(label: string): string {
  return `Update Ryco on ${label} to copy here`;
}

/** The To cards: every node, those that can't take the copy disabled with why. */
export function copyTargetCards(input: {
  readonly nodes: ReadonlyArray<NodeCatalogEntry>;
  readonly members: ReadonlyArray<CopyCheckoutMember>;
  readonly nowMs: number;
}): CopyTargetCard[] {
  return input.nodes.map((node) => {
    const checkout = input.members.find((member) => member.environmentId === node.environmentId);
    if (checkout) {
      const sub = `has it · ${displayProjectPath(checkout.cwd)}`;
      return { node, state: "has-it", selectable: false, sub, reason: sub };
    }
    if (node.presence === "offline") {
      const sub = describeNodePresence(node, input.nowMs).text;
      return { node, state: "offline", selectable: false, sub, reason: `${node.label} is offline` };
    }
    if (node.projectCopySupport === "no") {
      const reason = copyTargetUpdateReason(node.label);
      return { node, state: "outdated", selectable: false, sub: reason, reason };
    }
    if (!node.canMutate && node.presence === "online") {
      const reason = node.mutateBlockedReason ?? `You can't add projects on ${node.label}`;
      return { node, state: "blocked", selectable: false, sub: reason, reason };
    }
    const os = nodeOsLabel(node.platformOs);
    if (node.projectCopySupport === "unknown") {
      return {
        node,
        state: "unknown",
        selectable: true,
        sub: os ?? describeNodePresence(node, input.nowMs).text,
        reason: null,
      };
    }
    return { node, state: "ready", selectable: true, sub: os ?? "online", reason: null };
  });
}

const asSentence = (text: string): string => (/[.!?]$/u.test(text) ? text : `${text}.`);

/**
 * What the dialog says when no card can take the copy: only nodes that have
 * it (or are offline) is "already on every online node"; otherwise it says
 * why the others can't, such as a Ryco to update (A23).
 */
export function copyNoTargetMessage(title: string, cards: ReadonlyArray<CopyTargetCard>): string {
  const reasons = new Set<string>();
  for (const card of cards) {
    if ((card.state === "outdated" || card.state === "blocked") && card.reason !== null) {
      reasons.add(asSentence(card.reason));
    }
  }
  if (reasons.size === 0) {
    return `${title} is already on every online node. Add a node to copy it somewhere new.`;
  }
  return [`No node can take a copy of ${title} right now.`, ...reasons].join(" ");
}

/**
 * The destination the dialog starts with: the one asked for, else the one this
 * project was last copied to from this source, else the first node ready for it.
 */
export function initialCopyTarget(
  cards: ReadonlyArray<CopyTargetCard>,
  requested: EnvironmentId | null,
  remembered: EnvironmentId | null = null,
): EnvironmentId | null {
  for (const preferred of [requested, remembered]) {
    if (preferred === null) continue;
    const card = cards.find((candidate) => candidate.node.environmentId === preferred);
    if (card?.selectable) return card.node.environmentId;
  }
  return (
    cards.find((card) => card.state === "ready")?.node.environmentId ??
    cards.find((card) => card.selectable)?.node.environmentId ??
    null
  );
}

/**
 * The To cards worth a card: nodes that already have the project only get a
 * name in the "Already on" line (`copyAlreadyOn`).
 */
export function copyDestinationCards(cards: ReadonlyArray<CopyTargetCard>): CopyTargetCard[] {
  return cards.filter((card) => card.state !== "has-it");
}

/** The nodes that already have the project, for the To field's "Already on" line. */
export function copyAlreadyOn(cards: ReadonlyArray<CopyTargetCard>): CopyTargetCard[] {
  return cards.filter((card) => card.state === "has-it");
}

/* ───────── Folder on the destination ───────── */

/** The tag beside the destination path. */
export function copyFolderTag(
  suggestion: CopyDestinationSuggestion | null,
): { readonly text: string; readonly tone: "muted" | "warning" | "info" } | null {
  if (suggestion === null) return null;
  switch (suggestion.status) {
    case "available":
      return suggestion.preview.state === "exists-empty"
        ? { text: "empty folder", tone: "muted" }
        : { text: "new folder", tone: "muted" };
    case "renamed":
      return { text: "renamed, folder exists", tone: "warning" };
    case "link":
      return { text: "existing checkout", tone: "info" };
    case "existing-project":
    case "blocked":
      return null;
  }
}

/**
 * The line under the destination path: why this folder (the mockup's "Same
 * place as on X" / "<path> doesn't exist on D, so this uses <path> instead"),
 * or what is wrong with it.
 */
export function copyFolderNote(input: {
  readonly suggestion: CopyDestinationSuggestion | null;
  readonly manual: boolean;
  /** The manual folder is the one used the last time this checkout was copied there. */
  readonly remembered?: boolean | undefined;
  readonly sourceLabel: string;
  readonly targetLabel: string;
  readonly targetHome: string | null;
  readonly projectTitle: string;
}): { readonly segments: ReadonlyArray<CopyTextSegment>; readonly tone: "muted" | "negative" } {
  const { suggestion, targetLabel } = input;
  if (suggestion === null) {
    return { segments: [plain(`Checking ${targetLabel}…`)], tone: "muted" };
  }
  if (suggestion.status === "blocked") {
    return {
      segments: [plain(suggestion.detail ?? `Ryco can't use this folder on ${targetLabel}.`)],
      tone: "negative",
    };
  }
  if (suggestion.status === "existing-project") {
    return {
      segments: [plain(`${input.projectTitle} is already a project there.`)],
      tone: "negative",
    };
  }
  if (suggestion.status === "link") {
    return {
      segments: [
        plain(`Already a checkout of ${input.projectTitle} on ${targetLabel}. Linking adds it as `),
        plain("a project without copying anything."),
      ],
      tone: "muted",
    };
  }
  if (input.manual) {
    return {
      segments: [
        plain(input.remembered ? "The folder you used last time." : "You picked this folder."),
      ],
      tone: "muted",
    };
  }
  if (suggestion.basis === "same-place") {
    return { segments: [plain(`Same place as on ${input.sourceLabel}.`)], tone: "muted" };
  }
  const parent = parentOfNodePath(suggestion.takenPath ?? suggestion.path);
  const shownParent = displayProjectPath(parent, input.targetHome);
  if (suggestion.missingMirroredParent !== null) {
    return {
      segments: [
        mono(displayProjectPath(suggestion.missingMirroredParent, input.targetHome)),
        plain(` doesn’t exist on ${targetLabel}, so this uses `),
        mono(shownParent),
        plain(" instead."),
      ],
      tone: "muted",
    };
  }
  return {
    segments: [plain("Uses "), mono(shownParent), plain(`, the code folder on ${targetLabel}.`)],
    tone: "muted",
  };
}

/** The parent of an absolute node path ("/a/b" → "/a", "C:\\a" → "C:\\"). */
export function parentOfNodePath(path: string): string {
  const trimmed = path.replace(/[\\/]+$/u, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (index < 0) return trimmed;
  if (index === 0) return trimmed.slice(0, 1);
  const parent = trimmed.slice(0, index);
  return /^[A-Za-z]:$/u.test(parent) ? `${parent}\\` : parent;
}

/** What the copy brings beyond the repository, as the collapsed Options and the footer say it. */
export interface CopyOptionsSummaryInput {
  readonly mode: ProjectCopyMode;
  /** Uncommitted changes that come along (0 when they stay). */
  readonly changes: number;
  /** Unpushed commits that come along (0 when they stay). */
  readonly commits: number;
  /** Ignored files picked to come along. */
  readonly ignoredFiles: number;
  /** What those files are called: "ignored file" in a repository, ".env file" in a plain folder. */
  readonly ignoredFileNoun?: string;
  readonly copySettings: boolean;
  /** The setup command that runs afterwards; null when none does. */
  readonly setupCommand: string | null;
  readonly followUp: boolean;
}

const plural = (count: number, one: string, many = `${one}s`): string =>
  `${count} ${count === 1 ? one : many}`;

/** A setup command short enough for one line: its first words, "bun install …". */
export function shortSetupCommand(command: string): string {
  const line = command.trim().split("\n")[0]?.trim() ?? "";
  if (line.length <= 24) return line;
  const words = line.split(/\s+/u);
  let short = words[0] ?? "";
  for (const word of words.slice(1)) {
    if (`${short} ${word}`.length > 20) break;
    short = `${short} ${word}`;
  }
  return short.length > 24 ? `${short.slice(0, 23)}…` : `${short} …`;
}

/**
 * The one-line Options summary: "+ 2 uncommitted changes · 1 unpushed commit ·
 * settings · runs `bun install …`" ("Nothing extra" when it brings nothing).
 */
export function copyOptionsSummary(input: CopyOptionsSummaryInput): ReadonlyArray<CopyTextSegment> {
  const parts: CopyTextSegment[][] = [];
  if (input.mode !== "link") {
    if (input.changes > 0) parts.push([plain(plural(input.changes, "uncommitted change"))]);
    if (input.commits > 0) parts.push([plain(plural(input.commits, "unpushed commit"))]);
    if (input.ignoredFiles > 0) {
      parts.push([plain(plural(input.ignoredFiles, input.ignoredFileNoun ?? "ignored file"))]);
    }
  }
  if (input.copySettings) parts.push([plain("settings")]);
  if (input.setupCommand !== null && input.setupCommand.trim().length > 0) {
    parts.push([plain("runs "), mono(shortSetupCommand(input.setupCommand))]);
  }
  if (input.followUp) parts.push([plain("an agent finishes setup")]);
  if (parts.length === 0) return [plain("Nothing extra")];
  const segments: CopyTextSegment[] = [plain("+ ")];
  parts.forEach((part, index) => {
    if (index > 0) segments.push(plain(" · "));
    segments.push(...part);
  });
  return segments;
}

/* ───────── Connection cap (A22) ───────── */

export interface CopyNodeConnection {
  readonly environmentId: EnvironmentId;
  /** Reached through the Hub (a hosted node or a Desktop Hub machine), so it takes a slot. */
  readonly relayed: boolean;
}

export const COPY_CONNECTION_CAP_MESSAGE =
  "All connections are in use; let a running copy finish first.";

/**
 * Refuses a copy that needs more Hub connections than the client keeps: the
 * relayed nodes it would hold, plus those running copies hold until their
 * import started, over `maxConnections` (A22). Direct nodes take no slot.
 */
export function copyConnectionCapReason(input: {
  readonly copyNodes: ReadonlyArray<CopyNodeConnection>;
  readonly heldByRunningCopies: ReadonlyArray<CopyNodeConnection>;
  readonly maxConnections: number;
}): string | null {
  const relayed = new Set<EnvironmentId>();
  for (const node of [...input.copyNodes, ...input.heldByRunningCopies]) {
    if (node.relayed) relayed.add(node.environmentId);
  }
  return relayed.size > input.maxConnections ? COPY_CONNECTION_CAP_MESSAGE : null;
}

/** The nodes a running copy holds with its own (non-preemptible) scope: until its import started. */
export function nodesHeldByCopy(
  entry: Pick<ProjectCopyEntryLike, "running" | "progress" | "record">,
): EnvironmentId[] {
  if (!entry.running || entry.progress.canCloseClient) return [];
  return [
    entry.record.targetEnvironmentId,
    ...(entry.record.sourceEnvironmentId === null ? [] : [entry.record.sourceEnvironmentId]),
  ];
}

/* ───────── Progress ───────── */

export type CopyStepStatus = "done" | "running" | "pending" | "failed";

export interface CopyProgressStep {
  readonly id: string;
  readonly label: ReadonlyArray<CopyTextSegment>;
  readonly status: CopyStepStatus;
  /** 0–100 while the step measures itself (clone, upload); null otherwise. */
  readonly percent: number | null;
  /** The running step's latest output line ("Receiving objects 31% …"), or a failure's reason. */
  readonly log: string | null;
  /** How much of the copy this step stands for, for the overall bar. */
  readonly weight: number;
}

/** What the progress list knows about the copy beyond its progress. */
export interface CopyProgressContext {
  readonly sourceLabel: string | null;
  readonly targetLabel: string;
  readonly mode: ProjectCopyMode;
  readonly remoteUrl: string | null;
  readonly branch: string | null;
  readonly destinationPath: string;
  readonly targetHome: string | null;
  readonly changeCount: number;
  readonly setupCommand: string | null;
  /** The copy sends artifacts from the source (commits, changes, files, avatar). */
  readonly uploads: boolean;
  readonly bringsCommits: boolean;
  readonly bringsChanges: boolean;
  readonly copiesSettings: boolean;
  readonly followUp: boolean;
  /** A plain folder: its files are unpacked, no git steps run. */
  readonly plainFolder?: boolean;
}

const STEP_WEIGHTS: Partial<
  Record<ProjectImportStepId | "connect" | "prepare" | "upload", number>
> = {
  connect: 6,
  prepare: 4,
  upload: 32,
  preflight: 4,
  clone: 32,
  setup: 24,
};
const DEFAULT_STEP_WEIGHT = 5;

function firstLine(command: string): string {
  const line = command.trim().split("\n")[0] ?? "";
  return line.length > 60 ? `${line.slice(0, 59)}…` : line;
}

/** The label of one import step, with the copy's own paths and names. */
export function copyImportStepLabel(
  id: ProjectImportStepId,
  context: CopyProgressContext,
): ReadonlyArray<CopyTextSegment> {
  switch (id) {
    case "preflight":
      return context.mode === "link"
        ? [plain("Check "), mono(displayProjectPath(context.destinationPath, context.targetHome))]
        : [plain("Create "), mono(displayProjectPath(context.destinationPath, context.targetHome))];
    case "clone":
      return context.mode === "send-files"
        ? [plain("Unpack the files")]
        : context.remoteUrl
          ? [plain("Clone "), mono(displayRemoteUrl(context.remoteUrl))]
          : [plain("Clone the repository")];
    case "remotes":
      return [plain("Add the remotes")];
    case "commits":
      return [plain("Add the unpushed commits")];
    case "checkout":
      return context.branch
        ? [plain("Check out "), mono(context.branch)]
        : [plain("Check out the branch")];
    case "changes":
      return context.changeCount > 0
        ? [
            plain(
              `Apply ${context.changeCount} uncommitted change${context.changeCount === 1 ? "" : "s"}`,
            ),
          ]
        : [plain("Apply the uncommitted changes")];
    case "submodules":
      return [plain("Update submodules")];
    case "lfs":
      return [plain("Fetch large files")];
    case "register":
      return [plain(`Add the project on ${context.targetLabel}`)];
    case "settings":
      return [plain("Copy project settings")];
    case "avatar":
      return [plain("Copy the avatar")];
    case "setup":
      return context.setupCommand
        ? [plain("Run "), mono(firstLine(context.setupCommand))]
        : [plain("Run the setup command")];
    case "follow-up":
      return [plain("Start the setup thread")];
  }
}

/** The steps the target will run, before it reported any (the import was not started yet). */
function plannedImportSteps(context: CopyProgressContext): ProjectImportStepId[] {
  if (context.mode === "link") {
    return ["preflight", "register", ...(context.copiesSettings ? ["settings" as const] : [])];
  }
  return [
    "preflight",
    "clone",
    ...(context.bringsCommits ? ["commits" as const] : []),
    ...(context.plainFolder === true ? [] : ["checkout" as const]),
    ...(context.bringsChanges ? ["changes" as const] : []),
    "register",
    ...(context.copiesSettings ? ["settings" as const] : []),
    ...(context.setupCommand ? ["setup" as const] : []),
    ...(context.followUp ? ["follow-up" as const] : []),
  ];
}

function importStepRow(
  step: ProjectImportStep,
  snapshot: ProjectImportSnapshot,
  context: CopyProgressContext,
): CopyProgressStep {
  const status: CopyStepStatus = step.status === "skipped" ? "done" : step.status;
  const running = status === "running";
  return {
    id: step.id,
    label: copyImportStepLabel(step.id, context),
    status,
    percent: running ? step.progressPercent : null,
    log:
      status === "failed"
        ? step.detail
        : running
          ? step.id === "setup"
            ? lastOutputLine(snapshot.outputTail)
            : step.detail
          : null,
    weight: STEP_WEIGHTS[step.id] ?? DEFAULT_STEP_WEIGHT,
  };
}

/** Where a failure that happened before the target accepted the import stopped. */
function failedClientPosition(progress: ProjectCopyProgress, uploads: boolean): number {
  switch (progress.error?.code) {
    case "node-unavailable":
    case "unsupported":
      return CLIENT_POSITION.connect;
    case "export-failed":
      return uploads ? CLIENT_POSITION.prepare : CLIENT_POSITION.connect;
    case "transfer-failed":
    case "too-large":
    case "upload-interrupted":
      return uploads ? CLIENT_POSITION.upload : CLIENT_POSITION.connect;
    default:
      return CLIENT_POSITION.import;
  }
}

const CLIENT_POSITION = { connect: 0, prepare: 1, upload: 2, import: 3, done: 4 } as const;

/** How far the copy got, as a position in connect → prepare → upload → import → done. */
function clientPosition(progress: ProjectCopyProgress, uploads: boolean): number {
  const reachedImport = progress.importSnapshot !== null || progress.canCloseClient;
  switch (progress.phase) {
    case "acquire":
      // A pause to reconnect keeps the copy where it was.
      return reachedImport
        ? CLIENT_POSITION.import
        : progress.uploadedBytes > 0
          ? CLIENT_POSITION.upload
          : CLIENT_POSITION.connect;
    case "export":
      return CLIENT_POSITION.prepare;
    case "upload":
      return CLIENT_POSITION.upload;
    case "import":
      return CLIENT_POSITION.import;
    case "done":
      return CLIENT_POSITION.done;
    case "failed":
      return reachedImport ? CLIENT_POSITION.import : failedClientPosition(progress, uploads);
    case "cancelled":
      return reachedImport ? CLIENT_POSITION.import : CLIENT_POSITION.connect;
  }
}

/**
 * The progress list: connecting, preparing and sending the files on this
 * client, then the target's own steps (planned ones until it reports them;
 * skipped ones left out).
 */
export function copyProgressSteps(
  progress: ProjectCopyProgress,
  context: CopyProgressContext,
  throughput: ProjectCopyThroughput | null = null,
): CopyProgressStep[] {
  const snapshot = progress.importSnapshot;
  const uploads = context.uploads && context.sourceLabel !== null;
  const position = clientPosition(progress, uploads);
  const failed = progress.phase === "failed";
  const cancelled = progress.phase === "cancelled";
  const reconnecting = progress.phase === "acquire" && position > CLIENT_POSITION.connect;
  const clientStep = (
    id: "connect" | "prepare" | "upload",
    label: ReadonlyArray<CopyTextSegment>,
    extra: { readonly percent?: number | null; readonly log?: string | null } = {},
  ): CopyProgressStep => {
    const index = CLIENT_POSITION[id];
    const status: CopyStepStatus =
      index < position
        ? "done"
        : index > position || cancelled
          ? "pending"
          : failed
            ? "failed"
            : "running";
    return {
      id,
      label,
      status,
      percent: status === "running" ? (extra.percent ?? null) : null,
      log:
        status === "failed"
          ? (progress.error?.message ?? null)
          : status === "running"
            ? reconnecting
              ? `Reconnecting to ${context.targetLabel}…`
              : (extra.log ?? null)
            : null,
      weight: STEP_WEIGHTS[id]!,
    };
  };

  const steps: CopyProgressStep[] = [
    clientStep("connect", [plain(`Connect to ${context.targetLabel}`)]),
  ];
  if (uploads) {
    steps.push(clientStep("prepare", [plain(`Prepare the files on ${context.sourceLabel}`)]));
    const measuring = progress.phase === "upload" && progress.totalBytes > 0;
    steps.push(
      clientStep(
        "upload",
        [
          plain(
            context.mode === "send-files"
              ? `Send files from ${context.sourceLabel}`
              : `Send local work from ${context.sourceLabel}`,
          ),
        ],
        {
          percent: measuring
            ? Math.round((progress.uploadedBytes / progress.totalBytes) * 100)
            : null,
          log: measuring
            ? formatCopyUpload(progress.uploadedBytes, progress.totalBytes, throughput)
            : null,
        },
      ),
    );
  }
  if (snapshot !== null) {
    for (const step of snapshot.steps) {
      if (step.status === "skipped") continue;
      steps.push(importStepRow(step, snapshot, context));
    }
    return steps;
  }
  plannedImportSteps(context).forEach((id, index) => {
    // The target refused the import before it reported a step: its first one failed.
    const refused = failed && position === CLIENT_POSITION.import && index === 0;
    steps.push({
      id,
      label: copyImportStepLabel(id, context),
      status: position === CLIENT_POSITION.done ? "done" : refused ? "failed" : "pending",
      percent: null,
      log: refused ? (progress.error?.message ?? null) : null,
      weight: STEP_WEIGHTS[id] ?? DEFAULT_STEP_WEIGHT,
    });
  });
  return steps;
}

/** The overall bar: finished steps count fully, the running one by its own percent. */
export function copyOverallPercent(
  steps: ReadonlyArray<CopyProgressStep>,
  progress: ProjectCopyProgress,
): number {
  if (progress.phase === "done") return 100;
  const total = steps.reduce((sum, step) => sum + step.weight, 0);
  if (total === 0) return 0;
  const done = steps.reduce((sum, step) => {
    if (step.status === "done") return sum + step.weight;
    if (step.status === "running" && step.percent !== null) {
      return sum + (step.weight * Math.max(0, Math.min(100, step.percent))) / 100;
    }
    return sum;
  }, 0);
  return Math.max(0, Math.min(99, Math.round((done / total) * 100)));
}

/**
 * The progress footer (A22): before the target accepted the import the copy
 * still needs this client; after, it runs there on its own.
 */
export function copyProgressFooter(
  progress: ProjectCopyProgress,
  targetLabel: string,
  throughput: ProjectCopyThroughput | null = null,
): string {
  if (progress.canCloseClient) return `Runs on ${targetLabel}; you can close Ryco.`;
  if (progress.totalBytes > 0) {
    // Once the speed is known, the time left says more than the sizes (the step shows both).
    const status =
      throughput?.secondsLeft != null
        ? formatCopyTimeLeft(throughput.secondsLeft)
        : formatCopyTransfer(progress.uploadedBytes, progress.totalBytes);
    return `Keep Ryco open until the upload finishes (${status}).`;
  }
  return `Keep Ryco open until ${targetLabel} starts the copy.`;
}

/* ───────── Copies block (A36(3)) ───────── */

/** The parts of a `copyManager` entry the Copies block reads. */
export interface ProjectCopyEntryLike {
  readonly copyId: string;
  readonly title: string | null;
  readonly sourceLabel: string | null;
  readonly targetLabel: string | null;
  readonly targetEnvironmentId: EnvironmentId;
  readonly progress: ProjectCopyProgress;
  readonly record: ProjectCopyJobRecord;
  readonly running: boolean;
  readonly hasPlan: boolean;
}

/** An import one of the connected nodes reports (`projects.listImports`). */
export interface NodeImportReport {
  readonly environmentId: EnvironmentId;
  readonly snapshot: ProjectImportSnapshot;
}

export type ProjectCopyRowStatus = "running" | "failed" | "interrupted" | "cancelled";

export interface ProjectCopyRow {
  readonly key: string;
  readonly title: string;
  readonly targetEnvironmentId: EnvironmentId;
  readonly targetLabel: string;
  readonly status: ProjectCopyRowStatus;
  readonly description: string;
  readonly percent: number | null;
  /** What "View log" shows; null when nothing has run on the target yet. */
  readonly snapshot: ProjectImportSnapshot | null;
  /** A copy this client tracks; null for an import only the node reports. */
  readonly copyId: string | null;
  /** The failure's retry, worded for its button ("Send files instead", "Resume"). */
  readonly retryLabel: string | null;
  /** An unfinished stored copy that can be followed or continued from its record. */
  readonly canResume: boolean;
  /**
   * The copy can only go on through the copy dialog: a copy the user started
   * whose upload stopped when Ryco closed, and whose plan (folder, setup
   * command, options) never reaches storage. Resume reopens the dialog for it;
   * dismissing it cleans up what it sent.
   */
  readonly resumeInDialog: boolean;
  /** A folder the failed import left behind on the target, which "Discard leftover" deletes. */
  readonly leftover: {
    readonly environmentId: EnvironmentId;
    readonly importId: ProjectImportSnapshot["importId"];
    readonly path: string;
  } | null;
  /** A finished copy this client remembers, which the row's dismiss forgets. */
  readonly canDismiss: boolean;
}

const IMPORT_STATUS_ROW: Partial<Record<ProjectImportSnapshot["status"], ProjectCopyRowStatus>> = {
  running: "running",
  failed: "failed",
  interrupted: "interrupted",
  cancelled: "cancelled",
};

/**
 * One row per copy of this project that is running or did not finish: this
 * session's copies, the stored records of earlier ones, and the imports the
 * connected nodes report (merged by import id). Completed copies are left out:
 * they are checkouts now. A node's import counts as this project's when its
 * project is a member, a record of this project started it, or (for an import
 * no record knows) its title is the project's name.
 */
export function projectCopyRows(input: {
  readonly entries: ReadonlyArray<ProjectCopyEntryLike>;
  readonly records: ReadonlyArray<ProjectCopyJobRecord>;
  readonly imports: ReadonlyArray<NodeImportReport>;
  readonly memberProjectIds: ReadonlySet<string>;
  readonly projectNames: ReadonlySet<string>;
  readonly labelOf: (environmentId: EnvironmentId) => string;
  readonly isResumable: (record: ProjectCopyJobRecord) => boolean;
  /** Whether a resumable record goes on through the copy dialog (see `resumeInDialog`). */
  readonly resumesInDialog?: ((record: ProjectCopyJobRecord) => boolean) | undefined;
}): ProjectCopyRow[] {
  const belongs = (record: ProjectCopyJobRecord) =>
    input.memberProjectIds.has(record.projectId) ||
    (record.sourceProjectId !== null && input.memberProjectIds.has(record.sourceProjectId));
  const importById = new Map(input.imports.map((report) => [report.snapshot.importId, report]));
  const usedImports = new Set<string>();
  const rows: ProjectCopyRow[] = [];
  const leftoverOf = (report: NodeImportReport | undefined) =>
    report && report.snapshot.leftoverPath && report.snapshot.status !== "running"
      ? {
          environmentId: report.environmentId,
          importId: report.snapshot.importId,
          path: report.snapshot.leftoverPath,
        }
      : null;

  const seenCopies = new Set<string>();
  for (const entry of input.entries) {
    if (!belongs(entry.record)) continue;
    seenCopies.add(entry.copyId);
    const phase = entry.progress.phase;
    if (phase === "done" || (phase === "cancelled" && !entry.running)) continue;
    const report = importById.get(entry.record.importId);
    if (report) usedImports.add(report.snapshot.importId);
    const targetLabel = entry.targetLabel ?? input.labelOf(entry.targetEnvironmentId);
    const view = projectCopyView(entry.progress, {
      title: entry.title,
      sourceLabel: entry.sourceLabel,
      targetLabel,
    });
    const failed = view.kind === "failed";
    rows.push({
      key: `copy:${entry.copyId}`,
      title: entry.title ?? report?.snapshot.title ?? "Copy",
      targetEnvironmentId: entry.targetEnvironmentId,
      targetLabel,
      status: entry.running ? "running" : failed ? "failed" : "cancelled",
      description: view.description,
      percent: view.percent,
      snapshot: entry.progress.importSnapshot ?? report?.snapshot ?? null,
      copyId: entry.copyId,
      retryLabel: failed && entry.hasPlan ? view.retryLabel : null,
      canResume: !entry.running && !failed && input.isResumable(entry.record),
      resumeInDialog: false,
      leftover: entry.running ? null : leftoverOf(report),
      canDismiss: !entry.running,
    });
  }

  for (const record of input.records) {
    if (seenCopies.has(record.copyId) || !belongs(record)) continue;
    if (record.stage === "finished" && record.outcome === "completed") continue;
    const report = importById.get(record.importId);
    if (report) usedImports.add(report.snapshot.importId);
    const resumable = input.isResumable(record);
    const inDialog = resumable && input.resumesInDialog?.(record) === true;
    const status: ProjectCopyRowStatus =
      report && IMPORT_STATUS_ROW[report.snapshot.status]
        ? IMPORT_STATUS_ROW[report.snapshot.status]!
        : record.outcome === "cancelled"
          ? "cancelled"
          : resumable
            ? "interrupted"
            : "failed";
    if (status === "cancelled" && !leftoverOf(report)) continue;
    const targetLabel = input.labelOf(record.targetEnvironmentId);
    rows.push({
      key: `record:${record.copyId}`,
      title: report?.snapshot.title ?? "Copy",
      targetEnvironmentId: record.targetEnvironmentId,
      targetLabel,
      status,
      description: report?.snapshot.error?.message ?? recordDescription(record, targetLabel),
      percent: null,
      snapshot: report?.snapshot ?? null,
      copyId: record.copyId,
      retryLabel: null,
      canResume: resumable,
      resumeInDialog: inDialog,
      leftover: leftoverOf(report),
      canDismiss: !resumable || inDialog,
    });
  }

  for (const report of input.imports) {
    const snapshot = report.snapshot;
    if (usedImports.has(snapshot.importId)) continue;
    const status = IMPORT_STATUS_ROW[snapshot.status];
    if (!status) continue;
    const ours =
      input.memberProjectIds.has(snapshot.projectId) ||
      input.projectNames.has(snapshot.title.trim().toLowerCase());
    if (!ours) continue;
    // A stopped import with nothing left behind needs no row.
    if (status !== "running" && !leftoverOf(report) && status === "cancelled") continue;
    rows.push({
      key: `import:${report.environmentId}:${snapshot.importId}`,
      title: snapshot.title,
      targetEnvironmentId: report.environmentId,
      targetLabel: input.labelOf(report.environmentId),
      status,
      description:
        snapshot.error?.message ??
        (status === "running" ? "Running" : `Stopped on ${input.labelOf(report.environmentId)}`),
      percent: null,
      snapshot,
      copyId: null,
      retryLabel: null,
      canResume: false,
      resumeInDialog: false,
      leftover: leftoverOf(report),
      canDismiss: false,
    });
  }
  return rows;
}

function recordDescription(record: ProjectCopyJobRecord, targetLabel: string): string {
  switch (record.stage) {
    case "export":
    case "upload":
      return "The copy stopped when Ryco closed during the upload.";
    case "import-requested":
    case "importing":
      return `Runs on ${targetLabel}.`;
    case "finished":
      return record.outcome === "cancelled" ? "Stopped." : "The copy failed.";
  }
}
