/**
 * The registry over client services from context, for tests that mock the
 * GitHub, GitLab, Bitbucket and Azure DevOps clients. Production uses
 * {@link SourceControlProviderRegistry.layer}, which loads them on first use.
 */
import { Effect, Layer } from "effect";

import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";
import * as BitbucketApi from "./BitbucketApi.ts";
import * as GitHubCli from "./GitHubCli.ts";
import * as GitLabCli from "./GitLabCli.ts";
import * as SourceControlProviderRegistry from "./SourceControlProviderRegistry.ts";

/** `onClientUse` reports each time the registry resolves a client. */
export const makeFromClientServices = (
  onClientUse: (client: keyof SourceControlProviderRegistry.SourceControlClients) => void = () =>
    undefined,
) =>
  Effect.gen(function* () {
    const github = yield* GitHubCli.GitHubCli;
    const gitlab = yield* GitLabCli.GitLabCli;
    const bitbucket = yield* BitbucketApi.BitbucketApi;
    const azureDevOps = yield* AzureDevOpsCli.AzureDevOpsCli;
    const use = <A>(client: keyof SourceControlProviderRegistry.SourceControlClients, value: A) =>
      Effect.sync(() => {
        onClientUse(client);
        return value;
      });
    return yield* SourceControlProviderRegistry.makeWithClients({
      github: use("github", github),
      gitlab: use("gitlab", gitlab),
      bitbucket: use("bitbucket", bitbucket),
      azureDevOps: use("azureDevOps", azureDevOps),
    });
  });

export const layerFromClientServices = Layer.effect(
  SourceControlProviderRegistry.SourceControlProviderRegistry,
  makeFromClientServices(),
);
