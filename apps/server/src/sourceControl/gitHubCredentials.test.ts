import os from "node:os";

import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, PlatformError, Redacted } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { TestClock } from "effect/testing";
import { VcsProcessSpawnError, VcsProcessTimeoutError, type VcsError } from "@ryco/contracts";

import {
  ProcessLaneRef,
  governChildProcess,
  inBackgroundProcessLane,
  processGovernorStats,
  type ProcessLane,
} from "../processGovernor.ts";
import type * as VcsProcess from "../vcs/VcsProcess.ts";
import {
  gitHubCredentialFingerprint,
  gitHubEnvironmentToken,
  gitHubFetchIgnoresProxy,
  isGitHubDotComHost,
  makeGitHubCredentials,
  normalizeGitHubHost,
  type GitHubCredentialLookup,
  type GitHubFetchRuntime,
} from "./gitHubCredentials.ts";

const NODE_RUNTIME: GitHubFetchRuntime = { bun: undefined, node: "24.22.0", execArgv: [] };

const output = (
  stdout: string,
  options?: { readonly exitCode?: number; readonly stderr?: string },
): VcsProcess.VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(options?.exitCode ?? 0),
  stdout,
  stderr: options?.stderr ?? "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

interface RecordedRun {
  readonly input: VcsProcess.VcsProcessInput;
  readonly lane: ProcessLane;
}

/** A fake `VcsProcess` whose `run` answers from `answer` and records each call and its lane. */
function fakeProcess(
  answer: (
    input: VcsProcess.VcsProcessInput,
  ) => Effect.Effect<VcsProcess.VcsProcessOutput, VcsError>,
) {
  const runs: RecordedRun[] = [];
  const process: VcsProcess.VcsProcessShape = {
    withProcess: () => Effect.die("not used"),
    run: (input) =>
      Effect.flatMap(ProcessLaneRef, (lane) => {
        runs.push({ input, lane });
        return answer(input);
      }),
  };
  return { process, runs };
}

const tokenOf = (lookup: GitHubCredentialLookup): string | null =>
  lookup._tag === "Available" ? Redacted.value(lookup.credential.token) : null;

describe("gitHubEnvironmentToken", () => {
  it("follows gh's order for github.com and GHE.com hosts", () => {
    assert.deepStrictEqual(
      gitHubEnvironmentToken("github.com", { GH_TOKEN: "gh", GITHUB_TOKEN: "github" }),
      { token: "gh", name: "GH_TOKEN" },
    );
    assert.deepStrictEqual(gitHubEnvironmentToken("github.com", { GITHUB_TOKEN: " github " }), {
      token: "github",
      name: "GITHUB_TOKEN",
    });
    assert.deepStrictEqual(gitHubEnvironmentToken("octo.ghe.com", { GH_TOKEN: "gh" }), {
      token: "gh",
      name: "GH_TOKEN",
    });
    // Whitespace-only values count as unset.
    assert.isNull(gitHubEnvironmentToken("github.com", { GH_TOKEN: "   ", GITHUB_TOKEN: "" }));
    // An enterprise token never goes to github.com.
    assert.isNull(gitHubEnvironmentToken("github.com", { GH_ENTERPRISE_TOKEN: "ent" }));
  });

  it("sends an enterprise token only to the host GH_HOST names", () => {
    assert.deepStrictEqual(
      gitHubEnvironmentToken("ghes.example:8443", {
        GH_HOST: " GHES.example:8443 ",
        GH_ENTERPRISE_TOKEN: "ent",
        GITHUB_ENTERPRISE_TOKEN: "other",
      }),
      { token: "ent", name: "GH_ENTERPRISE_TOKEN" },
    );
    assert.deepStrictEqual(
      gitHubEnvironmentToken("ghes.example", {
        GH_HOST: "ghes.example",
        GITHUB_ENTERPRISE_TOKEN: "ent",
      }),
      { token: "ent", name: "GITHUB_ENTERPRISE_TOKEN" },
    );
    assert.strictEqual(
      gitHubEnvironmentToken("evil.example", {
        GH_HOST: "ghes.example",
        GH_ENTERPRISE_TOKEN: "ent",
      }),
      "env-token-other-host",
    );
    // GH_HOST unset: gh would hand the enterprise token to any host, so the host stays on gh.
    assert.strictEqual(
      gitHubEnvironmentToken("ghes.example", { GH_ENTERPRISE_TOKEN: "ent" }),
      "env-token-other-host",
    );
    // A github.com token is not an enterprise host's token.
    assert.isNull(gitHubEnvironmentToken("ghes.example", { GH_TOKEN: "gh" }));
  });

  it("normalizes hosts and recognises GitHub.com-like ones", () => {
    assert.strictEqual(normalizeGitHubHost(" GitHub.com "), "github.com");
    assert.strictEqual(normalizeGitHubHost("ghes.example:8443"), "ghes.example:8443");
    assert.isNull(normalizeGitHubHost("evil.example/x"));
    assert.isNull(normalizeGitHubHost("user@evil.example"));
    assert.isNull(normalizeGitHubHost(""));
    assert.isTrue(isGitHubDotComHost("github.com"));
    assert.isTrue(isGitHubDotComHost("octo.ghe.com"));
    assert.isFalse(isGitHubDotComHost("ghes.example"));
  });
});

describe("gitHubFetchIgnoresProxy", () => {
  it("keeps proxied machines on gh unless fetch reads the proxy itself", () => {
    assert.isFalse(gitHubFetchIgnoresProxy({}, NODE_RUNTIME));
    assert.isTrue(gitHubFetchIgnoresProxy({ HTTPS_PROXY: "http://proxy:3128" }, NODE_RUNTIME));
    assert.isTrue(gitHubFetchIgnoresProxy({ https_proxy: "http://proxy:3128" }, NODE_RUNTIME));
    assert.isFalse(
      gitHubFetchIgnoresProxy(
        { HTTPS_PROXY: "http://proxy:3128", NODE_USE_ENV_PROXY: "1" },
        NODE_RUNTIME,
      ),
    );
    assert.isFalse(
      gitHubFetchIgnoresProxy(
        { HTTPS_PROXY: "http://proxy:3128" },
        { ...NODE_RUNTIME, execArgv: ["--use-env-proxy"] },
      ),
    );
    // Neither gh nor fetch reads ALL_PROXY.
    assert.isFalse(gitHubFetchIgnoresProxy({ ALL_PROXY: "socks5://proxy:1080" }, NODE_RUNTIME));
  });

  it("does not trust NODE_USE_ENV_PROXY on a Node without it, and trusts Bun", () => {
    const proxied = { HTTPS_PROXY: "http://proxy:3128", NODE_USE_ENV_PROXY: "1" };
    assert.isTrue(gitHubFetchIgnoresProxy(proxied, { ...NODE_RUNTIME, node: "23.11.0" }));
    assert.isTrue(gitHubFetchIgnoresProxy(proxied, { ...NODE_RUNTIME, node: "22.16.0" }));
    assert.isTrue(gitHubFetchIgnoresProxy(proxied, { ...NODE_RUNTIME, node: "24.4.1" }));
    assert.isFalse(gitHubFetchIgnoresProxy(proxied, { ...NODE_RUNTIME, node: "22.21.0" }));
    assert.isFalse(
      gitHubFetchIgnoresProxy(
        { HTTPS_PROXY: "http://proxy:3128" },
        { bun: "1.4.3", node: "24.3.0", execArgv: [] },
      ),
    );
  });
});

describe("gitHubCredentialFingerprint", () => {
  it("is 16 stable hex characters that differ by host and token and hide the token", () => {
    const fingerprint = gitHubCredentialFingerprint("github.com", "ghp_TEST_SENTINEL");
    assert.match(fingerprint, /^[0-9a-f]{16}$/u);
    assert.strictEqual(fingerprint, gitHubCredentialFingerprint("github.com", "ghp_TEST_SENTINEL"));
    assert.notStrictEqual(
      fingerprint,
      gitHubCredentialFingerprint("ghes.example", "ghp_TEST_SENTINEL"),
    );
    assert.notStrictEqual(fingerprint, gitHubCredentialFingerprint("github.com", "ghp_OTHER"));
    assert.notInclude(fingerprint, "SENTINEL");
  });
});

describe("makeGitHubCredentials", () => {
  it.effect("uses an environment token without starting gh", () =>
    Effect.gen(function* () {
      const fake = fakeProcess(() => Effect.die("gh must not run"));
      const credentials = yield* makeGitHubCredentials({
        process: fake.process,
        env: { GH_TOKEN: "ghp_env" },
        runtime: NODE_RUNTIME,
      });
      const lookup = yield* credentials.get("GitHub.com");
      assert.strictEqual(tokenOf(lookup), "ghp_env");
      assert.strictEqual(lookup._tag === "Available" && lookup.credential.source, "env");
      assert.strictEqual(lookup._tag === "Available" && lookup.credential.envName, "GH_TOKEN");
      assert.lengthOf(fake.runs, 0);
    }),
  );

  it.effect("refuses an enterprise env token for a host GH_HOST does not name, without gh", () =>
    Effect.gen(function* () {
      const fake = fakeProcess(() => Effect.die("gh must not run"));
      const unset = yield* makeGitHubCredentials({
        process: fake.process,
        env: { GH_ENTERPRISE_TOKEN: "ent" },
        runtime: NODE_RUNTIME,
      });
      assert.deepStrictEqual(yield* unset.get("ghes.example"), {
        _tag: "Unavailable",
        reason: "env-token-other-host",
      });
      const other = yield* makeGitHubCredentials({
        process: fake.process,
        env: { GH_ENTERPRISE_TOKEN: "ent", GH_HOST: "ghes.example" },
        runtime: NODE_RUNTIME,
      });
      assert.deepStrictEqual(yield* other.get("evil.example"), {
        _tag: "Unavailable",
        reason: "env-token-other-host",
      });
      assert.strictEqual(tokenOf(yield* other.get("ghes.example")), "ent");
      assert.lengthOf(fake.runs, 0);
    }),
  );

  it.effect("asks gh for the host's token with a quiet environment and a stable directory", () =>
    Effect.gen(function* () {
      const fake = fakeProcess(() => Effect.succeed(output("ghp_x\n")));
      const credentials = yield* makeGitHubCredentials({
        process: fake.process,
        env: {},
        runtime: NODE_RUNTIME,
      });
      const lookup = yield* credentials.get("GHES.example:8443");
      assert.strictEqual(tokenOf(lookup), "ghp_x");
      assert.isTrue(lookup._tag === "Available" && Redacted.isRedacted(lookup.credential.token));
      assert.notInclude(JSON.stringify(lookup), "ghp_x");
      assert.lengthOf(fake.runs, 1);
      const run = fake.runs[0]!.input;
      assert.strictEqual(run.command, "gh");
      assert.deepStrictEqual(run.args, ["auth", "token", "--hostname", "ghes.example:8443"]);
      assert.include(run.env, { GH_DEBUG: "", GH_PROMPT_DISABLED: "1" });
      assert.strictEqual(run.timeoutMs, 10_000);
      assert.strictEqual(run.allowNonZeroExit, true);
      assert.strictEqual(run.cwd, os.homedir());
    }),
  );

  it.effect("serves a token for minutes, then re-reads it in the background without waiting", () =>
    Effect.gen(function* () {
      let current = "ghp_first";
      const fake = fakeProcess(() => Effect.sync(() => output(`${current}\n`)));
      const credentials = yield* makeGitHubCredentials({
        process: fake.process,
        env: {},
        runtime: NODE_RUNTIME,
      });
      assert.strictEqual(tokenOf(yield* credentials.get("github.com")), "ghp_first");
      yield* TestClock.adjust("3 minutes");
      assert.strictEqual(tokenOf(yield* credentials.get("github.com")), "ghp_first");
      assert.lengthOf(fake.runs, 1);

      // Past the refresh age the old token is served at once and one lookup runs detached.
      current = "ghp_second";
      yield* TestClock.adjust("2 minutes");
      assert.strictEqual(tokenOf(yield* credentials.get("github.com")), "ghp_first");
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      assert.lengthOf(fake.runs, 2);
      assert.strictEqual(tokenOf(yield* credentials.get("github.com")), "ghp_second");
      assert.lengthOf(fake.runs, 2);

      // Unread for longer than the maximum age: resolved again before use.
      current = "ghp_third";
      yield* TestClock.adjust("61 minutes");
      assert.strictEqual(tokenOf(yield* credentials.get("github.com")), "ghp_third");
      assert.lengthOf(fake.runs, 3);
    }),
  );

  it.effect("keeps the token when a background refresh fails to run, and retries it later", () =>
    Effect.gen(function* () {
      let answer: "token" | "timeout" | "logged-out" = "token";
      const fake = fakeProcess((input) => {
        if (answer === "token") return Effect.succeed(output("ghp_kept\n"));
        if (answer === "logged-out") {
          return Effect.succeed(
            output("", { exitCode: 1, stderr: "no oauth token found for github.com" }),
          );
        }
        return Effect.fail(
          new VcsProcessTimeoutError({
            operation: input.operation,
            command: "gh auth token",
            cwd: input.cwd,
            timeoutMs: 10_000,
          }),
        );
      });
      const credentials = yield* makeGitHubCredentials({
        process: fake.process,
        env: {},
        runtime: NODE_RUNTIME,
      });
      assert.strictEqual(tokenOf(yield* credentials.get("github.com")), "ghp_kept");

      // A refresh that times out (a loaded machine) leaves the working token in place.
      answer = "timeout";
      yield* TestClock.adjust("5 minutes");
      assert.strictEqual(tokenOf(yield* credentials.get("github.com")), "ghp_kept");
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      assert.lengthOf(fake.runs, 2);
      assert.strictEqual(tokenOf(yield* credentials.get("github.com")), "ghp_kept");
      // Not retried on every read: only after the miss TTL.
      yield* TestClock.adjust("5 seconds");
      assert.strictEqual(tokenOf(yield* credentials.get("github.com")), "ghp_kept");
      yield* Effect.yieldNow;
      assert.lengthOf(fake.runs, 2);

      // gh's own "no login" answer still replaces it on the next refresh.
      answer = "logged-out";
      yield* TestClock.adjust("6 seconds");
      assert.strictEqual(tokenOf(yield* credentials.get("github.com")), "ghp_kept");
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      assert.lengthOf(fake.runs, 3);
      assert.deepStrictEqual(yield* credentials.get("github.com"), {
        _tag: "Unavailable",
        reason: "no-credential",
      });
    }),
  );

  it.effect("retries a missing login after 10 seconds and not before", () =>
    Effect.gen(function* () {
      const fake = fakeProcess(() =>
        Effect.succeed(output("", { exitCode: 1, stderr: "no oauth token found for github.com" })),
      );
      const credentials = yield* makeGitHubCredentials({
        process: fake.process,
        env: {},
        runtime: NODE_RUNTIME,
      });
      assert.deepStrictEqual(yield* credentials.get("github.com"), {
        _tag: "Unavailable",
        reason: "no-credential",
      });
      yield* TestClock.adjust("9 seconds");
      yield* credentials.get("github.com");
      assert.lengthOf(fake.runs, 1);
      yield* TestClock.adjust("2 seconds");
      yield* credentials.get("github.com");
      assert.lengthOf(fake.runs, 2);
    }),
  );

  it.effect("treats an empty answer and a timeout as no credential for now", () =>
    Effect.gen(function* () {
      let answer: "empty" | "timeout" = "empty";
      const fake = fakeProcess((input) =>
        answer === "empty"
          ? Effect.succeed(output("  \n"))
          : Effect.fail(
              new VcsProcessTimeoutError({
                operation: input.operation,
                command: "gh auth token",
                cwd: input.cwd,
                timeoutMs: 10_000,
              }),
            ),
      );
      const credentials = yield* makeGitHubCredentials({
        process: fake.process,
        env: {},
        runtime: NODE_RUNTIME,
      });
      assert.deepStrictEqual(yield* credentials.get("github.com"), {
        _tag: "Unavailable",
        reason: "no-credential",
      });
      answer = "timeout";
      yield* TestClock.adjust("11 seconds");
      assert.deepStrictEqual(yield* credentials.get("github.com"), {
        _tag: "Unavailable",
        reason: "gh-failed",
      });
    }),
  );

  it.effect("remembers a gh without `auth token` for 10 minutes", () =>
    Effect.gen(function* () {
      const fake = fakeProcess(() =>
        Effect.succeed(
          output("", { exitCode: 1, stderr: 'unknown command "token" for "gh auth"' }),
        ),
      );
      const credentials = yield* makeGitHubCredentials({
        process: fake.process,
        env: {},
        runtime: NODE_RUNTIME,
      });
      assert.deepStrictEqual(yield* credentials.get("github.com"), {
        _tag: "Unavailable",
        reason: "gh-too-old",
      });
      yield* TestClock.adjust("9 minutes");
      yield* credentials.get("github.com");
      assert.lengthOf(fake.runs, 1);
      yield* TestClock.adjust("2 minutes");
      yield* credentials.get("github.com");
      assert.lengthOf(fake.runs, 2);
    }),
  );

  it.effect("reports a missing gh binary", () =>
    Effect.gen(function* () {
      const spawnError = (cause: unknown) =>
        new VcsProcessSpawnError({
          operation: "GitHubCredentials.lookup",
          command: "gh auth token",
          cwd: os.homedir(),
          cause,
        });
      const platform = fakeProcess(() =>
        Effect.fail(
          spawnError(
            PlatformError.systemError({
              _tag: "NotFound",
              module: "ChildProcess",
              method: "spawn",
            }),
          ),
        ),
      );
      const fromPlatform = yield* makeGitHubCredentials({
        process: platform.process,
        env: {},
        runtime: NODE_RUNTIME,
      });
      assert.deepStrictEqual(yield* fromPlatform.get("github.com"), {
        _tag: "Unavailable",
        reason: "gh-missing",
      });
      const text = fakeProcess(() => Effect.fail(spawnError(new Error("spawn gh ENOENT"))));
      const fromText = yield* makeGitHubCredentials({
        process: text.process,
        env: {},
        runtime: NODE_RUNTIME,
      });
      assert.deepStrictEqual(yield* fromText.get("github.com"), {
        _tag: "Unavailable",
        reason: "gh-missing",
      });
    }),
  );

  it.effect("shares one lookup between concurrent reads", () =>
    Effect.gen(function* () {
      const gate = yield* Deferred.make<void>();
      const fake = fakeProcess(() => Deferred.await(gate).pipe(Effect.as(output("ghp_shared\n"))));
      const credentials = yield* makeGitHubCredentials({
        process: fake.process,
        env: {},
        runtime: NODE_RUNTIME,
      });
      const fibers = yield* Effect.forEach(Array.from({ length: 5 }), () =>
        credentials.get("github.com").pipe(Effect.forkChild),
      );
      yield* Effect.yieldNow;
      yield* Deferred.succeed(gate, undefined);
      const results = yield* Effect.forEach(fibers, Fiber.join);
      assert.deepStrictEqual(results.map(tokenOf), Array(5).fill("ghp_shared"));
      assert.lengthOf(fake.runs, 1);
    }),
  );

  it.effect("keeps a proxied machine on gh without asking gh for a token", () =>
    Effect.gen(function* () {
      const fake = fakeProcess(() => Effect.die("gh must not run"));
      const credentials = yield* makeGitHubCredentials({
        process: fake.process,
        env: { HTTPS_PROXY: "http://proxy:3128", GH_TOKEN: "ghp_env" },
        runtime: NODE_RUNTIME,
      });
      assert.deepStrictEqual(yield* credentials.get("github.com"), {
        _tag: "Unavailable",
        reason: "proxy",
      });
      assert.lengthOf(fake.runs, 0);
    }),
  );

  it.effect("forgets a refused gh token on invalidate", () =>
    Effect.gen(function* () {
      let current = "ghp_old";
      const fake = fakeProcess(() => Effect.sync(() => output(current)));
      const credentials = yield* makeGitHubCredentials({
        process: fake.process,
        env: {},
        runtime: NODE_RUNTIME,
      });
      assert.strictEqual(tokenOf(yield* credentials.get("github.com")), "ghp_old");
      current = "ghp_new";
      yield* credentials.invalidate("GitHub.com");
      assert.strictEqual(tokenOf(yield* credentials.get("github.com")), "ghp_new");
      assert.lengthOf(fake.runs, 2);
    }),
  );

  it.effect(
    "looks the token up in the interactive lane, so interactive reads never wait behind background gh work",
    () =>
      Effect.gen(function* () {
        // A VcsProcess that is governed like the real one: every gh child takes a forge permit.
        const gate = yield* Deferred.make<void>();
        const fake = fakeProcess((input) =>
          governChildProcess(
            input.command,
            Deferred.await(gate).pipe(Effect.as(output("ghp_lane\n"))),
          ),
        );
        const credentials = yield* makeGitHubCredentials({
          process: fake.process,
          env: {},
          runtime: NODE_RUNTIME,
        });

        // Saturate the forge pool and queue background gh children behind it.
        const forgeLimit = processGovernorStats().find((stats) => stats.pool === "forge")!.limit;
        const release = yield* Deferred.make<void>();
        const holders = yield* Effect.forEach(Array.from({ length: forgeLimit }), () =>
          governChildProcess("gh", Deferred.await(release)).pipe(Effect.forkChild),
        );
        const queuedBehind = yield* Effect.forEach(Array.from({ length: 3 }), () =>
          governChildProcess("gh", Effect.void).pipe(inBackgroundProcessLane, Effect.forkChild),
        );
        yield* Effect.yieldNow;
        assert.strictEqual(
          processGovernorStats().find((stats) => stats.pool === "forge")!.queued,
          3,
        );

        // A background read starts the lookup; an interactive read joins it.
        const background = yield* credentials
          .get("github.com")
          .pipe(inBackgroundProcessLane, Effect.forkChild);
        yield* Effect.yieldNow;
        const interactive = yield* credentials.get("github.com").pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        assert.lengthOf(fake.runs, 1);
        assert.strictEqual(fake.runs[0]!.lane, "interactive");
        yield* Deferred.succeed(gate, undefined);
        // Both answer while the forge pool is still full and the background queue still waits.
        assert.strictEqual(tokenOf(yield* Fiber.join(interactive)), "ghp_lane");
        assert.strictEqual(tokenOf(yield* Fiber.join(background)), "ghp_lane");
        assert.strictEqual(
          processGovernorStats().find((stats) => stats.pool === "forge")!.queued,
          3,
        );

        yield* Deferred.succeed(release, undefined);
        yield* Effect.forEach([...holders, ...queuedBehind], Fiber.join);

        // After the refresh age a read returns the old token at once, also while the pool is full.
        const releaseAgain = yield* Deferred.make<void>();
        const fullAgain = yield* Effect.forEach(Array.from({ length: forgeLimit }), () =>
          governChildProcess("gh", Deferred.await(releaseAgain)).pipe(Effect.forkChild),
        );
        yield* Effect.yieldNow;
        yield* TestClock.adjust("5 minutes");
        assert.strictEqual(
          tokenOf(yield* credentials.get("github.com").pipe(inBackgroundProcessLane)),
          "ghp_lane",
        );
        yield* Deferred.succeed(releaseAgain, undefined);
        yield* Effect.forEach(fullAgain, Fiber.join);
        yield* Effect.yieldNow;
        assert.lengthOf(fake.runs, 2);
        assert.strictEqual(fake.runs[1]!.lane, "interactive");
      }),
  );
});
