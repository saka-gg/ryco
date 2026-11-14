import { hostedHubStore } from "@ryco/client-runtime/authorization";
import {
  EnvironmentId,
  type ComposerSourceControlContext,
  type SourceControlIssueDetail,
} from "@ryco/contracts";
import { DateTime, Option } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("~/env", () => ({ isHostedHubMode: () => false }));

const { getIssue, getChangeRequestDetail } = vi.hoisted(() => ({
  getIssue: vi.fn(),
  getChangeRequestDetail: vi.fn(),
}));

vi.mock("~/environments/runtime", () => ({
  requireEnvironmentConnection: vi.fn(() => ({
    client: { sourceControl: { getIssue, getChangeRequestDetail } },
  })),
}));

import {
  changeRequestDetailBinding,
  fetchSourceControlIssueDetail,
  invalidateSourceControl,
  issueDetailBinding,
  resetSourceControlAtomsForTests,
} from "../rpc/sourceControlAtoms";
import { createSourceControlContextFetcher } from "./chatSendShared";

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const CWD = "/tmp/workspace";

function issueDetail(body: string): SourceControlIssueDetail {
  return {
    provider: "github",
    number: 7,
    title: "Issue 7",
    url: "https://example.test/issues/7",
    state: "open",
    updatedAt: Option.none(),
    body,
    comments: [],
    truncated: false,
  };
}

function staleIssueContext(detail: SourceControlIssueDetail): ComposerSourceControlContext {
  const past = DateTime.fromDateUnsafe(new Date(Date.now() - 10 * 60_000));
  return {
    id: "context-1",
    kind: "issue",
    provider: "github",
    reference: "owner/repo#7",
    detail,
    fetchedAt: past,
    staleAfter: past,
  };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

beforeEach(() => {
  hostedHubStore.setState(hostedHubStore.getInitialState(), true);
  vi.clearAllMocks();
  vi.useFakeTimers();
  resetSourceControlAtomsForTests();
});

afterEach(() => {
  resetSourceControlAtomsForTests();
  vi.useRealTimers();
});

describe("createSourceControlContextFetcher", () => {
  it("sends the composer's cached issue detail, without a second read", async () => {
    getIssue.mockResolvedValueOnce(issueDetail("as the UI shows it"));
    // The composer's attach read fills the shared detail cache.
    await fetchSourceControlIssueDetail({
      environmentId: ENVIRONMENT_ID,
      cwd: CWD,
      reference: "7",
    });

    const fetcher = createSourceControlContextFetcher({ environmentId: ENVIRONMENT_ID, cwd: CWD });
    const refreshed = await fetcher(staleIssueContext(issueDetail("attached earlier")));

    expect(getIssue).toHaveBeenCalledTimes(1);
    expect(refreshed.detail).toMatchObject({ body: "as the UI shows it" });
  });

  it("reads again after the UI's cache was invalidated, so the send is never staler", async () => {
    getIssue
      .mockResolvedValueOnce(issueDetail("before the comment"))
      .mockResolvedValueOnce(issueDetail("after the comment"));
    await fetchSourceControlIssueDetail({
      environmentId: ENVIRONMENT_ID,
      cwd: CWD,
      reference: "7",
    });
    invalidateSourceControl({ environmentId: ENVIRONMENT_ID, cwd: CWD });

    const fetcher = createSourceControlContextFetcher({ environmentId: ENVIRONMENT_ID, cwd: CWD });
    const refreshed = await fetcher(staleIssueContext(issueDetail("attached earlier")));

    expect(getIssue).toHaveBeenCalledTimes(2);
    expect(refreshed.detail).toMatchObject({ body: "after the comment" });
  });

  it("sends a view's newer capped detail over the composer's older copy", async () => {
    getIssue.mockResolvedValueOnce(issueDetail("composer attach"));
    await fetchSourceControlIssueDetail({
      environmentId: ENVIRONMENT_ID,
      cwd: CWD,
      reference: "7",
    });
    vi.advanceTimersByTime(60_000);
    // A view polls the same capped detail and sees a comment someone else added.
    getIssue.mockResolvedValueOnce(issueDetail("with the new comment"));
    const release = issueDetailBinding.watch({
      environmentId: ENVIRONMENT_ID,
      cwd: CWD,
      reference: "7",
    });
    await flush();

    const fetcher = createSourceControlContextFetcher({ environmentId: ENVIRONMENT_ID, cwd: CWD });
    const refreshed = await fetcher(staleIssueContext(issueDetail("attached earlier")));

    expect(getIssue).toHaveBeenCalledTimes(2);
    expect(refreshed.detail).toMatchObject({ body: "with the new comment" });
    release();
  });

  it("keeps the composer's copy when it is newer than the view's", async () => {
    getIssue.mockResolvedValueOnce(issueDetail("view read"));
    const release = issueDetailBinding.watch({
      environmentId: ENVIRONMENT_ID,
      cwd: CWD,
      reference: "7",
    });
    await flush();
    vi.advanceTimersByTime(60_000);
    getIssue.mockResolvedValueOnce(issueDetail("composer attach"));
    await fetchSourceControlIssueDetail({
      environmentId: ENVIRONMENT_ID,
      cwd: CWD,
      reference: "7",
    });

    const fetcher = createSourceControlContextFetcher({ environmentId: ENVIRONMENT_ID, cwd: CWD });
    const refreshed = await fetcher(staleIssueContext(issueDetail("attached earlier")));

    expect(refreshed.detail).toMatchObject({ body: "composer attach" });
    release();
  });

  it("reads again instead of sending a view's detail older than five minutes", async () => {
    getIssue.mockResolvedValueOnce(issueDetail("old view read"));
    // The view stays open and does not poll: its read just ages.
    const release = issueDetailBinding.watch({
      environmentId: ENVIRONMENT_ID,
      cwd: CWD,
      reference: "7",
    });
    await flush();
    vi.advanceTimersByTime(5 * 60_000);
    getIssue.mockResolvedValueOnce(issueDetail("fresh"));

    const fetcher = createSourceControlContextFetcher({ environmentId: ENVIRONMENT_ID, cwd: CWD });
    const refreshed = await fetcher(staleIssueContext(issueDetail("attached earlier")));

    expect(getIssue).toHaveBeenCalledTimes(2);
    expect(refreshed.detail).toMatchObject({ body: "fresh" });
    release();
  });

  it("does not send a full-content page's uncapped detail", async () => {
    getChangeRequestDetail.mockResolvedValueOnce({ ...issueDetail("full page"), number: 7 });
    const release = changeRequestDetailBinding.watch({
      environmentId: ENVIRONMENT_ID,
      cwd: CWD,
      reference: "7",
      fullContent: true,
    });
    await flush();
    getChangeRequestDetail.mockResolvedValueOnce({ ...issueDetail("capped read"), number: 7 });

    const fetcher = createSourceControlContextFetcher({ environmentId: ENVIRONMENT_ID, cwd: CWD });
    const past = DateTime.fromDateUnsafe(new Date(Date.now() - 10 * 60_000));
    const refreshed = await fetcher({
      ...staleIssueContext(issueDetail("attached earlier")),
      kind: "change-request",
      fetchedAt: past,
      staleAfter: past,
    });

    expect(getChangeRequestDetail).toHaveBeenLastCalledWith({ cwd: CWD, reference: "7" });
    expect(refreshed.detail).toMatchObject({ body: "capped read" });
    release();
  });

  it("fetches when nothing is cached and keeps the context without a cwd", async () => {
    getIssue.mockResolvedValueOnce(issueDetail("fresh"));
    const fetcher = createSourceControlContextFetcher({ environmentId: ENVIRONMENT_ID, cwd: CWD });
    await expect(fetcher(staleIssueContext(issueDetail("old")))).resolves.toMatchObject({
      detail: { body: "fresh" },
    });
    expect(getIssue).toHaveBeenCalledWith({ cwd: CWD, reference: "7" });

    const original = staleIssueContext(issueDetail("old"));
    const noCwd = createSourceControlContextFetcher({ environmentId: ENVIRONMENT_ID, cwd: null });
    await expect(noCwd(original)).resolves.toBe(original);
    expect(getIssue).toHaveBeenCalledTimes(1);
  });
});
