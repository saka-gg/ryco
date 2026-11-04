/**
 * The failure every Agent Control MCP tool answers with. A leaf module, so a tool set that loads
 * through `import()` (`projectCopyTools.ts`) can share it without a static import of the
 * boot-loaded tool modules, which would split those into extra boot chunks.
 *
 * @module agentControl/Mcp/toolFailure
 */
import { Effect } from "effect";

/** Bounded, presentation-safe tool failure. Never carries internals. */
export class ToolFailure {
  readonly _tag = "ToolFailure";
  readonly reason: string;
  constructor(reason: string) {
    this.reason = reason;
  }
}

export const failTool = (reason: string) => Effect.fail(new ToolFailure(reason));
