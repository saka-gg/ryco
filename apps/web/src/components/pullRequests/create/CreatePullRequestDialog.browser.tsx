import "~/index.css";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

const routerMock = vi.hoisted(() => ({ navigate: vi.fn(async (_options: unknown) => undefined) }));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => routerMock.navigate,
}));

vi.mock("~/rpc/useSourceControl", async (importOriginal) => {
  const { createSourceControlRpcMock } =
    await import("~/components/pullRequests/testing/sourceControlRpcMock");
  return createSourceControlRpcMock(await importOriginal());
});

vi.mock("~/rpc/useGit", async (importOriginal) => {
  const { createUseGitMock } =
    await import("~/components/pullRequests/create/createPullRequestGitMock");
  return createUseGitMock(await importOriginal());
});

import type { ChangeRequestHostCapabilities } from "@ryco/shared/sourceControl";

import { toastManager } from "~/components/ui/toast";
import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "~/environmentApi";
import { buildPullRequestLocation } from "~/pullRequestsRoute";

import { PullRequestListPane } from "../list/PullRequestListPane";
import {
  FIXTURE_CWD,
  FIXTURE_ENVIRONMENT_ID,
  FIXTURE_NOW_MS,
  PullRequestsTestProvider,
  fixtureRepositoryOption,
  pullRequestsTestNavLog,
  resetPullRequestsTestState,
  sourceControlRpcMock,
} from "../testing/PullRequestsTestProvider";
import { CreatePullRequestDialogHost } from "./CreatePullRequestDialogHost";
import {
  createPullRequestEnvironmentApi,
  createPullRequestGitMock,
  fixtureGitStatus,
  FIXTURE_CURRENT_BRANCH,
} from "./createPullRequestGitMock";
import { useCreatePullRequestDialogStore } from "./createPullRequestDialogStore";

const toasts: Array<{ readonly title: unknown; readonly type?: string | undefined }> = [];

beforeEach(async () => {
  vi.setSystemTime(FIXTURE_NOW_MS);
  await page.viewport(1100, 800);
  toasts.length = 0;
  vi.spyOn(toastManager, "add").mockImplementation((options) => {
    toasts.push({ title: options.title, type: options.type });
    return "toast";
  });
  __setEnvironmentApiOverrideForTests(FIXTURE_ENVIRONMENT_ID, createPullRequestEnvironmentApi());
});

afterEach(() => {
  vi.restoreAllMocks();
  resetPullRequestsTestState();
  createPullRequestGitMock.reset();
  __resetEnvironmentApiOverridesForTests();
  routerMock.navigate.mockClear();
  useCreatePullRequestDialogStore.setState({ open: false, request: null });
});

const CREATE_ONLY_DRAFTLESS: Partial<ChangeRequestHostCapabilities> = {
  create: { supported: true, draft: false },
};

async function renderList(
  input: {
    readonly host?: "github" | "gitlab" | "unknown";
    readonly capabilities?: Partial<ChangeRequestHostCapabilities>;
  } = {},
) {
  return render(
    <PullRequestsTestProvider
      width={1100}
      host={input.host}
      capabilities={input.capabilities}
      className="flex-row"
    >
      <aside className="flex min-h-0 w-[304px] shrink-0 flex-col border-r">
        <PullRequestListPane variant="docked" />
      </aside>
    </PullRequestsTestProvider>,
  );
}

function dialog() {
  return page.getByRole("dialog");
}

async function openDialog(
  screen: Awaited<ReturnType<typeof renderList>>,
  name = "New pull request",
) {
  await userEvent.click(screen.getByRole("button", { name }));
  await expect.element(dialog()).toBeVisible();
}

async function pickBranch(side: "Head branch" | "Base branch", refName: string) {
  await userEvent.click(page.getByLabelText(new RegExp(`^${side}:`, "u")));
  await userEvent.click(page.getByRole("option", { name: new RegExp(`^${refName}`, "u") }));
}

describe("New pull request from the list header", () => {
  it("opens from the checkout's branch into the default one and creates with ⌘↵", async () => {
    const screen = await renderList();
    await openDialog(screen);
    await expect.element(dialog().getByText("ryco", { exact: true })).toBeVisible();
    await expect
      .element(page.getByLabelText(/^Head branch:/u))
      .toHaveAccessibleName(`Head branch: ${FIXTURE_CURRENT_BRANCH}`);
    await expect
      .element(page.getByLabelText(/^Base branch:/u))
      .toHaveAccessibleName("Base branch: main");
    const create = dialog().getByRole("button", { name: /^Create/u });
    // The title is the only gap, and it starts focused.
    await expect.element(create).toBeDisabled();
    await expect.element(dialog().getByLabelText("Title")).toHaveFocus();

    await userEvent.type(dialog().getByLabelText("Title"), "Add the create dialog");
    await userEvent.type(dialog().getByLabelText("Description"), "Opens pull requests from Ryco.");
    await userEvent.click(dialog().getByRole("checkbox"));
    await expect.element(create).toHaveAccessibleName("Create draft");
    await userEvent.keyboard("{Meta>}{Enter}{/Meta}");

    await expect.element(dialog()).not.toBeInTheDocument();
    expect(sourceControlRpcMock.callsTo("useCreateChangeRequestMutation")).toEqual([
      {
        hook: "useCreateChangeRequestMutation",
        target: { environmentId: FIXTURE_ENVIRONMENT_ID },
        args: {
          cwd: FIXTURE_CWD,
          baseRefName: "main",
          headRefName: FIXTURE_CURRENT_BRANCH,
          title: "Add the create dialog",
          body: "Opens pull requests from Ryco.",
          draft: true,
        },
      },
    ]);
    expect(toasts).toEqual([{ title: "Pull request #800 opened", type: "success" }]);
    expect(pullRequestsTestNavLog.callsTo("selectPullRequest").at(-1)?.args).toEqual([
      800,
      { push: true },
    ]);
  });

  it("is hidden where the host can't open change requests", async () => {
    const screen = await renderList({
      capabilities: { create: { supported: false, draft: false } },
    });
    await expect
      .element(screen.getByRole("button", { name: "Filter pull requests" }))
      .toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "New pull request" }))
      .not.toBeInTheDocument();
  });

  it("speaks the host's language and offers drafts only where it has them", async () => {
    const screen = await renderList({ host: "gitlab", capabilities: CREATE_ONLY_DRAFTLESS });
    await openDialog(screen, "New merge request");
    await expect
      .element(dialog().getByRole("heading", { name: "New merge request" }))
      .toBeVisible();
    await expect.element(dialog().getByRole("checkbox")).not.toBeInTheDocument();
    await expect
      .element(dialog().getByRole("button", { name: /^Create/u }))
      .toHaveAccessibleName("Create");
  });

  it("explains an unpushed current branch and offers nothing but a re-check", async () => {
    createPullRequestGitMock.status = fixtureGitStatus({ hasUpstream: false, aheadCount: 3 });
    const screen = await renderList();
    await openDialog(screen);
    await userEvent.type(dialog().getByLabelText("Title"), "Add the create dialog");
    await expect
      .element(dialog().getByRole("status"))
      .toMatchTextContent(
        `${FIXTURE_CURRENT_BRANCH} isn't on origin yet. Push it, then open the pull request.`,
      );
    await expect.element(dialog().getByRole("button", { name: /^Create/u })).toBeDisabled();
    await expect.element(dialog().getByRole("button", { name: "Check again" })).toBeVisible();
    await expect.element(dialog().getByRole("button", { name: /push/iu })).not.toBeInTheDocument();
  });

  it("notes local commits the remote lacks without blocking", async () => {
    createPullRequestGitMock.status = fixtureGitStatus({ aheadCount: 2 });
    const screen = await renderList();
    await openDialog(screen);
    await userEvent.type(dialog().getByLabelText("Title"), "Add the create dialog");
    await expect
      .element(dialog().getByRole("status"))
      .toMatchTextContent("2 local commits aren't on origin yet");
    await expect.element(dialog().getByRole("button", { name: /^Create/u })).toBeEnabled();
  });

  it("checks origin for another local branch, and re-checks on request", async () => {
    const screen = await renderList();
    await openDialog(screen);
    await userEvent.type(dialog().getByLabelText("Title"), "Local work");
    await pickBranch("Head branch", "ryco/local-only");
    await expect
      .element(dialog().getByRole("status"))
      .toMatchTextContent("ryco/local-only isn't on origin yet.");
    expect(createPullRequestGitMock.listRefsCalls.at(-1)).toMatchObject({
      cwd: FIXTURE_CWD,
      originOnly: true,
      query: "origin/ryco/local-only",
    });

    // Pushed elsewhere (a terminal): "Check again" picks it up.
    createPullRequestGitMock.originBranches.add("ryco/local-only");
    await userEvent.click(dialog().getByRole("button", { name: "Check again" }));
    await expect.element(dialog().getByRole("status")).not.toBeInTheDocument();
    await expect.element(dialog().getByRole("button", { name: /^Create/u })).toBeEnabled();
  });

  it("opens a remote-only head under its host name without a lookup", async () => {
    const screen = await renderList();
    await openDialog(screen);
    await userEvent.type(dialog().getByLabelText("Title"), "Release notes");
    await pickBranch("Head branch", "origin/release/2026.10");
    await expect
      .element(page.getByLabelText(/^Head branch:/u))
      .toHaveAccessibleName("Head branch: release/2026.10");
    await userEvent.click(dialog().getByRole("button", { name: /^Create/u }));
    expect(sourceControlRpcMock.callsTo("useCreateChangeRequestMutation")[0]?.args).toMatchObject({
      headRefName: "release/2026.10",
      baseRefName: "main",
    });
    expect(createPullRequestGitMock.listRefsCalls).toEqual([]);
  });

  it("refuses the same branch on both sides", async () => {
    const screen = await renderList();
    await openDialog(screen);
    await userEvent.type(dialog().getByLabelText("Title"), "Oops");
    await pickBranch("Base branch", FIXTURE_CURRENT_BRANCH);
    await expect
      .element(dialog().getByRole("status"))
      .toHaveTextContent(`The pull request needs a base other than ${FIXTURE_CURRENT_BRANCH}.`);
    await expect.element(dialog().getByRole("button", { name: /^Create/u })).toBeDisabled();
  });

  it("points at a request that is already open between the branches", async () => {
    const screen = await renderList();
    await openDialog(screen);
    await pickBranch("Head branch", "mvogt/pr-diff-virtualization");
    await expect
      .element(dialog().getByRole("status"))
      .toMatchTextContent("#712 is already open from mvogt/pr-diff-virtualization.");
    await userEvent.click(dialog().getByRole("button", { name: "Open", exact: true }));
    await expect.element(dialog()).not.toBeInTheDocument();
    expect(pullRequestsTestNavLog.callsTo("selectPullRequest").at(-1)?.args).toEqual([
      712,
      { push: true },
    ]);
  });

  it("keeps the dialog and the text when the host refuses", async () => {
    sourceControlRpcMock.mutationOverrides.useCreateChangeRequestMutation = async () => {
      throw new Error("No commits between main and ryco/create-pr-dialog.");
    };
    const screen = await renderList();
    await openDialog(screen);
    await userEvent.type(dialog().getByLabelText("Title"), "Add the create dialog");
    await userEvent.click(dialog().getByRole("button", { name: /^Create/u }));
    await expect
      .element(dialog().getByRole("alert"))
      .toMatchTextContent("No commits between main and ryco/create-pr-dialog.");
    await expect.element(dialog().getByLabelText("Title")).toHaveValue("Add the create dialog");
    expect(toasts).toEqual([]);
    expect(pullRequestsTestNavLog.callsTo("selectPullRequest")).toEqual([]);
  });
});

describe("New pull request from the palette", () => {
  const request = {
    environmentId: FIXTURE_ENVIRONMENT_ID,
    projectId: fixtureRepositoryOption.projectId,
    cwd: FIXTURE_CWD,
    repositoryName: "ryco",
  };

  it("reads the host from git status and opens the created request on the page", async () => {
    await render(<CreatePullRequestDialogHost />);
    useCreatePullRequestDialogStore.getState().openFor(request);
    await expect.element(dialog().getByRole("heading", { name: "New pull request" })).toBeVisible();
    // GitHub (from git status) has drafts.
    await expect.element(dialog().getByRole("checkbox")).toBeVisible();
    await userEvent.type(dialog().getByLabelText("Title"), "From the palette");
    await userEvent.click(dialog().getByRole("button", { name: /^Create/u }));
    await expect.element(dialog()).not.toBeInTheDocument();
    expect(routerMock.navigate).toHaveBeenCalledWith(
      buildPullRequestLocation({
        environmentId: request.environmentId,
        projectId: request.projectId,
        number: 800,
      }),
    );
  });

  it("waits for git status before judging the host", async () => {
    createPullRequestGitMock.status = null;
    createPullRequestGitMock.statusPending = true;
    await render(<CreatePullRequestDialogHost />);
    useCreatePullRequestDialogStore.getState().openFor(request);
    await expect.element(dialog().getByLabelText("Title")).toBeVisible();
    await expect.element(dialog().getByText(/does not support/u)).not.toBeInTheDocument();
  });

  it("says so where the checkout's host can't open change requests", async () => {
    createPullRequestGitMock.status = fixtureGitStatus({
      sourceControlProvider: { kind: "unknown", name: "git", baseUrl: "" },
    });
    await render(<CreatePullRequestDialogHost />);
    useCreatePullRequestDialogStore.getState().openFor(request);
    await expect
      .element(
        dialog().getByText(
          "This source control provider does not support opening change requests.",
        ),
      )
      .toBeVisible();
    await expect.element(dialog().getByLabelText("Title")).not.toBeInTheDocument();
  });
});
