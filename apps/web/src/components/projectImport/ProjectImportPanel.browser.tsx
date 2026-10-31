import "../../index.css";
import { page } from "vite-plus/test/browser";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type SessionImportCandidate,
  type SessionImportDiscoverInput,
  type SessionImportInput,
} from "@ryco/contracts";

import { ProjectImportPanel } from "./ProjectImportPanel";

const CODEX_STORE = "c".repeat(64);
const CLAUDE_STORE = "d".repeat(64);

const harness = vi.hoisted(() => ({
  sources: vi.fn(),
  discover: vi.fn(),
  run: vi.fn(),
  createProject: vi.fn(),
  allowed: true,
}));

function item(
  key: string,
  overrides: Partial<SessionImportCandidate> & Pick<SessionImportCandidate, "title">,
): SessionImportCandidate {
  return {
    key: key.repeat(64),
    source: "codex",
    cwd: "",
    canonicalCwd: null,
    archived: false,
    messageCount: 4,
    importedThreadId: null,
    quarantined: false,
    ...overrides,
  };
}

const viaLink = item("a", {
  title: "Linked app chat",
  cwd: "/home/me/link-to-app",
  canonicalCwd: "/work/app",
});
const direct = item("b", { title: "Direct app chat", cwd: "/work/app", canonicalCwd: "/work/app" });
const imported = item("e", {
  title: "Imported app chat",
  cwd: "/work/app",
  canonicalCwd: "/work/app",
  importedThreadId: ThreadId.make("earlier-thread"),
});
const inRepo = item("1", {
  title: "Repo chat",
  cwd: "/work/repo/src",
  canonicalCwd: "/work/repo/src",
});
const claudeApp = item("2", {
  source: "claudeAgent",
  title: "Claude app chat",
  cwd: "/work/app",
  canonicalCwd: "/work/app",
});
const gone = item("3", {
  source: "claudeAgent",
  title: "Deleted folder chat",
  cwd: "/deleted/worktree",
  canonicalCwd: null,
});

function FixturePanel() {
  return (
    <ProjectImportPanel
      nodeLabel="Fixture node"
      allowed={harness.allowed}
      canCreateProjects
      projects={[{ id: ProjectId.make("repo"), name: "Repo project", workspaceRoot: "/work/repo" }]}
      providerOptions={[
        {
          instanceId: ProviderInstanceId.make("codex"),
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          installed: true,
          displayName: "Fixture Codex",
          models: [
            {
              slug: "codex-model",
              name: "Codex model",
              isDefault: true,
              isCustom: false,
              capabilities: null,
            },
          ],
        },
        {
          instanceId: ProviderInstanceId.make("claude"),
          driver: ProviderDriverKind.make("claudeAgent"),
          enabled: true,
          installed: true,
          displayName: "Fixture Claude",
          models: [
            { slug: "claude-model", name: "Claude model", isCustom: false, capabilities: null },
          ],
        },
      ]}
      client={() => ({ sources: harness.sources, discover: harness.discover, run: harness.run })}
      createProject={harness.createProject}
    />
  );
}

async function chooseOption(label: string, option: string) {
  await page.getByLabelText(label, { exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

beforeEach(() => {
  vi.clearAllMocks();
  harness.allowed = true;
  harness.sources.mockImplementation(async ({ source }: { source: string }) => [
    source === "codex"
      ? { key: CODEX_STORE, label: "Default store", isDefault: true, instanceIds: ["codex"] }
      : { key: CLAUDE_STORE, label: "Default store", isDefault: true, instanceIds: ["claude"] },
  ]);
  harness.discover.mockImplementation(async (input: SessionImportDiscoverInput) =>
    input.source === "codex"
      ? input.offset === 0
        ? { items: [viaLink, direct], nextOffset: 2, notices: [] }
        : { items: [imported, inRepo], nextOffset: null, notices: [] }
      : { items: [claudeApp, gone], nextOffset: null, notices: [] },
  );
  harness.createProject.mockResolvedValue(ProjectId.make("created-app"));
  harness.run.mockImplementation(async (input: SessionImportInput) => ({
    threadId: ThreadId.make(`thread-${input.key.slice(0, 1)}`),
    alreadyImported: false,
  }));
});

describe("project import", () => {
  it("groups both sources by folder, creates the missing project once, imports into the mapped projects and retries only failures", async () => {
    let claudeBusy = true;
    harness.run.mockImplementation(async (input: SessionImportInput) => {
      if (input.key === claudeApp.key && claudeBusy) {
        claudeBusy = false;
        throw new Error("Claude is busy");
      }
      return { threadId: ThreadId.make(`thread-${input.key.slice(0, 1)}`), alreadyImported: false };
    });
    render(<FixturePanel />);

    await page.getByRole("button", { name: "Find projects" }).click();

    // Every page of both stores is read.
    await expect.element(page.getByText("3 folders · 6 conversations")).toBeVisible();
    expect(harness.discover.mock.calls.map(([input]) => [input.source, input.offset])).toEqual([
      ["codex", 0],
      ["codex", 2],
      ["claudeAgent", 0],
    ]);
    // A link and the real folder, from Codex and Claude Code, are one group with a new project.
    await expect
      .element(page.getByLabelText("Destination for app", { exact: true }))
      .toMatchTextContent("New project “app”");
    // A folder inside an existing project goes to that project.
    await expect
      .element(page.getByLabelText("Destination for src", { exact: true }))
      .toMatchTextContent("Repo project");
    // A folder that is gone needs a destination picked by hand.
    await expect.element(page.getByText("Folder gone")).toBeVisible();
    await expect
      .element(page.getByLabelText("Destination for worktree", { exact: true }))
      .toMatchTextContent("Choose a project");

    await page.getByLabelText("Select app", { exact: true }).click();
    await page.getByLabelText("Select worktree", { exact: true }).click();
    await expect.element(page.getByText("Choose a project for 1 conversation.")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Import selected" })).toBeDisabled();
    await chooseOption("Destination for worktree", "Repo project");
    await expect.element(page.getByText("4 conversations selected, 1 new project.")).toBeVisible();

    await page.getByRole("button", { name: "Import selected" }).click();

    await expect.element(page.getByText("Imported 3, 1 failed.")).toBeVisible();
    expect(harness.createProject.mock.calls).toEqual([["/work/app"]]);
    expect(
      harness.run.mock.calls.map(([input]) => [
        input.key,
        input.projectId,
        input.storeKey,
        input.modelSelection,
      ]),
    ).toEqual([
      [viaLink.key, "created-app", CODEX_STORE, { instanceId: "codex", model: "codex-model" }],
      [direct.key, "created-app", CODEX_STORE, { instanceId: "codex", model: "codex-model" }],
      [claudeApp.key, "created-app", CLAUDE_STORE, { instanceId: "claude", model: "claude-model" }],
      [gone.key, "repo", CLAUDE_STORE, { instanceId: "claude", model: "claude-model" }],
    ]);
    await expect.element(page.getByText("1 failed", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "4 conversations", exact: true }).click();
    await expect.element(page.getByText("· Claude is busy")).toBeVisible();
    await expect.element(page.getByText("· Already imported")).toBeVisible();

    await page.getByRole("button", { name: "Retry failed" }).click();

    await expect.element(page.getByText("Imported 1.")).toBeVisible();
    expect(harness.run.mock.calls.slice(4).map(([input]) => [input.key, input.projectId])).toEqual([
      [claudeApp.key, "created-app"],
    ]);
    expect(harness.createProject).toHaveBeenCalledTimes(1);
    await expect
      .element(page.getByRole("button", { name: "Retry failed" }))
      .not.toBeInTheDocument();
  });

  it("stops after the conversation in progress", async () => {
    let finish!: () => void;
    harness.run.mockImplementationOnce(
      (input: SessionImportInput) =>
        new Promise((resolve) => {
          finish = () =>
            resolve({ threadId: ThreadId.make(`thread-${input.key}`), alreadyImported: false });
        }),
    );
    render(<FixturePanel />);
    await page.getByRole("button", { name: "Find projects" }).click();
    await page.getByLabelText("Select app", { exact: true }).click();
    await page.getByRole("button", { name: "Import selected" }).click();
    await expect.poll(() => harness.run.mock.calls.length).toBe(1);

    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect
      .element(page.getByRole("button", { name: "Stopping after this one…" }))
      .toBeDisabled();
    finish();

    await expect.element(page.getByText("Stopped. Imported 1.")).toBeVisible();
    expect(harness.run).toHaveBeenCalledTimes(1);
  });

  it("reads nothing until owner access is current", async () => {
    harness.allowed = false;
    render(<FixturePanel />);
    await expect
      .element(page.getByText("Reconnect to Fixture node with owner access to import its history."))
      .toBeVisible();
    await expect.element(page.getByRole("button", { name: "Find projects" })).toBeDisabled();
    expect(harness.sources).not.toHaveBeenCalled();
  });
});
