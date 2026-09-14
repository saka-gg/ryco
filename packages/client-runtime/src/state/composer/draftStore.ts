import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  defaultInstanceIdForDriver,
  type EnvironmentId,
  ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ProviderInteractionMode,
  ProviderDriverKind,
  ProviderOptionSelection,
  RuntimeMode,
  AgentTokenMode,
  type ServerProvider,
  type ScopedProjectRef,
  type ScopedThreadRef,
  ThreadId,
  type ComposerSourceControlContext,
  type WorkItemState,
} from "@ryco/contracts";
import { scopedThreadKey, scopeThreadRef } from "../../scoped.ts";
import * as Schema from "effect/Schema";
import * as Equal from "effect/Equal";
import { createModelSelection, normalizeModelSlug } from "@ryco/shared/model";
import {
  DEFAULT_AGENT_TOKEN_MODE,
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type ChatFileAttachment,
  type ChatImageAttachment,
} from "../threads/types.ts";
import {
  type TerminalContextDraft,
  ensureInlineTerminalContextPlaceholders,
  normalizeTerminalContextText,
} from "./terminalContext.ts";
import { create } from "zustand";
import { createJSONStorage, persist, type PersistStorage } from "zustand/middleware";
import { getDefaultServerModel } from "./providerModels.ts";
import type { UnifiedSettings } from "@ryco/contracts/settings";
import { resolveAppModelSelection, resolveAppModelSelectionForInstance } from "./modelSelection.ts";
import {
  COMPOSER_DRAFT_STORAGE_KEY,
  COMPOSER_DRAFT_STORAGE_VERSION,
  composerTargetKey,
  isAgentTokenMode,
  isRuntimeMode,
  logicalProjectDraftKey,
  migratePersistedComposerDraftStoreState,
  normalizeCurrentPersistedComposerDraftStoreState,
  normalizeModelSelection,
  normalizeProviderDriverKind,
  partializeComposerDraftStoreState,
  projectDraftKey,
  toHydratedDraftThreadState,
  toHydratedThreadDraft,
  type DraftThreadEnvMode,
  type HydrateComposerImages,
  type PersistedComposerDraftStoreState,
  type PersistedComposerImageAttachment,
  type ProviderOptionSelectionsByProvider,
} from "./draftPersistence.ts";

export const DraftId = Schema.String.pipe(Schema.brand("DraftId"));
export type DraftId = typeof DraftId.Type;

/**
 * Neutral in-memory composer image shape used by the package store. The web
 * adapter extends this with a DOM `File` (`ComposerImageAttachment`); the
 * package never references `File`/`Blob` (blob-preview lifecycle stays app-side).
 */
export interface ComposerDraftImage extends Omit<
  ChatImageAttachment | ChatFileAttachment,
  "previewUrl"
> {
  previewUrl: string;
}

/**
 * Composer content keyed by either a draft session (`DraftId`) or a real server
 * thread (`ScopedThreadRef`). This is the editable payload shown in the composer.
 */
export interface ComposerThreadDraftState<TImage extends ComposerDraftImage = ComposerDraftImage> {
  prompt: string;
  images: TImage[];
  nonPersistedImageIds: string[];
  persistedAttachments: PersistedComposerImageAttachment[];
  terminalContexts: TerminalContextDraft[];
  /** Source-control contexts (issues / change requests) attached to this draft. Not persisted. */
  sourceControlContexts: ComposerSourceControlContext[];
  /**
   * Per-instance model selection. Keyed by `ProviderInstanceId` (open
   * branded slug) so a default `codex` instance and a user-authored
   * `codex_personal` instance each persist their own selected model. Every
   * historical `ProviderDriverKind` literal (`codex` / `claudeAgent` / `cursor` /
   * `grok` / `opencode`) also satisfies the `ProviderInstanceId` slug pattern, so
   * legacy kind-keyed drafts round-trip unchanged.
   */
  modelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>>;
  /** Routing key of the last picked instance (see `modelSelectionByProvider`). */
  activeProvider: ProviderInstanceId | null;
  runtimeMode: RuntimeMode | null;
  interactionMode: ProviderInteractionMode | null;
  tokenMode?: AgentTokenMode | null;
}

/**
 * Mutable routing and execution context for a pre-thread draft session.
 *
 * Unlike a real server thread, a draft session can still change target
 * environment/worktree configuration before the first send.
 */
/**
 * A pull request, issue, or work item the user picked as the origin for a
 * worktree that does not exist yet.
 *
 * Held as plain data rather than materialized on selection: picking a source
 * is a statement of intent, and creating a git worktree is a side effect on
 * disk. The two are joined on first send, where the worktree is created from
 * this intent exactly as the New worktree dialog would.
 *
 * `label` is captured at selection time so the sentence can name the source
 * without re-fetching it.
 */
export type DraftWorktreeSource =
  | { readonly kind: "pr"; readonly number: number; readonly label: string }
  | {
      readonly kind: "issue";
      readonly number: number;
      readonly title: string;
      readonly label: string;
    }
  | {
      readonly kind: "workItem";
      readonly provider: "jira";
      readonly key: string;
      readonly title: string;
      readonly state?: WorkItemState | undefined;
      readonly stateName?: string | undefined;
      readonly url?: string | undefined;
      readonly label: string;
    };

export interface DraftSessionState {
  threadId: ThreadId;
  environmentId: EnvironmentId;
  projectId: ProjectId;
  logicalProjectKey: string;
  createdAt: string;
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;
  tokenMode?: AgentTokenMode;
  branch: string | null;
  worktreePath: string | null;
  envMode: DraftThreadEnvMode;
  /** Set only in `worktree` mode when the base is not a plain branch. */
  worktreeSource?: DraftWorktreeSource | null;
  fetchOrigin?: boolean;
  worktreeBranchName?: string | null;
  promotedTo?: ScopedThreadRef | null;
}

export type DraftThreadState = DraftSessionState;

/**
 * Draft session metadata paired with its stable draft-session identity.
 */
interface ProjectDraftSession extends DraftSessionState {
  draftId: DraftId;
}

/**
 * App-facing composer identity:
 * - `DraftId` for pre-thread draft sessions
 * - `ScopedThreadRef` for server-backed threads
 *
 * Raw `ThreadId` is intentionally excluded so callers cannot drop environment
 * identity for real threads.
 */
export type ComposerThreadTarget = ScopedThreadRef | DraftId;

/**
 * Persisted store for composer content plus draft-session metadata.
 *
 * The store intentionally models two domains:
 * - draft sessions keyed by `DraftId`
 * - server thread composer state keyed by `ScopedThreadRef`
 */
export interface ComposerDraftStoreState<TImage extends ComposerDraftImage = ComposerDraftImage> {
  draftsByThreadKey: Record<string, ComposerThreadDraftState<TImage>>;
  draftThreadsByThreadKey: Record<string, DraftThreadState>;
  logicalProjectDraftThreadKeyByLogicalProjectKey: Record<string, string>;
  stickyModelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>>;
  stickyActiveProvider: ProviderInstanceId | null;
  /** Returns the editable composer content for a draft session or server thread. */
  getComposerDraft: (target: ComposerThreadTarget) => ComposerThreadDraftState<TImage> | null;
  /** Looks up the active draft session for a logical project identity. */
  getDraftThreadByLogicalProjectKey: (logicalProjectKey: string) => ProjectDraftSession | null;
  getDraftSessionByLogicalProjectKey: (logicalProjectKey: string) => ProjectDraftSession | null;
  getDraftThreadByProjectRef: (projectRef: ScopedProjectRef) => ProjectDraftSession | null;
  getDraftSessionByProjectRef: (projectRef: ScopedProjectRef) => ProjectDraftSession | null;
  /** Reads mutable draft-session metadata by `DraftId`. */
  getDraftSession: (draftId: DraftId) => DraftSessionState | null;
  /** Resolves a server-thread ref back to a matching draft session when one exists. */
  getDraftSessionByRef: (threadRef: ScopedThreadRef) => DraftSessionState | null;
  getDraftThreadByRef: (threadRef: ScopedThreadRef) => DraftThreadState | null;
  getDraftThread: (threadRef: ComposerThreadTarget) => DraftThreadState | null;
  listDraftThreadKeys: () => string[];
  hasDraftThreadsInEnvironment: (environmentId: EnvironmentId) => boolean;
  /** Creates or updates the draft session tracked for a logical project. */
  setLogicalProjectDraftThreadId: (
    logicalProjectKey: string,
    projectRef: ScopedProjectRef,
    draftId: DraftId,
    options?: {
      threadId?: ThreadId;
      branch?: string | null;
      worktreePath?: string | null;
      createdAt?: string;
      envMode?: DraftThreadEnvMode;
      runtimeMode?: RuntimeMode;
      interactionMode?: ProviderInteractionMode;
      tokenMode?: AgentTokenMode;
    },
  ) => void;
  /** Creates or updates the draft session tracked for a concrete project ref. */
  setProjectDraftThreadId: (
    projectRef: ScopedProjectRef,
    draftId: DraftId,
    options?: {
      threadId?: ThreadId;
      branch?: string | null;
      worktreePath?: string | null;
      createdAt?: string;
      envMode?: DraftThreadEnvMode;
      runtimeMode?: RuntimeMode;
      interactionMode?: ProviderInteractionMode;
      tokenMode?: AgentTokenMode;
    },
  ) => void;
  /** Updates mutable draft-session metadata without touching composer content. */
  setDraftThreadContext: (
    threadRef: ComposerThreadTarget,
    options: {
      branch?: string | null;
      worktreePath?: string | null;
      worktreeSource?: DraftWorktreeSource | null;
      fetchOrigin?: boolean;
      worktreeBranchName?: string | null;
      projectRef?: ScopedProjectRef;
      createdAt?: string;
      envMode?: DraftThreadEnvMode;
      runtimeMode?: RuntimeMode;
      interactionMode?: ProviderInteractionMode;
      tokenMode?: AgentTokenMode;
    },
  ) => void;
  /**
   * Retargets an existing draft session at a different project, keeping its
   * composer content (prompt, attachments, model/provider selection) intact.
   *
   * Distinct from starting a new thread in that project: the caller is editing
   * the project *field* of the thread being composed, not navigating to another
   * draft. Branch and worktree path are dropped because they belong to the old
   * repository. The logical-project mapping moves with the draft, so the old
   * project no longer resolves to it.
   */
  moveDraftThreadToProject: (
    threadRef: ComposerThreadTarget,
    input: { projectRef: ScopedProjectRef; logicalProjectKey: string },
  ) => void;
  clearProjectDraftThreadId: (projectRef: ScopedProjectRef) => void;
  clearProjectDraftThreadById: (
    projectRef: ScopedProjectRef,
    threadRef: ComposerThreadTarget,
  ) => void;
  /** Marks a draft session as being promoted to a real server thread. */
  markDraftThreadPromoting: (threadRef: ComposerThreadTarget, promotedTo?: ScopedThreadRef) => void;
  /** Removes draft-session metadata after promotion is complete. */
  finalizePromotedDraftThread: (threadRef: ComposerThreadTarget) => void;
  clearDraftThread: (threadRef: ComposerThreadTarget) => void;
  setStickyModelSelection: (modelSelection: ModelSelection | null | undefined) => void;
  setPrompt: (threadRef: ComposerThreadTarget, prompt: string) => void;
  setTerminalContexts: (threadRef: ComposerThreadTarget, contexts: TerminalContextDraft[]) => void;
  setModelSelection: (
    threadRef: ComposerThreadTarget,
    modelSelection: ModelSelection | null | undefined,
  ) => void;
  /** Replace the model options for one or more providers in the draft. */
  setModelOptions: (
    threadRef: ComposerThreadTarget,
    modelOptions:
      | Partial<Record<string, ReadonlyArray<ProviderOptionSelection>>>
      | null
      | undefined,
  ) => void;
  applyStickyState: (threadRef: ComposerThreadTarget) => void;
  setProviderModelOptions: (
    threadRef: ComposerThreadTarget,
    provider: ProviderDriverKind,
    nextProviderOptions: ReadonlyArray<ProviderOptionSelection> | null | undefined,
    options?: {
      instanceId?: ProviderInstanceId | null | undefined;
      model?: string | null | undefined;
      persistSticky?: boolean;
    },
  ) => void;
  setRuntimeMode: (
    threadRef: ComposerThreadTarget,
    runtimeMode: RuntimeMode | null | undefined,
  ) => void;
  setInteractionMode: (
    threadRef: ComposerThreadTarget,
    interactionMode: ProviderInteractionMode | null | undefined,
  ) => void;
  setTokenMode: (
    threadRef: ComposerThreadTarget,
    tokenMode: AgentTokenMode | null | undefined,
  ) => void;
  addImage: (threadRef: ComposerThreadTarget, image: TImage) => void;
  addImages: (threadRef: ComposerThreadTarget, images: TImage[]) => void;
  removeImage: (threadRef: ComposerThreadTarget, imageId: string) => void;
  /** Applies an in-place update to one staged attachment (e.g. upload token). */
  updateImage: (
    threadRef: ComposerThreadTarget,
    imageId: string,
    update: (image: TImage) => TImage,
  ) => void;
  insertTerminalContext: (
    threadRef: ComposerThreadTarget,
    prompt: string,
    context: TerminalContextDraft,
    index: number,
  ) => boolean;
  addTerminalContext: (threadRef: ComposerThreadTarget, context: TerminalContextDraft) => void;
  addTerminalContexts: (threadRef: ComposerThreadTarget, contexts: TerminalContextDraft[]) => void;
  removeTerminalContext: (threadRef: ComposerThreadTarget, contextId: string) => void;
  clearTerminalContexts: (threadRef: ComposerThreadTarget) => void;
  addSourceControlContext: (
    threadRef: ComposerThreadTarget,
    context: ComposerSourceControlContext,
  ) => { added: boolean; reason?: "duplicate" };
  removeSourceControlContext: (threadRef: ComposerThreadTarget, id: string) => void;
  clearSourceControlContexts: (threadRef: ComposerThreadTarget) => void;
  clearPersistedAttachments: (threadRef: ComposerThreadTarget) => void;
  syncPersistedAttachments: (
    threadRef: ComposerThreadTarget,
    attachments: PersistedComposerImageAttachment[],
  ) => void;
  /** Clears only stashable prompt content, preserving all routing, modes, and contexts. */
  clearPromptAndImages: (threadRef: ComposerThreadTarget) => void;
  clearComposerContent: (threadRef: ComposerThreadTarget) => void;
}

export interface EffectiveComposerModelState {
  selectedModel: string;
  modelOptions: ProviderOptionSelectionsByProvider | null;
}

export interface ComposerDraftModelState {
  activeProvider: ProviderInstanceId | null;
  modelSelectionByProvider: Partial<Record<ProviderInstanceId, ModelSelection>>;
}

function providerSelectionsFromModelSelection(
  modelSelection: ModelSelection | null | undefined,
): ProviderOptionSelectionsByProvider | null {
  if (!modelSelection) {
    return null;
  }
  const options = modelSelection.options;
  if (!options || options.length === 0) {
    return null;
  }
  return { [modelSelection.instanceId]: options };
}

function modelSelectionByProviderToOptions(
  map: Partial<Record<string, ModelSelection>> | null | undefined,
): ProviderOptionSelectionsByProvider | null {
  if (!map) return null;
  const result: ProviderOptionSelectionsByProvider = {};
  for (const [provider, selection] of Object.entries(map)) {
    if (selection?.options && selection.options.length > 0) {
      result[provider] = selection.options;
    }
  }
  return Object.keys(result).length > 0 ? result : null;
}

const EMPTY_IMAGES: never[] = [];
const EMPTY_IDS: string[] = [];
const EMPTY_PERSISTED_ATTACHMENTS: PersistedComposerImageAttachment[] = [];
const EMPTY_TERMINAL_CONTEXTS: TerminalContextDraft[] = [];
const EMPTY_SOURCE_CONTROL_CONTEXTS: ComposerSourceControlContext[] = [];
Object.freeze(EMPTY_IMAGES);
Object.freeze(EMPTY_IDS);
Object.freeze(EMPTY_PERSISTED_ATTACHMENTS);
Object.freeze(EMPTY_SOURCE_CONTROL_CONTEXTS);
const EMPTY_MODEL_SELECTION_BY_PROVIDER: Partial<Record<ProviderDriverKind, ModelSelection>> =
  Object.freeze({});
export const EMPTY_COMPOSER_DRAFT_MODEL_STATE = Object.freeze<ComposerDraftModelState>({
  activeProvider: null,
  modelSelectionByProvider: EMPTY_MODEL_SELECTION_BY_PROVIDER,
});

export const EMPTY_THREAD_DRAFT = Object.freeze<ComposerThreadDraftState<never>>({
  prompt: "",
  images: EMPTY_IMAGES,
  nonPersistedImageIds: EMPTY_IDS,
  persistedAttachments: EMPTY_PERSISTED_ATTACHMENTS,
  terminalContexts: EMPTY_TERMINAL_CONTEXTS,
  sourceControlContexts: EMPTY_SOURCE_CONTROL_CONTEXTS,
  modelSelectionByProvider: EMPTY_MODEL_SELECTION_BY_PROVIDER,
  activeProvider: null,
  runtimeMode: null,
  interactionMode: null,
  tokenMode: null,
});

function createEmptyThreadDraft(): ComposerThreadDraftState<never> {
  return {
    prompt: "",
    images: [],
    nonPersistedImageIds: [],
    persistedAttachments: [],
    terminalContexts: [],
    sourceControlContexts: [],
    modelSelectionByProvider: {},
    activeProvider: null,
    runtimeMode: null,
    interactionMode: null,
    tokenMode: null,
  };
}

export function composerDraftImageDedupKey(image: ComposerDraftImage): string {
  // Keep this independent from File.lastModified so dedupe is stable for hydrated
  // images reconstructed from localStorage (which get a fresh lastModified value).
  return `${image.mimeType}\u0000${image.sizeBytes}\u0000${image.name}`;
}

function terminalContextDedupKey(context: TerminalContextDraft): string {
  return `${context.terminalId}\u0000${context.lineStart}\u0000${context.lineEnd}`;
}

function normalizeTerminalContextForThread(
  threadId: ThreadId,
  context: TerminalContextDraft,
): TerminalContextDraft | null {
  const terminalId = context.terminalId.trim();
  const terminalLabel = context.terminalLabel.trim();
  if (terminalId.length === 0 || terminalLabel.length === 0) {
    return null;
  }
  const lineStart = Math.max(1, Math.floor(context.lineStart));
  const lineEnd = Math.max(lineStart, Math.floor(context.lineEnd));
  return {
    ...context,
    threadId,
    terminalId,
    terminalLabel,
    lineStart,
    lineEnd,
    text: normalizeTerminalContextText(context.text),
  };
}

function normalizeTerminalContextsForThread(
  threadId: ThreadId,
  contexts: ReadonlyArray<TerminalContextDraft>,
): TerminalContextDraft[] {
  const existingIds = new Set<string>();
  const existingDedupKeys = new Set<string>();
  const normalizedContexts: TerminalContextDraft[] = [];

  for (const context of contexts) {
    const normalizedContext = normalizeTerminalContextForThread(threadId, context);
    if (!normalizedContext) {
      continue;
    }
    const dedupKey = terminalContextDedupKey(normalizedContext);
    if (existingIds.has(normalizedContext.id) || existingDedupKeys.has(dedupKey)) {
      continue;
    }
    normalizedContexts.push(normalizedContext);
    existingIds.add(normalizedContext.id);
    existingDedupKeys.add(dedupKey);
  }

  return normalizedContexts;
}

function shouldRemoveDraft(draft: ComposerThreadDraftState): boolean {
  return (
    draft.prompt.length === 0 &&
    draft.images.length === 0 &&
    draft.persistedAttachments.length === 0 &&
    draft.terminalContexts.length === 0 &&
    draft.sourceControlContexts.length === 0 &&
    Object.keys(draft.modelSelectionByProvider).length === 0 &&
    draft.activeProvider === null &&
    draft.runtimeMode === null &&
    draft.interactionMode === null &&
    draft.tokenMode == null
  );
}

export function deriveEffectiveComposerModelState(input: {
  draft:
    | Pick<ComposerThreadDraftState, "modelSelectionByProvider" | "activeProvider">
    | null
    | undefined;
  providers: ReadonlyArray<ServerProvider>;
  selectedProvider: ProviderDriverKind;
  /**
   * Optional routing key of the instance whose selection should override
   * the driver-level lookup. When present, the draft is queried by
   * `modelSelectionByProvider[selectedInstanceId]` so a custom Codex
   * instance (e.g. `codex_personal`) reads its own saved model instead of
   * collapsing to the default Codex bucket.
   */
  selectedInstanceId?: ProviderInstanceId | null | undefined;
  threadModelSelection: ModelSelection | null | undefined;
  /** @deprecated Project defaults are ignored; retained for older callers. */
  projectModelSelection?: ModelSelection | null | undefined;
  settings: UnifiedSettings;
}): EffectiveComposerModelState {
  const baseModelCandidate = input.threadModelSelection?.model ?? null;
  const baseModel =
    (input.selectedInstanceId
      ? resolveAppModelSelectionForInstance(
          input.selectedInstanceId,
          input.settings,
          input.providers,
          baseModelCandidate,
        )
      : null) ??
    resolveAppModelSelection(
      input.selectedProvider,
      input.settings,
      input.providers,
      baseModelCandidate,
    ) ??
    normalizeModelSlug(baseModelCandidate, input.selectedProvider) ??
    getDefaultServerModel(input.providers, input.selectedProvider);
  // Look up the instance's saved selection first; fall back to the
  // driver-kind bucket so legacy kind-keyed drafts still resolve. Every
  // `ProviderDriverKind` literal is a valid `ProviderInstanceId` slug, so the
  // cast to the branded type is safe.
  const instanceSelection = input.selectedInstanceId
    ? input.draft?.modelSelectionByProvider?.[input.selectedInstanceId]
    : undefined;
  const legacySelection =
    input.draft?.modelSelectionByProvider?.[ProviderInstanceId.make(input.selectedProvider)];
  const activeSelection = instanceSelection ?? legacySelection;
  const activeSelectionInstanceId = instanceSelection
    ? (input.selectedInstanceId ?? ProviderInstanceId.make(input.selectedProvider))
    : ProviderInstanceId.make(input.selectedProvider);
  const selectedModel = activeSelection?.model
    ? (resolveAppModelSelectionForInstance(
        activeSelectionInstanceId,
        input.settings,
        input.providers,
        activeSelection.model,
      ) ??
      resolveAppModelSelection(
        input.selectedProvider,
        input.settings,
        input.providers,
        activeSelection.model,
      ))
    : baseModel;
  const modelOptions =
    modelSelectionByProviderToOptions(input.draft?.modelSelectionByProvider) ??
    providerSelectionsFromModelSelection(input.threadModelSelection) ??
    null;

  return {
    selectedModel,
    modelOptions,
  };
}

type ComposerThreadLookupState = Pick<
  ComposerDraftStoreState,
  "draftsByThreadKey" | "draftThreadsByThreadKey"
>;

function normalizeComposerTarget(
  state: ComposerThreadLookupState,
  target: ComposerThreadTarget,
): ComposerThreadTarget | null {
  if (typeof target === "string") {
    const draftId = target.trim();
    return draftId.length > 0 ? DraftId.make(draftId) : null;
  }
  return target;
}

function resolveComposerDraftKey(
  state: ComposerThreadLookupState,
  target: ComposerThreadTarget,
): string | null {
  const normalizedTarget = normalizeComposerTarget(state, target);
  if (!normalizedTarget) {
    return null;
  }
  if (typeof normalizedTarget !== "string") {
    const scopedKey = composerTargetKey(normalizedTarget);
    if (state.draftsByThreadKey[scopedKey]) {
      return scopedKey;
    }
    for (const [draftId, draftSession] of Object.entries(state.draftThreadsByThreadKey)) {
      if (
        draftSession.environmentId === normalizedTarget.environmentId &&
        draftSession.threadId === normalizedTarget.threadId
      ) {
        return draftId;
      }
    }
    return scopedKey;
  }
  const threadKey = composerTargetKey(normalizedTarget);
  return threadKey.length > 0 ? threadKey : null;
}

function resolveComposerThreadId(
  state: ComposerThreadLookupState,
  target: ComposerThreadTarget,
): ThreadId | null {
  const normalizedTarget = normalizeComposerTarget(state, target);
  if (!normalizedTarget) {
    return null;
  }
  if (typeof normalizedTarget !== "string") {
    return normalizedTarget.threadId;
  }
  return state.draftThreadsByThreadKey[normalizedTarget]?.threadId ?? null;
}

export function getComposerDraftState<TImage extends ComposerDraftImage = ComposerDraftImage>(
  state: Pick<ComposerDraftStoreState<TImage>, "draftsByThreadKey" | "draftThreadsByThreadKey">,
  target: ComposerThreadTarget,
): ComposerThreadDraftState<TImage> | null {
  const threadKey = resolveComposerDraftKey(state, target);
  if (!threadKey) {
    return null;
  }
  return state.draftsByThreadKey[threadKey] ?? null;
}

function isComposerThreadKeyInUse(mappings: Record<string, string>, threadKey: string): boolean {
  return Object.values(mappings).includes(threadKey);
}

function toProjectDraftSession(
  draftId: DraftId,
  draftSession: DraftSessionState,
): ProjectDraftSession {
  return {
    draftId,
    ...draftSession,
  };
}

function createDraftThreadState(
  projectRef: ScopedProjectRef,
  threadId: ThreadId,
  logicalProjectKey: string,
  existingThread: DraftThreadState | undefined,
  options?: {
    threadId?: ThreadId;
    branch?: string | null;
    worktreePath?: string | null;
    worktreeSource?: DraftWorktreeSource | null;
    fetchOrigin?: boolean;
    worktreeBranchName?: string | null;
    createdAt?: string;
    envMode?: DraftThreadEnvMode;
    runtimeMode?: RuntimeMode;
    interactionMode?: ProviderInteractionMode;
    tokenMode?: AgentTokenMode;
  },
): DraftThreadState {
  const projectChanged =
    existingThread !== undefined &&
    (existingThread.environmentId !== projectRef.environmentId ||
      existingThread.projectId !== projectRef.projectId);
  const nextWorktreePath =
    options?.worktreePath === undefined
      ? projectChanged
        ? null
        : (existingThread?.worktreePath ?? null)
      : (options.worktreePath ?? null);
  const nextBranch =
    options?.branch === undefined
      ? projectChanged
        ? null
        : (existingThread?.branch ?? null)
      : (options.branch ?? null);
  return {
    threadId,
    environmentId: projectRef.environmentId,
    projectId: projectRef.projectId,
    logicalProjectKey,
    createdAt: options?.createdAt ?? existingThread?.createdAt ?? new Date().toISOString(),
    runtimeMode: options?.runtimeMode ?? existingThread?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
    interactionMode:
      options?.interactionMode ?? existingThread?.interactionMode ?? DEFAULT_INTERACTION_MODE,
    tokenMode: options?.tokenMode ?? existingThread?.tokenMode ?? DEFAULT_AGENT_TOKEN_MODE,
    fetchOrigin: options?.fetchOrigin ?? existingThread?.fetchOrigin ?? true,
    worktreeBranchName: projectChanged
      ? null
      : options?.worktreeBranchName === undefined
        ? (existingThread?.worktreeBranchName ?? null)
        : options.worktreeBranchName,
    branch: nextBranch,
    worktreePath: nextWorktreePath,
    // A source belongs to the repository it was picked from, so it is dropped
    // alongside branch and worktree path when the project changes.
    worktreeSource:
      options?.worktreeSource === undefined
        ? projectChanged
          ? null
          : (existingThread?.worktreeSource ?? null)
        : options.worktreeSource,
    envMode:
      options?.envMode ??
      (nextWorktreePath
        ? "worktree"
        : projectChanged
          ? "local"
          : (existingThread?.envMode ?? "local")),
    promotedTo: null,
  };
}

function scopedThreadRefsEqual(
  left: ScopedThreadRef | null | undefined,
  right: ScopedThreadRef | null | undefined,
): boolean {
  if (!left || !right) {
    return left === right;
  }
  return left.environmentId === right.environmentId && left.threadId === right.threadId;
}

function isDraftThreadPromoting(draftThread: DraftThreadState | null | undefined): boolean {
  return draftThread?.promotedTo !== null && draftThread?.promotedTo !== undefined;
}

function draftThreadsEqual(left: DraftThreadState | undefined, right: DraftThreadState): boolean {
  return (
    !!left &&
    left.threadId === right.threadId &&
    left.environmentId === right.environmentId &&
    left.projectId === right.projectId &&
    left.logicalProjectKey === right.logicalProjectKey &&
    left.createdAt === right.createdAt &&
    left.runtimeMode === right.runtimeMode &&
    left.interactionMode === right.interactionMode &&
    left.tokenMode === right.tokenMode &&
    left.branch === right.branch &&
    left.worktreePath === right.worktreePath &&
    left.envMode === right.envMode &&
    scopedThreadRefsEqual(left.promotedTo, right.promotedTo)
  );
}

/** Plain key-value storage injected by the platform (web binds localStorage). */
export interface ComposerDraftStorage {
  readonly getItem: (name: string) => string | null | Promise<string | null>;
  readonly setItem: (name: string, value: string) => unknown;
  readonly removeItem: (name: string) => unknown;
}

/**
 * Platform seams for the composer draft store. Persistence, the blob-preview
 * lifecycle, and dataURL decoding stay app-side; the store logic and Schema
 * migrations live here.
 */
export interface CreateComposerDraftStoreDeps<TImage extends ComposerDraftImage> {
  /** Persist-middleware storage (web binds a debounced localStorage wrapper). */
  readonly storage: ComposerDraftStorage;
  /** Flush buffered writes to durable storage before a verify read. */
  readonly flushStorage: () => void;
  /** Release a blob preview URL when an image leaves the draft (web-only lifecycle). */
  readonly revokePreviewUrl: (previewUrl: string) => void;
  /** Decode persisted (dataURL) attachments into in-memory images at the boundary. */
  readonly hydrateImages: HydrateComposerImages<TImage>;
  /** Read the currently-persisted attachment ids for a thread key (web storage read). */
  readonly readPersistedAttachmentIds: (threadKey: string) => string[];
}

/**
 * Builds the composer draft zustand store plus its promotion helpers over the
 * injected platform seams. No import-time side effects: the web binding module
 * owns storage binding and the `beforeunload` flush at its own module eval.
 */
export function createComposerDraftStore<TImage extends ComposerDraftImage>(
  deps: CreateComposerDraftStoreDeps<TImage>,
) {
  function revokeDraftThreadPreviewUrls(draft: ComposerThreadDraftState<TImage> | undefined): void {
    if (!draft) {
      return;
    }
    for (const image of draft.images) {
      deps.revokePreviewUrl(image.previewUrl);
    }
  }

  function removeDraftThreadReferences(
    state: Pick<
      ComposerDraftStoreState<TImage>,
      | "draftThreadsByThreadKey"
      | "draftsByThreadKey"
      | "logicalProjectDraftThreadKeyByLogicalProjectKey"
    >,
    threadKey: string,
  ): Pick<
    ComposerDraftStoreState<TImage>,
    | "draftThreadsByThreadKey"
    | "draftsByThreadKey"
    | "logicalProjectDraftThreadKeyByLogicalProjectKey"
  > {
    const nextLogicalMappings = Object.fromEntries(
      Object.entries(state.logicalProjectDraftThreadKeyByLogicalProjectKey).filter(
        ([, draftThreadKey]) => draftThreadKey !== threadKey,
      ),
    ) as Record<string, string>;
    const { [threadKey]: _removedDraftThread, ...restDraftThreadsByThreadKey } =
      state.draftThreadsByThreadKey;
    const { [threadKey]: removedComposerDraft, ...restDraftsByThreadKey } = state.draftsByThreadKey;
    revokeDraftThreadPreviewUrls(removedComposerDraft);
    return {
      draftsByThreadKey: restDraftsByThreadKey,
      draftThreadsByThreadKey: restDraftThreadsByThreadKey,
      logicalProjectDraftThreadKeyByLogicalProjectKey: nextLogicalMappings,
    };
  }

  function verifyPersistedAttachments(
    threadKey: string,
    attachments: PersistedComposerImageAttachment[],
    set: (
      partial:
        | ComposerDraftStoreState<TImage>
        | Partial<ComposerDraftStoreState<TImage>>
        | ((
            state: ComposerDraftStoreState<TImage>,
          ) => ComposerDraftStoreState<TImage> | Partial<ComposerDraftStoreState<TImage>>),
      replace?: false,
    ) => void,
  ): void {
    let persistedIdSet = new Set<string>();
    try {
      deps.flushStorage();
      persistedIdSet = new Set(deps.readPersistedAttachmentIds(threadKey));
    } catch {
      persistedIdSet = new Set();
    }
    set((state) => {
      const current = state.draftsByThreadKey[threadKey];
      if (!current) {
        return state;
      }
      const imageIdSet = new Set(current.images.map((image) => image.id));
      const persistedAttachments = attachments.filter(
        (attachment) => imageIdSet.has(attachment.id) && persistedIdSet.has(attachment.id),
      );
      const nonPersistedImageIds = current.images
        .map((image) => image.id)
        .filter((imageId) => !persistedIdSet.has(imageId));
      const nextDraft: ComposerThreadDraftState<TImage> = {
        ...current,
        persistedAttachments,
        nonPersistedImageIds,
      };
      const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
      if (shouldRemoveDraft(nextDraft)) {
        delete nextDraftsByThreadKey[threadKey];
      } else {
        nextDraftsByThreadKey[threadKey] = nextDraft;
      }
      return { draftsByThreadKey: nextDraftsByThreadKey };
    });
  }

  const composerDraftStore = create<ComposerDraftStoreState<TImage>>()(
    persist<ComposerDraftStoreState<TImage>, [], [], PersistedComposerDraftStoreState>(
      (setBase, get) => {
        const set = setBase;

        return {
          draftsByThreadKey: {},
          draftThreadsByThreadKey: {},
          logicalProjectDraftThreadKeyByLogicalProjectKey: {},
          stickyModelSelectionByProvider: {},
          stickyActiveProvider: null,
          getComposerDraft: (target) => getComposerDraftState(get(), target),
          getDraftThreadByLogicalProjectKey: (logicalProjectKey) => {
            return get().getDraftSessionByLogicalProjectKey(logicalProjectKey);
          },
          getDraftSessionByLogicalProjectKey: (logicalProjectKey) => {
            const normalizedLogicalProjectKey = logicalProjectDraftKey(logicalProjectKey);
            if (normalizedLogicalProjectKey.length === 0) {
              return null;
            }
            const draftId =
              get().logicalProjectDraftThreadKeyByLogicalProjectKey[normalizedLogicalProjectKey];
            if (!draftId) {
              return null;
            }
            const draftThread = get().draftThreadsByThreadKey[draftId];
            if (!draftThread || isDraftThreadPromoting(draftThread)) {
              return null;
            }
            return toProjectDraftSession(DraftId.make(draftId), draftThread);
          },
          getDraftThreadByProjectRef: (projectRef) => {
            return get().getDraftSessionByProjectRef(projectRef);
          },
          getDraftSessionByProjectRef: (projectRef) => {
            for (const [draftId, draftThread] of Object.entries(get().draftThreadsByThreadKey)) {
              if (isDraftThreadPromoting(draftThread)) {
                continue;
              }
              if (
                draftThread.projectId === projectRef.projectId &&
                draftThread.environmentId === projectRef.environmentId
              ) {
                return toProjectDraftSession(DraftId.make(draftId), draftThread);
              }
            }
            return null;
          },
          getDraftSession: (draftId) => get().draftThreadsByThreadKey[draftId] ?? null,
          getDraftSessionByRef: (threadRef) => {
            for (const draftSession of Object.values(get().draftThreadsByThreadKey)) {
              if (
                draftSession.environmentId === threadRef.environmentId &&
                draftSession.threadId === threadRef.threadId
              ) {
                return draftSession;
              }
            }
            return null;
          },
          getDraftThread: (threadRef) => {
            if (typeof threadRef === "string") {
              return get().getDraftSession(DraftId.make(threadRef));
            }
            return get().getDraftSessionByRef(threadRef);
          },
          getDraftThreadByRef: (threadRef) => {
            return get().getDraftSessionByRef(threadRef);
          },
          listDraftThreadKeys: () =>
            Object.values(get().draftThreadsByThreadKey).map((draftThread) =>
              scopedThreadKey(scopeThreadRef(draftThread.environmentId, draftThread.threadId)),
            ),
          hasDraftThreadsInEnvironment: (environmentId) =>
            Object.values(get().draftThreadsByThreadKey).some(
              (draftThread) => draftThread.environmentId === environmentId,
            ),
          setLogicalProjectDraftThreadId: (logicalProjectKey, projectRef, draftId, options) => {
            const normalizedLogicalProjectKey = logicalProjectDraftKey(logicalProjectKey);
            if (normalizedLogicalProjectKey.length === 0 || draftId.length === 0) {
              return;
            }
            set((state) => {
              const existingThread = state.draftThreadsByThreadKey[draftId];
              const previousThreadKeyForLogicalProject =
                state.logicalProjectDraftThreadKeyByLogicalProjectKey[normalizedLogicalProjectKey];
              const nextDraftThread = createDraftThreadState(
                projectRef,
                options?.threadId ?? existingThread?.threadId ?? ThreadId.make(draftId),
                normalizedLogicalProjectKey,
                existingThread,
                options,
              );
              const hasSameLogicalMapping = previousThreadKeyForLogicalProject === draftId;
              if (hasSameLogicalMapping && draftThreadsEqual(existingThread, nextDraftThread)) {
                return state;
              }
              const nextLogicalProjectDraftThreadKeyByLogicalProjectKey: Record<string, string> = {
                ...state.logicalProjectDraftThreadKeyByLogicalProjectKey,
                [normalizedLogicalProjectKey]: draftId,
              };
              const nextDraftThreadsByThreadKey: Record<string, DraftThreadState> = {
                ...state.draftThreadsByThreadKey,
                [draftId]: nextDraftThread,
              };
              let nextDraftsByThreadKey = state.draftsByThreadKey;
              const previousDraftThread =
                previousThreadKeyForLogicalProject === undefined
                  ? undefined
                  : nextDraftThreadsByThreadKey[previousThreadKeyForLogicalProject];
              if (
                previousThreadKeyForLogicalProject &&
                previousThreadKeyForLogicalProject !== draftId &&
                !isComposerThreadKeyInUse(
                  nextLogicalProjectDraftThreadKeyByLogicalProjectKey,
                  previousThreadKeyForLogicalProject,
                ) &&
                !isDraftThreadPromoting(previousDraftThread)
              ) {
                delete nextDraftThreadsByThreadKey[previousThreadKeyForLogicalProject];
                if (state.draftsByThreadKey[previousThreadKeyForLogicalProject] !== undefined) {
                  nextDraftsByThreadKey = { ...state.draftsByThreadKey };
                  delete nextDraftsByThreadKey[previousThreadKeyForLogicalProject];
                }
              }
              return {
                draftsByThreadKey: nextDraftsByThreadKey,
                draftThreadsByThreadKey: nextDraftThreadsByThreadKey,
                logicalProjectDraftThreadKeyByLogicalProjectKey:
                  nextLogicalProjectDraftThreadKeyByLogicalProjectKey,
              };
            });
          },
          setProjectDraftThreadId: (projectRef, draftId, options) => {
            get().setLogicalProjectDraftThreadId(
              projectDraftKey(projectRef),
              projectRef,
              draftId,
              options,
            );
          },
          setDraftThreadContext: (threadRef, options) => {
            const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
            if (threadKey.length === 0) {
              return;
            }
            set((state) => {
              const existing = state.draftThreadsByThreadKey[threadKey];
              if (!existing) {
                return state;
              }
              const nextProjectRef = options.projectRef ?? {
                environmentId: existing.environmentId,
                projectId: existing.projectId,
              };
              if (
                nextProjectRef.projectId.length === 0 ||
                nextProjectRef.environmentId.length === 0
              ) {
                return state;
              }
              const projectChanged =
                nextProjectRef.environmentId !== existing.environmentId ||
                nextProjectRef.projectId !== existing.projectId;
              const nextWorktreePath =
                options.worktreePath === undefined
                  ? projectChanged
                    ? null
                    : existing.worktreePath
                  : (options.worktreePath ?? null);
              const nextBranch =
                options.branch === undefined
                  ? projectChanged
                    ? null
                    : existing.branch
                  : (options.branch ?? null);
              const nextWorktreeSource =
                options.worktreeSource === undefined
                  ? projectChanged
                    ? null
                    : (existing.worktreeSource ?? null)
                  : options.worktreeSource;
              const nextDraftThread: DraftThreadState = {
                threadId: existing.threadId,
                environmentId: nextProjectRef.environmentId,
                projectId: nextProjectRef.projectId,
                logicalProjectKey: existing.logicalProjectKey,
                createdAt:
                  options.createdAt === undefined
                    ? existing.createdAt
                    : options.createdAt || existing.createdAt,
                runtimeMode: options.runtimeMode ?? existing.runtimeMode,
                interactionMode: options.interactionMode ?? existing.interactionMode,
                tokenMode: options.tokenMode ?? existing.tokenMode ?? DEFAULT_AGENT_TOKEN_MODE,
                fetchOrigin: options.fetchOrigin ?? existing.fetchOrigin ?? true,
                worktreeBranchName: projectChanged
                  ? null
                  : options.worktreeBranchName === undefined
                    ? (existing.worktreeBranchName ?? null)
                    : options.worktreeBranchName,
                branch: nextBranch,
                worktreePath: nextWorktreePath,
                worktreeSource: nextWorktreeSource,
                envMode:
                  options.envMode ??
                  (nextWorktreePath
                    ? "worktree"
                    : projectChanged
                      ? "local"
                      : (existing.envMode ?? "local")),
                promotedTo: existing.promotedTo ?? null,
              };
              const isUnchanged =
                nextDraftThread.environmentId === existing.environmentId &&
                nextDraftThread.projectId === existing.projectId &&
                nextDraftThread.logicalProjectKey === existing.logicalProjectKey &&
                nextDraftThread.createdAt === existing.createdAt &&
                nextDraftThread.runtimeMode === existing.runtimeMode &&
                nextDraftThread.interactionMode === existing.interactionMode &&
                nextDraftThread.tokenMode === existing.tokenMode &&
                nextDraftThread.fetchOrigin === (existing.fetchOrigin ?? true) &&
                nextDraftThread.worktreeBranchName === (existing.worktreeBranchName ?? null) &&
                nextDraftThread.branch === existing.branch &&
                nextDraftThread.worktreePath === existing.worktreePath &&
                Equal.equals(nextDraftThread.worktreeSource, existing.worktreeSource ?? null) &&
                nextDraftThread.envMode === existing.envMode &&
                scopedThreadRefsEqual(nextDraftThread.promotedTo, existing.promotedTo);
              if (isUnchanged) {
                return state;
              }
              return {
                draftThreadsByThreadKey: {
                  ...state.draftThreadsByThreadKey,
                  [threadKey]: nextDraftThread,
                },
              };
            });
          },
          moveDraftThreadToProject: (threadRef, input) => {
            const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
            const normalizedLogicalProjectKey = logicalProjectDraftKey(input.logicalProjectKey);
            if (threadKey.length === 0 || normalizedLogicalProjectKey.length === 0) {
              return;
            }
            if (
              input.projectRef.projectId.length === 0 ||
              input.projectRef.environmentId.length === 0
            ) {
              return;
            }
            set((state) => {
              const existingThread = state.draftThreadsByThreadKey[threadKey];
              if (!existingThread || isDraftThreadPromoting(existingThread)) {
                return state;
              }
              const nextDraftThread = createDraftThreadState(
                input.projectRef,
                existingThread.threadId,
                normalizedLogicalProjectKey,
                existingThread,
              );
              if (
                draftThreadsEqual(existingThread, nextDraftThread) &&
                state.logicalProjectDraftThreadKeyByLogicalProjectKey[
                  normalizedLogicalProjectKey
                ] === threadKey
              ) {
                return state;
              }

              // Drop every mapping that pointed at this draft before claiming
              // the target slot: leaving the old project's entry behind would
              // let "new thread in <old project>" resurrect a draft that now
              // belongs to a different repository.
              const nextLogicalProjectDraftThreadKeyByLogicalProjectKey: Record<string, string> =
                Object.fromEntries(
                  Object.entries(state.logicalProjectDraftThreadKeyByLogicalProjectKey).filter(
                    ([, draftThreadKey]) => draftThreadKey !== threadKey,
                  ),
                );
              const displacedThreadKey =
                nextLogicalProjectDraftThreadKeyByLogicalProjectKey[normalizedLogicalProjectKey];
              nextLogicalProjectDraftThreadKeyByLogicalProjectKey[normalizedLogicalProjectKey] =
                threadKey;

              const nextDraftThreadsByThreadKey: Record<string, DraftThreadState> = {
                ...state.draftThreadsByThreadKey,
                [threadKey]: nextDraftThread,
              };
              let nextDraftsByThreadKey = state.draftsByThreadKey;
              // The target project may already have had its own draft parked in
              // this slot. Retire it only when it is genuinely empty — a parked
              // draft can hold an unsent prompt, attachments, or a model choice,
              // and discarding those to make room would be silent data loss. A
              // draft that survives keeps its entry in `draftThreadsByThreadKey`
              // (so the sidebar still lists it and its route still resolves) and
              // simply loses the logical-project slot to the incoming draft.
              const displacedContent = displacedThreadKey
                ? state.draftsByThreadKey[displacedThreadKey]
                : undefined;
              const displacedIsEmpty =
                displacedContent === undefined || shouldRemoveDraft(displacedContent);
              if (
                displacedThreadKey &&
                displacedThreadKey !== threadKey &&
                displacedIsEmpty &&
                !isComposerThreadKeyInUse(
                  nextLogicalProjectDraftThreadKeyByLogicalProjectKey,
                  displacedThreadKey,
                ) &&
                !isDraftThreadPromoting(nextDraftThreadsByThreadKey[displacedThreadKey])
              ) {
                delete nextDraftThreadsByThreadKey[displacedThreadKey];
                if (state.draftsByThreadKey[displacedThreadKey] !== undefined) {
                  nextDraftsByThreadKey = { ...state.draftsByThreadKey };
                  revokeDraftThreadPreviewUrls(nextDraftsByThreadKey[displacedThreadKey]);
                  delete nextDraftsByThreadKey[displacedThreadKey];
                }
              }

              return {
                draftsByThreadKey: nextDraftsByThreadKey,
                draftThreadsByThreadKey: nextDraftThreadsByThreadKey,
                logicalProjectDraftThreadKeyByLogicalProjectKey:
                  nextLogicalProjectDraftThreadKeyByLogicalProjectKey,
              };
            });
          },
          clearProjectDraftThreadId: (projectRef) => {
            set((state) => {
              const matchingThreadEntry = Object.entries(state.draftThreadsByThreadKey).find(
                ([, draftThread]) =>
                  draftThread.projectId === projectRef.projectId &&
                  draftThread.environmentId === projectRef.environmentId,
              );
              if (!matchingThreadEntry) {
                return state;
              }
              return removeDraftThreadReferences(state, matchingThreadEntry[0]);
            });
          },
          clearProjectDraftThreadById: (projectRef, threadRef) => {
            const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
            if (threadKey.length === 0) {
              return;
            }
            set((state) => {
              const draftThread = state.draftThreadsByThreadKey[threadKey];
              if (
                !draftThread ||
                draftThread.projectId !== projectRef.projectId ||
                draftThread.environmentId !== projectRef.environmentId
              ) {
                return state;
              }
              return removeDraftThreadReferences(state, threadKey);
            });
          },
          markDraftThreadPromoting: (threadRef, promotedTo) => {
            const threadKey = resolveComposerDraftKey(get(), threadRef);
            if (!threadKey) {
              return;
            }
            set((state) => {
              const existing = state.draftThreadsByThreadKey[threadKey];
              if (!existing) {
                return state;
              }
              const nextPromotedTo =
                promotedTo ?? scopeThreadRef(existing.environmentId, existing.threadId);
              if (scopedThreadRefsEqual(existing.promotedTo, nextPromotedTo)) {
                return state;
              }
              return {
                draftThreadsByThreadKey: {
                  ...state.draftThreadsByThreadKey,
                  [threadKey]: {
                    ...existing,
                    promotedTo: nextPromotedTo,
                  },
                },
              };
            });
          },
          finalizePromotedDraftThread: (threadRef) => {
            const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
            if (threadKey.length === 0) {
              return;
            }
            set((state) => {
              const existing = state.draftThreadsByThreadKey[threadKey];
              if (!isDraftThreadPromoting(existing)) {
                return state;
              }
              return removeDraftThreadReferences(state, threadKey);
            });
          },
          clearDraftThread: (threadRef) => {
            const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
            if (threadKey.length === 0) {
              return;
            }
            set((state) => {
              const hasDraftThread = state.draftThreadsByThreadKey[threadKey] !== undefined;
              const hasLogicalProjectMapping = Object.values(
                state.logicalProjectDraftThreadKeyByLogicalProjectKey,
              ).includes(threadKey);
              const hasComposerDraft = state.draftsByThreadKey[threadKey] !== undefined;
              if (!hasDraftThread && !hasLogicalProjectMapping && !hasComposerDraft) {
                return state;
              }
              return removeDraftThreadReferences(state, threadKey);
            });
          },
          setStickyModelSelection: (modelSelection) => {
            const normalized = normalizeModelSelection(modelSelection);
            set((state) => {
              if (!normalized) {
                return state;
              }
              const nextMap: Partial<Record<ProviderInstanceId, ModelSelection>> = {
                ...state.stickyModelSelectionByProvider,
                [normalized.instanceId]: normalized,
              };
              if (Equal.equals(state.stickyModelSelectionByProvider, nextMap)) {
                return state.stickyActiveProvider === normalized.instanceId
                  ? state
                  : { stickyActiveProvider: normalized.instanceId };
              }
              return {
                stickyModelSelectionByProvider: nextMap,
                stickyActiveProvider: normalized.instanceId,
              };
            });
          },
          applyStickyState: (threadRef) => {
            const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
            if (threadKey.length === 0) {
              return;
            }
            set((state) => {
              const stickyMap = state.stickyModelSelectionByProvider;
              const stickyActiveProvider = state.stickyActiveProvider;
              if (Object.keys(stickyMap).length === 0 && stickyActiveProvider === null) {
                return state;
              }
              const existing = state.draftsByThreadKey[threadKey];
              const base = existing ?? createEmptyThreadDraft();
              const nextMap = { ...base.modelSelectionByProvider };
              for (const [provider, selection] of Object.entries(stickyMap)) {
                if (selection) {
                  // Iteration key comes from the instance-keyed sticky map,
                  // so coerce the string back to `ProviderInstanceId` for
                  // the typed lookup.
                  const instanceKey = provider as ProviderInstanceId;
                  const current = nextMap[instanceKey];
                  nextMap[instanceKey] = {
                    ...selection,
                    model: current?.model ?? selection.model,
                  };
                }
              }
              if (
                Equal.equals(base.modelSelectionByProvider, nextMap) &&
                base.activeProvider === stickyActiveProvider
              ) {
                return state;
              }
              const nextDraft: ComposerThreadDraftState<TImage> = {
                ...base,
                modelSelectionByProvider: nextMap,
                activeProvider: stickyActiveProvider,
              };
              const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
              if (shouldRemoveDraft(nextDraft)) {
                delete nextDraftsByThreadKey[threadKey];
              } else {
                nextDraftsByThreadKey[threadKey] = nextDraft;
              }
              return { draftsByThreadKey: nextDraftsByThreadKey };
            });
          },
          setPrompt: (threadRef, prompt) => {
            const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
            if (threadKey.length === 0) {
              return;
            }
            set((state) => {
              const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
              const nextDraft: ComposerThreadDraftState<TImage> = {
                ...existing,
                prompt,
              };
              const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
              if (shouldRemoveDraft(nextDraft)) {
                delete nextDraftsByThreadKey[threadKey];
              } else {
                nextDraftsByThreadKey[threadKey] = nextDraft;
              }
              return { draftsByThreadKey: nextDraftsByThreadKey };
            });
          },
          setTerminalContexts: (threadRef, contexts) => {
            const threadKey = resolveComposerDraftKey(get(), threadRef);
            const threadId = resolveComposerThreadId(get(), threadRef);
            if (!threadKey || !threadId) {
              return;
            }
            const normalizedContexts = normalizeTerminalContextsForThread(threadId, contexts);
            set((state) => {
              const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
              const nextDraft: ComposerThreadDraftState<TImage> = {
                ...existing,
                prompt: ensureInlineTerminalContextPlaceholders(
                  existing.prompt,
                  normalizedContexts.length,
                ),
                terminalContexts: normalizedContexts,
              };
              const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
              if (shouldRemoveDraft(nextDraft)) {
                delete nextDraftsByThreadKey[threadKey];
              } else {
                nextDraftsByThreadKey[threadKey] = nextDraft;
              }
              return { draftsByThreadKey: nextDraftsByThreadKey };
            });
          },
          setModelSelection: (threadRef, modelSelection) => {
            const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
            if (threadKey.length === 0) {
              return;
            }
            const normalized = normalizeModelSelection(modelSelection);
            set((state) => {
              const existing = state.draftsByThreadKey[threadKey];
              if (!existing && normalized === null) {
                return state;
              }
              const base = existing ?? createEmptyThreadDraft();
              const nextMap = { ...base.modelSelectionByProvider };
              if (normalized) {
                const current = nextMap[normalized.instanceId];
                if (normalized.options !== undefined) {
                  // Explicit options provided → use them
                  nextMap[normalized.instanceId] = normalized as ModelSelection;
                } else {
                  // No options in selection → preserve existing options, update provider+model
                  nextMap[normalized.instanceId] = createModelSelection(
                    normalized.instanceId,
                    normalized.model,
                    current?.options,
                  );
                }
              }
              const nextActiveProvider = normalized?.instanceId ?? base.activeProvider;
              if (
                Equal.equals(base.modelSelectionByProvider, nextMap) &&
                base.activeProvider === nextActiveProvider
              ) {
                return state;
              }
              const nextDraft: ComposerThreadDraftState<TImage> = {
                ...base,
                modelSelectionByProvider: nextMap,
                activeProvider: nextActiveProvider,
              };
              const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
              if (shouldRemoveDraft(nextDraft)) {
                delete nextDraftsByThreadKey[threadKey];
              } else {
                nextDraftsByThreadKey[threadKey] = nextDraft;
              }
              return { draftsByThreadKey: nextDraftsByThreadKey };
            });
          },
          setModelOptions: (threadRef, modelOptions) => {
            const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
            if (threadKey.length === 0) {
              return;
            }
            set((state) => {
              const existing = state.draftsByThreadKey[threadKey];
              if (!existing && (!modelOptions || Object.keys(modelOptions).length === 0)) {
                return state;
              }
              const base = existing ?? createEmptyThreadDraft();
              const nextMap = { ...base.modelSelectionByProvider };
              for (const provider of [
                "codex",
                "claudeAgent",
                "cursor",
                "grok",
                "opencode",
              ] as const) {
                if (!modelOptions || !(provider in modelOptions)) continue;
                const opts = modelOptions[provider];
                const driverKind = ProviderDriverKind.make(provider);
                const instanceKey = defaultInstanceIdForDriver(driverKind);
                const current = nextMap[instanceKey];
                if (opts && opts.length > 0) {
                  nextMap[instanceKey] = createModelSelection(
                    instanceKey,
                    current?.model ?? DEFAULT_MODEL_BY_PROVIDER[driverKind] ?? DEFAULT_MODEL,
                    opts,
                  );
                } else if (current?.options) {
                  const { options: _, ...rest } = current;
                  nextMap[instanceKey] = rest as ModelSelection;
                }
              }
              if (Equal.equals(base.modelSelectionByProvider, nextMap)) {
                return state;
              }
              const nextDraft: ComposerThreadDraftState<TImage> = {
                ...base,
                modelSelectionByProvider: nextMap,
              };
              const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
              if (shouldRemoveDraft(nextDraft)) {
                delete nextDraftsByThreadKey[threadKey];
              } else {
                nextDraftsByThreadKey[threadKey] = nextDraft;
              }
              return { draftsByThreadKey: nextDraftsByThreadKey };
            });
          },
          setProviderModelOptions: (threadRef, provider, nextProviderOptions, options) => {
            const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
            if (threadKey.length === 0) {
              return;
            }
            const normalizedProvider = normalizeProviderDriverKind(provider);
            if (normalizedProvider === null) {
              return;
            }
            const instanceKey =
              options?.instanceId ?? defaultInstanceIdForDriver(normalizedProvider);
            const fallbackModel =
              normalizeModelSlug(options?.model, normalizedProvider) ??
              DEFAULT_MODEL_BY_PROVIDER[normalizedProvider] ??
              DEFAULT_MODEL;
            const providerOpts =
              nextProviderOptions && nextProviderOptions.length > 0
                ? nextProviderOptions
                : undefined;

            set((state) => {
              const existing = state.draftsByThreadKey[threadKey];
              const base = existing ?? createEmptyThreadDraft();

              // Update the map entry for this provider
              const nextMap = { ...base.modelSelectionByProvider };
              const currentForProvider = nextMap[instanceKey];
              if (providerOpts) {
                nextMap[instanceKey] = createModelSelection(
                  instanceKey,
                  currentForProvider?.model ?? fallbackModel,
                  providerOpts,
                );
              } else if (currentForProvider && (currentForProvider.options?.length ?? 0) > 0) {
                const { options: _, ...rest } = currentForProvider;
                nextMap[instanceKey] = rest as ModelSelection;
              }

              // Handle sticky persistence
              let nextStickyMap = state.stickyModelSelectionByProvider;
              let nextStickyActiveProvider = state.stickyActiveProvider;
              if (options?.persistSticky === true) {
                nextStickyMap = { ...state.stickyModelSelectionByProvider };
                const stickyBase =
                  nextStickyMap[instanceKey] ??
                  base.modelSelectionByProvider[instanceKey] ??
                  createModelSelection(instanceKey, fallbackModel);
                if (providerOpts) {
                  nextStickyMap[instanceKey] = createModelSelection(
                    instanceKey,
                    stickyBase.model,
                    providerOpts,
                  );
                } else if ((stickyBase.options?.length ?? 0) > 0) {
                  const { options: _, ...rest } = stickyBase;
                  nextStickyMap[instanceKey] = rest as ModelSelection;
                }
                nextStickyActiveProvider = options.instanceId
                  ? instanceKey
                  : (base.activeProvider ?? instanceKey);
              }

              if (
                Equal.equals(base.modelSelectionByProvider, nextMap) &&
                Equal.equals(state.stickyModelSelectionByProvider, nextStickyMap) &&
                state.stickyActiveProvider === nextStickyActiveProvider
              ) {
                return state;
              }

              const nextDraft: ComposerThreadDraftState<TImage> = {
                ...base,
                ...(options?.instanceId ? { activeProvider: instanceKey } : {}),
                modelSelectionByProvider: nextMap,
              };
              const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
              if (shouldRemoveDraft(nextDraft)) {
                delete nextDraftsByThreadKey[threadKey];
              } else {
                nextDraftsByThreadKey[threadKey] = nextDraft;
              }

              return {
                draftsByThreadKey: nextDraftsByThreadKey,
                ...(options?.persistSticky === true
                  ? {
                      stickyModelSelectionByProvider: nextStickyMap,
                      stickyActiveProvider: nextStickyActiveProvider,
                    }
                  : {}),
              };
            });
          },
          setRuntimeMode: (threadRef, runtimeMode) => {
            const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
            if (threadKey.length === 0) {
              return;
            }
            const nextRuntimeMode = isRuntimeMode(runtimeMode) ? runtimeMode : null;
            set((state) => {
              const existing = state.draftsByThreadKey[threadKey];
              if (!existing && nextRuntimeMode === null) {
                return state;
              }
              const base = existing ?? createEmptyThreadDraft();
              if (base.runtimeMode === nextRuntimeMode) {
                return state;
              }
              const nextDraft: ComposerThreadDraftState<TImage> = {
                ...base,
                runtimeMode: nextRuntimeMode,
              };
              const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
              if (shouldRemoveDraft(nextDraft)) {
                delete nextDraftsByThreadKey[threadKey];
              } else {
                nextDraftsByThreadKey[threadKey] = nextDraft;
              }
              return { draftsByThreadKey: nextDraftsByThreadKey };
            });
          },
          setInteractionMode: (threadRef, interactionMode) => {
            const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
            if (threadKey.length === 0) {
              return;
            }
            const nextInteractionMode = Schema.is(ProviderInteractionMode)(interactionMode)
              ? interactionMode
              : null;
            set((state) => {
              const existing = state.draftsByThreadKey[threadKey];
              if (!existing && nextInteractionMode === null) {
                return state;
              }
              const base = existing ?? createEmptyThreadDraft();
              if (base.interactionMode === nextInteractionMode) {
                return state;
              }
              const nextDraft: ComposerThreadDraftState<TImage> = {
                ...base,
                interactionMode: nextInteractionMode,
              };
              const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
              if (shouldRemoveDraft(nextDraft)) {
                delete nextDraftsByThreadKey[threadKey];
              } else {
                nextDraftsByThreadKey[threadKey] = nextDraft;
              }
              return { draftsByThreadKey: nextDraftsByThreadKey };
            });
          },
          setTokenMode: (threadRef, tokenMode) => {
            const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
            if (threadKey.length === 0) {
              return;
            }
            const nextTokenMode = isAgentTokenMode(tokenMode) ? tokenMode : null;
            set((state) => {
              const existing = state.draftsByThreadKey[threadKey];
              if (!existing && nextTokenMode === null) {
                return state;
              }
              const base = existing ?? createEmptyThreadDraft();
              if (base.tokenMode === nextTokenMode) {
                return state;
              }
              const nextDraft: ComposerThreadDraftState<TImage> = {
                ...base,
                tokenMode: nextTokenMode,
              };
              const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
              if (shouldRemoveDraft(nextDraft)) {
                delete nextDraftsByThreadKey[threadKey];
              } else {
                nextDraftsByThreadKey[threadKey] = nextDraft;
              }
              return { draftsByThreadKey: nextDraftsByThreadKey };
            });
          },
          addImage: (threadRef, image) => {
            const threadKey = resolveComposerDraftKey(get(), threadRef);
            const threadId = resolveComposerThreadId(get(), threadRef);
            if (!threadKey || !threadId) {
              return;
            }
            get().addImages(typeof threadRef === "string" ? DraftId.make(threadKey) : threadRef, [
              image,
            ]);
          },
          addImages: (threadRef, images) => {
            const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
            if (threadKey.length === 0 || images.length === 0) {
              return;
            }
            set((state) => {
              const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
              const existingIds = new Set(existing.images.map((image) => image.id));
              const existingDedupKeys = new Set(
                existing.images.map((image) => composerDraftImageDedupKey(image)),
              );
              const acceptedPreviewUrls = new Set(existing.images.map((image) => image.previewUrl));
              const dedupedIncoming: TImage[] = [];
              for (const image of images) {
                const dedupKey = composerDraftImageDedupKey(image);
                if (existingIds.has(image.id) || existingDedupKeys.has(dedupKey)) {
                  // Avoid revoking a blob URL that's still referenced by an accepted image.
                  if (!acceptedPreviewUrls.has(image.previewUrl)) {
                    deps.revokePreviewUrl(image.previewUrl);
                  }
                  continue;
                }
                dedupedIncoming.push(image);
                existingIds.add(image.id);
                existingDedupKeys.add(dedupKey);
                acceptedPreviewUrls.add(image.previewUrl);
              }
              if (dedupedIncoming.length === 0) {
                return state;
              }
              return {
                draftsByThreadKey: {
                  ...state.draftsByThreadKey,
                  [threadKey]: {
                    ...existing,
                    images: [...existing.images, ...dedupedIncoming],
                  },
                },
              };
            });
          },
          removeImage: (threadRef, imageId) => {
            const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
            if (threadKey.length === 0) {
              return;
            }
            const existing = get().draftsByThreadKey[threadKey];
            if (!existing) {
              return;
            }
            const removedImage = existing.images.find((image) => image.id === imageId);
            if (removedImage) {
              deps.revokePreviewUrl(removedImage.previewUrl);
            }
            set((state) => {
              const current = state.draftsByThreadKey[threadKey];
              if (!current) {
                return state;
              }
              const nextDraft: ComposerThreadDraftState<TImage> = {
                ...current,
                images: current.images.filter((image) => image.id !== imageId),
                nonPersistedImageIds: current.nonPersistedImageIds.filter((id) => id !== imageId),
                persistedAttachments: current.persistedAttachments.filter(
                  (attachment) => attachment.id !== imageId,
                ),
              };
              const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
              if (shouldRemoveDraft(nextDraft)) {
                delete nextDraftsByThreadKey[threadKey];
              } else {
                nextDraftsByThreadKey[threadKey] = nextDraft;
              }
              return { draftsByThreadKey: nextDraftsByThreadKey };
            });
          },
          updateImage: (threadRef, imageId, update) => {
            const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
            if (threadKey.length === 0) {
              return;
            }
            set((state) => {
              const current = state.draftsByThreadKey[threadKey];
              if (!current) {
                return state;
              }
              const index = current.images.findIndex((image) => image.id === imageId);
              if (index === -1) {
                return state;
              }
              const updated = update(current.images[index]!);
              if (updated === current.images[index]) {
                return state;
              }
              const nextImages = [...current.images];
              nextImages[index] = updated;
              const nextDraft: ComposerThreadDraftState<TImage> = {
                ...current,
                images: nextImages,
              };
              return {
                draftsByThreadKey: {
                  ...state.draftsByThreadKey,
                  [threadKey]: nextDraft,
                },
              };
            });
          },
          insertTerminalContext: (threadRef, prompt, context, index) => {
            const threadKey = resolveComposerDraftKey(get(), threadRef);
            const threadId = resolveComposerThreadId(get(), threadRef);
            if (!threadKey || !threadId) {
              return false;
            }
            let inserted = false;
            set((state) => {
              const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
              const normalizedContext = normalizeTerminalContextForThread(threadId, context);
              if (!normalizedContext) {
                return state;
              }
              const dedupKey = terminalContextDedupKey(normalizedContext);
              if (
                existing.terminalContexts.some((entry) => entry.id === normalizedContext.id) ||
                existing.terminalContexts.some(
                  (entry) => terminalContextDedupKey(entry) === dedupKey,
                )
              ) {
                return state;
              }
              inserted = true;
              const boundedIndex = Math.max(0, Math.min(existing.terminalContexts.length, index));
              const nextDraft: ComposerThreadDraftState<TImage> = {
                ...existing,
                prompt,
                terminalContexts: [
                  ...existing.terminalContexts.slice(0, boundedIndex),
                  normalizedContext,
                  ...existing.terminalContexts.slice(boundedIndex),
                ],
              };
              return {
                draftsByThreadKey: {
                  ...state.draftsByThreadKey,
                  [threadKey]: nextDraft,
                },
              };
            });
            return inserted;
          },
          addTerminalContext: (threadRef, context) => {
            const threadKey = resolveComposerDraftKey(get(), threadRef);
            const threadId = resolveComposerThreadId(get(), threadRef);
            if (!threadKey || !threadId) {
              return;
            }
            get().addTerminalContexts(
              typeof threadRef === "string" ? DraftId.make(threadKey) : threadRef,
              [context],
            );
          },
          addTerminalContexts: (threadRef, contexts) => {
            const threadKey = resolveComposerDraftKey(get(), threadRef);
            const threadId = resolveComposerThreadId(get(), threadRef);
            if (!threadKey || !threadId || contexts.length === 0) {
              return;
            }
            set((state) => {
              const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
              const acceptedContexts = normalizeTerminalContextsForThread(threadId, [
                ...existing.terminalContexts,
                ...contexts,
              ]).slice(existing.terminalContexts.length);
              if (acceptedContexts.length === 0) {
                return state;
              }
              return {
                draftsByThreadKey: {
                  ...state.draftsByThreadKey,
                  [threadKey]: {
                    ...existing,
                    prompt: ensureInlineTerminalContextPlaceholders(
                      existing.prompt,
                      existing.terminalContexts.length + acceptedContexts.length,
                    ),
                    terminalContexts: [...existing.terminalContexts, ...acceptedContexts],
                  },
                },
              };
            });
          },
          removeTerminalContext: (threadRef, contextId) => {
            const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
            if (threadKey.length === 0 || contextId.length === 0) {
              return;
            }
            set((state) => {
              const current = state.draftsByThreadKey[threadKey];
              if (!current) {
                return state;
              }
              const nextDraft: ComposerThreadDraftState<TImage> = {
                ...current,
                terminalContexts: current.terminalContexts.filter(
                  (context) => context.id !== contextId,
                ),
              };
              const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
              if (shouldRemoveDraft(nextDraft)) {
                delete nextDraftsByThreadKey[threadKey];
              } else {
                nextDraftsByThreadKey[threadKey] = nextDraft;
              }
              return { draftsByThreadKey: nextDraftsByThreadKey };
            });
          },
          clearTerminalContexts: (threadRef) => {
            const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
            if (threadKey.length === 0) {
              return;
            }
            set((state) => {
              const current = state.draftsByThreadKey[threadKey];
              if (!current || current.terminalContexts.length === 0) {
                return state;
              }
              const nextDraft: ComposerThreadDraftState<TImage> = {
                ...current,
                terminalContexts: [],
              };
              const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
              if (shouldRemoveDraft(nextDraft)) {
                delete nextDraftsByThreadKey[threadKey];
              } else {
                nextDraftsByThreadKey[threadKey] = nextDraft;
              }
              return { draftsByThreadKey: nextDraftsByThreadKey };
            });
          },
          addSourceControlContext: (threadRef, context) => {
            const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
            if (threadKey.length === 0) {
              return { added: false };
            }
            const dedupKey = `${context.provider}:${context.reference}`;
            let alreadyPresent = false;
            set((state) => {
              const existing = state.draftsByThreadKey[threadKey] ?? createEmptyThreadDraft();
              alreadyPresent = existing.sourceControlContexts.some(
                (ctx) => `${ctx.provider}:${ctx.reference}` === dedupKey,
              );
              if (alreadyPresent) {
                return state;
              }
              return {
                draftsByThreadKey: {
                  ...state.draftsByThreadKey,
                  [threadKey]: {
                    ...existing,
                    sourceControlContexts: [...existing.sourceControlContexts, context],
                  },
                },
              };
            });
            return alreadyPresent ? { added: false, reason: "duplicate" } : { added: true };
          },
          removeSourceControlContext: (threadRef, id) => {
            const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
            if (threadKey.length === 0) {
              return;
            }
            set((state) => {
              const current = state.draftsByThreadKey[threadKey];
              if (!current) {
                return state;
              }
              const nextDraft: ComposerThreadDraftState<TImage> = {
                ...current,
                sourceControlContexts: current.sourceControlContexts.filter((ctx) => ctx.id !== id),
              };
              const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
              if (shouldRemoveDraft(nextDraft)) {
                delete nextDraftsByThreadKey[threadKey];
              } else {
                nextDraftsByThreadKey[threadKey] = nextDraft;
              }
              return { draftsByThreadKey: nextDraftsByThreadKey };
            });
          },
          clearSourceControlContexts: (threadRef) => {
            const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
            if (threadKey.length === 0) {
              return;
            }
            set((state) => {
              const current = state.draftsByThreadKey[threadKey];
              if (!current || current.sourceControlContexts.length === 0) {
                return state;
              }
              const nextDraft: ComposerThreadDraftState<TImage> = {
                ...current,
                sourceControlContexts: [],
              };
              const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
              if (shouldRemoveDraft(nextDraft)) {
                delete nextDraftsByThreadKey[threadKey];
              } else {
                nextDraftsByThreadKey[threadKey] = nextDraft;
              }
              return { draftsByThreadKey: nextDraftsByThreadKey };
            });
          },
          clearPersistedAttachments: (threadRef) => {
            const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
            if (threadKey.length === 0) {
              return;
            }
            set((state) => {
              const current = state.draftsByThreadKey[threadKey];
              if (!current) {
                return state;
              }
              const nextDraft: ComposerThreadDraftState<TImage> = {
                ...current,
                persistedAttachments: [],
                nonPersistedImageIds: [],
              };
              const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
              if (shouldRemoveDraft(nextDraft)) {
                delete nextDraftsByThreadKey[threadKey];
              } else {
                nextDraftsByThreadKey[threadKey] = nextDraft;
              }
              return { draftsByThreadKey: nextDraftsByThreadKey };
            });
          },
          syncPersistedAttachments: (threadRef, attachments) => {
            const threadKey = resolveComposerDraftKey(get(), threadRef);
            if (!threadKey) {
              return;
            }
            const attachmentIdSet = new Set(attachments.map((attachment) => attachment.id));
            set((state) => {
              const current = state.draftsByThreadKey[threadKey];
              if (!current) {
                return state;
              }
              const nextDraft: ComposerThreadDraftState<TImage> = {
                ...current,
                // Stage attempted attachments so persist middleware can try writing them.
                persistedAttachments: attachments,
                nonPersistedImageIds: current.nonPersistedImageIds.filter(
                  (id) => !attachmentIdSet.has(id),
                ),
              };
              const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
              if (shouldRemoveDraft(nextDraft)) {
                delete nextDraftsByThreadKey[threadKey];
              } else {
                nextDraftsByThreadKey[threadKey] = nextDraft;
              }
              return { draftsByThreadKey: nextDraftsByThreadKey };
            });
            Promise.resolve().then(() => {
              verifyPersistedAttachments(threadKey, attachments, set);
            });
          },
          clearPromptAndImages: (threadRef) => {
            const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
            if (threadKey.length === 0) {
              return;
            }
            set((state) => {
              const current = state.draftsByThreadKey[threadKey];
              if (!current) {
                return state;
              }
              const nextDraft: ComposerThreadDraftState<TImage> = {
                ...current,
                prompt: ensureInlineTerminalContextPlaceholders(
                  "",
                  current.terminalContexts.length,
                ),
                images: [],
                nonPersistedImageIds: [],
                persistedAttachments: [],
              };
              const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
              if (shouldRemoveDraft(nextDraft)) {
                delete nextDraftsByThreadKey[threadKey];
              } else {
                nextDraftsByThreadKey[threadKey] = nextDraft;
              }
              return { draftsByThreadKey: nextDraftsByThreadKey };
            });
          },
          clearComposerContent: (threadRef) => {
            const threadKey = resolveComposerDraftKey(get(), threadRef) ?? "";
            if (threadKey.length === 0) {
              return;
            }
            set((state) => {
              const current = state.draftsByThreadKey[threadKey];
              if (!current) {
                return state;
              }
              const nextDraft: ComposerThreadDraftState<TImage> = {
                ...current,
                prompt: "",
                images: [],
                nonPersistedImageIds: [],
                persistedAttachments: [],
                terminalContexts: [],
                sourceControlContexts: [],
              };
              const nextDraftsByThreadKey = { ...state.draftsByThreadKey };
              if (shouldRemoveDraft(nextDraft)) {
                delete nextDraftsByThreadKey[threadKey];
              } else {
                nextDraftsByThreadKey[threadKey] = nextDraft;
              }
              return { draftsByThreadKey: nextDraftsByThreadKey };
            });
          },
        };
      },
      {
        name: COMPOSER_DRAFT_STORAGE_KEY,
        version: COMPOSER_DRAFT_STORAGE_VERSION,
        storage: createJSONStorage(
          () => deps.storage,
        ) as PersistStorage<PersistedComposerDraftStoreState>,
        migrate: (persistedState) => migratePersistedComposerDraftStoreState(persistedState),
        partialize: (state) => partializeComposerDraftStoreState(state),
        merge: (persistedState, currentState) => {
          const normalizedPersisted =
            normalizeCurrentPersistedComposerDraftStoreState(persistedState);
          const draftsByThreadKey = Object.fromEntries(
            Object.entries(normalizedPersisted.draftsByThreadKey).map(([threadKey, draft]) => [
              threadKey,
              toHydratedThreadDraft(draft, deps.hydrateImages),
            ]),
          );
          const draftThreadsByThreadKey = Object.fromEntries(
            Object.entries(normalizedPersisted.draftThreadsByThreadKey).map(
              ([threadKey, draftThread]) => [threadKey, toHydratedDraftThreadState(draftThread)],
            ),
          ) as Record<string, DraftThreadState>;
          return {
            ...currentState,
            draftsByThreadKey,
            draftThreadsByThreadKey,
            logicalProjectDraftThreadKeyByLogicalProjectKey:
              normalizedPersisted.logicalProjectDraftThreadKeyByLogicalProjectKey,
            stickyModelSelectionByProvider:
              normalizedPersisted.stickyModelSelectionByProvider ?? {},
            stickyActiveProvider: normalizedPersisted.stickyActiveProvider ?? null,
          };
        },
      },
    ),
  );

  const useComposerDraftStore = composerDraftStore;

  /**
   * Mark a draft thread as promoting once the server has materialized the same thread id.
   *
   * Use the single-thread helper for live `thread.created` events and the
   * iterable helper for bootstrap/recovery paths that discover multiple server
   * threads at once.
   */
  function markPromotedDraftThread(threadId: ThreadId): void {
    const store = useComposerDraftStore.getState();
    const draftThreadTargets: ComposerThreadTarget[] = [];
    for (const [draftId, draftThread] of Object.entries(store.draftThreadsByThreadKey)) {
      if (draftThread.threadId === threadId) {
        draftThreadTargets.push(DraftId.make(draftId));
      }
    }
    if (draftThreadTargets.length === 0) {
      return;
    }
    for (const draftThreadTarget of draftThreadTargets) {
      store.markDraftThreadPromoting(draftThreadTarget);
    }
  }

  function markPromotedDraftThreadByRef(threadRef: ScopedThreadRef): void {
    const draftStore = useComposerDraftStore.getState();
    for (const [draftId, draftThread] of Object.entries(draftStore.draftThreadsByThreadKey)) {
      if (
        draftThread.environmentId === threadRef.environmentId &&
        draftThread.threadId === threadRef.threadId
      ) {
        draftStore.markDraftThreadPromoting(DraftId.make(draftId), threadRef);
      }
    }
  }

  function markPromotedDraftThreads(serverThreadIds: Iterable<ThreadId>): void {
    for (const threadId of serverThreadIds) {
      markPromotedDraftThread(threadId);
    }
  }

  function markPromotedDraftThreadsByRef(serverThreadRefs: Iterable<ScopedThreadRef>): void {
    for (const threadRef of serverThreadRefs) {
      markPromotedDraftThreadByRef(threadRef);
    }
  }

  function finalizePromotedDraftThreadByRef(threadRef: ScopedThreadRef): void {
    const draftStore = useComposerDraftStore.getState();
    for (const [draftId, draftThread] of Object.entries(draftStore.draftThreadsByThreadKey)) {
      if (
        draftThread.promotedTo &&
        draftThread.promotedTo.environmentId === threadRef.environmentId &&
        draftThread.promotedTo.threadId === threadRef.threadId
      ) {
        draftStore.finalizePromotedDraftThread(DraftId.make(draftId));
      }
    }
  }

  function finalizePromotedDraftThreadsByRef(serverThreadRefs: Iterable<ScopedThreadRef>): void {
    for (const threadRef of serverThreadRefs) {
      finalizePromotedDraftThreadByRef(threadRef);
    }
  }

  return {
    useComposerDraftStore,
    markPromotedDraftThread,
    markPromotedDraftThreadByRef,
    markPromotedDraftThreads,
    markPromotedDraftThreadsByRef,
    finalizePromotedDraftThreadByRef,
    finalizePromotedDraftThreadsByRef,
  };
}
