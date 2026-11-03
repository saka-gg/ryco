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
  ServerSettings,
} from "@ryco/contracts";
import {
  CLAUDE_NON_LOGIN_CREDENTIAL_VARIABLES,
  CLAUDE_THIRD_PARTY_PROVIDER_FLAGS,
} from "@ryco/shared/claudeCredentialVariables";
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
import { afterEach, beforeEach, vi } from "vitest";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { PtyAdapter } from "../../terminal/Services/PTY.ts";
import { FakePtyAdapter, type FakePtyProcess } from "../../terminal/testUtils/fakePty.ts";
import { ProviderRegistry } from "../Services/ProviderRegistry.ts";
import type { ProviderSignInShape } from "./ProviderSignIn.ts";
import { makeProviderSignInRuntime } from "./providerSignInRuntime.ts";

const CLAUDE = ProviderInstanceId.make("claude_sign_in");
const GROK = ProviderInstanceId.make("grok_sign_in");

const stateOf = (event: ProviderSignInEvent): ProviderSignInState | undefined =>
  event.type === "state" ? event.state : undefined;

type OutputEvent = Extract<ProviderSignInEvent, { type: "output" }>;
const outputOf = (event: ProviderSignInEvent): OutputEvent | undefined =>
  event.type === "output" ? event : undefined;

const sleepReal = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Polls (on the real clock) until `check` holds. */
const eventually = (check: () => boolean, timeoutMs = 2_000) =>
  Effect.promise(async () => {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
      if (Date.now() > deadline) throw new Error("Timed out waiting for a condition");
      await sleepReal(5);
    }
  });

/** An executable stand-in for a provider CLI: the PTY is fake, so only `--version` ever runs. */
const writeCli = (bin: string, name: string, version = "1.0.0") => {
  const file = path.join(bin, name);
  fs.writeFileSync(file, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${version}"; fi\n`);
  fs.chmodSync(file, 0o755);
  return file;
};

/**
 * A runtime over fake settings, a fake registry and a fake PTY. `instances` builds the provider
 * instances from the fixture's directory, whose `bin` holds stand-ins for every CLI. The refreshed
 * snapshot of any instance is `snapshot`, with the instance's driver.
 */
const makeHarness = (
  instances: (fixture: { readonly dir: string; readonly bin: string }) => Record<string, unknown>,
  options: { readonly scope?: Scope.Scope; readonly openCodeVersion?: string } = {},
) =>
  Effect.gen(function* () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-sign-in-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => fs.rmSync(dir, { recursive: true, force: true })),
    );
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    for (const name of ["claude", "cursor-agent", "grok"]) writeCli(bin, name);
    writeCli(bin, "opencode", options.openCodeVersion ?? "1.18.34");
    const settings = yield* Ref.make(
      Schema.decodeUnknownSync(ServerSettings)({ providerInstances: instances({ dir, bin }) }),
    );
    const settingsChanges = yield* PubSub.unbounded<ServerSettings>();
    const refreshed: Array<ProviderInstanceId> = [];
    const snapshot = yield* Ref.make<Pick<ServerProvider, "status" | "auth">>({
      status: "ready",
      auth: { status: "authenticated", type: "max", email: "fixture@example.com" },
    });
    const pty = new FakePtyAdapter();
    pty.exitOnKill = true;
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
                const driver = (yield* Ref.get(settings)).providerInstances[instanceId]?.driver;
                return [{ instanceId, driver, ...(yield* Ref.get(snapshot)) } as ServerProvider];
              }),
          } as unknown as ProviderRegistry["Service"]),
          Layer.succeed(ServerConfig, {
            stateDir: path.join(dir, "state"),
          } as ServerConfig["Service"]),
          Layer.succeed(PtyAdapter, pty),
        ),
      ),
      (make) => (options.scope ? Scope.provide(make, options.scope) : make),
    );
    const reach = (phase: ProviderSignInPhase, instanceId: ProviderInstanceId) =>
      runtime.subscribe(instanceId).pipe(
        Stream.map(stateOf),
        Stream.filter((state) => state?.phase === phase),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
        Effect.map((state) => state!),
      );
    return {
      dir,
      bin,
      runtime,
      pty,
      settings,
      settingsChanges,
      refreshed,
      snapshot,
      reach,
      /** Starts a flow and waits until its login waits on the terminal. */
      started: (instanceId: ProviderInstanceId) =>
        Effect.gen(function* () {
          const { flowId } = yield* runtime.start(instanceId);
          const waiting = yield* reach("waiting", instanceId);
          assert.equal(waiting.flowId, flowId);
          return { flowId: flowId!, process: pty.processes.at(-1)! as FakePtyProcess };
        }),
      /** Every event a new follower of the instance gets from now on. */
      follow: (instanceId: ProviderInstanceId) =>
        Effect.gen(function* () {
          const events: Array<ProviderSignInEvent> = [];
          yield* runtime.subscribe(instanceId).pipe(
            Stream.runForEach((event) => Effect.sync(() => events.push(event))),
            Effect.forkScoped,
          );
          yield* eventually(() => events.some((event) => event.type === "state"));
          return events;
        }),
    };
  });

const claudeInstance = (bin: string, environment: Record<string, string> = {}, extra = {}) => ({
  driver: "claudeAgent",
  enabled: true,
  config: { binaryPath: path.join(bin, "claude") },
  environment: Object.entries(environment).map(([name, value]) => ({
    name,
    value,
    sensitive: false,
  })),
  ...extra,
});

const grokInstance = (bin: string, extra = {}) => ({
  driver: "grok",
  enabled: true,
  config: { binaryPath: path.join(bin, "grok") },
  ...extra,
});

const captureLogs = () => {
  const lines: Array<string> = [];
  const layer = Logger.layer([
    Logger.make((options) => {
      lines.push(JSON.stringify(options.message));
    }),
  ]);
  return { lines, layer };
};

describe("terminal sign-in", () => {
  // The node's own environment is the test runner's: nothing in it may decide a Claude refusal.
  beforeEach(() => {
    for (const name of [
      ...CLAUDE_NON_LOGIN_CREDENTIAL_VARIABLES,
      ...CLAUDE_THIRD_PARTY_PROVIDER_FLAGS,
    ]) {
      vi.stubEnv(name, undefined);
    }
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.live(
    "runs Claude's own login in a private directory, with its store and no Ryco variables",
    () =>
      Effect.gen(function* () {
        vi.stubEnv("RYCO_SIGN_IN_LEAK", "node-only");
        vi.stubEnv("VITE_DEV_SERVER_URL", "http://localhost:5173");
        const harness = yield* makeHarness(({ dir, bin }) => ({
          [CLAUDE]: claudeInstance(bin, {
            CLAUDE_CONFIG_DIR: path.join(dir, "claude-config"),
            HOME: path.join(dir, "home"),
          }),
        }));
        const states = yield* harness.follow(CLAUDE);
        const { process } = yield* harness.started(CLAUDE);

        const [spawned] = harness.pty.spawnInputs;
        assert.equal(spawned?.shell, path.join(harness.bin, "claude"));
        assert.deepEqual(spawned?.args, ["auth", "login"]);
        const cwd = path.join(
          harness.dir,
          "state",
          "provider-sign-in",
          Buffer.from(CLAUDE).toString("hex"),
        );
        assert.equal(spawned?.cwd, cwd);
        assert.equal(fs.statSync(cwd).mode & 0o777, 0o700);
        assert.deepEqual([spawned?.cols, spawned?.rows], [100, 30]);
        assert.equal(spawned?.env.CLAUDE_CONFIG_DIR, path.join(harness.dir, "claude-config"));
        assert.equal(spawned?.env.HOME, path.join(harness.dir, "home"));
        assert.equal(spawned?.env.TERM, "xterm-256color");
        assert.deepEqual(
          Object.keys(spawned?.env ?? {}).filter((name) => /^(?:RYCO|VITE)_/iu.test(name)),
          [],
        );
        const waiting = states.map(stateOf).find((state) => state?.phase === "waiting");
        assert.deepEqual(waiting?.interaction, { type: "terminal", cols: 100, rows: 30 });
        assert.equal(waiting?.method, "terminal");

        process.emitExit({ exitCode: 0, signal: null });
        const succeeded = yield* harness.reach("succeeded", CLAUDE);
        assert.equal(succeeded.message, "Signed in as fixture@example.com.");
        assert.deepEqual(harness.refreshed, [CLAUDE]);
        assert.deepEqual(
          states.flatMap((event) => (event.type === "state" ? [event.state.phase] : [])),
          ["idle", "starting", "waiting", "verifying", "succeeded"],
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("launches Cursor, Grok and OpenCode with their own login arguments", () =>
    Effect.gen(function* () {
      const cursor = ProviderInstanceId.make("cursor_sign_in");
      const openCode = ProviderInstanceId.make("opencode_sign_in");
      const harness = yield* makeHarness(({ bin }) => ({
        [cursor]: {
          driver: "cursor",
          enabled: true,
          config: { binaryPath: path.join(bin, "cursor-agent"), apiEndpoint: "https://e.test" },
        },
        [GROK]: grokInstance(bin),
        [openCode]: {
          driver: "opencode",
          enabled: true,
          config: { binaryPath: path.join(bin, "opencode") },
        },
      }));
      for (const instanceId of [cursor, GROK, openCode]) yield* harness.started(instanceId);

      assert.deepEqual(
        harness.pty.spawnInputs.map((input) => [path.basename(input.shell), input.args]),
        [
          ["cursor-agent", ["-e", "https://e.test", "login"]],
          ["grok", ["login", "--device-auth"]],
          ["opencode", ["auth", "login"]],
        ],
      );
      // Grok never reports its account: one that is ready after its login is signed in.
      yield* Ref.set(harness.snapshot, { status: "ready", auth: { status: "unknown" } });
      harness.pty.processes[1]!.emitExit({ exitCode: 0, signal: null });
      assert.equal((yield* harness.reach("succeeded", GROK)).message, "Signed in.");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("leaves a proxied Claude instance alone, naming the variable and never its value", () =>
    Effect.gen(function* () {
      const ambient = ProviderInstanceId.make("claude_ambient");
      const harness = yield* makeHarness(({ bin }) => ({
        [CLAUDE]: claudeInstance(bin, {
          ANTHROPIC_BASE_URL: "https://hub.example.test/claude",
          ANTHROPIC_AUTH_TOKEN: "hub-token-abc",
        }),
        [ambient]: claudeInstance(bin),
      }));
      const idle = yield* harness.reach("idle", CLAUDE);
      assert.isNull(idle.method);
      assert.equal(
        idle.unavailableReason,
        "Claude uses ANTHROPIC_AUTH_TOKEN, set for this instance or on the node, instead of a claude.ai login, so it has no login to sign in to.",
      );
      const refused = yield* harness.runtime.start(CLAUDE).pipe(Effect.flip);
      assert.equal(refused.message, idle.unavailableReason);
      for (const text of [idle.unavailableReason, refused.message]) {
        assert.notInclude(text, "hub-token-abc");
        assert.notInclude(text, "hub.example.test");
      }

      // A key in the node's own environment counts too.
      vi.stubEnv("ANTHROPIC_API_KEY", "sk-ambient-key");
      const ambientRefusal = yield* harness.runtime.start(ambient).pipe(Effect.flip);
      assert.include(ambientRefusal.message, "ANTHROPIC_API_KEY");
      assert.notInclude(ambientRefusal.message, "sk-ambient-key");
      assert.deepEqual(harness.pty.spawnInputs, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("refuses an OpenCode instance that uses an external server", () =>
    Effect.gen(function* () {
      const openCode = ProviderInstanceId.make("opencode_remote");
      const harness = yield* makeHarness(({ bin }) => ({
        [openCode]: {
          driver: "opencode",
          enabled: true,
          config: { binaryPath: path.join(bin, "opencode"), serverUrl: "http://127.0.0.1:4096" },
        },
      }));
      const idle = yield* harness.reach("idle", openCode);
      assert.equal(
        idle.unavailableReason,
        "This instance uses the OpenCode server at its server URL. Sign in on that server.",
      );
      assert.equal(
        (yield* harness.runtime.start(openCode).pipe(Effect.flip)).message,
        idle.unavailableReason,
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live(
    "runs no OpenCode login with an unsupported 2.x binary, and none for a CLI that is missing",
    () =>
      Effect.gen(function* () {
        const openCode = ProviderInstanceId.make("opencode_v2");
        const harness = yield* makeHarness(
          ({ bin }) => ({
            [openCode]: {
              driver: "opencode",
              enabled: true,
              config: { binaryPath: path.join(bin, "opencode") },
            },
            [GROK]: grokInstance(bin, { config: { binaryPath: "/nonexistent/ryco-test/grok" } }),
          }),
          { openCodeVersion: "opencode v2.0.18" },
        );
        yield* harness.runtime.start(openCode);
        // OpenCode 2 runs from v2.2.0 (#907); the node neither serves nor signs in an older one.
        assert.include((yield* harness.reach("failed", openCode)).message, "is too old");
        yield* harness.runtime.start(GROK);
        assert.equal(
          (yield* harness.reach("failed", GROK)).message,
          "`/nonexistent/ryco-test/grok` was not found on the node. Install Grok there or set its binary path.",
        );
        assert.deepEqual(harness.pty.spawnInputs, []);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("refuses a second sign-in to the same Claude store", () =>
    Effect.gen(function* () {
      const twin = ProviderInstanceId.make("claude_twin");
      const harness = yield* makeHarness(({ dir, bin }) => {
        const store = { CLAUDE_CONFIG_DIR: path.join(dir, "shared-claude") };
        return { [CLAUDE]: claudeInstance(bin, store), [twin]: claudeInstance(bin, store) };
      });
      yield* harness.started(CLAUDE);
      const refused = yield* harness.runtime.start(twin).pipe(Effect.flip);
      assert.equal(refused.message, "Another sign-in for this account store is running.");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("keys a Grok sign-in by its GROK_HOME store, not by the home", () =>
    Effect.gen(function* () {
      const work = ProviderInstanceId.make("grok_work");
      const sameStore = ProviderInstanceId.make("grok_same_store");
      const plain = ProviderInstanceId.make("grok_plain");
      const plainStore = ProviderInstanceId.make("grok_plain_store");
      const harness = yield* makeHarness(({ dir, bin }) => {
        const grokWith = (environment: Record<string, string>) =>
          grokInstance(bin, {
            environment: Object.entries(environment).map(([name, value]) => ({
              name,
              value,
              sensitive: false,
            })),
          });
        const home = path.join(dir, "home");
        return {
          // One home, two stores: how one node runs two Grok accounts.
          [GROK]: grokWith({ HOME: home, GROK_HOME: path.join(dir, "grok-personal") }),
          [work]: grokWith({ HOME: home, GROK_HOME: path.join(dir, "grok-work") }),
          // Another home, but the first instance's store.
          [sameStore]: grokWith({
            HOME: path.join(dir, "other-home"),
            GROK_HOME: path.join(dir, "grok-personal"),
          }),
          // Without GROK_HOME the store is `~/.grok`.
          [plain]: grokWith({ HOME: path.join(dir, "plain-home") }),
          [plainStore]: grokWith({ GROK_HOME: path.join(dir, "plain-home", ".grok") }),
        };
      });
      yield* harness.started(GROK);
      yield* harness.started(work);
      yield* harness.started(plain);
      for (const instanceId of [sameStore, plainStore]) {
        const refused = yield* harness.runtime.start(instanceId).pipe(Effect.flip);
        assert.equal(refused.message, "Another sign-in for this account store is running.");
      }
      assert.equal(harness.pty.spawnInputs.length, 3);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("sends output in coalesced, bounded events and the tail to a new follower", () => {
    const logs = captureLogs();
    return Effect.gen(function* () {
      const harness = yield* makeHarness(({ bin }) => ({ [GROK]: grokInstance(bin) }));
      const { flowId, process } = yield* harness.started(GROK);
      const events = yield* harness.follow(GROK);
      const outputs = () => events.flatMap((event) => outputOf(event) ?? []);
      // A follower of a running terminal flow starts from its (still empty) tail.
      yield* eventually(() => outputs().length === 1);
      assert.deepEqual(outputs()[0], { type: "output", flowId, offset: 0, data: "", reset: true });

      process.emitData("Open https://auth.example.test/");
      process.emitData("device and enter GROK-CODE\r\n");
      yield* eventually(() => outputs().length === 2);
      const first = "Open https://auth.example.test/device and enter GROK-CODE\r\n";
      assert.deepEqual(outputs()[1], { type: "output", flowId, offset: 0, data: first });

      // A flood goes out in pieces of at most 16 KiB.
      process.emitData("x".repeat(40_000));
      yield* eventually(() => outputs().length === 5);
      assert.deepEqual(
        outputs()
          .slice(2)
          .map((output) => [output.offset, output.data.length]),
        [
          [first.length, 16_384],
          [first.length + 16_384, 16_384],
          [first.length + 32_768, 40_000 - 32_768],
        ],
      );

      // A new follower gets the last 32 KiB once, then the deltas.
      const later = yield* harness.follow(GROK);
      yield* eventually(() => later.some((event) => event.type === "output"));
      const tail = later.flatMap((event) => outputOf(event) ?? [])[0]!;
      const total = first.length + 40_000;
      assert.isTrue(tail.reset);
      assert.equal(tail.data.length, 32 * 1024);
      assert.equal(tail.offset, total - 32 * 1024);
      process.emitData("Login successful\r\n");
      yield* eventually(() => later.filter((event) => event.type === "output").length === 2);
      assert.deepEqual(later.flatMap((event) => outputOf(event) ?? [])[1], {
        type: "output",
        flowId,
        offset: total,
        data: "Login successful\r\n",
      });

      yield* harness.runtime.respond({
        instanceId: GROK,
        flowId,
        action: { type: "input", data: "typed-secret\r" },
      });
      process.emitExit({ exitCode: 0, signal: null });
      yield* harness.reach("succeeded", GROK);
      for (const line of logs.lines) {
        assert.notInclude(line, "GROK-CODE");
        assert.notInclude(line, "auth.example.test");
        assert.notInclude(line, "typed-secret");
      }
    }).pipe(Effect.provide(Layer.merge(NodeServices.layer, logs.layer)));
  });

  it.live("passes input and size on, and refuses input once the login exited", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(({ bin }) => ({ [GROK]: grokInstance(bin) }));
      const { flowId, process } = yield* harness.started(GROK);
      const respond = (action: Parameters<ProviderSignInShape["respond"]>[0]["action"]) =>
        harness.runtime.respond({ instanceId: GROK, flowId, action });

      yield* respond({ type: "input", data: "1" });
      yield* respond({ type: "input", data: "code-123\r" });
      yield* respond({ type: "resize", cols: 120, rows: 40 });
      assert.deepEqual(process.writes, ["1", "code-123\r"]);
      assert.deepEqual(process.resizeCalls, [{ cols: 120, rows: 40 }]);
      assert.deepEqual((yield* harness.reach("waiting", GROK)).interaction, {
        type: "terminal",
        cols: 120,
        rows: 40,
      });

      process.emitExit({ exitCode: 1, signal: null });
      const failed = yield* harness.reach("failed", GROK);
      assert.equal(failed.message, "The login command exited with code 1.");
      assert.deepEqual(harness.refreshed, []);
      const late = yield* respond({ type: "input", data: "y\r" }).pipe(Effect.flip);
      assert.equal(late.message, "This sign-in is no longer active.");
      assert.deepEqual(process.writes, ["1", "code-123\r"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("fails a login that a signal stopped, without checking the instance", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(({ bin }) => ({ [GROK]: grokInstance(bin) }));
      const { process } = yield* harness.started(GROK);
      process.emitExit({ exitCode: 0, signal: 9 });

      const failed = yield* harness.reach("failed", GROK);
      assert.equal(failed.message, "The login command was stopped by signal 9.");
      assert.deepEqual(harness.refreshed, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("fails instead of succeeding when the instance's settings changed meanwhile", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(({ bin }) => ({ [CLAUDE]: claudeInstance(bin) }));
      const { process } = yield* harness.started(CLAUDE);
      const changed = Schema.decodeSync(ServerSettings)({
        providerInstances: {
          [CLAUDE]: claudeInstance(harness.bin, { CLAUDE_CONFIG_DIR: "/srv/another-store" }),
        },
      });
      yield* Ref.set(harness.settings, changed);
      yield* PubSub.publish(harness.settingsChanges, changed);
      process.emitExit({ exitCode: 0, signal: null });

      const failed = yield* harness.reach("failed", CLAUDE);
      assert.equal(failed.message, "Provider settings changed during sign-in. Start again.");
      assert.deepEqual(harness.refreshed, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("fails when Claude still reports no account after its login", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(({ bin }) => ({ [CLAUDE]: claudeInstance(bin) }));
      // What Claude reports whenever it starts, signed in or not.
      yield* Ref.set(harness.snapshot, { status: "ready", auth: { status: "authenticated" } });
      const { process } = yield* harness.started(CLAUDE);
      process.emitExit({ exitCode: 0, signal: null });

      assert.equal(
        (yield* harness.reach("failed", CLAUDE)).message,
        "The login finished, but Claude still reports no sign-in. Refresh providers.",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("cancel hangs the login up, and kills one that does not exit", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(({ bin }) => ({
        [GROK]: grokInstance(bin),
        [CLAUDE]: claudeInstance(bin),
      }));
      const grok = yield* harness.started(GROK);
      yield* harness.runtime.respond({
        instanceId: GROK,
        flowId: grok.flowId,
        action: { type: "cancel" },
      });
      assert.deepEqual(grok.process.killSignals, [undefined]);
      assert.equal((yield* harness.reach("cancelled", GROK)).message, "Sign-in cancelled.");

      harness.pty.exitOnKill = false;
      const claude = yield* harness.started(CLAUDE);
      const cancelledAt = Date.now();
      yield* harness.runtime.respond({
        instanceId: CLAUDE,
        flowId: claude.flowId,
        action: { type: "cancel" },
      });
      assert.deepEqual(claude.process.killSignals, [undefined, "SIGKILL"]);
      assert.isAtLeast(Date.now() - cancelledAt, 900);
      yield* harness.reach("cancelled", CLAUDE);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("ends the login with the server, not with the client that started it", () =>
    Effect.gen(function* () {
      const serverScope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(serverScope, Exit.void));
      const harness = yield* makeHarness(({ bin }) => ({ [GROK]: grokInstance(bin) }), {
        scope: serverScope,
      });
      const rpc = yield* harness.runtime
        .start(GROK)
        .pipe(
          Effect.andThen(harness.runtime.subscribe(GROK).pipe(Stream.runDrain)),
          Effect.forkChild,
        );
      yield* harness.reach("waiting", GROK);
      const process = harness.pty.processes[0]!;
      yield* Fiber.interrupt(rpc);
      assert.isFalse(process.killed);

      yield* Scope.close(serverScope, Exit.void);
      assert.isTrue(process.killed);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("expires after 15 minutes and ends the login", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness(({ bin }) => ({ [GROK]: grokInstance(bin) }));
        const { flowId, process } = yield* harness.started(GROK);

        yield* TestClock.adjust("15 minutes");
        const expired = yield* harness.reach("expired", GROK);

        assert.equal(expired.flowId, flowId);
        assert.equal(expired.message, "The sign-in expired. Start again.");
        assert.isTrue(process.killed);
        assert.deepEqual(harness.refreshed, []);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
