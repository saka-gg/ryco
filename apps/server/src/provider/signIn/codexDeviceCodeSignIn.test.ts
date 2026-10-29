import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  type ProviderSignInInteraction,
  ServerSettings,
} from "@ryco/contracts";
import { Deferred, Effect, Fiber, Schema } from "effect";

import { prepareCodexDeviceCodeSignIn } from "./codexDeviceCodeSignIn.ts";

const PEER = path.join(import.meta.dirname, "../testFixtures/codexLoginMockPeer.sh");
const instanceId = ProviderInstanceId.make("codex_sign_in");

interface Scenario {
  readonly account?: { readonly type: string; readonly email?: string } | null;
  readonly requiresOpenaiAuth?: boolean;
  readonly start?: "deviceCode" | "error" | "hang" | "insecureUrl";
  readonly completion?: "success" | "failure" | "exit";
  readonly completionError?: string;
  readonly accountAfterLogin?: boolean;
  readonly codexHome?: string;
}

/**
 * A Codex instance whose binary is the login mock peer, on a home that does not exist yet. With
 * `authOverlay`, the instance signs in to a shadow home over a shared home that holds a config.
 */
const makeFixture = (scenario: Scenario, options: { readonly authOverlay?: boolean } = {}) =>
  Effect.gen(function* () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-sign-in-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => fs.rmSync(dir, { recursive: true, force: true })),
    );
    const sharedHome = path.join(dir, "codex-home");
    const shadowHome = path.join(dir, "codex-shadow");
    const home = options.authOverlay ? shadowHome : sharedHome;
    if (options.authOverlay) {
      fs.mkdirSync(sharedHome);
      fs.writeFileSync(path.join(sharedHome, "config.toml"), 'model_provider = "openai"\n');
    }
    const scriptPath = path.join(dir, "script.json");
    fs.writeFileSync(scriptPath, JSON.stringify(scenario));
    const settings = Schema.decodeSync(ServerSettings)({
      providerInstances: {
        [instanceId]: {
          driver: "codex",
          enabled: true,
          config: {
            binaryPath: PEER,
            homePath: sharedHome,
            ...(options.authOverlay ? { shadowHomePath: shadowHome } : {}),
          },
          environment: [{ name: "RYCO_CODEX_LOGIN_SCRIPT", value: scriptPath, sensitive: false }],
        },
      },
    });
    return {
      home,
      sharedHome,
      cwd: path.join(dir, "state", "provider-sign-in", "cwd"),
      settings,
      trigger: () => fs.writeFileSync(`${scriptPath}.trigger`, ""),
      requests: (): ReadonlyArray<{ readonly method: string; readonly params: unknown }> =>
        fs.existsSync(`${scriptPath}.requests`)
          ? fs
              .readFileSync(`${scriptPath}.requests`, "utf8")
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line))
          : [],
      pid: () => Number(fs.readFileSync(`${scriptPath}.pid`, "utf8")),
    };
  });

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Runs the method; `onWaiting` acts once the device code is shown (by default: approves it). */
const runSignIn = (
  fixture: Effect.Success<ReturnType<typeof makeFixture>>,
  onWaiting: (interaction: ProviderSignInInteraction) => Effect.Effect<void> = () =>
    Effect.sync(fixture.trigger),
) =>
  Effect.gen(function* () {
    const prepared = yield* prepareCodexDeviceCodeSignIn(fixture.settings, instanceId, fixture.cwd);
    return yield* prepared.run({ waiting: onWaiting });
  });

const noDeviceCode = () => Effect.sync(() => assert.fail("no device code expected"));

describe("Codex device-code sign-in", () => {
  it.live("shows the device code, waits for Codex and checks the account it reports", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture({});
      const shown: Array<ProviderSignInInteraction> = [];
      const result = yield* runSignIn(fixture, (interaction) =>
        Effect.sync(() => {
          shown.push(interaction);
          fixture.trigger();
        }),
      );

      assert.deepEqual(result, { message: null });
      assert.deepEqual(shown, [
        {
          type: "deviceCode",
          verificationUrl: "https://auth.example.test/codex/device",
          userCode: "FIXT-CODE",
        },
      ]);
      assert.deepEqual(
        fixture.requests().map((request) => request.method),
        ["initialize", "initialized", "account/read", "account/login/start", "account/read"],
      );
      assert.deepEqual(fixture.requests()[3]?.params, { type: "chatgptDeviceCode" });
      // A fresh node's Codex home and the private working directory exist, for this user only.
      assert.equal(fs.statSync(fixture.home).mode & 0o777, 0o700);
      assert.equal(fs.statSync(fixture.cwd).mode & 0o777, 0o700);
      assert.isFalse(isAlive(fixture.pid()));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("links an auth overlay's shadow home to the shared home before Codex starts", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture({}, { authOverlay: true });
      const result = yield* runSignIn(fixture);

      assert.deepEqual(result, { message: null });
      // Codex runs on the shadow home, which is private and reads the instance's shared config.
      assert.equal(fs.statSync(fixture.home).mode & 0o777, 0o700);
      assert.equal(
        fs.readlinkSync(path.join(fixture.home, "config.toml")),
        path.join(fixture.sharedHome, "config.toml"),
      );
      assert.include(
        fixture.requests().map((request) => request.method),
        "account/login/start",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("fails at once when Codex stops while the code is shown", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture({ completion: "exit" });
      const startedAt = Date.now();
      const error = yield* runSignIn(fixture).pipe(Effect.flip);

      assert.equal(error.message, "Codex stopped before the sign-in finished. Try again.");
      assert.isBelow(Date.now() - startedAt, 4_000);
      assert.isFalse(isAlive(fixture.pid()));
      // Nothing is left to cancel: the process is gone.
      assert.notInclude(
        fixture.requests().map((request) => request.method),
        "account/login/cancel",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("answers an instance that is already signed in without starting a login", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture({ account: { type: "chatgpt", email: "a@example.com" } });
      const result = yield* runSignIn(fixture, noDeviceCode);

      assert.deepEqual(result, { message: "Already signed in." });
      assert.notInclude(
        fixture.requests().map((request) => request.method),
        "account/login/start",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("refuses an instance whose model provider does not use a ChatGPT sign-in", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture({ requiresOpenaiAuth: false });
      const error = yield* runSignIn(fixture).pipe(Effect.flip);

      assert.equal(error.message, "This Codex instance does not use a ChatGPT sign-in.");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("explains a Codex that cannot start a device sign-in, with the CLI fallback", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture({ start: "error" });
      const error = yield* runSignIn(fixture).pipe(Effect.flip);

      assert.equal(
        error.message,
        "Codex could not start device sign-in: unknown variant `chatgptDeviceCode`. " +
          "Update Codex or run `codex login --device-auth` on the node.",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("refuses a verification page that is not https", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture({ start: "insecureUrl" });
      const error = yield* runSignIn(fixture, noDeviceCode).pipe(Effect.flip);

      assert.include(error.message, "Codex returned an unexpected device sign-in.");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("reports a failed login by its first line, without credentials", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture({
        completion: "failure",
        completionError: "token exchange failed: Bearer abc.def.ghi rejected\nstack trace",
      });
      const error = yield* runSignIn(fixture).pipe(Effect.flip);

      assert.equal(
        error.message,
        "Codex sign-in failed: token exchange failed: Bearer [redacted] rejected",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("does not take the completion alone as proof of a sign-in", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture({ accountAfterLogin: false });
      const error = yield* runSignIn(fixture).pipe(Effect.flip);

      assert.equal(error.message, "Codex finished the sign-in but reports no account. Try again.");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("cancels the login and ends Codex when the flow stops waiting", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture({});
      const waiting = yield* Deferred.make<void>();
      const fiber = yield* runSignIn(fixture, () => Deferred.succeed(waiting, undefined)).pipe(
        Effect.forkChild,
      );
      yield* Deferred.await(waiting);
      const pid = fixture.pid();
      assert.isTrue(isAlive(pid));

      yield* Fiber.interrupt(fiber);

      const cancel = fixture
        .requests()
        .find((request) => request.method === "account/login/cancel");
      assert.deepEqual(cancel?.params, { loginId: "login-fixture-1" });
      assert.isFalse(isAlive(pid));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("refuses a Codex that opened another store than the instance's", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture({ codexHome: os.tmpdir() });
      const error = yield* runSignIn(fixture, noDeviceCode).pipe(Effect.flip);

      assert.equal(error.message, "Codex started in a different provider store.");
      assert.notInclude(
        fixture.requests().map((request) => request.method),
        "account/read",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses an instance that is not an enabled Codex instance", () =>
    Effect.gen(function* () {
      const settings = Schema.decodeSync(ServerSettings)({
        providerInstances: { [instanceId]: { driver: "codex", enabled: false } },
      });
      const error = yield* prepareCodexDeviceCodeSignIn(settings, instanceId, "/unused").pipe(
        Effect.flip,
      );

      assert.equal(
        error.message,
        "This Codex instance is unavailable. Check its settings and try again.",
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
