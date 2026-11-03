import {
  reviewDraftKey,
  selectReviewDraft,
  type ChangeRequestNextAction,
} from "@ryco/client-runtime/state/pull-request-review";
import type { EnvironmentId, SourceControlChangeRequestDetail } from "@ryco/contracts";
import { getChangeRequestHostCapabilities } from "@ryco/shared/changeRequestHostCapabilities";
import * as Option from "effect/Option";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

// The review draft changes on every keystroke. The pull request screen calls
// `usePullRequestActions` and renders the whole timeline, so nothing it reads
// from the draft store may change with one; only the review sheet's
// `usePullRequestReviewDraft` reads the draft. Hooks run as plain functions
// (no React renderer exists in this suite) over the real shared draft store.

const hoisted = vi.hoisted(() => ({
  selectors: [] as Array<(state: unknown) => unknown>,
  submitChangeRequestReview: vi.fn(async (_input: unknown) => ({})),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: <T>(initial: T | (() => T)) =>
      [typeof initial === "function" ? (initial as () => T)() : initial, () => {}] as const,
  };
});
vi.mock("./pullRequestReviewDrafts", async () => {
  const { createReviewDraftStore } = await import("@ryco/client-runtime/state/pull-request-review");
  const store = createReviewDraftStore();
  const usePullRequestReviewDrafts = <T>(selector: (state: unknown) => T): T => {
    hoisted.selectors.push(selector);
    return selector(store.getState());
  };
  return { usePullRequestReviewDrafts: Object.assign(usePullRequestReviewDrafts, store) };
});
vi.mock("../../providers/ConnectionRegistryProvider", () => ({
  useConnectionRegistry: () => ({ driver: { supervisor: { read: () => null } } }),
}));
vi.mock("../../connection/environmentApi", () => ({
  readRpcClient: () => ({
    sourceControl: { submitChangeRequestReview: hoisted.submitChangeRequestReview },
  }),
}));
vi.mock("../../rpc/pullRequestAtoms", () => ({ refreshPullRequestReads: () => undefined }));
vi.mock("@ryco/client-runtime/state/composer", () => ({
  captureReviewedSendReadiness: () => () => undefined,
}));

import { usePullRequestReviewDrafts } from "./pullRequestReviewDrafts";
import { usePullRequestActions, usePullRequestReviewDraft } from "./usePullRequestActions";

const ENVIRONMENT_ID = "env-1" as EnvironmentId;
const KEY = reviewDraftKey({ environmentId: ENVIRONMENT_ID, cwd: "/repo", number: 42 });

const DETAIL = {
  provider: "github",
  number: 42,
  title: "Phone pull requests",
  url: "https://github.com/acme/app/pull/42",
  baseRefName: "main",
  headRefName: "feature/prs",
  state: "open",
  updatedAt: Option.none(),
  headSha: "abc1234",
  body: "",
  comments: [],
  truncated: false,
} as SourceControlChangeRequestDetail;

const NEXT_ACTION: ChangeRequestNextAction = {
  kind: "merge",
  label: "Merge",
  tone: "neutral",
  blocking: false,
  viewerCanAct: true,
};

const screenActions = () =>
  usePullRequestActions({
    environmentId: ENVIRONMENT_ID,
    cwd: "/repo",
    number: 42,
    detail: DETAIL,
    viewer: null,
    nextAction: NEXT_ACTION,
    capabilities: getChangeRequestHostCapabilities("github"),
    mutationReady: true,
    role: "owner",
    hostPendingComments: 0,
  });

describe("the review draft and the pull request screen", () => {
  beforeEach(() => {
    hoisted.selectors.length = 0;
    hoisted.submitChangeRequestReview.mockClear();
    usePullRequestReviewDrafts.getState().clear(KEY);
  });

  it("re-renders the review sheet on a keystroke, and nothing the screen reads", () => {
    const control = screenActions();
    const screenSelectors = hoisted.selectors.splice(0);
    const before = usePullRequestReviewDrafts.getState();
    before.setSummary(KEY, "L");
    const after = usePullRequestReviewDrafts.getState();
    // The store re-renders a subscriber whose selection changed (Object.is).
    for (const select of screenSelectors) expect(select(after)).toBe(select(before));

    expect(usePullRequestReviewDraft(control).summary).toBe("L");
    const sheetSelectors = hoisted.selectors.splice(0);
    after.setSummary(KEY, "Lo");
    const typed = usePullRequestReviewDrafts.getState();
    expect(sheetSelectors.some((select) => select(typed) !== select(after))).toBe(true);
  });

  it("sends the sheet's draft with the verdict it picked, and clears it once the host accepts", async () => {
    const store = usePullRequestReviewDrafts.getState();
    store.setSummary(KEY, "Looks good");
    store.setEvent(KEY, "approve");
    const draft = usePullRequestReviewDraft(screenActions());
    expect(draft).toMatchObject({ summary: "Looks good", event: "approve" });

    const onDone = vi.fn();
    draft.submit(onDone);
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(hoisted.submitChangeRequestReview).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/repo",
        reference: "42",
        event: "approve",
        body: "Looks good",
        expectedHeadSha: "abc1234",
      }),
    );
    expect(selectReviewDraft(usePullRequestReviewDrafts.getState(), KEY).summary).toBe("");
  });
});
