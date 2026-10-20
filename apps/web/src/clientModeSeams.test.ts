import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  CLIENT_MODE_SEAM_MODULES,
  createClientModeSeamPlugin,
  shouldApplyClientModeSeams,
  standardSeamSibling,
} from "./clientModeSeams";

const srcRoot = fileURLToPath(new URL(".", import.meta.url));

/** Real hosted module → its standard sibling, loaded the way each build resolves them. */
const SEAM_LOADERS: Record<
  (typeof CLIENT_MODE_SEAM_MODULES)[number],
  readonly [hosted: () => Promise<object>, standard: () => Promise<object>]
> = {
  "hostedHub/state.ts": [
    () => import("./hostedHub/state"),
    () => import("./hostedHub/state.standard"),
  ],
  "hostedHub/bootGate.ts": [
    () => import("./hostedHub/bootGate"),
    () => import("./hostedHub/bootGate.standard"),
  ],
  "hostedHub/transport.ts": [
    () => import("./hostedHub/transport"),
    () => import("./hostedHub/transport.standard"),
  ],
  "hostedHub/hostedConnectionCoordinator.ts": [
    () => import("./hostedHub/hostedConnectionCoordinator"),
    () => import("./hostedHub/hostedConnectionCoordinator.standard"),
  ],
  "components/hostedHub/HostedConnectionControls.tsx": [
    () => import("./components/hostedHub/HostedConnectionControls"),
    () => import("./components/hostedHub/HostedConnectionControls.standard"),
  ],
  "components/NoActiveThreadHostedStatus.tsx": [
    () => import("./components/NoActiveThreadHostedStatus"),
    () => import("./components/NoActiveThreadHostedStatus.standard"),
  ],
  "pwa/lifecycle.ts": [() => import("./pwa/lifecycle"), () => import("./pwa/lifecycle.standard")],
};

describe("client-mode seams", () => {
  it.each(CLIENT_MODE_SEAM_MODULES)(
    "%s has a sibling with the same runtime exports",
    async (seam) => {
      const [loadHosted, loadStandard] = SEAM_LOADERS[seam];
      const [hosted, standard] = await Promise.all([loadHosted(), loadStandard()]);
      expect(Object.keys(standard).toSorted()).toEqual(Object.keys(hosted).toSorted());
    },
    // The hosted state module transforms its whole runtime graph cold (about
    // 1.3 s alone), which exceeds the default under a loaded full-suite run.
    20_000,
  );

  it("publishes the hosted stores' initial snapshots in standard builds", async () => {
    const [hosted, standard] = await Promise.all([
      import("./hostedHub/state"),
      import("./hostedHub/state.standard"),
    ]);
    expect(standard.hostedHubStore.getState()).toEqual(hosted.hostedHubStore.getInitialState());
    expect(standard.hostedAccountStore.getState()).toEqual(
      hosted.hostedAccountStore.getInitialState(),
    );
    expect(standard.hostedRecoveryCodeDisplayStore.getState()).toEqual(
      hosted.hostedRecoveryCodeDisplayStore.getInitialState(),
    );
    expect(standard.HOSTED_SESSION_SYNC_FAILURE_MESSAGE).toBe(
      hosted.HOSTED_SESSION_SYNC_FAILURE_MESSAGE,
    );
  });

  it("gives the standard controller every public controller member", async () => {
    const [hosted, standard] = await Promise.all([
      import("./hostedHub/state"),
      import("./hostedHub/state.standard"),
    ]);
    const publicMembers = (value: object) =>
      Object.getOwnPropertyNames(Object.getPrototypeOf(value))
        .filter((name) => name !== "constructor")
        .toSorted();
    expect(Object.keys(standard.hostedHubController).toSorted()).toEqual(
      publicMembers(hosted.hostedHubController),
    );
    await expect(standard.hostedHubController.addPasskey({ passkeyLabel: null })).resolves.toEqual(
      expect.objectContaining({ status: "refused", reason: "signed-out" }),
    );
    expect(standard.hostedHubController.leaseRecoveryCodeDisplay()()).toBeUndefined();
  });

  it("gives standard builds an inert environment session registry with every registry member", async () => {
    const [hosted, standard] = await Promise.all([
      import("./hostedHub/state"),
      import("./hostedHub/state.standard"),
    ]);
    const registry = standard.getHostedEnvironmentSessions();
    expect(Object.keys(registry).toSorted()).toEqual(
      Object.keys(hosted.getHostedEnvironmentSessions()).toSorted(),
    );
    const snapshot = registry.getSnapshot();
    expect(snapshot.records.size).toBe(0);
    expect(snapshot.deliveryUnknown.size).toBe(0);
    expect(registry.getSnapshot()).toBe(snapshot);
    expect(registry.list()).toEqual([]);
    const environmentId = "env-1" as Parameters<typeof registry.read>[0];
    expect(registry.read(environmentId)).toBeUndefined();
    const listener = vi.fn();
    expect(registry.subscribe(listener)()).toBeUndefined();
    expect(listener).not.toHaveBeenCalled();
    expect(() => registry.ensureRecord({} as Parameters<typeof registry.ensureRecord>[0])).toThrow(
      /hosted-hub builds/u,
    );
    expect(standard.hostedEnvironmentSessionsMode()).toBe("single");
    // No session is ever ready to adopt, so a row intent never reads a window
    // through it.
    expect(standard.isHostedEnvironmentSessionAdoptable(environmentId)).toBe(false);
    expect(hosted.isHostedEnvironmentSessionAdoptable(environmentId)).toBe(false);
  });

  it("reports the signed-out hosted workspace and never grants a lease", async () => {
    const [hosted, standard] = await Promise.all([
      import("./hostedHub/hostedConnectionCoordinator"),
      import("./hostedHub/hostedConnectionCoordinator.standard"),
    ]);
    expect(standard.readHostedWorkspaceState()).toEqual(hosted.readHostedWorkspaceState());
    expect(standard.MAX_HOSTED_WEB_CONNECTIONS).toBe(hosted.MAX_HOSTED_WEB_CONNECTIONS);
    const environmentId = "env-1" as Parameters<typeof standard.readHostedNodeMutationLease>[0];
    expect(standard.readHostedNodeMutationLease(environmentId)).toBeNull();
    await expect(standard.waitForHostedNodeMutationLease(environmentId)).resolves.toBeNull();
    expect(standard.nodeIdForHostedEnvironment(environmentId)).toBeNull();
    expect(standard.isHostedEnvironmentDemanded(environmentId)).toBe(false);
    // A row press never connects anything ahead of a navigation in a standard build.
    expect(standard.canPreconnectHostedEnvironment(environmentId)).toBe(false);
    expect(standard.requestHostedWorkspaceReconcile({ reason: "resume" })).toBeUndefined();
    expect(() => standard.startHostedWorkspaceCoordinator()).toThrow(/hosted-hub builds/u);
  });

  it("keeps hosted-only transport entry points loud in standard builds", async () => {
    const standard = await import("./hostedHub/transport.standard");
    expect(standard.hasHostedRelayPendingRequests()).toBe(false);
    expect(standard.hostedDispatchLineage({ accountStatus: "signed-out", account: null })).toBe(
      null,
    );
    expect(() => standard.getHostedRelayAttemptFactory()).toThrow(/hosted-hub builds/u);
    expect(() =>
      standard.createHostedEnvironmentAttemptFactory(
        {} as Parameters<typeof standard.createHostedEnvironmentAttemptFactory>[0],
      ),
    ).toThrow(/hosted-hub builds/u);
    expect(() =>
      standard.webHostedEnvironmentAttemptPorts(
        {} as Parameters<typeof standard.webHostedEnvironmentAttemptPorts>[0],
      ),
    ).toThrow(/hosted-hub builds/u);
  });

  it("keeps the hosted boot gate loud in standard builds", async () => {
    const standard = await import("./hostedHub/bootGate.standard");
    expect(() =>
      standard.runHostedBootGate({ pathname: "/", hostedRoot: Promise.resolve() }),
    ).toThrow(/hosted-hub builds/u);
  });

  it("has no PWA lifecycle outside hosted builds", async () => {
    const standard = await import("./pwa/lifecycle.standard");
    expect(standard.hostedPwaLifecycle).toBeNull();
  });

  it("applies only to non-test standard builds", () => {
    expect(
      shouldApplyClientModeSeams({ clientMode: "standard", mode: "production", vitest: false }),
    ).toBe(true);
    expect(
      shouldApplyClientModeSeams({ clientMode: "standard", mode: "development", vitest: false }),
    ).toBe(true);
    expect(
      shouldApplyClientModeSeams({ clientMode: "hosted-hub", mode: "production", vitest: false }),
    ).toBe(false);
    expect(
      shouldApplyClientModeSeams({ clientMode: "standard", mode: "test", vitest: false }),
    ).toBe(false);
    expect(
      shouldApplyClientModeSeams({ clientMode: "standard", mode: "production", vitest: true }),
    ).toBe(false);
  });

  it("resolves a seam module to its sibling and leaves everything else alone", async () => {
    const plugin = createClientModeSeamPlugin({ clientMode: "standard", srcRoot });
    const resolveId = plugin.resolveId as {
      readonly filter: { readonly id: RegExp };
      readonly handler: (
        this: { resolve: (source: string) => Promise<{ id: string; external: boolean } | null> },
        source: string,
        importer: string | undefined,
        options: object,
      ) => Promise<string | null>;
    };
    const resolved = new Map([
      ["./hostedHub/state", `${srcRoot}hostedHub/state.ts`],
      ["./other/state", `${srcRoot}other/state.ts`],
    ]);
    const context = {
      resolve: async (source: string) => {
        const id = resolved.get(source);
        return id ? { id, external: false } : null;
      },
    };
    const importer = `${srcRoot}main.tsx`;

    expect(resolveId.filter.id.test("./hostedHub/state")).toBe(true);
    expect(resolveId.filter.id.test("../pwa/lifecycle")).toBe(true);
    expect(resolveId.filter.id.test("./store")).toBe(false);
    await expect(resolveId.handler.call(context, "./hostedHub/state", importer, {})).resolves.toBe(
      `${srcRoot}${standardSeamSibling("hostedHub/state.ts")}`,
    );
    await expect(
      resolveId.handler.call(context, "./other/state", importer, {}),
    ).resolves.toBeNull();
    // A sibling may name its own hosted module (type positions only).
    await expect(
      resolveId.handler.call(
        context,
        "./hostedHub/state",
        `${srcRoot}hostedHub/state.standard.ts`,
        {},
      ),
    ).resolves.toBeNull();
  });
});
