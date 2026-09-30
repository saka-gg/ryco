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

const id = ProjectId.make("fixture-project");
const project = {
  id,
  defaultModelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "legacy-model" },
};
function harness(exists = true, permitted = true) {
  const update = vi.fn(() => Effect.succeed(DEFAULT_SERVER_SETTINGS));
  const owner = vi.fn((method: string, action: Effect.Effect<unknown>) =>
    permitted
      ? action
      : Effect.fail(new AuthRpcError({ message: `Denied ${method}`, status: 403 })),
  );
  const lookup = vi.fn(() => Effect.succeed(exists ? Option.some(project) : Option.none()));
  const handlers = makeProviderHandlers({
    config: { stateDir: "/tmp/fixture-project-preferences" },
    ownerEffect: owner,
    serverSettings: {
      getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
      updateSettings: update,
    },
    projectionSnapshotQuery: { getProjectShellById: lookup },
  } as unknown as WsRpcContext);
  return { handlers, owner, update, lookup };
}
describe("project preference RPC boundary", () => {
  it("reads authoritative effective values and guards through the role policy", async () => {
    const { handlers, owner } = harness();
    const effective = await Effect.runPromise(
      handlers[WS_METHODS.serverGetProjectPreferences]({ projectId: id }),
    );
    expect(effective.initialModelSelection).toEqual({
      value: project.defaultModelSelection,
      source: "legacy-project",
    });
    expect(owner).toHaveBeenCalledWith(WS_METHODS.serverGetProjectPreferences, expect.anything());
    expect(rpcAccessFor(WS_METHODS.serverGetProjectPreferences)).toBe("viewer");
    expect(rpcAccessFor(WS_METHODS.serverUpdateSettings)).toBe("owner");
  });
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
