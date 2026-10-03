import { assert, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ConfigProvider, DateTime, Effect, Layer, Option } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import * as ForgejoApi from "./ForgejoApi.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import type * as VcsDriver from "../vcs/VcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

/**
 * Test support for `ForgejoApi`: a layer over a fake HTTP client (each
 * request answered by `response`), a mocked git driver, and one `origin`
 * remote at `git@codeberg.test:pingdotgg/ryco.git`.
 */

export function requestJsonBody(request: HttpClientRequest.HttpClientRequest): unknown {
  const rawBody = (request.body as { readonly body?: Uint8Array }).body;
  assert.ok(rawBody);
  return JSON.parse(new TextDecoder().decode(rawBody));
}

export function makeForgejoApiTestLayer(input: {
  readonly response: (request: HttpClientRequest.HttpClientRequest) => Response;
  readonly env?: Record<string, string>;
  readonly git?: Partial<GitVcsDriver.GitVcsDriverShape>;
}) {
  const execute = vi.fn((request: HttpClientRequest.HttpClientRequest) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, input.response(request))),
  );
  const gitMock = {
    readConfigValue: vi.fn<GitVcsDriver.GitVcsDriverShape["readConfigValue"]>(() =>
      Effect.succeed<string | null>("git@codeberg.test:pingdotgg/ryco.git"),
    ),
    resolvePrimaryRemoteName: vi.fn<GitVcsDriver.GitVcsDriverShape["resolvePrimaryRemoteName"]>(
      () => Effect.succeed("origin"),
    ),
    ensureRemote: vi.fn<GitVcsDriver.GitVcsDriverShape["ensureRemote"]>(() =>
      Effect.succeed("alice"),
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
            url: "git@codeberg.test:pingdotgg/ryco.git",
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

  const layer = ForgejoApi.layer.pipe(
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
            RYCO_FORGEJO_BASE_URL: "https://codeberg.test",
            RYCO_FORGEJO_TOKEN: "token",
          },
        }),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

  return { execute, git: gitMock, layer };
}

/** A request's URL path below `/api/v1`, e.g. `/repos/pingdotgg/ryco/pulls/42`. */
export function apiPath(request: HttpClientRequest.HttpClientRequest): string {
  return new URL(request.url).pathname.replace(/^\/api\/v1/u, "");
}

export function urlParam(
  request: HttpClientRequest.HttpClientRequest,
  name: string,
): string | null {
  return request.urlParams.params.find(([key]) => key === name)?.[1] ?? null;
}

type Route = readonly [
  method: string,
  path: string | RegExp,
  respond: (request: HttpClientRequest.HttpClientRequest) => Response,
];

/** Answer requests by method and API path (exact string or pattern); anything else is a 404. */
export function forgejoRoutes(routes: ReadonlyArray<Route>) {
  return (request: HttpClientRequest.HttpClientRequest): Response => {
    const path = apiPath(request);
    for (const [method, pattern, respond] of routes) {
      if (method !== request.method) continue;
      if (typeof pattern === "string" ? pattern === path : pattern.test(path))
        return respond(request);
    }
    return Response.json({ message: "The target couldn't be found.", url: "" }, { status: 404 });
  };
}
