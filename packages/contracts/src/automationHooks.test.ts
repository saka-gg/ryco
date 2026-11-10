import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  AUTOMATION_HOOK_FORWARDED_HEADERS,
  AutomationHookId,
  AutomationHookSecret,
  NodeAutomationHooksSyncInput,
  NodeAutomationHooksSyncResult,
} from "./automationHooks.ts";

const proof = {
  nodeId: `node_${"n".repeat(22)}`,
  protocolMajor: 1,
  protocolMinor: 3,
  nonce: `${"A".repeat(42)}A`,
  signature: `${"B".repeat(85)}A`,
};

describe("automation hook contracts", () => {
  it("takes 16-byte hook ids and 32-byte secrets in base64url", () => {
    expect(Schema.is(AutomationHookId)("AbCdEfGhIjKlMnOpQrSt_-")).toBe(true);
    expect(Schema.is(AutomationHookId)("too-short")).toBe(false);
    expect(Schema.is(AutomationHookSecret)("a".repeat(43))).toBe(true);
    expect(Schema.is(AutomationHookSecret)("a".repeat(44))).toBe(false);
  });

  it("forwards lowercase headers and never authorization", () => {
    for (const header of AUTOMATION_HOOK_FORWARDED_HEADERS) {
      expect(header).toBe(header.toLowerCase());
    }
    expect(AUTOMATION_HOOK_FORWARDED_HEADERS).not.toContain("authorization");
  });

  it("decodes a sync and its answer", () => {
    const decodeInput = Schema.decodeUnknownSync(NodeAutomationHooksSyncInput);
    expect(
      decodeInput({
        proof,
        hookIds: ["AbCdEfGhIjKlMnOpQrSt_-"],
        acks: [{ deliveryId: "d1", outcome: "accepted" }],
      }).hookIds,
    ).toHaveLength(1);
    expect(() =>
      decodeInput({ proof, hookIds: [], acks: [{ deliveryId: "d1", outcome: "maybe" }] }),
    ).toThrow();
    const decodeResult = Schema.decodeUnknownSync(NodeAutomationHooksSyncResult);
    expect(
      decodeResult({
        protocolVersion: 1,
        deliveries: [
          {
            deliveryId: "d2",
            hookId: "AbCdEfGhIjKlMnOpQrSt_-",
            receivedAt: "2026-11-09T12:00:00.000Z",
            headers: { "content-type": "application/json" },
            bodyBase64: "e30=",
          },
        ],
        more: false,
      }).deliveries[0]?.deliveryId,
    ).toBe("d2");
  });
});
