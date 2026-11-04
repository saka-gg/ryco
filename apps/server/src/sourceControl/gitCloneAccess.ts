/**
 * gitCloneAccess - what every git command that clones from or reads a remote shares: which URLs
 * the server accepts, and how a source-control provider's clone credentials reach git (a scoped
 * askpass script, never the URL or the command line).
 *
 * Used by `sourceControl.cloneRepository` and by the cross-node project copy's network git.
 *
 * @module gitCloneAccess
 */
import { isScpStyleGitUrl } from "@ryco/shared/gitRemoteUrl";
import { Effect, FileSystem, Path, Result } from "effect";
import type { PlatformError, Scope } from "effect";

import type * as SourceControlProvider from "./SourceControlProvider.ts";
import type { SourceControlProviderRegistryShape } from "./SourceControlProviderRegistry.ts";

export const CLONE_REMOTE_URL_EMPTY_DETAIL = "Enter a valid repository URL before cloning.";
export const CLONE_REMOTE_URL_SYNTAX_DETAIL =
  "Clone URL must use https://, ssh://, or git@host:owner/repo.git syntax.";

/**
 * The trimmed URL when the server clones from it (https, ssh or scp-style); otherwise the reason,
 * worded for the user. A leading `-` is refused so the URL can never act as a git option.
 */
export function validateCloneRemoteUrl(remoteUrl: string): Result.Result<string, string> {
  const trimmed = remoteUrl.trim();
  if (trimmed.length === 0 || trimmed.startsWith("-")) {
    return Result.fail(CLONE_REMOTE_URL_EMPTY_DETAIL);
  }
  if (isScpStyleGitUrl(trimmed)) return Result.succeed(trimmed);
  try {
    const url = new URL(trimmed);
    if (url.protocol === "https:" || url.protocol === "ssh:") return Result.succeed(trimmed);
  } catch {
    // Fall through to the syntax error below.
  }
  return Result.fail(CLONE_REMOTE_URL_SYNTAX_DETAIL);
}

export function isHttpsCloneUrl(remoteUrl: string): boolean {
  try {
    return new URL(remoteUrl).protocol === "https:";
  } catch {
    return false;
  }
}

/** The URL without user name and password (it does not parse: unchanged). */
export function removeUrlCredentials(remoteUrl: string): string {
  try {
    const url = new URL(remoteUrl);
    url.username = "";
    url.password = "";
    return url.toString();
  } catch {
    return remoteUrl;
  }
}

export interface CloneCredentials {
  /** The provider given, or the one detected from an https URL when none was. */
  readonly provider: SourceControlProvider.SourceControlProviderShape | null;
  /** The provider's clone credentials for an https URL, else null. */
  readonly authentication: SourceControlProvider.SourceControlCloneAuthentication | null;
  /** The URL git uses: without user info whenever the credentials go through the askpass. */
  readonly remoteUrl: string;
}

/**
 * The clone credentials for a validated remote URL. An https URL without a given provider picks
 * the provider detected from it; only https URLs ever get credentials (ssh authenticates through
 * the user's own ssh setup).
 */
export const resolveCloneCredentials = Effect.fn("resolveCloneCredentials")(function* (input: {
  readonly registry: Pick<
    SourceControlProviderRegistryShape,
    "get" | "detectProviderFromRemoteUrl"
  >;
  readonly remoteUrl: string;
  readonly provider: SourceControlProvider.SourceControlProviderShape | null;
}) {
  const https = isHttpsCloneUrl(input.remoteUrl);
  let provider = input.provider;
  if (!provider && https) {
    const detected = input.registry.detectProviderFromRemoteUrl(input.remoteUrl);
    if (detected?.kind && detected.kind !== "unknown") {
      provider = yield* input.registry.get(detected.kind);
    }
  }
  const authentication: SourceControlProvider.SourceControlCloneAuthentication | null =
    provider?.cloneAuthentication && https
      ? yield* provider.cloneAuthentication({ remoteUrl: input.remoteUrl })
      : null;
  const credentials: CloneCredentials = {
    provider,
    authentication,
    remoteUrl: authentication ? removeUrlCredentials(input.remoteUrl) : input.remoteUrl,
  };
  return credentials;
});

const GIT_ASKPASS_SCRIPT = `#!/bin/sh
case "$1" in
  *Username*|*username*) printf '%s\\n' "$RYCO_GIT_USERNAME" ;;
  *) printf '%s\\n' "$RYCO_GIT_PASSWORD" ;;
esac
`;

/**
 * Runs `use` with the environment that hands `authentication` to git: a private askpass script
 * in a temporary directory that lives only as long as `use`, and the credentials in variables
 * that script reads. Without credentials `use` gets `undefined` and nothing is written.
 */
export const withCloneAskpass = <A, E, R>(
  authentication: SourceControlProvider.SourceControlCloneAuthentication | null,
  use: (env: Readonly<Record<string, string>> | undefined) => Effect.Effect<A, E, R>,
): Effect.Effect<
  A,
  E | PlatformError.PlatformError,
  Exclude<R, Scope.Scope> | FileSystem.FileSystem | Path.Path
> => {
  if (authentication === null) return Effect.scoped(use(undefined));
  return Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const askpassDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "ryco-git-askpass-",
      });
      const askpassPath = path.join(askpassDir, "askpass.sh");
      yield* fileSystem.writeFileString(askpassPath, GIT_ASKPASS_SCRIPT);
      yield* fileSystem.chmod(askpassPath, 0o700);
      return yield* use({
        GIT_ASKPASS: askpassPath,
        GIT_TERMINAL_PROMPT: "0",
        RYCO_GIT_USERNAME: authentication.username,
        RYCO_GIT_PASSWORD: authentication.password,
      });
    }),
  );
};
