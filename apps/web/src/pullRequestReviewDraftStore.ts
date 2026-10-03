import { createReviewDraftStore } from "@ryco/client-runtime/state/pull-request-review";

import { isHostedHubMode } from "./env";

/**
 * Pending pull request reviews written in this browser. Drafts are the user's
 * own text, so they survive reloads locally; hosted mode keeps them in memory
 * (a hosted browser must not persist anything node-owned or account-scoped).
 */
export const usePullRequestReviewDraftStore = createReviewDraftStore(
  typeof window !== "undefined" && !isHostedHubMode() ? { storage: window.localStorage } : {},
);
