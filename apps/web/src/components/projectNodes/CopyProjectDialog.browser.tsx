import "../../index.css";

import {
  createProjectCopyJobRecord,
  reduceProjectCopyJobRecord,
  type ProjectCopyJobRecord,
  type ProjectCopyOutcome,
  type ProjectCopyProgress,
  type ProjectCopyRunPlan,
  type StartProjectCopyInput,
} from "@ryco/client-runtime/projectCopy";
import type { NodeCatalogEntry } from "@ryco/client-runtime/state/nodes";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  type EnvironmentApi,
  type ServerConfig,
} from "@ryco/contracts";
import {
  ProjectImportId,
  type NodePathHints,
  type ProjectDestinationPreview,
  type ProjectExportInspection,
  type ProjectImportSnapshot,
} from "@ryco/contracts/project-copy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "vitest-browser-react";

import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../environmentApi";
import { AppAtomRegistryProvider } from "../../rpc/atomRegistry";
import { resetProjectAtomsForTests } from "../../rpc/projectAtoms";
import { defaultQueryClient } from "../../rpc/queryClient";
import type { Project } from "../../types";
import {
  resetProjectCopyManagerForTests,
  setProjectCopyRuntimeForTests,
  startManagedProjectCopy,
  useProjectCopyStore,
  type ProjectCopyRuntime,
} from "./copyRuntime/copyManager";
import type { WebProjectCopyIo } from "./copyRuntime/webProjectCopyIo";
import { CopyProjectDialogView } from "./CopyProjectDialog";
import type { CopyProjectDialogRequest } from "./projectNodesDialogStore";
import type { CopyDialogServices } from "./useCopyProjectPlanning";

/* ───────── Nodes ───────── */

const LAPTOP = EnvironmentId.make("env-laptop");
const MINI = EnvironmentId.make("env-mini");
const HETZNER = EnvironmentId.make("env-hetzner");
const GAMING = EnvironmentId.make("env-gaming");
const SOURCE_ID = ProjectId.make("project-ryco-laptop");
const MINI_ID = ProjectId.make("project-ryco-mini");
const KEY = "github.com/sak0a/ryco";

function node(
  overrides: Partial<NodeCatalogEntry> & Pick<NodeCatalogEntry, "environmentId" | "label">,
) {
  return {
    isPrimary: false,
    isThisDevice: false,
    presence: "online",
    platformOs: "darwin",
    iconKind: null,
    canMutate: true,
    mutateBlockedReason: null,
    projectCopySupport: "yes",
    transport: "direct",
    lastSeenAt: null,
    ...overrides,
  } satisfies NodeCatalogEntry;
}

function nodes(overrides: Partial<Record<EnvironmentId, Partial<NodeCatalogEntry>>> = {}) {
  return [
    node({
      environmentId: LAPTOP,
      label: "MacBook Pro",
      isThisDevice: true,
      isPrimary: true,
      ...overrides[LAPTOP],
    }),
    node({ environmentId: MINI, label: "Mac mini", ...overrides[MINI] }),
    node({
      environmentId: HETZNER,
      label: "hetzner-build",
      platformOs: "linux",
      ...overrides[HETZNER],
    }),
    node({
      environmentId: GAMING,
      label: "Gaming PC",
      platformOs: "windows",
      presence: "offline",
      lastSeenAt: Date.now() - 2 * 60 * 60 * 1000,
      ...overrides[GAMING],
    }),
  ];
}

function project(environmentId: EnvironmentId, id: ProjectId, cwd: string): Project {
  return {
    id,
    environmentId,
    name: "ryco",
    cwd,
    repositoryIdentity: {
      canonicalKey: KEY,
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "git@github.com:sak0a/ryco.git",
      },
      provider: "github",
      owner: "sak0a",
      name: "ryco",
      rootPath: cwd,
    },
    defaultModelSelection: null,
    scripts: [
      {
        id: "setup",
        name: "Setup",
        command: "bun install --frozen-lockfile",
        icon: "configure",
        runOnWorktreeCreate: true,
      },
    ],
  } as unknown as Project;
}

const MEMBERS = [
  project(LAPTOP, SOURCE_ID, "/Users/me/Code/ryco"),
  project(MINI, MINI_ID, "/Users/me/dev/ryco"),
];

/* ───────── Node APIs ───────── */

const MAC_HINTS: NodePathHints = {
  homeDirectory: "/Users/me",
  pathSeparator: "/",
  defaultProjectDirectory: "/Users/me/Code",
  defaultProjectDirectorySource: "well-known",
  codeRoots: [{ path: "/Users/me/Code", source: "well-known", projectCount: 1 }],
  workspaceAccessRoot: null,
};
const LINUX_HINTS: NodePathHints = {
  homeDirectory: "/home/me",
  pathSeparator: "/",
  defaultProjectDirectory: "/home/me/Code",
  defaultProjectDirectorySource: "well-known",
  codeRoots: [{ path: "/home/me/Code", source: "well-known", projectCount: 0 }],
  workspaceAccessRoot: null,
};

function inspection(
  overrides: {
    readonly bundleBytes?: number;
    readonly headOnRemote?: boolean;
    readonly unpushed?: number;
    readonly changes?: number;
    readonly ignored?: ReadonlyArray<string>;
  } = {},
): ProjectExportInspection {
  return {
    projectId: SOURCE_ID,
    repository: {
      rootPath: "/Users/me/Code/ryco",
      isGitRepository: true,
      branch: "task/copy-clone",
      headOid: "a".repeat(40),
      isDetached: false,
      remotes: [{ name: "origin", url: "git@github.com:sak0a/ryco.git" }],
      primaryRemoteName: "origin",
      cloneRemoteName: "origin",
      canonicalKey: KEY,
      isShallow: false,
      hasSubmodules: false,
      usesLfs: false,
    },
    pushedState: {
      headOnRemote: overrides.headOnRemote ?? true,
      upstreamBranch: "origin/task/copy-clone",
      unpushedCommitCount: overrides.unpushed ?? 0,
    },
    workingTree: {
      trackedChangeCount: overrides.changes ?? 2,
      untrackedCount: 0,
      hasConflicts: false,
      ignoredCandidates: (overrides.ignored ?? []).map((path) => ({ path, byteLength: 120 })),
    },
    settings: {
      title: "ryco",
      scripts: [
        {
          id: "setup",
          name: "Setup",
          command: "bun install --frozen-lockfile",
          icon: "configure",
          runOnWorktreeCreate: true,
        },
      ],
      customSystemPrompt: null,
      preferredRemoteName: null,
      projectMetadataDir: ".ryco",
      hasCustomAvatar: false,
      overrides: {},
      relativeRootInRepository: "",
    },
    estimates: [
      {
        kind: "repository-bundle",
        estimatedBytes: overrides.bundleBytes ?? 38 * 1024 * 1024 - 8192,
        skippedReason: null,
      },
      (overrides.unpushed ?? 0) > 0
        ? { kind: "commits-bundle", estimatedBytes: 64 * 1024, skippedReason: null }
        : { kind: "commits-bundle", estimatedBytes: 0, skippedReason: "nothing unpushed" },
      { kind: "changes-patch", estimatedBytes: 4096, skippedReason: null },
    ],
  } as unknown as ProjectExportInspection;
}

/** Folders on hetzner-build; a value marks a git repository with that canonical key. */
type FakeFolders = Record<string, string | null>;

function preview(folders: FakeFolders, path: string): ProjectDestinationPreview {
  const resolved = path.replace(/\/+$/u, "");
  const exists = resolved in folders;
  const children = Object.keys(folders).some((other) => other.startsWith(`${resolved}/`));
  const key = folders[resolved] ?? null;
  let suggestedPath: string | null = null;
  if (exists) {
    for (let suffix = 2; suggestedPath === null; suffix += 1) {
      if (!(`${resolved}-${suffix}` in folders)) suggestedPath = `${resolved}-${suffix}`;
    }
  }
  return {
    resolvedPath: resolved,
    state: !exists
      ? "available"
      : key
        ? "is-git-repository"
        : children
          ? "exists-not-empty"
          : "exists-empty",
    existingProjectId: null,
    existingRepositoryCanonicalKey: key,
    suggestedPath,
    detail: null,
  };
}

function nodeApi(options: {
  readonly hints: NodePathHints;
  readonly folders?: FakeFolders | undefined;
  readonly inspection?: ProjectExportInspection | undefined;
  readonly reachable?: boolean | undefined;
}) {
  const folders = options.folders ?? {};
  const checkRemoteAccess = vi.fn(async () => ({
    reachable: options.reachable ?? true,
    alternateRemoteUrl: null,
    detail: options.reachable === false ? "Host key verification failed" : null,
  }));
  const previewDestination = vi.fn(async ({ path }: { path: string }) => preview(folders, path));
  const exportInspect = vi.fn(async () => options.inspection ?? inspection());
  const browse = vi.fn(async ({ partialPath }: { partialPath: string }) => {
    const directory = partialPath.replace(/\/+$/u, "") || "/";
    const entries = Object.keys(folders)
      .filter(
        (path) =>
          path.startsWith(`${directory}/`) && !path.slice(directory.length + 1).includes("/"),
      )
      .map((path) => ({ name: path.slice(directory.length + 1), fullPath: path }));
    return { parentPath: directory, entries };
  });
  const searchDirectories = vi.fn(async () => ({
    matches: [],
    roots: [],
    truncated: false,
    scannedDirectories: 0,
  }));
  const api = {
    filesystem: { browse, searchDirectories },
    projects: {
      pathHints: vi.fn(async () => options.hints),
      previewDestination,
      checkRemoteAccess,
      exportInspect,
    },
  } as unknown as EnvironmentApi;
  return { api, checkRemoteAccess, previewDestination, exportInspect };
}

/* ───────── Copy runtime ───────── */

interface FakeRun {
  readonly input: StartProjectCopyInput;
  record: ProjectCopyJobRecord;
  progress: ProjectCopyProgress;
  emit(patch: Partial<ProjectCopyProgress>): void;
  settle(patch: Partial<ProjectCopyProgress>, project?: ProjectCopyOutcome["project"]): void;
}

function fakeRuntime() {
  const runs: FakeRun[] = [];
  const runtime: ProjectCopyRuntime = {
    startProjectCopy: (input) => {
      let resolve: (outcome: ProjectCopyOutcome) => void = () => undefined;
      const done = new Promise<ProjectCopyOutcome>((settle) => {
        resolve = settle;
      });
      const record = input.restartOf
        ? reduceProjectCopyJobRecord(input.restartOf, {
            type: "restarted",
            at: Date.now(),
            importId: ProjectImportId.make(crypto.randomUUID()),
            projectId: ProjectId.make("project-new"),
          })
        : createProjectCopyJobRecord({
            copyId: input.resume?.copyId ?? input.copyId ?? `copy-${runs.length + 1}`,
            at: Date.now(),
            sourceEnvironmentId: LAPTOP,
            sourceProjectId: SOURCE_ID,
            targetEnvironmentId: HETZNER,
            projectId: ProjectId.make("project-new"),
            importId: ProjectImportId.make(crypto.randomUUID()),
          });
      const run: FakeRun = {
        input,
        record,
        progress: {
          copyId: record.copyId,
          phase: "acquire",
          uploadedBytes: 0,
          totalBytes: 0,
          importSnapshot: null,
          canCloseClient: false,
          error: null,
        },
        emit(patch) {
          run.progress = { ...run.progress, ...patch };
          input.onProgress?.(run.progress);
        },
        settle(patch, completed = null) {
          run.progress = { ...run.progress, ...patch };
          input.onProgress?.(run.progress);
          resolve({ progress: run.progress, record: run.record, project: completed });
        },
      };
      runs.push(run);
      input.onRecord?.(record);
      return {
        copyId: record.copyId,
        getProgress: () => run.progress,
        done,
        cancel: () => run.settle({ phase: "cancelled", error: null }),
        detach: () => undefined,
      };
    },
    projectCopyPlanWithSendFiles: (plan) => ({
      ...plan,
      choices: { ...plan.choices, mode: "send-files", bringCommits: false },
      sendFilesFallback: false,
    }),
    createIo: () =>
      ({
        dispose: () => undefined,
        uuid: () => `copy-${runs.length + 1}`,
      }) as unknown as WebProjectCopyIo,
    callNodeWithLease: async () => undefined as never,
    callNodeToRead: async () => undefined as never,
  };
  return { runtime, runs };
}

function snapshot(patch: Partial<ProjectImportSnapshot>): ProjectImportSnapshot {
  return {
    importId: ProjectImportId.make(crypto.randomUUID()),
    projectId: ProjectId.make("project-new"),
    title: "ryco",
    destinationPath: "/home/me/Code/ryco",
    status: "running",
    steps: [],
    outputTail: "",
    error: null,
    warnings: [],
    preflight: null,
    leftoverPath: null,
    followUpThreadId: null,
    origin: { kind: "user", sourceLabel: "MacBook Pro", proposalId: null },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...patch,
  } as ProjectImportSnapshot;
}

/* ───────── Mounting ───────── */

interface MountOptions {
  readonly nodes?: ReadonlyArray<NodeCatalogEntry>;
  readonly request?: Partial<CopyProjectDialogRequest>;
  readonly holdNode?: CopyDialogServices["holdNode"];
  readonly sourceInspection?: ProjectExportInspection;
  readonly hetznerFolders?: FakeFolders;
  readonly reachable?: boolean;
  readonly targetConfig?: ServerConfig | null;
}

async function mount(options: MountOptions = {}) {
  const laptop = nodeApi({ hints: MAC_HINTS, inspection: options.sourceInspection });
  const mini = nodeApi({ hints: MAC_HINTS, folders: { "/Users/me/dev": null } });
  const hetzner = nodeApi({
    hints: LINUX_HINTS,
    folders: options.hetznerFolders ?? { "/home/me/Code": null, "/home/me/Code/scratch": null },
    reachable: options.reachable,
  });
  __setEnvironmentApiOverrideForTests(LAPTOP, laptop.api);
  __setEnvironmentApiOverrideForTests(MINI, mini.api);
  __setEnvironmentApiOverrideForTests(HETZNER, hetzner.api);
  const fake = fakeRuntime();
  setProjectCopyRuntimeForTests(fake.runtime);
  const startCopy = vi.fn((plan: ProjectCopyRunPlan) =>
    startManagedProjectCopy({ plan, toast: false }),
  );
  const services: CopyDialogServices = {
    holdNode:
      options.holdNode ??
      (async (environmentId) => ({
        transport:
          (options.nodes ?? nodes()).find((entry) => entry.environmentId === environmentId)
            ?.transport ?? "direct",
        release: () => undefined,
      })),
    readServerConfig: async (environmentId) =>
      environmentId === HETZNER ? (options.targetConfig ?? null) : null,
    startCopy,
  };
  const request: CopyProjectDialogRequest = {
    source: { environmentId: LAPTOP, projectId: SOURCE_ID },
    targetEnvironmentId: null,
    origin: "sidebar",
    ...options.request,
  };
  const onClose = vi.fn();
  function Harness() {
    const entries = useProjectCopyStore((state) => state.entries);
    return (
      <CopyProjectDialogView
        open
        token={1}
        request={request}
        nodes={options.nodes ?? nodes()}
        members={MEMBERS}
        copies={Object.values(entries)}
        services={services}
        onClose={onClose}
      />
    );
  }
  const screen = await render(
    <AppAtomRegistryProvider>
      <Harness />
    </AppAtomRegistryProvider>,
  );
  return { screen, laptop, mini, hetzner, fake, startCopy, onClose };
}

const dialog = () => page.getByTestId("copy-project-dialog");
const radio = (name: string | RegExp) => dialog().getByRole("radio", { name });
const primary = () => dialog().getByRole("button", { name: /^(Copy to |Link existing checkout)/u });

beforeEach(async () => {
  await page.viewport(1_100, 900);
});

afterEach(() => {
  __resetEnvironmentApiOverridesForTests();
  resetProjectAtomsForTests();
  resetProjectCopyManagerForTests();
  setProjectCopyRuntimeForTests(null);
  defaultQueryClient.clear();
  document.body.innerHTML = "";
});

describe("CopyProjectDialog", () => {
  it("shows the project's checkouts, the destinations and a reachable clone", async () => {
    const { screen, hetzner } = await mount();
    try {
      await expect.element(dialog().getByText("ryco to another node")).toBeVisible();
      // From: both checkouts; the requested one is selected.
      await expect
        .element(radio(/^MacBook Pro ~\/Code\/ryco/u))
        .toHaveAttribute("aria-checked", "true");
      await expect.element(radio(/^Mac mini ~\/dev\/ryco/u)).toBeVisible();
      // To: nodes that have it, the offline one, and the first free one picked.
      await expect.element(radio(/^MacBook Pro has it/u)).toBeDisabled();
      await expect.element(radio(/^Mac mini has it · ~\/dev\/ryco/u)).toBeDisabled();
      await expect.element(radio(/^Gaming PC offline/u)).toBeDisabled();
      await expect.element(radio(/^hetzner-build Linux/u)).toHaveAttribute("aria-checked", "true");
      // How: clone is recommended and the destination can reach the remote.
      await expect.element(radio(/^Clone from origin/u)).toHaveAttribute("aria-checked", "true");
      await expect.element(dialog().getByText("Recommended")).toBeVisible();
      await expect
        .element(page.getByTestId("copy-remote-check"))
        .toMatchTextContent("hetzner-build can reach it.");
      expect(hetzner.checkRemoteAccess).toHaveBeenCalledWith({
        remoteUrl: "git@github.com:sak0a/ryco.git",
      });
      await expect
        .element(radio(/^Send files from MacBook Pro/u))
        .toMatchTextContent("38 MB, skips ignored files like node_modules");
      // Folder: the same place as on the source, a new folder.
      await expect
        .element(page.getByTestId("copy-destination-path"))
        .toMatchTextContent("~/Code/ryco");
      await expect
        .element(page.getByTestId("copy-destination-tag"))
        .toMatchTextContent("new folder");
      await expect
        .element(page.getByTestId("copy-folder-note"))
        .toMatchTextContent("Same place as on MacBook Pro.");
      // Options and the footer.
      await expect
        .element(page.getByTestId("copy-option-changes"))
        .toMatchTextContent("Bring the 2 uncommitted changes along");
      await expect
        .element(page.getByTestId("copy-option-setup"))
        .toMatchTextContent("Run setup afterwards");
      await expect
        .element(dialog().getByRole("textbox", { name: "Setup command" }))
        .toHaveValue("bun install --frozen-lockfile");
      await expect
        .element(page.getByTestId("copy-footer-summary"))
        .toMatchTextContent("Clones to ~/Code/ryco on hetzner-build");
      await expect.element(primary()).toMatchTextContent("Copy to hetzner-build");
      await expect.element(primary()).toBeEnabled();
    } finally {
      await screen.unmount();
    }
  });

  it("preselects Send files when the destination can't reach the remote", async () => {
    const { screen } = await mount({ reachable: false });
    try {
      await expect
        .element(page.getByTestId("copy-remote-check"))
        .toMatchTextContent("hetzner-build can’t reach it: Host key verification failed");
      await expect
        .element(radio(/^Send files from MacBook Pro/u))
        .toHaveAttribute("aria-checked", "true");
      await expect.element(radio(/^Clone from origin/u)).toBeEnabled();
      // The changes come with the files.
      await expect
        .element(page.getByTestId("copy-option-changes"))
        .toMatchTextContent("2 uncommitted changes come with the files");
      await expect
        .element(page.getByTestId("copy-footer-summary"))
        .toMatchTextContent("Sends to ~/Code/ryco on hetzner-build");
    } finally {
      await screen.unmount();
    }
  });

  it("disables what is too large for the Hub when the source is relayed", async () => {
    const { screen } = await mount({
      nodes: nodes({ [LAPTOP]: { transport: "relay" } }),
      sourceInspection: inspection({ bundleBytes: 40 * 1024 * 1024 }),
    });
    try {
      await expect.element(radio(/^Send files from MacBook Pro/u)).toBeDisabled();
      await expect
        .element(radio(/^Send files from MacBook Pro/u))
        .toMatchTextContent(
          "Too large to send through the Hub (40 MB). Push the branch, or connect both devices directly.",
        );
      await expect.element(radio(/^Clone from origin/u)).toHaveAttribute("aria-checked", "true");
      await expect.element(primary()).toBeEnabled();
    } finally {
      await screen.unmount();
    }
  });

  it("warns that ignored files stay home when the destination is reached through the Hub (A33)", async () => {
    const { screen } = await mount({
      nodes: nodes({ [HETZNER]: { transport: "relay" } }),
      sourceInspection: inspection({ ignored: [".env"] }),
    });
    try {
      // Uncommitted changes come along by default, and with them the ignored files to pick.
      await expect
        .element(page.getByTestId("copy-option-changes").getByRole("checkbox"))
        .toHaveAttribute("aria-checked", "true");
      await expect.element(page.getByTestId("copy-ignored-files")).toMatchTextContent(".env");
      await expect
        .element(page.getByTestId("copy-insecure-note"))
        .toMatchTextContent(
          "hetzner-build is reached through the Hub. If that connection isn't end-to-end encrypted",
        );
    } finally {
      await screen.unmount();
    }
  });

  it("only clones from a source without project copy", async () => {
    const { screen, laptop } = await mount({
      nodes: nodes({ [LAPTOP]: { projectCopySupport: "no" } }),
    });
    try {
      await expect.element(radio(/^Clone from origin/u)).toHaveAttribute("aria-checked", "true");
      await expect.element(radio(/^Send files from MacBook Pro/u)).toBeDisabled();
      await expect
        .element(radio(/^Send files from MacBook Pro/u))
        .toMatchTextContent("Update Ryco on MacBook Pro to send files.");
      await expect
        .element(dialog().getByText("Update Ryco on MacBook Pro to bring unpushed commits."))
        .toBeVisible();
      await expect
        .element(dialog().getByText("Update Ryco on MacBook Pro to bring uncommitted changes."))
        .toBeVisible();
      // The source's repository identity still places the copy where it is on the source.
      await expect
        .element(page.getByTestId("copy-folder-note"))
        .toMatchTextContent("Same place as on MacBook Pro.");
      expect(laptop.exportInspect).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("skips a destination that already has the project and says why", async () => {
    const { screen } = await mount({ request: { targetEnvironmentId: MINI } });
    try {
      await expect.element(radio(/^Mac mini has it/u)).toBeDisabled();
      await expect
        .element(radio(/^Mac mini has it/u))
        .toHaveAttribute("title", "has it · ~/dev/ryco");
      await expect.element(radio(/^hetzner-build/u)).toHaveAttribute("aria-checked", "true");
    } finally {
      await screen.unmount();
    }
  });

  it("says a node needs Ryco updated, not that every node has the project", async () => {
    const { screen } = await mount({ nodes: nodes({ [HETZNER]: { projectCopySupport: "no" } }) });
    try {
      await expect
        .element(page.getByTestId("copy-no-target"))
        .toHaveTextContent(
          "No node can take a copy of ryco right now. Update Ryco on hetzner-build to copy here.",
        );
      await expect.element(radio(/^hetzner-build/u)).toBeDisabled();
    } finally {
      await screen.unmount();
    }
  });

  it("explains a suggested folder the destination doesn't have", async () => {
    const { screen } = await mount({
      request: { source: { environmentId: MINI, projectId: MINI_ID } },
      nodes: nodes({ [MINI]: { projectCopySupport: "no" } }),
    });
    try {
      await expect
        .element(radio(/^Mac mini ~\/dev\/ryco/u))
        .toHaveAttribute("aria-checked", "true");
      await expect
        .element(page.getByTestId("copy-destination-path"))
        .toMatchTextContent("~/Code/ryco");
      await expect
        .element(page.getByTestId("copy-folder-note"))
        .toMatchTextContent("~/dev doesn’t exist on hetzner-build, so this uses ~/Code instead.");
    } finally {
      await screen.unmount();
    }
  });

  it("renames a destination folder that exists", async () => {
    const { screen } = await mount({
      hetznerFolders: {
        "/home/me/Code": null,
        "/home/me/Code/ryco": null,
        "/home/me/Code/ryco/x": null,
      },
    });
    try {
      await expect
        .element(page.getByTestId("copy-destination-path"))
        .toMatchTextContent("~/Code/ryco-2");
      await expect
        .element(page.getByTestId("copy-destination-tag"))
        .toMatchTextContent("renamed, folder exists");
      await expect
        .element(page.getByTestId("copy-footer-summary"))
        .toMatchTextContent("Clones to ~/Code/ryco-2 on hetzner-build");
    } finally {
      await screen.unmount();
    }
  });

  it("links a checkout of the same repository instead of copying", async () => {
    const { screen, fake } = await mount({
      hetznerFolders: { "/home/me/Code": null, "/home/me/Code/ryco": KEY },
    });
    try {
      await expect.element(primary()).toMatchTextContent("Link existing checkout");
      await expect
        .element(page.getByTestId("copy-destination-tag"))
        .toMatchTextContent("existing checkout");
      await expect.element(page.getByTestId("copy-method-link")).toBeVisible();
      await expect
        .element(page.getByTestId("copy-footer-summary"))
        .toMatchTextContent("Links ~/Code/ryco on hetzner-build");
      await primary().click();
      await vi.waitFor(() => expect(fake.runs).toHaveLength(1));
      expect(fake.runs[0]!.input.plan?.choices.mode).toBe("link");
      expect(fake.runs[0]!.input.plan?.expectedCanonicalKey).toBe(KEY);
    } finally {
      await screen.unmount();
    }
  });

  it("picks another parent folder with Change…", async () => {
    const { screen, hetzner } = await mount();
    try {
      await expect
        .element(page.getByTestId("copy-destination-tag"))
        .toMatchTextContent("new folder");
      await dialog().getByRole("button", { name: "Change…" }).click();
      await expect
        .element(dialog().getByRole("combobox", { name: "Search folders on hetzner-build" }))
        .toBeVisible();
      await dialog()
        .getByRole("option", { name: /^scratch/u })
        .click();
      await vi.waitFor(() =>
        expect(hetzner.previewDestination).toHaveBeenCalledWith({
          path: "/home/me/Code/scratch/ryco",
        }),
      );
      await dialog().getByRole("button", { name: "Done" }).click();
      await expect
        .element(page.getByTestId("copy-destination-path"))
        .toMatchTextContent("~/Code/scratch/ryco");
      await expect
        .element(page.getByTestId("copy-folder-note"))
        .toMatchTextContent("You picked this folder.");
    } finally {
      await screen.unmount();
    }
  });

  it("checks a node that is not connected yet before it offers the copy", async () => {
    const { screen } = await mount({
      nodes: nodes({ [HETZNER]: { projectCopySupport: "unknown", transport: null } }),
      holdNode: (environmentId) =>
        environmentId === HETZNER
          ? new Promise(() => undefined)
          : Promise.resolve({ transport: "direct", release: () => undefined }),
    });
    try {
      await expect.element(radio(/^hetzner-build/u)).toMatchTextContent("Checking hetzner-build…");
      await expect.element(primary()).toBeDisabled();
    } finally {
      await screen.unmount();
    }
  });

  it("shows the copy's progress, then the project on its new node", async () => {
    const { screen, fake, startCopy } = await mount({
      sourceInspection: inspection({ unpushed: 1, headOnRemote: false }),
    });
    try {
      await expect.element(primary()).toBeEnabled();
      await expect
        .element(page.getByTestId("copy-option-commits"))
        .toMatchTextContent("The uncommitted changes need them");
      await expect
        .element(page.getByTestId("copy-option-commits").getByRole("checkbox"))
        .toBeDisabled();
      await primary().click();
      await vi.waitFor(() => expect(fake.runs).toHaveLength(1));
      const plan = startCopy.mock.calls[0]![0];
      expect(plan.destinationPath).toBe("/home/me/Code/ryco");
      // The changes need the unpushed commits: the remote lacks the commit they are on (A8).
      expect(plan.choices).toMatchObject({ mode: "clone", bringCommits: true, bringChanges: true });
      expect(plan.setup).toEqual({ command: "bun install --frozen-lockfile", saveAsScript: false });
      const run = fake.runs[0]!;

      run.emit({ phase: "upload", uploadedBytes: 1024 * 1024, totalBytes: 4 * 1024 * 1024 });
      await expect
        .element(page.getByTestId("copy-progress-footer"))
        .toMatchTextContent("Keep Ryco open until the upload finishes (1.0 of 4.0 MB).");
      await expect
        .element(dialog().getByRole("button", { name: "Run in background" }))
        .toBeVisible();

      run.emit({
        phase: "import",
        uploadedBytes: 4 * 1024 * 1024,
        canCloseClient: true,
        importSnapshot: snapshot({
          steps: [
            { id: "preflight", status: "done", progressPercent: null, detail: null },
            {
              id: "clone",
              status: "running",
              progressPercent: 31,
              detail: "Receiving objects 31% (5760/18432)",
            },
            { id: "checkout", status: "pending", progressPercent: null, detail: null },
            { id: "lfs", status: "skipped", progressPercent: null, detail: null },
          ],
        }),
      });
      await expect
        .element(page.getByTestId("copy-progress-footer"))
        .toMatchTextContent("Runs on hetzner-build; you can close Ryco.");
      await expect.element(dialog().getByText("Receiving objects 31% (5760/18432)")).toBeVisible();
      expect(document.querySelector('[data-step="checkout"]')?.textContent).toContain(
        "Check out task/copy-clone",
      );
      expect(document.querySelector('[data-step="clone"]')?.textContent).toContain(
        "Clone github.com/sak0a/ryco",
      );
      expect(document.querySelector('[data-step="lfs"]')).toBeNull();

      run.settle(
        {
          phase: "done",
          importSnapshot: snapshot({ status: "completed", steps: [] }),
        },
        {
          environmentId: HETZNER,
          projectId: ProjectId.make("project-new"),
          workspaceRoot: "/home/me/Code/ryco",
          warnings: [],
        },
      );
      await expect.element(page.getByTestId("copy-project-done")).toBeVisible();
      await expect.element(dialog().getByText("ryco is on hetzner-build")).toBeVisible();
      await expect
        .element(dialog().getByText("One project on 3 nodes. Threads can start on any of them."))
        .toBeVisible();
      await expect
        .element(dialog().getByRole("button", { name: "Start a thread on hetzner-build" }))
        .toBeEnabled();
      // The dialog showed how it ended; the copy did not toast it as well.
      expect(useProjectCopyStore.getState().entries[run.record.copyId]?.inDialog).toBe(true);
    } finally {
      await screen.unmount();
    }
  });

  it("offers Send files after the destination could not reach the remote", async () => {
    const { screen, fake } = await mount();
    try {
      await primary().click();
      await vi.waitFor(() => expect(fake.runs).toHaveLength(1));
      fake.runs[0]!.settle({
        phase: "failed",
        canCloseClient: true,
        importSnapshot: snapshot({
          status: "failed",
          steps: [
            {
              id: "preflight",
              status: "failed",
              progressPercent: null,
              detail: "remote-unreachable",
            },
          ],
        }),
        error: {
          code: "remote-unreachable",
          message: "hetzner-build can't reach github.com.",
          retry: "send-files",
        },
      });
      await expect.element(page.getByTestId("copy-project-failed")).toBeVisible();
      await expect
        .element(dialog().getByText("hetzner-build can't reach github.com."))
        .toBeVisible();
      await dialog().getByRole("button", { name: "Send from MacBook Pro instead" }).click();
      await vi.waitFor(() => expect(fake.runs).toHaveLength(2));
      expect(fake.runs[1]!.input.restartOf?.copyId).toBe(fake.runs[0]!.record.copyId);
      expect(fake.runs[1]!.input.plan?.choices.mode).toBe("send-files");
      await expect.element(page.getByTestId("copy-project-progress")).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("goes back to the form when a copy is stopped", async () => {
    const { screen, fake } = await mount();
    try {
      await primary().click();
      await vi.waitFor(() => expect(fake.runs).toHaveLength(1));
      await dialog().getByRole("button", { name: "Cancel" }).click();
      await expect.element(page.getByTestId("copy-project-form")).toBeVisible();
      await expect
        .element(dialog().getByText("Stopped copying ryco. Nothing was left behind."))
        .toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("asks an agent on the destination to finish setup, with its model", async () => {
    const targetConfig = {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          enabled: true,
          installed: true,
          version: "1.0.0",
          status: "ready",
          auth: { status: "authenticated" },
          checkedAt: "2026-10-22T10:00:00.000Z",
          models: [{ slug: "gpt-5.6-terra", name: "GPT-5.6 Terra" }],
          slashCommands: [],
        },
      ],
      settings: { ...DEFAULT_SERVER_SETTINGS, initialModelSelection: null },
    } as unknown as ServerConfig;
    const { screen, fake } = await mount({ targetConfig });
    try {
      const agent = page.getByTestId("copy-option-agent");
      await expect.element(agent.getByRole("checkbox")).toBeEnabled();
      await agent.getByRole("checkbox").click();
      const prompt = dialog().getByRole("textbox", { name: "What the agent should do" });
      await expect.element(prompt).toBeVisible();
      await expect.element(agent).toMatchTextContent("Model on hetzner-build");
      await prompt.fill("Install the tools and run the tests.");
      await primary().click();
      await vi.waitFor(() => expect(fake.runs).toHaveLength(1));
      expect(fake.runs[0]!.input.plan?.followUpThread).toMatchObject({
        title: "Finish setting up ryco",
        prompt: "Install the tools and run the tests.",
        modelSelection: { instanceId: "codex", model: "gpt-5.6-terra" },
      });
    } finally {
      await screen.unmount();
    }
  });

  it("can't ask an agent when no provider is ready on the destination", async () => {
    const { screen } = await mount({ targetConfig: null });
    try {
      const agent = page.getByTestId("copy-option-agent");
      await expect.element(agent.getByRole("checkbox")).toBeDisabled();
      await expect
        .element(agent)
        .toMatchTextContent("No agent provider is ready on hetzner-build.");
    } finally {
      await screen.unmount();
    }
  });
});
