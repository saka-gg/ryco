import { describe, expect, it } from "vite-plus/test";

import { RELAY_INITIAL_LIMITS, type RelayLimits } from "@ryco/contracts/relay";
import {
  E2EE_ENVELOPE_OVERHEAD_BYTES,
  e2eeChannelSizeBudget,
} from "@ryco/shared/relayE2eeConstants";

import type { NodeE2eeChannelSession } from "./NodeE2eeChannelSession.ts";
import {
  makeNodeE2eeRelayChannelSession,
  nodeE2eeChannelPlaintextCeiling,
} from "./NodeE2eeRelayChannel.ts";

// The channel binding is where a relay channel's lifecycle meets §10 and §10.4,
// so what is asserted here is ORDER and INPUTS: that the authenticated close is
// entered before anything is disposed, that the verdict is told whether the
// chunk assembler still holds a partial message, and that the RPC runtime is
// released only after both.

function stubSession(calls: string[]): NodeE2eeChannelSession {
  return {
    mode: () => "e2ee",
    announce: () => calls.push("announce"),
    intercept: async () => ({ kind: "claimed" }),
    emit: async () => "sent",
    abandon: () => calls.push("abandon"),
    beginClose: async () => {
      calls.push("beginClose");
    },
    revokeAccountGrant: async () => {
      calls.push("revokeAccountGrant");
    },
    dispose: (options) => calls.push(`dispose:${String(options?.incompleteReassembly)}`),
    verdict: () => undefined,
  };
}

describe("nodeE2eeChannelPlaintextCeiling", () => {
  it("takes §4.5's ceiling from the one shared derivation", () => {
    const cases: readonly RelayLimits[] = [
      RELAY_INITIAL_LIMITS,
      // A connection squeezed well below `RELAY_MAX_RPC_MESSAGE_BYTES`, where
      // the two arms of §4.5's `min` swap over.
      { ...RELAY_INITIAL_LIMITS, maxQueuedBytes: 1_024 * 1_024 },
    ];
    for (const limits of cases) {
      const budget = e2eeChannelSizeBudget(limits);
      expect(budget.establishable).toBe(true);
      // The connector holds no second copy of the arithmetic: this is the value
      // `e2eeChannelSizeBudget` computes, not one that merely agrees with it
      // until someone edits one of the two.
      expect(nodeE2eeChannelPlaintextCeiling(limits)).toBe(budget.plaintextCeiling);
    }
  });

  it("yields no usable ceiling when §4.5 declares the budget unestablishable", () => {
    // §4.5 / §11.2 P14: such a channel MUST fail during establishment rather
    // than shrink anything silently, and 0 is the value the record session
    // refuses. A hand-rolled subtraction returns a negative number here, which
    // is a different kind of wrong in every caller that compares against it.
    const limits = {
      ...RELAY_INITIAL_LIMITS,
      maxControlFrameBytes: 4_096,
      maxQueuedBytes: 4_096 + E2EE_ENVELOPE_OVERHEAD_BYTES - 16,
    } as RelayLimits;
    const budget = e2eeChannelSizeBudget(limits);
    expect(budget.establishable).toBe(false);
    expect(budget.plaintextCeiling).toBeLessThan(0);
    expect(nodeE2eeChannelPlaintextCeiling(limits)).toBe(0);
  });
});

describe("makeNodeE2eeRelayChannelSession", () => {
  it("runs §10's close, then §10.4's verdict, then the release", async () => {
    const calls: string[] = [];
    const channel = makeNodeE2eeRelayChannelSession({
      e2ee: stubSession(calls),
      rpc: {
        receive: async () => true,
        queuedBytes: async () => 0,
        supportsChunkedMessages: () => false,
        // §10.4: the assembler holds a partial message at the instant the
        // channel ends, which is truncation regardless of any other state.
        incompleteReassembly: () => true,
      },
      release: async () => {
        calls.push("release");
      },
    });
    await channel.close();
    expect(calls).toEqual(["beginClose", "dispose:true", "release"]);
  });

  it("reports a complete reassembly as such", async () => {
    const calls: string[] = [];
    const channel = makeNodeE2eeRelayChannelSession({
      e2ee: stubSession(calls),
      rpc: {
        receive: async () => true,
        queuedBytes: async () => 0,
        supportsChunkedMessages: () => false,
        incompleteReassembly: () => false,
      },
      release: async () => {
        calls.push("release");
      },
    });
    await channel.close();
    expect(calls).toEqual(["beginClose", "dispose:false", "release"]);
  });

  it("announces at acceptance and passes the RPC surface straight through", async () => {
    const calls: string[] = [];
    const channel = makeNodeE2eeRelayChannelSession({
      e2ee: stubSession(calls),
      rpc: {
        receive: async (bytes) => bytes.byteLength > 0,
        queuedBytes: async () => 17,
        supportsChunkedMessages: () => true,
        incompleteReassembly: () => false,
      },
      release: async () => undefined,
    });
    channel.onAccepted?.();
    expect(calls).toEqual(["announce"]);
    expect(await channel.receive(Uint8Array.of(1))).toBe(true);
    expect(await channel.receive(new Uint8Array(0))).toBe(false);
    expect(await channel.queuedBytes()).toBe(17);
    expect(channel.supportsChunkedMessages()).toBe(true);
  });
});
