import { Effect, Layer } from "effect";

import { NON_INTERACTIVE_GIT_ENV } from "../../vcs/GitVcsDriver.ts";
import { GitNetworkError } from "../Errors.ts";
import { GitNetwork } from "../Services/GitNetwork.ts";
import { NOT_AVAILABLE_YET, notAvailableYet } from "./notAvailableYet.ts";

const networkFailure = (operation: string) =>
  Effect.fail(
    new GitNetworkError({
      operation,
      reason: "internal",
      detail: NOT_AVAILABLE_YET,
      host: null,
      exitCode: null,
    }),
  );

/**
 * Stands in for the live network git service: effects fail "not available yet", and the
 * synchronous URL helpers throw the same error.
 */
export const GitNetworkPlaceholder = Layer.succeed(
  GitNetwork,
  GitNetwork.of({
    env: NON_INTERACTIVE_GIT_ENV,
    runGitNetworkCommand: (input) => networkFailure(input.operation),
    lsRemote: () => networkFailure("GitNetwork.lsRemote"),
    checkRemoteAccess: () => Effect.fail(notAvailableYet()),
    alternateRemoteUrl: () => {
      throw notAvailableYet();
    },
    sanitizeRemoteUrl: () => {
      throw notAvailableYet();
    },
    classifyRemoteUrl: () => {
      throw notAvailableYet();
    },
  }),
);
