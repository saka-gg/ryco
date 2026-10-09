import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  type DiagnosticsTerminalProcess,
  type OrchestrationCommand,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  ProjectChatError,
  ProjectId,
  type ProjectsPromoteChatInput,
  type ProviderSession,
  TerminalSessionLookupError,
  ThreadId,
} from "@ryco/contracts";
import { Effect, Fiber, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import type { ProjectionProject } from "../persistence/Services/ProjectionProjects.ts";
import type { ProjectionThread } from "../persistence/Services/ProjectionThreads.ts";
import type {
  ProjectRelocation,
  ProjectRelocationRepositoryShape,
} from "../persistence/Services/ProjectRelocations.ts";
import { type StoragePathBlocker, storagePathBlocker } from "../storage/lifecycle.ts";
import { makeWorkspaceAccessPolicy } from "../workspace/Layers/WorkspaceAccessPolicy.ts";
import {
  type ChatPromotionDependencies,
  type ChatPromotionFileSystem,
  chatTerminalActivity,
  chatThreadBusyReason,
  copyFolderContents,
  makeChatPromotion,
  nodeChatPromotionFileSystem,
  readTreeManifest,
  recoverProjectRelocations,
  resolvePromotionParent,
  sameManifest,
  scanChatFolder,
} from "./chatPromotion.ts";

let scratch: string;
beforeEach(async () => {
  scratch = await realpath(await mkdtemp(path.join(tmpdir(), "ryco-chat-promotion-")));
});
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const NOW = "2026-10-08T10:00:00.000Z";
const projectId = ProjectId.make("project-chat-1");
const threadId = ThreadId.make("thread-chat-1");

const pathExists = (target: string) =>
  lstat(target).then(
    () => true,
    () => false,
  );

const idleShell = (overrides: Partial<OrchestrationThreadShell> = {}) =>
  ({
    id: threadId,
    projectId,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestTurn: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    backgroundLiveness: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }) as unknown as OrchestrationThreadShell;

/** An in-memory journal with the repository's rule: settled rows never change. */
const makeJournal = () => {
  const rows = new Map<string, ProjectRelocation>();
  const repository: ProjectRelocationRepositoryShape = {
    create: (row) => Effect.sync(() => void rows.set(row.relocationId, row)),
    getById: ({ relocationId }) => Effect.sync(() => Option.fromNullishOr(rows.get(relocationId))),
    listUnresolved: () =>
      Effect.sync(() =>
        [...rows.values()].filter((row) => row.state === "pending" || row.state === "moved"),
      ),
    listUnresolvedByProjectId: ({ projectId: id }) =>
      Effect.sync(() =>
        [...rows.values()].filter(
          (row) => row.projectId === id && (row.state === "pending" || row.state === "moved"),
        ),
      ),
    update: (input) =>
      Effect.sync(() => {
        const current = rows.get(input.relocationId);
        if (!current || (current.state !== "pending" && current.state !== "moved")) return false;
        rows.set(input.relocationId, { ...current, ...input });
        return true;
      }),
  };
  return { rows, repository };
};

const chatProject = (source: string): ProjectionProject => ({
  projectId,
  kind: "chat",
  title: "Plan the offsite",
  workspaceRoot: source,
  projectMetadataDir: ".ryco",
  defaultModelSelection: null,
  customAvatarContentHash: null,
  preferredRemoteName: null,
  scripts: [],
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
});

interface HarnessOptions {
  readonly shell?: OrchestrationThreadShell;
  readonly thread?: Partial<OrchestrationThread>;
  readonly fs?: Partial<ChatPromotionFileSystem>;
  readonly accessRoot?: string;
  readonly sessions?: Array<Pick<ProviderSession, "threadId" | "status" | "cwd">>;
  readonly addProjectBaseDirectory?: string;
  readonly git?: ChatPromotionDependencies["git"];
  readonly failMetaUpdate?: boolean;
  readonly holdMetaUpdate?: Promise<void>;
  readonly initializeGit?: ChatPromotionDependencies["initializeGit"];
  readonly threads?: ReadonlyArray<Partial<ProjectionThread>>;
  /** The terminals open when the promotion starts, given the chat's folder. */
  readonly terminals?: (folder: string) => ReadonlyArray<DiagnosticsTerminalProcess>;
  /** The terminal manager refuses to close these threads' terminals. */
  readonly stuckTerminalThreadIds?: ReadonlyArray<string>;
  /** Storage admission's blocker for a canonical path, given the call's index; null admits it. */
  readonly fenced?: (canonical: string, call: number) => StoragePathBlocker | null;
}

const terminal = (
  overrides: Partial<DiagnosticsTerminalProcess> = {},
): DiagnosticsTerminalProcess =>
  ({
    threadId,
    terminalId: "default",
    cwd: "/chats/2026-10-08-plan-0a1b2c3d",
    worktreePath: null,
    status: "running",
    pid: 4242,
    hasRunningSubprocess: false,
    exitCode: null,
    exitSignal: null,
    updatedAt: NOW,
    ...overrides,
  }) as DiagnosticsTerminalProcess;

/** A chat with one conversation and a folder holding a file, a subfolder and a symlink. */
const makeHarness = async (options: HarnessOptions = {}) => {
  const chatsRoot = path.join(scratch, "chats");
  const source = path.join(chatsRoot, "2026-10-08-plan-the-offsite-0a1b2c3d");
  await mkdir(path.join(source, "notes"), { recursive: true });
  await writeFile(path.join(source, "plan.md"), "# Offsite\n");
  await writeFile(path.join(source, "notes", "day-1.md"), "Arrive\n");
  await symlink("plan.md", path.join(source, "latest.md"));
  const home = path.join(scratch, "home");
  await mkdir(path.join(home, "Code"), { recursive: true });

  let project = chatProject(source);
  const journal = makeJournal();
  const commands: OrchestrationCommand[] = [];
  const sessions = [...(options.sessions ?? [])];
  const stopped: string[] = [];
  let terminals = [...(options.terminals?.(source) ?? [])];
  const closedTerminals: string[] = [];
  /** The journal's states each time a session stop ran. */
  const journalStatesAtStop: string[] = [];
  const gitCalls: Array<{ writeGitignore: boolean; initialCommit: boolean }> = [];
  const admissionChecks: string[] = [];
  const policy = await Effect.runPromise(
    makeWorkspaceAccessPolicy(options.accessRoot).pipe(Effect.provide(NodeServices.layer)),
  );
  const dependencies: ChatPromotionDependencies = {
    projects: { getById: () => Effect.sync(() => Option.some(project)) },
    threads: {
      listByProjectId: () =>
        Effect.succeed(
          (options.threads ?? [{}]).map(
            (thread) =>
              Object.assign(
                { threadId, projectId, deletedAt: null, trashedAt: null },
                thread,
              ) as ProjectionThread,
          ),
        ),
    },
    snapshots: {
      getThreadShellById: () => Effect.succeed(Option.some(options.shell ?? idleShell())),
      getThreadDetailById: () =>
        Effect.succeed(
          Option.some({ activities: [], ...options.thread } as unknown as OrchestrationThread),
        ),
    },
    relocations: journal.repository,
    chatFolders: { capability: Effect.succeed({ available: true, root: chatsRoot }) },
    policy,
    config: { workspaceAccessRoot: options.accessRoot },
    settings: {
      getSettings: Effect.succeed({
        ...DEFAULT_SERVER_SETTINGS,
        addProjectBaseDirectory: options.addProjectBaseDirectory ?? "",
      }),
    },
    providers: {
      listSessions: () => Effect.sync(() => [...sessions]),
      stopSession: ({ threadId: stoppedThreadId }) =>
        Effect.sync(() => {
          journalStatesAtStop.push(...[...journal.rows.values()].map((row) => row.state));
          stopped.push(stoppedThreadId);
          for (const [index, session] of sessions.entries()) {
            if (session.threadId === stoppedThreadId) {
              sessions[index] = { ...session, status: "closed" };
            }
          }
        }),
    },
    terminals: {
      listDiagnostics: Effect.sync(() => [...terminals]),
      close: ({ threadId: closedThreadId }) =>
        (options.stuckTerminalThreadIds ?? []).includes(closedThreadId)
          ? Effect.fail(
              new TerminalSessionLookupError({ threadId: closedThreadId, terminalId: "default" }),
            )
          : Effect.sync(() => {
              closedTerminals.push(closedThreadId);
              terminals = terminals.filter((entry) => entry.threadId !== closedThreadId);
            }),
    },
    dispatch: (command) =>
      Effect.gen(function* () {
        if (command.type === "project.meta.update" && options.holdMetaUpdate) {
          yield* Effect.promise(() => options.holdMetaUpdate!);
        }
        commands.push(command);
        if (command.type !== "project.meta.update") return { sequence: commands.length };
        if (options.failMetaUpdate || command.expectedUpdatedAt !== project.updatedAt) {
          return yield* Effect.fail({
            message: "Project changed after the command was authorized.",
          });
        }
        project = {
          ...project,
          kind: command.kind ?? project.kind,
          title: command.title ?? project.title,
          workspaceRoot: command.workspaceRoot ?? project.workspaceRoot,
          updatedAt: "2026-10-08T10:05:00.000Z",
        };
        return { sequence: commands.length };
      }),
    initializeGit:
      options.initializeGit ??
      ((_id, gitOptions) =>
        Effect.sync(() => {
          gitCalls.push({ ...gitOptions });
          return { initialCommitCreated: gitOptions.initialCommit };
        })),
    storageAdmission: (canonical) =>
      Effect.sync(() => {
        admissionChecks.push(canonical);
        return options.fenced?.(canonical, admissionChecks.length - 1) ?? null;
      }),
    git: options.git,
    fs: { ...nodeChatPromotionFileSystem, ...options.fs },
    homeDir: () => home,
    now: () => new Date(NOW),
  };
  return {
    chatsRoot,
    source,
    home,
    journal,
    commands,
    stopped,
    closedTerminals,
    journalStatesAtStop,
    gitCalls,
    admissionChecks,
    get project() {
      return project;
    },
    set project(value: ProjectionProject) {
      project = value;
    },
    promotion: makeChatPromotion(dependencies),
    dependencies,
  };
};

const promoteInput = (
  destination: string,
  overrides: Partial<ProjectsPromoteChatInput> = {},
): ProjectsPromoteChatInput => ({
  projectId,
  expectedUpdatedAt: NOW,
  title: "Offsite planner",
  destination,
  initializeGit: false,
  initialCommit: false,
  writeGitignore: false,
  ...overrides,
});

const promotionFailure = <A>(effect: Effect.Effect<A, ProjectChatError>) =>
  Effect.runPromise(Effect.flip(effect));

const exdevOnce = (source: string): Partial<ChatPromotionFileSystem> => ({
  rename: async (from, to) => {
    if (from === source) throw Object.assign(new Error("cross-device link"), { code: "EXDEV" });
    await rename(from, to);
  },
});

describe("promoteChat", () => {
  it("renames the folder, then turns the same project into a regular one", async () => {
    const harness = await makeHarness({
      sessions: [{ threadId, status: "ready", cwd: path.join(scratch, "chats", "x") }],
    });
    const destination = path.join(harness.home, "Code", "offsite");
    const result = await Effect.runPromise(harness.promotion.promote(promoteInput(destination)));

    expect(result).toEqual({
      projectId,
      workspaceRoot: destination,
      gitInitialized: false,
      initialCommitCreated: false,
    });
    expect(await pathExists(harness.source)).toBe(false);
    expect(await readFile(path.join(destination, "notes", "day-1.md"), "utf8")).toBe("Arrive\n");
    expect(await readlink(path.join(destination, "latest.md"))).toBe("plan.md");
    expect(harness.stopped).toEqual([threadId]);
    expect(harness.commands.map((command) => command.type)).toEqual([
      "thread.session.stop",
      "project.meta.update",
    ]);
    expect(harness.commands[1]).toMatchObject({
      type: "project.meta.update",
      projectId,
      expectedUpdatedAt: NOW,
      kind: "project",
      title: "Offsite planner",
      workspaceRoot: destination,
    });
    expect(harness.project).toMatchObject({ kind: "project", workspaceRoot: destination });
    const [row] = harness.journal.rows.values();
    expect(row).toMatchObject({
      strategy: "rename",
      state: "done",
      sourcePath: harness.source,
      destinationPath: destination,
      // Journaled, so recovery applies the same title.
      title: "Offsite planner",
    });
  });

  it("copies across devices, verifies the copy, then removes the source", async () => {
    const harness = await makeHarness();
    await chmod(path.join(harness.source, "plan.md"), 0o640);
    const harnessWithCopy = await makeHarnessWithFs(harness, exdevOnce(harness.source));
    const destination = path.join(harness.home, "Code", "offsite");
    const result = await Effect.runPromise(
      harnessWithCopy.promotion.promote(promoteInput(destination)),
    );

    expect(result.workspaceRoot).toBe(destination);
    expect(await pathExists(harness.source)).toBe(false);
    expect(await readFile(path.join(destination, "plan.md"), "utf8")).toBe("# Offsite\n");
    expect((await stat(path.join(destination, "plan.md"))).mode & 0o777).toBe(0o640);
    // Copied as a link, never followed.
    expect((await lstat(path.join(destination, "latest.md"))).isSymbolicLink()).toBe(true);
    const [row] = harness.journal.rows.values();
    expect(row).toMatchObject({ strategy: "copy", destinationCreated: true, state: "done" });
  });

  it("rolls a failed copy back and leaves the chat untouched", async () => {
    const harness = await makeHarness();
    const destination = path.join(harness.home, "Code", "offsite");
    const failing = await makeHarnessWithFs(harness, {
      ...exdevOnce(harness.source),
      copyContents: async (_from, to) => {
        await writeFile(path.join(to, "partial.md"), "half");
        throw new Error("disk full");
      },
    });
    const error = await promotionFailure(failing.promotion.promote(promoteInput(destination)));

    expect(error).toMatchObject({ _tag: "ProjectChatError", reason: "move-failed" });
    expect(await pathExists(destination)).toBe(false);
    expect(await readFile(path.join(harness.source, "plan.md"), "utf8")).toBe("# Offsite\n");
    expect(harness.commands.some((command) => command.type === "project.meta.update")).toBe(false);
    const [row] = harness.journal.rows.values();
    expect(row).toMatchObject({ state: "failed", strategy: "copy" });
    expect(row?.error).toContain("disk full");
  });

  it("abandons a copy when the chat's files change while copying", async () => {
    const harness = await makeHarness();
    const destination = path.join(harness.home, "Code", "offsite");
    const racing = await makeHarnessWithFs(harness, {
      ...exdevOnce(harness.source),
      copyContents: async (from, to) => {
        await copyFolderContents(from, to);
        await writeFile(path.join(from, "late.md"), "written by an agent mid-copy");
      },
    });
    const error = await promotionFailure(racing.promotion.promote(promoteInput(destination)));

    expect(error).toMatchObject({ reason: "busy" });
    expect(await pathExists(destination)).toBe(false);
    expect(await pathExists(path.join(harness.source, "late.md"))).toBe(true);
    const [row] = harness.journal.rows.values();
    expect(row).toMatchObject({ state: "failed", error: "source changed during copy" });
  });

  it("settles an abandoned copy it cannot remove, so the chat is not left fenced", async () => {
    const harness = await makeHarness();
    const destination = path.join(harness.home, "Code", "offsite");
    const failing = await makeHarnessWithFs(harness, {
      ...exdevOnce(harness.source),
      copyContents: async (_from, to) => {
        await writeFile(path.join(to, "partial.md"), "half");
        throw new Error("disk full");
      },
      removeTree: async () => {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      },
    });
    const error = await promotionFailure(failing.promotion.promote(promoteInput(destination)));

    expect(error).toMatchObject({ reason: "move-failed" });
    expect(error.message).toContain(destination);
    const [row] = harness.journal.rows.values();
    expect(row).toMatchObject({ state: "failed", strategy: "copy" });
    expect(row?.error).toContain("could not be removed");
    expect(harness.project.kind).toBe("chat");
    expect(await readFile(path.join(harness.source, "plan.md"), "utf8")).toBe("# Offsite\n");
  });

  it("settles a verified copy it cannot remove after the record update failed", async () => {
    const harness = await makeHarness({ failMetaUpdate: true });
    const destination = path.join(harness.home, "Code", "offsite");
    const copying = await makeHarnessWithFs(harness, {
      ...exdevOnce(harness.source),
      removeTree: async () => {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      },
    });
    const error = await promotionFailure(copying.promotion.promote(promoteInput(destination)));

    expect(error).toMatchObject({ reason: "move-failed" });
    expect(error.message).toContain(destination);
    const [row] = harness.journal.rows.values();
    expect(row).toMatchObject({ state: "failed", strategy: "copy" });
    expect(harness.project.kind).toBe("chat");
  });

  it("removes a verified copy when the project record cannot be updated", async () => {
    const harness = await makeHarness({ failMetaUpdate: true });
    const destination = path.join(harness.home, "Code", "offsite");
    const copying = await makeHarnessWithFs(harness, exdevOnce(harness.source));
    const error = await promotionFailure(copying.promotion.promote(promoteInput(destination)));

    expect(error).toMatchObject({ reason: "move-failed" });
    expect(await pathExists(destination)).toBe(false);
    expect(await readFile(path.join(harness.source, "plan.md"), "utf8")).toBe("# Offsite\n");
    const [row] = harness.journal.rows.values();
    expect(row).toMatchObject({ state: "failed", strategy: "copy" });
  });

  it("refuses while a thread is working, without journaling or moving anything", async () => {
    const harness = await makeHarness({
      shell: idleShell({
        session: {
          threadId,
          status: "running",
          providerName: "codex",
          runtimeMode: "full-access",
          activeTurnId: null,
          lastError: null,
          updatedAt: NOW,
        },
      } as Partial<OrchestrationThreadShell>),
    });
    const error = await promotionFailure(
      harness.promotion.promote(promoteInput(path.join(harness.home, "Code", "offsite"))),
    );

    expect(error).toMatchObject({ reason: "busy" });
    expect(error.message).toContain("a turn is running");
    expect(harness.journal.rows.size).toBe(0);
    expect(await pathExists(harness.source)).toBe(true);
  });

  it("refuses a stale expectedUpdatedAt", async () => {
    const harness = await makeHarness();
    const error = await promotionFailure(
      harness.promotion.promote(
        promoteInput(path.join(harness.home, "Code", "offsite"), {
          expectedUpdatedAt: "2026-10-08T09:00:00.000Z",
        }),
      ),
    );
    expect(error).toMatchObject({ reason: "stale" });
    expect(harness.journal.rows.size).toBe(0);
  });

  it("refuses a regular project", async () => {
    const harness = await makeHarness();
    harness.project = { ...harness.project, kind: "project" };
    const error = await promotionFailure(
      harness.promotion.promote(promoteInput(path.join(harness.home, "Code", "offsite"))),
    );
    expect(error).toMatchObject({ reason: "not-chat" });
  });

  it.each([
    [
      "an existing folder",
      (h: ChatPaths): string => path.join(h.home, "Code"),
      "destination-exists",
    ],
    [
      "a folder inside the chats root",
      (h: ChatPaths): string => path.join(h.chatsRoot, "x"),
      "destination-inside-chats",
    ],
    [
      "a folder inside the chat itself",
      (h: ChatPaths): string => path.join(h.source, "x"),
      "destination-inside-source",
    ],
    ["a relative path", (_h: ChatPaths): string => "Code/offsite", "destination-invalid"],
    [
      "a missing parent",
      (h: ChatPaths): string => path.join(h.home, "nope", "offsite"),
      "destination-invalid",
    ],
  ] as const)("refuses %s", async (_label, destinationOf, reason) => {
    const harness = await makeHarness();
    const error = await promotionFailure(
      harness.promotion.promote(promoteInput(destinationOf(harness))),
    );
    expect(error).toMatchObject({ reason });
    expect(harness.journal.rows.size).toBe(0);
    expect(await pathExists(harness.source)).toBe(true);
  });

  it("refuses a destination storage admission fences, without journaling or moving anything", async () => {
    const harness = await makeHarness({ fenced: () => "checkout" });
    const destination = path.join(harness.home, "Code", "offsite");
    const error = await promotionFailure(harness.promotion.promote(promoteInput(destination)));

    expect(error).toMatchObject({ reason: "destination-retired-checkout" });
    expect(harness.admissionChecks).toEqual([destination]);
    expect(harness.journal.rows.size).toBe(0);
    expect(harness.stopped).toEqual([]);
    expect(await pathExists(harness.source)).toBe(true);
  });

  it("admits the destination again with the journal, so a fence that appears meanwhile wins", async () => {
    // Free when judged; fenced by the time the move is journaled under the admission lock.
    const harness = await makeHarness({
      fenced: (_path, call) => (call === 0 ? null : "checkout"),
    });
    const destination = path.join(harness.home, "Code", "offsite");
    const error = await promotionFailure(harness.promotion.promote(promoteInput(destination)));

    expect(error).toMatchObject({ reason: "destination-retired-checkout" });
    expect(harness.admissionChecks).toEqual([destination, destination]);
    expect(harness.journal.rows.size).toBe(0);
    expect(harness.stopped).toEqual([]);
    expect(await pathExists(destination)).toBe(false);
    expect(await pathExists(harness.source)).toBe(true);
  });

  it("refuses a destination the workspace access policy does not allow", async () => {
    const allowed = path.join(scratch, "allowed");
    await mkdir(allowed);
    const harness = await makeHarness({ accessRoot: allowed });
    const error = await promotionFailure(
      harness.promotion.promote(promoteInput(path.join(harness.home, "Code", "offsite"))),
    );
    expect(error).toMatchObject({ reason: "access-denied" });
  });

  it("moves the folder back when the project record cannot be updated", async () => {
    const harness = await makeHarness({ failMetaUpdate: true });
    const destination = path.join(harness.home, "Code", "offsite");
    const error = await promotionFailure(harness.promotion.promote(promoteInput(destination)));

    expect(error).toMatchObject({ reason: "move-failed" });
    expect(await pathExists(destination)).toBe(false);
    expect(await readFile(path.join(harness.source, "plan.md"), "utf8")).toBe("# Offsite\n");
    expect(harness.project.kind).toBe("chat");
    const [row] = harness.journal.rows.values();
    expect(row).toMatchObject({ state: "failed" });
  });

  it("lets only one of two concurrent promotions run", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = await makeHarness({ holdMetaUpdate: held });
    const destination = path.join(harness.home, "Code", "offsite");
    const first = Effect.runPromise(harness.promotion.promote(promoteInput(destination)));
    while (harness.journal.rows.size === 0) await new Promise((resolve) => setTimeout(resolve, 5));

    const second = await promotionFailure(
      harness.promotion.promote(promoteInput(path.join(harness.home, "Code", "other"))),
    );
    expect(second).toMatchObject({ reason: "busy" });
    release();
    expect((await first).workspaceRoot).toBe(destination);
    expect(harness.journal.rows.size).toBe(1);
  });

  it("initializes Git with the chosen options and reports a commit problem", async () => {
    const harness = await makeHarness({
      initializeGit: (_id, options) =>
        Effect.succeed({
          initialCommitCreated: false,
          ...(options.initialCommit
            ? {
                commitError:
                  "Git has no name or email on this machine. Set user.name and user.email, then commit.",
              }
            : {}),
        }),
    });
    const result = await Effect.runPromise(
      harness.promotion.promote(
        promoteInput(path.join(harness.home, "Code", "offsite"), {
          initializeGit: true,
          initialCommit: true,
          writeGitignore: true,
        }),
      ),
    );
    expect(result).toMatchObject({
      gitInitialized: true,
      initialCommitCreated: false,
      commitError: expect.stringContaining("user.name"),
    });
  });

  it("keeps the promotion when git init fails", async () => {
    const harness = await makeHarness({
      initializeGit: () => Effect.fail({ message: "git init failed" }),
    });
    const destination = path.join(harness.home, "Code", "offsite");
    const result = await Effect.runPromise(
      harness.promotion.promote(promoteInput(destination, { initializeGit: true })),
    );
    expect(result).toMatchObject({
      workspaceRoot: destination,
      gitInitialized: false,
      commitError: expect.stringContaining("Initialize Git"),
    });
    expect(harness.project.kind).toBe("project");
  });

  it("passes the dialog's Git choices through", async () => {
    const harness = await makeHarness();
    await Effect.runPromise(
      harness.promotion.promote(
        promoteInput(path.join(harness.home, "Code", "offsite"), {
          initializeGit: true,
          initialCommit: true,
          writeGitignore: false,
        }),
      ),
    );
    expect(harness.gitCalls).toEqual([{ writeGitignore: false, initialCommit: true }]);
  });
});

describe("promoteChat fencing", () => {
  const destinationIn = (harness: Harness) => path.join(harness.home, "Code", "offsite");

  it("journals the move before it stops sessions, so nothing new starts in the folder", async () => {
    const harness = await makeHarness({
      sessions: [{ threadId, status: "ready", cwd: path.join(scratch, "chats", "x") }],
    });
    await Effect.runPromise(harness.promotion.promote(promoteInput(destinationIn(harness))));
    expect(harness.journalStatesAtStop).toEqual(["pending"]);
  });

  it("re-checks the threads once the folder is fenced and settles the journal", async () => {
    const harness = await makeHarness({
      sessions: [{ threadId, status: "ready", cwd: path.join(scratch, "chats", "x") }],
    });
    let reads = 0;
    // Idle when first checked; a turn admitted just before the fence is visible on the re-check.
    const racing = makeChatPromotion({
      ...harness.dependencies,
      snapshots: {
        ...harness.dependencies.snapshots,
        getThreadShellById: () =>
          Effect.sync(() =>
            Option.some((reads += 1) === 1 ? idleShell() : idleShell({ latestUserMessageAt: NOW })),
          ),
      },
    });
    const error = await promotionFailure(racing.promote(promoteInput(destinationIn(harness))));

    expect(error).toMatchObject({ reason: "busy" });
    expect(error.message).toContain("a message is still starting");
    expect(harness.stopped).toEqual([]);
    expect(await pathExists(harness.source)).toBe(true);
    const [row] = harness.journal.rows.values();
    expect(row).toMatchObject({ state: "failed" });
  });

  it("closes the chat's idle terminals, keeping their history, before the folder moves", async () => {
    const harness = await makeHarness({ terminals: (folder) => [terminal({ cwd: folder })] });
    const destination = destinationIn(harness);
    await Effect.runPromise(harness.promotion.promote(promoteInput(destination)));
    expect(harness.closedTerminals).toEqual([threadId]);
    expect(harness.project.workspaceRoot).toBe(destination);
  });

  it("refuses while a chat terminal runs a command, without journaling anything", async () => {
    const harness = await makeHarness({
      terminals: (folder) => [terminal({ cwd: folder, hasRunningSubprocess: true })],
    });
    const error = await promotionFailure(
      harness.promotion.promote(promoteInput(destinationIn(harness))),
    );
    expect(error).toMatchObject({ reason: "busy" });
    expect(error.message).toContain("a terminal is running a command");
    expect(harness.closedTerminals).toEqual([]);
    expect(harness.journal.rows.size).toBe(0);
  });

  it("treats a terminal that cannot be closed as busy and lifts the fence", async () => {
    const harness = await makeHarness({
      terminals: (folder) => [terminal({ cwd: folder })],
      stuckTerminalThreadIds: [threadId],
    });
    const destination = destinationIn(harness);
    const error = await promotionFailure(harness.promotion.promote(promoteInput(destination)));

    expect(error).toMatchObject({ reason: "busy" });
    expect(error.message).toContain("did not close");
    expect(await pathExists(destination)).toBe(false);
    expect(await pathExists(harness.source)).toBe(true);
    expect(harness.project.kind).toBe("chat");
    const [row] = harness.journal.rows.values();
    expect(row).toMatchObject({ state: "failed" });
  });

  it("refuses another conversation's terminal in the chat's folder", async () => {
    const harness = await makeHarness({
      terminals: (folder) => [
        terminal({ threadId: ThreadId.make("thread-elsewhere"), cwd: path.join(folder, "notes") }),
      ],
    });
    const error = await promotionFailure(
      harness.promotion.promote(promoteInput(destinationIn(harness))),
    );
    expect(error).toMatchObject({ reason: "busy" });
    expect(error.message).toContain("another conversation has a terminal open");
    expect(harness.closedTerminals).toEqual([]);
    expect([...harness.journal.rows.values()][0]).toMatchObject({ state: "failed" });
  });

  it("settles the journal when a promotion is cancelled before the move", async () => {
    const harness = await makeHarness({
      sessions: [{ threadId, status: "ready", cwd: path.join(scratch, "chats", "x") }],
    });
    let markStopping!: () => void;
    const stopping = new Promise<void>((resolve) => {
      markStopping = resolve;
    });
    const hanging = makeChatPromotion({
      ...harness.dependencies,
      providers: {
        ...harness.dependencies.providers,
        stopSession: () =>
          Effect.suspend(() => {
            markStopping();
            return Effect.never;
          }),
      },
    });
    const fiber = Effect.runFork(hanging.promote(promoteInput(destinationIn(harness))));
    await stopping;
    await Effect.runPromise(Fiber.interrupt(fiber));

    const [row] = harness.journal.rows.values();
    expect(row).toMatchObject({ state: "failed", error: "cancelled before the move" });
    expect(await pathExists(harness.source)).toBe(true);
    expect(harness.project.kind).toBe("chat");
  });
});

type Harness = Awaited<ReturnType<typeof makeHarness>>;

/** The folders a destination case is built from. */
interface ChatPaths {
  readonly home: string;
  readonly chatsRoot: string;
  readonly source: string;
}

/** The same chat and journal, with a different filesystem seam. */
const makeHarnessWithFs = async (harness: Harness, fs: Partial<ChatPromotionFileSystem>) => ({
  ...harness,
  promotion: makeChatPromotion({
    ...harness.dependencies,
    fs: { ...nodeChatPromotionFileSystem, ...fs },
  }),
});

describe("promoteChatPreview", () => {
  it("suggests a free folder under ~/Code and judges it available", async () => {
    const harness = await makeHarness();
    await mkdir(path.join(harness.home, "Code", "plan-the-offsite"));
    await mkdir(path.join(harness.home, "Code", "plan-the-offsite-2"));
    const preview = await Effect.runPromise(harness.promotion.preview({ projectId }));

    expect(preview).toMatchObject({
      projectId,
      source: harness.source,
      defaultDestination: path.join(harness.home, "Code", "plan-the-offsite-3"),
      destination: path.join(harness.home, "Code", "plan-the-offsite-3"),
      destinationStatus: "available",
      fileCount: 3,
      totalBytes: "# Offsite\n".length + "Arrive\n".length,
      countTruncated: false,
      busyThreadIds: [],
      gitAvailable: false,
      gitIdentityConfigured: false,
      crossDevice: false,
    });
  });

  it("uses the Add project base directory when it is set", async () => {
    const base = path.join(scratch, "projects");
    await mkdir(base);
    const harness = await makeHarness({ addProjectBaseDirectory: base });
    const preview = await Effect.runPromise(harness.promotion.preview({ projectId }));
    expect(preview.defaultDestination).toBe(path.join(base, "plan-the-offsite"));
  });

  it.each([
    ["exists", (h: ChatPaths): string => path.join(h.home, "Code")],
    ["invalid", (_h: ChatPaths): string => "relative/path"],
    ["invalid", (_h: ChatPaths): string => ""],
    ["invalid", (h: ChatPaths): string => path.join(h.home, "missing", "x")],
    ["inside-chats", (h: ChatPaths): string => path.join(h.chatsRoot, "elsewhere")],
    ["inside-source", (h: ChatPaths): string => path.join(h.source, "nested")],
    ["available", (h: ChatPaths): string => `  ${path.join(h.home, "Code", "custom")}/  `],
  ] as const)("judges %s", async (status, destinationOf) => {
    const harness = await makeHarness();
    const preview = await Effect.runPromise(
      harness.promotion.preview({ projectId, destination: destinationOf(harness) }),
    );
    expect(preview.destinationStatus).toBe(status);
  });

  it("judges a destination at or inside a removed checkout the way storage admission does", async () => {
    const harness = await makeHarness();
    const removed = path.join(harness.home, "Code", "old-worktree");
    const moving = path.join(harness.home, "Code", "other-chat");
    const statuses = await Effect.runPromise(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        // A checkout Ryco removed: its tombstone refuses new work there forever.
        yield* sql`INSERT INTO storage_owned_entries (id, path, category, identity_json, created_at, state)
          VALUES ('removed-checkout', ${removed}, 'worktree', '{}', ${NOW}, 'removed')`;
        // Another chat moving in right now.
        yield* sql`INSERT INTO project_relocations (
            relocation_id, project_id, source_path, destination_path, strategy, state,
            destination_created, error, created_at, updated_at
          ) VALUES (
            'relocation-other', 'project-chat-2', ${path.join(harness.chatsRoot, "other")},
            ${moving}, 'rename', 'pending', 0, NULL, ${NOW}, ${NOW}
          )`;
        const promotion = makeChatPromotion({
          ...harness.dependencies,
          storageAdmission: (canonical) => storagePathBlocker(sql, canonical),
        });
        const judge = (destination: string) =>
          promotion
            .preview({ projectId, destination })
            .pipe(Effect.map((preview) => preview.destinationStatus));
        return {
          removed: yield* judge(removed),
          insideRemoved: yield* judge(path.join(removed, "app")),
          sibling: yield* judge(`${removed}-2`),
          moving: yield* judge(moving),
        };
      }).pipe(Effect.provide(SqlitePersistenceMemory)),
    );

    expect(statuses).toEqual({
      removed: "retired-checkout",
      insideRemoved: "retired-checkout",
      sibling: "available",
      moving: "exists",
    });
  });

  it("judges a destination outside the access root as access-denied", async () => {
    const allowed = path.join(scratch, "allowed");
    await mkdir(allowed);
    const harness = await makeHarness({ accessRoot: allowed });
    const preview = await Effect.runPromise(
      harness.promotion.preview({ projectId, destination: path.join(harness.home, "Code", "x") }),
    );
    expect(preview.destinationStatus).toBe("access-denied");
    // Under --restrict-to-cwd the default parent is the access root.
    expect(preview.defaultDestination).toBe(path.join(allowed, "plan-the-offsite"));
  });

  it("lists busy threads and reports Git's identity", async () => {
    const harness = await makeHarness({
      shell: idleShell({ hasPendingApprovals: true }),
      git: {
        execute: (input) =>
          Effect.succeed({
            exitCode: 0,
            stdout: input.args.includes("user.email") ? "ada@example.com\n" : "Ada\n",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          } as never),
      },
    });
    const preview = await Effect.runPromise(harness.promotion.preview({ projectId }));
    expect(preview.busyThreadIds).toEqual([threadId]);
    expect(preview.gitAvailable).toBe(true);
    expect(preview.gitIdentityConfigured).toBe(true);
  });

  it("lists a thread whose terminal runs a command as busy", async () => {
    const harness = await makeHarness({
      terminals: (folder) => [terminal({ cwd: folder, hasRunningSubprocess: true })],
    });
    const preview = await Effect.runPromise(harness.promotion.preview({ projectId }));
    expect(preview.busyThreadIds).toEqual([threadId]);
  });

  it("is read-only", async () => {
    const harness = await makeHarness({ terminals: (folder) => [terminal({ cwd: folder })] });
    await Effect.runPromise(harness.promotion.preview({ projectId }));
    expect(harness.closedTerminals).toEqual([]);
    expect(harness.journal.rows.size).toBe(0);
    expect(harness.commands).toEqual([]);
    expect(await pathExists(path.join(harness.home, "Code", "plan-the-offsite"))).toBe(false);
  });
});

describe("chatTerminalActivity", () => {
  const folder = "/chats/2026-10-08-plan-0a1b2c3d";
  const threadIds = new Set<string>([threadId]);

  it("closes a chat thread's idle shell and ignores exited and unrelated terminals", () => {
    expect(
      chatTerminalActivity({
        terminals: [
          terminal({ cwd: folder }),
          terminal({
            threadId: ThreadId.make("thread-a"),
            cwd: folder,
            status: "exited",
            pid: null,
          }),
          terminal({ threadId: ThreadId.make("thread-b"), cwd: "/code/other" }),
        ],
        threadIds,
        folder,
      }),
    ).toEqual({ busy: [], idleThreadIds: new Set([threadId]) });
  });

  it.each([
    [terminal({ cwd: folder, hasRunningSubprocess: true }), "a terminal is running a command"],
    [terminal({ cwd: folder, status: "starting", pid: null }), "a terminal is running a command"],
    [
      terminal({ threadId: ThreadId.make("thread-b"), cwd: path.join(folder, "notes") }),
      "another conversation has a terminal open in its folder",
    ],
  ] as const)("reports %o as busy", (entry, reason) => {
    expect(chatTerminalActivity({ terminals: [entry], threadIds, folder }).busy).toEqual([
      { threadId: entry.threadId, reason },
    ]);
  });
});

describe("chatThreadBusyReason", () => {
  const nowMs = Date.parse(NOW);
  it("treats an idle thread as movable", () => {
    expect(chatThreadBusyReason({ shell: idleShell(), thread: null, nowMs })).toBeNull();
  });
  it.each([
    [{ hasPendingUserInput: true }, "a question is waiting for an answer"],
    [{ backgroundLiveness: "working" }, "background work is still running"],
    [{ latestUserMessageAt: NOW }, "a message is still starting"],
  ] as const)("reports %o", (shell, reason) => {
    expect(
      chatThreadBusyReason({
        shell: idleShell(shell as Partial<OrchestrationThreadShell>),
        thread: null,
        nowMs,
      }),
    ).toBe(reason);
  });
  it("reports an active model switch", () => {
    const thread = {
      activities: [
        {
          id: "activity-1",
          kind: "context-handoff",
          tone: "info",
          summary: "Switching models",
          payload: { status: "dispatching" },
          turnId: null,
          createdAt: NOW,
        },
      ],
    } as unknown as OrchestrationThread;
    expect(chatThreadBusyReason({ shell: idleShell(), thread, nowMs })).toBe(
      "it is switching models",
    );
  });
});

describe("folder helpers", () => {
  it("copies contents without following symlinks out of the folder", async () => {
    const source = path.join(scratch, "source");
    const outside = path.join(scratch, "outside");
    const destination = path.join(scratch, "destination");
    await mkdir(path.join(source, "nested"), { recursive: true });
    await mkdir(outside);
    await mkdir(destination);
    await writeFile(path.join(outside, "secret.txt"), "secret");
    await writeFile(path.join(source, "nested", "script.sh"), "#!/bin/sh\n");
    await chmod(path.join(source, "nested", "script.sh"), 0o755);
    await symlink(outside, path.join(source, "outside-link"));

    await copyFolderContents(source, destination);

    expect(await readlink(path.join(destination, "outside-link"))).toBe(outside);
    expect((await stat(path.join(destination, "nested", "script.sh"))).mode & 0o777).toBe(0o755);
    const [original, copy] = await Promise.all([
      readTreeManifest(source),
      readTreeManifest(destination),
    ]);
    expect(sameManifest(original, copy, { compareModifiedTimes: false })).toBe(true);
    expect([...copy.keys()].some((entry) => entry.includes("secret"))).toBe(false);
  });

  it("removes a tree whose folders are read-only, as a copy keeps them", async () => {
    const tree = path.join(scratch, "copy");
    await mkdir(path.join(tree, "vendor", "pkg"), { recursive: true });
    await writeFile(path.join(tree, "vendor", "pkg", "index.js"), "module.exports = 1;\n");
    await chmod(path.join(tree, "vendor", "pkg"), 0o555);
    await chmod(path.join(tree, "vendor"), 0o555);

    await nodeChatPromotionFileSystem.removeTree(tree);

    expect(await pathExists(tree)).toBe(false);
  });

  it("notices an edit that keeps a file's size", async () => {
    const folder = path.join(scratch, "folder");
    await mkdir(folder);
    await writeFile(path.join(folder, "a.txt"), "one");
    const before = await readTreeManifest(folder);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(path.join(folder, "a.txt"), "two");
    const after = await readTreeManifest(folder);
    expect(sameManifest(before, after, { compareModifiedTimes: false })).toBe(true);
    expect(sameManifest(before, after, { compareModifiedTimes: true })).toBe(false);
  });

  it("bounds the preview scan", async () => {
    const folder = path.join(scratch, "many");
    await mkdir(folder);
    await Promise.all(
      Array.from({ length: 12 }, (_, index) => writeFile(path.join(folder, `${index}.txt`), "x")),
    );
    expect(await scanChatFolder(folder, 5)).toMatchObject({ fileCount: 5, truncated: true });
    expect(await scanChatFolder(folder, 100)).toEqual({
      fileCount: 12,
      totalBytes: 12,
      truncated: false,
    });
  });

  it("resolves the default parent folder", async () => {
    const home = path.join(scratch, "home");
    await mkdir(home);
    const parent = (input: { workspaceAccessRoot?: string; addProjectBaseDirectory?: string }) =>
      resolvePromotionParent({
        workspaceAccessRoot: input.workspaceAccessRoot,
        addProjectBaseDirectory: input.addProjectBaseDirectory ?? "",
        homeDir: home,
      });
    expect(await parent({})).toBe(home);
    await mkdir(path.join(home, "Code"));
    expect(await parent({})).toBe(path.join(home, "Code"));
    expect(await parent({ addProjectBaseDirectory: "~/Projects" })).toBe(
      path.join(homedir(), "Projects"),
    );
    expect(await parent({ workspaceAccessRoot: "/srv/root", addProjectBaseDirectory: "/x" })).toBe(
      "/srv/root",
    );
  });
});

describe("recoverProjectRelocations", () => {
  const relocationId = "relocation-recover";
  const setup = async (input: {
    readonly row: Partial<ProjectRelocation>;
    readonly source: boolean;
    readonly destination: boolean;
    /** The destination's file; the same as the source's unless given. */
    readonly destinationContents?: string;
    readonly project?: (source: string, destination: string) => ProjectionProject | null;
    readonly fs?: Partial<ChatPromotionFileSystem>;
  }) => {
    const source = path.join(scratch, "chats", "chat-folder");
    const destination = path.join(scratch, "Code", "promoted");
    await mkdir(path.dirname(source), { recursive: true });
    await mkdir(path.dirname(destination), { recursive: true });
    if (input.source) {
      await mkdir(source);
      await writeFile(path.join(source, "plan.md"), "source");
    }
    if (input.destination) {
      await mkdir(destination);
      await writeFile(path.join(destination, "plan.md"), input.destinationContents ?? "source");
    }
    let project = input.project ? input.project(source, destination) : chatProject(source);
    const journal = makeJournal();
    journal.rows.set(relocationId, {
      relocationId,
      projectId,
      sourcePath: source,
      destinationPath: destination,
      strategy: "rename",
      state: "pending",
      destinationCreated: false,
      title: null,
      error: null,
      createdAt: NOW,
      updatedAt: NOW,
      ...input.row,
    });
    const commands: OrchestrationCommand[] = [];
    await Effect.runPromise(
      recoverProjectRelocations({
        ...(input.fs ? { fs: { ...nodeChatPromotionFileSystem, ...input.fs } } : {}),
        relocations: journal.repository,
        projects: { getById: () => Effect.sync(() => Option.fromNullishOr(project)) },
        dispatch: (command) =>
          Effect.sync(() => {
            commands.push(command);
            if (command.type === "project.meta.update" && project) {
              project = {
                ...project,
                kind: command.kind ?? project.kind,
                title: command.title ?? project.title,
                workspaceRoot: command.workspaceRoot ?? project.workspaceRoot,
              };
            }
          }),
      }),
    );
    return {
      row: journal.rows.get(relocationId)!,
      commands,
      project,
      sourceExists: await pathExists(source),
      destinationExists: await pathExists(destination),
      source,
      destination,
    };
  };

  it("finishes a rename whose record was not updated", async () => {
    const result = await setup({ row: {}, source: false, destination: true });
    expect(result.row.state).toBe("done");
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0]).toMatchObject({
      type: "project.meta.update",
      kind: "project",
      workspaceRoot: result.destination,
      expectedUpdatedAt: NOW,
    });
    expect(result.project).toMatchObject({ kind: "project", workspaceRoot: result.destination });
  });

  it("finishes the promotion with the title the user chose", async () => {
    const result = await setup({
      row: { title: "Offsite planner" },
      source: false,
      destination: true,
    });
    expect(result.row.state).toBe("done");
    expect(result.commands[0]).toMatchObject({
      type: "project.meta.update",
      title: "Offsite planner",
      workspaceRoot: result.destination,
    });
    expect(result.project?.title).toBe("Offsite planner");
  });

  it("never commits an unverified copy whose source cannot be found", async () => {
    // Interrupted mid-copy; the source's volume is not mounted at this start.
    const result = await setup({
      row: { strategy: "copy", destinationCreated: true },
      source: false,
      destination: true,
      destinationContents: "partial",
    });
    expect(result.commands).toEqual([]);
    expect(result.project?.kind).toBe("chat");
    expect(result.row.state).toBe("failed");
    expect(result.row.error).toContain(result.source);
    expect(result.row.error).toContain(result.destination);
    // Possibly the only data left: never removed.
    expect(result.destinationExists).toBe(true);
  });

  it("settles an interrupted copy it cannot remove, naming what is left", async () => {
    const result = await setup({
      row: { strategy: "copy", destinationCreated: true },
      source: true,
      destination: true,
      fs: {
        removeTree: async () => {
          throw Object.assign(new Error("permission denied"), { code: "EACCES" });
        },
      },
    });
    // Settled, so storage admission lifts the fence on the chat's folder.
    expect(result.row.state).toBe("failed");
    expect(result.row.error).toContain(result.destination);
    expect(result.sourceExists).toBe(true);
    expect(result.commands).toEqual([]);
  });

  it("keeps a copied source that changed since the copy", async () => {
    const result = await setup({
      row: { strategy: "copy", destinationCreated: true, state: "moved" },
      source: true,
      destination: true,
      destinationContents: "the copy, taken before an editor saved the source",
    });
    expect(result.row.state).toBe("done");
    expect(result.commands).toHaveLength(1);
    expect(result.sourceExists).toBe(true);
    expect(result.destinationExists).toBe(true);
  });

  it("marks a move that never started as failed", async () => {
    const result = await setup({ row: {}, source: true, destination: false });
    expect(result.row.state).toBe("failed");
    expect(result.commands).toEqual([]);
    expect(result.sourceExists).toBe(true);
  });

  it("removes an interrupted copy Ryco created and keeps the source", async () => {
    const result = await setup({
      row: { strategy: "copy", destinationCreated: true },
      source: true,
      destination: true,
    });
    expect(result.row.state).toBe("failed");
    expect(result.sourceExists).toBe(true);
    expect(result.destinationExists).toBe(false);
    expect(result.commands).toEqual([]);
  });

  it("never removes a destination Ryco did not create", async () => {
    const result = await setup({ row: {}, source: true, destination: true });
    expect(result.row.state).toBe("failed");
    expect(result.sourceExists).toBe(true);
    expect(result.destinationExists).toBe(true);
  });

  it("completes a verified copy: commits the record and removes the copied source", async () => {
    const result = await setup({
      row: { strategy: "copy", destinationCreated: true, state: "moved" },
      source: true,
      destination: true,
    });
    expect(result.row.state).toBe("done");
    expect(result.sourceExists).toBe(false);
    expect(result.destinationExists).toBe(true);
    expect(result.commands).toHaveLength(1);
  });

  it("settles a move whose record was already updated without dispatching again", async () => {
    const result = await setup({
      row: { state: "moved" },
      source: false,
      destination: true,
      project: (_source, destination) => ({
        ...chatProject(destination),
        kind: "project",
      }),
    });
    expect(result.row.state).toBe("done");
    expect(result.commands).toEqual([]);
  });

  it("keeps the files when the chat was deleted meanwhile", async () => {
    const result = await setup({
      row: { state: "moved" },
      source: false,
      destination: true,
      project: () => null,
    });
    expect(result.row.state).toBe("failed");
    expect(result.row.error).toContain(result.destination);
    expect(result.destinationExists).toBe(true);
  });
});
