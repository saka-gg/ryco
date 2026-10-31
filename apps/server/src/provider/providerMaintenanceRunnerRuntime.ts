/**
 * providerMaintenanceRunnerRuntime - The one-click provider update runner, loaded with the first
 * update (`ProviderMaintenanceRunner` in `providerMaintenanceRunner.ts` is the boot facade).
 *
 * @module providerMaintenanceRunnerRuntime
 */
import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  ServerProviderUpdateError,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUpdateState,
} from "@ryco/contracts";
import { isBlockingProviderCompatibilityStatus } from "@ryco/shared/providerCapabilities";
import { Cause, DateTime, Duration, Effect, Option, Ref, Schema } from "effect";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import type { ProviderMaintenanceRunnerShape } from "./providerMaintenanceRunner.ts";
import { ProviderInstallLock } from "./Services/ProviderInstallLock.ts";
import { ProviderRegistry } from "./Services/ProviderRegistry.ts";
import { makeProviderMaintenanceCommandCoordinator } from "./providerMaintenanceCommandCoordinator.ts";
import {
  createProviderVersionAdvisory,
  enrichProviderSnapshotWithVersionAdvisory,
  makeMaintenanceChildProcess,
  resolveLatestProviderUpdateAction,
  resolveLatestProviderVersion,
} from "./providerMaintenance.ts";
import { resolvePinnedProviderUpdateAction } from "./providerUpdatePinning.ts";
import type {
  ProviderMaintenanceCapabilities,
  ProviderMaintenanceCommandAction,
} from "./providerMaintenance.ts";
import { BUNDLED_MODEL_MANIFEST, ModelManifest } from "./ModelManifest.ts";
import { rateProviderVersion } from "./providerCompatibility.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { collectUint8StreamText } from "../stream/collectUint8StreamText.ts";

const UPDATE_TIMEOUT_MS = 5 * 60_000;
const UPDATE_OUTPUT_MAX_BYTES = 10_000;

export interface ProviderMaintenanceCommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

interface VerifiedProviderRefresh {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly verifiedProviders: ReadonlyArray<ServerProvider>;
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const runProviderMaintenanceCommandWithSpawner = Effect.fn("ProviderMaintenanceRunner.runCommand")(
  function* (input: {
    readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly env: NodeJS.ProcessEnv | undefined;
    /** Runs once the installer has spawned; a failure stops it before it gets far. */
    readonly onSpawned: (pid: number) => Effect.Effect<void, Error>;
  }) {
    const collectCommandResult = Effect.fn("ProviderMaintenanceRunner.collectCommandResult")(
      function* () {
        // Windows package managers are `.cmd` shims that only start through `cmd.exe`.
        const child = yield* input.spawner
          .spawn(
            makeMaintenanceChildProcess({
              command: input.command,
              args: input.args,
              env: input.env,
            }),
          )
          .pipe(
            Effect.mapError(
              (cause) =>
                new Error(`Failed to run update command ${input.command}: ${cause.message}`),
            ),
          );
        yield* Effect.addFinalizer(() => child.kill().pipe(Effect.ignore));
        yield* input.onSpawned(child.pid);

        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            collectUint8StreamText({
              stream: child.stdout,
              maxBytes: UPDATE_OUTPUT_MAX_BYTES,
            }),
            collectUint8StreamText({
              stream: child.stderr,
              maxBytes: UPDATE_OUTPUT_MAX_BYTES,
            }),
            child.exitCode,
          ],
          { concurrency: "unbounded" },
        ).pipe(
          Effect.mapError(
            (cause) =>
              new Error(cause instanceof Error ? cause.message : "Update command failed to run."),
          ),
        );

        return {
          stdout: stdout.text,
          stderr: stderr.text,
          exitCode: Number(exitCode),
          timedOut: false,
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
        } satisfies ProviderMaintenanceCommandResult;
      },
    );

    return yield* collectCommandResult().pipe(
      Effect.scoped,
      Effect.timeoutOption(Duration.millis(UPDATE_TIMEOUT_MS)),
      Effect.map((result) =>
        Option.match(result, {
          onSome: (value) => value,
          onNone: () =>
            ({
              stdout: "",
              stderr: "",
              exitCode: null,
              timedOut: true,
              stdoutTruncated: false,
              stderrTruncated: false,
            }) satisfies ProviderMaintenanceCommandResult,
        }),
      ),
    );
  },
);

function trimNullable(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function truncateText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function commandOutput(result: ProviderMaintenanceCommandResult): string | null {
  const output = trimNullable([result.stderr, result.stdout].filter(Boolean).join("\n\n"));
  if (!output) {
    return null;
  }
  return truncateText(output, UPDATE_OUTPUT_MAX_BYTES);
}

function failureMessage(result: ProviderMaintenanceCommandResult): string {
  if (result.timedOut) {
    return "Update timed out.";
  }
  if (result.exitCode !== null && result.exitCode !== 0) {
    return `Update command exited with code ${result.exitCode}.`;
  }
  return "Update command failed.";
}

function isOutdatedProvider(provider: ServerProvider | undefined): boolean {
  return provider?.versionAdvisory?.status === "behind_latest";
}

function makeUpdateState(input: {
  readonly status: ServerProviderUpdateState["status"];
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly message: string | null;
  readonly output?: string | null;
}): ServerProviderUpdateState {
  return {
    status: input.status,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    message: input.message,
    output: input.output ?? null,
  };
}

export const make = Effect.fn("ProviderMaintenanceRunner.make")(function* () {
  const providerRegistry = yield* ProviderRegistry;
  const installLock = yield* ProviderInstallLock;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const httpClient = yield* HttpClient.HttpClient;
  const serverSettings = yield* ServerSettingsService;
  const manifestService = yield* Effect.serviceOption(ModelManifest);
  const currentManifest = Option.match(manifestService, {
    onNone: () => Effect.succeed(BUNDLED_MODEL_MANIFEST),
    onSome: (service) => service.current,
  });
  const runMaintenanceCommand = (
    action: ProviderMaintenanceCommandAction,
    onSpawned: (pid: number) => Effect.Effect<void, Error>,
  ) =>
    runProviderMaintenanceCommandWithSpawner({
      spawner,
      command: action.executable,
      args: action.args,
      env: action.env,
      onSpawned,
    });
  const commandCoordinator = yield* makeProviderMaintenanceCommandCoordinator({
    makeAlreadyRunningError: () =>
      new ServerProviderUpdateError({
        provider: ProviderDriverKind.make("unknown"),
        reason: "An update is already running for this provider.",
      }),
  });

  const verifyRefreshedProvider = (
    provider: ProviderDriverKind,
    maintenanceCapabilities: ProviderMaintenanceCapabilities,
    instanceId: ProviderInstanceId,
  ): Effect.Effect<VerifiedProviderRefresh> =>
    providerRegistry.getProviders.pipe(
      Effect.map((providers) =>
        providers
          .filter(
            (candidate) => candidate.driver === provider && candidate.instanceId === instanceId,
          )
          .map((candidate) => candidate.instanceId),
      ),
      Effect.flatMap((instanceIds) =>
        instanceIds.length === 0
          ? providerRegistry.refreshInstance(instanceId)
          : Effect.forEach(
              instanceIds,
              (instanceId) => providerRegistry.refreshInstance(instanceId),
              {
                concurrency: "unbounded",
                discard: true,
              },
            ).pipe(Effect.andThen(providerRegistry.getProviders)),
      ),
      Effect.flatMap((providers) => {
        const refreshedProviders = providers.filter(
          (candidate) => candidate.driver === provider && candidate.instanceId === instanceId,
        );
        if (refreshedProviders.length === 0) {
          return Effect.succeed<VerifiedProviderRefresh>({
            providers,
            verifiedProviders: [],
          });
        }
        return Effect.forEach(
          refreshedProviders,
          (refreshedProvider) =>
            enrichProviderSnapshotWithVersionAdvisory(
              refreshedProvider,
              maintenanceCapabilities,
            ).pipe(
              Effect.provideService(HttpClient.HttpClient, httpClient),
              Effect.provideService(ServerSettingsService, serverSettings),
            ),
          {
            concurrency: "unbounded",
          },
        ).pipe(
          Effect.map((verifiedProviders): VerifiedProviderRefresh => ({
            providers,
            verifiedProviders,
          })),
          Effect.catchCause((cause) =>
            Effect.logWarning("Provider post-update version verification failed", {
              provider,
              cause: Cause.pretty(cause),
            }).pipe(
              Effect.as<VerifiedProviderRefresh>({
                providers,
                verifiedProviders: refreshedProviders,
              }),
            ),
          ),
        );
      }),
    );

  /** Records an instance's update state; every step of a run that ran an installer goes here. */
  const updateStateWriter = (instanceId: ProviderInstanceId) => {
    const setUpdateState = (state: ServerProviderUpdateState | null) =>
      providerRegistry.setProviderMaintenanceActionState({
        instanceId,
        action: "update",
        state,
      });
    return {
      setUpdateState,
      finish: (state: ServerProviderUpdateState) =>
        setUpdateState(state).pipe(Effect.map((providers) => ({ providers, state }))),
    };
  };

  /**
   * The one install path: marks the instance running, runs `action` under the host lock the
   * caller holds, then verifies the installed version and records the result. One-click and
   * unattended updates differ only in the gate before it.
   */
  const installAndVerify = Effect.fn("ProviderMaintenanceRunner.installAndVerify")(
    function* (input: {
      readonly provider: ProviderDriverKind;
      readonly instanceId: ProviderInstanceId;
      readonly capabilities: ProviderMaintenanceCapabilities;
      readonly action: ProviderMaintenanceCommandAction;
      readonly startedAtRef: Ref.Ref<string | null>;
      readonly recordChildPid: (pid: number) => Effect.Effect<void, Error>;
      /** Prefixes every recorded message, so an update nobody clicked says so. */
      readonly messagePrefix: string;
    }) {
      const { setUpdateState, finish } = updateStateWriter(input.instanceId);
      const message = (text: string) => `${input.messagePrefix}${text}`;
      const startedAt = yield* nowIso;
      yield* Ref.set(input.startedAtRef, startedAt);
      yield* setUpdateState(
        makeUpdateState({
          status: "running",
          startedAt,
          finishedAt: null,
          message: message("Updating provider."),
        }),
      );

      const result = yield* runMaintenanceCommand(input.action, input.recordChildPid);
      const finishedAt = yield* nowIso;
      if (result.timedOut || result.exitCode !== 0) {
        return yield* finish(
          makeUpdateState({
            status: "failed",
            startedAt,
            finishedAt,
            message: message(failureMessage(result)),
            output: commandOutput(result),
          }),
        );
      }

      const { verifiedProviders } = yield* verifyRefreshedProvider(
        input.provider,
        input.capabilities,
        input.instanceId,
      );
      const couldNotVerify = verifiedProviders.length === 0;
      const stillOutdated =
        couldNotVerify ||
        verifiedProviders.some((verifiedProvider) => isOutdatedProvider(verifiedProvider));
      return yield* finish(
        makeUpdateState({
          status: stillOutdated ? "unchanged" : "succeeded",
          startedAt,
          finishedAt,
          message: message(
            couldNotVerify
              ? "Update command completed, but Ryco could not verify the provider version."
              : stillOutdated
                ? "Update command completed, but Ryco still detects an outdated provider version."
                : "Provider updated.",
          ),
          output: commandOutput(result),
        }),
      );
    },
  );

  /** Any failure of a run, recorded as the instance's failed update. */
  const recordFailedUpdate = (
    instanceId: ProviderInstanceId,
    startedAtRef: Ref.Ref<string | null>,
    messagePrefix: string,
  ) =>
    Effect.fn("ProviderMaintenanceRunner.recordFailedUpdate")(function* (
      cause: Cause.Cause<unknown>,
    ) {
      const failure = Cause.squash(cause);
      return yield* updateStateWriter(instanceId).finish(
        makeUpdateState({
          status: "failed",
          startedAt: yield* Ref.get(startedAtRef),
          finishedAt: yield* nowIso,
          message: `${messagePrefix}${failure instanceof Error ? failure.message : "Update command failed."}`,
          output: null,
        }),
      );
    });

  const resolveInstance = (
    target:
      | ProviderDriverKind
      | {
          readonly provider: ProviderDriverKind;
          readonly instanceId?: ProviderInstanceId | undefined;
        },
  ) => {
    const provider = typeof target === "string" ? target : target.provider;
    const instanceId =
      typeof target === "string"
        ? defaultInstanceIdForDriver(provider)
        : (target.instanceId ?? defaultInstanceIdForDriver(provider));
    return { provider, instanceId, targetKey: `instance:${instanceId}` };
  };

  const updateProvider: ProviderMaintenanceRunnerShape["updateProvider"] = Effect.fn(
    "ProviderMaintenanceRunner.updateProvider",
  )(function* (target) {
    const { provider, instanceId, targetKey } = resolveInstance(target);
    const capabilities = yield* providerRegistry.getProviderMaintenanceCapabilitiesForInstance(
      instanceId,
      provider,
    );
    const update = capabilities.update;
    if (!update) {
      return yield* new ServerProviderUpdateError({
        provider,
        reason: "This provider does not support one-click updates.",
      });
    }

    const { setUpdateState, finish } = updateStateWriter(instanceId);
    const setQueuedState = setUpdateState(
      makeUpdateState({
        status: "queued",
        startedAt: null,
        finishedAt: null,
        message: "Waiting for another provider update to finish.",
      }),
    ).pipe(Effect.asVoid);

    const runProviderUpdate = Effect.fn("ProviderMaintenanceRunner.runProviderUpdate")(
      function* () {
        const startedAtRef = yield* Ref.make<string | null>(null);

        const runCommandAndVerify = Effect.fn("ProviderMaintenanceRunner.runCommandAndVerify")(
          function* (recordChildPid: (pid: number) => Effect.Effect<void, Error>) {
            // Compatibility gate, inside the command lock so a queued update re-checks after
            // its wait. It rates the version the installer would install right now (a fresh
            // lookup through the installer's own channel, e.g. `brew info` or `pnpm outdated`,
            // else npm; never the snapshot's cached rating) against the current manifest,
            // bundled policies and code-owned floors. The lookup runs even with provider update
            // checks disabled: the user asked for this update, and the install contacts the
            // registry anyway. An unknown latest version (no package, offline) is not blocked.
            const latestVersion = yield* resolveLatestProviderVersion(capabilities, {
              fresh: true,
            }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
            if (latestVersion !== null) {
              const rating = rateProviderVersion({
                manifest: yield* currentManifest,
                driver: provider,
                version: latestVersion,
              });
              if (isBlockingProviderCompatibilityStatus(rating?.status)) {
                const label = latestVersion.startsWith("v") ? latestVersion : `v${latestVersion}`;
                return yield* finish(
                  makeUpdateState({
                    status: "failed",
                    startedAt: null,
                    finishedAt: yield* nowIso,
                    message: `Ryco did not install ${label}: ${rating?.message ?? "it is not compatible with this Ryco release."}`,
                  }),
                );
              }
            }

            // pnpm installs the exact version that was rated, not whatever `@latest` resolves to.
            return yield* installAndVerify({
              provider,
              instanceId,
              capabilities,
              action: resolveLatestProviderUpdateAction(capabilities, latestVersion) ?? update,
              startedAtRef,
              recordChildPid,
              messagePrefix: "",
            });
          },
        );

        // Host-wide, inside this process's lock: another Ryco on this machine (Desktop, a CLI
        // service, Nightly, a dev server) may run an installer on the same target. Held through
        // verification. When it is held, wait for it, then start over from the compatibility
        // gate, which re-checks what would be installed now.
        return yield* installLock.lock.pipe(
          Effect.flatMap((lock) =>
            lock.runWhenFree(
              update.lockKey,
              setUpdateState(
                makeUpdateState({
                  status: "queued",
                  startedAt: null,
                  finishedAt: null,
                  message: "Another Ryco on this machine is updating this CLI.",
                }),
              ),
              runCommandAndVerify,
            ),
          ),
          Effect.catchCause(recordFailedUpdate(instanceId, startedAtRef, "")),
          Effect.map(({ providers }) => ({ providers })),
        );
      },
    );

    return yield* commandCoordinator
      .withCommandLock({
        targetKey,
        lockKey: update.lockKey,
        onQueued: setQueuedState,
        run: runProviderUpdate(),
      })
      .pipe(
        Effect.mapError((error) =>
          Schema.is(ServerProviderUpdateError)(error)
            ? new ServerProviderUpdateError({
                provider,
                reason: error.reason,
              })
            : error,
        ),
      );
  });

  const updateProviderUnattended: ProviderMaintenanceRunnerShape["updateProviderUnattended"] =
    Effect.fn("ProviderMaintenanceRunner.updateProviderUnattended")(function* (input) {
      const { provider, instanceId, targetKey } = resolveInstance(input);
      const skipped = (reason: string) => ({ kind: "skipped", reason }) as const;
      const postponed = (reason: string) => ({ kind: "postponed", reason }) as const;
      const capabilities = yield* providerRegistry.getProviderMaintenanceCapabilitiesForInstance(
        instanceId,
        provider,
      );
      const update = capabilities.update;
      if (!update) return skipped("This provider does not support one-click updates.");

      const startedAtRef = yield* Ref.make<string | null>(null);
      const messagePrefix = "Automatic update: ";

      // Under both locks, so it judges what would be installed right now. Nothing it rejects
      // touches the instance's update state; only a run that starts an installer records one.
      const gateAndInstall = Effect.fn("ProviderMaintenanceRunner.unattendedGateAndInstall")(
        function* (recordChildPid: (pid: number) => Effect.Effect<void, Error>) {
          const latestVersion = yield* resolveLatestProviderVersion(capabilities, {
            fresh: true,
          }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));
          if (latestVersion !== input.targetVersion) {
            return skipped("The newest release changed since this pass picked it.");
          }
          const rating = rateProviderVersion({
            manifest: yield* currentManifest,
            driver: provider,
            version: latestVersion,
          });
          if (rating?.status !== "supported") {
            return skipped(
              `This Ryco release rates ${latestVersion} ${rating?.status ?? "unknown"}.`,
            );
          }
          const action = resolvePinnedProviderUpdateAction(capabilities, latestVersion);
          if (action === null)
            return skipped(`Its installer cannot be pinned to ${latestVersion}.`);
          // Probed again: another Ryco on this machine, or a one-click update, may have
          // installed it meanwhile, or the instance was turned off.
          const current = (yield* providerRegistry.refreshInstance(instanceId)).find(
            (candidate) => candidate.instanceId === instanceId,
          );
          if (!current?.enabled || !current.installed) {
            return skipped("The provider is turned off or no longer installed.");
          }
          const advisory = createProviderVersionAdvisory({
            driver: provider,
            currentVersion: current.version,
            latestVersion,
            maintenanceCapabilities: capabilities,
          });
          if (advisory.status !== "behind_latest") {
            return skipped(`${latestVersion} is not newer than the installed version.`);
          }
          if (!(yield* input.beforeInstall.pipe(Effect.orElseSucceed(() => false)))) {
            return postponed("The update window closed.");
          }
          const { state } = yield* installAndVerify({
            provider,
            instanceId,
            capabilities,
            action,
            startedAtRef,
            recordChildPid,
            messagePrefix,
          });
          return state.status === "failed"
            ? ({ kind: "failed", message: state.message ?? "Update command failed." } as const)
            : ({ kind: "installed", version: latestVersion } as const);
        },
      );

      const run = installLock.lock.pipe(
        Effect.flatMap((lock) => lock.tryRun(update.lockKey, gateAndInstall)),
        Effect.map(
          Option.getOrElse(() => postponed("Another Ryco on this machine is installing this CLI.")),
        ),
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            // Before an installer started (a lookup, a probe, the lock folder) nothing changed
            // on disk: logged and retried like a failed install, without an update state.
            if ((yield* Ref.get(startedAtRef)) === null) {
              yield* Effect.logWarning("Automatic provider update could not start", {
                instanceId,
                cause: Cause.pretty(cause),
              });
              return { kind: "failed", message: "The update could not start." } as const;
            }
            const { state } = yield* recordFailedUpdate(
              instanceId,
              startedAtRef,
              messagePrefix,
            )(cause);
            return { kind: "failed", message: state.message ?? "Update command failed." } as const;
          }),
        ),
      );
      const outcome = yield* commandCoordinator.tryWithCommandLock({
        targetKey,
        lockKey: update.lockKey,
        run,
      });
      return Option.getOrElse(outcome, () => postponed("Another update of this CLI is running."));
    });

  return { updateProvider, updateProviderUnattended } satisfies ProviderMaintenanceRunnerShape;
});
