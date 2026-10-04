import {
  type ComposerSourceControlContext,
  type EnvironmentId,
  ProjectId,
  type ModelSelection,
  type ScopedThreadRef,
  type ThreadId,
} from "@ryco/contracts";
import {
  isChatImageAttachment,
  type ChatMessage,
  DEFAULT_AGENT_TOKEN_MODE,
  type Thread,
} from "../types";
import { type ComposerImageAttachment, type DraftThreadState } from "../composerDraftStore";
import { DateTime, Schema } from "effect";
import { selectThreadByRef, useStore } from "../store";
import {
  filterTerminalContextsWithText,
  stripInlineTerminalContextPlaceholders,
  type TerminalContextDraft,
} from "../lib/terminalContext";
import type { DraftThreadEnvMode } from "../composerDraftStore";
export {
  deriveProviderSelectionPolicy,
  normalizeInteractionModeForProviderTarget,
  selectionAllowedAtSendBoundary,
  type ProviderSelectionPolicy,
  type ProviderSelectionPolicyReason,
} from "@ryco/client-runtime/state/composer";

export const LAST_INVOKED_SCRIPT_BY_PROJECT_KEY = "ryco:last-invoked-script-by-project";
export const MAX_HIDDEN_MOUNTED_TERMINAL_THREADS = 10;

export const LastInvokedScriptByProjectSchema = Schema.Record(ProjectId, Schema.String);

export function resolveHeaderLiveAgentCount(input: {
  readonly liveCount: number;
  readonly workspacePanelOpen: boolean;
  readonly workspaceTab: string | null | undefined;
}): number {
  return input.workspacePanelOpen && input.workspaceTab === "agents" ? 0 : input.liveCount;
}

export function buildLocalDraftThread(
  threadId: ThreadId,
  draftThread: DraftThreadState,
  fallbackModelSelection: ModelSelection,
  error: string | null,
): Thread {
  return {
    id: threadId,
    environmentId: draftThread.environmentId,
    codexThreadId: null,
    projectId: draftThread.projectId,
    title: "New thread",
    modelSelection: fallbackModelSelection,
    runtimeMode: draftThread.runtimeMode,
    interactionMode: draftThread.interactionMode,
    tokenMode: draftThread.tokenMode ?? DEFAULT_AGENT_TOKEN_MODE,
    session: null,
    messages: [],
    error,
    createdAt: draftThread.createdAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    latestTurn: null,
    branch: draftThread.branch,
    worktreePath: draftThread.worktreePath,
    turnDiffSummaries: [],
    activities: [],
    proposedPlans: [],
  };
}

export function shouldWriteThreadErrorToCurrentServerThread(input: {
  serverThread:
    | {
        environmentId: EnvironmentId;
        id: ThreadId;
      }
    | null
    | undefined;
  routeThreadRef: ScopedThreadRef;
  targetThreadId: ThreadId;
}): boolean {
  return Boolean(
    input.serverThread &&
    input.targetThreadId === input.routeThreadRef.threadId &&
    input.serverThread.environmentId === input.routeThreadRef.environmentId &&
    input.serverThread.id === input.targetThreadId,
  );
}

export function reconcileMountedTerminalThreadIds(input: {
  currentThreadIds: ReadonlyArray<string>;
  openThreadIds: ReadonlyArray<string>;
  activeThreadId: string | null;
  activeThreadTerminalOpen: boolean;
  maxHiddenThreadCount?: number;
}): string[] {
  const openThreadIdSet = new Set(input.openThreadIds);
  const hiddenThreadIds = input.currentThreadIds.filter(
    (threadId) => threadId !== input.activeThreadId && openThreadIdSet.has(threadId),
  );
  const maxHiddenThreadCount = Math.max(
    0,
    input.maxHiddenThreadCount ?? MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  );
  const nextThreadIds =
    hiddenThreadIds.length > maxHiddenThreadCount
      ? hiddenThreadIds.slice(-maxHiddenThreadCount)
      : hiddenThreadIds;

  if (
    input.activeThreadId &&
    input.activeThreadTerminalOpen &&
    !nextThreadIds.includes(input.activeThreadId)
  ) {
    nextThreadIds.push(input.activeThreadId);
  }

  return nextThreadIds;
}

export function revokeBlobPreviewUrl(previewUrl: string | undefined): void {
  if (!previewUrl || typeof URL === "undefined" || !previewUrl.startsWith("blob:")) {
    return;
  }
  URL.revokeObjectURL(previewUrl);
}

export function revokeUserMessagePreviewUrls(message: ChatMessage): void {
  if (message.role !== "user" || !message.attachments) {
    return;
  }
  for (const attachment of message.attachments) {
    if (!isChatImageAttachment(attachment)) {
      continue;
    }
    revokeBlobPreviewUrl(attachment.previewUrl);
  }
}

export function collectUserMessageBlobPreviewUrls(message: ChatMessage): string[] {
  if (message.role !== "user" || !message.attachments) {
    return [];
  }
  const previewUrls: string[] = [];
  for (const attachment of message.attachments) {
    if (!isChatImageAttachment(attachment)) continue;
    if (!attachment.previewUrl || !attachment.previewUrl.startsWith("blob:")) continue;
    previewUrls.push(attachment.previewUrl);
  }
  return previewUrls;
}

export interface PullRequestDialogState {
  initialReference: string | null;
  key: number;
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("Could not read image data."));
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("Failed to read image."));
    });
    reader.readAsDataURL(file);
  });
}

export function resolveSendEnvMode(input: {
  requestedEnvMode: DraftThreadEnvMode;
  isGitRepo: boolean;
}): DraftThreadEnvMode {
  return input.isGitRepo ? input.requestedEnvMode : "local";
}

export function resolveChatSendWorktreePlan(input: {
  isServerThread: boolean;
  isFirstMessage: boolean;
  threadWorktreePath: string | null;
  activeThreadBranch: string | null;
  currentGitRefName: string | null;
  sendEnvMode: DraftThreadEnvMode;
}): {
  shouldMaterializeLegacyBranchWorktree: boolean;
  baseBranchForWorktree: string | null;
  shouldCreateWorktree: boolean;
} {
  const shouldMaterializeLegacyBranchWorktree =
    input.isServerThread &&
    !input.isFirstMessage &&
    input.threadWorktreePath === null &&
    input.activeThreadBranch !== null &&
    input.currentGitRefName !== null &&
    input.currentGitRefName !== input.activeThreadBranch;

  const baseBranchForWorktree =
    input.isFirstMessage && input.sendEnvMode === "worktree" && !input.threadWorktreePath
      ? input.activeThreadBranch
      : shouldMaterializeLegacyBranchWorktree
        ? input.activeThreadBranch
        : null;

  const shouldCreateWorktree =
    (input.isFirstMessage && input.sendEnvMode === "worktree" && !input.threadWorktreePath) ||
    shouldMaterializeLegacyBranchWorktree;

  return {
    shouldMaterializeLegacyBranchWorktree,
    baseBranchForWorktree,
    shouldCreateWorktree,
  };
}

export function buildChatSendTitleSeed(input: {
  trimmedPrompt: string;
  firstImageName: string | null;
  firstTerminalContextLabel: string | null;
}): string {
  const normalizedPrompt = input.trimmedPrompt.trim();
  if (normalizedPrompt.length > 0) {
    return normalizedPrompt;
  }
  if (input.firstImageName) {
    return `Attachment: ${input.firstImageName}`;
  }
  if (input.firstTerminalContextLabel) {
    return input.firstTerminalContextLabel;
  }
  return "New thread";
}

export function cloneComposerImageForRetry(
  image: ComposerImageAttachment,
): ComposerImageAttachment {
  if (typeof URL === "undefined" || !image.previewUrl.startsWith("blob:") || !image.file) {
    return image;
  }
  try {
    return {
      ...image,
      previewUrl: URL.createObjectURL(image.file),
    };
  } catch {
    return image;
  }
}

export function deriveComposerSendState(options: {
  prompt: string;
  imageCount: number;
  terminalContexts: ReadonlyArray<TerminalContextDraft>;
  sourceControlContexts?: ReadonlyArray<unknown>;
}): {
  trimmedPrompt: string;
  sendableTerminalContexts: TerminalContextDraft[];
  expiredTerminalContextCount: number;
  hasSendableContent: boolean;
} {
  const trimmedPrompt = stripInlineTerminalContextPlaceholders(options.prompt).trim();
  const sendableTerminalContexts = filterTerminalContextsWithText(options.terminalContexts);
  const expiredTerminalContextCount =
    options.terminalContexts.length - sendableTerminalContexts.length;
  const sourceControlContextCount = options.sourceControlContexts?.length ?? 0;
  return {
    trimmedPrompt,
    sendableTerminalContexts,
    expiredTerminalContextCount,
    hasSendableContent:
      trimmedPrompt.length > 0 ||
      options.imageCount > 0 ||
      sendableTerminalContexts.length > 0 ||
      sourceControlContextCount > 0,
  };
}

export function buildExpiredTerminalContextToastCopy(
  expiredTerminalContextCount: number,
  variant: "omitted" | "empty",
): { title: string; description: string } {
  const count = Math.max(1, Math.floor(expiredTerminalContextCount));
  const noun = count === 1 ? "Expired terminal context" : "Expired terminal contexts";
  if (variant === "empty") {
    return {
      title: `${noun} won't be sent`,
      description: "Remove it or re-add it to include terminal output.",
    };
  }
  return {
    title: `${noun} omitted from message`,
    description: "Re-add it if you want that terminal output included.",
  };
}

/**
 * For each context whose `staleAfter` timestamp has passed, calls `fetcher`
 * to re-fetch detail and returns a new context with bumped timestamps.
 * On any failure the original context is kept (best-effort semantics).
 */
export async function refreshStaleSourceControlContexts(
  contexts: ReadonlyArray<ComposerSourceControlContext>,
  options: {
    fetcher: (context: ComposerSourceControlContext) => Promise<ComposerSourceControlContext>;
  },
): Promise<ComposerSourceControlContext[]> {
  const now = DateTime.fromDateUnsafe(new Date());
  return Promise.all(
    contexts.map(async (ctx) => {
      const isStale = DateTime.isLessThanOrEqualTo(ctx.staleAfter, now);
      if (!isStale) return ctx;
      try {
        return await options.fetcher(ctx);
      } catch {
        // best-effort: keep original on failure
        return ctx;
      }
    }),
  );
}

export function threadHasStarted(thread: Thread | null | undefined): boolean {
  return Boolean(
    thread && (thread.latestTurn !== null || thread.messages.length > 0 || thread.session !== null),
  );
}

// The draft -> server route swap remounts ChatView, which drops component-local
// optimistic send state. Wait for runtime state that can independently render
// "Working for ..." instead of swapping as soon as the user message is persisted.
export function threadIsPromotedAndPersisted(thread: Thread | null | undefined): boolean {
  return Boolean(thread && (thread.latestTurn !== null || thread.messages.length > 0));
}

export async function waitForStartedServerThread(
  threadRef: ScopedThreadRef,
  timeoutMs = 1_000,
): Promise<boolean> {
  const getThread = () => selectThreadByRef(useStore.getState(), threadRef);
  const thread = getThread();

  if (threadHasStarted(thread)) {
    return true;
  }

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
    const finish = (result: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId !== null) {
        globalThis.clearTimeout(timeoutId);
      }
      unsubscribe();
      resolve(result);
    };

    const unsubscribe = useStore.subscribe((state) => {
      if (!threadHasStarted(selectThreadByRef(state, threadRef))) {
        return;
      }
      finish(true);
    });

    if (threadHasStarted(getThread())) {
      finish(true);
      return;
    }

    timeoutId = globalThis.setTimeout(() => {
      finish(false);
    }, timeoutMs);
  });
}

export {
  createLocalDispatchSnapshot,
  hasServerAcknowledgedLocalDispatch,
  type LocalDispatchSnapshot,
} from "@ryco/client-runtime/state/session";

/**
 * Whether to replace the timeline with the new-thread surface (hero + "Work in
 * …" sentence).
 *
 * Three conditions, each learned the hard way:
 * - No messages *and* no optimistic sends, so the surface disappears the moment
 *   a turn starts rather than after the server acknowledges it.
 * - No other timeline entries either. A thread can carry work-log rows, a
 *   proposed plan, or setup-script activity from worktree creation while
 *   `messages` is still empty; showing the hero then would hide real progress
 *   and real failures.
 * - Not the phone tier. `apps/web`'s phone presentation is frozen and
 *   `apps/mobile` owns that experience (AGENTS.md), so this surface is
 *   desktop-only.
 */
export function shouldShowNewThreadSurface(input: {
  readonly hasThread: boolean;
  readonly messageCount: number;
  readonly optimisticMessageCount: number;
  readonly timelineEntryCount: number;
  readonly presentationTier: string;
}): boolean {
  return (
    input.hasThread &&
    input.messageCount === 0 &&
    input.optimisticMessageCount === 0 &&
    input.timelineEntryCount === 0 &&
    input.presentationTier !== "phone"
  );
}
