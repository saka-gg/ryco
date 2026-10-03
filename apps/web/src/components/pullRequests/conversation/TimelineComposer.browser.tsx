import "~/index.css";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { cleanup, render } from "vitest-browser-react";

vi.mock("~/rpc/useSourceControl", async (importOriginal) => {
  const { createSourceControlRpcMock } =
    await import("~/components/pullRequests/testing/sourceControlRpcMock");
  return createSourceControlRpcMock(await importOriginal());
});

import {
  FIXTURE_NOW_MS,
  PullRequestsTestProvider,
  resetPullRequestsTestState,
  sourceControlRpcMock,
} from "../testing/PullRequestsTestProvider";
import { TimelineComposer } from "./TimelineComposer";

afterEach(async () => {
  await cleanup();
  resetPullRequestsTestState();
  document.body.innerHTML = "";
});

describe("TimelineComposer", () => {
  it("keeps focus in the comment field after posting with ⌘↵", async () => {
    vi.setSystemTime(FIXTURE_NOW_MS);
    let post!: () => void;
    sourceControlRpcMock.mutationOverrides.useAddChangeRequestCommentMutation = () =>
      new Promise((resolve) => {
        post = () => resolve({});
      });
    await render(
      <PullRequestsTestProvider selected={703} width={1192}>
        <TimelineComposer draftKey="timeline-composer-focus" canClose={false} />
      </PullRequestsTestProvider>,
    );
    const field = page.getByRole("textbox", { name: "Comment" });
    await field.click();
    await userEvent.type(field, "Looks good to me");
    await userEvent.keyboard("{Meta>}{Enter}{/Meta}");

    await expect
      .poll(() => sourceControlRpcMock.callsTo("useAddChangeRequestCommentMutation").length)
      .toBe(1);
    // Posting disables the field, which takes focus away from it.
    await expect.element(field).toBeDisabled();
    await expect.poll(() => document.activeElement).toBe(document.body);
    post();
    await expect.element(field).toHaveValue("");
    // The field is disabled while posting; focus comes back once it settles.
    await expect.element(field).toHaveFocus();
  });
});
