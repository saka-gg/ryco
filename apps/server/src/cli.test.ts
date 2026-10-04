import * as NodeHttp from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { NetService } from "@ryco/shared/Net";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import * as CliError from "effect/unstable/cli/CliError";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/unstable/cli";

import { cli } from "./cli.ts";
import { deriveServerPaths, ServerConfig, type ServerConfigShape } from "./config.ts";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationLayerLive } from "./orchestration/runtimeLayer.ts";
import {
  orchestrationDispatchRouteLayer,
  orchestrationSnapshotRouteLayer,
} from "./orchestration/http.ts";
import { layerConfig as SqlitePersistenceLayerLive } from "./persistence/Layers/Sqlite.ts";
import { ProjectAvatarStoreLive } from "./project/Layers/ProjectAvatarStore.ts";
import { RepositoryIdentityResolverLive } from "./project/Layers/RepositoryIdentityResolver.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "./serverRuntimeState.ts";
import { WorkspacePathsLive } from "./workspace/Layers/WorkspacePaths.ts";
import { WorkspaceAccessPolicyLayer } from "./workspace/Layers/WorkspaceAccessPolicy.ts";
import { ServerSecretStoreLive } from "./auth/Layers/ServerSecretStore.ts";
import { ServerAuthLive } from "./auth/Layers/ServerAuth.ts";
import { hubConnectorRoutesLayer } from "./hubConnector/http.ts";
import {
  HubConnectorService,
  type HubConnectorE2eeOperator,
  type HubConnectorServiceShape,
} from "./hubConnector/HubConnectorLive.ts";
import {
  stubClientListing,
  stubClientRecord,
  stubE2eeOperator,
  stubLocalIntroductionService,
  stubNativeNodeClaimService,
  stubPolicy,
} from "./hubConnector/testUtils/e2eeOperatorStub.ts";
import { E2EE_CONTINUITY_UNRESOLVABLE_REMEDY } from "./hubIdentity/NodeIdentityContinuityStore.ts";
import { E2EE_PREKEY_EXPIRED_REMEDY } from "./hubIdentity/NodeE2eePrekeyClient.ts";

const CliRuntimeLayer = Layer.mergeAll(NodeServices.layer, NetService.layer);

const runCli = (args: ReadonlyArray<string>) => Command.runWith(cli, { version: "0.0.0" })(args);
const runCliWithRuntime = (args: ReadonlyArray<string>) =>
  runCli(args).pipe(Effect.provide(CliRuntimeLayer));

/**
 * Capture everything ONE command wrote to stdout, isolated from every other.
 *
 * `lines` is the whole transcript of this call, and `output` is its last
 * emission — the command's document, which is what a `--json` test parses and
 * what a single-emission human command writes in full. A test about a command
 * that emits more than once joins `lines` itself.
 *
 * `Layer.fresh` IS LOad-BEARING AND MUST NOT BE DROPPED. `@effect/vitest`
 * already provides `TestConsole.layer` to every `it.effect`, and layers are
 * memoized per suite runtime — so a bare `Effect.provide(TestConsole.layer)`
 * resolves to the SAME console instance for the whole `it.layer` block, whose
 * entries never reset. Every call then returned the accumulated output of every
 * command the module had run so far: `output` was the previous test's last line
 * whenever the command under test emitted nothing, an `assert.include` over
 * `lines` passed on a neighbour's output, and a test could not fail for
 * printing nothing at all. `Layer.fresh` builds a new console per call, so a
 * capture contains exactly what its own effect wrote.
 *
 * Note that this captures the Effect LOGGER as well, because the default logger
 * writes through the `Console` service. That is deliberate: it is what lets the
 * `--json` tests below assert that no log line reaches stdout.
 */
const captureStdout = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const result = yield* effect;
    const lines = (yield* TestConsole.logLines).filter(
      (line): line is string => typeof line === "string",
    );
    return { result, lines, output: lines.at(-1) ?? "" };
  }).pipe(Effect.provide(Layer.mergeAll(CliRuntimeLayer, Layer.fresh(TestConsole.layer))));

const makeCliTestServerConfig = (baseDir: string) =>
  Effect.gen(function* () {
    const derivedPaths = yield* deriveServerPaths(baseDir, undefined);
    return {
      logLevel: "Info",
      traceMinLevel: "Info",
      traceTimingEnabled: true,
      traceBatchWindowMs: 200,
      traceMaxBytes: 10 * 1024 * 1024,
      traceMaxFiles: 10,
      otlpTracesUrl: undefined,
      otlpMetricsUrl: undefined,
      otlpExportIntervalMs: 10_000,
      otlpServiceName: "ryco-server",
      mode: "web",
      port: 0,
      host: "127.0.0.1",
      cwd: process.cwd(),
      baseDir,
      ...derivedPaths,
      staticDir: undefined,
      devUrl: undefined,
      noBrowser: true,
      startupPresentation: "browser",
      desktopBootstrapToken: undefined,
      autoBootstrapProjectFromCwd: false,
      logWebSocketEvents: false,
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
    } satisfies ServerConfigShape;
  });

const makeProjectPersistenceLayer = (config: ServerConfigShape) =>
  Layer.mergeAll(
    OrchestrationLayerLive.pipe(
      Layer.provideMerge(RepositoryIdentityResolverLive),
      Layer.provideMerge(ProjectAvatarStoreLive({ dataDir: config.stateDir })),
      Layer.provideMerge(SqlitePersistenceLayerLive),
    ),
    WorkspaceAccessPolicyLayer(config.workspaceAccessRoot),
    WorkspacePathsLive,
  ).pipe(
    Layer.provideMerge(NodeServices.layer),
    Layer.provide(Layer.succeed(ServerConfig, config)),
  );

const readPersistedSnapshot = (baseDir: string) =>
  Effect.gen(function* () {
    const config = yield* makeCliTestServerConfig(baseDir);
    return yield* Effect.gen(function* () {
      const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
      return yield* projectionSnapshotQuery.getSnapshot();
    }).pipe(Effect.provide(makeProjectPersistenceLayer(config)));
  });

const withLiveProjectCliServer = <A, E, R>(baseDir: string, run: () => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const config = yield* makeCliTestServerConfig(baseDir);
    const routesLayer = Layer.mergeAll(
      orchestrationSnapshotRouteLayer,
      orchestrationDispatchRouteLayer,
    );
    const appLayer = HttpRouter.serve(routesLayer, {
      disableListenLog: true,
      disableLogger: true,
    }).pipe(
      Layer.provideMerge(
        ServerAuthLive.pipe(
          Layer.provideMerge(SqlitePersistenceLayerLive),
          Layer.provide(ServerSecretStoreLive),
        ),
      ),
      Layer.provideMerge(makeProjectPersistenceLayer(config)),
      Layer.provideMerge(
        NodeHttpServer.layer(NodeHttp.createServer, {
          host: "127.0.0.1",
          port: 0,
        }),
      ),
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(Layer.succeed(ServerConfig, config)),
    );

    return yield* Effect.scoped(
      Effect.gen(function* () {
        const server = yield* HttpServer.HttpServer;
        const address = server.address;
        if (typeof address === "string" || !("port" in address)) {
          assert.fail(`Expected TCP address, got ${address}`);
        }
        yield* persistServerRuntimeState({
          path: config.serverRuntimeStatePath,
          state: makePersistedServerRuntimeState({
            config,
            port: address.port,
          }),
        });
        return yield* run();
      }).pipe(Effect.provide(Layer.mergeAll(appLayer, NodeServices.layer))),
    );
  });

const withLiveHubCliServer = <A, E, R>(
  baseDir: string,
  run: () => Effect.Effect<A, E, R>,
  e2ee: Partial<HubConnectorE2eeOperator> = {},
  /** The connector's own members, for a test about an enrollment-lifecycle answer. */
  hub: Partial<HubConnectorServiceShape> = {},
) =>
  Effect.gen(function* () {
    const config = yield* makeCliTestServerConfig(baseDir);
    const waitingStatus = {
      state: "awaiting_approval" as const,
      transitionedAt: "1970-01-01T00:00:00.000Z",
      activeChannels: 0,
      queuedBytes: 0,
    };
    const appLayer = HttpRouter.serve(hubConnectorRoutesLayer, {
      disableListenLog: true,
      disableLogger: true,
    }).pipe(
      Layer.provide(
        Layer.succeed(HubConnectorService, {
          status: () => waitingStatus,
          resume: async () => undefined,
          enroll: async () => {
            await new Promise((resolve) => setTimeout(resolve, 1_100));
            return {
              status: waitingStatus,
              deviceCode: "ABCD-EFGH",
              fingerprint: `SHA256:${"A".repeat(43)}`,
              label: "Test Node",
              platformOs: "darwin" as const,
              platformArch: "arm64" as const,
              clientVersion: "0.0.0",
              algorithm: "ed25519" as const,
              expiresAt: "1970-01-01T00:10:00.000Z",
              pollIntervalMs: 5_000,
            };
          },
          identitySummary: async () => ({
            enrolled: "active" as const,
            fingerprint: `SHA256:${"A".repeat(43)}`,
          }),
          leave: async () => waitingStatus,
          readEnrollment: async () => ({
            deviceCode: "ABCD-EFGH",
            fingerprint: `SHA256:${"A".repeat(43)}`,
            label: "Test Node",
            platformOs: "darwin" as const,
            platformArch: "arm64" as const,
            clientVersion: "0.0.0",
            algorithm: "ed25519" as const,
            expiresAt: "1970-01-01T00:10:00.000Z",
            pollIntervalMs: 5_000,
          }),
          cancelEnrollment: async () => ({ ...waitingStatus, state: "enrolling" as const }),
          stop: async () => undefined,
          localIntroduction: stubLocalIntroductionService(),
          nativeNodeClaim: stubNativeNodeClaimService(),
          e2ee: stubE2eeOperator(e2ee),
          ...hub,
        }),
      ),
      Layer.provideMerge(
        ServerAuthLive.pipe(
          Layer.provideMerge(SqlitePersistenceLayerLive),
          Layer.provide(ServerSecretStoreLive),
        ),
      ),
      Layer.provideMerge(
        NodeHttpServer.layer(NodeHttp.createServer, {
          host: "127.0.0.1",
          port: 0,
        }),
      ),
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(Layer.succeed(ServerConfig, config)),
    );

    return yield* Effect.scoped(
      Effect.gen(function* () {
        const server = yield* HttpServer.HttpServer;
        const address = server.address;
        if (typeof address === "string" || !("port" in address)) {
          assert.fail(`Expected TCP address, got ${address}`);
        }
        yield* persistServerRuntimeState({
          path: config.serverRuntimeStatePath,
          state: makePersistedServerRuntimeState({ config, port: address.port }),
        });
        return yield* run();
      }).pipe(Effect.provide(Layer.mergeAll(appLayer, NodeServices.layer))),
    );
  });

it.layer(NodeServices.layer)("cli log-level parsing", (it) => {
  it.effect("accepts the built-in lowercase log-level flag values", () =>
    runCliWithRuntime(["--log-level", "debug", "--version"]),
  );

  it.effect("accepts canonical --no-<flag> boolean negation", () =>
    runCliWithRuntime(["--no-log-websocket-events", "--version"]),
  );

  it.effect("accepts restricted workspace flags on root, start, and serve commands", () =>
    Effect.forEach(
      [[], ["start"], ["serve"]],
      (command) => runCliWithRuntime([...command, "--restrict-to-cwd", "--version"]),
      { discard: true },
    ),
  );

  it.effect("accepts canonical negative restricted workspace flag", () =>
    runCliWithRuntime(["--no-restrict-to-cwd", "--version"]),
  );

  it.effect("accepts Hub connector flags on root, start, and serve commands", () =>
    Effect.forEach(
      [[], ["start"], ["serve"]],
      (command) =>
        runCliWithRuntime([
          ...command,
          "--hub-connector-enabled",
          "--hub-origin",
          "https://hub.example.test",
          "--hub-node-name",
          "Build node",
          "--hub-allow-file-secret-store",
          "--version",
        ]),
      { discard: true },
    ),
  );

  it.effect("accepts canonical negative Hub connector boolean flags", () =>
    runCliWithRuntime([
      "--no-hub-connector-enabled",
      "--no-hub-allow-file-secret-store",
      "--version",
    ]),
  );

  it.effect("rejects invalid log-level casing before launching the server", () =>
    Effect.gen(function* () {
      const error = yield* runCliWithRuntime(["--log-level", "Debug"]).pipe(Effect.flip);

      if (!CliError.isCliError(error)) {
        assert.fail(`Expected CliError, got ${String(error)}`);
      }
      if (error._tag !== "InvalidValue") {
        assert.fail(`Expected InvalidValue, got ${error._tag}`);
      }
      assert.equal(error.option, "log-level");
      assert.equal(error.value, "Debug");
    }),
  );

  it.effect("executes auth pairing subcommands and redacts secrets from list output", () =>
    Effect.gen(function* () {
      const baseDir = mkdtempSync(join(tmpdir(), "ryco-cli-auth-pairing-test-"));

      const createdOutput = yield* captureStdout(
        runCli(["auth", "pairing", "create", "--base-dir", baseDir, "--json"]),
      );
      const created = JSON.parse(createdOutput.output) as {
        readonly id: string;
        readonly credential: string;
      };
      const listedOutput = yield* captureStdout(
        runCli(["auth", "pairing", "list", "--base-dir", baseDir, "--json"]),
      );
      const listed = JSON.parse(listedOutput.output) as ReadonlyArray<{
        readonly id: string;
        readonly credential?: string;
      }>;

      assert.equal(typeof created.id, "string");
      assert.equal(typeof created.credential, "string");
      assert.equal(created.credential.length > 0, true);
      assert.equal(listed.length, 1);
      assert.equal(listed[0]?.id, created.id);
      assert.equal("credential" in (listed[0] ?? {}), false);
    }),
  );

  it.effect("executes auth session subcommands and redacts secrets from list output", () =>
    Effect.gen(function* () {
      const baseDir = mkdtempSync(join(tmpdir(), "ryco-cli-auth-session-test-"));

      const issuedOutput = yield* captureStdout(
        runCli(["auth", "session", "issue", "--base-dir", baseDir, "--json"]),
      );
      const issued = JSON.parse(issuedOutput.output) as {
        readonly sessionId: string;
        readonly token: string;
        readonly role: string;
      };
      const listedOutput = yield* captureStdout(
        runCli(["auth", "session", "list", "--base-dir", baseDir, "--json"]),
      );
      const listed = JSON.parse(listedOutput.output) as ReadonlyArray<{
        readonly sessionId: string;
        readonly token?: string;
        readonly role: string;
      }>;

      assert.equal(typeof issued.sessionId, "string");
      assert.equal(typeof issued.token, "string");
      assert.equal(issued.role, "owner");
      assert.equal(listed.length, 1);
      assert.equal(listed[0]?.sessionId, issued.sessionId);
      assert.equal(listed[0]?.role, "owner");
      assert.equal("token" in (listed[0] ?? {}), false);
    }),
  );

  it.effect("rejects invalid ttl values before running auth commands", () =>
    Effect.gen(function* () {
      const error = yield* runCliWithRuntime(["auth", "pairing", "create", "--ttl", "soon"]).pipe(
        Effect.flip,
      );

      if (!CliError.isCliError(error)) {
        assert.fail(`Expected CliError, got ${String(error)}`);
      }
      if (error._tag !== "ShowHelp") {
        assert.fail(`Expected ShowHelp, got ${error._tag}`);
      }
      assert.deepEqual(error.commandPath, ["ryco", "auth", "pairing", "create"]);
      const ttlError = error.errors[0] as CliError.CliError | undefined;
      if (!ttlError || ttlError._tag !== "InvalidValue") {
        assert.fail(`Expected InvalidValue, got ${String(ttlError?._tag)}`);
      }
      assert.equal(ttlError.option, "ttl");
      assert.equal(ttlError.value, "soon");
      assert.isTrue(ttlError.message.includes("Invalid duration"));
      assert.isTrue(ttlError.message.includes("5m, 1h, 30d, or 15 minutes"));
    }),
  );

  it.effect("adds, renames, and removes projects offline through the orchestration engine", () =>
    Effect.gen(function* () {
      const baseDir = mkdtempSync(join(tmpdir(), "ryco-cli-projects-offline-test-"));
      const workspaceRoot = mkdtempSync(join(tmpdir(), "ryco-cli-projects-workspace-"));

      yield* runCliWithRuntime([
        "project",
        "add",
        workspaceRoot,
        "--title",
        "Alpha",
        "--base-dir",
        baseDir,
      ]);
      const afterAdd = yield* readPersistedSnapshot(baseDir);
      const addedProject = afterAdd.projects.find(
        (project) => project.workspaceRoot === workspaceRoot && project.deletedAt === null,
      );
      assert.isTrue(addedProject !== undefined);
      assert.equal(addedProject?.title, "Alpha");

      yield* runCliWithRuntime(["project", "rename", workspaceRoot, "Beta", "--base-dir", baseDir]);
      const afterRename = yield* readPersistedSnapshot(baseDir);
      const renamedProject = afterRename.projects.find(
        (project) => project.id === addedProject?.id,
      );
      assert.equal(renamedProject?.title, "Beta");
      assert.equal(renamedProject?.deletedAt, null);

      yield* runCliWithRuntime([
        "project",
        "remove",
        addedProject?.id ?? "",
        "--base-dir",
        baseDir,
      ]);
      const afterRemove = yield* readPersistedSnapshot(baseDir);
      const removedProject = afterRemove.projects.find(
        (project) => project.id === addedProject?.id,
      );
      assert.isTrue((removedProject?.deletedAt ?? null) !== null);
    }),
  );

  it.effect("routes project commands through a running server when runtime state is present", () =>
    Effect.gen(function* () {
      const baseDir = mkdtempSync(join(tmpdir(), "ryco-cli-projects-live-test-"));
      const workspaceRoot = mkdtempSync(join(tmpdir(), "ryco-cli-projects-live-workspace-"));

      yield* withLiveProjectCliServer(baseDir, () =>
        Effect.gen(function* () {
          yield* runCliWithRuntime([
            "project",
            "add",
            workspaceRoot,
            "--title",
            "Live Project",
            "--base-dir",
            baseDir,
          ]);
          const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
          const readModel = yield* projectionSnapshotQuery.getSnapshot();
          const addedProject = readModel.projects.find(
            (project) => project.workspaceRoot === workspaceRoot && project.deletedAt === null,
          );
          assert.isTrue(addedProject !== undefined);
          assert.equal(addedProject?.title, "Live Project");
        }),
      );
    }),
  );

  it.effect(
    "uses ephemeral local authorization for Hub status, enrollment, cancellation, and resume",
    () =>
      Effect.gen(function* () {
        const baseDir = mkdtempSync(join(tmpdir(), "ryco-cli-hub-live-test-"));
        yield* withLiveHubCliServer(baseDir, () =>
          Effect.gen(function* () {
            const statusOutput = yield* captureStdout(
              runCli(["hub", "status", "--base-dir", baseDir, "--json"]),
            );
            const status = JSON.parse(statusOutput.output) as {
              readonly state?: string;
              readonly fingerprint?: string;
            };
            assert.equal(status.state, "awaiting_approval");
            assert.equal(status.fingerprint, `SHA256:${"A".repeat(43)}`);
            assert.notInclude(statusOutput.output, "publicKey");
            assert.notInclude(statusOutput.output, "secretName");
            assert.notInclude(statusOutput.output, baseDir);

            const humanStatusOutput = yield* captureStdout(
              runCli(["hub", "status", "--base-dir", baseDir]),
            );
            assert.include(humanStatusOutput.output, `Fingerprint: SHA256:${"A".repeat(43)}`);
            assert.notInclude(humanStatusOutput.output, "publicKey");
            assert.notInclude(humanStatusOutput.output, "secretName");
            assert.notInclude(humanStatusOutput.output, baseDir);

            const enrollmentOutput = yield* captureStdout(
              runCli(["hub", "enroll", "--base-dir", baseDir, "--json"]),
            );
            const enrollment = JSON.parse(enrollmentOutput.output) as {
              readonly deviceCode?: string;
              readonly fingerprint?: string;
            };
            assert.equal(enrollment.deviceCode, "ABCD-EFGH");
            assert.equal(enrollment.fingerprint, `SHA256:${"A".repeat(43)}`);

            const humanEnrollmentOutput = yield* captureStdout(
              runCli(["hub", "enroll", "--base-dir", baseDir]),
            );
            assert.include(humanEnrollmentOutput.output, `Fingerprint: SHA256:${"A".repeat(43)}`);
            assert.include(humanEnrollmentOutput.output, "Compare this fingerprint in Hub");
            assert.notInclude(humanEnrollmentOutput.output, "pollingSecret");
            assert.notInclude(humanEnrollmentOutput.output, "publicKey");
            assert.notInclude(humanEnrollmentOutput.output, baseDir);

            const cancellationOutput = yield* captureStdout(
              runCli(["hub", "cancel", "--base-dir", baseDir, "--json"]),
            );
            const cancellation = JSON.parse(cancellationOutput.output) as {
              readonly state?: string;
            };
            assert.equal(cancellation.state, "enrolling");

            const resumeOutput = yield* captureStdout(
              runCli(["hub", "resume", "--base-dir", baseDir, "--json"]),
            );
            const resumed = JSON.parse(resumeOutput.output) as { readonly state?: string };
            assert.equal(resumed.state, "awaiting_approval");

            const pendingOutput = yield* captureStdout(
              runCli(["hub", "pending", "--base-dir", baseDir]),
            );
            assert.include(pendingOutput.output, `Fingerprint: SHA256:${"A".repeat(43)}`);
            assert.include(pendingOutput.output, "Device code: ABCD-EFGH");
            assert.include(pendingOutput.output, "Compare every field");
            assert.notInclude(pendingOutput.output, "pollingSecret");
            assert.notInclude(pendingOutput.output, baseDir);

            const humanResumeOutput = yield* captureStdout(
              runCli(["hub", "resume", "--base-dir", baseDir]),
            );
            assert.include(humanResumeOutput.output, "Hub connector: awaiting_approval");
            assert.notInclude(humanResumeOutput.output, baseDir);
          }),
        );
      }),
  );

  it.effect("shows client authorization records, and the §13.4 safety number, in both forms", () =>
    Effect.gen(function* () {
      const baseDir = mkdtempSync(join(tmpdir(), "ryco-cli-e2ee-clients-test-"));
      const fingerprint = `SHA256:${"B".repeat(42)}A`;
      yield* withLiveHubCliServer(
        baseDir,
        () =>
          Effect.gen(function* () {
            const listJson = yield* captureStdout(
              runCli(["e2ee", "client", "list", "--base-dir", baseDir, "--json"]),
            );
            const listing = JSON.parse(listJson.output) as {
              readonly records: ReadonlyArray<{ readonly fingerprint: string }>;
              readonly pendingGlobalSaturated: boolean;
              readonly refusedPairingAttempts: number;
              readonly pairingWindow?: { readonly fingerprint: string; readonly spent: boolean };
            };
            assert.equal(listing.records.length, 2);
            assert.equal(listing.records[0]?.fingerprint, fingerprint);
            assert.equal(listing.pendingGlobalSaturated, true);
            assert.equal(listing.refusedPairingAttempts, 7);
            assert.equal(listing.pairingWindow?.spent, false);

            const listHuman = yield* captureStdout(
              runCli(["e2ee", "client", "list", "--base-dir", baseDir]),
            );
            // Two records means two fingerprint lines: the previous helper kept
            // only the last logged line, so a listing was untestable at all.
            assert.include(listHuman.output, `Fingerprint: ${fingerprint}`);
            assert.include(listHuman.output, `SHA256:${"D".repeat(42)}A`);
            assert.include(listHuman.output, "Status: approved");
            assert.include(listHuman.output, "Status: pending");
            assert.include(listHuman.output, "Max role: operator");
            // The role the pending device connects with is the `--max-role` an owner
            // must approve it at. The node stops following it once the record
            // leaves pending, so an approved record says when it was read.
            assert.equal(listHuman.output.split("Connects as: owner").length - 1, 1);
            assert.equal(
              listHuman.output.split("Connected as (when introduced): operator").length - 1,
              1,
            );
            assert.notInclude(listHuman.output, "Connects as: operator");
            // §13.6's display duty names the safety number among the LISTING's
            // fields, and §13.4 makes it the value an owner compares before
            // trusting a record. Both records carry it, so an owner comparing a
            // device does not have to run one command per record to see it.
            assert.equal(
              listHuman.output.split("Safety number: 11111 22222 33333 44444 55555").length - 1,
              2,
            );
            assert.include(listHuman.output, "Pending global cap: SATURATED");
            assert.include(listHuman.output, "Pairing attempts refused for pending cap: 7");
            assert.include(listHuman.output, "Pairing window: open");
            assert.include(listHuman.output, "Pairing window reservation: unspent");
            assert.include(listHuman.output, "Pending pairing is saturated");
            assert.notInclude(listHuman.output, baseDir);
            assert.notInclude(listHuman.output, "publicKey");

            const showHuman = yield* captureStdout(
              runCli([
                "e2ee",
                "client",
                "show",
                fingerprint,
                "--hub-origin",
                "https://hub.example.test",
                "--account-id",
                "acct_stub",
                "--base-dir",
                baseDir,
              ]),
            );
            assert.include(showHuman.output, `Fingerprint: ${fingerprint}`);
            assert.include(showHuman.output, "Safety number: 11111 22222 33333 44444 55555");
            assert.include(showHuman.output, "Compare this safety number");
            assert.notInclude(showHuman.output, "publicKey");
            assert.notInclude(showHuman.output, baseDir);

            const showJson = yield* captureStdout(
              runCli([
                "e2ee",
                "client",
                "show",
                fingerprint,
                "--hub-origin",
                "https://hub.example.test",
                "--account-id",
                "acct_stub",
                "--base-dir",
                baseDir,
                "--json",
              ]),
            );
            const record = JSON.parse(showJson.output) as { readonly safetyNumber: string };
            assert.equal(record.safetyNumber, "11111 22222 33333 44444 55555");
          }),
        {
          listClients: async () =>
            stubClientListing({
              records: [
                stubClientRecord({ observedRole: "operator" }),
                stubClientRecord({
                  status: "pending",
                  fingerprint: `SHA256:${"D".repeat(42)}A`,
                  approvedAt: undefined,
                  displayLabel: undefined,
                  pairingReserved: true,
                  observedRole: "owner",
                }),
              ],
              pendingGlobalSaturated: true,
              refusedPairingAttempts: 7,
              pairingWindow: {
                fingerprint: `SHA256:${"D".repeat(42)}A`,
                openedAt: 1_000,
                expiresAt: 301_000,
                spent: false,
              },
            }),
        },
      );
    }),
  );

  it.effect("approves, narrows, and revokes, reporting what each command closed", () =>
    Effect.gen(function* () {
      const baseDir = mkdtempSync(join(tmpdir(), "ryco-cli-e2ee-authorize-test-"));
      const fingerprint = `SHA256:${"B".repeat(42)}A`;
      const key = [
        "--hub-origin",
        "https://hub.example.test",
        "--account-id",
        "acct_stub",
        "--base-dir",
        baseDir,
      ];
      const narrowedCapabilitySets: (readonly string[] | undefined)[] = [];
      yield* withLiveHubCliServer(
        baseDir,
        () =>
          Effect.gen(function* () {
            const approve = yield* captureStdout(
              runCli([
                "e2ee",
                "client",
                "approve",
                fingerprint,
                ...key,
                "--max-role",
                "operator",
                "--capability",
                "ryco.rpc",
              ]),
            );
            assert.include(approve.output, "Approved.");
            assert.include(approve.output, "Closed 0 active E2EE channel(s)");
            assert.include(approve.output, "fresh ticket, channel, and handshake");

            // §13.6: a withdrawal reports how many channels it closed, and it
            // does not report success before the sweep has completed.
            const narrow = yield* captureStdout(
              runCli(["e2ee", "client", "narrow", fingerprint, ...key, "--max-role", "viewer"]),
            );
            assert.include(narrow.output, "Max role: viewer");
            assert.include(
              narrow.output,
              "Narrowed. Closed 3 active E2EE channel(s) and aborted 1 in-flight handshake(s).",
            );

            // §13.6's narrowing test is over the replacement SET, so the flag
            // repeats and the whole set travels; a single-valued flag would make
            // every multi-capability narrowing unstateable.
            const narrowSet = yield* captureStdout(
              runCli([
                "e2ee",
                "client",
                "narrow",
                fingerprint,
                ...key,
                "--capability",
                "ryco.rpc",
                "--capability",
                "ryco.terminal",
                "--json",
              ]),
            );
            assert.deepEqual(narrowedCapabilitySets.at(-1), ["ryco.rpc", "ryco.terminal"]);
            assert.equal(
              (JSON.parse(narrowSet.output) as { readonly closedChannels: number }).closedChannels,
              3,
            );

            const revokeJson = yield* captureStdout(
              runCli(["e2ee", "client", "revoke", fingerprint, ...key, "--json"]),
            );
            const revoked = JSON.parse(revokeJson.output) as {
              readonly closedChannels: number;
              readonly abortedHandshakes: number;
              readonly record?: { readonly status: string };
            };
            assert.equal(revoked.closedChannels, 2);
            assert.equal(revoked.abortedHandshakes, 0);
            assert.equal(revoked.record?.status, "revoked");

            const purge = yield* captureStdout(
              runCli(["e2ee", "client", "purge", fingerprint, ...key]),
            );
            assert.include(purge.output, "Purged.");

            const windowOpen = yield* captureStdout(
              runCli([
                "e2ee",
                "client",
                "window",
                "open",
                fingerprint,
                "--base-dir",
                baseDir,
                "--json",
              ]),
            );
            const windowed = JSON.parse(windowOpen.output) as {
              readonly pairingWindow?: { readonly fingerprint: string };
            };
            assert.equal(windowed.pairingWindow?.fingerprint, fingerprint);
          }),
        {
          narrowClient: async (input) => {
            narrowedCapabilitySets.push(input.capabilitySet);
            return {
              record: stubClientRecord({ maxRole: "viewer" }),
              closedChannels: 3,
              abortedHandshakes: 1,
            };
          },
          revokeClient: async () => ({
            record: stubClientRecord({ status: "revoked", revokedAt: 5_000 }),
            closedChannels: 2,
            abortedHandshakes: 0,
          }),
          openPairingWindow: async (named) =>
            stubClientListing({
              pairingWindow: {
                fingerprint: named,
                openedAt: 1_000,
                expiresAt: 301_000,
                spent: false,
              },
            }),
        },
      );
    }),
  );

  it.effect("renders the approved phone attestation as a terminal QR and JSON", () =>
    Effect.gen(function* () {
      const baseDir = mkdtempSync(join(tmpdir(), "ryco-cli-e2ee-approval-qr-test-"));
      const fingerprint = `SHA256:${"B".repeat(42)}A`;
      const seen: unknown[] = [];
      yield* withLiveHubCliServer(
        baseDir,
        () =>
          Effect.gen(function* () {
            const args = [
              "e2ee",
              "client",
              "approval-qr",
              fingerprint,
              "--hub-origin",
              "https://hub.example.test",
              "--account-id",
              "acct_stub",
              "--base-dir",
              baseDir,
            ];
            const human = yield* captureStdout(runCli(args));
            assert.include(human.output, "Scan this code in Ryco");
            assert.isTrue(
              human.output.includes("█") ||
                human.output.includes("▀") ||
                human.output.includes("▄"),
            );
            assert.include(human.output, "fresh ticket, channel, and IK handshake");
            assert.notInclude(human.output, "ryco-e2ee-approval-v1:test");

            const json = yield* captureStdout(runCli([...args, "--json"]));
            assert.deepInclude(JSON.parse(json.output), {
              payload: "ryco-e2ee-approval-v1:test",
              expiresAt: 303_000,
            });
            assert.deepEqual(seen, [
              {
                hubOrigin: "https://hub.example.test",
                accountId: "acct_stub",
                fingerprint,
              },
              {
                hubOrigin: "https://hub.example.test",
                accountId: "acct_stub",
                fingerprint,
              },
            ]);
          }),
        {
          createClientApprovalQr: async (key) => {
            seen.push(key);
            return {
              payload: "ryco-e2ee-approval-v1:test",
              approvedAt: 1_000,
              issuedAt: 3_000,
              expiresAt: 303_000,
            };
          },
        },
      );
    }),
  );

  it.effect("shows the admission policy and warns before a narrowing change", () =>
    Effect.gen(function* () {
      const baseDir = mkdtempSync(join(tmpdir(), "ryco-cli-e2ee-policy-test-"));
      yield* withLiveHubCliServer(
        baseDir,
        () =>
          Effect.gen(function* () {
            const showJson = yield* captureStdout(
              runCli(["e2ee", "policy", "show", "--base-dir", baseDir, "--json"]),
            );
            const policy = JSON.parse(showJson.output) as {
              readonly requireE2EE: boolean;
              readonly effectiveRequireE2EE: boolean;
              readonly generation: number;
            };
            assert.equal(policy.requireE2EE, false);
            assert.equal(policy.effectiveRequireE2EE, false);
            assert.equal(policy.generation, 3);

            const showHuman = yield* captureStdout(
              runCli(["e2ee", "policy", "show", "--base-dir", baseDir]),
            );
            assert.include(showHuman.output, "requireE2EE: false");
            assert.include(showHuman.output, "Effective requireE2EE: false");
            assert.include(showHuman.output, "Policy generation: 3");

            const set = yield* captureStdout(
              runCli([
                "e2ee",
                "policy",
                "set",
                "--require-approved-client-e2ee",
                "--base-dir",
                baseDir,
              ]),
            );
            // §12.4's lockout duty and §12.6's pre-change warning are separate
            // emissions from the acknowledgement; the whole transcript is what
            // has to carry them.
            const setTranscript = set.lines.join("\n");
            assert.isAtLeast(set.lines.length, 2);
            assert.include(setTranscript, "WARNING: requireApprovedClientE2EE disables web");
            assert.include(setTranscript, "strands remote access");
            assert.include(setTranscript, "This is a policy withdrawal");
            assert.include(setTranscript, "legacy 4");
            // §12.6(c): the counts the acknowledgement must report, by class.
            assert.include(
              set.output,
              "Closed 4 legacy channel(s), 1 NX E2EE channel(s), 0 suite-withdrawn E2EE channel(s); aborted 2 in-flight handshake(s).",
            );
            assert.include(set.output, "Policy committed.");
            assert.notInclude(set.output, baseDir);

            const setJson = yield* captureStdout(
              runCli([
                "e2ee",
                "policy",
                "set",
                "--require-approved-client-e2ee",
                "--base-dir",
                baseDir,
                "--json",
              ]),
            );
            // Under `--json` the document is the whole of stdout: the human
            // warning is suppressed and the machine consumer reads `withdrawal`
            // and the counts off the document itself.
            const change = JSON.parse(setJson.output) as {
              readonly withdrawal: boolean;
              readonly counts: { readonly legacy: number; readonly abortedHandshakes: number };
            };
            assert.equal(change.withdrawal, true);
            assert.equal(change.counts.legacy, 4);
            assert.equal(change.counts.abortedHandshakes, 2);
          }),
        {
          previewPolicy: () => ({
            policy: stubPolicy({ requireApprovedClientE2EE: true, effectiveRequireE2EE: true }),
            withdrawal: true,
            changed: true,
            counts: { legacy: 4, nxE2ee: 1, suiteWithdrawn: 0, abortedHandshakes: 2 },
          }),
          applyPolicy: async () => ({
            policy: stubPolicy({
              requireApprovedClientE2EE: true,
              effectiveRequireE2EE: true,
              admittedPatterns: ["IK"],
              generation: 4,
            }),
            withdrawal: true,
            changed: true,
            counts: { legacy: 4, nxE2ee: 1, suiteWithdrawn: 0, abortedHandshakes: 2 },
          }),
        },
      );
    }),
  );

  it.effect("shows the §13.5 advisory session code with its disclosure duty", () =>
    Effect.gen(function* () {
      const baseDir = mkdtempSync(join(tmpdir(), "ryco-cli-e2ee-sessions-test-"));
      yield* withLiveHubCliServer(
        baseDir,
        () =>
          Effect.gen(function* () {
            const human = yield* captureStdout(runCli(["e2ee", "sessions", "--base-dir", baseDir]));
            assert.include(human.output, "Session: 1");
            assert.include(human.output, "Tier: web");
            assert.include(human.output, "Verification code: ABCDE-FGHIJ");
            assert.include(human.output, "Session: 2");
            assert.include(human.output, "Tier: native");
            assert.include(human.output, "compare the safety number instead");
            assert.include(human.output, "cannot protect against the Hub operator");
            assert.include(human.output, "not proof that no interposer is present");
            assert.notInclude(human.output, baseDir);

            const json = yield* captureStdout(
              runCli(["e2ee", "sessions", "--base-dir", baseDir, "--json"]),
            );
            const view = JSON.parse(json.output) as {
              readonly sessions: ReadonlyArray<{
                readonly tier: string;
                readonly verificationCode?: string;
              }>;
            };
            assert.equal(view.sessions.length, 2);
            assert.equal(view.sessions[0]?.verificationCode, "ABCDE-FGHIJ");
            assert.equal(view.sessions[1]?.verificationCode, undefined);
          }),
        {
          listSessions: () => ({
            sessions: [
              {
                sessionIndex: 1,
                tier: "web",
                suite: 1,
                establishedAt: 1_000,
                verificationCode: "ABCDE-FGHIJ",
              },
              { sessionIndex: 2, tier: "native", suite: 1, establishedAt: 2_000 },
            ],
          }),
        },
      );
    }),
  );

  it.effect("rotates the prekey, recovers continuity, and breaks it deliberately", () =>
    Effect.gen(function* () {
      const baseDir = mkdtempSync(join(tmpdir(), "ryco-cli-e2ee-keys-test-"));
      yield* withLiveHubCliServer(
        baseDir,
        () =>
          Effect.gen(function* () {
            const rotateJson = yield* captureStdout(
              runCli(["e2ee", "prekey", "rotate", "--base-dir", baseDir, "--json"]),
            );
            const rotated = JSON.parse(rotateJson.output) as { readonly prekeyId: string };
            assert.equal(rotated.prekeyId, "pk_stub");

            const rotateHuman = yield* captureStdout(
              runCli(["e2ee", "prekey", "rotate", "--base-dir", baseDir]),
            );
            assert.include(rotateHuman.output, "Prekey: pk_stub");
            assert.include(rotateHuman.output, `Fingerprint: SHA256:${"C".repeat(42)}A`);
            assert.include(rotateHuman.output, "Established channels are unaffected");

            // §7.5's unresolvable state must reach an operator with the remedy
            // that names the very command below.
            const continuity = yield* captureStdout(
              runCli(["e2ee", "continuity", "show", "--base-dir", baseDir]),
            );
            assert.include(continuity.output, "Continuity: UNRESOLVABLE");
            assert.include(continuity.output, "Reason: anchor_disagrees");
            assert.include(continuity.output, "continuity recovery command");
            assert.include(continuity.output, "verify this node again");

            // Outcome one: re-adopt, which keeps every existing verification.
            const adopt = yield* captureStdout(
              runCli([
                "e2ee",
                "continuity",
                "recover",
                "--adopt",
                "nct_confirmedconfirmedco",
                "--base-dir",
                baseDir,
              ]),
            );
            assert.include(adopt.output, "Continuity id: nct_confirmedconfirmedco");
            assert.include(adopt.output, "Every existing client verification is kept.");

            // Outcome two: break and re-mint, whose cost is stated at the point
            // of use.
            const remint = yield* captureStdout(
              runCli(["e2ee", "continuity", "recover", "--break", "--base-dir", baseDir, "--json"]),
            );
            const reminted = JSON.parse(remint.output) as { readonly outcome: string };
            assert.equal(reminted.outcome, "reminted");

            const remintHuman = yield* captureStdout(
              runCli(["e2ee", "continuity", "recover", "--break", "--base-dir", baseDir]),
            );
            assert.include(remintHuman.output, "fresh id");
            assert.include(remintHuman.output, "needs a fresh pairing ceremony");

            // The deliberate chain break is a separate command from recovery.
            const broken = yield* captureStdout(
              runCli(["e2ee", "continuity", "break", "--base-dir", baseDir]),
            );
            assert.include(broken.output, "Continuity chain broken deliberately.");
            assert.include(broken.output, "The lineage id is kept");
          }),
        {
          readContinuity: async () => ({
            status: "unavailable",
            reason: "anchor_disagrees",
            remedy: E2EE_CONTINUITY_UNRESOLVABLE_REMEDY,
          }),
        },
      );
    }),
  );

  it.effect("refuses a continuity recovery that names neither outcome or both", () =>
    Effect.gen(function* () {
      const baseDir = mkdtempSync(join(tmpdir(), "ryco-cli-e2ee-recover-choice-test-"));
      const neither = yield* runCliWithRuntime([
        "e2ee",
        "continuity",
        "recover",
        "--base-dir",
        baseDir,
      ]).pipe(Effect.flip);
      const both = yield* runCliWithRuntime([
        "e2ee",
        "continuity",
        "recover",
        "--adopt",
        "nct_confirmedconfirmedco",
        "--break",
        "--base-dir",
        baseDir,
      ]).pipe(Effect.flip);

      for (const error of [neither, both]) {
        assert.isTrue(error instanceof Error, `expected an Error, got ${String(error)}`);
        assert.include(String(error), "Choose exactly one outcome");
      }
    }),
  );

  it.effect("reports the §12.5 fallback counters separately, and resets them", () =>
    Effect.gen(function* () {
      const baseDir = mkdtempSync(join(tmpdir(), "ryco-cli-e2ee-fallback-test-"));
      yield* withLiveHubCliServer(
        baseDir,
        () =>
          Effect.gen(function* () {
            const human = yield* captureStdout(
              runCli(["e2ee", "fallback", "show", "--base-dir", baseDir]),
            );
            // Both counters, never a single total, plus both ring-overflow
            // counters adjacent to the ring and labelled as what they mean.
            assert.include(human.output, "peer-legacy occurrences: 5");
            assert.include(human.output, "advertisement-unavailable occurrences: 2");
            assert.include(human.output, "peer-legacy ring overflows: 3");
            assert.include(human.output, "advertisement-unavailable ring overflows: 0");
            assert.include(human.output, "incomplete account of this window");
            assert.include(human.output, "undersized-connection");
            // §12.5 forbids account, channel, session, and key identifiers, and
            // no origin hash is displayed.
            assert.notInclude(human.output, "originHash");
            assert.notInclude(human.output, "acct_");
            assert.notInclude(human.output, "SHA256:");
            assert.notInclude(human.output, baseDir);

            const json = yield* captureStdout(
              runCli(["e2ee", "fallback", "show", "--base-dir", baseDir, "--json"]),
            );
            const view = JSON.parse(json.output) as {
              readonly peerLegacy: { readonly occurrences: number };
              readonly ring: ReadonlyArray<{ readonly reason: string }>;
            };
            assert.equal(view.peerLegacy.occurrences, 5);
            assert.equal(view.ring.length, 2);
            assert.equal("originHash" in (view.ring[0] ?? {}), false);

            const reset = yield* captureStdout(
              runCli(["e2ee", "fallback", "reset", "--base-dir", baseDir, "--json"]),
            );
            const afterReset = JSON.parse(reset.output) as {
              readonly peerLegacy: { readonly occurrences: number };
              readonly windowStartedAt?: number;
            };
            assert.equal(afterReset.peerLegacy.occurrences, 0);
            assert.equal(afterReset.windowStartedAt, 9_000);
          }),
        {
          readFallback: () => ({
            windowStartedAt: 1_000,
            peerLegacy: { occurrences: 5, ringOverflows: 3, lastOccurrenceAt: 4_000 },
            advertisementUnavailable: { occurrences: 2, ringOverflows: 0, lastOccurrenceAt: 3_000 },
            ring: [
              { occurredAt: 2_000, reason: "peer-legacy" },
              { occurredAt: 3_000, reason: "undersized-connection" },
            ],
          }),
        },
      );
    }),
  );

  it.effect("displays both §12.5 numbers for a live undersized connection", () =>
    Effect.gen(function* () {
      const baseDir = mkdtempSync(join(tmpdir(), "ryco-cli-e2ee-undersized-test-"));
      yield* withLiveHubCliServer(
        baseDir,
        () =>
          Effect.gen(function* () {
            const human = yield* captureStdout(
              runCli(["e2ee", "fallback", "show", "--base-dir", baseDir]),
            );
            // §12.5: BOTH figures, because the condition is the comparison
            // between them and one alone says nothing about whether it holds.
            assert.include(human.output, "8191");
            assert.include(human.output, "8192");
            assert.include(human.output, "Undersized connection");

            const json = yield* captureStdout(
              runCli(["e2ee", "fallback", "show", "--base-dir", baseDir, "--json"]),
            );
            const view = JSON.parse(json.output) as {
              readonly undersizedConnection?: {
                readonly assertedMaxDataChunkBytes: number;
                readonly advertisementMinChunkBytes: number;
              };
            };
            assert.deepEqual(view.undersizedConnection, {
              assertedMaxDataChunkBytes: 8_191,
              advertisementMinChunkBytes: 8_192,
            });
          }),
        {
          readFallback: () => ({
            peerLegacy: { occurrences: 0, ringOverflows: 0 },
            advertisementUnavailable: { occurrences: 1, ringOverflows: 0 },
            ring: [{ occurredAt: 3_000, reason: "undersized-connection" }],
            undersizedConnection: {
              assertedMaxDataChunkBytes: 8_191,
              advertisementMinChunkBytes: 8_192,
            },
          }),
        },
      );
    }),
  );

  it.effect("clears the §13.6 pairing-attempt refusal count on owner command", () =>
    Effect.gen(function* () {
      const baseDir = mkdtempSync(join(tmpdir(), "ryco-cli-e2ee-refusals-test-"));
      let cleared = 0;
      yield* withLiveHubCliServer(
        baseDir,
        () =>
          Effect.gen(function* () {
            // §13.6 requires the count to be legible AND clearable, so the
            // display that shows a nonzero count names the command that clears
            // it — an owner who cannot find the action has the same problem as
            // an owner with no action.
            const before = yield* captureStdout(
              runCli(["e2ee", "client", "list", "--base-dir", baseDir]),
            );
            assert.include(before.output, "Pairing attempts refused for pending cap: 12");
            assert.include(before.output, "ryco e2ee client clear-refusals");

            const after = yield* captureStdout(
              runCli(["e2ee", "client", "clear-refusals", "--base-dir", baseDir, "--json"]),
            );
            assert.equal(cleared, 1);
            assert.equal(
              (JSON.parse(after.output) as { readonly refusedPairingAttempts: number })
                .refusedPairingAttempts,
              0,
            );
          }),
        {
          listClients: async () => stubClientListing({ refusedPairingAttempts: 12 }),
          clearRefusedPairingAttempts: async () => {
            cleared += 1;
            return stubClientListing({ refusedPairingAttempts: 0 });
          },
        },
      );
    }),
  );

  it.effect("surfaces the §6.4 prekey remedy where an operator meets the condition", () =>
    Effect.gen(function* () {
      const baseDir = mkdtempSync(join(tmpdir(), "ryco-cli-e2ee-prekey-show-test-"));
      yield* withLiveHubCliServer(
        baseDir,
        () =>
          Effect.gen(function* () {
            const human = yield* captureStdout(
              runCli(["e2ee", "prekey", "show", "--base-dir", baseDir]),
            );
            assert.include(human.output, "Validity: expired");
            // The remedy is §6.4's own sentence, carried from the module that
            // defines the diagnostic — not restated by this surface.
            assert.include(human.output, E2EE_PREKEY_EXPIRED_REMEDY);

            const json = yield* captureStdout(
              runCli(["e2ee", "prekey", "show", "--base-dir", baseDir, "--json"]),
            );
            const view = JSON.parse(json.output) as {
              readonly validity: string;
              readonly remedy: string;
            };
            assert.equal(view.validity, "expired");
            assert.equal(view.remedy, E2EE_PREKEY_EXPIRED_REMEDY);

            // A usable prekey gets no remedy: the sentence is a repair for a
            // condition, not a footer.
            const rotated = yield* captureStdout(
              runCli(["e2ee", "prekey", "rotate", "--base-dir", baseDir]),
            );
            assert.include(rotated.output, "Validity: usable");
            assert.notInclude(rotated.output, E2EE_PREKEY_EXPIRED_REMEDY);
          }),
        {
          readPrekey: async () => ({
            present: true,
            prekeyId: "pk_stub",
            fingerprint: `SHA256:${"C".repeat(42)}A`,
            createdAt: 1_000,
            expiresAt: 2_000,
            validity: "expired",
            remedy: E2EE_PREKEY_EXPIRED_REMEDY,
          }),
        },
      );
    }),
  );

  it.effect("recovers a rolled-back §5.7 policy generation, warning before the jump", () =>
    Effect.gen(function* () {
      const baseDir = mkdtempSync(join(tmpdir(), "ryco-cli-e2ee-recover-test-"));
      let recovered = 0;
      yield* withLiveHubCliServer(
        baseDir,
        () =>
          Effect.gen(function* () {
            const human = yield* captureStdout(
              runCli(["e2ee", "policy", "recover", "--base-dir", baseDir]),
            );
            const transcript = human.lines.join("\n");
            assert.equal(recovered, 1);
            // §5.7's mandated warning, both halves.
            assert.include(transcript, "strictly higher");
            assert.include(transcript, "deliberate");
            // …and the generation the command actually advanced to, which is the
            // whole point: a recovery that reported the rolled-back value would
            // be indistinguishable from one that did nothing.
            assert.include(human.output, "Policy generation: 41");
            assert.include(human.output, "generation 41");
            // §12.6 step (b) is owed for a recovery that fell closed, so the
            // counts are reported like any other withdrawal.
            assert.include(human.output, "Closed 2 legacy channel(s)");

            const json = yield* captureStdout(
              runCli(["e2ee", "policy", "recover", "--base-dir", baseDir, "--json"]),
            );
            const change = JSON.parse(json.output) as {
              readonly policy: { readonly generation: number };
              readonly warnings: readonly string[];
            };
            assert.equal(change.policy.generation, 41);
            // Under `--json` the warning is not dropped: it travels in the
            // document and on stderr, never on the document's own stream.
            assert.equal(change.warnings.length, 1);
            assert.include(change.warnings[0] ?? "", "strictly higher");
          }),
        {
          recoverPolicyGeneration: async () => {
            recovered += 1;
            return {
              policy: stubPolicy({ requireE2EE: true, effectiveRequireE2EE: true, generation: 41 }),
              withdrawal: true,
              changed: true,
              counts: { legacy: 2, nxE2ee: 0, suiteWithdrawn: 0, abortedHandshakes: 0 },
            };
          },
        },
      );
    }),
  );

  it.effect("sends the suite registry through the §12.6 policy command", () =>
    Effect.gen(function* () {
      const baseDir = mkdtempSync(join(tmpdir(), "ryco-cli-e2ee-suite-test-"));
      const proposals: unknown[] = [];
      yield* withLiveHubCliServer(
        baseDir,
        () =>
          Effect.gen(function* () {
            const set = yield* captureStdout(
              runCli(["e2ee", "policy", "set", "--suite", "1", "--base-dir", baseDir, "--json"]),
            );
            // §12.6's suite clause has an input path: the whole registry travels
            // and the node decides whether it is a reduction.
            assert.deepEqual(proposals.at(-1), { suiteRegistry: [1] });
            const change = JSON.parse(set.output) as {
              readonly counts: { readonly suiteWithdrawn: number };
              readonly warnings: readonly string[];
              readonly preview: { readonly withdrawal: boolean };
            };
            assert.equal(change.counts.suiteWithdrawn, 1);
            assert.equal(change.preview.withdrawal, true);
            // §12.6's pre-change warning is carried rather than dropped, and the
            // preview counts it was computed from travel with it.
            assert.equal(change.warnings.length, 1);
            assert.include(change.warnings[0] ?? "", "policy withdrawal");
          }),
        {
          previewPolicy: (proposal) => {
            proposals.push(proposal);
            return {
              policy: stubPolicy(),
              withdrawal: true,
              changed: true,
              counts: { legacy: 0, nxE2ee: 0, suiteWithdrawn: 1, abortedHandshakes: 0 },
            };
          },
          applyPolicy: async (proposal) => {
            proposals.push(proposal);
            return {
              policy: stubPolicy(),
              withdrawal: true,
              changed: true,
              counts: { legacy: 0, nxE2ee: 0, suiteWithdrawn: 1, abortedHandshakes: 0 },
            };
          },
        },
      );
    }),
  );

  it.effect("gives --json the whole of stdout, with logging turned all the way up", () =>
    Effect.gen(function* () {
      // THE POINT OF `--json` IS THAT THE OUTPUT PARSES. A single log line makes
      // the document unparseable, and two independent paths used to produce one:
      // the configuration resolution logs its startup phases at Debug and is
      // what COMPUTES the level any later suppression is derived from, so no
      // per-layer suppression could ever cover it; and `hub pending` answered
      // "nothing is pending" as English under `--json`, which is the same defect
      // reached with no logging at all.
      //
      // Every `--json` command is therefore run at the loudest level the CLI
      // accepts and EVERY line of its stdout is parsed. A command that emits a
      // log line, a banner, or a sentence fails here rather than in a consumer's
      // pipeline.
      const baseDir = mkdtempSync(join(tmpdir(), "ryco-cli-e2ee-json-stdout-test-"));
      const fingerprint = `SHA256:${"B".repeat(42)}A`;
      const key = [
        "--hub-origin",
        "https://hub.example.test",
        "--account-id",
        "acct_stub",
        "--base-dir",
        baseDir,
      ];
      const here = ["--base-dir", baseDir];
      const commands: ReadonlyArray<ReadonlyArray<string>> = [
        ["hub", "status", ...here],
        ["hub", "pending", ...here],
        ["e2ee", "client", "list", ...here],
        ["e2ee", "client", "show", fingerprint, ...key],
        [
          "e2ee",
          "client",
          "approve",
          fingerprint,
          ...key,
          "--max-role",
          "viewer",
          "--capability",
          "ryco.rpc",
        ],
        ["e2ee", "client", "narrow", fingerprint, ...key, "--max-role", "viewer"],
        ["e2ee", "client", "revoke", fingerprint, ...key],
        ["e2ee", "client", "purge", fingerprint, ...key],
        ["e2ee", "client", "clear-refusals", ...here],
        ["e2ee", "client", "window", "open", fingerprint, ...here],
        ["e2ee", "client", "window", "close", ...here],
        ["e2ee", "sessions", ...here],
        ["e2ee", "policy", "show", ...here],
        ["e2ee", "policy", "set", "--require-e2ee", ...here],
        ["e2ee", "policy", "recover", ...here],
        ["e2ee", "prekey", "show", ...here],
        ["e2ee", "prekey", "rotate", ...here],
        ["e2ee", "continuity", "show", ...here],
        ["e2ee", "continuity", "recover", "--break", ...here],
        ["e2ee", "continuity", "break", ...here],
        ["e2ee", "fallback", "show", ...here],
        ["e2ee", "fallback", "reset", ...here],
      ];
      yield* withLiveHubCliServer(
        baseDir,
        () =>
          Effect.gen(function* () {
            // The one `--json` answer that is not a record: "nothing is
            // pending". It is still an ANSWER, so it is a document — `null` —
            // and not a sentence. This branch is why the command list below runs
            // against a connector with an enrollment and this one does not.
            const machine = yield* captureStdout(
              runCli(["--log-level", "debug", "hub", "pending", "--base-dir", baseDir, "--json"]),
            );
            assert.deepEqual(machine.lines, ["null"]);
            assert.equal(JSON.parse(machine.output), null);

            const human = yield* captureStdout(runCli(["hub", "pending", "--base-dir", baseDir]));
            assert.equal(human.output, "No Hub enrollment is pending.");
          }),
        {},
        { readEnrollment: async () => null },
      );
      yield* withLiveHubCliServer(baseDir, () =>
        Effect.forEach(
          commands,
          (command) =>
            Effect.gen(function* () {
              const captured = yield* captureStdout(
                runCli(["--log-level", "debug", ...command, "--json"]),
              );
              const label = command.join(" ");
              // ONE line, and it parses. Not "the last line parses": a leading
              // log line is exactly what this exists to catch.
              assert.equal(
                captured.lines.length,
                1,
                `${label} wrote ${String(captured.lines.length)} stdout lines: ${captured.lines.join(" | ")}`,
              );
              try {
                JSON.parse(captured.output);
              } catch {
                assert.fail(`${label} did not emit a JSON document: ${captured.output}`);
              }
            }),
          { discard: true },
        ),
      );
    }),
  );

  it.effect("rejects dev-url on project commands", () =>
    Effect.gen(function* () {
      const workspaceRoot = mkdtempSync(
        join(tmpdir(), "ryco-cli-projects-unknown-option-workspace-"),
      );
      const error = yield* runCliWithRuntime([
        "project",
        "add",
        workspaceRoot,
        "--dev-url",
        "http://127.0.0.1:5173",
      ]).pipe(Effect.flip);

      if (!CliError.isCliError(error)) {
        assert.fail(`Expected CliError, got ${String(error)}`);
      }
      if (error._tag !== "ShowHelp") {
        assert.fail(`Expected ShowHelp, got ${error._tag}`);
      }
      assert.deepEqual(error.commandPath, ["ryco", "project", "add"]);
      const optionError = error.errors[0] as CliError.CliError | undefined;
      if (!optionError || optionError._tag !== "UnrecognizedOption") {
        assert.fail(`Expected UnrecognizedOption, got ${String(optionError?._tag)}`);
      }
      assert.equal(optionError.option, "--dev-url");
    }),
  );
});
