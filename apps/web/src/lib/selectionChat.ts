import { ThreadId, type ScopedProjectRef } from "@ryco/contracts";
import { scopedThreadKey, scopeThreadRef } from "@ryco/client-runtime/scoped";
import { appendSelectionQuote, type SelectionQuote } from "@ryco/client-runtime/state/composer";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { useMessageQueueStore } from "../messageQueueStore";
import type { NewThreadOptions } from "../hooks/useHandleNewThread";
import type { SendTurnComposerSnapshot, SendTurnSettings } from "../hooks/executeChatSendTurn";

export interface SelectionChatRequest {
  quote: SelectionQuote;
  prompt: string;
  envMode: "local" | "worktree";
  intent: "send" | "compose";
  requestKey: string;
}

/** Transfers ownership only after navigation succeeds. Uses the normal first-turn queue. */
export async function startSelectionChat(
  input: SelectionChatRequest & {
    projectRef: ScopedProjectRef;
    branch: string | null;
    canUseWorktree: boolean;
    composer: Pick<
      SendTurnComposerSnapshot,
      | "selectedProvider"
      | "selectedModel"
      | "selectedProviderModels"
      | "selectedPromptEffort"
      | "selectedModelSelection"
    >;
    settings: SendTurnSettings;
    prepare: () => Promise<boolean>;
    isCurrent: () => boolean;
    createThread: (projectRef: ScopedProjectRef, options: NewThreadOptions) => Promise<void>;
  },
): Promise<void> {
  if (input.intent === "send" && !input.prompt.trim())
    throw new Error("Write a question before sending.");
  if (input.envMode === "worktree" && (!input.canUseWorktree || !input.branch)) {
    throw new Error("Select a checked-out branch before creating a worktree.");
  }
  const prompt = appendSelectionQuote(input.prompt, input.quote);
  // Saves the source before leaving. Destination dispatch uses its own autosave barrier.
  if (!(await input.prepare()))
    throw new Error("Save the pending file changes before opening the new chat.");
  const draftId = DraftId.make(`selection-${input.requestKey}`);
  const threadId = ThreadId.make(`selection-${input.requestKey}`);
  await input.createThread(input.projectRef, {
    envMode: input.envMode,
    branch: input.envMode === "worktree" ? input.branch : null,
    worktreePath: null,
    freshDraft: {
      draftId,
      threadId,
      prompt,
      modelSelection: input.composer.selectedModelSelection,
      runtimeMode: input.settings.runtimeMode,
      tokenMode: input.settings.tokenMode,
      isCurrent: input.isCurrent,
    },
  });
  if (input.intent !== "send") return;
  const key = scopedThreadKey(scopeThreadRef(input.projectRef.environmentId, threadId));
  const queue = useMessageQueueStore.getState();
  if (!queue.queuesByThreadKey[key]?.some((entry) => entry.id === input.requestKey)) {
    queue.enqueue(key, {
      id: input.requestKey,
      createdAt: new Date().toISOString(),
      composer: {
        selectedProvider: input.composer.selectedProvider,
        selectedModel: input.composer.selectedModel,
        selectedProviderModels: input.composer.selectedProviderModels,
        selectedPromptEffort: input.composer.selectedPromptEffort,
        selectedModelSelection: input.composer.selectedModelSelection,
        prompt,
        trimmedPrompt: prompt.trim(),
        images: [],
        sendableTerminalContexts: [],
        sourceControlContexts: [],
        expiredTerminalContextCount: 0,
      },
      settings: input.settings,
    });
  }
  const drafts = useComposerDraftStore.getState();
  if (drafts.getComposerDraft(draftId)?.prompt === prompt) drafts.setPrompt(draftId, "");
}
