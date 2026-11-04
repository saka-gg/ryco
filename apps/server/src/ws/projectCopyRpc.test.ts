import { PROJECT_COPY_WS_METHODS } from "@ryco/contracts";
import {
  PROJECT_COPY_CHUNK_BYTES,
  PROJECT_COPY_DIRECT_CHUNK_BYTES,
  ProjectExportId,
  type ProjectCopyError,
  type ProjectExportStartInput,
} from "@ryco/contracts/project-copy";
import { expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";

import { authorizeRpcPrincipal } from "../auth/wsAuthorization.ts";
import type { ProjectCopyCallerChannel } from "../projectCopy/callerChannel.ts";
import type { NodePathsShape } from "../projectCopy/Services/NodePaths.ts";
import type {
  ProjectExportShape,
  ProjectExportStartRequest,
} from "../projectCopy/Services/ProjectExport.ts";
import type { ProjectTransfersShape } from "../projectCopy/Services/ProjectTransfers.ts";
import type { WsRpcContext } from "./context.ts";
import {
  makeProjectCopyHandlers,
  projectCopyCallerChannel,
  projectCopyMaxChunkBytes,
} from "./projectCopyRpc.ts";
import { rpcAccessFor } from "./RpcAccessPolicy.ts";
import { relayRpcPrincipal, type RpcConnectionFacts, type RpcPrincipal } from "./RpcPrincipal.ts";

type ProjectCopyServices = WsRpcContext["projectCopy"];

const noServices: ProjectCopyServices = {
  nodePaths: Option.none(),
  gitNetwork: Option.none(),
  projectExport: Option.none(),
  projectTransfers: Option.none(),
  projectImports: Option.none(),
};

const makeContext = (principal: RpcPrincipal, projectCopy: ProjectCopyServices) => {
  // The production guard: each method's row in the shared access policy.
  const ownerEffect = <A, E, R>(method: string, effect: Effect.Effect<A, E, R>) =>
    authorizeRpcPrincipal(principal, rpcAccessFor(method), method).pipe(
      Effect.flatMap(() => effect),
    );
  return {
    principal,
    connection: principal.connection,
    projectCopy,
    ownerEffect,
    ownerStreamEffect: ownerEffect,
  } as unknown as WsRpcContext;
};

const directFacts = (
  remoteAddress: string,
  localAddress: string,
): Extract<RpcConnectionFacts, { readonly kind: "direct" }> => ({
  kind: "direct",
  remote: remoteAddress.startsWith("127.") ? "loopback" : "other",
  remoteAddress,
  localAddress,
  tls: false,
  forwarding: {
    forwardedFor: undefined,
    forwarded: undefined,
    forwardedProto: undefined,
    realIp: undefined,
  },
});

/** An owner's browser on this machine: never on a network in the clear. */
const directOwner: RpcPrincipal = {
  transport: "direct",
  role: "owner",
  scopeId: "session-owner",
  canManageLocalAccess: true,
  connection: directFacts("127.0.0.1", "127.0.0.1"),
};

/** An owner on another machine over plain `ws://`: the network carries it in the clear. */
const plainDirectOwner: RpcPrincipal = {
  ...directOwner,
  scopeId: "session-owner-lan",
  connection: directFacts("192.168.1.20", "192.168.1.10"),
};

const callers = (): ReadonlyArray<RpcPrincipal> => [
  directOwner,
  relayRpcPrincipal("owner", "relay-e2ee", undefined, () => true),
  relayRpcPrincipal("owner", "relay-legacy"),
  plainDirectOwner,
];

type Handlers = ReturnType<typeof makeProjectCopyHandlers>;
type HandlerError = ProjectCopyError | { readonly _tag: "AuthRpcError" };

const unary = (handlers: Handlers, method: keyof Handlers) =>
  handlers[method] as unknown as (input: unknown) => Effect.Effect<unknown, HandlerError>;

const failureOf = (effect: Effect.Effect<unknown, HandlerError>) =>
  effect.pipe(
    Effect.asVoid,
    Effect.flip,
    Effect.map((error) => ({
      tag: error._tag,
      code: "code" in error ? error.code : undefined,
      message: "message" in error ? error.message : undefined,
    })),
  );

const exportInput: ProjectExportStartInput = {
  exportId: ProjectExportId.make("00000000-0000-4000-8000-000000000001"),
  projectId: "project" as ProjectExportStartInput["projectId"],
  include: {
    commits: true,
    workingTreeChanges: false,
    ignoredPaths: [],
    wholeRepository: false,
    avatar: false,
  },
};

it.effect("checks access before the service and fails unavailable without one", () =>
  Effect.gen(function* () {
    let called = 0;
    const nodePaths = {
      pathHints: () =>
        Effect.sync(() => {
          called += 1;
          return {} as never;
        }),
    } as unknown as NodePathsShape;
    const viewer = makeProjectCopyHandlers(
      makeContext(relayRpcPrincipal("viewer", "relay-viewer"), {
        ...noServices,
        nodePaths: Option.some(nodePaths),
      }),
    );
    const denied = yield* failureOf(unary(viewer, PROJECT_COPY_WS_METHODS.pathHints)({}));
    expect(denied.tag).toBe("AuthRpcError");
    expect(called).toBe(0);

    const bare = makeProjectCopyHandlers(makeContext(directOwner, noServices));
    const missing = yield* failureOf(unary(bare, PROJECT_COPY_WS_METHODS.importStart)({}));
    expect(missing).toMatchObject({ tag: "ProjectCopyError", code: "unavailable" });
  }),
);

it.effect("tells the export how the caller's bytes travel", () =>
  Effect.gen(function* () {
    const requests: Array<ProjectExportStartRequest> = [];
    const exporter = {
      start: (request: ProjectExportStartRequest) => {
        requests.push(request);
        return Effect.die("recorded");
      },
    } as unknown as ProjectExportShape;
    const services = { ...noServices, projectExport: Option.some(exporter) };
    for (const principal of callers()) {
      const handlers = makeProjectCopyHandlers(makeContext(principal, services));
      yield* unary(handlers, PROJECT_COPY_WS_METHODS.exportStart)(exportInput).pipe(Effect.exit);
    }
    expect(requests.map((request) => request.channel)).toEqual([
      "encrypted",
      "encrypted",
      "unencrypted",
      "unencrypted",
    ]);
    expect(requests[0]?.input).toEqual(exportInput);
  }),
);

it.effect("tells the export's chunk reads how the caller's bytes travel", () =>
  Effect.gen(function* () {
    const channels: Array<ProjectCopyCallerChannel | undefined> = [];
    const exporter = {
      readChunk: (_input: unknown, channel?: ProjectCopyCallerChannel) => {
        channels.push(channel);
        return Effect.die("recorded");
      },
    } as unknown as ProjectExportShape;
    const services = { ...noServices, projectExport: Option.some(exporter) };
    for (const principal of callers()) {
      const handlers = makeProjectCopyHandlers(makeContext(principal, services));
      yield* unary(
        handlers,
        PROJECT_COPY_WS_METHODS.exportReadChunk,
      )({ exportId: exportInput.exportId, artifactId: "artifact", offset: 0, length: 1 }).pipe(
        Effect.exit,
      );
    }
    expect(channels).toEqual(["encrypted", "encrypted", "unencrypted", "unencrypted"]);
  }),
);

it.effect("tells the destination's transfer begins and appends how the caller's bytes travel", () =>
  Effect.gen(function* () {
    const channels: Array<[string, ProjectCopyCallerChannel | undefined]> = [];
    const record = (method: string) => (_input: unknown, channel?: ProjectCopyCallerChannel) => {
      channels.push([method, channel]);
      return Effect.die("recorded");
    };
    const transfers = {
      begin: record("begin"),
      append: record("append"),
    } as unknown as ProjectTransfersShape;
    const services = { ...noServices, projectTransfers: Option.some(transfers) };
    const transferId = "5b6e3f0e-2f5c-4f7e-9c1a-0d7a1c2b3e4f";
    for (const principal of callers()) {
      const handlers = makeProjectCopyHandlers(makeContext(principal, services));
      yield* unary(
        handlers,
        PROJECT_COPY_WS_METHODS.transferBegin,
      )({
        transferId,
        purpose: "changes-patch",
        byteLength: 1,
        sha256: "0".repeat(64),
        carriesIgnoredFiles: true,
      }).pipe(Effect.exit);
      yield* unary(
        handlers,
        PROJECT_COPY_WS_METHODS.transferAppend,
      )({ transferId, offset: 0, dataBase64: "AA==" }).pipe(Effect.exit);
    }
    expect(channels).toEqual([
      ["begin", "encrypted"],
      ["append", "encrypted"],
      ["begin", "encrypted"],
      ["append", "encrypted"],
      ["begin", "unencrypted"],
      ["append", "unencrypted"],
      ["begin", "unencrypted"],
      ["append", "unencrypted"],
    ]);
  }),
);

it.effect("counts a relay channel as encrypted only while it says so", () =>
  Effect.gen(function* () {
    let encrypted = false;
    const principal = relayRpcPrincipal("owner", "relay", undefined, () => encrypted);
    const channel = projectCopyCallerChannel(principal.connection);
    expect(yield* channel).toBe("unencrypted");
    encrypted = true;
    expect(yield* channel).toBe("encrypted");
  }),
);

it.effect("withholds ignored files from plain ws:// and connections it knows nothing about", () =>
  Effect.gen(function* () {
    expect(yield* projectCopyCallerChannel(directOwner.connection)).toBe("encrypted");
    expect(yield* projectCopyCallerChannel(plainDirectOwner.connection)).toBe("unencrypted");
    expect(yield* projectCopyCallerChannel(undefined)).toBe("unencrypted");
  }),
);

it.effect("lets only a direct caller move 1 MiB chunks; the relay keeps 160 KiB", () =>
  Effect.gen(function* () {
    const limits: Array<[string, number | undefined]> = [];
    const exporter = {
      start: (request: ProjectExportStartRequest) => {
        limits.push(["start", request.maxChunkBytes]);
        return Effect.die("recorded");
      },
      readChunk: (_input: unknown, _channel: unknown, maxChunkBytes?: number) => {
        limits.push(["readChunk", maxChunkBytes]);
        return Effect.die("recorded");
      },
    } as unknown as ProjectExportShape;
    const record =
      (method: string) => (_input: unknown, _channel: unknown, maxChunkBytes?: number) => {
        limits.push([method, maxChunkBytes]);
        return Effect.die("recorded");
      };
    const transfers = {
      begin: record("begin"),
      append: record("append"),
    } as unknown as ProjectTransfersShape;
    const services = {
      ...noServices,
      projectExport: Option.some(exporter),
      projectTransfers: Option.some(transfers),
    };
    const transferId = "5b6e3f0e-2f5c-4f7e-9c1a-0d7a1c2b3e4f";
    for (const principal of [
      directOwner,
      relayRpcPrincipal("owner", "relay-e2ee", undefined, () => true),
    ]) {
      const handlers = makeProjectCopyHandlers(makeContext(principal, services));
      yield* unary(handlers, PROJECT_COPY_WS_METHODS.exportStart)(exportInput).pipe(Effect.exit);
      yield* unary(
        handlers,
        PROJECT_COPY_WS_METHODS.exportReadChunk,
      )({ exportId: exportInput.exportId, artifactId: "artifact", offset: 0, length: 1 }).pipe(
        Effect.exit,
      );
      yield* unary(
        handlers,
        PROJECT_COPY_WS_METHODS.transferBegin,
      )({ transferId, purpose: "changes-patch", byteLength: 1, sha256: "0".repeat(64) }).pipe(
        Effect.exit,
      );
      yield* unary(
        handlers,
        PROJECT_COPY_WS_METHODS.transferAppend,
      )({ transferId, offset: 0, dataBase64: "AA==" }).pipe(Effect.exit);
    }
    const direct = PROJECT_COPY_DIRECT_CHUNK_BYTES;
    const relay = PROJECT_COPY_CHUNK_BYTES;
    expect(limits).toEqual([
      ["start", direct],
      ["readChunk", direct],
      ["begin", direct],
      ["append", direct],
      ["start", relay],
      ["readChunk", relay],
      ["begin", relay],
      ["append", relay],
    ]);
    // A connection the node knows nothing about counts as relayed.
    expect(projectCopyMaxChunkBytes(undefined)).toBe(relay);
  }),
);
