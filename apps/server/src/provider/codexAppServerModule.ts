/**
 * codexAppServerModule - Loads the Codex app-server client on first use.
 *
 * The client pulls in the generated Codex protocol schema (about 1 MiB of
 * Schema definitions evaluated at import). Features outside the Codex driver
 * (session import, MCP settings) load it here when they first talk to `codex
 * app-server`, so it stays off the server's boot path. The module system
 * caches the import after the first call.
 *
 * @module codexAppServerModule
 */
import { Data, Effect } from "effect";

export class CodexAppServerModuleLoadError extends Data.TaggedError(
  "CodexAppServerModuleLoadError",
)<{
  readonly message: string;
  readonly cause: unknown;
}> {}

export const loadCodexAppServerModule = Effect.tryPromise({
  try: async () => {
    const [client, provider] = await Promise.all([
      import("effect-codex-app-server/client"),
      import("./Layers/CodexProvider.ts"),
    ]);
    return {
      CodexClient: client,
      buildCodexInitializeParams: provider.buildCodexInitializeParams,
    };
  },
  catch: (cause) =>
    new CodexAppServerModuleLoadError({
      message: "The Codex app-server client could not be loaded.",
      cause,
    }),
});
