import "../../index.css";
// The feature stylesheet loads with its page or dialog chunk in the app.
import "./pullRequests.css";

import {
  EnvironmentId,
  ProjectId,
  type ChangeRequest,
  type ChangeRequestInvolvement,
  type SourceControlInvolvedChangeRequestsResult,
} from "@ryco/contracts";
import { DateTime, Option } from "effect";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

vi.mock("~/rpc/useSourceControl", async (importOriginal) => {
  const { createSourceControlRpcMock } =
    await import("~/components/pullRequests/testing/sourceControlRpcMock");
  return createSourceControlRpcMock(await importOriginal());
});

import { projectCheckoutKey, type ProjectCheckoutOption } from "../../projectCheckouts.logic";
import type { CrossRepositoryNote } from "./crossRepository/crossRepositoryList.logic";
import { ListResizeHandle, PullRequestListPane } from "./list/PullRequestListPane";
import type { PullRequestsSearch } from "./pullRequestsSearch";
import {
  FIXTURE_ENVIRONMENT_ID,
  FIXTURE_NOW_MS,
  PullRequestsTestProvider,
  buildTestCrossRepositoryRows,
  fixtureRepositoryOption,
  resetPullRequestsTestState,
} from "./testing/PullRequestsTestProvider";

afterEach(() => resetPullRequestsTestState());

const BUILD = EnvironmentId.make("env-fixture-build");

const apiOption: ProjectCheckoutOption = {
  key: projectCheckoutKey(BUILD, "project-api"),
  environmentId: BUILD,
  projectId: ProjectId.make("project-api"),
  cwd: "/srv/api",
  name: "api",
  environmentLabel: "Build box",
  customAvatarContentHash: null,
  repositoryKey: "github.com/ryco-labs/api",
  isRepresentative: true,
  repositoryRemoteUrl: "git@github.com:ryco-labs/api.git",
  repositoryProvider: "github",
};

const repositories = [fixtureRepositoryOption, apiOption];

function entry(
  repositoryKey: string,
  number: number,
  involvements: ReadonlyArray<ChangeRequestInvolvement>,
  overrides: Partial<ChangeRequest> = {},
) {
  return {
    changeRequest: {
      provider: "github",
      number,
      title: `${repositoryKey.split("/").at(-1)} change ${number}`,
      url: `https://${repositoryKey}/pull/${number}`,
      baseRefName: "main",
      headRefName: `feature/${number}`,
      state: "open",
      updatedAt: Option.some(DateTime.makeUnsafe(FIXTURE_NOW_MS - number * 60_000)),
      author: "sak0a",
      ...overrides,
    } satisfies ChangeRequest,
    repositoryKey,
    repositoryLabel: repositoryKey.slice(repositoryKey.indexOf("/") + 1),
    involvements,
  };
}

function answer(
  entries: SourceControlInvolvedChangeRequestsResult["entries"],
): SourceControlInvolvedChangeRequestsResult {
  return { entries, sources: [], skippedCwds: [], truncated: false };
}

const rows = buildTestCrossRepositoryRows(
  [
    {
      environmentId: FIXTURE_ENVIRONMENT_ID,
      result: answer([
        entry("github.com/ryco-labs/ryco", 703, ["review-requested"], { author: "anouk-d" }),
        entry("github.com/ryco-labs/api", 12, ["authored"]),
        entry("github.com/acme/elsewhere", 5, ["review-requested"], { author: "octo" }),
      ]),
    },
    {
      environmentId: BUILD,
      result: answer([
        entry("github.com/ryco-labs/api", 12, ["authored"]),
        entry("github.com/ryco-labs/ryco", 709, ["authored"]),
      ]),
    },
  ],
  repositories,
);

const notes: ReadonlyArray<CrossRepositoryNote> = [
  {
    kind: "source-failed",
    environmentLabel: "Build box",
    name: "acme/tools",
    message: "glab is not installed.",
  },
  { kind: "environment-outdated", environmentLabel: "M4" },
  { kind: "hidden", count: 1 },
];

function rowButton(rowKey: string): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(
    `[data-pr-row-button="${CSS.escape(rowKey)}"]`,
  );
  if (!button) throw new Error(`row ${rowKey} is not rendered`);
  return button;
}

async function renderList(input: {
  readonly search?: Partial<PullRequestsSearch>;
  readonly onSearchChange?: (search: PullRequestsSearch) => void;
  readonly refresh?: () => void;
}) {
  vi.setSystemTime(FIXTURE_NOW_MS);
  await page.viewport(1100, 860);
  return render(
    <PullRequestsTestProvider
      search={input.search}
      width={1100}
      height={860}
      onSearchChange={input.onSearchChange}
      crossRepository={{ repositories, rows, notes, refresh: input.refresh }}
      className="flex-row"
    >
      <aside className="flex min-h-0 w-[304px] shrink-0 flex-col border-r">
        <PullRequestListPane variant="docked" />
      </aside>
      <ListResizeHandle />
    </PullRequestsTestProvider>,
  );
}

describe("Pull requests — All repositories", () => {
  it("offers All repositories first in the switcher and opens it", async () => {
    const changes: PullRequestsSearch[] = [];
    const screen = await renderList({ onSearchChange: (search) => changes.push(search) });
    await userEvent.click(screen.getByRole("combobox", { name: "Repository: ryco" }));
    const options = screen.getByRole("option");
    await expect.element(options.first()).toBeVisible();
    expect(options.first().element().textContent).toMatch(/^All repositories/u);
    await userEvent.click(options.first());
    expect(changes.at(-1)).toEqual({ scope: "all" });
    await expect
      .element(screen.getByRole("combobox", { name: "Repository: All repositories" }))
      .toBeVisible();
    await expect.element(screen.getByText("ryco-labs/api")).toBeVisible();
  });

  it("lists rows from every repository and node in the involvement groups", async () => {
    const screen = await renderList({
      search: { scope: "all", env: undefined, project: undefined },
    });
    await expect.element(screen.getByRole("button", { name: /^Needs your review/u })).toBeVisible();
    await expect.element(screen.getByRole("button", { name: /^Yours/u })).toBeVisible();
    // The same pull request from two nodes is one row; numbers repeat across repositories.
    expect(
      document.querySelectorAll('[data-pr-row-button="github.com/ryco-labs/api#12"]'),
    ).toHaveLength(1);
    expect(rowButton("github.com/ryco-labs/api#12").getAttribute("aria-label")).toContain(
      "ryco-labs/api #12",
    );
    // A repository not in Ryco is left out and counted.
    expect(document.querySelector('[data-pr-row-button="github.com/acme/elsewhere#5"]')).toBeNull();
    await expect
      .element(screen.getByText("1 more in repositories not added to Ryco"))
      .toBeVisible();
  });

  it("opens a row through its checkout and stays in All repositories", async () => {
    const changes: PullRequestsSearch[] = [];
    await renderList({
      search: { scope: "all", env: undefined, project: undefined },
      onSearchChange: (search) => changes.push(search),
    });
    await userEvent.click(rowButton("github.com/ryco-labs/api#12"));
    expect(changes.at(-1)).toEqual({
      scope: "all",
      env: BUILD,
      project: "project-api",
      pr: 12,
    });
    await expect
      .element(rowButton("github.com/ryco-labs/api#12"))
      .toHaveAttribute("aria-current", "true");
  });

  it("moves J across repositories", async () => {
    const changes: PullRequestsSearch[] = [];
    await renderList({
      search: {
        scope: "all",
        env: FIXTURE_ENVIRONMENT_ID,
        project: fixtureRepositoryOption.projectId,
        pr: 703,
      },
      onSearchChange: (search) => changes.push(search),
    });
    await expect
      .element(rowButton("github.com/ryco-labs/ryco#703"))
      .toHaveAttribute("aria-current", "true");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
    expect(changes.at(-1)).toMatchObject({
      scope: "all",
      env: BUILD,
      project: "project-api",
      pr: 12,
    });
  });

  it("says what it could not read, keeps the other rows, and refreshes on request", async () => {
    const refresh = vi.fn();
    const screen = await renderList({ search: { scope: "all" }, refresh });
    await expect
      .element(screen.getByText("Couldn’t read acme/tools on Build box: glab is not installed."))
      .toBeVisible();
    await expect
      .element(screen.getByText("Update Ryco on M4 to include its repositories"))
      .toBeVisible();
    expect(rowButton("github.com/ryco-labs/ryco#709")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("leaves one repository's list as it was", async () => {
    const screen = await renderList({ search: {} });
    await expect.element(screen.getByRole("combobox", { name: "Repository: ryco" })).toBeVisible();
    expect(document.querySelector('[data-pr-row-button="703"]')).not.toBeNull();
    expect(screen.getByRole("button", { name: "Refresh" }).query()).toBeNull();
  });
});
