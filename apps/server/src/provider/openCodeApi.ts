/**
 * The OpenCode server surface Ryco calls, independent of the server's API generation.
 *
 * Types only (erased at build time), so it adds nothing to the boot chunk.
 */
import type { OpencodeClient } from "@opencode-ai/sdk/v2";

/**
 * The 1.x SDK client satisfies it structurally; a 2.x facade implements it and keeps the 1.x
 * `{ data }` envelopes and event shapes. A client speaks one API generation for its whole lifetime
 * (`createOpenCodeSdkClient` detects it before creating one), and a failed request is never
 * retried on the other API.
 */
export interface OpenCodeApi {
  /** Present only on a 2.x facade; a 1.x SDK client leaves it unset. */
  readonly generation?: "v2";
  readonly global: Pick<OpencodeClient["global"], "health">;
  readonly provider: Pick<OpencodeClient["provider"], "list">;
  readonly app: Pick<OpencodeClient["app"], "agents">;
  readonly session: Pick<
    OpencodeClient["session"],
    | "create"
    | "get"
    | "update"
    | "children"
    | "messages"
    | "promptAsync"
    | "prompt"
    | "abort"
    | "fork"
    | "command"
  >;
  readonly command: Pick<OpencodeClient["command"], "list">;
  readonly permission: Pick<OpencodeClient["permission"], "list" | "respond">;
  readonly question: Pick<OpencodeClient["question"], "list" | "reply">;
  readonly event: Pick<OpencodeClient["event"], "subscribe">;
  readonly mcp: Pick<OpencodeClient["mcp"], "add">;
}
