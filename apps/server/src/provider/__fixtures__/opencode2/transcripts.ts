/**
 * Real OpenCode 2.0.18 sessions recorded at the HTTP and SSE boundary, copied from t3code
 * (`apps/server/src/orchestration-v2/testkit/fixtures/opencode2_<name>/opencode_transcript.ndjson`
 * at commit 91992bd5d464, MIT; see THIRD_PARTY_NOTICES.md). Paths are placeholders (`<work>`,
 * `<home>`), and the only key in them is OpenCode Zen's public one.
 *
 * Each line is one frame: `transcript_start` (with the recorded `version`), an `expect_outbound`
 * request the client sent, an `emit_inbound` server response (`sdk.response`, by operation) or
 * event (`sdk.event`), and `runtime_exit`.
 */
import { readFileSync } from "node:fs";

import type { OpenCodeEvent } from "@opencode/client";

export const OPENCODE2_TRANSCRIPTS = [
  "simple",
  "tool_call",
  "permission",
  "question",
  "subagent",
  "interrupt",
  "background",
] as const;

export type OpenCode2TranscriptName = (typeof OPENCODE2_TRANSCRIPTS)[number];

export type OpenCode2Frame =
  | {
      readonly type: "transcript_start";
      readonly version: string;
      readonly scenario: string;
      readonly metadata: Readonly<Record<string, unknown>>;
    }
  | {
      readonly type: "expect_outbound";
      readonly label: string;
      readonly frame: { readonly type: string; readonly input?: unknown };
    }
  | {
      readonly type: "emit_inbound";
      readonly label: string;
      readonly frame:
        | { readonly type: "sdk.response"; readonly operation: string; readonly data: unknown }
        | { readonly type: "sdk.event"; readonly event: OpenCodeEvent };
    }
  | { readonly type: "runtime_exit" };

export interface OpenCode2Transcript {
  /** The OpenCode version the session was recorded against. */
  readonly version: string;
  readonly frames: ReadonlyArray<OpenCode2Frame>;
  /** The server's events, in order. */
  readonly events: ReadonlyArray<OpenCodeEvent>;
  /** The server's responses to one operation (`model.list`, `agent.list`, ...), in order. */
  readonly responses: (operation: string) => ReadonlyArray<unknown>;
}

export function readOpenCode2Transcript(name: OpenCode2TranscriptName): OpenCode2Transcript {
  const frames = readFileSync(new URL(`./${name}.ndjson`, import.meta.url), "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as OpenCode2Frame);
  const start = frames[0];
  if (start?.type !== "transcript_start") throw new Error(`${name}: no transcript_start frame`);
  const inbound = frames.flatMap((frame) => (frame.type === "emit_inbound" ? [frame.frame] : []));
  return {
    version: start.version,
    frames,
    events: inbound.flatMap((frame) => (frame.type === "sdk.event" ? [frame.event] : [])),
    responses: (operation) =>
      inbound.flatMap((frame) =>
        frame.type === "sdk.response" && frame.operation === operation ? [frame.data] : [],
      ),
  };
}
