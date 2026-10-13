import { Effect, Option } from "effect";
import { ProviderInstanceId, ThreadId, WS_METHODS } from "@ryco/contracts";
import { hostedRoleAllows, rpcAccessFor } from "@ryco/shared/rpcAccessPolicy";
import { describe, expect, it } from "vitest";

import { authorizeRpcPrincipal } from "../auth/wsAuthorization.ts";
import type { RpcPrincipal, RpcPrincipalRole } from "./RpcPrincipal.ts";
import type { WsRpcContext } from "./context.ts";
import { makeProviderProjectCommandsHandlers } from "./providerProjectCommandsRpc.ts";
import { makeProviderSessionPrewarmHandlers } from "./providerSessionPrewarmRpc.ts";

const ownerEffect =
  (role: RpcPrincipalRole) => (rpcMethod: string, effect: Effect.Effect<unknown>) =>
    authorizeRpcPrincipal(
      {
        role,
        transport: "relay",
        scopeId: "test",
        canManageLocalAccess: false,
      } satisfies RpcPrincipal,
      rpcAccessFor(rpcMethod),
      rpcMethod,
    ).pipe(Effect.andThen(effect));

const commands = { skills: [], slashCommands: [{ name: "ship" }] };

function projectCommandsContext(input: {
  readonly role: RpcPrincipalRole;
  readonly knownProjectRoot?: string;
  readonly reads: Array<string>;
}) {
  return {
    ownerEffect: ownerEffect(input.role),
    projectionSnapshotQuery: {
      getActiveProjectByWorkspaceRoot: (cwd: string) =>
        Effect.succeed(cwd === input.knownProjectRoot ? Option.some({ id: "p" }) : Option.none()),
    },
    projectionWorktrees: {
      findActiveByWorktreePath: () => Effect.succeed(Option.none()),
    },
    providerService: Option.some({
      readProjectCommands: (_instanceId: string, cwd: string) =>
        Effect.sync(() => {
          input.reads.push(cwd);
          return commands;
        }),
    }),
  } as unknown as WsRpcContext;
}

describe("provider session RPCs", () => {
  it("lets operators prewarm and read project commands, but not viewers", () => {
    for (const method of [
      WS_METHODS.providerPrewarmSession,
      WS_METHODS.providerReadProjectCommands,
    ]) {
      expect(rpcAccessFor(method)).toBe("operator");
      expect(hostedRoleAllows("viewer", method)).toBe(false);
      expect(hostedRoleAllows("operator", method)).toBe(true);
    }
  });

  it("answers skipped when the node runs no prewarm service", async () => {
    const handlers = makeProviderSessionPrewarmHandlers({
      ownerEffect: ownerEffect("owner"),
      sessionPrewarm: Option.none(),
    } as unknown as WsRpcContext);
    await expect(
      Effect.runPromise(
        handlers[WS_METHODS.providerPrewarmSession]({ threadId: ThreadId.make("t") }),
      ),
    ).resolves.toEqual({ status: "skipped", reason: "prewarm unavailable" });
  });

  it("reads project commands only for a directory the node works in", async () => {
    const reads: Array<string> = [];
    const handlers = makeProviderProjectCommandsHandlers(
      projectCommandsContext({ role: "owner", knownProjectRoot: "/repo", reads }),
    );
    const read = (cwd: string) =>
      Effect.runPromise(
        handlers[WS_METHODS.providerReadProjectCommands]({
          instanceId: ProviderInstanceId.make("claude"),
          cwd,
        }),
      );
    await expect(read("/repo")).resolves.toEqual(commands);
    await expect(read("/etc")).resolves.toEqual({ skills: [], slashCommands: [] });
    expect(reads).toEqual(["/repo"]);
  });

  it("denies a viewer before reading anything", async () => {
    const reads: Array<string> = [];
    const handlers = makeProviderProjectCommandsHandlers(
      projectCommandsContext({ role: "viewer", knownProjectRoot: "/repo", reads }),
    );
    await expect(
      Effect.runPromise(
        handlers[WS_METHODS.providerReadProjectCommands]({
          instanceId: ProviderInstanceId.make("claude"),
          cwd: "/repo",
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(reads).toEqual([]);
  });
});
