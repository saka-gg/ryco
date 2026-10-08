// FILE: PromoteChatDialog.logic.ts
// Purpose: Pure rules behind "Turn into project…": the destination field's
//          name-following leaf, the plan and per-step results shown while and
//          after the chat is promoted, and friendly copy for every server
//          verdict (destination status, `ProjectChatError` reasons).
// Layer: Web UI logic (no React, no I/O), consumed by `PromoteChatDialog.tsx`.

import {
  CHAT_PROJECT_TITLE_MAX_CHARS,
  ProjectChatErrorReason,
  type ProjectChatDestinationStatus,
  type ProjectsPromoteChatPreviewResult,
  type ProjectsPromoteChatResult,
  type ThreadId,
} from "@ryco/contracts";
import {
  deriveThreadActivityStatus,
  type ThreadActivityStatus,
} from "@ryco/client-runtime/state/threads";
import { directorySlug } from "@ryco/shared/directorySlug";
import { isTagged } from "effect/Predicate";
import * as Schema from "effect/Schema";

import {
  ensureBrowseDirectoryPath,
  getBrowseDirectoryPath,
  getBrowseLeafPathSegment,
  hasTrailingPathSeparator,
  normalizeProjectPathForDispatch,
} from "../../lib/projectPaths";
import type { SidebarThreadSummary } from "../../types";
import { formatBytes } from "../settings/DiagnosticsSettings.logic";

/** The folder-name fallback the server also uses for its default destination. */
const PROJECT_LEAF_FALLBACK = "project";

/** How long a clean result stays on screen before the dialog folds away by itself. */
export const PROMOTION_SUCCESS_HOLD_MS = 1400;
/** The longest the dialog waits for the promoted project to reach the sidebar before folding. */
export const PROMOTED_PROJECT_ARRIVAL_TIMEOUT_MS = 2500;
/** Debounce for the live destination preview while the location is typed. */
export const DESTINATION_PREVIEW_DEBOUNCE_MS = 250;
/** How many `<name>-N` siblings the dialog probes when the destination already exists. */
export const FREE_NAME_PROBE_LIMIT = 6;

export const GIT_IDENTITY_COMMANDS: ReadonlyArray<string> = [
  'git config --global user.name "Your Name"',
  "git config --global user.email you@example.com",
];

/* ───────── Destination: the folder name follows the project name ───────── */

/** The folder name a project called `name` gets. */
export function projectFolderLeafForName(name: string): string {
  return directorySlug(name, PROJECT_LEAF_FALLBACK);
}

export function destinationLeaf(destination: string): string {
  return getBrowseLeafPathSegment(normalizeProjectPathForDispatch(destination));
}

/** `destination` with its last segment replaced; a bare name becomes `leaf` itself. */
export function replaceDestinationLeaf(destination: string, leaf: string): string {
  const normalized = normalizeProjectPathForDispatch(destination);
  if (normalized.length === 0) return leaf;
  if (hasTrailingPathSeparator(normalized)) return `${normalized}${leaf}`;
  const directory = getBrowseDirectoryPath(normalized);
  return directory === normalized ? leaf : `${directory}${leaf}`;
}

/** `<parent>/<leaf>`, with the separator the parent already uses. */
export function joinDestination(parent: string, leaf: string): string {
  const directory = ensureBrowseDirectoryPath(parent);
  return directory.length === 0 ? leaf : `${directory}${leaf}`;
}

/** A collision suffix: `2`, `3`, … `10`, … (never `0` or `1`). */
const COLLISION_SUFFIX_RE = /^(?:[2-9]|[1-9]\d+)$/;
const LEAF_WITH_COLLISION_SUFFIX_RE = /^(.+)-([2-9]|[1-9]\d+)$/;

/**
 * Whether `leaf` is the folder name Ryco would pick for `name`: its slug, or
 * that slug with a collision suffix (`-2`, `-3`, …). Such a leaf still follows
 * the name as it is edited; a leaf the user typed does not.
 */
export function isAutoLeafForName(leaf: string, name: string): boolean {
  const slug = projectFolderLeafForName(name);
  if (leaf === slug) return true;
  if (!leaf.startsWith(`${slug}-`)) return false;
  return COLLISION_SUFFIX_RE.test(leaf.slice(slug.length + 1));
}

/** The first location shown: the server's default, renamed for `name` when the chat was retitled. */
export function initialDestinationForName(defaultDestination: string, name: string): string {
  return isAutoLeafForName(destinationLeaf(defaultDestination), name)
    ? defaultDestination
    : replaceDestinationLeaf(defaultDestination, projectFolderLeafForName(name));
}

/** The location after the name changes: an automatic leaf follows it, a typed one stays. */
export function retargetDestinationForName(input: {
  readonly destination: string;
  readonly previousName: string;
  readonly nextName: string;
}): string {
  const { destination, previousName, nextName } = input;
  if (destination.trim().length === 0) return destination;
  const leaf = destinationLeaf(destination);
  if (!isAutoLeafForName(leaf, previousName) || isAutoLeafForName(leaf, nextName)) {
    return destination;
  }
  return replaceDestinationLeaf(destination, projectFolderLeafForName(nextName));
}

/** `<base>-2`, `<base>-3`, … after `leaf` (whose own suffix, if any, is the starting point). */
export function freeLeafCandidates(leaf: string, count = FREE_NAME_PROBE_LIMIT): string[] {
  const match = LEAF_WITH_COLLISION_SUFFIX_RE.exec(leaf);
  const base = match?.[1] ?? leaf;
  const start = match ? Number(match[2]) + 1 : 2;
  return Array.from({ length: count }, (_, index) => `${base}-${start + index}`);
}

/* ───────── Destination status line ───────── */

export type DestinationStatusTone = "positive" | "caution" | "negative" | "neutral";

export interface DestinationStatusPresentation {
  readonly tone: DestinationStatusTone;
  readonly text: string;
}

export type DestinationCheckState = ProjectChatDestinationStatus | "checking" | "empty";

export function describeDestinationStatus(
  status: DestinationCheckState,
): DestinationStatusPresentation {
  switch (status) {
    case "available":
      return { tone: "positive", text: "Folder is available" };
    case "exists":
      return { tone: "caution", text: "A folder already exists here" };
    case "invalid":
      return {
        tone: "negative",
        text: "Needs a full path inside a folder you can write to",
      };
    case "access-denied":
      return { tone: "negative", text: "This device's access policy does not allow this location" };
    case "inside-chats":
      return { tone: "negative", text: "Inside the chats folder. Choose a location outside it" };
    case "inside-source":
      return {
        tone: "negative",
        text: "Inside this chat's own folder. Choose a location outside it",
      };
    case "retired-checkout":
      return {
        tone: "negative",
        text: "A removed workspace used this location. Choose another one",
      };
    case "checking":
      return { tone: "neutral", text: "Checking location…" };
    case "empty":
      return { tone: "negative", text: "Choose where the project should live" };
  }
}

/* ───────── "What will happen" ───────── */

export interface PromotionGitOptions {
  readonly initializeGit: boolean;
  readonly initialCommit: boolean;
  readonly writeGitignore: boolean;
}

/** What is actually sent: nothing Git-related when Git is off or missing on the device. */
export function effectiveGitOptions(
  options: PromotionGitOptions,
  gitAvailable: boolean,
): PromotionGitOptions {
  const initializeGit = options.initializeGit && gitAvailable;
  return {
    initializeGit,
    initialCommit: initializeGit && options.initialCommit,
    writeGitignore: initializeGit && options.writeGitignore,
  };
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? singular : plural}`;
}

/** "12 files (3.4 MB)", "more than 5,000 files (…)", or "the empty chat folder". */
export function describeFolderContents(
  preview: Pick<ProjectsPromoteChatPreviewResult, "fileCount" | "totalBytes" | "countTruncated">,
): string {
  if (preview.fileCount === 0 && !preview.countTruncated) return "the empty chat folder";
  const files = preview.countTruncated
    ? `more than ${pluralize(preview.fileCount, "file")}`
    : pluralize(preview.fileCount, "file");
  return preview.totalBytes > 0 ? `${files} (${formatBytes(preview.totalBytes)})` : files;
}

export interface MovePlanPresentation {
  readonly title: string;
  readonly detail: string | null;
}

export function describeMovePlan(
  preview: Pick<
    ProjectsPromoteChatPreviewResult,
    "fileCount" | "totalBytes" | "countTruncated" | "crossDevice"
  >,
): MovePlanPresentation {
  const contents = describeFolderContents(preview);
  if (preview.crossDevice) {
    return {
      title: `Copy ${contents}, then remove the original`,
      detail: "The new location is on a different disk, so the files are copied and checked first.",
    };
  }
  return { title: `Move ${contents}`, detail: null };
}

export function describeGitPlan(
  options: PromotionGitOptions,
  gitAvailable: boolean,
): MovePlanPresentation {
  if (!gitAvailable) {
    return {
      title: "No Git yet",
      detail: "Git is not installed on this device. You can initialize it from the project later.",
    };
  }
  if (!options.initializeGit) {
    return {
      title: "No Git yet",
      detail: "You can initialize Git from the project at any time.",
    };
  }
  const extras = [
    options.writeGitignore ? "add a .gitignore" : null,
    options.initialCommit ? "make an initial commit" : null,
  ].filter((part): part is string => part !== null);
  return {
    title: "Initialize a Git repository",
    detail:
      extras.length > 0
        ? `Then ${extras.join(" and ")}. Branches, worktrees, diffs and checkpoints turn on.`
        : "Branches, worktrees, diffs and checkpoints turn on.",
  };
}

export function shouldShowGitIdentityNotice(input: {
  readonly gitAvailable: boolean;
  readonly gitIdentityConfigured: boolean;
  readonly options: PromotionGitOptions;
}): boolean {
  return (
    input.gitAvailable &&
    !input.gitIdentityConfigured &&
    input.options.initializeGit &&
    input.options.initialCommit
  );
}

/* ───────── Progress and per-step results ───────── */

export type PromotionStepId = "move" | "git-init" | "initial-commit";
export type PromotionStepStatus = "pending" | "running" | "done" | "skipped" | "warning";

export interface PromotionStep {
  readonly id: PromotionStepId;
  readonly label: string;
  readonly status: PromotionStepStatus;
  readonly detail: string | null;
}

const STEP_LABELS: Record<PromotionStepId, string> = {
  move: "Move files",
  "git-init": "Initialize Git",
  "initial-commit": "Initial commit",
};

function plannedStepIds(options: PromotionGitOptions): PromotionStepId[] {
  return [
    "move",
    ...(options.initializeGit ? (["git-init"] as const) : []),
    ...(options.initializeGit && options.initialCommit ? (["initial-commit"] as const) : []),
  ];
}

/**
 * The steps while the request runs. The server reports nothing until it is
 * done, so only the move — always first, and the long part — shows as running.
 */
export function planPromotionSteps(
  options: PromotionGitOptions,
  preview: Pick<ProjectsPromoteChatPreviewResult, "crossDevice">,
): PromotionStep[] {
  return plannedStepIds(options).map((id, index) => ({
    id,
    label: STEP_LABELS[id],
    status: index === 0 ? "running" : "pending",
    detail:
      id === "move"
        ? preview.crossDevice
          ? "Copying to the other disk…"
          : "Moving the chat folder…"
        : null,
  }));
}

/** The same steps, settled from the server's answer. */
export function resolvePromotionSteps(
  options: PromotionGitOptions,
  result: ProjectsPromoteChatResult,
): PromotionStep[] {
  return plannedStepIds(options).map((id): PromotionStep => {
    const label = STEP_LABELS[id];
    switch (id) {
      case "move":
        return { id, label, status: "done", detail: result.workspaceRoot };
      case "git-init":
        return result.gitInitialized
          ? {
              id,
              label,
              status: "done",
              detail: options.writeGitignore ? "Repository created with a .gitignore" : null,
            }
          : {
              id,
              label,
              status: "warning",
              detail: result.commitError ?? "Git could not be initialized.",
            };
      case "initial-commit":
        if (!result.gitInitialized) {
          return { id, label, status: "skipped", detail: "Skipped because Git was not set up" };
        }
        if (result.initialCommitCreated) return { id, label, status: "done", detail: null };
        return result.commitError
          ? { id, label, status: "warning", detail: result.commitError }
          : { id, label, status: "skipped", detail: "Nothing to commit yet" };
    }
  });
}

export function promotionHasWarnings(steps: ReadonlyArray<PromotionStep>): boolean {
  return steps.some((step) => step.status === "warning");
}

/* ───────── Submit gating ───────── */

export interface PromotionSubmitInput {
  readonly name: string;
  readonly destination: string;
  /** The preview judged for exactly `destination`, or null while it is being checked. */
  readonly preview: Pick<
    ProjectsPromoteChatPreviewResult,
    "destinationStatus" | "busyThreadIds"
  > | null;
}

export type PromotionSubmitBlocker =
  | { readonly field: "name"; readonly reason: string }
  | { readonly field: "location"; readonly reason: string }
  | { readonly field: "busy"; readonly reason: string }
  | { readonly field: "pending"; readonly reason: string };

export const BUSY_CHAT_REASON =
  "Wait for the agent and any terminal command in this chat to finish before moving it.";

/** Why "Turn into project" cannot run yet, or null when it can. */
export function resolvePromotionSubmitBlocker(
  input: PromotionSubmitInput,
): PromotionSubmitBlocker | null {
  const name = input.name.trim();
  if (name.length === 0) return { field: "name", reason: "Give the project a name." };
  if (name.length > CHAT_PROJECT_TITLE_MAX_CHARS) {
    return {
      field: "name",
      reason: `Keep the name under ${CHAT_PROJECT_TITLE_MAX_CHARS} characters.`,
    };
  }
  if (input.destination.trim().length === 0) {
    return { field: "location", reason: describeDestinationStatus("empty").text };
  }
  if (!input.preview) return { field: "pending", reason: "Checking the location…" };
  if (input.preview.busyThreadIds.length > 0) return { field: "busy", reason: BUSY_CHAT_REASON };
  if (input.preview.destinationStatus !== "available") {
    return {
      field: "location",
      reason: describeDestinationStatus(input.preview.destinationStatus).text,
    };
  }
  return null;
}

/* ───────── Errors ───────── */

export type PromotionErrorRecovery =
  /** Re-read the preview (the chat or its threads changed). */
  | "refresh-preview"
  /** The destination is taken: offer the next free folder name. */
  | "suggest-name"
  /** The location itself is unusable: send the user back to it. */
  | "fix-location"
  /** Nothing changed; the same request may succeed again. */
  | "retry"
  /** The chat cannot be promoted from here. */
  | "none";

export interface PromotionErrorPresentation {
  readonly reason: ProjectChatErrorReason | null;
  readonly title: string;
  readonly message: string;
  readonly recovery: PromotionErrorRecovery;
}

const isProjectChatErrorReason = Schema.is(ProjectChatErrorReason);

/** The `ProjectChatError` reason behind a rejected chat RPC, or null for any other failure. */
export function readProjectChatErrorReason(cause: unknown): ProjectChatErrorReason | null {
  if (!isTagged(cause, "ProjectChatError")) return null;
  const reason = (cause as { readonly reason?: unknown }).reason;
  return isProjectChatErrorReason(reason) ? reason : null;
}

function causeMessage(cause: unknown): string | null {
  if (cause instanceof Error && cause.message.trim().length > 0) return cause.message.trim();
  if (typeof cause === "object" && cause !== null && "message" in cause) {
    const message = (cause as { readonly message?: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) return message.trim();
  }
  return null;
}

export function describePromotionError(cause: unknown): PromotionErrorPresentation {
  const reason = readProjectChatErrorReason(cause);
  const serverMessage = causeMessage(cause);
  const withReason = (
    title: string,
    message: string,
    recovery: PromotionErrorRecovery,
  ): PromotionErrorPresentation => ({ reason, title, message, recovery });
  switch (reason) {
    case "stale":
      return withReason(
        "This chat changed while the dialog was open",
        "The details were refreshed. Check them and try again.",
        "refresh-preview",
      );
    case "busy":
      return withReason("This chat is still busy", BUSY_CHAT_REASON, "refresh-preview");
    case "destination-exists":
      return withReason(
        "That folder already exists",
        "Ryco never moves a chat into an existing folder. Pick another name.",
        "suggest-name",
      );
    case "destination-invalid":
      return withReason(
        "That location can't be used",
        serverMessage ?? describeDestinationStatus("invalid").text,
        "fix-location",
      );
    case "destination-inside-chats":
      return withReason(
        "That location is inside the chats folder",
        "Projects live outside the chats folder. Choose another location.",
        "fix-location",
      );
    case "destination-inside-source":
      return withReason(
        "That location is inside this chat's folder",
        "A chat can't move into its own folder. Choose a location outside it.",
        "fix-location",
      );
    case "destination-retired-checkout":
      return withReason(
        "That location belonged to a removed workspace",
        "Ryco keeps new work out of removed workspace folders. Choose another location.",
        "fix-location",
      );
    case "access-denied":
      return withReason(
        "That location isn't allowed",
        "This device's workspace access policy does not allow it. Choose a folder it allows.",
        "fix-location",
      );
    case "move-failed":
      return withReason(
        "The files could not be moved",
        serverMessage ?? "Nothing was changed. The chat is still in its folder.",
        "retry",
      );
    case "git-failed":
      return withReason(
        "Git could not be set up",
        serverMessage ?? "The project was not changed.",
        "retry",
      );
    case "not-found":
      return withReason(
        "This chat no longer exists",
        "It may have been deleted on another device.",
        "none",
      );
    case "not-chat":
      return withReason(
        "This chat is already a project",
        "It may have been turned into a project somewhere else.",
        "none",
      );
    case "chats-unavailable":
      return withReason(
        "This device can't turn chats into projects",
        serverMessage ?? "Update Ryco on that device and try again.",
        "none",
      );
    case "has-threads":
    case "outside-chats-root":
      return withReason(
        "This chat can't be turned into a project",
        serverMessage ?? "The request was refused.",
        "none",
      );
    case null:
      return withReason(
        "The request did not complete",
        serverMessage ?? "Check your connection and try again.",
        "retry",
      );
  }
}

/** Failures about the chosen location; the location status line re-judges it afterwards. */
export function isLocationFailure(failure: Pick<PromotionErrorPresentation, "recovery">): boolean {
  return failure.recovery === "fix-location" || failure.recovery === "suggest-name";
}

/**
 * Whether a refused promotion still describes what the dialog shows. A
 * location failure speaks about the location it was raised for: once the user
 * picks another, the status line judges the new one instead.
 */
export function promotionErrorStillApplies(input: {
  readonly failure: Pick<PromotionErrorPresentation, "recovery">;
  /** The trimmed location that was submitted, or null when unknown. */
  readonly failedDestination: string | null;
  /** The trimmed location in the field now. */
  readonly destination: string;
}): boolean {
  if (!isLocationFailure(input.failure)) return true;
  return input.failedDestination === null || input.failedDestination === input.destination;
}

/** The chat's device offers no promotion RPC right now (offline, or an older Ryco). */
export function describePromotionUnavailable(): PromotionErrorPresentation {
  return {
    reason: "chats-unavailable",
    title: "This device can't turn chats into projects right now",
    message:
      "It may be offline or run an older version of Ryco. Reconnect or update it, then try again.",
    recovery: "retry",
  };
}

/* ───────── Live activity ───────── */

/** What one of the chat's threads is visibly doing, as this client sees it. */
export interface ChatThreadLiveWork {
  readonly threadId: ThreadId;
  /** The agent's state (see `deriveThreadActivityStatus`). */
  readonly activity: ThreadActivityStatus;
  /** How many of the thread's terminals are running a command. */
  readonly runningTerminals: number;
}

/** The live work of each chat thread, from its summary and its terminals' activity. */
export function chatThreadLiveWork(
  threads: ReadonlyArray<
    Pick<SidebarThreadSummary, "id"> & Parameters<typeof deriveThreadActivityStatus>[0]
  >,
  runningTerminals: (threadId: ThreadId) => number,
): ChatThreadLiveWork[] {
  return threads.map((thread) => ({
    threadId: thread.id,
    activity: deriveThreadActivityStatus(thread),
    runningTerminals: runningTerminals(thread.id),
  }));
}

/**
 * A compact fingerprint of the chat's live work (one entry per thread). The
 * dialog re-reads the preview when it changes, so the busy notice clears by
 * itself once the agent stops or a terminal command ends.
 */
export function chatActivitySignature(work: ReadonlyArray<ChatThreadLiveWork>): string {
  return work
    .map((entry) => `${entry.threadId}:${entry.activity}:${entry.runningTerminals}`)
    .join("|");
}

/** Agent work that interrupting the thread's turn stops; idle and a ready plan are not work. */
function isAgentWorking(activity: ThreadActivityStatus | undefined): boolean {
  return activity !== undefined && activity !== "idle" && activity !== "plan-ready";
}

export interface ChatBusyPresentation {
  readonly title: string;
  readonly message: string;
  /** Busy threads whose agent is working: what "Stop the agent" interrupts. Empty hides it. */
  readonly stoppableThreadIds: ReadonlyArray<ThreadId>;
  /**
   * Some of the work is not the agent's (a terminal command, or something this client cannot
   * see), and "Stop the agent" cannot end it: offer to check again by hand.
   */
  readonly offerRecheck: boolean;
}

/**
 * Explains why the preview found the chat busy, from what this client sees of each busy thread:
 * the agent working, a terminal running a command, or work it cannot see (a message that is still
 * starting, a model switch, a revert, a terminal it missed). Null when nothing is busy.
 */
export function describeChatBusy(input: {
  readonly busyThreadIds: ReadonlyArray<ThreadId>;
  readonly work: ReadonlyArray<ChatThreadLiveWork>;
}): ChatBusyPresentation | null {
  if (input.busyThreadIds.length === 0) return null;
  const workById = new Map(input.work.map((entry) => [entry.threadId, entry] as const));
  const stoppableThreadIds = input.busyThreadIds.filter((threadId) =>
    isAgentWorking(workById.get(threadId)?.activity),
  );
  const otherThreadIds = input.busyThreadIds.filter(
    (threadId) => !stoppableThreadIds.includes(threadId),
  );
  const terminalOnly =
    otherThreadIds.length > 0 &&
    otherThreadIds.every((threadId) => (workById.get(threadId)?.runningTerminals ?? 0) > 0);
  if (otherThreadIds.length === 0) {
    return {
      title: "The agent is still working in this chat",
      message: "Wait for the agent to finish (or stop it) before moving the chat.",
      stoppableThreadIds,
      offerRecheck: false,
    };
  }
  if (stoppableThreadIds.length === 0 && terminalOnly) {
    return {
      title: "A terminal is still running a command in this chat",
      message:
        "Let the command finish, or stop it in its terminal, before moving the chat. The dialog checks again when it ends.",
      stoppableThreadIds,
      offerRecheck: true,
    };
  }
  return {
    title: "This chat is still busy",
    message:
      stoppableThreadIds.length > 0
        ? terminalOnly
          ? "Stop the agent or let it finish, and let the terminal command end, before moving the chat."
          : "Stop the agent or let it finish, and wait for the rest of the chat's work to end, before moving the chat."
        : "Something is still running in this chat, such as a terminal command or a message that is starting. Wait for it to finish, then check again.",
    stoppableThreadIds,
    offerRecheck: true,
  };
}
