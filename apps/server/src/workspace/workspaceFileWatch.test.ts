import { EventEmitter } from "node:events";
import type { FSWatcher } from "node:fs";
import * as NodeFs from "node:fs/promises";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ProjectFileChangeEvent, ProjectWatchFileError } from "@ryco/contracts";
import { Effect, Fiber, Layer, ManagedRuntime, Stream } from "effect";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ServerConfig } from "../config.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { WorkspaceAccessPolicyLayer } from "./Layers/WorkspaceAccessPolicy.ts";
import { WorkspaceEntriesLive } from "./Layers/WorkspaceEntries.ts";
import { WorkspaceFileSystemLive } from "./Layers/WorkspaceFileSystem.ts";
import { WorkspacePathsLive } from "./Layers/WorkspacePaths.ts";
import { fileVersion } from "./previewFile.ts";
import {
  WorkspaceFileSystem,
  type WorkspaceFileSystemShape,
} from "./Services/WorkspaceFileSystem.ts";
import {
  FILE_WATCH_DEBOUNCE_MS,
  FILE_WATCH_MIN_EVENT_INTERVAL_MS,
  makeFileWatchRegistry,
  MAX_FILE_WATCHES_PER_CONNECTION,
  nextFileWatchEvaluationAt,
  watchWorkspaceFile,
  type ConnectionFileWatches,
  type FileWatchRegistry,
} from "./workspaceFileWatch.ts";

const WorkspaceLayer = WorkspaceFileSystemLive.pipe(
  Layer.provide(WorkspacePathsLive),
  Layer.provide(
    WorkspaceEntriesLive.pipe(
      Layer.provide(WorkspacePathsLive),
      Layer.provide(WorkspaceAccessPolicyLayer(undefined)),
    ),
  ),
  Layer.provide(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer))),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "ryco-file-watch-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

const runtime = ManagedRuntime.make(WorkspaceLayer);
let resolveTarget: WorkspaceFileSystemShape["resolveTarget"];

beforeAll(async () => {
  resolveTarget = (await runtime.runPromise(Effect.service(WorkspaceFileSystem))).resolveTarget;
});
afterAll(() => runtime.dispose());

const temporaryRoots: string[] = [];
async function makeDirectory(): Promise<string> {
  const root = await NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "ryco-file-watch-"));
  temporaryRoots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => NodeFs.rm(root, { recursive: true, force: true })),
  );
});

const version = (contents: string) => fileVersion(Buffer.from(contents, "utf8"));

interface Watching {
  readonly events: ProjectFileChangeEvent[];
  readonly failure: () => ProjectWatchFileError | null;
  readonly ended: Promise<void>;
  readonly stop: () => Promise<void>;
}

const running = new Set<Watching>();
afterEach(async () => {
  await Promise.all([...running].map((watching) => watching.stop()));
  running.clear();
});

function watch(
  cwd: string,
  relativePath: string,
  options?: { readonly connection?: ConnectionFileWatches; readonly registry?: FileWatchRegistry },
): Watching {
  const events: ProjectFileChangeEvent[] = [];
  let failure: ProjectWatchFileError | null = null;
  const fiber = Effect.runFork(
    watchWorkspaceFile(
      {
        resolveTarget,
        connection: options?.connection ?? { active: 0 },
        ...(options?.registry ? { registry: options.registry } : {}),
      },
      { cwd, relativePath },
    ).pipe(
      Stream.runForEach((event) => Effect.sync(() => events.push(event))),
      Effect.catch((error) =>
        Effect.sync(() => {
          failure = error;
        }),
      ),
    ),
  );
  const watching: Watching = {
    events,
    failure: () => failure,
    ended: Effect.runPromise(Fiber.await(fiber)).then(() => undefined),
    stop: () => Effect.runPromise(Fiber.interrupt(fiber)).then(() => undefined),
  };
  running.add(watching);
  return watching;
}

const settle = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
const waitFor = (assertion: () => void) => vi.waitFor(assertion, { timeout: 5_000, interval: 20 });

describe("watchWorkspaceFile", () => {
  it("reports the file once its watch is in place, then each new version, a rename-over save and a delete", async () => {
    const cwd = await makeDirectory();
    await NodeFs.mkdir(NodePath.join(cwd, "src"));
    const filePath = NodePath.join(cwd, "src", "app.ts");
    await NodeFs.writeFile(filePath, "first\n");

    const watching = watch(cwd, "src/app.ts");
    await waitFor(() =>
      expect(watching.events).toEqual([{ type: "current", version: version("first\n") }]),
    );

    await NodeFs.writeFile(filePath, "second\n");
    await waitFor(() =>
      expect(watching.events.at(-1)).toEqual({ type: "changed", version: version("second\n") }),
    );

    // An editor's atomic save: a new file renamed over the old one.
    const temporary = NodePath.join(cwd, "src", ".app.ts.tmp");
    await NodeFs.writeFile(temporary, "third\n");
    await NodeFs.rename(temporary, filePath);
    await waitFor(() =>
      expect(watching.events.at(-1)).toEqual({ type: "changed", version: version("third\n") }),
    );

    await NodeFs.unlink(filePath);
    await waitFor(() => expect(watching.events.at(-1)).toEqual({ type: "deleted" }));

    await NodeFs.writeFile(filePath, "fourth\n");
    await waitFor(() =>
      expect(watching.events.at(-1)).toEqual({ type: "changed", version: version("fourth\n") }),
    );
    expect(watching.failure()).toBeNull();
  });

  it("reports nothing for a write that keeps the version", async () => {
    const cwd = await makeDirectory();
    const filePath = NodePath.join(cwd, "notes.md");
    await NodeFs.writeFile(filePath, "same\n");

    const watching = watch(cwd, "notes.md");
    await waitFor(() => expect(watching.events).toHaveLength(1));

    // The bytes a client's own save wrote: its watch event must cost that client nothing.
    await NodeFs.writeFile(filePath, "same\n");
    await settle(FILE_WATCH_MIN_EVENT_INTERVAL_MS * 3);
    expect(watching.events).toEqual([{ type: "current", version: version("same\n") }]);

    await NodeFs.writeFile(filePath, "different\n");
    await waitFor(() =>
      expect(watching.events).toEqual([
        { type: "current", version: version("same\n") },
        { type: "changed", version: version("different\n") },
      ]),
    );
  });

  it("reports a file that becomes a link out of the root as deleted, never the outside file's version", async () => {
    const cwd = await makeDirectory();
    const outside = await makeDirectory();
    await NodeFs.writeFile(NodePath.join(outside, "secret.txt"), "outside\n");
    const filePath = NodePath.join(cwd, "config.json");
    await NodeFs.writeFile(filePath, "inside\n");

    const watching = watch(cwd, "config.json");
    await waitFor(() => expect(watching.events).toHaveLength(1));

    await NodeFs.unlink(filePath);
    await NodeFs.symlink(NodePath.join(outside, "secret.txt"), filePath);
    await waitFor(() => expect(watching.events.at(-1)).toEqual({ type: "deleted" }));
    // The outside file changes and the link is touched: the watch must not follow the link.
    await NodeFs.writeFile(NodePath.join(outside, "secret.txt"), "outside, changed\n");
    await NodeFs.lutimes(filePath, new Date(), new Date());
    await settle(FILE_WATCH_MIN_EVENT_INTERVAL_MS * 3);

    const versions = watching.events.flatMap((event) =>
      event.type === "deleted" ? [] : [event.version],
    );
    expect(versions).toEqual([version("inside\n")]);
    expect(watching.events.at(-1)).toEqual({ type: "deleted" });
  });

  it.each([
    ["a parent path", "../outside.ts"],
    ["an absolute path", "/etc/hosts"],
    ["a link to a folder outside the root", "linked/secret.txt"],
  ])("refuses %s with outside-root before it watches anything", async (_label, relativePath) => {
    const cwd = await makeDirectory();
    const outside = await makeDirectory();
    await NodeFs.writeFile(NodePath.join(outside, "secret.txt"), "outside\n");
    await NodeFs.symlink(outside, NodePath.join(cwd, "linked"));
    const watchFolder = vi.fn();
    const registry = makeFileWatchRegistry({ watchFolder });

    const watching = watch(cwd, relativePath, { registry });
    await watching.ended;

    expect(watching.failure()?.reason).toBe("outside-root");
    expect(watching.events).toEqual([]);
    expect(watchFolder).not.toHaveBeenCalled();
  });

  it("fails with unavailable when the file's folder is missing", async () => {
    const cwd = await makeDirectory();

    const watching = watch(cwd, "missing/folder/app.ts");
    await watching.ended;

    expect(watching.failure()?.reason).toBe("unavailable");
  });

  it("reports the delete, then ends with unavailable, when the file's folder is removed", async () => {
    const cwd = await makeDirectory();
    await NodeFs.mkdir(NodePath.join(cwd, "src"));
    await NodeFs.writeFile(NodePath.join(cwd, "src", "app.ts"), "first\n");

    const watching = watch(cwd, "src/app.ts");
    await waitFor(() => expect(watching.events).toHaveLength(1));
    await NodeFs.rm(NodePath.join(cwd, "src"), { recursive: true });
    await watching.ended;

    expect(watching.events.at(-1)).toEqual({ type: "deleted" });
    expect(watching.failure()?.reason).toBe("unavailable");
  });
});

class FakeWatcher extends EventEmitter {
  readonly close = vi.fn();
}

function fakeRegistry(options?: { readonly maxDirectories?: number }) {
  const watchers = new Map<string, FakeWatcher>();
  const notify = new Map<string, (filename: string | null) => void>();
  const watchFolder = vi.fn((directory: string, onEvent: (filename: string | null) => void) => {
    const watcher = new FakeWatcher();
    watchers.set(directory, watcher);
    notify.set(directory, onEvent);
    return watcher as unknown as FSWatcher;
  });
  const registry = makeFileWatchRegistry({
    watchFolder,
    ...(options?.maxDirectories === undefined ? {} : { maxDirectories: options.maxDirectories }),
  });
  return { registry, watchFolder, watchers, notify };
}

describe("file watch registry", () => {
  it("shares one folder watch between subscribers and closes it after the last ends", async () => {
    const cwd = await makeDirectory();
    await NodeFs.writeFile(NodePath.join(cwd, "a.ts"), "a\n");
    await NodeFs.writeFile(NodePath.join(cwd, "b.ts"), "b\n");
    const fake = fakeRegistry();

    // Two connections on one file, and a sibling file in the same folder.
    const first = watch(cwd, "a.ts", { registry: fake.registry });
    const second = watch(cwd, "a.ts", { registry: fake.registry });
    const sibling = watch(cwd, "b.ts", { registry: fake.registry });
    await waitFor(() => {
      expect(first.events).toHaveLength(1);
      expect(second.events).toHaveLength(1);
      expect(sibling.events).toHaveLength(1);
    });

    expect(fake.watchFolder).toHaveBeenCalledTimes(1);
    expect(fake.watchFolder).toHaveBeenCalledWith(await NodeFs.realpath(cwd), expect.any(Function));
    expect(fake.registry.watchedDirectories()).toBe(1);
    const [watcher] = [...fake.watchers.values()];

    await first.stop();
    await sibling.stop();
    expect(watcher?.close).not.toHaveBeenCalled();
    await second.stop();
    expect(watcher?.close).toHaveBeenCalledOnce();
    expect(fake.registry.watchedDirectories()).toBe(0);
  });

  it("delivers a folder's events by name", async () => {
    const cwd = await makeDirectory();
    const filePath = NodePath.join(cwd, "a.ts");
    await NodeFs.writeFile(filePath, "a\n");
    const fake = fakeRegistry();
    const watching = watch(cwd, "a.ts", { registry: fake.registry });
    await waitFor(() => expect(watching.events).toHaveLength(1));
    const notify = fake.notify.get(await NodeFs.realpath(cwd));

    await NodeFs.writeFile(filePath, "changed\n");
    notify?.("b.ts");
    await settle(FILE_WATCH_MIN_EVENT_INTERVAL_MS * 2);
    expect(watching.events).toHaveLength(1);

    notify?.("a.ts");
    await waitFor(() =>
      expect(watching.events.at(-1)).toEqual({ type: "changed", version: version("changed\n") }),
    );

    // An event about the folder itself (it was removed or renamed) reaches every file in it.
    await NodeFs.writeFile(filePath, "again\n");
    notify?.(NodePath.basename(await NodeFs.realpath(cwd)));
    await waitFor(() =>
      expect(watching.events.at(-1)).toEqual({ type: "changed", version: version("again\n") }),
    );
  });

  it("ends a subscription with unavailable when its folder's watch fails", async () => {
    const cwd = await makeDirectory();
    await NodeFs.writeFile(NodePath.join(cwd, "a.ts"), "a\n");
    const fake = fakeRegistry();
    const watching = watch(cwd, "a.ts", { registry: fake.registry });
    await waitFor(() => expect(watching.events).toHaveLength(1));

    const watcher = fake.watchers.get(await NodeFs.realpath(cwd));
    watcher?.emit("error", new Error("watch stopped"));
    await watching.ended;

    expect(watching.failure()?.reason).toBe("unavailable");
    expect(fake.registry.watchedDirectories()).toBe(0);
    expect(watcher?.close).toHaveBeenCalledOnce();
    // A late error from the closed watch is ignored, never thrown.
    expect(() => watcher?.emit("error", new Error("late"))).not.toThrow();
  });

  it("refuses a connection's extra watch and a folder past the node's cap with limit", async () => {
    const cwd = await makeDirectory();
    await NodeFs.mkdir(NodePath.join(cwd, "other"));
    await NodeFs.writeFile(NodePath.join(cwd, "a.ts"), "a\n");
    await NodeFs.writeFile(NodePath.join(cwd, "other", "b.ts"), "b\n");
    const fake = fakeRegistry({ maxDirectories: 1 });

    const connection: ConnectionFileWatches = { active: MAX_FILE_WATCHES_PER_CONNECTION };
    const overConnection = watch(cwd, "a.ts", { registry: fake.registry, connection });
    await overConnection.ended;
    expect(overConnection.failure()?.reason).toBe("limit");
    expect(connection.active).toBe(MAX_FILE_WATCHES_PER_CONNECTION);

    const own: ConnectionFileWatches = { active: 0 };
    const admitted = watch(cwd, "a.ts", { registry: fake.registry, connection: own });
    await waitFor(() => expect(admitted.events).toHaveLength(1));
    expect(own.active).toBe(1);
    const overNode = watch(cwd, "other/b.ts", { registry: fake.registry, connection: own });
    await overNode.ended;
    expect(overNode.failure()?.reason).toBe("limit");
    expect(own.active).toBe(1);

    await admitted.stop();
    expect(own.active).toBe(0);
  });
});

describe("nextFileWatchEvaluationAt", () => {
  it("waits for a quiet moment, but not forever, and spaces evaluations", () => {
    const at = (firstSignalAt: number, lastSignalAt: number, lastEvaluationAt: number) =>
      nextFileWatchEvaluationAt({ firstSignalAt, lastSignalAt, lastEvaluationAt });
    // One event long after the last evaluation: after the debounce.
    expect(at(1_000, 1_000, 0)).toBe(1_000 + FILE_WATCH_DEBOUNCE_MS);
    // A burst extends the debounce...
    expect(at(1_000, 1_080, 0)).toBe(1_080 + FILE_WATCH_DEBOUNCE_MS);
    // ...but a file that keeps changing is evaluated at most this late.
    expect(at(1_000, 1_200, 0)).toBe(1_000 + FILE_WATCH_MIN_EVENT_INTERVAL_MS);
    // Never sooner than the interval after the previous evaluation.
    expect(at(1_000, 1_000, 900)).toBe(900 + FILE_WATCH_MIN_EVENT_INTERVAL_MS);
  });
});
