import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { TerminalOpenInput, TerminalSubscribeEventsInput } from "./terminal.ts";

/** The input schemas as released nodes still decode them. */
const ReleasedSubscribeInput = Schema.Struct({
  replay: Schema.optional(Schema.Literal("metadata")),
});
const ReleasedOpenInput = TerminalOpenInput.mapFields(
  ({ attachOutput: _attach, ...fields }) => fields,
);

describe("scoped terminal output across node versions", () => {
  it("a released node decodes a scoped subscription as an ordinary one", () => {
    const sent = Schema.encodeSync(TerminalSubscribeEventsInput)({
      replay: "metadata",
      output: { attached: [{ threadId: "thread", terminalId: "default" }] },
    });
    expect(Schema.decodeUnknownSync(ReleasedSubscribeInput)(sent)).toEqual({ replay: "metadata" });
  });

  it("a released node opens a terminal asked to attach its output like any other", () => {
    const decoded = Schema.decodeUnknownSync(ReleasedOpenInput)({
      threadId: "thread",
      terminalId: "default",
      cwd: "/repo",
      attachOutput: true,
    });
    expect(decoded).not.toHaveProperty("attachOutput");
    expect(decoded.cwd).toBe("/repo");
  });

  it("a current node reads both fields, and older clients that omit them", () => {
    expect(Schema.decodeUnknownSync(TerminalSubscribeEventsInput)({})).toEqual({});
    expect(
      Schema.decodeUnknownSync(TerminalOpenInput)({ threadId: "t", cwd: "/r", attachOutput: true })
        .attachOutput,
    ).toBe(true);
  });
});
