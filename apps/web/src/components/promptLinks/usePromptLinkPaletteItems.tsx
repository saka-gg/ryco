import { scopeProjectRef } from "@ryco/client-runtime/scoped";
import type { ServerConfig, ServerProvider } from "@ryco/contracts";
import { useParams } from "@tanstack/react-router";
import { LinkIcon } from "lucide-react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { useEnvironmentServerConfigSelector } from "~/hooks/useChatsAvailability";
import { selectProjectByRef, selectThreadByRef, useStore } from "~/store";
import { resolveThreadRouteTarget } from "~/threadRoutes";

import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "../CommandPalette.logic";
import { copyPromptLink, promptLinkFor, promptLinkRepositoryOf } from "./copyPromptLink";

const NO_PROVIDERS: ReadonlyArray<ServerProvider> = [];
const selectProviders = (config: ServerConfig | null) => config?.providers ?? NO_PROVIDERS;

/**
 * "Copy prompt link" in the command palette: the draft in the open composer,
 * else the open thread's first prompt. With the project on GitHub a second
 * entry also names the repository and the composer's model.
 */
export function usePromptLinkPaletteItems(): ReadonlyArray<CommandPaletteActionItem> {
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const target = routeTarget
    ? routeTarget.kind === "server"
      ? routeTarget.threadRef
      : routeTarget.draftId
    : null;
  const draftPrompt = useComposerDraftStore((store) =>
    target ? (store.getComposerDraft(target)?.prompt ?? "") : "",
  );
  const draftSelection = useComposerDraftStore((store) => {
    const draft = target ? store.getComposerDraft(target) : null;
    return draft?.activeProvider
      ? (draft.modelSelectionByProvider[draft.activeProvider] ?? null)
      : null;
  });
  const draftSession = useComposerDraftStore((store) =>
    routeTarget?.kind === "draft" ? store.getDraftSession(routeTarget.draftId) : null,
  );
  const thread = useStore((store) =>
    routeTarget?.kind === "server" ? selectThreadByRef(store, routeTarget.threadRef) : undefined,
  );
  const environmentId = thread?.environmentId ?? draftSession?.environmentId ?? null;
  const projectId = thread?.projectId ?? draftSession?.projectId ?? null;
  const project = useStore((store) =>
    environmentId && projectId
      ? selectProjectByRef(store, scopeProjectRef(environmentId, projectId))
      : undefined,
  );
  const providers = useEnvironmentServerConfigSelector(environmentId, selectProviders);

  const fromDraft = draftPrompt.trim().length > 0;
  const prompt = fromDraft
    ? draftPrompt
    : (thread?.messages.find((message) => message.role === "user")?.text ?? "");
  const plain = promptLinkFor(prompt);
  if (plain === null) return [];
  const description = fromDraft ? "The draft in the composer" : "This thread's first prompt";
  const items: CommandPaletteActionItem[] = [
    {
      kind: "action",
      value: "action:copy-prompt-link",
      searchTerms: ["copy", "share", "prompt", "link"],
      title: "Copy prompt link",
      description,
      icon: <LinkIcon className={ITEM_ICON_CLASS} />,
      run: () => copyPromptLink(plain),
    },
  ];
  const repository = promptLinkRepositoryOf(project?.repositoryIdentity);
  const withContext =
    repository === null
      ? null
      : promptLinkFor(prompt, {
          repository,
          selection: (fromDraft ? draftSelection : null) ?? thread?.modelSelection ?? null,
          providers,
        });
  if (withContext !== null) {
    items.push({
      kind: "action",
      value: "action:copy-prompt-link-with-context",
      searchTerms: ["copy", "share", "prompt", "link", "repository", "model"],
      title: "Copy prompt link with repo and model",
      description,
      icon: <LinkIcon className={ITEM_ICON_CLASS} />,
      run: () => copyPromptLink(withContext),
    });
  }
  return items;
}
