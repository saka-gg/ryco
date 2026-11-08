import { createReviewDraftStore } from "@ryco/client-runtime/state/pull-request-review";

import { mobileKV } from "../../platform/kv";

/**
 * Reviews being written on this phone, by `reviewDraftKey` (node, checkout,
 * number): the shared draft store, saved on the device like the web saves it
 * in the browser, so line comments and the summary survive a relaunch until
 * the review is sent. Only the reader's own text is kept, never pull request
 * content; the store caps how many drafts it keeps.
 */
export const usePullRequestReviewDrafts = createReviewDraftStore({ storage: mobileKV });
