import type { RelayE2eeHost } from "@ryco/client-runtime/relay";
import { makeRelayE2eeInitiator } from "@ryco/client-runtime/relay/e2ee";
import {
  E2EE_SUITE_25519_CHACHAPOLY_SHA256,
  E2EE_SUITE_ACCOUNT_GRANT_25519_CHACHAPOLY_SHA256,
  classifyPostStripPayload,
} from "@ryco/shared/relayE2eeWire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { F19, fixtureBytes, fixtureCase, hexOf } from "../../../test/e2eeCorpus";
import {
  authenticateRelay,
  createRelayHarness,
  deliverRelayPayload,
  FIXTURE_ACCOUNT_ID,
  FIXTURE_HUB_ORIGIN,
  FIXTURE_NODE_ID,
  outboundRelayPayloads,
  relayCloseReasons,
  settleRelay,
} from "../../../test/maliciousRelay";
import { webRelayE2eeAttempt } from "../../hostedHub/e2eeAttempt";
import { clearWebE2eeLatches } from "../../hostedHub/e2eeLatch";
import { clearWebE2eeLocalDiagnostics, resetWebE2eeSession } from "../../hostedHub/e2eeSession";

// §18.2 / F19's Web-isolation run. The account device grant is a native-only
// credential. This test hands the exact valid committed grant to the shipped Web
// channel as hostile relay input and checks the boundary behavior, as well as
// all browser persistence and observation surfaces named by the protocol.

const SELECTION = {
  hubOrigin: FIXTURE_HUB_ORIGIN,
  accountId: FIXTURE_ACCOUNT_ID,
  nodeId: FIXTURE_NODE_ID,
} as const;

const serialized = (value: unknown): string => {
  if (typeof value === "string") return value;
  try {
    return `${String(value)} ${JSON.stringify(value) ?? ""}`;
  } catch {
    return String(value);
  }
};

beforeEach(() => {
  clearWebE2eeLatches();
  clearWebE2eeLocalDiagnostics();
  resetWebE2eeSession();
});

afterEach(() => {
  clearWebE2eeLatches();
  clearWebE2eeLocalDiagnostics();
  resetWebE2eeSession();
  vi.restoreAllMocks();
});

describe("§16.4 F19 account-grant isolation on Web", () => {
  it("keeps suite 0x02 and every native credential out of the Web attempt", () => {
    const attempt = webRelayE2eeAttempt(SELECTION);
    expect(attempt.localSuitePreference).toEqual([E2EE_SUITE_25519_CHACHAPOLY_SHA256]);
    expect(attempt.localSuitePreference).not.toContain(
      E2EE_SUITE_ACCOUNT_GRANT_25519_CHACHAPOLY_SHA256,
    );
    expect(attempt.credentials).toEqual({ tier: "web" });
    expect(Object.keys(attempt.credentials)).toEqual(["tier"]);
    expect(JSON.stringify(attempt)).not.toMatch(/deviceGrant|agreementSecret|prekeySignature/);
  });

  it("rejects the exact valid grant before decode and never stores, renders, logs, or forwards it", async () => {
    const entry = fixtureCase(F19, "valid-account-enrolled-native-device-grant");
    expect(entry.inputs.tier).toBe("native");
    expect(entry.inputs.selectedSuite).toBe(E2EE_SUITE_ACCOUNT_GRANT_25519_CHACHAPOLY_SHA256);
    const grant = fixtureBytes(entry.inputs.envelope);
    expect(hexOf(grant)).toBe(hexOf(fixtureBytes(entry.expected.envelope)));
    expect(classifyPostStripPayload(grant)).toEqual({
      kind: "other",
      reason: "unknown_discriminator",
    });

    const storageSet = vi.spyOn(Storage.prototype, "setItem");
    const storageRemove = vi.spyOn(Storage.prototype, "removeItem");
    const storageClear = vi.spyOn(Storage.prototype, "clear");
    const idbOpen = vi.spyOn(IDBFactory.prototype, "open");
    const consoleSinks = (["debug", "error", "info", "log", "trace", "warn"] as const).map((name) =>
      vi.spyOn(console, name).mockImplementation(() => undefined),
    );
    const jsonParse = vi.spyOn(JSON, "parse");

    const attempt = webRelayE2eeAttempt(SELECTION);
    const diagnostics: string[] = [];
    const harness = createRelayHarness({
      e2ee: (host: RelayE2eeHost) =>
        makeRelayE2eeInitiator({
          host,
          attempt: {
            ...attempt,
            onDiagnostic: (entry) => void diagnostics.push(entry.row),
          },
        }),
    });
    authenticateRelay(harness.socket);
    harness.facade.send(new TextEncoder().encode('{"mustNeverEscape":true}'));
    deliverRelayPayload(harness.socket, grant);
    await settleRelay();

    expect(diagnostics).toEqual(["P6"]);
    expect(outboundRelayPayloads(harness.socket)).toEqual([]);
    expect(relayCloseReasons(harness.socket)).toEqual(["channel_rejected"]);
    expect(storageSet).not.toHaveBeenCalled();
    expect(storageRemove).not.toHaveBeenCalled();
    expect(storageClear).not.toHaveBeenCalled();
    expect(idbOpen).not.toHaveBeenCalled();
    expect(document.documentElement.textContent).not.toContain(hexOf(grant));
    expect(globalThis.location.href).not.toContain(hexOf(grant));
    for (const call of jsonParse.mock.calls) {
      expect(call.map(serialized).join(" ")).not.toContain(hexOf(grant));
    }
    for (const sink of consoleSinks) {
      for (const call of sink.mock.calls) {
        expect(call.map(serialized).join(" ")).not.toContain(hexOf(grant));
      }
    }
  });
});
