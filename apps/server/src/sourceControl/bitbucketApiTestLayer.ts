import * as NodeServices from "@effect/platform-node/NodeServices";
import { vi } from "@effect/vitest";
import { ConfigProvider, DateTime, Effect, Layer, Option } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import * as BitbucketApi from "./BitbucketApi.ts";
import { ServerSecretStore } from "../auth/Services/ServerSecretStore.ts";
import { AtlassianConnectionRepository } from "../persistence/Services/AtlassianConnections.ts";
import type { AtlassianConnectionRecord } from "../persistence/Services/AtlassianConnections.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import type * as VcsDriver from "../vcs/VcsDriver.ts";

/**
 * `BitbucketApi.layer` over a mocked HTTP client (`response` answers every
 * request), git driver, saved connections and secrets. The repository remote
 * is `git@bitbucket.org:pingdotgg/ryco.git` unless `remoteUrl` says otherwise.
 */
export function makeLayer(input: {
  readonly response: (request: HttpClientRequest.HttpClientRequest) => Response;
  readonly env?: Readonly<Record<string, string>>;
  readonly atlassianConnections?: ReadonlyArray<AtlassianConnectionRecord>;
  readonly secrets?: ReadonlyMap<string, Uint8Array>;
  readonly git?: Partial<GitVcsDriver.GitVcsDriverShape>;
  readonly remoteUrl?: string;
}) {
  const execute = vi.fn((request: HttpClientRequest.HttpClientRequest) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, input.response(request))),
  );
  const gitMock = {
    readConfigValue: vi.fn<GitVcsDriver.GitVcsDriverShape["readConfigValue"]>(() =>
      Effect.succeed<string | null>("git@bitbucket.org:pingdotgg/ryco.git"),
    ),
    resolvePrimaryRemoteName: vi.fn<GitVcsDriver.GitVcsDriverShape["resolvePrimaryRemoteName"]>(
      () => Effect.succeed("origin"),
    ),
    ensureRemote: vi.fn<GitVcsDriver.GitVcsDriverShape["ensureRemote"]>(() =>
      Effect.succeed("octocat"),
    ),
    fetchRemoteBranch: vi.fn<GitVcsDriver.GitVcsDriverShape["fetchRemoteBranch"]>(
      () => Effect.void,
    ),
    fetchRemoteTrackingBranch: vi.fn<GitVcsDriver.GitVcsDriverShape["fetchRemoteTrackingBranch"]>(
      () => Effect.void,
    ),
    setBranchUpstream: vi.fn<GitVcsDriver.GitVcsDriverShape["setBranchUpstream"]>(
      () => Effect.void,
    ),
    switchRef: vi.fn<GitVcsDriver.GitVcsDriverShape["switchRef"]>((request) =>
      Effect.succeed({ refName: request.refName }),
    ),
    listLocalBranchNames: vi.fn<GitVcsDriver.GitVcsDriverShape["listLocalBranchNames"]>(() =>
      Effect.succeed([]),
    ),
  };
  const git = {
    ...gitMock,
    ...input.git,
  } satisfies Partial<GitVcsDriver.GitVcsDriverShape>;

  const driver = {
    listRemotes: () =>
      Effect.succeed({
        remotes: [
          {
            name: "origin",
            url: input.remoteUrl ?? "git@bitbucket.org:pingdotgg/ryco.git",
            pushUrl: Option.none(),
            isPrimary: true,
          },
        ],
        freshness: {
          source: "live-local" as const,
          observedAt: DateTime.makeUnsafe("1970-01-01T00:00:00.000Z"),
          expiresAt: Option.none(),
        },
      }),
  } satisfies Partial<VcsDriver.VcsDriverShape>;

  const layer = BitbucketApi.layer.pipe(
    Layer.provide(
      Layer.mock(AtlassianConnectionRepository)({
        list: (query = {}) =>
          Effect.succeed(
            (input.atlassianConnections ?? []).filter(
              (connection) => query.status === undefined || connection.status === query.status,
            ),
          ),
        getById: ({ connectionId }) =>
          Effect.sync(() => {
            const found = input.atlassianConnections?.find(
              (connection) => connection.connectionId === connectionId,
            );
            return found ? Option.some(found) : Option.none();
          }),
        upsert: () => Effect.void,
        disconnect: () => Effect.succeed(false),
        deleteById: () => Effect.void,
      }),
    ),
    Layer.provide(
      Layer.mock(ServerSecretStore)({
        get: (name) => Effect.succeed(input.secrets?.get(name) ?? null),
        set: () => Effect.void,
        getOrCreateRandom: (_name, bytes) => Effect.succeed(new Uint8Array(bytes)),
        remove: () => Effect.void,
      }),
    ),
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => execute(request)),
      ),
    ),
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        resolve: () =>
          Effect.succeed({
            kind: "git",
            repository: {
              kind: "git",
              rootPath: "/repo",
              metadataPath: null,
              freshness: {
                source: "live-local" as const,
                observedAt: DateTime.makeUnsafe("1970-01-01T00:00:00.000Z"),
                expiresAt: Option.none(),
              },
            },
            driver: driver as unknown as VcsDriver.VcsDriverShape,
          }),
      }),
    ),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)(git)),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({
          env: input.env ?? {
            RYCO_BITBUCKET_API_BASE_URL: "https://api.test.local/2.0",
            RYCO_BITBUCKET_EMAIL: "user@example.com",
            RYCO_BITBUCKET_API_TOKEN: "token",
          },
        }),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

  return { execute, git: gitMock, layer };
}
