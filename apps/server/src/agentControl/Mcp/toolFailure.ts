/**
 * The failure every Agent Control MCP tool answers with, and the argument decoder that fails with
 * it. A leaf module, so a tool set that loads through `import()` (`projectCopyTools.ts`) can share
 * it without a static import of the boot-loaded tool modules, which would split those into extra
 * boot chunks.
 *
 * @module agentControl/Mcp/toolFailure
 */
import { Effect, Schema } from "effect";

/** Bounded, presentation-safe tool failure. Never carries internals. */
export class ToolFailure {
  readonly _tag = "ToolFailure";
  readonly reason: string;
  constructor(reason: string) {
    this.reason = reason;
  }
}

export const failTool = (reason: string) => Effect.fail(new ToolFailure(reason));

export const INVALID_TOOL_ARGUMENTS = "Invalid tool arguments.";

/**
 * Decodes a tool's arguments (absent arguments decode as `{}`). Any mismatch answers with the
 * same bounded text, so no schema detail reaches the agent.
 */
export const decodeToolArgs = <S extends Schema.Top>(schema: S, args: unknown) =>
  Schema.decodeUnknownEffect(schema)(args ?? {}).pipe(
    Effect.mapError(() => new ToolFailure(INVALID_TOOL_ARGUMENTS)),
  ) as Effect.Effect<S["Type"], ToolFailure>;
