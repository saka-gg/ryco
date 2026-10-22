import { WS_METHODS } from "@ryco/contracts";
import {
  ProjectExportId,
  type ProjectCopyError,
  type ProjectExportStartInput,
} from "@ryco/contracts/project-copy";
import { expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";

import { authorizeRpcPrincipal } from "../auth/wsAuthorization.ts";
import type { NodePathsShape } from "../projectCopy/Services/NodePaths.ts";
import type {
  ProjectCopyCallerChannel,
  ProjectExportShape,
  ProjectExportStartRequest,
} from "../projectCopy/Services/ProjectExport.ts";
import type { WsRpcContext } from "./context.ts";
import { makeProjectCopyHandlers, projectCopyCallerChannel } from "./projectCopyRpc.ts";
import { rpcAccessFor } from "./RpcAccessPolicy.ts";
import { relayRpcPrincipal, type RpcPrincipal } from "./RpcPrincipal.ts";

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
    projectCopy,
    ownerEffect,
    ownerStreamEffect: ownerEffect,
  } as unknown as WsRpcContext;
};

const directOwner: RpcPrincipal = {
  transport: "direct",
  role: "owner",
  scopeId: "session-owner",
  canManageLocalAccess: true,
};

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
    const denied = yield* failureOf(unary(viewer, WS_METHODS.projectsPathHints)({}));
    expect(denied.tag).toBe("AuthRpcError");
    expect(called).toBe(0);

    const bare = makeProjectCopyHandlers(makeContext(directOwner, noServices));
    const missing = yield* failureOf(unary(bare, WS_METHODS.projectsImportStart)({}));
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
    for (const principal of [
      directOwner,
      relayRpcPrincipal("owner", "relay-e2ee", undefined, () => true),
      relayRpcPrincipal("owner", "relay-legacy"),
    ]) {
      const handlers = makeProjectCopyHandlers(makeContext(principal, services));
      yield* unary(handlers, WS_METHODS.projectsExportStart)(exportInput).pipe(Effect.exit);
    }
    expect(requests.map((request) => request.channel)).toEqual([
      "direct",
      "relay-e2ee",
      "relay-plaintext",
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
    for (const principal of [
      directOwner,
      relayRpcPrincipal("owner", "relay-e2ee", undefined, () => true),
      relayRpcPrincipal("owner", "relay-legacy"),
    ]) {
      const handlers = makeProjectCopyHandlers(makeContext(principal, services));
      yield* unary(
        handlers,
        WS_METHODS.projectsExportReadChunk,
      )({ exportId: exportInput.exportId, artifactId: "artifact", offset: 0, length: 1 }).pipe(
        Effect.exit,
      );
    }
    expect(channels).toEqual(["direct", "relay-e2ee", "relay-plaintext"]);
  }),
);

it("counts a relay channel as encrypted only while it says so", () => {
  let encrypted = false;
  const principal = relayRpcPrincipal("owner", "relay", undefined, () => encrypted);
  expect(projectCopyCallerChannel(principal)).toBe("relay-plaintext");
  encrypted = true;
  expect(projectCopyCallerChannel(principal)).toBe("relay-e2ee");
  expect(
    projectCopyCallerChannel({ ...principal, relayChannelEncrypted: undefined } as never),
  ).toBe("relay-plaintext");
});
