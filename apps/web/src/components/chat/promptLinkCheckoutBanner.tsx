import { GitPullRequestIcon } from "lucide-react";
import { useMemo } from "react";

import {
  useComposerDraftStore,
  type DraftId,
  type DraftSessionState,
} from "../../composerDraftStore";
import {
  promptLinkCheckoutOfferCopy,
  usePromptLinkCheckoutOffers,
  withdrawPromptLinkCheckout,
} from "../promptLinks/promptLinkCheckoutOffers";
import { Button } from "../ui/button";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import { pullRequestCheckoutDraftPatch } from "./NewThreadWorkLocation.logic";

/**
 * The composer notice a pull request link leaves on its draft: which pull request the link is
 * for, and a button that checks it out exactly as picking it in "Work in … from …" does. It
 * stays until the user clicks it, dismisses it, picks the pull request by hand, or moves the
 * draft to another project. Null when the draft has no such offer.
 */
export function usePromptLinkCheckoutBannerItem(input: {
  readonly draftId: DraftId | null;
  readonly draftSession: Pick<
    DraftSessionState,
    "environmentId" | "projectId" | "worktreeSource"
  > | null;
}): ComposerBannerStackItem | null {
  const { draftId, draftSession } = input;
  const offer = usePromptLinkCheckoutOffers((state) =>
    draftId ? (state.byDraftId[draftId] ?? null) : null,
  );
  const source = draftSession?.worktreeSource ?? null;
  const offered =
    draftId !== null &&
    offer !== null &&
    draftSession !== null &&
    draftSession.environmentId === offer.environmentId &&
    draftSession.projectId === offer.projectId &&
    // Picked by hand already.
    !(source?.kind === "pr" && source.number === offer.pullRequest.number);
  return useMemo(() => {
    if (!offered || draftId === null || offer === null) return null;
    const { number } = offer.pullRequest;
    const copy = promptLinkCheckoutOfferCopy(offer.pullRequest);
    return {
      id: `prompt-link-checkout:${draftId}`,
      variant: "info",
      icon: <GitPullRequestIcon />,
      title: copy.title,
      description: copy.description,
      actions: (
        <Button
          size="xs"
          onClick={() => {
            useComposerDraftStore
              .getState()
              .setDraftThreadContext(draftId, pullRequestCheckoutDraftPatch(number, null));
            withdrawPromptLinkCheckout(draftId);
          }}
        >
          {copy.action}
        </Button>
      ),
      dismissLabel: "Dismiss the pull request checkout",
      onDismiss: () => withdrawPromptLinkCheckout(draftId),
    };
  }, [draftId, offer, offered]);
}
