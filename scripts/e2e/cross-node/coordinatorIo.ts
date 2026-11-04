/**
 * The client copy coordinator's IO (`packages/client-runtime/src/projectCopy/io.ts`) over the
 * harness's paired RPC clients, so the E2E can run the coordinator the dialogs use against two
 * real nodes. Both nodes are direct connections that stay open for the whole run: acquiring one
 * retains nothing, and there is no mutation lease to lose.
 *
 * Calls go through `Effect.runPromise`, as the app's transport does, so a node's
 * `ProjectCopyError` reaches the coordinator with its `_tag` and `code`.
 */
import { randomUUID } from "node:crypto";

import {
  type EnvironmentId,
  ORCHESTRATION_WS_METHODS,
  PROJECT_COPY_WS_METHODS,
} from "@ryco/contracts";
import { Cause, Effect, Exit, Stream } from "effect";

import type { CliRemoteRpcClient } from "../../../apps/server/src/cliRemote/remotes.ts";
import {
  ProjectCopyNodeUnavailableError,
  type ProjectCopyIo,
  type ProjectCopyNodeApi,
} from "../../../packages/client-runtime/src/projectCopy/index.ts";

/** One node's project-copy API, the slice of `EnvironmentApi` the coordinator calls. */
export const projectCopyNodeApi = (client: CliRemoteRpcClient): ProjectCopyNodeApi => {
  const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
  return {
    projects: {
      pathHints: (input) => run(client[PROJECT_COPY_WS_METHODS.pathHints](input)),
      previewDestination: (input) => run(client[PROJECT_COPY_WS_METHODS.previewDestination](input)),
      checkRemoteAccess: (input) => run(client[PROJECT_COPY_WS_METHODS.checkRemoteAccess](input)),
      exportInspect: (input) => run(client[PROJECT_COPY_WS_METHODS.exportInspect](input)),
      exportStart: (input) => run(client[PROJECT_COPY_WS_METHODS.exportStart](input)),
      exportReadChunk: (input) => run(client[PROJECT_COPY_WS_METHODS.exportReadChunk](input)),
      exportDispose: (input) => run(client[PROJECT_COPY_WS_METHODS.exportDispose](input)),
      transferBegin: (input) => run(client[PROJECT_COPY_WS_METHODS.transferBegin](input)),
      transferAppend: (input) => run(client[PROJECT_COPY_WS_METHODS.transferAppend](input)),
      transferCommit: (input) => run(client[PROJECT_COPY_WS_METHODS.transferCommit](input)),
      transferAbort: (input) => run(client[PROJECT_COPY_WS_METHODS.transferAbort](input)),
      importStart: (input) => run(client[PROJECT_COPY_WS_METHODS.importStart](input)),
      subscribeImport: (input, listener, options) =>
        Effect.runCallback(
          Stream.runForEach(client[PROJECT_COPY_WS_METHODS.subscribeImport](input), (snapshot) =>
            Effect.sync(() => listener(snapshot)),
          ),
          {
            onExit: (exit) => {
              // A failed stream (an unknown import) ends the subscription, as on the app's
              // transport, which shows the failure to `classifyFailure` first; an unsubscribe
              // is not a failure.
              if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
                options?.classifyFailure?.(Cause.squash(exit.cause));
                options?.onError?.();
              }
            },
          },
        ),
      cancelImport: (input) => run(client[PROJECT_COPY_WS_METHODS.cancelImport](input)),
      listImports: (input) => run(client[PROJECT_COPY_WS_METHODS.listImports](input)),
      discardImport: (input) => run(client[PROJECT_COPY_WS_METHODS.discardImport](input)),
    },
    orchestration: {
      dispatchCommand: (command) => run(client[ORCHESTRATION_WS_METHODS.dispatchCommand](command)),
    },
  };
};

/** The paired connections stay open for the whole run: theirs is never lost. */
const OPEN_CONNECTION = new AbortController().signal;

/** The coordinator's IO for the paired nodes, by environment id. */
export const directProjectCopyIo = (
  nodes: ReadonlyMap<EnvironmentId, CliRemoteRpcClient>,
): ProjectCopyIo => {
  const apis = new Map([...nodes].map(([id, client]) => [id, projectCopyNodeApi(client)]));
  const apiOf = (environmentId: EnvironmentId) => {
    const api = apis.get(environmentId);
    if (api === undefined) {
      throw new ProjectCopyNodeUnavailableError(environmentId, `${environmentId} is not paired.`);
    }
    return api;
  };
  return {
    acquireNode: async ({ environmentId }) => {
      apiOf(environmentId);
      return { environmentId, transport: "direct", release: () => undefined };
    },
    withLease: async (environmentId, call) => call(apiOf(environmentId)),
    withNode: async (environmentId, call) => call(apiOf(environmentId), OPEN_CONNECTION),
    now: () => Date.now(),
    uuid: () => randomUUID(),
    sleep: (ms, signal) =>
      new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      }),
  };
};
