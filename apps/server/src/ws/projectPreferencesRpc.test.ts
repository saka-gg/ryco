import {
  AuthRpcError,
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
  WS_METHODS,
} from "@ryco/contracts";
import { Effect, Option } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { WsRpcContext } from "./context.ts";
import { makeProviderHandlers } from "./providerRpc.ts";
import { rpcAccessFor } from "@ryco/shared/rpcAccessPolicy";
import { authorizeRpcPrincipal, type WsRpcAccess } from "../auth/wsAuthorization.ts";
import { relayRpcPrincipal, type RpcPrincipalRole } from "./RpcPrincipal.ts";

const id = ProjectId.make("fixture-project");
const project = {
  id,
  defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "legacy-model" },
};
function harness(exists = true, permitted = true, role: RpcPrincipalRole = "owner") {
  const update = vi.fn(() => Effect.succeed(DEFAULT_SERVER_SETTINGS));
  const owner = vi.fn((method: string, action: Effect.Effect<unknown>) =>
    permitted
      ? authorizeRpcPrincipal(
          relayRpcPrincipal(role, "test-channel"),
          rpcAccessFor(method),
          method,
        ).pipe(Effect.andThen(action))
      : Effect.fail(new AuthRpcError({ message: `Denied ${method}`, status: 403 })),
  );
  const lookup = vi.fn(() => Effect.succeed(exists ? Option.some(project) : Option.none()));
  const withAccess = vi.fn((access: WsRpcAccess, method: string, action: Effect.Effect<unknown>) =>
    authorizeRpcPrincipal(relayRpcPrincipal(role, "test-channel"), access, method).pipe(
      Effect.andThen(action),
    ),
  );
  const handlers = makeProviderHandlers({
    config: { stateDir: "/tmp/fixture-project-preferences" },
    ownerEffect: owner,
    withAccess,
    serverSettings: {
      getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
      updateSettings: update,
    },
    projectionSnapshotQuery: { getProjectShellById: lookup },
  } as unknown as WsRpcContext);
  return { handlers, owner, withAccess, update, lookup };
}
describe("project preference RPC boundary", () => {
  it.each(["viewer", "operator", "owner"] as const)(
    "allows %s to read authoritative effective values through the viewer guard",
    async (role) => {
      const { handlers, owner, withAccess } = harness(true, true, role);
      const effective = await Effect.runPromise(
        handlers[WS_METHODS.serverGetProjectPreferences]({ projectId: id }),
      );
      expect(effective.initialModelSelection).toEqual({
        value: project.defaultModelSelection,
        source: "legacy-project",
      });
      expect(owner).not.toHaveBeenCalled();
      expect(withAccess).toHaveBeenCalledWith(
        "viewer",
        WS_METHODS.serverGetProjectPreferences,
        expect.anything(),
      );
      expect(rpcAccessFor(WS_METHODS.serverGetProjectPreferences)).toBe("viewer");
      expect(rpcAccessFor(WS_METHODS.serverUpdateSettings)).toBe("owner");
    },
  );
  it.each(["viewer", "operator"] as const)(
    "denies %s settings writes before inspecting projects",
    async (role) => {
      const { handlers, lookup, update } = harness(true, true, role);
      await expect(
        Effect.runPromise(
          handlers[WS_METHODS.serverUpdateSettings]({
            patch: { projectPreferences: { [id]: { runSetupScript: false } } },
          }),
        ),
      ).rejects.toThrow("Only owner");
      expect(lookup).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    },
  );
  it("rejects reads/writes for deleted projects before settings mutation", async () => {
    const { handlers, update } = harness(false);
    await expect(
      Effect.runPromise(handlers[WS_METHODS.serverGetProjectPreferences]({ projectId: id })),
    ).rejects.toThrow("no longer exists");
    await expect(
      Effect.runPromise(
        handlers[WS_METHODS.serverUpdateSettings]({
          patch: { projectPreferences: { [id]: { runSetupScript: false } } },
        }),
      ),
    ).rejects.toThrow("no longer exists");
    expect(update).not.toHaveBeenCalled();
  });
  it("does not inspect projects or mutate settings after role/readiness denial", async () => {
    const { handlers, lookup, update } = harness(true, false);
    await expect(
      Effect.runPromise(
        handlers[WS_METHODS.serverUpdateSettings]({
          patch: { projectPreferences: { [id]: { runSetupScript: false } } },
        }),
      ),
    ).rejects.toThrow("Denied");
    expect(lookup).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});
