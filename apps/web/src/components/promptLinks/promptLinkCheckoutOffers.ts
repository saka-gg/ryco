import type { EnvironmentId, ProjectId } from "@ryco/contracts";
import type { PromptLinkPullRequest } from "@ryco/shared/promptLinks";
import { create } from "zustand";

import { useComposerDraftStore, type DraftId } from "../../composerDraftStore";

/**
 * A pull request a prompt link named, offered on the draft it opened. A link never records the
 * pull request as the draft's checkout: creating that worktree runs the project's setup script
 * on code a stranger may have chosen. The draft's composer shows the offer instead
 * (`promptLinkCheckoutBanner.tsx`) until the user checks it out with a click, dismisses it, or
 * moves the draft to another project. Kept in memory: a reload drops the offer, never the draft.
 * This module is shared by the chat view and the link's page, so it imports nothing of the
 * link's parser or resolver: those would load with every chat.
 */
export interface PromptLinkCheckoutOffer {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly pullRequest: PromptLinkPullRequest;
}

interface PromptLinkCheckoutOffersState {
  readonly byDraftId: Readonly<Record<string, PromptLinkCheckoutOffer>>;
}

export const usePromptLinkCheckoutOffers = create<PromptLinkCheckoutOffersState>(() => ({
  byDraftId: {},
}));

/** Leaves the offer on the draft; offers of drafts that are gone (sent or cleared) go. */
export function offerPromptLinkCheckout(draftId: DraftId, offer: PromptLinkCheckoutOffer): void {
  const drafts = useComposerDraftStore.getState();
  usePromptLinkCheckoutOffers.setState((state) => ({
    byDraftId: {
      ...Object.fromEntries(
        Object.entries(state.byDraftId).filter(
          ([id]) => drafts.getDraftSession(id as DraftId) !== null,
        ),
      ),
      [draftId]: offer,
    },
  }));
}

export function withdrawPromptLinkCheckout(draftId: DraftId): void {
  usePromptLinkCheckoutOffers.setState((state) => {
    if (!(draftId in state.byDraftId)) return state;
    const { [draftId]: _withdrawn, ...rest } = state.byDraftId;
    return { byDraftId: rest };
  });
}

/**
 * What the offer says. The checkout runs the project's setup script on code from the pull
 * request, so its button says so. (The repository name passed the link's slug check.)
 */
export function promptLinkCheckoutOfferCopy(pullRequest: PromptLinkPullRequest): {
  readonly title: string;
  readonly description: string;
  readonly action: string;
} {
  const { owner, name, number } = pullRequest;
  return {
    title: `This link is for ${owner}/${name}#${number}`,
    description:
      "The draft works in the project's checkout. Checking the pull request out puts its code in a new worktree and runs your project's setup script on it.",
    action: `Check out #${number} (runs your setup script)`,
  };
}

export function resetPromptLinkCheckoutOffersForTests(): void {
  usePromptLinkCheckoutOffers.setState({ byDraftId: {} }, true);
}
