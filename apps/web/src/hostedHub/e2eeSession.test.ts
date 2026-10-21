import { EnvironmentId } from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  beginWebE2eeChannelAttempt,
  clearWebE2eeLocalDiagnostics,
  lockWebE2eeChannelMode,
  publishWebE2eeVerificationCode,
  recordWebE2eePolicyGenerationRegression,
  resetWebE2eeSession,
  setDisplayedWebE2eeEnvironment,
  subscribeWebE2eeOpenChannels,
  subscribeWebE2eeSession,
  subscribeWebE2eeSessionFor,
  webE2eeLocalDiagnostics,
  webE2eeOpenChannelStatuses,
  webE2eeSessionState,
  webE2eeSessionStateFor,
} from "./e2eeSession";
import { clearWebHostedNodeScopedState } from "./environment";

// docs/relay-e2ee-protocol.md §13's per-channel projection, asserted on the
// module rather than through a channel.
//
// `e2eeAttempt.test.ts` drives this module end to end through the real §4.4
// machine, and that is where the reachable states are proven. What it cannot
// reach is the module's own refusals and its per-channel clearing: those are
// properties of a caller sequence, and each of them is the last line between a
// §13.5 code and a session that does not exist.

const CODE = "AAAA-BBBB";
const OTHER_CODE = "CCCC-DDDD";
const UNAVAILABLE = { status: "unavailable", verificationCode: null } as const;
const ENVIRONMENT_A = EnvironmentId.make("env_aaaaaaaaaaaaaaaaaaaaaa");
const ENVIRONMENT_B = EnvironmentId.make("env_bbbbbbbbbbbbbbbbbbbbbb");

/** One channel to `environmentId`, driven in the §4.4 machine's order to an `e2ee` lock. */
function lockedChannel(environmentId: EnvironmentId, code: string): object {
  const channel = {};
  beginWebE2eeChannelAttempt(environmentId, channel);
  publishWebE2eeVerificationCode(code, environmentId, channel);
  lockWebE2eeChannelMode("e2ee", environmentId, channel);
  return channel;
}

beforeEach(() => {
  clearWebE2eeLocalDiagnostics();
  setDisplayedWebE2eeEnvironment(null);
  resetWebE2eeSession();
});

afterEach(() => {
  clearWebE2eeLocalDiagnostics();
  setDisplayedWebE2eeEnvironment(null);
  resetWebE2eeSession();
});

describe("§11.4 web local diagnostics", () => {
  it("keeps the stable rollback code across channel reset and clears it explicitly", () => {
    recordWebE2eePolicyGenerationRegression();
    resetWebE2eeSession();
    expect(webE2eeLocalDiagnostics()).toEqual(["e2ee_policy_generation_regressed"]);
    clearWebE2eeLocalDiagnostics();
    expect(webE2eeLocalDiagnostics()).toEqual([]);
  });

  it("is bounded to the newest eight local codes", () => {
    for (let index = 0; index < 12; index += 1) recordWebE2eePolicyGenerationRegression();
    expect(webE2eeLocalDiagnostics()).toHaveLength(8);
  });
});

describe("§13 the projection is per channel", () => {
  it("drops the previous channel's §13.5 code when the next one begins", () => {
    // §13.5's code is bound to ONE session by construction — "it changes on every
    // channel" — so carrying it into the next negotiation is the one way an
    // owner can compare a dead session's string against the node CLI's live one
    // and see a match. `beginWebE2eeChannelAttempt` names both halves; only the
    // status half had an assertion.
    lockWebE2eeChannelMode("e2ee");
    publishWebE2eeVerificationCode(CODE);
    expect(webE2eeSessionState()).toEqual({
      status: "web-unsigned",
      verificationCode: CODE,
    });

    beginWebE2eeChannelAttempt();
    expect(webE2eeSessionState()).toEqual({
      status: "negotiating",
      verificationCode: null,
    });
  });

  it("drops the code again when the channel falls back to plaintext", () => {
    lockWebE2eeChannelMode("e2ee");
    publishWebE2eeVerificationCode(CODE);
    lockWebE2eeChannelMode("legacy");
    expect(webE2eeSessionState()).toEqual({
      status: "legacy",
      verificationCode: null,
    });
  });

  it("is dropped by the node-scoped clearing catalog, for that environment only", () => {
    // The sibling of §12.1's latch rule and its opposite: the §13 projection IS
    // node-scoped, so a teardown that left `web-unsigned` and the previous
    // node's `WebSAS` standing would describe a channel for a node the owner has
    // left. Another node's channel did not end, and neither does its entry.
    lockedChannel(ENVIRONMENT_A, CODE);
    lockedChannel(ENVIRONMENT_B, OTHER_CODE);
    setDisplayedWebE2eeEnvironment(ENVIRONMENT_A);

    clearWebHostedNodeScopedState(ENVIRONMENT_A);

    expect(webE2eeSessionState()).toEqual(UNAVAILABLE);
    expect(webE2eeSessionStateFor(ENVIRONMENT_B)).toEqual({
      status: "web-unsigned",
      verificationCode: OTHER_CODE,
    });
  });
});

describe("§13.5 every environment's channel owns its own entry", () => {
  it("shows the displayed environment's own code and never another's", () => {
    // §13.5's property is that the owner compares the code against the node CLI
    // of the session that produced it. Two channels publishing into one shared
    // projection let the one that negotiated last own the code shown for the
    // selected node, whichever node that session was with.
    lockedChannel(ENVIRONMENT_A, CODE);
    lockedChannel(ENVIRONMENT_B, OTHER_CODE);

    setDisplayedWebE2eeEnvironment(ENVIRONMENT_A);
    expect(webE2eeSessionState()).toEqual({ status: "web-unsigned", verificationCode: CODE });
    setDisplayedWebE2eeEnvironment(ENVIRONMENT_B);
    expect(webE2eeSessionState()).toEqual({
      status: "web-unsigned",
      verificationCode: OTHER_CODE,
    });
    // Nothing selected shows nothing, rather than whichever channel is newest.
    setDisplayedWebE2eeEnvironment(null);
    expect(webE2eeSessionState()).toEqual(UNAVAILABLE);
  });

  it("lets no stale channel clear or overwrite the entry its successor took over", () => {
    // A reconnect can begin the next channel before the previous engine finishes
    // tearing down, so every late write from the old one must miss.
    const stale = lockedChannel(ENVIRONMENT_A, CODE);
    const current = {};
    beginWebE2eeChannelAttempt(ENVIRONMENT_A, current);
    const negotiating = { status: "negotiating", verificationCode: null };

    lockWebE2eeChannelMode("legacy", ENVIRONMENT_A, stale);
    publishWebE2eeVerificationCode(OTHER_CODE, ENVIRONMENT_A, stale);
    resetWebE2eeSession(ENVIRONMENT_A, stale);
    expect(webE2eeSessionStateFor(ENVIRONMENT_A)).toEqual(negotiating);

    // The channel that owns the entry still drives it, and its own end clears it.
    publishWebE2eeVerificationCode(OTHER_CODE, ENVIRONMENT_A, current);
    lockWebE2eeChannelMode("e2ee", ENVIRONMENT_A, current);
    expect(webE2eeSessionStateFor(ENVIRONMENT_A)).toEqual({
      status: "web-unsigned",
      verificationCode: OTHER_CODE,
    });
    resetWebE2eeSession(ENVIRONMENT_A, current);
    expect(webE2eeSessionStateFor(ENVIRONMENT_A)).toEqual(UNAVAILABLE);
  });

  it("lets a channel write nothing into an entry that was cleared under it", () => {
    // A node teardown drops the entry while its channel may still lock from a
    // timer; that late lock must not recreate a status for a channel that ended.
    const channel = lockedChannel(ENVIRONMENT_A, CODE);
    resetWebE2eeSession(ENVIRONMENT_A);
    lockWebE2eeChannelMode("legacy", ENVIRONMENT_A, channel);
    publishWebE2eeVerificationCode(OTHER_CODE, ENVIRONMENT_A, channel);
    expect(webE2eeSessionStateFor(ENVIRONMENT_A)).toEqual(UNAVAILABLE);
  });

  it("addresses the displayed entry from the forms that name no environment", () => {
    lockedChannel(ENVIRONMENT_B, OTHER_CODE);
    setDisplayedWebE2eeEnvironment(ENVIRONMENT_A);
    beginWebE2eeChannelAttempt();
    publishWebE2eeVerificationCode(CODE);
    lockWebE2eeChannelMode("e2ee");
    expect(webE2eeSessionStateFor(ENVIRONMENT_A)).toEqual({
      status: "web-unsigned",
      verificationCode: CODE,
    });
    expect(webE2eeSessionStateFor(ENVIRONMENT_B).verificationCode).toBe(OTHER_CODE);

    // The session-wide reset ends every environment's entry: the application
    // session that every one of those channels belonged to ended.
    resetWebE2eeSession();
    expect(webE2eeSessionStateFor(ENVIRONMENT_A)).toEqual(UNAVAILABLE);
    expect(webE2eeSessionStateFor(ENVIRONMENT_B)).toEqual(UNAVAILABLE);
  });
});

describe("§13 the channels open in this tab", () => {
  it("lists every open channel's state, displayed or not, and none once they end", () => {
    let notified = 0;
    const unsubscribe = subscribeWebE2eeOpenChannels(() => (notified += 1));
    expect(webE2eeOpenChannelStatuses()).toEqual([]);

    // No environment is displayed: the selection is on no node.
    const a = lockedChannel(ENVIRONMENT_A, CODE);
    beginWebE2eeChannelAttempt(ENVIRONMENT_B, {});
    expect(webE2eeSessionState()).toEqual(UNAVAILABLE);
    expect(webE2eeOpenChannelStatuses()).toEqual(["negotiating", "web-unsigned"]);
    const snapshot = webE2eeOpenChannelStatuses();
    const notifiedBefore = notified;

    // A change that leaves the set of states as it was keeps the snapshot.
    publishWebE2eeVerificationCode(OTHER_CODE, ENVIRONMENT_A, a);
    expect(webE2eeOpenChannelStatuses()).toBe(snapshot);
    expect(notified).toBe(notifiedBefore);

    resetWebE2eeSession(ENVIRONMENT_B);
    expect(webE2eeOpenChannelStatuses()).toEqual(["web-unsigned"]);
    resetWebE2eeSession();
    expect(webE2eeOpenChannelStatuses()).toEqual([]);
    expect(notified).toBe(notifiedBefore + 2);
    unsubscribe();
  });
});

describe("§13.5 the code is refused by any state that cannot have one", () => {
  it("refuses a code for a channel that does not exist", () => {
    publishWebE2eeVerificationCode(CODE);
    expect(webE2eeSessionState()).toEqual(UNAVAILABLE);
  });

  it("refuses a code for a channel that locked plaintext", () => {
    // §12.2's fallback channel has no session to bind a §13.5 string to, so a
    // value arriving here describes one that does not exist. It is defence in
    // depth today — the machine publishes only at its own `e2ee` lock — and the
    // guard is exactly what a later caller would remove without noticing.
    lockWebE2eeChannelMode("legacy");
    publishWebE2eeVerificationCode(CODE);
    expect(webE2eeSessionState()).toEqual({
      status: "legacy",
      verificationCode: null,
    });
  });

  it("accepts a code while negotiating, which is the ordering the machine uses", () => {
    // §4.4's mode lock is a state the machine holds rather than a callback: it
    // locks, derives, and publishes, and only then does the caller's wrapper
    // report the lock. The live state at publish time is therefore still
    // `negotiating`, and gating on `web-unsigned` silently threw the code away.
    beginWebE2eeChannelAttempt();
    publishWebE2eeVerificationCode(CODE);
    expect(webE2eeSessionState()).toEqual({
      status: "negotiating",
      verificationCode: CODE,
    });
    lockWebE2eeChannelMode("e2ee");
    expect(webE2eeSessionState()).toEqual({
      status: "web-unsigned",
      verificationCode: CODE,
    });
  });
});

describe("§13 the projection notifies its subscribers", () => {
  it("notifies on every change and on no no-op", () => {
    let notifications = 0;
    const unsubscribe = subscribeWebE2eeSession(() => void (notifications += 1));
    try {
      beginWebE2eeChannelAttempt();
      expect(notifications).toBe(1);
      beginWebE2eeChannelAttempt();
      expect(notifications).toBe(1);
      lockWebE2eeChannelMode("e2ee");
      expect(notifications).toBe(2);
      resetWebE2eeSession();
      expect(notifications).toBe(3);
    } finally {
      unsubscribe();
    }
    lockWebE2eeChannelMode("legacy");
    expect(notifications).toBe(3);
  });

  it("notifies the displayed subscribers only for the displayed entry", () => {
    let displayed = 0;
    let environmentB = 0;
    const unsubscribe = subscribeWebE2eeSession(() => void (displayed += 1));
    const unsubscribeB = subscribeWebE2eeSessionFor(ENVIRONMENT_B, () => void (environmentB += 1));
    try {
      setDisplayedWebE2eeEnvironment(ENVIRONMENT_A);
      // Both entries are `unavailable`, so the switch changed nothing visible.
      expect(displayed).toBe(0);

      const channelB = {};
      beginWebE2eeChannelAttempt(ENVIRONMENT_B, channelB);
      lockWebE2eeChannelMode("e2ee", ENVIRONMENT_B, channelB);
      expect(displayed).toBe(0);
      expect(environmentB).toBe(2);

      beginWebE2eeChannelAttempt(ENVIRONMENT_A, {});
      expect(displayed).toBe(1);
      expect(environmentB).toBe(2);

      setDisplayedWebE2eeEnvironment(ENVIRONMENT_B);
      expect(displayed).toBe(2);
      expect(webE2eeSessionState().status).toBe("web-unsigned");
    } finally {
      unsubscribe();
      unsubscribeB();
    }
  });
});
