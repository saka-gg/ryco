/**
 * Agent Control tools whose module loads on first use instead of with the
 * server.
 *
 * The tool names answer `hasTool` and `isWriteTool` right away, so the
 * listener can bind a call to its turn before anything loads. The module
 * loads the first time a session `mayUse` accepts lists tools, or anyone
 * calls one of the names, and once only. A module that fails to load leaves
 * the base catalogue as it was (its tools stay hidden and unknown) instead
 * of failing the listener.
 *
 * @module agentControl/Mcp/lazyTools
 */
import { Effect } from "effect";

import type { AgentControlSessionRecord } from "../Services/AgentControlSessionRegistry.ts";
import type { AgentControlMcpTools } from "./tools.ts";

export interface LazyAgentControlTools {
  /** Every tool the module adds. */
  readonly names: ReadonlyArray<string>;
  /** The ones bound to the caller's turn and aborted with it. */
  readonly writeNames: ReadonlyArray<string>;
  /** Sessions that could ever see the tools; others never load the module. */
  readonly mayUse: (session: AgentControlSessionRecord) => boolean;
  /** Imports the module and wraps `base` with it. */
  readonly load: () => Promise<AgentControlMcpTools>;
}

export const withLazyAgentControlTools = (
  base: AgentControlMcpTools,
  lazy: LazyAgentControlTools,
): AgentControlMcpTools => {
  let loading: Promise<{ readonly tools: AgentControlMcpTools; readonly cause?: unknown }> | null =
    null;
  let reported = false;
  // A promise rather than a cached effect: a caller that goes away mid-load
  // must not leave an interrupted load behind for everyone after it.
  const loaded = Effect.promise(() => {
    loading ??= lazy.load().then(
      (tools) => ({ tools }),
      (cause: unknown) => ({ tools: base, cause }),
    );
    return loading;
  }).pipe(
    Effect.tap((result) => {
      if (result.cause === undefined || reported) return Effect.void;
      reported = true;
      return Effect.logWarning("Agent Control tools failed to load", {
        tools: lazy.names,
        cause: result.cause,
      });
    }),
    Effect.map((result) => result.tools),
  );
  const owns = (name: string) => lazy.names.includes(name);

  return {
    ...base,
    descriptorsFor: (session) =>
      lazy.mayUse(session)
        ? Effect.flatMap(loaded, (tools) => tools.descriptorsFor(session))
        : base.descriptorsFor(session),
    hasTool: (name) => owns(name) || base.hasTool(name),
    isWriteTool: (name) => lazy.writeNames.includes(name) || base.isWriteTool(name),
    callTool: (session, name, args) =>
      owns(name)
        ? Effect.flatMap(loaded, (tools) => tools.callTool(session, name, args))
        : base.callTool(session, name, args),
  };
};
