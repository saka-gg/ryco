import "~/index.css";
// The feature stylesheet loads with its page or dialog chunk in the app.
import "../pullRequests.css";

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

import { recordWsConnectionOpened, resetWsConnectionStateForTests } from "@ryco/client-runtime/rpc";
import type {
  ChangeRequestTemplate,
  ChangeRequestTemplateListResult,
  ServerConfig,
} from "@ryco/contracts";
import type { ChangeRequestHostCapabilities } from "@ryco/shared/changeRequestHostCapabilities";

import { toastManager } from "~/components/ui/toast";
import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "~/environmentApi";
import {
  resetSavedEnvironmentRuntimeStoreForTests,
  useSavedEnvironmentRuntimeStore,
} from "~/environments/runtime";
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
  resetSavedEnvironmentRuntimeStoreForTests();
  resetWsConnectionStateForTests();
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

describe("Repository templates in the description", () => {
  const template = (
    path: string,
    body: string,
    extra: Partial<ChangeRequestTemplate> = {},
  ): ChangeRequestTemplate => ({
    path,
    name: path.slice(path.lastIndexOf("/") + 1).replace(/\.md$/u, ""),
    isDefault: false,
    body,
    truncated: false,
    ...extra,
  });
  const DEFAULT_TEMPLATE = template(".github/pull_request_template.md", "## What changed", {
    name: "Default",
    isDefault: true,
  });
  const BUG = template(".github/PULL_REQUEST_TEMPLATE/bug.md", "## Bug\n\n## Fix");
  const FEATURE = template(".github/PULL_REQUEST_TEMPLATE/feature.md", "## Feature", {
    truncated: true,
  });

  /** A base tree's templates and the one the server says a generated description follows. */
  const listing = (
    templates: ReadonlyArray<ChangeRequestTemplate>,
    follows: ChangeRequestTemplate | null = null,
  ): ChangeRequestTemplateListResult => ({
    templates,
    generationTemplatePath: follows?.path ?? null,
  });

  /** The node behind the fixture environment: whether it reads templates, and the setting. */
  function nodeConfig(input: { readonly capability?: boolean; readonly setting?: boolean } = {}) {
    useSavedEnvironmentRuntimeStore.getState().patch(FIXTURE_ENVIRONMENT_ID, {
      serverConfig: {
        environment: {
          capabilities: input.capability === false ? {} : { changeRequestTemplates: true },
        },
        settings: { pullRequestTemplates: input.setting ?? true },
      } as unknown as ServerConfig,
    });
  }

  const description = () => dialog().getByLabelText("Description");
  const picker = () => dialog().getByRole("combobox", { name: /^Template:/u });
  const option = (name: string) => page.getByRole("option", { name, exact: true });

  it("starts from the default template and swaps templates until the text is edited", async () => {
    nodeConfig();
    createPullRequestGitMock.templatesByBase.set(
      "main",
      listing([DEFAULT_TEMPLATE, BUG, FEATURE], DEFAULT_TEMPLATE),
    );
    const screen = await renderList();
    await openDialog(screen);

    await expect.element(description()).toHaveValue("## What changed");
    await expect.element(picker()).toHaveAccessibleName("Template: Default");
    expect(createPullRequestGitMock.listTemplatesCalls).toEqual([
      { cwd: FIXTURE_CWD, baseRefName: "main" },
    ]);

    await userEvent.click(picker());
    await expect.element(option("No template")).toBeVisible();
    await expect.element(option("Default")).toHaveAttribute("aria-selected", "true");
    await expect.element(option("feature (shortened)")).toBeVisible();
    await userEvent.click(option("bug"));
    await expect.element(description()).toHaveValue("## Bug\n\n## Fix");
    await expect.element(picker()).toHaveAccessibleName("Template: bug");

    // Editing the text locks the picker, so a switch never throws away what was written.
    await userEvent.fill(description(), "## Bug\n\n## Fix\nFixes the login loop.");
    await expect.element(picker()).toBeDisabled();
    await expect
      .element(dialog().getByTitle("Clear the description to switch templates"))
      .toBeVisible();
    await userEvent.clear(description());
    await expect.element(picker()).toBeEnabled();
    await expect.element(picker()).toHaveAccessibleName("Template: No template");

    await userEvent.type(dialog().getByLabelText("Title"), "Fix the login loop");
    await userEvent.click(picker());
    await userEvent.click(option("Default"));
    await userEvent.click(dialog().getByRole("button", { name: /^Create/u }));
    await expect.element(dialog()).not.toBeInTheDocument();
    expect(sourceControlRpcMock.callsTo("useCreateChangeRequestMutation")[0]?.args).toMatchObject({
      title: "Fix the login loop",
      body: "## What changed",
    });
  });

  it("leaves the description empty when there are several templates and no default", async () => {
    nodeConfig();
    createPullRequestGitMock.templatesByBase.set("main", listing([BUG, FEATURE]));
    const screen = await renderList();
    await openDialog(screen);

    await expect.element(picker()).toHaveAccessibleName("Template: No template");
    await expect.element(description()).toHaveValue("");
    await userEvent.click(picker());
    await userEvent.type(page.getByLabelText("Find a template"), "bu");
    await expect.element(option("feature (shortened)")).not.toBeInTheDocument();
    await userEvent.click(option("bug"));
    await expect.element(description()).toHaveValue("## Bug\n\n## Fix");
  });

  it("reads the new base's templates and swaps an untouched description", async () => {
    nodeConfig();
    createPullRequestGitMock.templatesByBase.set(
      "main",
      listing([DEFAULT_TEMPLATE], DEFAULT_TEMPLATE),
    );
    createPullRequestGitMock.templatesByBase.set("release/2026.10", listing([BUG], BUG));
    const screen = await renderList();
    await openDialog(screen);
    await expect.element(description()).toHaveValue("## What changed");

    await pickBranch("Base branch", "origin/release/2026.10");
    await expect.element(description()).toHaveValue("## Bug\n\n## Fix");
    expect(createPullRequestGitMock.listTemplatesCalls.at(-1)).toEqual({
      cwd: FIXTURE_CWD,
      baseRefName: "release/2026.10",
    });

    // Edited text stays when the base changes again.
    await userEvent.fill(description(), "## Bug\n\n## Fix\nDetails.");
    await pickBranch("Base branch", "main");
    await expect.element(description()).toHaveValue("## Bug\n\n## Fix\nDetails.");
  });

  it("drops an untouched template when the new base's templates cannot be read", async () => {
    nodeConfig();
    createPullRequestGitMock.templatesByBase.set(
      "main",
      listing([DEFAULT_TEMPLATE], DEFAULT_TEMPLATE),
    );
    createPullRequestGitMock.failingTemplateBases.add("release/2026.10");
    const screen = await renderList();
    await openDialog(screen);
    await expect.element(description()).toHaveValue("## What changed");

    await pickBranch("Base branch", "origin/release/2026.10");
    await expect.element(description()).toHaveValue("");
    await expect.element(picker()).not.toBeInTheDocument();
    expect(createPullRequestGitMock.listTemplatesCalls.at(-1)).toEqual({
      cwd: FIXTURE_CWD,
      baseRefName: "release/2026.10",
    });
  });

  it("lists a template the server does not follow without filling the description", async () => {
    // GitLab applies only default.md on its own, so a lone other template is offered, not used.
    const gitLabFeature = template(".gitlab/merge_request_templates/feature.md", "## Feature");
    nodeConfig();
    createPullRequestGitMock.templatesByBase.set("main", listing([gitLabFeature]));
    const screen = await renderList();
    await openDialog(screen);

    await expect.element(picker()).toHaveAccessibleName("Template: No template");
    await expect.element(description()).toHaveValue("");
    await userEvent.click(picker());
    await userEvent.click(option("feature"));
    await expect.element(description()).toHaveValue("## Feature");
  });

  it("reads the templates again once the connection comes back after a failed read", async () => {
    nodeConfig();
    createPullRequestGitMock.templatesByBase.set(
      "main",
      listing([DEFAULT_TEMPLATE], DEFAULT_TEMPLATE),
    );
    createPullRequestGitMock.failingTemplateBases.add("main");
    const screen = await renderList();
    await openDialog(screen);
    await expect.poll(() => createPullRequestGitMock.listTemplatesCalls.length).toBe(1);
    await expect.element(description()).toHaveValue("");
    await expect.element(picker()).not.toBeInTheDocument();

    createPullRequestGitMock.failingTemplateBases.delete("main");
    recordWsConnectionOpened({ environmentId: FIXTURE_ENVIRONMENT_ID });
    await expect.element(description()).toHaveValue("## What changed");
    await expect.element(picker()).toHaveAccessibleName("Template: Default");
    expect(createPullRequestGitMock.listTemplatesCalls).toHaveLength(2);
  });

  for (const off of [
    { name: "a node that cannot read templates", capability: false },
    { name: "the setting turned off", setting: false },
  ]) {
    it(`asks for nothing and shows no picker with ${off.name}`, async () => {
      nodeConfig(off);
      createPullRequestGitMock.templatesByBase.set(
        "main",
        listing([DEFAULT_TEMPLATE], DEFAULT_TEMPLATE),
      );
      const screen = await renderList();
      await openDialog(screen);
      await expect.element(dialog().getByLabelText("Title")).toBeVisible();
      await expect.element(description()).toHaveValue("");
      await expect.element(picker()).not.toBeInTheDocument();
      expect(createPullRequestGitMock.listTemplatesCalls).toEqual([]);
    });
  }
});
