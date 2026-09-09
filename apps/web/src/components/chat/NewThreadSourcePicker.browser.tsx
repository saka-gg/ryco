import "../../index.css";
import { EnvironmentId, ProjectId, type VcsListRefsInput } from "@ryco/contracts";
import { useState } from "react";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { NewThreadSourcePicker } from "./NewThreadSourcePicker";

const { listRefs, selectSource, changeName } = vi.hoisted(() => ({
  listRefs: vi.fn(),
  selectSource: vi.fn(),
  changeName: vi.fn(),
}));
vi.mock("../../environmentApi", () => {
  const readEnvironmentApi = () => ({ vcs: { listRefs } });
  return { readEnvironmentApi, ensureEnvironmentApi: readEnvironmentApi };
});

vi.mock("../projectExplorer/IssuesTab", () => ({ IssuesTab: () => null }));
vi.mock("../projectExplorer/PullRequestsTab", () => ({ PullRequestsTab: () => null }));
vi.mock("../projectExplorer/WorkItemsTab", () => ({ WorkItemsTab: () => null }));

function Picker() {
  const [fetchOrigin, setFetchOrigin] = useState(true);
  const [branchName, setBranchName] = useState<string | null>(null);
  return (
    <NewThreadSourcePicker
      label="origin/main"
      sourceKind="branch"
      environmentId={EnvironmentId.make("local")}
      projectId={ProjectId.make("project")}
      cwd="/repo"
      fetchOrigin={fetchOrigin}
      onFetchOriginChange={setFetchOrigin}
      branchName={branchName}
      onBranchNameChange={(name) => {
        setBranchName(name);
        changeName(name);
      }}
      onSelect={selectSource}
    />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  listRefs.mockImplementation(async (input: VcsListRefsInput) => ({
    refs: [
      {
        name: input.originOnly ? "origin/main" : "main",
        isRemote: input.originOnly,
        remoteName: input.originOnly ? "origin" : undefined,
        current: !input.originOnly,
        isDefault: true,
        worktreePath: null,
      },
    ],
    isRepo: true,
    hasPrimaryRemote: true,
    totalCount: 1,
    nextCursor: null,
  }));
});

it("fetches origin, switches to local branches, and selects the base", async () => {
  await render(<Picker />);
  await page.getByRole("button", { name: /Change what this worktree/ }).click();
  await expect.element(page.getByRole("switch", { name: "Fetch Origin" })).toBeChecked();
  await expect
    .poll(() => listRefs.mock.calls[0]?.[0])
    .toMatchObject({ fetchOrigin: true, originOnly: true });
  await expect
    .element(page.getByRole("button", { name: "origin/main origin", exact: true }))
    .toBeVisible();
  await page.getByRole("switch", { name: "Fetch Origin" }).click();
  await expect
    .element(page.getByRole("button", { name: "main current", exact: true }))
    .toBeVisible();
  expect(listRefs.mock.calls.at(-1)?.[0]).toMatchObject({ fetchOrigin: false, originOnly: false });
  await page.getByRole("button", { name: "main current", exact: true }).click();
  expect(selectSource).toHaveBeenCalledWith({ kind: "branch", branchName: "main" });
});

it("records a custom branch name and allows returning to automatic naming", async () => {
  await render(<Picker />);
  await page.getByRole("button", { name: /Change what this worktree/ }).click();
  await page.getByRole("button", { name: "Create a new branch" }).click();
  await page.getByRole("textbox", { name: "New branch name" }).fill("feature/custom");
  await page.getByRole("button", { name: "Use name" }).click();
  expect(changeName).toHaveBeenLastCalledWith("feature/custom");
  expect(selectSource).not.toHaveBeenCalled();
  await page.getByRole("button", { name: "Create a new branch" }).click();
  await page.getByRole("textbox", { name: "New branch name" }).fill("");
  await page.getByRole("button", { name: "Use name" }).click();
  expect(changeName).toHaveBeenLastCalledWith(null);
});

it("shows fetch errors and lets the user turn fetching off", async () => {
  listRefs.mockRejectedValueOnce(new Error("Origin unavailable"));
  await render(<Picker />);
  await page.getByRole("button", { name: /Change what this worktree/ }).click();
  await expect.element(page.getByRole("alert")).toHaveTextContent("Origin unavailable");
  await page.getByRole("switch", { name: "Fetch Origin" }).click();
  await expect
    .element(page.getByRole("button", { name: "main current", exact: true }))
    .toBeVisible();
});
