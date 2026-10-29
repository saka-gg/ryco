import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  type ProviderSignInEvent,
  type ProviderSignInPhase,
  type ProviderSignInState,
  type ServerProvider,
  type ServerProviderAuth,
  ServerSettings,
} from "@ryco/contracts";
import {
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  Option,
  PubSub,
  Ref,
  Schema,
  Scope,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderRegistry } from "../Services/ProviderRegistry.ts";
import type { ProviderSignInShape } from "./ProviderSignIn.ts";
import { makeProviderSignInRuntime } from "./providerSignInRuntime.ts";

const PEER = path.join(import.meta.dirname, "../testFixtures/codexLoginMockPeer.sh");
const CODEX = ProviderInstanceId.make("codex_sign_in");

const codexInstance = (home: string, scriptPath: string, extra: object = {}) => ({
  driver: "codex",
  enabled: true,
  config: { binaryPath: PEER, homePath: home },
  environment: [{ name: "RYCO_CODEX_LOGIN_SCRIPT", value: scriptPath, sensitive: false }],
  ...extra,
});

const stateOf = (event: ProviderSignInEvent): ProviderSignInState | undefined =>
  event.type === "state" ? event.state : undefined;

/**
 * A runtime over fake settings and a fake registry. `instances` builds the provider instances
 * from the fixture's directory; each Codex instance runs the login mock peer. The runtime lives in
 * `scope` (the server's layer scope) when one is given, else in the test's.
 */
const makeHarness = (
  instances: (fixture: {
    readonly dir: string;
    readonly home: string;
    readonly scriptPath: string;
  }) => Record<string, unknown> = ({ home, scriptPath }) => ({
    [CODEX]: codexInstance(home, scriptPath),
  }),
  options: {
    readonly scope?: Scope.Scope;
    /** What the registry's n-th refresh answers; later refreshes read `auth`. */
    readonly authByRefresh?: ReadonlyArray<ServerProviderAuth>;
  } = {},
) =>
  Effect.gen(function* () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "provider-sign-in-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => fs.rmSync(dir, { recursive: true, force: true })),
    );
    const home = path.join(dir, "codex-home");
    const scriptPath = path.join(dir, "script.json");
    fs.writeFileSync(scriptPath, JSON.stringify({}));
    const settings = yield* Ref.make(
      Schema.decodeUnknownSync(ServerSettings)({
        providerInstances: instances({ dir, home, scriptPath }),
      }),
    );
    const settingsChanges = yield* PubSub.unbounded<ServerSettings>();
    const refreshed: Array<ProviderInstanceId> = [];
    const auth = yield* Ref.make<ServerProviderAuth>({
      status: "authenticated",
      type: "chatgpt",
      email: "fixture@example.com",
    });
    const runtime: ProviderSignInShape = yield* makeProviderSignInRuntime.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(ServerSettingsService, {
            getSettings: Ref.get(settings),
            streamChanges: Stream.fromPubSub(settingsChanges),
          } as unknown as ServerSettingsService["Service"]),
          Layer.succeed(ProviderRegistry, {
            refreshInstance: (instanceId: ProviderInstanceId) =>
              Effect.gen(function* () {
                refreshed.push(instanceId);
                const scripted = options.authByRefresh?.[refreshed.length - 1];
                return [
                  {
                    instanceId,
                    driver: "codex",
                    auth: scripted ?? (yield* Ref.get(auth)),
                  } as ServerProvider,
                ];
              }),
          } as unknown as ProviderRegistry["Service"]),
          Layer.succeed(ServerConfig, {
            stateDir: path.join(dir, "state"),
          } as ServerConfig["Service"]),
        ),
      ),
      (make) => (options.scope ? Scope.provide(make, options.scope) : make),
    );
    const requestedMethods = (script = scriptPath) =>
      fs.existsSync(`${script}.requests`)
        ? fs
            .readFileSync(`${script}.requests`, "utf8")
            .trim()
            .split("\n")
            .map((line) => (JSON.parse(line) as { readonly method: string }).method)
        : [];
    return {
      dir,
      home,
      scriptPath,
      runtime,
      settings,
      settingsChanges,
      refreshed,
      auth,
      trigger: () => fs.writeFileSync(`${scriptPath}.trigger`, ""),
      requestedMethods,
      pid: () => Number(fs.readFileSync(`${scriptPath}.pid`, "utf8")),
      /** Resolves once the instance's state reaches `phase` (at once when it is there now). */
      reach: (phase: ProviderSignInPhase, instanceId: ProviderInstanceId = CODEX) =>
        runtime.subscribe(instanceId).pipe(
          Stream.map(stateOf),
          Stream.filter((state) => state?.phase === phase),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
          Effect.map((state) => state!),
        ),
      /** Every state the instance shows from now on. */
      record: (instanceId: ProviderInstanceId = CODEX) =>
        Effect.gen(function* () {
          const states: Array<ProviderSignInState> = [];
          yield* runtime.subscribe(instanceId).pipe(
            Stream.runForEach((event) => Effect.sync(() => states.push(stateOf(event)!))),
            Effect.forkScoped,
          );
          // The first state is the current one; later ones follow from here.
          while (states.length === 0) yield* Effect.promise(() => sleepReal(5));
          return states;
        }),
    };
  });

const sleepReal = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const captureLogs = () => {
  const lines: Array<string> = [];
  const layer = Logger.layer([
    Logger.make((options) => {
      lines.push(JSON.stringify(options.message));
    }),
  ]);
  return { lines, layer };
};

describe("provider sign-in runtime", () => {
  it.live("reports what Start would use from the settings alone", () =>
    Effect.gen(function* () {
      const { runtime, reach, requestedMethods } = yield* makeHarness(({ home, scriptPath }) => ({
        [CODEX]: codexInstance(home, scriptPath),
        codex_off: codexInstance(home, scriptPath, { enabled: false }),
        // Without an envelope flag, the config's own decides, as in the registry.
        codex_config_off: {
          driver: "codex",
          config: { binaryPath: PEER, homePath: home, enabled: false },
        },
        codex_envelope_on: {
          driver: "codex",
          enabled: true,
          config: { binaryPath: PEER, homePath: home, enabled: false },
        },
        codex_invalid: { driver: "codex", config: { binaryPath: 42 } },
        registry: { driver: "acpRegistry", config: { agentId: "agent", version: "1.0.0" } },
        claude_hub: { driver: "claudeAgent" },
      }));
      const idle = (instanceId: string) =>
        reach("idle", ProviderInstanceId.make(instanceId)).pipe(
          Effect.map(({ method, unavailableReason }) => ({ method, unavailableReason })),
        );

      assert.deepEqual(yield* idle(CODEX), { method: "codexDeviceCode", unavailableReason: null });
      assert.deepEqual(yield* idle("codex_off"), {
        method: null,
        unavailableReason: "Enable this provider instance to sign in.",
      });
      assert.deepEqual(yield* idle("codex_config_off"), {
        method: null,
        unavailableReason: "Enable this provider instance to sign in.",
      });
      assert.deepEqual(yield* idle("codex_envelope_on"), {
        method: "codexDeviceCode",
        unavailableReason: null,
      });
      assert.deepEqual(yield* idle("codex_invalid"), {
        method: null,
        unavailableReason: "Fix this Codex instance's settings to sign in.",
      });
      assert.deepEqual(yield* idle("registry"), {
        method: null,
        unavailableReason: "Use ACP Registry authentication below.",
      });
      assert.deepEqual(yield* idle("claude_hub"), {
        method: null,
        unavailableReason:
          "Sign-in from Ryco is not available for this provider yet. Run its login on the node.",
      });
      assert.deepEqual(yield* idle("missing"), {
        method: null,
        unavailableReason: "This provider instance is not configured on the node.",
      });
      const refused = yield* runtime.start(ProviderInstanceId.make("claude_hub")).pipe(Effect.flip);
      assert.equal(
        refused.message,
        "Sign-in from Ryco is not available for this provider yet. Run its login on the node.",
      );
      assert.deepEqual(requestedMethods(), []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live(
    "runs a flow to success, refreshes the instance once and never logs the code or page",
    () => {
      const logs = captureLogs();
      return Effect.gen(function* () {
        const harness = yield* makeHarness();
        const states = yield* harness.record();

        const started = yield* harness.runtime.start(CODEX);
        assert.equal(started.phase, "starting");
        assert.equal(started.method, "codexDeviceCode");
        const waiting = yield* harness.reach("waiting");
        assert.deepEqual(waiting.interaction, {
          type: "deviceCode",
          verificationUrl: "https://auth.example.test/codex/device",
          userCode: "FIXT-CODE",
        });
        assert.equal(waiting.flowId, started.flowId);
        harness.trigger();
        const succeeded = yield* harness.reach("succeeded");

        assert.equal(succeeded.message, "Signed in as fixture@example.com.");
        assert.isNull(succeeded.interaction);
        assert.deepEqual(
          states.map((state) => state.phase),
          ["idle", "starting", "waiting", "verifying", "succeeded"],
        );
        assert.deepEqual(harness.refreshed, [CODEX]);
        assert.isTrue(logs.lines.some((line) => line.includes("provider sign-in finished")));
        for (const line of logs.lines) {
          assert.notInclude(line, "FIXT-CODE");
          assert.notInclude(line, "auth.example.test");
        }
      }).pipe(Effect.provide(Layer.merge(NodeServices.layer, logs.layer)));
    },
  );

  it.live("answers another start with the running flow instead of a second process", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const first = yield* harness.runtime.start(CODEX);
      yield* harness.reach("waiting");
      const second = yield* harness.runtime.start(CODEX);

      assert.equal(second.flowId, first.flowId);
      assert.equal(second.phase, "waiting");
      assert.deepEqual(
        harness.requestedMethods().filter((method) => method === "initialize"),
        ["initialize"],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("refuses a second instance that signs in to the same Codex home", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(({ home, scriptPath }) => ({
        [CODEX]: codexInstance(home, scriptPath),
        codex_twin: codexInstance(home, scriptPath),
      }));
      yield* harness.runtime.start(CODEX);
      const refused = yield* harness.runtime
        .start(ProviderInstanceId.make("codex_twin"))
        .pipe(Effect.flip);

      assert.equal(refused.message, "Another sign-in for this account store is running.");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("refuses a fourth running flow on the node", () =>
    Effect.gen(function* () {
      const ids = ["codex_a", "codex_b", "codex_c", "codex_d"];
      const harness = yield* makeHarness(({ dir, scriptPath }) =>
        Object.fromEntries(
          ids.map((id) => [id, codexInstance(path.join(dir, `home-${id}`), scriptPath)]),
        ),
      );
      for (const id of ids.slice(0, 3)) {
        yield* harness.runtime.start(ProviderInstanceId.make(id));
      }
      const refused = yield* harness.runtime
        .start(ProviderInstanceId.make("codex_d"))
        .pipe(Effect.flip);

      assert.equal(
        refused.message,
        "Three sign-ins are already running on this node. Finish one first.",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("cancels: Codex is told, its process ends, and any owner sees cancelled", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const { flowId } = yield* harness.runtime.start(CODEX);
      yield* harness.reach("waiting");
      const pid = harness.pid();

      yield* harness.runtime.respond({
        instanceId: CODEX,
        flowId: flowId!,
        action: { type: "cancel" },
      });

      assert.include(harness.requestedMethods(), "account/login/cancel");
      assert.isFalse(isAlive(pid));
      const cancelled = yield* harness.reach("cancelled");
      assert.equal(cancelled.message, "Sign-in cancelled.");
      assert.deepEqual(harness.refreshed, []);
      const again = yield* harness.runtime
        .respond({ instanceId: CODEX, flowId: flowId!, action: { type: "cancel" } })
        .pipe(Effect.flip);
      assert.equal(again.message, "This sign-in is no longer active.");
      // An ended flow does not block the next one.
      const next = yield* harness.runtime.start(CODEX);
      assert.notEqual(next.flowId, flowId);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("rejects actions for another flow, and terminal input for a device code", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const { flowId } = yield* harness.runtime.start(CODEX);
      yield* harness.reach("waiting");

      const stale = yield* harness.runtime
        .respond({ instanceId: CODEX, flowId: "another-flow", action: { type: "cancel" } })
        .pipe(Effect.flip);
      assert.equal(stale.message, "This sign-in is no longer active.");
      const input = yield* harness.runtime
        .respond({ instanceId: CODEX, flowId: flowId!, action: { type: "input", data: "y\r" } })
        .pipe(Effect.flip);
      assert.equal(input.message, "This sign-in does not take terminal input.");
      assert.equal((yield* harness.reach("waiting")).flowId, flowId);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("fails instead of succeeding when the instance's settings changed meanwhile", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.runtime.start(CODEX);
      yield* harness.reach("waiting");
      const changed = Schema.decodeSync(ServerSettings)({
        providerInstances: {
          [CODEX]: codexInstance(harness.home, harness.scriptPath, {
            environment: [
              { name: "RYCO_CODEX_LOGIN_SCRIPT", value: harness.scriptPath, sensitive: false },
              { name: "OPENAI_BASE_URL", value: "https://proxy.example.test", sensitive: false },
            ],
          }),
        },
      });
      yield* Ref.set(harness.settings, changed);
      yield* PubSub.publish(harness.settingsChanges, changed);
      harness.trigger();

      const failed = yield* harness.reach("failed");
      assert.equal(failed.message, "Provider settings changed during sign-in. Start again.");
      assert.deepEqual(harness.refreshed, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("fails when the refreshed instance still reports no sign-in", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Ref.set(harness.auth, { status: "unauthenticated" });
      yield* harness.runtime.start(CODEX);
      yield* harness.reach("waiting");
      harness.trigger();

      const failed = yield* harness.reach("failed");
      assert.equal(
        failed.message,
        "The login finished, but Codex still reports no sign-in. Refresh providers.",
      );
      assert.deepEqual(harness.refreshed, [CODEX, CODEX]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("reads once more when the first refresh answers from before the login", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(undefined, {
        authByRefresh: [{ status: "unauthenticated" }],
      });
      yield* harness.runtime.start(CODEX);
      yield* harness.reach("waiting");
      harness.trigger();

      const succeeded = yield* harness.reach("succeeded");
      assert.equal(succeeded.message, "Signed in as fixture@example.com.");
      assert.deepEqual(harness.refreshed, [CODEX, CODEX]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("fails at once when Codex stops while waiting, and frees the account store", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(({ home, scriptPath }) => ({
        [CODEX]: codexInstance(home, scriptPath),
        codex_twin: codexInstance(home, scriptPath),
      }));
      fs.writeFileSync(harness.scriptPath, JSON.stringify({ completion: "exit" }));
      const { flowId } = yield* harness.runtime.start(CODEX);
      yield* harness.reach("waiting");
      const pid = harness.pid();
      const stoppedAt = Date.now();
      harness.trigger();

      const failed = yield* harness.reach("failed");
      assert.equal(failed.flowId, flowId);
      assert.equal(failed.message, "Codex stopped before the sign-in finished. Try again.");
      assert.isBelow(Date.now() - stoppedAt, 4_000);
      assert.isFalse(isAlive(pid));
      assert.deepEqual(harness.refreshed, []);
      // The ended flow no longer holds the Codex home.
      fs.rmSync(`${harness.scriptPath}.trigger`);
      fs.writeFileSync(harness.scriptPath, JSON.stringify({}));
      const twin = yield* harness.runtime.start(ProviderInstanceId.make("codex_twin"));
      assert.equal(twin.phase, "starting");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("ends with the server, not with the client that started or watched it", () =>
    Effect.gen(function* () {
      const serverScope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(serverScope, Exit.void));
      const harness = yield* makeHarness(undefined, { scope: serverScope });
      // An RPC fiber starts the flow, watches it, then its client goes away.
      const rpc = yield* harness.runtime
        .start(CODEX)
        .pipe(
          Effect.andThen(harness.runtime.subscribe(CODEX).pipe(Stream.runDrain)),
          Effect.forkChild,
        );
      const waiting = yield* harness.reach("waiting");
      const pid = harness.pid();
      yield* Fiber.interrupt(rpc);

      assert.equal((yield* harness.reach("waiting")).flowId, waiting.flowId);
      assert.isTrue(isAlive(pid));
      assert.notInclude(harness.requestedMethods(), "account/login/cancel");

      yield* Scope.close(serverScope, Exit.void);

      assert.include(harness.requestedMethods(), "account/login/cancel");
      assert.isFalse(isAlive(pid));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("expires after 15 minutes, ends Codex, and shows idle two minutes later", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const started = yield* harness.runtime.start(CODEX);
        assert.equal(started.expiresAt, new Date(15 * 60_000).toISOString());
        yield* harness.reach("waiting");
        const pid = harness.pid();

        yield* TestClock.adjust("15 minutes");
        const expired = yield* harness.reach("expired");

        assert.equal(expired.message, "The sign-in expired. Start again.");
        assert.include(harness.requestedMethods(), "account/login/cancel");
        assert.isFalse(isAlive(pid));
        // Lets the ended flow start its two-minute wait before the clock moves.
        yield* Effect.promise(() => sleepReal(50));
        yield* TestClock.adjust("1 minute");
        assert.equal((yield* harness.reach("expired")).flowId, started.flowId);
        yield* TestClock.adjust("1 minute");
        const idle = yield* harness.reach("idle");
        assert.isNull(idle.flowId);
        assert.equal(idle.method, "codexDeviceCode");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
