import { expect, it } from "vite-plus/test";
import { preserveAgentMessageExtensions } from "./agentMessageExtensions.ts";

it("retains only native message extension fields without changing blocking requests", () => {
  const decoded = { item: { type: "agentMessage", id: "i", text: "Question" } };
  const raw = {
    item: {
      ...decoded.item,
      delivery: "async",
      questions: [{ title: "Q?", options: null }],
      untrusted: "discard",
    },
  };
  expect(preserveAgentMessageExtensions("item/completed", raw, decoded)).toEqual({
    item: { ...decoded.item, delivery: "async", questions: raw.item.questions },
  });
  expect(preserveAgentMessageExtensions("item/tool/requestUserInput", raw, decoded)).toBe(decoded);
  expect(preserveAgentMessageExtensions("item/completed", decoded, decoded)).toEqual(decoded);
});
