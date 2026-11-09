import {
  REVIEW_DRAFT_STORAGE_KEY,
  reviewDraftKey,
} from "@ryco/client-runtime/state/pull-request-review";
import type { EnvironmentId } from "@ryco/contracts";
import { describe, expect, it, vi } from "vitest";

const values = vi.hoisted(() => new Map<string, string>());

vi.mock("../../platform/kv", () => ({
  mobileKV: {
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: async (key: string) => {
      values.delete(key);
    },
  },
}));

const { clearPullRequestDeviceData } = await import("./pullRequestDeviceData");
const { usePullRequestReviewDrafts } = await import("./pullRequestReviewDrafts");
const { PULL_REQUEST_TAB_STATE_KEY } = await import("./pullRequestTabStateModel");
const { updatePullRequestTabState } = await import("./usePullRequestTabState");

const MAC = "env-mac" as EnvironmentId;
const MINI = "env-mini" as EnvironmentId;
const comment = { path: "a.ts", line: 3, side: "right" as const, body: "Nit", headSha: "h1" };

describe("clearPullRequestDeviceData", () => {
  it("removes one machine's review drafts and the tab's saved place", async () => {
    const macKey = reviewDraftKey({ environmentId: MAC, cwd: "/w/app", number: 7 });
    const miniKey = reviewDraftKey({ environmentId: MINI, cwd: "/x/app", number: 7 });
    usePullRequestReviewDrafts.getState().addComment(macKey, comment);
    usePullRequestReviewDrafts.getState().addComment(miniKey, comment);
    updatePullRequestTabState((state) => ({ ...state, repositoryKey: "github.com/acme/app" }));
    await vi.waitFor(() => expect(values.has(PULL_REQUEST_TAB_STATE_KEY)).toBe(true));

    await clearPullRequestDeviceData(MAC);

    expect(Object.keys(usePullRequestReviewDrafts.getState().draftsByKey)).toEqual([miniKey]);
    await vi.waitFor(() => {
      expect(values.get(REVIEW_DRAFT_STORAGE_KEY)).not.toContain(MAC);
      expect(values.has(PULL_REQUEST_TAB_STATE_KEY)).toBe(false);
    });
  });
});
