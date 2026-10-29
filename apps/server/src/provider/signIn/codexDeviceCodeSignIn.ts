/**
 * Codex sign-in by device code: a one-job `codex app-server` on the instance's effective home
 * runs `account/login/start {type: "chatgptDeviceCode"}`. The person opens the verification page
 * on whatever device they use and enters the code; Codex polls for the result and writes
 * `auth.json` itself, so nothing reaches this node over HTTP and no loopback callback is needed.
 *
 * The code and the URL go only into the flow's state. They are never logged.
 *
 * @module codexDeviceCodeSignIn
 */
import * as NodePath from "node:path";

import {
  ProviderSignInError,
  type ProviderInstanceId,
  type ProviderSignInInteraction,
  type ServerSettings,
} from "@ryco/contracts";
import { redactDiagnosticText } from "@ryco/shared/diagnosticRedaction";
import { Deferred, Effect, FileSystem, type Path, Queue, Schema } from "effect";
import type * as CodexClient from "effect-codex-app-server/client";
import type { ChildProcessSpawner } from "effect/process";

import { codexProcessEnvironment, materializeCodexShadowHome } from "../Drivers/CodexHomeLayout.ts";
import { type CodexInstanceRuntime, resolveCodexInstanceRuntime } from "../codexInstanceRuntime.ts";
import { codexRuntimeBinding } from "../codexRuntimeBinding.ts";
import { withIsolatedCodexAppServer } from "../codexIsolatedAppServer.ts";

/** Outlasts the flow's own 15-minute deadline, which ends the job first. */
const CODEX_DEVICE_CODE_JOB_TIMEOUT = "16 minutes";
const LOGIN_CANCEL_TIMEOUT = "2 seconds";
const DEVICE_AUTH_HINT = "Update Codex or run `codex login --device-auth` on the node.";
const HOME_UNPREPARED = "Could not prepare Codex's home directory on the node.";

/** Forward-compatible views of the account responses: newer plan types must not fail a login. */
const AccountRead = Schema.Struct({
  account: Schema.optional(Schema.NullOr(Schema.Struct({ type: Schema.String }))),
  requiresOpenaiAuth: Schema.optional(Schema.Boolean),
});
const LoginStart = Schema.Struct({
  type: Schema.String,
  loginId: Schema.optional(Schema.String),
  userCode: Schema.optional(Schema.String),
  verificationUrl: Schema.optional(Schema.String),
});

type LoginCompleted = {
  readonly success: boolean;
  readonly error?: string | null | undefined;
  readonly loginId?: string | null | undefined;
};

const failure = (message: string) => new ProviderSignInError({ message });

/** The first line of a provider message, without credentials or URLs, short enough to show. */
const presentableLine = (text: string): string =>
  redactDiagnosticText(text.split(/\r?\n/u, 1)[0]?.trim() ?? "").slice(0, 200);

/** The store a Codex instance keeps its login in. */
const credentialHome = (runtime: CodexInstanceRuntime) =>
  runtime.layout.effectiveHomePath ?? runtime.layout.sharedHomePath;

/** The binding a finished sign-in is checked against: binary, credential store and environment. */
const signInBinding = (runtime: CodexInstanceRuntime) =>
  codexRuntimeBinding({
    instanceId: runtime.instanceId,
    binaryPath: runtime.binaryPath,
    homePath: credentialHome(runtime),
    environment: codexProcessEnvironment(runtime.layout, runtime.environment),
  });

/** The binding of the instance as the settings define it now; `undefined` once it cannot sign in. */
const currentBinding = (settings: ServerSettings, instanceId: ProviderInstanceId) =>
  resolveCodexInstanceRuntime(settings, instanceId).pipe(
    Effect.map(signInBinding),
    Effect.orElseSucceed(() => undefined),
  );

export interface CodexDeviceCodeSignInHooks {
  /** Publishes what the person acts on; the flow then waits for Codex. */
  readonly waiting: (interaction: ProviderSignInInteraction) => Effect.Effect<void>;
}

/**
 * Resolves the instance and returns the flow's parts: two instances on one Codex home share a
 * `credentialKey`, so only one of them signs in at a time.
 */
export const prepareCodexDeviceCodeSignIn = (
  settings: ServerSettings,
  instanceId: ProviderInstanceId,
  cwd: string,
) =>
  resolveCodexInstanceRuntime(settings, instanceId).pipe(
    Effect.mapError(() =>
      failure("This Codex instance is unavailable. Check its settings and try again."),
    ),
    Effect.map((runtime) => ({
      method: "codexDeviceCode" as const,
      credentialKey: `codex:${NodePath.resolve(credentialHome(runtime))}`,
      binding: signInBinding(runtime),
      currentBinding: (next: ServerSettings) => currentBinding(next, instanceId),
      run: (hooks: CodexDeviceCodeSignInHooks) => runCodexDeviceCodeSignIn(runtime, cwd, hooks),
    })),
  );

const readAccount = (client: CodexClient.CodexAppServerClientShape) =>
  client.raw.request("account/read", {}).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(AccountRead)),
    Effect.mapError((error) =>
      failure(
        `Codex could not read its account: ${presentableLine(error.message)}. ${DEVICE_AUTH_HINT}`,
      ),
    ),
  );

/** Creates a missing directory for this node's user only; an existing one is left as it is. */
const ensurePrivateDirectory = (path: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    if (yield* fileSystem.exists(path)) return;
    yield* fileSystem.makeDirectory(path, { recursive: true, mode: 0o700 });
  });

/**
 * `stopped` completes once the app-server's process is gone. Requests fail on their own then, but
 * the wait for the completion notification would not: a code shown for a dead process could never
 * be redeemed, and the instance would stay blocked until the deadline.
 */
const signIn = (
  client: CodexClient.CodexAppServerClientShape,
  stopped: Effect.Effect<void>,
  hooks: CodexDeviceCodeSignInHooks,
) =>
  Effect.gen(function* () {
    const before = yield* readAccount(client);
    if (before.account) return { message: "Already signed in." };
    // A custom model provider (a CLIProxy-routed Codex, say) authenticates without ChatGPT.
    if (before.requiresOpenaiAuth === false) {
      return yield* failure("This Codex instance does not use a ChatGPT sign-in.");
    }

    // Registered before the start request, so a completion is never missed.
    const completions = yield* Queue.unbounded<LoginCompleted>();
    yield* client.handleServerNotification("account/login/completed", (completed) =>
      Queue.offer(completions, completed).pipe(Effect.asVoid),
    );
    const started = yield* client.raw
      .request("account/login/start", { type: "chatgptDeviceCode" })
      .pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(LoginStart)),
        Effect.mapError((error) =>
          failure(
            `Codex could not start device sign-in: ${presentableLine(error.message)}. ${DEVICE_AUTH_HINT}`,
          ),
        ),
      );
    const userCode = started.userCode?.trim() ?? "";
    const verificationUrl = started.verificationUrl ?? "";
    if (
      started.type !== "chatgptDeviceCode" ||
      !started.loginId ||
      userCode.length === 0 ||
      userCode.length > 64 ||
      verificationUrl.length > 2048 ||
      !isHttpsUrl(verificationUrl)
    ) {
      return yield* failure(`Codex returned an unexpected device sign-in. ${DEVICE_AUTH_HINT}`);
    }
    const loginId = started.loginId;
    const completed = yield* Effect.raceFirst(
      Effect.gen(function* () {
        yield* hooks.waiting({ type: "deviceCode", verificationUrl, userCode });
        while (true) {
          const next = yield* Queue.take(completions);
          if (!next.loginId || next.loginId === loginId) return next;
        }
      }),
      stopped.pipe(
        Effect.andThen(
          Effect.fail(failure("Codex stopped before the sign-in finished. Try again.")),
        ),
      ),
    ).pipe(
      // Cancel, expiry and shutdown stop Codex polling before its process ends.
      Effect.onInterrupt(() =>
        client.raw
          .request("account/login/cancel", { loginId })
          .pipe(Effect.timeout(LOGIN_CANCEL_TIMEOUT), Effect.ignore),
      ),
    );
    if (!completed.success) {
      const detail = presentableLine(completed.error ?? "");
      return yield* failure(
        detail ? `Codex sign-in failed: ${detail}` : "Codex sign-in did not complete.",
      );
    }
    // The notification alone is no proof: the same process must now report the account.
    const after = yield* readAccount(client);
    if (!after.account) {
      return yield* failure("Codex finished the sign-in but reports no account. Try again.");
    }
    return { message: null };
  });

const isHttpsUrl = (value: string) => {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
};

/**
 * Runs the device-code login against the instance's own store. A fresh node has no Codex home
 * yet; it is created (0700) first, because the app-server's home check needs it to exist. An auth
 * overlay's shadow home is then linked to the shared home, as the driver does, so Codex reads the
 * instance's own config (its model provider decides whether a ChatGPT sign-in applies) and no
 * entry it creates there collides with a later link.
 */
const runCodexDeviceCodeSignIn = (
  runtime: CodexInstanceRuntime,
  cwd: string,
  hooks: CodexDeviceCodeSignInHooks,
): Effect.Effect<
  { readonly message: string | null },
  ProviderSignInError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    yield* Effect.all([
      ensurePrivateDirectory(credentialHome(runtime)),
      ensurePrivateDirectory(cwd),
    ]).pipe(Effect.mapError(() => failure(HOME_UNPREPARED)));
    yield* materializeCodexShadowHome(runtime.layout).pipe(
      Effect.mapError((error) => failure(`${HOME_UNPREPARED} ${error.detail}`)),
    );
    const stopped = yield* Deferred.make<void>();
    return yield* withIsolatedCodexAppServer(
      {
        ...runtime,
        cwd,
        timeout: CODEX_DEVICE_CODE_JOB_TIMEOUT,
        onTermination: () => Deferred.succeed(stopped, undefined).pipe(Effect.asVoid),
      },
      (client) => signIn(client, Deferred.await(stopped), hooks),
    ).pipe(
      Effect.catchTag("CodexIsolatedAppServerError", (error) => Effect.fail(failure(error.detail))),
    );
  });
