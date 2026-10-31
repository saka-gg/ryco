import { linkedPromptDraftAction, promptLinkNotice } from "@ryco/client-runtime/promptLinks";
import type { LinkedPrompt } from "@ryco/shared/promptLinks";

import { type ComposerThreadTarget, useComposerDraftStore } from "~/composerDraftStore";

import { toastManager } from "../ui/toast";

export interface PlaceLinkedPromptOptions {
  /** Anything the link asked for and did not get, such as a model; and what Send will do. */
  readonly notes?: ReadonlyArray<string | null>;
  /** Writes the rest of what the link asked for (model, checkout) together with the prompt. */
  readonly apply?: () => void;
}

/**
 * Puts a linked prompt in a composer for the user to read and send; nothing is
 * sent. Text the user already typed there is never replaced without asking: a
 * toast offers to swap it for the linked prompt, and until then the draft, its
 * model and its checkout stay as they are. A link without a prompt (a pull
 * request link may have none) only applies the rest, under the same rule.
 */
export function placeLinkedPrompt(
  target: ComposerThreadTarget,
  prompt: LinkedPrompt | null,
  options: PlaceLinkedPromptOptions = {},
): void {
  const notice = promptLinkNotice(prompt, options.notes);
  const suspicious = (prompt?.hiddenCharacters ?? 0) > 0;
  const place = () => {
    if (prompt !== null) useComposerDraftStore.getState().setPrompt(target, prompt.text);
    options.apply?.();
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
  const existing = useComposerDraftStore.getState().getComposerDraft(target)?.prompt ?? "";
  const action =
    prompt === null
      ? existing.trim().length === 0
        ? "fill"
        : "ask"
      : linkedPromptDraftAction(existing, prompt.text);
  if (action !== "ask") {
    place();
    return;
  }
  const id = toastManager.add({
    type: suspicious ? "warning" : "info",
    title: prompt === null ? "Link ready" : "Linked prompt ready",
    description:
      prompt === null
        ? `This draft already has text. Keep it and use the draft for the link? ${notice}`
        : `This draft already has text. Replace it with the linked prompt? ${notice}`,
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
