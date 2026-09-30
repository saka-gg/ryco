import type {
  VcsStatusLocalResult,
  VcsStatusRemoteResult,
  VcsStatusStreamEvent,
} from "@ryco/contracts";
import { WS_METHODS } from "@ryco/contracts";
import { Effect } from "effect";
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
      ],
      [
        {
          ...baseLocalStatus,
          ...baseRemoteStatus,
        },
      ],
      [
        {
          ...baseLocalStatus,
          ...baseRemoteStatus,
          hasWorkingTreeChanges: true,
        },
      ],
    ]);
    expect(client.isHeartbeatFresh()).toBe(true);
  });
});

it("negotiates usage capability before sending a literal version request to an old node", async () => {
  const usage = vi.fn(() => Effect.die("v1 schema should never receive a v2 request"));
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
  expect(config).toHaveBeenCalledOnce();
  expect(usage).not.toHaveBeenCalled();
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
