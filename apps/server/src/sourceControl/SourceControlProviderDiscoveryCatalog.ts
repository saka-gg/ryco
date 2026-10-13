import type * as BitbucketApi from "./BitbucketApi.ts";
import type * as ForgejoApi from "./ForgejoApi.ts";
import { findAuthenticatedGitHubAccount, parseGitHubAuthStatus } from "./gitHubAuthStatus.ts";
import { findAuthenticatedGitLabHost, parseGitLabAuthStatusHosts } from "./gitLabAuthStatus.ts";
import * as SourceControlProviderDiscovery from "./SourceControlProviderDiscovery.ts";

function parseGitHubAuth(input: SourceControlProviderDiscovery.SourceControlAuthProbeInput) {
  const output = SourceControlProviderDiscovery.combinedAuthOutput(input);
  const authStatus = parseGitHubAuthStatus(input.stdout);
  const authenticatedAccount = findAuthenticatedGitHubAccount(authStatus.accounts);
  const fallbackHost = SourceControlProviderDiscovery.parseCliHost(output);

  if (authenticatedAccount) {
    return SourceControlProviderDiscovery.providerAuth({
      status: "authenticated",
      account: authenticatedAccount.account,
      host: authenticatedAccount.host,
    });
  }

  if (authStatus.parsed) {
    const failedAccount =
      authStatus.accounts.find((account) => account.active) ?? authStatus.accounts[0];
    return SourceControlProviderDiscovery.providerAuth({
      status: "unauthenticated",
      host: failedAccount?.host,
      detail:
        failedAccount?.error ??
        "Run `gh auth login` to authenticate GitHub CLI with an active account.",
    });
  }

  if (input.exitCode !== 0) {
    return SourceControlProviderDiscovery.providerAuth({
      status: "unauthenticated",
      host: fallbackHost,
      detail:
        SourceControlProviderDiscovery.firstSafeAuthLine(output) ??
        "Run `gh auth login` to authenticate GitHub CLI.",
    });
  }

  const account = SourceControlProviderDiscovery.matchFirst(output, [
    /Logged in to .* account\s+([^\s(]+)/iu,
    /Logged in to .* as\s+([^\s(]+)/iu,
  ]);
  if (account) {
    return SourceControlProviderDiscovery.providerAuth({
      status: "authenticated",
      account,
      host: fallbackHost,
    });
  }

  return SourceControlProviderDiscovery.providerAuth({
    status: "unknown",
    host: fallbackHost,
    detail:
      SourceControlProviderDiscovery.firstSafeAuthLine(output) ??
      "GitHub CLI auth status could not be parsed.",
  });
}

function parseGitLabAuth(input: SourceControlProviderDiscovery.SourceControlAuthProbeInput) {
  const output = SourceControlProviderDiscovery.combinedAuthOutput(input);
  const authenticatedHost = findAuthenticatedGitLabHost(parseGitLabAuthStatusHosts(output));
  const account =
    authenticatedHost?.account ??
    SourceControlProviderDiscovery.matchFirst(output, [
      /Logged in to .* as\s+([^\s(]+)/iu,
      /Logged in to .* account\s+([^\s(]+)/iu,
      /account:\s*([^\s(]+)/iu,
    ]);
  const host = authenticatedHost?.host ?? SourceControlProviderDiscovery.parseCliHost(output);

  if (account) {
    return SourceControlProviderDiscovery.providerAuth({ status: "authenticated", account, host });
  }

  if (input.exitCode !== 0) {
    return SourceControlProviderDiscovery.providerAuth({
      status: "unauthenticated",
      host,
      detail:
        SourceControlProviderDiscovery.firstSafeAuthLine(output) ??
        "Run `glab auth login` to authenticate GitLab CLI.",
    });
  }

  return SourceControlProviderDiscovery.providerAuth({
    status: "unknown",
    host,
    detail:
      SourceControlProviderDiscovery.firstSafeAuthLine(output) ??
      "GitLab CLI auth status could not be parsed.",
  });
}

function normalizeAuthHost(value: string | undefined): string | null {
  const trimmed = value?.trim().toLowerCase() ?? "";
  if (trimmed.length === 0) {
    return null;
  }

  try {
    return new URL(trimmed).host.toLowerCase();
  } catch {
    return trimmed.replace(/^https?:\/\//iu, "").replace(/\/.*$/u, "");
  }
}

function gitLabProviderForHost(host: string) {
  return {
    kind: "gitlab" as const,
    name: host === "gitlab.com" ? "GitLab" : "GitLab Self-Hosted",
    baseUrl: `https://${host}`,
  };
}

function refineUnknownGitLabRemote(
  input: SourceControlProviderDiscovery.SourceControlUnknownRemoteRefinementInput,
) {
  const remoteHost =
    normalizeAuthHost(input.context.provider.baseUrl) ??
    normalizeAuthHost(input.context.provider.name);
  if (remoteHost === null) {
    return null;
  }

  const authenticatedHost = parseGitLabAuthStatusHosts(
    SourceControlProviderDiscovery.combinedAuthOutput(input.auth),
  ).find((host) => host.authenticated && host.host === remoteHost);

  return authenticatedHost ? gitLabProviderForHost(authenticatedHost.host) : null;
}

function parseAzureAuth(input: SourceControlProviderDiscovery.SourceControlAuthProbeInput) {
  const account = input.stdout.trim().split(/\r?\n/)[0]?.trim();

  if (input.exitCode !== 0) {
    return SourceControlProviderDiscovery.providerAuth({
      status: "unauthenticated",
      detail:
        SourceControlProviderDiscovery.firstSafeAuthLine(
          SourceControlProviderDiscovery.combinedAuthOutput(input),
        ) ?? "Run `az login` to authenticate Azure CLI.",
    });
  }

  if (account && account.length > 0) {
    return SourceControlProviderDiscovery.providerAuth({
      status: "authenticated",
      account,
      host: "dev.azure.com",
    });
  }

  return SourceControlProviderDiscovery.providerAuth({
    status: "unknown",
    host: "dev.azure.com",
    detail: "Azure CLI account status could not be parsed.",
  });
}

export const githubDiscovery = {
  type: "cli",
  kind: "github",
  label: "GitHub",
  executable: "gh",
  versionArgs: ["--version"],
  authArgs: ["auth", "status", "--json", "hosts"],
  parseAuth: parseGitHubAuth,
  installHint:
    "Install the GitHub command-line tool (`gh`) via https://cli.github.com/ or your package manager (for example `brew install gh`).",
} satisfies SourceControlProviderDiscovery.SourceControlCliDiscoverySpec;

export const gitlabDiscovery = {
  type: "cli",
  kind: "gitlab",
  label: "GitLab",
  executable: "glab",
  versionArgs: ["--version"],
  authArgs: ["auth", "status"],
  parseAuth: parseGitLabAuth,
  refineUnknownRemote: refineUnknownGitLabRemote,
  installHint:
    "Install the GitLab command-line tool (`glab`) from https://gitlab.com/gitlab-org/cli or your package manager (for example `brew install glab`).",
} satisfies SourceControlProviderDiscovery.SourceControlCliDiscoverySpec;

export const azureDevOpsDiscovery = {
  type: "cli",
  kind: "azure-devops",
  label: "Azure DevOps",
  executable: "az",
  versionArgs: ["--version"],
  authArgs: ["account", "show", "--query", "user.name", "-o", "tsv"],
  parseAuth: parseAzureAuth,
  installHint:
    "Install the Azure command-line tools (`az`), then enable Azure DevOps support with `az extension add --name azure-devops`.",
} satisfies SourceControlProviderDiscovery.SourceControlCliDiscoverySpec;

export function makeBitbucketDiscovery(
  bitbucket: Pick<BitbucketApi.BitbucketApiShape, "probeAuth">,
): SourceControlProviderDiscovery.SourceControlApiDiscoverySpec {
  return {
    type: "api",
    kind: "bitbucket",
    label: "Bitbucket",
    installHint:
      "Save a Bitbucket app password in Settings -> Source Control -> Atlassian, or set RYCO_BITBUCKET_EMAIL and RYCO_BITBUCKET_API_TOKEN on the server.",
    probeAuth: bitbucket.probeAuth,
  };
}

export function makeForgejoDiscovery(
  forgejo: Pick<ForgejoApi.ForgejoApiShape, "probeAuth">,
): SourceControlProviderDiscovery.SourceControlApiDiscoverySpec {
  return {
    type: "api",
    kind: "forgejo",
    label: "Forgejo",
    installHint:
      "Authenticate with `fj auth login` on the server and verify with `fj -H codeberg.org whoami`, or set RYCO_FORGEJO_BASE_URL and RYCO_FORGEJO_TOKEN. For unusual fj installs, point Ryco at the token file with RYCO_FORGEJO_CLI_KEYS_FILE.",
    probeAuth: forgejo.probeAuth,
  };
}
