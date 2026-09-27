export const id = "11111111-1111-4111-8111-111111111111";
const lines = (...rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join("\n");
export const codexFixture = () =>
  lines(
    { type: "session_meta", payload: { id, cwd: "C:\\old\\project" } },
    {
      type: "response_item",
      timestamp: "2026-01-01T00:00:00Z",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Please explain this fixture." }],
      },
    },
    {
      type: "response_item",
      payload: {
        type: "reasoning",
        encrypted_content: "never visible",
        summary: [{ text: "private" }],
      },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        channel: "analysis",
        content: [{ type: "output_text", text: "hidden analysis" }],
      },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        channel: "commentary",
        content: [{ type: "output_text", text: "internal commentary" }],
      },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        channel: "future-private",
        content: [{ type: "output_text", text: "unknown channel" }],
      },
    },
    { type: "response_item", payload: { type: "function_call_output", output: "tool secret" } },
    {
      type: "response_item",
      timestamp: "2026-01-01T00:01:00Z",
      payload: {
        type: "message",
        role: "assistant",
        channel: "final",
        content: [
          { type: "output_text", text: "A safe answer." },
          { type: "image", data: "binary" },
        ],
      },
    },
  );
export const claudeFixture = () =>
  lines(
    {
      type: "user",
      sessionId: id,
      cwd: "/moved/project",
      uuid: "user",
      parentUuid: null,
      timestamp: "2026-01-01T00:00:00Z",
      message: { content: "Question" },
    },
    { type: "progress", uuid: "progress", parentUuid: "user", data: { secret: "not displayable" } },
    {
      type: "assistant",
      uuid: "branch",
      parentUuid: "progress",
      message: { content: "Abandoned branch", stop_reason: "end_turn" },
    },
    {
      type: "system",
      subtype: "compact_boundary",
      uuid: "compact",
      parentUuid: "progress",
      content: "Internal summary",
    },
    {
      type: "assistant",
      uuid: "answer",
      parentUuid: "compact",
      timestamp: "2026-01-01T00:01:00Z",
      message: {
        content: [
          { type: "thinking", thinking: "private reasoning" },
          { type: "text", text: "Visible answer" },
        ],
        stop_reason: "end_turn",
      },
    },
  );
