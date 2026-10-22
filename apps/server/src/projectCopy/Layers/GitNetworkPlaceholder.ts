import { Effect, Layer } from "effect";

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
    env: Object.freeze({
      LC_ALL: "C",
      LANG: "C",
      GIT_TERMINAL_PROMPT: "0",
      SSH_ASKPASS_REQUIRE: "never",
      GCM_INTERACTIVE: "never",
    }),
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
