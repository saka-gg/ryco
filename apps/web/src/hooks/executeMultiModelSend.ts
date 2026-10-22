/**
 * A "Compare models" send from a new draft: one prompt, one new thread per
 * chosen model, each in its own fresh worktree (`multiModelSend` in the client
 * runtime plans, sends and classifies the targets). This module turns the
 * composer's snapshot into the tracker's input with the same composition as a
 * normal send (file references, terminal contexts and attachments), so every
 * model gets identical text, and resolves the worktree preferences the normal
 * new-worktree send resolves. Everything here runs before anything is sent.
 */
import {
  MODEL_MULTI_SELECT_OFF,
  captureReviewedSendReadiness,
  createMultiModelSendTracker,
  normalizeInteractionModeForProviderTarget,
  resolveMultiModelSendTarget,
  retryModelMultiSelect,
  summarizeMultiModelSend,
  type MultiModelSendSnapshot,
  type MultiModelSendTargetInput,
  type MultiModelSendTracker,
  type ProviderInstanceEntry,
} from "@ryco/client-runtime/state/composer";
import type {
  EnvironmentApi,
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ServerConfig,
} from "@ryco/contracts";
import { rejectRetiredProjectMemory } from "@ryco/shared/retiredFeatures";

import { resolveBuildModeModelSelection } from "../buildMode";
import { refreshStaleSourceControlContexts } from "../components/ChatView.logic";
import {
  finishMultiModelSend,
  readMultiModelSelection,
  readMultiModelSend,
  setMultiModelSelection,
  setMultiModelSend,
} from "../components/chat/multiModelSendStore";
import type { DraftId } from "../composerDraftStore";
import { readEnvironmentConnection } from "../environments/runtime";
import { randomUUID } from "../lib/utils";
import {
  buildOutgoingMessageText,
  buildOutgoingTurnAttachments,
  clearComposerContentRefs,
  resolveSendTurnTitle,
  resolveWorktreeSendPreferences,
  restoreUnsentComposerContent,
  type ComposerContentRefs,
  type ExecuteChatSendTurnInput,
  type SendTurnComposerDraftDeps,
  type SendTurnComposerSnapshot,
  type SendTurnReadComposer,
  type SendTurnSettings,
  type SendTurnSourceControlFetcher,
} from "./executeChatSendTurn";

export const MULTI_MODEL_SEND_UNSUPPORTED_MESSAGE =
  "This environment can't start models in separate worktrees yet. Update Ryco on it first.";

/** Whether a node refuses, rather than falls back from, a first send that requires a worktree. */
export function supportsMultiModelSend(config: ServerConfig | null | undefined): boolean {
  return config?.environment.capabilities.requiredWorktreeBootstrap === true;
}

export interface PrepareMultiModelSendInput {
  readonly api: EnvironmentApi;
  readonly environmentId: EnvironmentId;
  readonly draftId: DraftId;
  /** New for every send from the draft; kept for its uncertain retries. */
  readonly submissionId: string;
  readonly projectId: ProjectId;
  readonly projectCwd: string;
  /** Every worktree starts here (`newWorktreeBaseBranch`). */
  readonly baseBranch: string;
  readonly fetchOrigin: boolean;
  readonly composer: SendTurnComposerSnapshot;
  /** `resolveModelMultiSelectTargets`: the composer's own model with its live options. */
  readonly selections: ReadonlyArray<ModelSelection>;
  readonly providerEntries: ReadonlyArray<ProviderInstanceEntry>;
  /** The custom models the picker offers for an instance (`getAppModelOptionsForInstance`). */
  readonly customModelSlugs?: ((entry: ProviderInstanceEntry) => ReadonlyArray<string>) | undefined;
  readonly settings: SendTurnSettings;
  readonly enforceBuildMode: boolean;
  readonly sourceControl: SendTurnSourceControlFetcher;
  readonly formatOutgoingPrompt: ExecuteChatSendTurnInput["formatOutgoingPrompt"];
}

/**
 * Builds the send's tracker. Throws, with a message for the user, when it
 * cannot go out as asked: a model left the catalog, the node cannot isolate
 * the targets, or a streamed file's bytes are gone. Nothing is sent yet.
 */
export async function prepareMultiModelSend(
  input: PrepareMultiModelSendInput,
): Promise<MultiModelSendTracker> {
  const { api, composer, settings } = input;
  rejectRetiredProjectMemory(composer);
  const targets = input.selections.map((selection): MultiModelSendTargetInput => {
    const resolved = resolveMultiModelSendTarget({
      selection,
      entries: input.providerEntries,
      prompt: composer.prompt,
      customModelSlugs: input.customModelSlugs,
    });
    if (!resolved.ok) throw new Error(resolved.reason);
    const { entry } = resolved;
    return {
      modelSelection: input.enforceBuildMode
        ? resolveBuildModeModelSelection(entry.driverKind, resolved.modelSelection)
        : resolved.modelSelection,
      // The same composition as the composer's own send, formatted for this model.
      outgoingMessageText: buildOutgoingMessageText({
        composer: {
          ...composer,
          selectedProvider: entry.driverKind,
          selectedModel: resolved.modelSelection.model,
          selectedProviderModels: entry.models,
          selectedPromptEffort: resolved.promptEffort,
        },
        formatOutgoingPrompt: input.formatOutgoingPrompt,
      }),
      interactionMode: normalizeInteractionModeForProviderTarget(
        settings.interactionMode,
        entry.snapshot.supportsAskMode ?? false,
      ),
      providerDriver: entry.driverKind,
    };
  });
  // An upload token goes with one command, so streamed files go inline, once
  // per model.
  const turnAttachmentsPromise = buildOutgoingTurnAttachments(composer.images, {
    inlineUploads: true,
  });
  const [preferences, turnAttachments, sourceControlContexts] = await Promise.all([
    resolveWorktreeSendPreferences({
      api,
      environmentId: input.environmentId,
      projectId: input.projectId,
      createsWorktree: true,
      needsBranchPrefix: true,
    }),
    turnAttachmentsPromise,
    refreshStaleSourceControlContexts(composer.sourceControlContexts, input.sourceControl),
  ]);
  if (!supportsMultiModelSend(preferences.config)) {
    throw new Error(MULTI_MODEL_SEND_UNSUPPORTED_MESSAGE);
  }
  const { title } = resolveSendTurnTitle({
    trimmedPrompt: composer.trimmedPrompt,
    images: composer.images,
    terminalContexts: composer.sendableTerminalContexts,
    fileReferences: composer.fileReferences ?? [],
  });
  return createMultiModelSendTracker({
    draftId: input.draftId,
    submissionId: input.submissionId,
    projectId: input.projectId,
    projectCwd: input.projectCwd,
    baseBranch: input.baseBranch,
    fetchOrigin: input.fetchOrigin,
    worktreeBranchPrefix: preferences.worktreeBranchPrefix,
    runSetupScript: preferences.runSetupScript,
    title,
    runtimeMode: settings.runtimeMode,
    tokenMode: settings.tokenMode,
    turnAttachments,
    sourceControlContexts,
    createdAt: new Date().toISOString(),
    targets,
  });
}

export const MULTI_MODEL_SEND_CONNECTION_CHANGED_MESSAGE =
  "The connection changed before this model started. Reconnect and send again.";

export interface ExecuteMultiModelSendInput extends Omit<
  PrepareMultiModelSendInput,
  "submissionId"
> {
  readonly refs: ComposerContentRefs;
  readonly composerHandle: SendTurnReadComposer;
  readonly draft: Pick<
    SendTurnComposerDraftDeps,
    | "composerDraftTarget"
    | "clearComposerDraftContent"
    | "setComposerDraftTokenMode"
    | "setComposerDraftPrompt"
    | "addComposerDraftImages"
    | "setComposerDraftTerminalContexts"
    | "setComposerDraftFileReferences"
    | "readComposerDraftContent"
  >;
  /** True once the composer changed since `composer` was taken: it then keeps what it holds. */
  readonly composerChanged: () => boolean;
}

export type MultiModelSendResult =
  /** The draft is already sending to several models. */
  | { readonly kind: "busy" }
  /** Nothing was sent; the composer is unchanged. */
  | { readonly kind: "refused"; readonly message: string }
  | { readonly kind: "sent"; readonly snapshot: MultiModelSendSnapshot };

const preparingDrafts = new Set<DraftId>();

/** Whether the draft is preparing or sending a multi-model send; it sends nothing else meanwhile. */
export function isMultiModelSendBusy(draftId: DraftId): boolean {
  return preparingDrafts.has(draftId) || readMultiModelSend(draftId)?.sending === true;
}

/**
 * Sends one prompt to every chosen model and keeps the user in the composer:
 * its content is cleared as the send goes out, the targets start in parallel,
 * and the draft's tracker (`multiModelSendStore`) reports their outcomes. The
 * models the node did not create come back as the selection, with the prompt,
 * so the next send retries only them; after a send without such a model,
 * "Compare models" is off again. An uncertain target is left to an explicit
 * retry (the composer's banner), never sent again here.
 */
export async function executeMultiModelSend(
  input: ExecuteMultiModelSendInput,
): Promise<MultiModelSendResult> {
  const { draftId, environmentId, composer } = input;
  if (isMultiModelSendBusy(draftId)) return { kind: "busy" };
  preparingDrafts.add(draftId);
  let tracker: MultiModelSendTracker;
  try {
    tracker = await prepareMultiModelSend({ ...input, submissionId: randomUUID() });
  } catch (error) {
    return {
      kind: "refused",
      message: error instanceof Error ? error.message : "Could not send to these models.",
    };
  } finally {
    preparingDrafts.delete(draftId);
  }
  setMultiModelSend(draftId, { tracker, environmentId, sending: true });

  const { refs, composerHandle, draft } = input;
  const live = composerHandle.showsSendThread?.() ?? true;
  // Edits made while the send was prepared stay in the composer.
  const consumed = !input.composerChanged();
  if (consumed) {
    if (live) clearComposerContentRefs(refs);
    draft.clearComposerDraftContent(draft.composerDraftTarget);
    draft.setComposerDraftTokenMode(draft.composerDraftTarget, input.settings.tokenMode);
    if (live) composerHandle.readComposer()?.resetCursorState();
  }
  const selectionAtSend = readMultiModelSelection(draftId);
  let snapshot: MultiModelSendSnapshot;
  try {
    snapshot = await tracker.send({
      api: input.api,
      assertMutationReady: captureReviewedSendReadiness(
        environmentId,
        () => readEnvironmentConnection(environmentId),
        MULTI_MODEL_SEND_CONNECTION_CHANGED_MESSAGE,
      ),
    });
  } finally {
    finishMultiModelSend(draftId, tracker);
  }

  const { notCreated } = summarizeMultiModelSend(snapshot);
  if (notCreated.length > 0 && consumed) {
    restoreUnsentComposerContent({
      refs,
      composerHandle,
      draft,
      prompt: composer.promptForRestore ?? composer.prompt,
      images: composer.images,
      terminalContexts: composer.sendableTerminalContexts,
      fileReferences: composer.fileReferences ?? [],
    });
  }
  // A selection changed meanwhile is the user's.
  if (readMultiModelSelection(draftId) === selectionAtSend) {
    setMultiModelSelection(
      draftId,
      notCreated.length === 0
        ? MODEL_MULTI_SELECT_OFF
        : notCreated.length === snapshot.targets.length
          ? selectionAtSend
          : retryModelMultiSelect(notCreated.map((target) => target.plan.modelSelection)),
    );
  }
  return { kind: "sent", snapshot };
}
