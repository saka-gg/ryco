import { Effect, Schema } from "effect";
import { NodeServices } from "@effect/platform-node";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ProviderInstanceId,
  ProviderDriverKind,
  ServerSettings,
  WS_METHODS,
} from "@ryco/contracts";
import { authorizeRpcPrincipal } from "../auth/wsAuthorization.ts";
import { rpcAccessFor } from "./RpcAccessPolicy.ts";
import type { RpcPrincipal } from "./RpcPrincipal.ts";
import type { WsRpcContext } from "./context.ts";
import { makeProviderHandlers } from "./providerRpc.ts";
import { ServerConfig } from "../config.ts";

const mocks = vi.hoisted(() => ({
  search: vi.fn(),
  install: vi.fn(),
  methods: vi.fn(),
  authenticate: vi.fn(),
}));
vi.mock("../provider/acp/AcpRegistryCatalog.ts", () => ({
  makeAcpRegistryCatalog: () => ({ search: mocks.search, install: mocks.install }),
}));
vi.mock("../provider/acp/AcpRegistrySupport.ts", () => ({
  getAcpRegistryAuthMethods: (...args: unknown[]) => mocks.methods(...args),
  authenticateAcpRegistry: (...args: unknown[]) => mocks.authenticate(...args),
}));
const instanceId = ProviderInstanceId.make("registry_test");
const settings = Schema.decodeSync(ServerSettings)({
  providerInstances: {
    [instanceId]: {
      driver: "acpRegistry",
      enabled: true,
      config: { agentId: "test", version: "1.2.3" },
      environment: [{ name: "API_KEY", value: "secret", sensitive: true }],
    },
  },
});
const config = { stateDir: "/test-state" } as ServerConfig["Service"];
function handlers(role: "owner" | "operator" | "viewer", value = settings) {
  const principal = {
    role,
    transport: "hosted",
    canManageLocalAccess: false,
  } as unknown as RpcPrincipal;
  return makeProviderHandlers({
    config,
    ownerEffect: <A, E, R>(method: string, effect: Effect.Effect<A, E, R>) =>
      authorizeRpcPrincipal(principal, rpcAccessFor(method), method).pipe(Effect.andThen(effect)),
    serverSettings: { getSettings: Effect.succeed(value) },
    providerRegistry: { refreshInstance: () => Effect.succeed([]) },
  } as unknown as WsRpcContext);
}
const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(NodeServices.layer),
      Effect.provideService(ServerConfig, config),
    ) as Effect.Effect<A, E>,
  );
beforeEach(() => {
  vi.clearAllMocks();
  mocks.search.mockResolvedValue([]);
  mocks.install.mockResolvedValue({ agentId: "test", version: "1.2.3", sha256: "a".repeat(64) });
  mocks.methods.mockReturnValue(Effect.succeed([{ id: "login", name: "Sign in" }]));
  mocks.authenticate.mockReturnValue(Effect.void);
});
describe("ACP registry RPC boundaries", () => {
  it("allows read-only discovery and performs no installation or auth", async () => {
    await expect(
      run(handlers("viewer")[WS_METHODS.serverSearchAcpRegistry]({ query: "test" })),
    ).resolves.toEqual({ agents: [] });
    expect(mocks.search).toHaveBeenCalledWith("test");
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.methods).not.toHaveBeenCalled();
    expect(mocks.authenticate).not.toHaveBeenCalled();
  });
  it.each(["viewer", "operator"] as const)(
    "denies %s execution before touching the catalog or provider settings",
    async (role) => {
      const rpc = handlers(role);
      await expect(
        run(rpc[WS_METHODS.serverInstallAcpRegistry]({ agentId: "test", version: "1.2.3" })),
      ).rejects.toThrow("Only owner");
      await expect(
        run(rpc[WS_METHODS.serverGetAcpRegistryAuthMethods]({ instanceId })),
      ).rejects.toThrow("Only owner");
      await expect(
        run(rpc[WS_METHODS.serverAuthenticateAcpRegistry]({ instanceId, methodId: "login" })),
      ).rejects.toThrow("Only owner");
      expect(mocks.install).not.toHaveBeenCalled();
      expect(mocks.methods).not.toHaveBeenCalled();
      expect(mocks.authenticate).not.toHaveBeenCalled();
    },
  );
  it("uses the stored instance configuration and keeps secrets out of responses", async () => {
    const rpc = handlers("owner");
    await expect(
      run(rpc[WS_METHODS.serverGetAcpRegistryAuthMethods]({ instanceId })),
    ).resolves.toEqual([{ id: "login", name: "Sign in" }]);
    await expect(
      run(rpc[WS_METHODS.serverAuthenticateAcpRegistry]({ instanceId, methodId: "login" })),
    ).resolves.toEqual({ authenticated: true });
    expect(mocks.authenticate).toHaveBeenCalledWith(
      { agentId: "test", version: "1.2.3" },
      "login",
      expect.objectContaining({ API_KEY: "secret" }),
    );
  });
  it("rejects authentication for other providers", async () => {
    const changed = {
      ...settings,
      providerInstances: {
        [instanceId]: {
          ...settings.providerInstances[instanceId]!,
          driver: ProviderDriverKind.make("cursor"),
        },
      },
    };
    await expect(
      run(
        handlers("owner", changed)[WS_METHODS.serverAuthenticateAcpRegistry]({
          instanceId,
          methodId: "login",
        }),
      ),
    ).rejects.toThrow("enabled ACP Registry");
    expect(mocks.authenticate).not.toHaveBeenCalled();
  });
  it("redacts arbitrary installation and authentication failure payloads", async () => {
    mocks.install.mockRejectedValue(new Error("secret=/private/provider/auth"));
    await expect(
      run(
        handlers("owner")[WS_METHODS.serverInstallAcpRegistry]({
          agentId: "test",
          version: "1.2.3",
        }),
      ),
    ).rejects.toThrow("ACP Registry operation failed");
    mocks.authenticate.mockReturnValue(Effect.fail(new Error("API_KEY=secret")));
    await expect(
      run(
        handlers("owner")[WS_METHODS.serverAuthenticateAcpRegistry]({
          instanceId,
          methodId: "login",
        }),
      ),
    ).rejects.toThrow("ACP Registry operation failed");
  });
});
