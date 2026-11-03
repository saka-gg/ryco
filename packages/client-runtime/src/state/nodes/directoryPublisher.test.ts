import {
  EnvironmentId,
  type AgentControlNodeDirectoryEntry,
  type AgentControlPublishNodeDirectoryInput,
} from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { NodeCatalogSnapshot } from "../workspace/nodeCatalog.js";
import {
  NODE_DIRECTORY_PUBLISH_DEBOUNCE_MS,
  nodeDirectoryEntries,
  selectNodeDirectoryTargets,
  startNodeDirectoryPublisher,
  type NodeDirectoryTarget,
} from "./directoryPublisher.js";
import type { NodeCatalogEntry } from "./types.js";

const MINI = EnvironmentId.make("env-mini");
const SERVER = EnvironmentId.make("env-server");

function node(environmentId: EnvironmentId, overrides: Partial<NodeCatalogEntry> = {}) {
  return {
    environmentId,
    label: String(environmentId),
    isPrimary: false,
    isThisDevice: false,
    presence: "online",
    platformOs: "darwin",
    iconKind: "mini-pc",
    canMutate: true,
    mutateBlockedReason: null,
    projectCopySupport: "yes",
    transport: "direct",
    lastSeenAt: null,
    ...overrides,
  } satisfies NodeCatalogEntry;
}

function entry(
  environmentId: EnvironmentId,
  overrides: Partial<AgentControlNodeDirectoryEntry> = {},
): AgentControlNodeDirectoryEntry {
  return {
    environmentId,
    label: String(environmentId),
    platformOs: "darwin",
    online: true,
    projectCopySupport: "yes",
    ...overrides,
  };
}

describe("nodeDirectoryEntries", () => {
  it("publishes only owner-held nodes, bounded to the directory's limits", () => {
    const snapshot: NodeCatalogSnapshot = {
      nodes: [
        node(MINI, { label: "  Mac mini  ", platformOs: "darwin", presence: "connecting" }),
        node(SERVER, { label: "x".repeat(200), platformOs: "freebsd", projectCopySupport: "no" }),
        node(EnvironmentId.make("env-viewer")),
        node(EnvironmentId.make("env-blank"), { label: "   " }),
        node(EnvironmentId.make("e".repeat(129))),
      ],
      ownerEnvironmentIds: new Set([
        MINI,
        SERVER,
        EnvironmentId.make("env-blank"),
        EnvironmentId.make("e".repeat(129)),
      ]),
    };
    expect(nodeDirectoryEntries(snapshot)).toEqual([
      entry(MINI, { label: "Mac mini", online: false, transport: "direct" }),
      entry(SERVER, {
        label: "x".repeat(120),
        platformOs: "unknown",
        projectCopySupport: "no",
        transport: "direct",
      }),
    ]);
  });

  it("adds how a node is reached, its code directory and its projects, when known", () => {
    const BOX = EnvironmentId.make("env-box");
    const BIG = EnvironmentId.make("env-big");
    const snapshot: NodeCatalogSnapshot = {
      nodes: [
        node(MINI, { transport: "relay" }),
        node(SERVER, { transport: null, presence: "offline" }),
        node(BOX),
        node(BIG),
      ],
      ownerEnvironmentIds: new Set([MINI, SERVER, BOX, BIG]),
    };
    const many = (count: number, prefix: string) =>
      Array.from({ length: count }, (_, index) => ({
        repositoryCanonicalKey: `github.com/me/${prefix}-${index}`,
        path: `/code/${prefix}-${index}`,
      }));
    const entries = nodeDirectoryEntries(snapshot, (environmentId) =>
      environmentId === MINI
        ? {
            defaultProjectDirectory: " /Users/me/code ",
            projects: [
              { repositoryCanonicalKey: "github.com/me/app", path: "/Users/me/code/app" },
              { repositoryCanonicalKey: "github.com/me/app", path: "/Users/me/code/app" },
              { repositoryCanonicalKey: " ", path: "/Users/me/code/blank" },
              { repositoryCanonicalKey: "github.com/me/long", path: `/${"x".repeat(2_000)}` },
            ],
          }
        : environmentId === SERVER
          ? { defaultProjectDirectory: null, projects: [] }
          : environmentId === BOX
            ? { defaultProjectDirectory: null, projects: null }
            : // More than one entry may list: not known, rather than a partial list.
              { defaultProjectDirectory: "/srv", projects: many(65, "big") },
    );
    expect(entries).toEqual([
      entry(MINI, {
        transport: "relay",
        defaultProjectDirectory: "/Users/me/code",
        projects: [{ repositoryCanonicalKey: "github.com/me/app", path: "/Users/me/code/app" }],
      }),
      // Offline: no transport; an empty project list is published as known and empty.
      entry(SERVER, { online: false, projects: [] }),
      entry(BOX, { transport: "direct" }),
      entry(BIG, { transport: "direct", defaultProjectDirectory: "/srv" }),
    ]);
  });

  it("keeps one publication's projects within its total bound, first nodes first", () => {
    const ids = Array.from({ length: 5 }, (_, index) => EnvironmentId.make(`env-${index}`));
    const entries = nodeDirectoryEntries(
      { nodes: ids.map((id) => node(id)), ownerEnvironmentIds: new Set(ids) },
      (environmentId) => ({
        defaultProjectDirectory: null,
        projects: Array.from({ length: 60 }, (_, index) => ({
          repositoryCanonicalKey: `github.com/me/${environmentId}-${index}`,
          path: `/code/${index}`,
        })),
      }),
    );
    // 4 × 60 = 240 fit the 256 total; the fifth node's 60 do not.
    expect(entries.map((value) => value.projects?.length ?? null)).toEqual([60, 60, 60, 60, null]);
  });

  it("keeps the catalog's first 64 nodes", () => {
    const ids = Array.from({ length: 70 }, (_, index) =>
      EnvironmentId.make(`env-${String(index).padStart(2, "0")}`),
    );
    const entries = nodeDirectoryEntries({
      nodes: ids.map((id) => node(id)),
      ownerEnvironmentIds: new Set(ids),
    });
    expect(entries).toHaveLength(64);
    expect(entries.at(-1)?.environmentId).toBe(ids[63]);
  });
});

describe("selectNodeDirectoryTargets", () => {
  it("calls only connected owner-held nodes that support copy and admit the call", () => {
    const ids = {
      ready: EnvironmentId.make("env-ready"),
      older: EnvironmentId.make("env-older"),
      unknown: EnvironmentId.make("env-unknown"),
      disconnected: EnvironmentId.make("env-disconnected"),
      notOwner: EnvironmentId.make("env-not-owner"),
      blocked: EnvironmentId.make("env-blocked"),
      noMethod: EnvironmentId.make("env-no-method"),
    };
    const publish = async () => ({ accepted: 1 });
    const targets = selectNodeDirectoryTargets(
      {
        nodes: [
          node(ids.ready),
          node(ids.older, { projectCopySupport: "no" }),
          node(ids.unknown, { projectCopySupport: "unknown" }),
          node(ids.disconnected, { transport: null }),
          node(ids.notOwner),
          node(ids.blocked, { transport: "relay" }),
          node(ids.noMethod),
        ],
        ownerEnvironmentIds: new Set(
          Object.values(ids).filter((environmentId) => environmentId !== ids.notOwner),
        ),
      },
      {
        // A hosted session blocked after uncertain delivery admits nothing.
        admits: (environmentId) => environmentId !== ids.blocked,
        connectionFor: (environmentId) =>
          environmentId === ids.noMethod ? null : { connection: environmentId, publish },
      },
    );
    expect(targets).toEqual([{ environmentId: ids.ready, connection: ids.ready, publish }]);
  });
});

describe("startNodeDirectoryPublisher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function harness() {
    let entries: ReadonlyArray<AgentControlNodeDirectoryEntry> = [entry(MINI)];
    let targets: NodeDirectoryTarget[] = [];
    const listeners = new Set<() => void>();
    const calls: Array<{
      environmentId: EnvironmentId;
      input: AgentControlPublishNodeDirectoryInput;
    }> = [];
    const failures: EnvironmentId[] = [];
    let respond: (environmentId: EnvironmentId) => Promise<unknown> = async () => ({ accepted: 1 });
    const target = (
      environmentId: EnvironmentId,
      connection: unknown = {},
    ): NodeDirectoryTarget => ({
      environmentId,
      connection,
      publish: (input) => {
        calls.push({ environmentId, input });
        return respond(environmentId);
      },
    });
    const stop = startNodeDirectoryPublisher({
      readEntries: () => entries,
      readTargets: () => targets,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      now: Date.now,
      setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
      clearTimeout: (timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>),
      onPublishFailed: (environmentId) => failures.push(environmentId),
    });
    return {
      calls,
      failures,
      stop,
      target,
      setEntries: (next: ReadonlyArray<AgentControlNodeDirectoryEntry>) => {
        entries = next;
      },
      setTargets: (next: NodeDirectoryTarget[]) => {
        targets = next;
      },
      respondWith: (next: (environmentId: EnvironmentId) => Promise<unknown>) => {
        respond = next;
      },
      notify: () => {
        for (const listener of Array.from(listeners)) listener();
      },
      listenerCount: () => listeners.size,
    };
  }

  it("publishes a burst of changes once, after the debounce", async () => {
    const publisher = harness();
    publisher.setTargets([publisher.target(MINI), publisher.target(SERVER)]);
    publisher.notify();
    await vi.advanceTimersByTimeAsync(500);
    publisher.notify();
    publisher.notify();
    expect(publisher.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(NODE_DIRECTORY_PUBLISH_DEBOUNCE_MS);
    expect(publisher.calls.map((call) => call.environmentId)).toEqual([MINI, SERVER]);
    expect(publisher.calls[0]?.input).toEqual({ nodes: [entry(MINI)] });

    // Nothing changed: nothing is sent again.
    publisher.notify();
    await vi.advanceTimersByTimeAsync(NODE_DIRECTORY_PUBLISH_DEBOUNCE_MS * 2);
    expect(publisher.calls).toHaveLength(2);
    publisher.stop();
  });

  it("publishes again on a changed entry list and on every new connection", async () => {
    const publisher = harness();
    const first = {};
    publisher.setTargets([publisher.target(MINI, first)]);
    await vi.advanceTimersByTimeAsync(NODE_DIRECTORY_PUBLISH_DEBOUNCE_MS);
    expect(publisher.calls).toHaveLength(1);

    publisher.setEntries([entry(MINI), entry(SERVER)]);
    publisher.notify();
    await vi.advanceTimersByTimeAsync(NODE_DIRECTORY_PUBLISH_DEBOUNCE_MS);
    expect(publisher.calls).toHaveLength(2);
    expect(publisher.calls[1]?.input.nodes).toHaveLength(2);

    // A reconnect is a new connection with the same entries.
    publisher.setTargets([publisher.target(MINI, {})]);
    publisher.notify();
    await vi.advanceTimersByTimeAsync(NODE_DIRECTORY_PUBLISH_DEBOUNCE_MS);
    expect(publisher.calls).toHaveLength(3);

    // A node that leaves the targets and returns over a new connection is sent them again.
    publisher.setTargets([]);
    publisher.notify();
    await vi.advanceTimersByTimeAsync(NODE_DIRECTORY_PUBLISH_DEBOUNCE_MS);
    publisher.setTargets([publisher.target(MINI, first)]);
    publisher.notify();
    await vi.advanceTimersByTimeAsync(NODE_DIRECTORY_PUBLISH_DEBOUNCE_MS);
    expect(publisher.calls).toHaveLength(4);
    publisher.stop();
  });

  it("keeps one call in flight per node and sends what changed meanwhile after it", async () => {
    const publisher = harness();
    let finish: () => void = () => undefined;
    publisher.respondWith(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ accepted: 1 });
        }),
    );
    publisher.setTargets([publisher.target(MINI)]);
    await vi.advanceTimersByTimeAsync(NODE_DIRECTORY_PUBLISH_DEBOUNCE_MS);
    expect(publisher.calls).toHaveLength(1);

    publisher.setEntries([entry(MINI, { online: false })]);
    publisher.notify();
    await vi.advanceTimersByTimeAsync(NODE_DIRECTORY_PUBLISH_DEBOUNCE_MS * 3);
    expect(publisher.calls).toHaveLength(1);

    publisher.respondWith(async () => ({ accepted: 1 }));
    finish();
    await vi.advanceTimersByTimeAsync(NODE_DIRECTORY_PUBLISH_DEBOUNCE_MS);
    expect(publisher.calls).toHaveLength(2);
    expect(publisher.calls[1]?.input).toEqual({ nodes: [entry(MINI, { online: false })] });
    publisher.stop();
  });

  it("backs off from a node that refuses, and retries at once when the entries change", async () => {
    const publisher = harness();
    publisher.respondWith(async () => {
      throw new Error("refused");
    });
    publisher.setTargets([publisher.target(MINI)]);
    await vi.advanceTimersByTimeAsync(NODE_DIRECTORY_PUBLISH_DEBOUNCE_MS);
    expect(publisher.calls).toHaveLength(1);
    expect(publisher.failures).toEqual([MINI]);

    // Unchanged entries wait out the backoff (30 s, then 60 s).
    publisher.notify();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(publisher.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(publisher.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(publisher.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(publisher.calls).toHaveLength(3);

    publisher.respondWith(async () => ({ accepted: 1 }));
    publisher.setEntries([entry(MINI), entry(SERVER)]);
    publisher.notify();
    await vi.advanceTimersByTimeAsync(NODE_DIRECTORY_PUBLISH_DEBOUNCE_MS);
    expect(publisher.calls).toHaveLength(4);

    // Delivered: the backoff is over.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(publisher.calls).toHaveLength(4);
    publisher.stop();
  });

  it("stops publishing and listening once stopped", async () => {
    const publisher = harness();
    publisher.setTargets([publisher.target(MINI)]);
    publisher.stop();
    expect(publisher.listenerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(NODE_DIRECTORY_PUBLISH_DEBOUNCE_MS * 5);
    expect(publisher.calls).toEqual([]);
  });
});
