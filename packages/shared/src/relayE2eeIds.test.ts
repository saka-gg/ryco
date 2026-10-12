import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

import { E2EE_ACCOUNT_ID_MAX_BYTES } from "./relayE2eeConstants.ts";
import {
  assertE2eeAccountId,
  invalidRelayE2eeInput,
  RelayE2eeValidationError,
} from "./relayE2eeIds.ts";
import * as Keys from "./relayE2eeKeys.ts";
import * as Transcripts from "./relayE2eeTranscripts.ts";

describe("relay E2EE identifier validation", () => {
  it("accepts a nonempty account id up to the byte bound", () => {
    expect(assertE2eeAccountId("acct_1")).toBe("acct_1");
    expect(assertE2eeAccountId("a".repeat(E2EE_ACCOUNT_ID_MAX_BYTES))).toHaveLength(
      E2EE_ACCOUNT_ID_MAX_BYTES,
    );
  });

  it("rejects empty, oversized, and non-string ids with the detail-free error", () => {
    for (const value of [
      "",
      "a".repeat(E2EE_ACCOUNT_ID_MAX_BYTES + 1),
      // Measured in UTF-8 bytes, not UTF-16 code units.
      "é".repeat(E2EE_ACCOUNT_ID_MAX_BYTES / 2 + 1),
      42 as unknown as string,
    ]) {
      expect(() => assertE2eeAccountId(value)).toThrow(RelayE2eeValidationError);
    }
    expect(() => invalidRelayE2eeInput()).toThrow("Relay E2EE input is invalid.");
  });

  it("is the one validator and error the key and transcript modules export", () => {
    expect(Transcripts.assertE2eeAccountId).toBe(assertE2eeAccountId);
    expect(Keys.RelayE2eeValidationError).toBe(RelayE2eeValidationError);
    expect(Keys.invalidRelayE2eeInput).toBe(invalidRelayE2eeInput);
  });

  it("stays free of the primitives so Hub account calls can validate without them", () => {
    const source = readFileSync(new URL("./relayE2eeIds.ts", import.meta.url), "utf8");
    const imports = [...source.matchAll(/from "([^"]+)"/gu)].map((match) => match[1]);
    expect(imports).toEqual(["./relayE2eeConstants.ts"]);
  });
});
