import { linkedPromptDraftAction, promptLinkNotice } from "@ryco/client-runtime/promptLinks";
import type { ModelSelection } from "@ryco/contracts";
import type { LinkedPrompt } from "@ryco/shared/promptLinks";

import { type ComposerThreadTarget, useComposerDraftStore } from "~/composerDraftStore";

import { toastManager } from "../ui/toast";

/** An existing checkout a link moves a draft to: the "existing worktree" target. */
export interface LinkedDraftLocation {
  readonly worktreePath: string;
  readonly branch: string | null;
}

export interface PlaceLinkedPromptOptions {
  /** Anything the link asked for and did not get, such as a model; and what it left out. */
  readonly notes?: ReadonlyArray<string | null>;
  /** The model the link asks for, set together with the prompt. */
  readonly modelSelection?: ModelSelection | null;
  /** The checkout the link moves a draft to, set together with the prompt. */
  readonly location?: LinkedDraftLocation | null;
  /** What else the link leaves on the draft once the user took it, such as a checkout offer. */
  readonly onPlaced?: () => void;
}

/** What the composer at `target` holds that a link could replace or change. */
function readLinkedPromptDraft(target: ComposerThreadTarget, options: PlaceLinkedPromptOptions) {
  const store = useComposerDraftStore.getState();
  const composer = store.getComposerDraft(target);
  const activeProvider = composer?.activeProvider ?? null;
  const currentModel = activeProvider
    ? (composer?.modelSelectionByProvider[activeProvider] ?? null)
    : null;
  const { modelSelection, location } = options;
  const session = typeof target === "string" ? store.getDraftSession(target) : null;
  return {
    text: composer?.prompt ?? "",
    attachments:
      (composer?.images.length ?? 0) +
      (composer?.terminalContexts.length ?? 0) +
      (composer?.fileReferences.length ?? 0) +
      (composer?.sourceControlContexts.length ?? 0),
    changesModel:
      modelSelection != null &&
      (currentModel?.instanceId !== modelSelection.instanceId ||
        currentModel.model !== modelSelection.model),
    changesLocation:
      location != null &&
      (session?.envMode !== "local" || session.worktreePath !== location.worktreePath),
  };
}

/**
 * Puts a linked prompt in a composer for the user to read and send; nothing is
 * sent. A composer that holds anything of the user's (text, attachments or
 * contexts) is never changed without asking: a toast offers to take the link,
 * and until then the draft, its model and its checkout stay as they are. A
 * link without a prompt (a pull request link may have none) only applies the
 * rest, under the same rule.
 */
export function placeLinkedPrompt(
  target: ComposerThreadTarget,
  prompt: LinkedPrompt | null,
  options: PlaceLinkedPromptOptions = {},
): void {
  const notice = promptLinkNotice(prompt, options.notes);
  const suspicious = (prompt?.hiddenCharacters ?? 0) > 0;
  const place = () => {
    const store = useComposerDraftStore.getState();
    if (prompt !== null) store.setPrompt(target, prompt.text);
    if (options.modelSelection) store.setModelSelection(target, options.modelSelection);
    if (options.location && typeof target === "string") {
      // The "existing worktree" row of `NewThreadWorkLocation.logic.ts`; importing that
      // module here would split it out of the chat route's chunk.
      store.setDraftThreadContext(target, {
        envMode: "local",
        worktreePath: options.location.worktreePath,
        branch: options.location.branch,
        worktreeSource: null,
      });
    }
    options.onPlaced?.();
    // It was not written here, so it must be read before it is sent.
    toastManager.add({
      type: suspicious ? "warning" : "info",
      title: suspicious
        ? "This prompt had hidden characters, it may be malicious"
        : prompt === null
          ? "Draft opened from a link"
          : "Prompt added from a link",
      description: notice,
      // A warning stays until it is dismissed.
      ...(suspicious ? { timeout: 0 } : {}),
    });
  };
  const action = linkedPromptDraftAction(
    readLinkedPromptDraft(target, options),
    prompt?.text ?? null,
  );
  if (action !== "ask") {
    place();
    return;
  }
  const id = toastManager.add({
    type: suspicious ? "warning" : "info",
    title: prompt === null ? "Link ready" : "Linked prompt ready",
    description:
      prompt === null
        ? `This draft holds your own text, attachments or settings. Use it for the link anyway? ${notice}`
        : `This draft holds your own text, attachments or settings. Replace its text with the linked prompt? ${notice}`,
    timeout: 0,
    actionProps: {
      children: prompt === null ? "Use draft" : "Replace draft",
      onClick: () => {
        toastManager.close(id);
        place();
      },
    },
  });
}
