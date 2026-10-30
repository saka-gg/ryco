import { createReviewDraftStore } from "@ryco/client-runtime/state/pull-request-review";

/**
 * Reviews being written on this phone, by `reviewDraftKey` (node, checkout,
 * number): the shared draft store, memory-only. A draft is the reader's own
 * text and survives leaving the screen, not a relaunch (like a hosted browser's).
 */
export const usePullRequestReviewDrafts = createReviewDraftStore();
