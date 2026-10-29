import type {
  VcsStatusLocalResult,
  VcsStatusRemoteResult,
  VcsStatusStreamEvent,
} from "@ryco/contracts";
import { WS_METHODS } from "@ryco/contracts";
import { GitManagerError } from "@ryco/contracts/git";
import { Effect, Stream } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("./wsTransport.ts", () => ({
  WsTransport: class WsTransport {
    dispose = vi.fn(async () => undefined);
    reconnect = vi.fn(async () => undefined);
    request = vi.fn();
    requestStream = vi.fn();
    subscribe = vi.fn(() => () => undefined);
  },
}));

import { createWsRpcClient } from "./wsRpcClient.ts";
import { type WsTransport } from "./wsTransport.ts";

const baseLocalStatus: VcsStatusLocalResult = {
  isRepo: true,
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "feature/demo",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
};

const baseRemoteStatus: VcsStatusRemoteResult = {
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
};

describe("wsRpcClient", () => {
  it("bounds guarded terminal RPC waits without replaying the write", async () => {
    vi.useFakeTimers();
    try {
      const wire = vi.fn(() => Effect.never);
      const transport = {
        request: (invoke: (client: unknown) => Effect.Effect<unknown>) =>
          Effect.runPromise(invoke({ [WS_METHODS.terminalWrite]: wire })),
      };
      const client = createWsRpcClient(transport as unknown as WsTransport);
      const result = expect(
        client.terminal.write({
          threadId: "synthetic-thread",
          terminalId: "new-pane",
          data: "\x1b[200~printf 'a'\x1b[201~",
          guard: {
            inputEpoch: "process",
            outputCursor: { generation: "server", sequence: 1 },
            cwd: "/synthetic/workspace",
            worktreePath: null,
          },
        }),
      ).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(10_000);
      await result;
      expect(wire).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
  it("calls the source-control merge wire method", async () => {
    const mergeWireMethod = vi.fn(() => Effect.succeed({ outcome: "enqueued" as const }));
    const transport = {
      dispose: vi.fn(async () => undefined),
      isHeartbeatFresh: vi.fn(() => true),
      reconnect: vi.fn(async () => undefined),
      request: vi.fn((invoke: (client: unknown) => Effect.Effect<unknown>) =>
        Effect.runPromise(
          invoke({ [WS_METHODS.sourceControlMergeChangeRequest]: mergeWireMethod }),
        ),
      ),
      requestStream: vi.fn(),
      subscribe: vi.fn(() => () => undefined),
    };
    const client = createWsRpcClient(transport as unknown as WsTransport);
    await expect(
      client.sourceControl.mergeChangeRequest({
        cwd: "/repo",
        reference: "42",
        mergeMethod: "squash",
      }),
    ).resolves.toEqual({ outcome: "enqueued" });
    expect(mergeWireMethod).toHaveBeenCalledWith({
      cwd: "/repo",
      reference: "42",
      mergeMethod: "squash",
    });
  });

  it("calls the worktree notes wire methods", async () => {
    const snapshot = { projectId: "project", notes: [], limit: 500, truncated: false };
    const listWireMethod = vi.fn(() => Effect.succeed(snapshot));
    const commandWireMethod = vi.fn(() => Effect.succeed(snapshot));
    const transport = {
      request: vi.fn((invoke: (client: unknown) => Effect.Effect<unknown>) =>
        Effect.runPromise(
          invoke({
            [WS_METHODS.notesList]: listWireMethod,
            [WS_METHODS.notesCommand]: commandWireMethod,
          }),
        ),
      ),
    };
    const client = createWsRpcClient(transport as unknown as WsTransport);
    await expect(client.notes.list({ projectId: "project" as never })).resolves.toEqual(snapshot);
    expect(listWireMethod).toHaveBeenCalledWith({ projectId: "project" });
    const command = {
      kind: "delete",
      noteId: "note",
      projectId: "project",
      expectedRevision: 3,
    } as const;
    await expect(client.notes.command(command as never)).resolves.toEqual(snapshot);
    expect(commandWireMethod).toHaveBeenCalledWith(command);
    expect(transport.request).toHaveBeenCalledTimes(2);
  });

  it("passes the daily recap caller's abort signal to the transport", async () => {
    const recapWireMethod = vi.fn(() => Effect.succeed({ date: "2026-10-23" }));
    const transport = {
      request: vi.fn((invoke: (client: unknown) => Effect.Effect<unknown>, _options?: unknown) =>
        Effect.runPromise(invoke({ [WS_METHODS.serverGetDailyRecap]: recapWireMethod })),
      ),
    };
    const client = createWsRpcClient(transport as unknown as WsTransport);
    const input = { date: "2026-10-23", timeZone: "Europe/Berlin" };
    const controller = new AbortController();
    await client.server.getDailyRecap(input, { signal: controller.signal });
    await client.server.getDailyRecap(input);
    expect(recapWireMethod).toHaveBeenCalledWith(input);
    expect(transport.request.mock.calls.map((call) => call[1])).toEqual([
      { signal: controller.signal },
      undefined,
    ]);
  });

  it("reduces vcs status stream events into flat status snapshots", () => {
    const subscribe = vi.fn(<TValue>(_connect: unknown, listener: (value: TValue) => void) => {
      for (const event of [
        {
          _tag: "snapshot",
          local: baseLocalStatus,
          remote: null,
        },
        {
          _tag: "remoteUpdated",
          remote: baseRemoteStatus,
        },
        {
          _tag: "localUpdated",
          local: {
            ...baseLocalStatus,
            hasWorkingTreeChanges: true,
          },
        },
      ] satisfies VcsStatusStreamEvent[]) {
        listener(event as TValue);
      }
      return () => undefined;
    });

    const transport = {
      dispose: vi.fn(async () => undefined),
      isHeartbeatFresh: vi.fn(() => true),
      reconnect: vi.fn(async () => undefined),
      request: vi.fn(),
      requestStream: vi.fn(),
      subscribe,
    } satisfies Pick<
      WsTransport,
      "dispose" | "isHeartbeatFresh" | "reconnect" | "request" | "requestStream" | "subscribe"
    >;

    const client = createWsRpcClient(transport as unknown as WsTransport);
    const listener = vi.fn();

    client.vcs.onStatus({ cwd: "/repo" }, listener);

    expect(listener.mock.calls).toEqual([
      [
        {
          ...baseLocalStatus,
          hasUpstream: false,
          aheadCount: 0,
          behindCount: 0,
          aheadOfDefaultCount: 0,
          pr: null,
        },
        { remoteKnown: false },
      ],
      [
        {
          ...baseLocalStatus,
          ...baseRemoteStatus,
        },
        { remoteKnown: true },
      ],
      [
        {
          ...baseLocalStatus,
          ...baseRemoteStatus,
          hasWorkingTreeChanges: true,
        },
        { remoteKnown: true },
      ],
    ]);
    expect(client.isHeartbeatFresh()).toBe(true);
  });
});

it("turns an old node's request decoding defect into an update instruction, without a config round trip", async () => {
  // A v1 node's literal payload schema rejects the v2 request before any handler runs.
  const usage = vi.fn(() => Effect.die('Expected 1, got 2\n  at ["contractVersion"]'));
  const config = vi.fn(() => Effect.succeed({}));
  const transport = {
    request: (invoke: (client: unknown) => Effect.Effect<unknown>) =>
      Effect.runPromise(
        invoke({ [WS_METHODS.serverGetConfig]: config, [WS_METHODS.serverGetUsageSummary]: usage }),
      ),
  };
  const client = createWsRpcClient(transport as unknown as WsTransport);
  await expect(
    client.server.getUsageSummary({ contractVersion: 2, endDate: "2026-08-10", timeZone: "UTC" }),
  ).rejects.toThrow("Update Ryco");
  expect(config).not.toHaveBeenCalled();
  expect(usage).toHaveBeenCalledOnce();
});
it("turns response version decoding failures into an update instruction without a schema dump", async () => {
  const transport = {
    request: (invoke: (client: unknown) => Effect.Effect<unknown>) =>
      Effect.runPromise(
        invoke({
          [WS_METHODS.serverGetConfig]: () => Effect.succeed({ usageContractVersion: 2 }),
          [WS_METHODS.serverGetUsageSummary]: () =>
            Effect.fail(new Error("Schema decode: contractVersion expected 2, actual 1")),
        }),
      ),
  };
  const client = createWsRpcClient(transport as unknown as WsTransport);
  await expect(
    client.server.getUsageSummary({ contractVersion: 2, endDate: "2026-08-10", timeZone: "UTC" }),
  ).rejects.toThrow("Update Ryco");
});

it("routes content search to its wire method with the caller's abort signal", async () => {
  const searchContent = vi.fn(() => Effect.succeed({ matches: [] }));
  const requestOptions: unknown[] = [];
  const transport = {
    request: (invoke: (client: unknown) => Effect.Effect<unknown>, options?: unknown) => {
      requestOptions.push(options);
      return Effect.runPromise(invoke({ [WS_METHODS.projectsSearchContent]: searchContent }));
    },
  } as unknown as WsTransport;
  const client = createWsRpcClient(transport);
  const input = { cwd: "/repo", query: "needle", limit: 200, cursor: "v1:a.ts" };
  const controller = new AbortController();
  await expect(
    client.projects.searchContent(input, { signal: controller.signal }),
  ).resolves.toEqual({ matches: [] });
  await client.projects.searchContent(input);
  expect(searchContent).toHaveBeenCalledWith(input);
  expect(requestOptions).toEqual([{ signal: controller.signal }, undefined]);
});

it("routes import source selection and reconciliation through the shared transport", async () => {
  const sources = vi.fn(() => Effect.succeed([]));
  const reconcile = vi.fn(() => Effect.succeed({ state: "unknown" }));
  const adopt = vi.fn(() => Effect.succeed({ threadId: "saved-copy", alreadyImported: false }));
  const wire = {
    [WS_METHODS.sessionImportSources]: sources,
    [WS_METHODS.sessionImportReconcile]: reconcile,
    [WS_METHODS.sessionImportAdopt]: adopt,
  };
  const transport = {
    request: (invoke: (client: unknown) => Effect.Effect<unknown>) =>
      Effect.runPromise(invoke(wire)),
  } as unknown as WsTransport;
  const client = createWsRpcClient(transport);
  const input = { source: "codex" as const, key: "a".repeat(64) };
  await client.sessionImport.sources({ source: input.source });
  await client.sessionImport.reconcile({ ...input, cursor: "server-cursor" });
  await client.sessionImport.adopt({ ...input, adoptionToken: "server-proof" });
  expect(sources).toHaveBeenCalledWith({ source: "codex" });
  expect(reconcile).toHaveBeenCalledWith({ ...input, cursor: "server-cursor" });
  expect(adopt).toHaveBeenCalledWith({ ...input, adoptionToken: "server-proof" });
});

it("routes thread forks to the threads.fork wire method", async () => {
  const fork = vi.fn(() =>
    Effect.succeed({
      threadId: "fork-thread",
      projectId: "project",
      replayed: false,
      providerContext: "native",
      checkout: { kind: "current-checkout", worktreePath: null, branch: "main" },
      notices: [],
    }),
  );
  const transport = {
    request: (invoke: (client: unknown) => Effect.Effect<unknown>) =>
      Effect.runPromise(invoke({ [WS_METHODS.threadsFork]: fork })),
  } as unknown as WsTransport;
  const client = createWsRpcClient(transport);
  const input = {
    forkKey: "fork-0123456789abcdef",
    sourceThreadId: "source",
    sourceMessageId: "reply",
    destination: { kind: "current-checkout" as const },
  } as Parameters<typeof client.threads.fork>[0];
  await expect(client.threads.fork(input)).resolves.toMatchObject({ threadId: "fork-thread" });
  expect(fork).toHaveBeenCalledWith(input);
});

describe("git stacked actions", () => {
  const actionInput = {
    actionId: "6f1c0d3e-8a5b-4c2d-9e7f-1a2b3c4d5e6f",
    cwd: "/repo",
    action: "create_pr" as const,
  };
  const base = { actionId: actionInput.actionId, cwd: "/repo", action: "create_pr" as const };
  const result = { action: "create_pr", pr: { status: "created" } };
  const started = { ...base, kind: "action_started", phases: ["pr"] };
  const finished = { ...base, kind: "action_finished", result };
  const linkFailure = new GitManagerError({
    operation: "git.runStackedAction",
    detail: "Failed to load worktree for pull request link update",
  });

  function streamTransport(wire: Record<string, (input: unknown) => unknown>) {
    return {
      request: (invoke: (client: unknown) => Effect.Effect<unknown>) =>
        Effect.runPromise(invoke(wire)),
      requestStream: (
        connect: (client: unknown) => Stream.Stream<unknown, Error>,
        listener: (value: unknown) => void,
      ) =>
        Effect.runPromise(
          Stream.runForEach(connect(wire), (value) => Effect.sync(() => listener(value))),
        ),
    } as unknown as WsTransport;
  }

  it("keeps the reported result when the stream fails after action_finished", async () => {
    const run = vi.fn(() =>
      Stream.concat(Stream.make(started, finished), Stream.fail(linkFailure)),
    );
    const client = createWsRpcClient(streamTransport({ [WS_METHODS.gitRunStackedAction]: run }));
    const progress: unknown[] = [];

    await expect(
      client.git.runStackedAction(actionInput, { onProgress: (event) => progress.push(event) }),
    ).resolves.toEqual(result);
    expect(progress).toEqual([started, finished]);
    expect(run).toHaveBeenCalledWith(actionInput);
  });

  it("keeps the reported result when the progress handler throws on it", async () => {
    const client = createWsRpcClient(
      streamTransport({ [WS_METHODS.gitRunStackedAction]: () => Stream.make(started, finished) }),
    );

    await expect(
      client.git.runStackedAction(actionInput, {
        onProgress: (event) => {
          if (event.kind === "action_finished") throw new Error("notice failed");
        },
      }),
    ).resolves.toEqual(result);
  });

  it("fails with the stream's failure when no result was reported", async () => {
    const client = createWsRpcClient(
      streamTransport({
        [WS_METHODS.gitRunStackedAction]: () =>
          Stream.concat(Stream.make(started), Stream.fail(linkFailure)),
      }),
    );
    await expect(client.git.runStackedAction(actionInput)).rejects.toBe(linkFailure);

    const silent = createWsRpcClient(
      streamTransport({ [WS_METHODS.gitRunStackedAction]: () => Stream.make(started) }),
    );
    await expect(silent.git.runStackedAction(actionInput)).rejects.toThrow(
      "Git action stream completed without a final result.",
    );
  });

  it("follows and stops an action through their own wire methods", async () => {
    const resume = vi.fn(() =>
      Stream.concat(Stream.make(started, finished), Stream.fail(linkFailure)),
    );
    const cancel = vi.fn(() => Effect.succeed({ cancelled: true }));
    const run = vi.fn(() => Stream.empty);
    const client = createWsRpcClient(
      streamTransport({
        [WS_METHODS.gitRunStackedAction]: run,
        [WS_METHODS.gitResumeStackedAction]: resume,
        [WS_METHODS.gitCancelStackedAction]: cancel,
      }),
    );
    const progress: unknown[] = [];

    await expect(
      client.git.resumeStackedAction(actionInput, { onProgress: (event) => progress.push(event) }),
    ).resolves.toEqual(result);
    expect(resume).toHaveBeenCalledWith(actionInput);
    expect(progress).toEqual([started, finished]);
    await expect(
      client.git.cancelStackedAction({ actionId: actionInput.actionId }),
    ).resolves.toEqual({ cancelled: true });
    expect(cancel).toHaveBeenCalledWith({ actionId: actionInput.actionId });
    expect(run).not.toHaveBeenCalled();
  });
});
