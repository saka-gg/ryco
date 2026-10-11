import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Duration, Effect, Layer, Option, Ref } from "effect";
import { TestClock } from "effect/testing";
import { ChildProcessSpawner } from "effect/process";
import { VcsProcessSpawnError } from "@ryco/contracts";

import { ServerConfig } from "../config.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";
import * as BitbucketApi from "./BitbucketApi.ts";
import * as ForgejoApi from "./ForgejoApi.ts";
import * as GitHubCli from "./GitHubCli.ts";
import * as GitLabCli from "./GitLabCli.ts";
import * as SourceControlDiscovery from "./SourceControlDiscovery.ts";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";

const sourceControlProviderRegistryTestLayer = (input: {
  readonly bitbucket: Partial<BitbucketApi.BitbucketApiShape>;
  readonly forgejo?: Partial<ForgejoApi.ForgejoApiShape>;
  readonly process: Partial<VcsProcess.VcsProcessShape>;
}) =>
  SourceControlProviderRegistry.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "ryco-source-control-registry-test-",
        }).pipe(Layer.provide(NodeServices.layer)),
        Layer.mock(AzureDevOpsCli.AzureDevOpsCli)({}),
        Layer.mock(BitbucketApi.BitbucketApi)(input.bitbucket),
        Layer.mock(ForgejoApi.ForgejoApi)({
          probeAuth: Effect.succeed({
            status: "unauthenticated",
            account: Option.none(),
            host: Option.some("codeberg.org"),
            detail: Option.none(),
          }),
          detectProviderFromRemoteUrl: () => null,
          ...input.forgejo,
        }),
        Layer.mock(GitHubCli.GitHubCli)({}),
        Layer.mock(GitLabCli.GitLabCli)({}),
        Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({}),
        Layer.mock(VcsProcess.VcsProcess)(input.process),
      ),
    ),
  );

const processOutput = (
  stdout: string,
  options?: {
    readonly stderr?: string;
    readonly exitCode?: ChildProcessSpawner.ExitCode;
  },
): VcsProcess.VcsProcessOutput => ({
  exitCode: options?.exitCode ?? ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: options?.stderr ?? "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const sourceControlDiscoveryTestLayer = (input: {
  readonly bitbucket: Partial<BitbucketApi.BitbucketApiShape>;
  readonly forgejo?: Partial<ForgejoApi.ForgejoApiShape>;
  readonly process: Partial<VcsProcess.VcsProcessShape>;
  readonly prefix: string;
}) =>
  SourceControlDiscovery.layer.pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: input.prefix })),
    Layer.provide(Layer.mock(VcsProcess.VcsProcess)(input.process)),
    Layer.provide(
      sourceControlProviderRegistryTestLayer({
        process: input.process,
        bitbucket: input.bitbucket,
        ...(input.forgejo ? { forgejo: input.forgejo } : {}),
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

it.effect("reports implemented tools separately from locally available executables", () => {
  const processMock = {
    run: (input: VcsProcess.VcsProcessInput) => {
      if (input.command === "git") {
        return Effect.succeed(processOutput("git version 2.51.0\n"));
      }
      if (input.command === "gh" && input.args[0] === "--version") {
        return Effect.succeed(processOutput("gh version 2.83.0\n"));
      }
      if (input.command === "gh" && input.args.join(" ") === "auth status --json hosts") {
        return Effect.succeed(
          processOutput(
            JSON.stringify({
              hosts: {
                "github.com": [
                  {
                    state: "success",
                    active: true,
                    host: "github.com",
                    login: "juliusmarminge",
                  },
                ],
              },
            }),
          ),
        );
      }
      return Effect.fail(
        new VcsProcessSpawnError({
          operation: input.operation,
          command: input.command,
          cwd: input.cwd,
          cause: new Error(`${input.command} not found`),
        }),
      );
    },
  } satisfies Partial<VcsProcess.VcsProcessShape>;
  const testLayer = SourceControlDiscovery.layer.pipe(
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "ryco-source-control-discovery-" }),
    ),
    Layer.provide(Layer.mock(VcsProcess.VcsProcess)(processMock)),
    Layer.provide(
      sourceControlProviderRegistryTestLayer({
        process: processMock,
        bitbucket: {
          probeAuth: Effect.succeed({
            status: "unauthenticated",
            account: Option.none(),
            host: Option.some("bitbucket.org"),
            detail: Option.some(
              "Set RYCO_BITBUCKET_EMAIL and RYCO_BITBUCKET_API_TOKEN, or RYCO_BITBUCKET_ACCESS_TOKEN.",
            ),
          }),
        },
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

  return Effect.gen(function* () {
    const discovery = yield* SourceControlDiscovery.SourceControlDiscovery;
    const result = yield* discovery.discover;

    assert.deepStrictEqual(
      result.versionControlSystems.map((item) => ({
        kind: item.kind,
        implemented: item.implemented,
        status: item.status,
      })),
      [
        { kind: "git", implemented: true, status: "available" },
        { kind: "jj", implemented: false, status: "missing" },
      ],
    );
    assert.deepStrictEqual(
      result.sourceControlProviders.map((item) => ({
        kind: item.kind,
        status: item.status,
        auth: item.auth.status,
        account: item.auth.account,
      })),
      [
        {
          kind: "github",
          status: "available",
          auth: "authenticated",
          account: Option.some("juliusmarminge"),
        },
        {
          kind: "gitlab",
          status: "missing",
          auth: "unknown",
          account: Option.none(),
        },
        {
          kind: "azure-devops",
          status: "missing",
          auth: "unknown",
          account: Option.none(),
        },
        {
          kind: "bitbucket",
          status: "available",
          auth: "unauthenticated",
          account: Option.none(),
        },
        {
          kind: "forgejo",
          status: "available",
          auth: "unauthenticated",
          account: Option.none(),
        },
      ],
    );
    const bitbucket = result.sourceControlProviders.find((item) => item.kind === "bitbucket");
    assert.ok(bitbucket);
    assert.strictEqual(bitbucket.executable, undefined);
  }).pipe(Effect.provide(testLayer));
});

it.effect("caches repeated discovery requests within the short discovery TTL", () =>
  Effect.gen(function* () {
    const processRuns = yield* Ref.make(0);
    const bitbucketProbes = yield* Ref.make(0);
    const processMock = {
      run: (input: VcsProcess.VcsProcessInput) =>
        Ref.update(processRuns, (count) => count + 1).pipe(
          Effect.as(processOutput(`${input.command} version test\n`)),
        ),
    } satisfies Partial<VcsProcess.VcsProcessShape>;
    const testLayer = sourceControlDiscoveryTestLayer({
      process: processMock,
      bitbucket: {
        probeAuth: Ref.update(bitbucketProbes, (count) => count + 1).pipe(
          Effect.as({
            status: "authenticated" as const,
            account: Option.some("bitbucket-user"),
            host: Option.some("bitbucket.org"),
            detail: Option.none(),
          }),
        ),
      },
      prefix: "ryco-source-control-discovery-cache-test-",
    });

    const counts = yield* Effect.gen(function* () {
      const discovery = yield* SourceControlDiscovery.SourceControlDiscovery;
      yield* discovery.discover;
      const afterFirstProcessRuns = yield* Ref.get(processRuns);
      const afterFirstBitbucketProbes = yield* Ref.get(bitbucketProbes);

      yield* discovery.discover;

      return {
        afterFirstProcessRuns,
        afterFirstBitbucketProbes,
        afterSecondProcessRuns: yield* Ref.get(processRuns),
        afterSecondBitbucketProbes: yield* Ref.get(bitbucketProbes),
      };
    }).pipe(Effect.provide(testLayer));

    assert.ok(counts.afterFirstProcessRuns > 0);
    assert.ok(counts.afterFirstBitbucketProbes > 0);
    assert.strictEqual(counts.afterSecondProcessRuns, counts.afterFirstProcessRuns);
    assert.strictEqual(counts.afterSecondBitbucketProbes, counts.afterFirstBitbucketProbes);
  }),
);

it.effect("refreshes discovery after the short discovery TTL expires", () =>
  Effect.gen(function* () {
    const processRuns = yield* Ref.make(0);
    const bitbucketProbes = yield* Ref.make(0);
    const processMock = {
      run: (input: VcsProcess.VcsProcessInput) =>
        Ref.update(processRuns, (count) => count + 1).pipe(
          Effect.as(processOutput(`${input.command} version test\n`)),
        ),
    } satisfies Partial<VcsProcess.VcsProcessShape>;
    const testLayer = sourceControlDiscoveryTestLayer({
      process: processMock,
      bitbucket: {
        probeAuth: Ref.update(bitbucketProbes, (count) => count + 1).pipe(
          Effect.as({
            status: "authenticated" as const,
            account: Option.some("bitbucket-user"),
            host: Option.some("bitbucket.org"),
            detail: Option.none(),
          }),
        ),
      },
      prefix: "ryco-source-control-discovery-expiry-test-",
    });

    const counts = yield* Effect.gen(function* () {
      const discovery = yield* SourceControlDiscovery.SourceControlDiscovery;
      yield* discovery.discover;
      const afterFirstProcessRuns = yield* Ref.get(processRuns);
      const afterFirstBitbucketProbes = yield* Ref.get(bitbucketProbes);

      yield* TestClock.adjust(
        Duration.sum(SourceControlDiscovery.SOURCE_CONTROL_DISCOVERY_CACHE_TTL, Duration.millis(1)),
      );
      yield* discovery.discover;

      return {
        afterFirstProcessRuns,
        afterFirstBitbucketProbes,
        afterSecondProcessRuns: yield* Ref.get(processRuns),
        afterSecondBitbucketProbes: yield* Ref.get(bitbucketProbes),
      };
    }).pipe(Effect.provide(Layer.merge(testLayer, TestClock.layer())));

    assert.ok(counts.afterSecondProcessRuns > counts.afterFirstProcessRuns);
    assert.ok(counts.afterSecondBitbucketProbes > counts.afterFirstBitbucketProbes);
  }),
);

it.effect("refresh bypasses the short discovery cache", () =>
  Effect.gen(function* () {
    const bitbucketProbes = yield* Ref.make(0);
    const processMock = {
      run: (input: VcsProcess.VcsProcessInput) =>
        Effect.succeed(processOutput(`${input.command} version test\n`)),
    } satisfies Partial<VcsProcess.VcsProcessShape>;
    const testLayer = sourceControlDiscoveryTestLayer({
      process: processMock,
      bitbucket: {
        probeAuth: Ref.updateAndGet(bitbucketProbes, (count) => count + 1).pipe(
          Effect.map((count) => ({
            status: count === 1 ? ("unauthenticated" as const) : ("authenticated" as const),
            account: count === 1 ? Option.none<string>() : Option.some("bitbucket-user"),
            host: Option.some("bitbucket.org"),
            detail: Option.none<string>(),
          })),
        ),
      },
      prefix: "ryco-source-control-discovery-refresh-test-",
    });

    const result = yield* Effect.gen(function* () {
      const discovery = yield* SourceControlDiscovery.SourceControlDiscovery;
      const first = yield* discovery.discover;
      const refreshed = yield* discovery.refresh;

      return {
        first: first.sourceControlProviders.find((item) => item.kind === "bitbucket")?.auth.status,
        refreshed: refreshed.sourceControlProviders.find((item) => item.kind === "bitbucket")?.auth
          .status,
        probes: yield* Ref.get(bitbucketProbes),
      };
    }).pipe(Effect.provide(testLayer));

    assert.strictEqual(result.first, "unauthenticated");
    assert.strictEqual(result.refreshed, "authenticated");
    assert.strictEqual(result.probes, 2);
  }),
);

it.effect("probes provider authentication without exposing token details", () => {
  const processMock = {
    run: (input: VcsProcess.VcsProcessInput) => {
      if (input.args[0] === "--version") {
        return Effect.succeed(processOutput(`${input.command} version test\n`));
      }
      if (input.command === "gh" && input.args.join(" ") === "auth status --json hosts") {
        return Effect.succeed(
          processOutput(
            JSON.stringify({
              hosts: {
                "github.com": [
                  {
                    state: "success",
                    active: true,
                    host: "github.com",
                    login: "octocat",
                  },
                ],
              },
            }),
          ),
        );
      }
      if (input.command === "glab" && input.args.join(" ") === "auth status") {
        return Effect.succeed(
          processOutput(`gitlab.com
Logged in to gitlab.com as gitlab-user
`),
        );
      }
      if (
        input.command === "az" &&
        input.args.join(" ") === "account show --query user.name -o tsv"
      ) {
        return Effect.succeed(processOutput("azure-user@example.com\n"));
      }
      return Effect.fail(
        new VcsProcessSpawnError({
          operation: input.operation,
          command: input.command,
          cwd: input.cwd,
          cause: new Error(`${input.command} not found`),
        }),
      );
    },
  } satisfies Partial<VcsProcess.VcsProcessShape>;
  const testLayer = SourceControlDiscovery.layer.pipe(
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "ryco-source-control-auth-discovery-" }),
    ),
    Layer.provide(Layer.mock(VcsProcess.VcsProcess)(processMock)),
    Layer.provide(
      sourceControlProviderRegistryTestLayer({
        process: processMock,
        bitbucket: {
          probeAuth: Effect.succeed({
            status: "authenticated",
            account: Option.some("bitbucket-user"),
            host: Option.some("bitbucket.org"),
            detail: Option.none(),
          }),
        },
        forgejo: {
          probeAuth: Effect.succeed({
            status: "authenticated",
            account: Option.some("forgejo-user"),
            host: Option.some("codeberg.org"),
            detail: Option.none(),
          }),
        },
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

  return Effect.gen(function* () {
    const discovery = yield* SourceControlDiscovery.SourceControlDiscovery;
    const result = yield* discovery.discover;

    assert.deepStrictEqual(
      result.sourceControlProviders.map((item) => ({
        kind: item.kind,
        auth: item.auth.status,
        account: item.auth.account,
        detail: item.auth.detail,
      })),
      [
        {
          kind: "github",
          auth: "authenticated",
          account: Option.some("octocat"),
          detail: Option.none(),
        },
        {
          kind: "gitlab",
          auth: "authenticated",
          account: Option.some("gitlab-user"),
          detail: Option.none(),
        },
        {
          kind: "azure-devops",
          auth: "authenticated",
          account: Option.some("azure-user@example.com"),
          detail: Option.none(),
        },
        {
          kind: "bitbucket",
          auth: "authenticated",
          account: Option.some("bitbucket-user"),
          detail: Option.none(),
        },
        {
          kind: "forgejo",
          auth: "authenticated",
          account: Option.some("forgejo-user"),
          detail: Option.none(),
        },
      ],
    );
  }).pipe(Effect.provide(testLayer));
});
