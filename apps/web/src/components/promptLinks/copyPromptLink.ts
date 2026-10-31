import { promptLinkOwnRepositoryKey } from "@ryco/client-runtime/promptLinks";
import type { ModelSelection, RepositoryIdentity, ServerProvider } from "@ryco/contracts";
import {
  buildNewThreadLink,
  parsePromptLinkRepository,
  PROMPT_LINK_MAX_PROMPT_LENGTH,
  type PromptLinkRepository,
} from "@ryco/shared/promptLinks";

import { isElectron } from "~/env";
import { configuredHostedAppUrl } from "~/hostedPairing";

import { toastManager } from "../ui/toast";

/**
 * The site a copied link opens: this one in a browser (the Hub, or a node's own
 * web app), and the hosted app from the desktop app, whose own address is a
 * loopback one nobody else can open.
 */
function promptLinkOrigin(): string {
  return isElectron || typeof window === "undefined"
    ? configuredHostedAppUrl()
    : window.location.origin;
}

/** The project's own GitHub repository, the only kind a prompt link can name. */
export function promptLinkRepositoryOf(
  identity: RepositoryIdentity | null | undefined,
): PromptLinkRepository | null {
  const key = promptLinkOwnRepositoryKey(identity);
  return key?.startsWith("github.com/")
    ? parsePromptLinkRepository(key.slice("github.com/".length))
    : null;
}

export interface PromptLinkContext {
  readonly repository: PromptLinkRepository | null;
  readonly selection: ModelSelection | null;
  readonly providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "driver">>;
}

/**
 * A shareable link to a prompt, or null when there is no prompt or it is too
 * long for one. With a context it also names the repository and the model:
 * the model's provider by its driver kind, which every user's instances share.
 */
export function promptLinkFor(prompt: string, context?: PromptLinkContext): string | null {
  const trimmed = prompt.trim();
  if (trimmed.length === 0 || trimmed.length > PROMPT_LINK_MAX_PROMPT_LENGTH) return null;
  const selection = context?.selection ?? null;
  const provider = selection
    ? (context?.providers.find((candidate) => candidate.instanceId === selection.instanceId)
        ?.driver ?? null)
    : null;
  return buildNewThreadLink({
    prompt: trimmed,
    repository: context?.repository ?? null,
    provider,
    model: provider === null ? null : (selection?.model ?? null),
    origin: promptLinkOrigin(),
  });
}

/** Copies a prompt link and says so. */
export async function copyPromptLink(link: string): Promise<void> {
  try {
    if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
      throw new Error("The clipboard is not available here.");
    }
    await navigator.clipboard.writeText(link);
    toastManager.add({
      type: "success",
      title: "Prompt link copied",
      description: "Opening it puts the prompt in a draft. Nothing runs until Send.",
    });
  } catch (error) {
    toastManager.add({
      type: "error",
      title: "Could not copy the prompt link",
      description: error instanceof Error ? error.message : "An error occurred.",
    });
  }
}
