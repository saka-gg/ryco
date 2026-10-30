import type { KVService } from "@ryco/client-runtime/platform";
import { useWorktreeLaunchStore } from "@ryco/client-runtime/state/worktree-setup";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ThreadId,
  type ClientOrchestrationCommand,
} from "@ryco/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { createNewTaskAttempt, type NewTaskStableIds } from "./newTaskController";
import {
  deriveNewTaskLaunchView,
  newTaskLaunchKey,
  queueNewTaskLaunch,
  readNewTaskLaunch,
  readNewTaskLaunchDraftForEdit,
  useNewTaskLaunchStore,
  type NewTaskLaunch,
  type NewTaskLaunchDeps,
  type NewTaskLaunchDraft,
} from "./newTaskLaunch";
import { buildWaitingTaskRows } from "./newTaskLaunchStore";
import { createNewTaskOutboxPersistence, drainNewTaskOutbox } from "./newTaskOutbox";

const STORAGE_KEY = "ryco.newTaskOutbox.v1";
const away = EnvironmentId.make("environment-away");
const other = EnvironmentId.make("environment-other");

function ids(suffix: string): NewTaskStableIds {
  return {
    projectId: ProjectId.make(`project-${suffix}`),
    projectCommandId: CommandId.make(`command-project-${suffix}`),
    threadId: ThreadId.make(`thread-${suffix}`),
    threadCommandId: CommandId.make(`command-thread-${suffix}`),
    attachCommandId: CommandId.make(`command-attach-${suffix}`),
    turnCommandId: CommandId.make(`command-turn-${suffix}`),
    messageId: MessageId.make(`message-${suffix}`),
  };
}

function attempt(environmentId: EnvironmentId, suffix: string, createdAt: string) {
  return createNewTaskAttempt({
    environmentId,
    prompt: `Task ${suffix}`,
    project: { kind: "existing", projectId: ProjectId.make("project"), workspaceRoot: "/code/app" },
    worktree: { kind: "local" },
    createdAt,
    ids: ids(suffix),
  });
}

function draft(environmentId: EnvironmentId, prompt: string): NewTaskLaunchDraft {
  return {
    environmentId,
    projectId: ProjectId.make("project"),
    newProjectPath: "",
    newProjectTitle: "",
    worktree: { kind: "local" },
    newBranch: "",
    baseBranch: "",
    prompt,
    attachments: [],
    modelSelection: { instanceId: "codex", model: "gpt-5.6-sol" } as never,
    runtimeMode: "full-access",
    interactionMode: "default",
  };
}

function queue(environmentId: EnvironmentId, suffix: string, createdAt: string): string {
  return queueNewTaskLaunch({
    attempt: attempt(environmentId, suffix, createdAt),
    draft: draft(environmentId, `Task ${suffix}`),
  });
}

function memoryKv(initial?: Record<string, string>) {
  const values = new Map(Object.entries(initial ?? {}));
  const kv: KVService = {
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => {
      values.set(key, value);
    },
    removeItem: async (key) => {
      values.delete(key);
    },
  };
  return { kv, values };
}

function node() {
  const commands: ClientOrchestrationCommand[] = [];
  const deps: NewTaskLaunchDeps = {
    feedApi: { vcs: {} } as never,
    newCommandId: () => CommandId.make("command-fresh"),
    controller: {
      dispatch: async (command) => {
        commands.push(command);
      },
      waitForProject: async () => undefined,
      waitForThread: async () => undefined,
    },
  };
  return { deps, commands };
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  useNewTaskLaunchStore.setState({ launchesByKey: {} });
  useWorktreeLaunchStore.setState({ launchesByKey: {} });
});

describe("New Task outbox", () => {
  it("keeps a task for an away machine on the device, sending nothing", () => {
    const key = queue(away, "a", "2026-10-30T08:00:00.000Z");
    const launch = readNewTaskLaunch(key)!;
    expect(launch.status).toBe("queued");
    expect(
      deriveNewTaskLaunchView({
        launch,
        worktreeLaunch: null,
        threadHasMessages: false,
        machineLabel: "Studio Mac",
      }),
    ).toMatchObject({
      queued: true,
      statusLabel: "Queued: starts when Studio Mac is back",
      canRetry: false,
      canEdit: true,
      canRemove: true,
    });
    // Nothing was sent, so the draft can come back as it was.
    expect(readNewTaskLaunchDraftForEdit(key)?.prompt).toBe("Task a");
  });

  it("starts queued tasks only on a machine that is live, under the ids they were written with", async () => {
    const awayKey = queue(away, "a", "2026-10-30T08:00:00.000Z");
    const otherKey = queue(other, "b", "2026-10-30T08:01:00.000Z");
    const remote = node();

    const started = drainNewTaskOutbox({
      isEnvironmentReady: (environmentId) => environmentId === away,
      depsFor: () => remote.deps,
    });
    expect(started).toBe(1);
    await settle();

    expect(readNewTaskLaunch(awayKey)?.status).toBe("started");
    expect(readNewTaskLaunch(otherKey)?.status).toBe("queued");
    expect(remote.commands.map((command) => command.commandId)).toEqual([
      "command-thread-a",
      "command-turn-a",
    ]);
    // A second pass finds nothing left to start for that machine.
    expect(
      drainNewTaskOutbox({
        isEnvironmentReady: (environmentId) => environmentId === away,
        depsFor: () => remote.deps,
      }),
    ).toBe(0);
  });

  it("writes what the node has not taken yet and brings it back after a restart", async () => {
    const storage = memoryKv();
    const first = createNewTaskOutboxPersistence(storage.kv);
    disposers.push(first.dispose);
    await first.hydrate();
    const key = queue(away, "a", "2026-10-30T08:00:00.000Z");
    await settle();
    const written = JSON.parse(storage.values.get(STORAGE_KEY)!);
    expect(written.version).toBe(1);
    expect(written.launches.map((launch: NewTaskLaunch) => [launch.key, launch.status])).toEqual([
      [key, "queued"],
    ]);

    // The app restarts.
    first.dispose();
    useNewTaskLaunchStore.setState({ launchesByKey: {} });
    const second = createNewTaskOutboxPersistence(storage.kv);
    disposers.push(second.dispose);
    await second.hydrate();
    expect(readNewTaskLaunch(key)).toMatchObject({
      status: "queued",
      queuedAt: written.launches[0].queuedAt,
    });
    expect(readNewTaskLaunch(key)?.attempt.ids).toEqual(ids("a"));
  });

  it("starts a launch the app stopped mid-way again, and never hands it back for editing", async () => {
    const key = newTaskLaunchKey(away, ThreadId.make("thread-a"));
    const starting = {
      key,
      attempt: attempt(away, "a", "2026-10-30T08:00:00.000Z"),
      draft: draft(away, "Task a"),
      status: "starting",
      failure: null,
      queuedAt: "2026-10-30T08:00:00.000Z",
    };
    const storage = memoryKv({
      [STORAGE_KEY]: JSON.stringify({ version: 1, launches: [starting] }),
    });
    const persistence = createNewTaskOutboxPersistence(storage.kv);
    disposers.push(persistence.dispose);
    await persistence.hydrate();

    expect(readNewTaskLaunch(key)).toMatchObject({ status: "queued", interrupted: true });
    // Some of its commands may be on the node already.
    expect(readNewTaskLaunchDraftForEdit(key)).toBeNull();
  });

  it("drops stored entries it cannot read and keeps a launch already in memory", async () => {
    const inMemory = queue(away, "a", "2026-10-30T08:00:00.000Z");
    const stored = {
      key: inMemory,
      attempt: { ...attempt(away, "a", "2026-10-30T07:00:00.000Z"), prompt: "Older copy" },
      draft: draft(away, "Older copy"),
      status: "queued",
      failure: null,
      queuedAt: "2026-10-30T07:00:00.000Z",
    };
    const storage = memoryKv({
      [STORAGE_KEY]: JSON.stringify({
        version: 1,
        launches: [
          stored,
          { key: "x", status: "queued" },
          { ...stored, key: "mismatched", status: "queued" },
          { ...stored, key: newTaskLaunchKey(away, ThreadId.make("thread-a")), status: "started" },
        ],
      }),
    });
    const persistence = createNewTaskOutboxPersistence(storage.kv);
    disposers.push(persistence.dispose);
    await persistence.hydrate();

    expect(Object.keys(useNewTaskLaunchStore.getState().launchesByKey)).toEqual([inMemory]);
    expect(readNewTaskLaunch(inMemory)?.attempt.prompt).toBe("Task a");
  });

  it("ignores a stored outbox from another version", async () => {
    const storage = memoryKv({
      [STORAGE_KEY]: JSON.stringify({ version: 2, launches: [{ anything: true }] }),
    });
    const persistence = createNewTaskOutboxPersistence(storage.kv);
    disposers.push(persistence.dispose);
    await persistence.hydrate();
    expect(useNewTaskLaunchStore.getState().launchesByKey).toEqual({});
  });

  it("lists waiting tasks for Home, oldest first, with their machine", () => {
    queue(other, "b", "2026-10-30T08:01:00.000Z");
    queue(away, "a", "2026-10-30T08:00:00.000Z");
    const rows = buildWaitingTaskRows({
      launches: useNewTaskLaunchStore.getState().launchesByKey,
      machineLabel: (environmentId) => (environmentId === away ? "Studio Mac" : null),
    });
    expect(rows.map((row) => [row.title, row.detail, row.failed])).toEqual([
      ["Task a", "Starts when Studio Mac is back", false],
      ["Task b", "Starts when its machine is back", false],
    ]);
  });
});
