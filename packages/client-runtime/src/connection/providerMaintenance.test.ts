import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
  type ServerProviderUpdatedPayload,
} from "@ryco/contracts";
import { Schema } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  createProviderMaintenanceController,
  type ProviderMaintenanceEnvironment,
} from "./providerMaintenance.ts";

const driver = ProviderDriverKind.make("codex");
function provider(id = "codex-default"): ServerProvider {
  return Schema.decodeUnknownSync(ServerProvider)({
    instanceId: id,
    driver,
    enabled: true,
    installed: true,
    status: "ready",
    version: "1.0.0",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-02T00:00:00.000Z",
    models: [],
    versionAdvisory: {
      status: "behind_latest",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      canUpdate: true,
      updateCommand: null,
      checkedAt: null,
      message: null,
    },
  });
}
function fixture(id = "environment-1") {
  const environmentId = EnvironmentId.make(id);
  const providers = [provider()];
  const updateProvider = vi.fn(async (): Promise<ServerProviderUpdatedPayload> => ({
    providers: providers.map((entry) => ({
      ...entry,
      updateState: {
        status: "succeeded",
        startedAt: null,
        finishedAt: null,
        output: null,
        message: "Installed",
      },
    })),
  }));
  const environment: ProviderMaintenanceEnvironment = {
    client: { server: { updateProvider } } as unknown as ProviderMaintenanceEnvironment["client"],
    providers,
    activeInstanceIds: [],
    readiness: {
      environmentId,
      selectionGeneration: 1,
      snapshotGeneration: 1,
      effectiveRole: "owner",
      directoryReady: true,
      relayReady: true,
      shellReady: true,
    },
  };
  return { environmentId, environment, updateProvider };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("provider maintenance batches", () => {
  it("isolates a failing readiness lookup while holding batch ownership for other installs", async () => {
    const first = fixture("one");
    const second = fixture("two");
    const pending = deferred<ServerProviderUpdatedPayload>();
    second.updateProvider.mockReturnValue(pending.promise);
    let failLookup = false;
    const controller = createProviderMaintenanceController({
      readEnvironment: (id) => {
        if (id === first.environmentId && failLookup) throw new Error("environment removed");
        return id === first.environmentId ? first.environment : second.environment;
      },
    });
    const preview = controller.preview([first.environmentId, second.environmentId]);
    const otherPreview = controller.preview([second.environmentId]);
    failLookup = true;
    const execution = controller.execute(preview);
    await vi.waitFor(() => expect(second.updateProvider).toHaveBeenCalledOnce());
    await expect(controller.execute(otherPreview)).rejects.toThrow("already running");
    pending.resolve({ providers: [] });
    expect((await execution).map((outcome) => outcome.status)).toEqual(["skipped", "unknown"]);
    expect(first.updateProvider).not.toHaveBeenCalled();
  });
  it("previews only eligible exact identities and deduplicates environments and instances", () => {
    const { environmentId, environment } = fixture();
    const base = provider();
    const entries: ServerProvider[] = [
      base,
      base,
      { ...provider("disabled"), enabled: false },
      { ...provider("missing"), installed: false },
      { ...provider("unavailable"), availability: "unavailable" },
      { ...provider("manual"), versionAdvisory: { ...base.versionAdvisory!, canUpdate: false } },
      { ...provider("current"), versionAdvisory: { ...base.versionAdvisory!, status: "current" } },
      {
        ...provider("running"),
        updateState: {
          status: "running",
          startedAt: null,
          finishedAt: null,
          message: null,
          output: null,
        },
      },
      provider("active"),
    ];
    const controller = createProviderMaintenanceController({
      readEnvironment: () => ({
        ...environment,
        providers: entries,
        activeInstanceIds: [ProviderInstanceId.make("active")],
      }),
    });
    const preview = controller.preview([environmentId, environmentId]);
    expect(preview.targets.map((target) => target.instanceId)).toEqual([base.instanceId]);
    expect(Object.isFrozen(preview.targets[0])).toBe(true);
    expect(Object.isFrozen(preview.targets)).toBe(true);
  });

  it("excludes offline, nonowner, and unsynchronized environments", () => {
    const { environmentId, environment } = fixture();
    for (const current of [
      null,
      {
        ...environment,
        readiness: { ...environment.readiness, effectiveRole: "operator" as const },
      },
      { ...environment, readiness: { ...environment.readiness, shellReady: false } },
    ]) {
      const controller = createProviderMaintenanceController({ readEnvironment: () => current });
      expect(controller.preview([environmentId]).targets).toEqual([]);
    }
  });

  it("executes each preview once and returns frozen per-target terminal outcomes", async () => {
    const { environmentId, environment, updateProvider } = fixture();
    const controller = createProviderMaintenanceController({ readEnvironment: () => environment });
    const preview = controller.preview([environmentId]);
    const first = controller.execute(preview);
    expect(controller.execute(preview)).toBe(first);
    const outcomes = await first;
    expect(outcomes[0]?.status).toBe("succeeded");
    expect(Object.isFrozen(outcomes)).toBe(true);
    expect(Object.isFrozen(outcomes[0])).toBe(true);
    expect(controller.execute(preview)).toBe(first);
    expect(updateProvider).toHaveBeenCalledExactlyOnceWith({
      provider: driver,
      instanceId: provider().instanceId,
    });
  });

  it("rechecks the client, generation, role, readiness, eligibility, and version before dispatch", async () => {
    const { environmentId, environment, updateProvider } = fixture();
    const replacements: ProviderMaintenanceEnvironment[] = [
      { ...environment, client: { ...environment.client } },
      { ...environment, readiness: { ...environment.readiness, snapshotGeneration: 2 } },
      { ...environment, readiness: { ...environment.readiness, selectionGeneration: 2 } },
      { ...environment, readiness: { ...environment.readiness, effectiveRole: "viewer" } },
      { ...environment, readiness: { ...environment.readiness, directoryReady: false } },
      { ...environment, activeInstanceIds: [provider().instanceId] },
      {
        ...environment,
        providers: [
          {
            ...provider(),
            versionAdvisory: { ...provider().versionAdvisory!, latestVersion: "2.0.0" },
          },
        ],
      },
    ];
    for (const replacement of replacements) {
      let current = environment;
      const controller = createProviderMaintenanceController({ readEnvironment: () => current });
      const preview = controller.preview([environmentId]);
      current = replacement;
      expect((await controller.execute(preview))[0]?.status).toBe("skipped");
    }
    expect(updateProvider).not.toHaveBeenCalled();
  });

  it("does not accept stale successful results after reconnect", async () => {
    const { environmentId, environment, updateProvider } = fixture();
    const pending = deferred<ServerProviderUpdatedPayload>();
    updateProvider.mockReturnValue(pending.promise);
    let current = environment;
    const controller = createProviderMaintenanceController({ readEnvironment: () => current });
    const execution = controller.execute(controller.preview([environmentId]));
    await vi.waitFor(() => expect(updateProvider).toHaveBeenCalledOnce());
    current = { ...environment, readiness: { ...environment.readiness, snapshotGeneration: 2 } };
    pending.resolve({ providers: [] });
    expect((await execution)[0]?.status).toBe("unknown");
  });

  it("bounds concurrency, isolates failures, and never retries ambiguous responses", async () => {
    const fixtures = [fixture("one"), fixture("two"), fixture("three")];
    const pending = fixtures.map(() => deferred<ServerProviderUpdatedPayload>());
    fixtures.forEach((entry, index) =>
      entry.updateProvider.mockReturnValue(pending[index]!.promise),
    );
    const controller = createProviderMaintenanceController({
      readEnvironment: (id) =>
        fixtures.find((entry) => entry.environmentId === id)?.environment ?? null,
      concurrency: 2,
    });
    const preview = controller.preview(fixtures.map((entry) => entry.environmentId));
    const execution = controller.execute(preview);
    await vi.waitFor(() => expect(fixtures[1]!.updateProvider).toHaveBeenCalledOnce());
    expect(fixtures[2]!.updateProvider).not.toHaveBeenCalled();
    await expect(
      controller.execute(controller.preview([fixtures[2]!.environmentId])),
    ).rejects.toThrow("already running");
    pending[0]!.reject(new Error("connection lost after install"));
    await vi.waitFor(() => expect(fixtures[2]!.updateProvider).toHaveBeenCalledOnce());
    pending[1]!.resolve({ providers: [] });
    pending[2]!.resolve({ providers: [] });
    expect((await execution).map((outcome) => outcome.status)).toEqual([
      "unknown",
      "unknown",
      "unknown",
    ]);
    await controller.execute(preview);
    fixtures.forEach((entry) => expect(entry.updateProvider).toHaveBeenCalledOnce());
  });

  it("cancels queued targets without pretending in-flight installs were cancelled", async () => {
    const first = fixture("one");
    const second = fixture("two");
    const pending = deferred<ServerProviderUpdatedPayload>();
    first.updateProvider.mockReturnValue(pending.promise);
    const controller = createProviderMaintenanceController({
      readEnvironment: (id) =>
        id === first.environmentId ? first.environment : second.environment,
      concurrency: 1,
    });
    const abort = new AbortController();
    const execution = controller.execute(
      controller.preview([first.environmentId, second.environmentId]),
      abort.signal,
    );
    await vi.waitFor(() => expect(first.updateProvider).toHaveBeenCalledOnce());
    abort.abort();
    pending.resolve({ providers: [] });
    expect((await execution).map((outcome) => outcome.status)).toEqual(["unknown", "skipped"]);
    expect(second.updateProvider).not.toHaveBeenCalled();
  });

  it("rejects fabricated previews", async () => {
    const controller = createProviderMaintenanceController({ readEnvironment: () => null });
    await expect(controller.execute({ targets: [] })).rejects.toThrow("preview issued");
  });
});
