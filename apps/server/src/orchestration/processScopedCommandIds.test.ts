import { CommandId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isProcessScopedCommandId, makeProcessScopedReceipts } from "./processScopedCommandIds.ts";

describe("isProcessScopedCommandId", () => {
  it("matches ids minted per emission only", () => {
    expect(isProcessScopedCommandId("provider:0f8fad5b-d9cb-469f-a165-70867728950e:x")).toBe(true);
    expect(isProcessScopedCommandId("history:0f8fad5b-d9cb-469f-a165-70867728950e")).toBe(true);
    expect(isProcessScopedCommandId("history:0f8fad5b-d9cb-469f-a165-70867728950e:x")).toBe(false);
    expect(isProcessScopedCommandId("provider:not-a-uuid:x")).toBe(false);
    expect(isProcessScopedCommandId("goal-pause:thread:key")).toBe(false);
  });
});

describe("makeProcessScopedReceipts", () => {
  it("keeps the most recent outcomes up to its capacity", () => {
    const receipts = makeProcessScopedReceipts(2);
    const a = CommandId.make("a");
    const b = CommandId.make("b");
    const c = CommandId.make("c");
    receipts.record(a, { status: "accepted", resultSequence: 1 });
    receipts.record(b, { status: "rejected", error: "no" });
    expect(receipts.get(a)).toEqual({ status: "accepted", resultSequence: 1 });
    receipts.record(c, { status: "accepted", resultSequence: 3 });
    expect(receipts.get(a)).toBeUndefined();
    expect(receipts.get(b)).toEqual({ status: "rejected", error: "no" });
    expect(receipts.get(c)).toEqual({ status: "accepted", resultSequence: 3 });
  });
});
