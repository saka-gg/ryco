import { describe, expect, it } from "vite-plus/test";

import {
  deriveHostedConnectionStatusIndicator,
  deriveHostedConnectionStatusText,
  HOSTED_CONNECTION_STATUS_INDICATORS,
  HOSTED_CONNECTION_STATUS_TEXTS,
  HOSTED_E2EE_CHANNEL_STATUSES,
  type HostedConnectionStatusInput,
  type HostedConnectionStatusText,
} from "./connectionStatus";
import {
  everyHostedConnectionStatusInput,
  hostedConnectionConnectedByGateOrder,
  hostedConnectionGuaranteeByGateOrder,
} from "../../test/hostedConnectionVocabulary";

function input(overrides: Partial<HostedConnectionStatusInput>): HostedConnectionStatusInput {
  return {
    browserStatus: "current",
    sessionStatus: "ready",
    selectionStatus: "online",
    transportStatus: "online",
    ...overrides,
  };
}

describe("deriveHostedConnectionStatusText", () => {
  it("keeps the bounded status vocabulary in the documented precedence order", () => {
    expect(deriveHostedConnectionStatusText(input({}))).toBe("Online");
    expect(deriveHostedConnectionStatusText(input({ browserStatus: "offline" }))).toBe("Offline");
    expect(deriveHostedConnectionStatusText(input({ browserStatus: "checking-access" }))).toBe(
      "Checking access",
    );
    expect(deriveHostedConnectionStatusText(input({ browserStatus: "synchronizing" }))).toBe(
      "Synchronizing",
    );
    expect(deriveHostedConnectionStatusText(input({ browserStatus: "suspended" }))).toBe("Stale");
    expect(deriveHostedConnectionStatusText(input({ browserStatus: "stale" }))).toBe("Stale");
    expect(deriveHostedConnectionStatusText(input({ sessionStatus: "delivery-unknown" }))).toBe(
      "Delivery unknown",
    );
    expect(
      deriveHostedConnectionStatusText(
        input({ sessionStatus: "stale", selectionStatus: "authorization-removed" }),
      ),
    ).toBe("Authorization removed");
    expect(
      deriveHostedConnectionStatusText(
        input({ sessionStatus: "stale", selectionStatus: "revoked" }),
      ),
    ).toBe("Revoked");
    expect(
      deriveHostedConnectionStatusText(
        input({ sessionStatus: "stale", selectionStatus: "incompatible" }),
      ),
    ).toBe("Incompatible");
    expect(
      deriveHostedConnectionStatusText(
        input({ sessionStatus: "stale", transportStatus: "reconnecting" }),
      ),
    ).toBe("Unavailable");
    expect(
      deriveHostedConnectionStatusText(
        input({ sessionStatus: "stale", transportStatus: "idle", selectionStatus: "offline" }),
      ),
    ).toBe("Offline");
  });

  it("browser lifecycle status wins over session and selection states", () => {
    expect(
      deriveHostedConnectionStatusText(
        input({ browserStatus: "offline", sessionStatus: "delivery-unknown" }),
      ),
    ).toBe("Offline");
    expect(
      deriveHostedConnectionStatusText(
        input({ browserStatus: "checking-access", selectionStatus: "revoked" }),
      ),
    ).toBe("Checking access");
  });

  it("keeps native enrollment closed behind an explicit device-security state", () => {
    expect(
      deriveHostedConnectionStatusText(
        input({ transportStatus: "idle", nativeDeviceSecurityStatus: "securing" }),
      ),
    ).toBe("Securing this device");
    expect(
      deriveHostedConnectionStatusText(
        input({ transportStatus: "idle", nativeDeviceSecurityStatus: "unavailable" }),
      ),
    ).toBe("Device encryption unavailable");
    // A revoked device enrollment is not the selected node's `Revoked`.
    expect(
      deriveHostedConnectionStatusText(
        input({ transportStatus: "idle", nativeDeviceSecurityStatus: "revoked" }),
      ),
    ).toBe("Device removed");
    expect(
      deriveHostedConnectionStatusIndicator(
        input({ e2eeStatus: "verified", nativeDeviceSecurityStatus: "securing" }),
      ),
    ).toMatchObject({ connected: false, guarantee: "none" });
  });

  it("falls back to the hyphen-expanded transport status only for uncovered states", () => {
    expect(
      deriveHostedConnectionStatusText(
        input({
          sessionStatus: "stale",
          selectionStatus: "online",
          transportStatus: "terminal-failure",
        }),
      ),
    ).toBe("terminal failure");
  });
});

/**
 * The collapsed presentation, swept over the whole bounded vocabulary.
 *
 * This is a pure suite on purpose: it exercises all 1,944 input combinations
 * as function calls, so the browser suite only has to mount the handful of
 * distinct results rather than pay a render per combination.
 */
describe("the collapsed connection indicator", () => {
  const everyText = HOSTED_CONNECTION_STATUS_TEXTS;

  it("covers every reachable status, and every covered status is reachable", () => {
    const reachable = new Set<string>();
    for (const value of everyHostedConnectionStatusInput()) {
      const text = deriveHostedConnectionStatusText(value);
      // A reachable text with no entry would be a runtime `undefined` label.
      expect(HOSTED_CONNECTION_STATUS_INDICATORS[text], `no indicator for "${text}"`).toBeDefined();
      reachable.add(text);
    }
    // Reachability both ways: the union carries no member the derivation
    // cannot produce, so no entry here is decoration.
    const declared = new Set<string>(everyText);
    expect([...reachable].filter((text) => !declared.has(text))).toEqual([]);
    expect([...declared].filter((text) => !reachable.has(text))).toEqual([]);
  });

  it("gives every status a distinct short label, without folding case", () => {
    const labels = everyText.map((text) => HOSTED_CONNECTION_STATUS_INDICATORS[text].shortLabel);
    // No `toLowerCase()` anywhere: `Online` and `online` are different states —
    // a ready ryco session versus one that is synchronizing, replaying, stale,
    // or closed — and lowercasing the key merged exactly that pair before the
    // comparison could see it.
    expect(new Set(labels).size, `collapsed labels are not distinct: ${labels.join(", ")}`).toBe(
      labels.length,
    );
    expect(HOSTED_CONNECTION_STATUS_INDICATORS.Online.shortLabel).not.toBe(
      HOSTED_CONNECTION_STATUS_INDICATORS.online.shortLabel,
    );
  });

  it("keeps every short label short enough for a 320px app bar", () => {
    for (const text of everyText) {
      const { shortLabel } = HOSTED_CONNECTION_STATUS_INDICATORS[text];
      expect(shortLabel.length, `short label for "${text}"`).toBeGreaterThan(0);
      // Twelve characters is what the chip's 136px cap holds at the default
      // type scale; rendering the full text instead runs to twenty-one.
      expect(shortLabel.length, `short label for "${text}"`).toBeLessThanOrEqual(12);
    }
  });

  it("keeps the polarity of the states where polarity is the message", () => {
    // Each of these read as neutral progress when the label was computed as
    // the leading token of the full text, leaving severity to glyph and colour
    // alone — the exact failure mode icon-only was rejected to avoid.
    expect(HOSTED_CONNECTION_STATUS_INDICATORS["Authorization removed"].shortLabel).toBe(
      "No access",
    );
    expect(HOSTED_CONNECTION_STATUS_INDICATORS["Delivery unknown"].shortLabel).toBe("Unconfirmed");
    expect(HOSTED_CONNECTION_STATUS_INDICATORS["terminal failure"].shortLabel).toBe("Failed");
    expect(HOSTED_CONNECTION_STATUS_INDICATORS.online.shortLabel).toBe("Not ready");

    // …and none of them may regress to that mechanism. `Encrypted web` is
    // here for the same reason and not as a fourth example: §2.2's web row is
    // the one row whose message is its caveat, and its leading token is the
    // tier noun — a chip reading `Browser` sits in the same neutral register as
    // `Online` and names a client type rather than a protection level.
    for (const text of [
      "Authorization removed",
      "Delivery unknown",
      "terminal failure",
      "Encrypted web",
    ] satisfies ReadonlyArray<HostedConnectionStatusText>) {
      expect(
        HOSTED_CONNECTION_STATUS_INDICATORS[text].shortLabel,
        `"${text}" fell back to its leading token`,
      ).not.toBe(text.split(" ")[0]);
    }
  });

  it("agrees with the derivation's gate order on whether the node is connected", () => {
    let connectedCount = 0;
    for (const value of everyHostedConnectionStatusInput()) {
      const expected = hostedConnectionConnectedByGateOrder(value);
      if (expected) connectedCount += 1;
      expect(
        deriveHostedConnectionStatusIndicator(value).connected,
        `connectedness for ${JSON.stringify(value)}`,
      ).toBe(expected);
    }
    // Both outcomes are actually exercised, so the assertion cannot pass by
    // being vacuously false everywhere.
    expect(connectedCount).toBeGreaterThan(0);
    expect(connectedCount).toBeLessThan(everyHostedConnectionStatusInput().length);
  });

  it("never reports a connected node while the transport is not online", () => {
    for (const value of everyHostedConnectionStatusInput()) {
      if (deriveHostedConnectionStatusIndicator(value).connected) {
        expect(value.transportStatus).toBe("online");
        expect(value.sessionStatus).toBe("ready");
        expect(value.browserStatus).toBe("current");
      }
    }
  });
});

/**
 * `docs/relay-e2ee-protocol.md` §2.2 / §12.2, folded into the one derivation.
 *
 * The sweep is the point. §2.2's rule — "implementations and user-facing
 * documentation MUST NOT present a stronger claim for a weaker configuration" —
 * is a statement about EVERY combination, and the reason the E2EE state was
 * folded in here rather than derived beside the pill is that a second derivation
 * once shipped a contradictory one.
 */
describe("the §4.4 channel state folded into the indicator", () => {
  it("leaves a caller that reports no channel state byte-identical", () => {
    for (const value of everyHostedConnectionStatusInput()) {
      if (value.e2eeStatus !== "unavailable") continue;
      const { e2eeStatus: _dropped, ...withoutE2ee } = value;
      expect(deriveHostedConnectionStatusText(withoutE2ee)).toBe(
        deriveHostedConnectionStatusText(value),
      );
    }
  });

  it("names a usable session for the mode its channel locked", () => {
    const ready = { browserStatus: "current", sessionStatus: "ready" } as const;
    const online = { selectionStatus: "online", transportStatus: "online" } as const;
    expect(deriveHostedConnectionStatusText({ ...ready, ...online, e2eeStatus: "verified" })).toBe(
      "Encrypted · Verified locally",
    );
    expect(deriveHostedConnectionStatusText({ ...ready, ...online, e2eeStatus: "legacy" })).toBe(
      "Legacy connection",
    );
    expect(
      deriveHostedConnectionStatusText({ ...ready, ...online, e2eeStatus: "unverified" }),
    ).toBe("Not verified");
    expect(
      deriveHostedConnectionStatusText({ ...ready, ...online, e2eeStatus: "web-unsigned" }),
    ).toBe("Encrypted web");
    expect(
      deriveHostedConnectionStatusText({ ...ready, ...online, e2eeStatus: "negotiating" }),
    ).toBe("Securing");
    expect(
      deriveHostedConnectionStatusText({ ...ready, ...online, e2eeStatus: "unavailable" }),
    ).toBe("Online");
  });

  it("never lets a channel state outrank a browser, session, or selection problem", () => {
    // The texts the §4.4 dimension can name, DERIVED from the exhaustive
    // enumeration rather than listed: a hand-written list silently skips the
    // rows a new channel member introduces, and skipping is indistinguishable
    // from passing in a loop whose body is the assertion.
    const ready = { browserStatus: "current", sessionStatus: "ready" } as const;
    const online = { selectionStatus: "online", transportStatus: "online" } as const;
    const channelNamed = new Set<string>(
      HOSTED_E2EE_CHANNEL_STATUSES.filter((status) => status !== "unavailable").map((e2eeStatus) =>
        deriveHostedConnectionStatusText({ ...ready, ...online, e2eeStatus }),
      ),
    );
    expect(channelNamed.size).toBe(HOSTED_E2EE_CHANNEL_STATUSES.length - 1);
    for (const value of everyHostedConnectionStatusInput()) {
      if (value.e2eeStatus === "unavailable") continue;
      const text = deriveHostedConnectionStatusText(value);
      if (!channelNamed.has(text)) continue;
      // Reached only through the one branch that used to say `Online`.
      expect(value.browserStatus).toBe("current");
      expect(value.sessionStatus).toBe("ready");
      expect(value.transportStatus).toBe("online");
      expect((["online", "none", "offline"] as string[]).includes(value.selectionStatus)).toBe(
        true,
      );
    }
  });

  it("claims E2EE for a verified session and for nothing else", () => {
    let claimed = 0;
    for (const value of everyHostedConnectionStatusInput()) {
      const { guarantee } = deriveHostedConnectionStatusIndicator(value);
      expect(guarantee, `guarantee for ${JSON.stringify(value)}`).toBe(
        hostedConnectionGuaranteeByGateOrder(value),
      );
      if (guarantee === "e2ee") {
        claimed += 1;
        expect(value.e2eeStatus).toBe("verified");
      }
      // The §13.1 release gate and §12.2's honest labeling, as a property of
      // every combination rather than of the four spot checks above.
      if (value.e2eeStatus === "unverified" || value.e2eeStatus === "negotiating") {
        expect(guarantee).toBe("none");
        expect(deriveHostedConnectionStatusIndicator(value).connected).toBe(false);
      }
      if (value.e2eeStatus === "legacy") expect(guarantee).not.toBe("e2ee");
    }
    expect(claimed).toBeGreaterThan(0);
  });

  it("gives the E2EE-bearing status a label that says so, and no other status one", () => {
    expect(HOSTED_CONNECTION_STATUS_INDICATORS["Encrypted · Verified locally"].guarantee).toBe(
      "e2ee",
    );
    expect(HOSTED_CONNECTION_STATUS_INDICATORS["Legacy connection"].guarantee).toBe("legacy");
    const claiming = HOSTED_CONNECTION_STATUS_TEXTS.filter(
      (text) => HOSTED_CONNECTION_STATUS_INDICATORS[text].guarantee === "e2ee",
    );
    expect(claiming).toEqual(["Encrypted · Verified locally"]);
  });
});

/**
 * §2.2's web NX row, which is the ONE row whose whole purpose is to be weaker
 * than it looks.
 *
 * A Hub that serves the JavaScript can exfiltrate plaintext while completing a
 * genuine handshake and drawing a genuine §13.5 `WebSAS`, so §2.2 and §2.3
 * forbid the web tier from claiming the operator-proof protection of the bottom
 * row. Every assertion here is about that negative: the word, the claim, and the
 * usability are each separately prevented from collapsing onto the native ones.
 */
describe("the web NX row (§2.2, §2.3, §13.1)", () => {
  const webReady: HostedConnectionStatusInput = {
    browserStatus: "current",
    sessionStatus: "ready",
    selectionStatus: "online",
    transportStatus: "online",
    e2eeStatus: "web-unsigned",
  };

  it("is spelled differently from the verified row and from the release-gated one", () => {
    const text = deriveHostedConnectionStatusText(webReady);
    expect(text).toBe("Encrypted web");
    expect(text).not.toBe(
      deriveHostedConnectionStatusText({ ...webReady, e2eeStatus: "verified" }),
    );
    expect(text).not.toBe(
      deriveHostedConnectionStatusText({ ...webReady, e2eeStatus: "unverified" }),
    );
    // The COLLAPSED label is what a chip shows, and it is where a glance-level
    // confusion would live: it must not be `Encrypted`, nor a prefix of it, and
    // it must not be the neutral tier noun either — at collapsed size that word
    // is the whole security signal, so on the one row that requires a caveat it
    // has to carry one.
    const { shortLabel } = HOSTED_CONNECTION_STATUS_INDICATORS["Encrypted web"];
    expect(shortLabel).toBe("Web E2EE");
    expect(shortLabel).not.toBe("Encrypted web".split(" ")[0]);
    expect(
      HOSTED_CONNECTION_STATUS_INDICATORS["Encrypted · Verified locally"].shortLabel.startsWith(
        shortLabel,
      ),
    ).toBe(false);
    expect(
      shortLabel.startsWith(
        HOSTED_CONNECTION_STATUS_INDICATORS["Encrypted · Verified locally"].shortLabel,
      ),
    ).toBe(false);
  });

  it("claims the web row and never the E2EE one", () => {
    const indicator = deriveHostedConnectionStatusIndicator(webReady);
    expect(indicator.guarantee).toBe("web");
    // Restated over EVERY combination, so `e2ee` cannot leak in through some
    // other input: the guarantee that means §2.2's bottom row stays reachable
    // from exactly one text, and that text is produced only by `verified`.
    const claiming = new Set<string>();
    for (const value of everyHostedConnectionStatusInput()) {
      const text = deriveHostedConnectionStatusText(value);
      if (HOSTED_CONNECTION_STATUS_INDICATORS[text].guarantee !== "e2ee") continue;
      claiming.add(text);
      expect(value.e2eeStatus).toBe("verified");
    }
    expect([...claiming]).toEqual(["Encrypted · Verified locally"]);
    expect(
      HOSTED_CONNECTION_STATUS_TEXTS.filter(
        (text) => HOSTED_CONNECTION_STATUS_INDICATORS[text].guarantee === "web",
      ),
    ).toEqual(["Encrypted web"]);
  });

  it("is a USABLE session, which is why it could not reuse `Not verified`", () => {
    // §13.1's release gate is native-only by construction — web holds no durable
    // pin of any kind (§6.3, §13.1) — so an NX channel releases application
    // payload exactly as a locked native one does. Reporting it disconnected
    // would be a lie about connectedness rather than a conservative claim.
    expect(deriveHostedConnectionStatusIndicator(webReady).connected).toBe(true);
    expect(
      deriveHostedConnectionStatusIndicator({ ...webReady, e2eeStatus: "unverified" }).connected,
    ).toBe(false);
    // And it is still subordinate to every earlier gate.
    expect(
      deriveHostedConnectionStatusIndicator({ ...webReady, browserStatus: "offline" }).connected,
    ).toBe(false);
    for (const value of everyHostedConnectionStatusInput()) {
      if (value.e2eeStatus !== "web-unsigned") continue;
      expect(deriveHostedConnectionStatusIndicator(value).connected).toBe(
        hostedConnectionConnectedByGateOrder(value),
      );
    }
  });

  it("leaves the pre-existing derivation byte-identical for every other caller", () => {
    // The new member is additive: a caller that reports no channel state, and a
    // caller that reports one of the four pre-existing ones, get exactly what
    // they got before it existed. This is the native no-op, restated here from
    // the shared side of the change.
    for (const value of everyHostedConnectionStatusInput()) {
      if (value.e2eeStatus === "web-unsigned") continue;
      expect(deriveHostedConnectionStatusText(value)).not.toBe("Encrypted web");
      expect(deriveHostedConnectionStatusIndicator(value).guarantee).not.toBe("web");
      if (value.e2eeStatus !== "unavailable") continue;
      const { e2eeStatus: _dropped, ...withoutE2ee } = value;
      expect(deriveHostedConnectionStatusIndicator(withoutE2ee)).toEqual(
        deriveHostedConnectionStatusIndicator(value),
      );
    }
  });
});
