import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EnvironmentId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  HOSTED_CONNECTION_STATUS_INDICATORS,
  HOSTED_CONNECTION_STATUS_TEXTS,
  HOSTED_RELAY_TRANSPORT_STATUSES,
  type HostedConnectionGuarantee,
  type HostedConnectionStatusIndicator,
  type HostedEnvironmentSessionRecord,
} from "../../hostedHub/connectionStatus";
import type { HostedHubNode } from "../../hostedHub/types";
import {
  deriveHostedConnectionChip,
  deriveHostedEnvironmentConnectionChip,
  HOSTED_CONNECTING_STATUS_TEXT,
  hostedConnectionAnnouncement,
  hostedConnectionChipQuiet,
  hostedConnectionStatusPresentation,
  type HostedConnectionChipInput,
  type HostedEnvironmentConnectionChipInput,
} from "./HostedConnectionControls.logic";

const CONTROLS_SOURCE = readFileSync(
  fileURLToPath(new URL("./HostedConnectionControls.tsx", import.meta.url)),
  "utf8",
);
const LOGIC_SOURCE = readFileSync(
  fileURLToPath(new URL("./HostedConnectionControls.logic.ts", import.meta.url)),
  "utf8",
);

function indicator(
  guarantee: HostedConnectionGuarantee,
  connected: boolean,
  shortLabel = "Whatever",
): HostedConnectionStatusIndicator {
  return { shortLabel, connected, guarantee };
}

describe("every derivation call site supplies the §4.4 channel state", () => {
  it("builds the one status input with `e2eeStatus` and derives only from it", () => {
    // §12.2 makes the legacy label mandatory "in every user-facing surface", and
    // the derivation's `e2eeStatus` is optional with an `unavailable` default —
    // so a surface that simply forgot it renders a plaintext downgrade as a
    // green `Online` and nothing type-checks differently. Read off the source
    // because that is where the omission would live: a runtime test can only
    // observe the call sites it already knows to mount.
    const inputs = LOGIC_SOURCE.match(/const statusInput = \{[^}]*\}/gu) ?? [];
    expect(inputs, "no status input found — this test is testing nothing").toHaveLength(1);
    expect(inputs[0]).toContain("e2eeStatus");
    // The phase and the indicator both derive from that input…
    expect(
      LOGIC_SOURCE.match(/deriveHostedConnectionStatusIndicator\(statusInput\)/gu),
    ).toHaveLength(1);
    expect(LOGIC_SOURCE).toMatch(/describeHostedConnectionPhase\(\{\s*\.\.\.statusInput,/u);
    // …and nothing derives from an inline object that could quietly omit it.
    expect(LOGIC_SOURCE).not.toMatch(/deriveHostedConnectionStatus(?:Text|Indicator)\(\{/u);
    // The surfaces derive nothing themselves: the phone sheet and pill render
    // the selected node's chip, the thread badge its own environment's — and
    // both chips are the one description above.
    expect(CONTROLS_SOURCE).not.toMatch(/deriveHostedConnectionStatus(?:Text|Indicator)\(/u);
    expect(CONTROLS_SOURCE.match(/= useHostedConnectionChip\(\)/gu)).toHaveLength(2);
    expect(
      CONTROLS_SOURCE.match(/= useHostedEnvironmentConnectionChip\(environmentId\)/gu),
    ).toHaveLength(1);
    expect(LOGIC_SOURCE.match(/describeHostedEnvironmentConnection\(\s*input,/gu)).toHaveLength(3);
  });

  it("reads the projection through the tier-fenced hooks, once per chip", () => {
    // The selected node's chip reads the displayed channel; the thread badge
    // reads its own environment's channel by id and never takes a status
    // handed to it from elsewhere.
    expect(CONTROLS_SOURCE.match(/useWebE2eeChannelStatus\(\)/gu)).toHaveLength(1);
    expect(CONTROLS_SOURCE.match(/useWebE2eeChannelStatusFor\(environmentId\)/gu)).toHaveLength(1);
    expect(CONTROLS_SOURCE).toMatch(/deriveHostedConnectionChip\(\{[^}]*e2eeStatus/u);
    expect(CONTROLS_SOURCE).toMatch(/deriveHostedEnvironmentConnectionChip\(\{[^}]*e2eeStatus/u);
  });

  it("chooses no glyph from the transport or from connectedness", () => {
    // The three defects this replaced, pinned as source facts because each of
    // them was a conditional that type-checked perfectly.
    expect(CONTROLS_SOURCE).not.toContain('transport === "online" ? (');
    expect(CONTROLS_SOURCE).not.toContain("connected ? (");
    // Every glyph comes from the one shared component, which reads the claim.
    expect(CONTROLS_SOURCE.match(/<HostedConnectionStatusIcon/gu)).toHaveLength(3);
  });
});

function hostedNode(id: string, label: string, overrides: Partial<HostedHubNode> = {}) {
  return {
    id,
    environmentId: EnvironmentId.make(`env_${id.slice(5).padEnd(22, "a").slice(0, 22)}`),
    label,
    platformOs: "linux",
    platformArch: "x64",
    clientVersion: "0.9.0",
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1,
    revokedAt: null,
    revocationReasonCode: null,
    grant: { id: `grant_${id.slice(5)}`, role: "operator" },
    effectiveRole: "operator",
    presence: { online: true, lastHeartbeatAt: 1 },
    ...overrides,
  } satisfies HostedHubNode;
}

const SOURCE_NODE = hostedNode("node_aaaaaaaaaaaaaaaaaaaaaa", "Source node");
const TARGET_NODE = hostedNode("node_bbbbbbbbbbbbbbbbbbbbbb", "Target node", {
  effectiveRole: "viewer",
});

/** A selected, fully connected node with no route to anywhere else. */
function chipInput(overrides: Partial<HostedConnectionChipInput> = {}): HostedConnectionChipInput {
  return {
    accountStatus: "authenticated",
    directoryStatus: "ready",
    browserStatus: "current",
    selectionStatus: "online",
    transportStatus: "online",
    sessionStatus: "ready",
    errorMessage: null,
    effectiveRole: "operator",
    selectedNode: SOURCE_NODE,
    nodes: [SOURCE_NODE, TARGET_NODE],
    routedNodeId: SOURCE_NODE.id,
    e2eeStatus: "unavailable",
    ...overrides,
  };
}

describe("the connection chip", () => {
  it("names the selected node with its derived status once it is connected", () => {
    expect(deriveHostedConnectionChip(chipInput())).toEqual({
      node: SOURCE_NODE,
      role: "operator",
      statusText: "Online",
      indicator: HOSTED_CONNECTION_STATUS_INDICATORS.Online,
      switching: false,
    });
  });

  it("reads one `Connecting…` for every step of an intentional connect", () => {
    // Raw transport words (`requesting ticket`, `authenticating`, …) and
    // `Unavailable` for a quiet reconnect never reach a surface.
    const establishing = HOSTED_RELAY_TRANSPORT_STATUSES.filter((transportStatus) =>
      ["idle", "requesting-ticket", "connecting", "authenticating", "opening-channel"].includes(
        transportStatus,
      ),
    );
    for (const transportStatus of [...establishing, "reconnecting"] as const) {
      const chip = deriveHostedConnectionChip(
        chipInput({ transportStatus, sessionStatus: "synchronizing" }),
      );
      expect(chip?.statusText, transportStatus).toBe(HOSTED_CONNECTING_STATUS_TEXT);
      expect(chip?.indicator.shortLabel, transportStatus).toBe("Connecting");
      expect(chip?.indicator.connected, transportStatus).toBe(false);
    }
    // An online transport whose session is still catching up is the same connect.
    for (const sessionStatus of ["synchronizing", "replaying"] as const) {
      expect(deriveHostedConnectionChip(chipInput({ sessionStatus }))?.statusText).toBe(
        HOSTED_CONNECTING_STATUS_TEXT,
      );
    }
  });

  it("keeps problems out of the collapsed word", () => {
    // An error waiting to be shown, a stale or offline browser, an offline node
    // and an unconfirmed delivery are not a connect in progress.
    const problems: ReadonlyArray<readonly [string, Partial<HostedConnectionChipInput>, string]> = [
      [
        "an error",
        { transportStatus: "reconnecting", sessionStatus: "synchronizing", errorMessage: "x" },
        "Unavailable",
      ],
      ["a stale browser", { browserStatus: "stale", transportStatus: "connecting" }, "Stale"],
      ["an offline browser", { browserStatus: "offline", transportStatus: "idle" }, "Offline"],
      ["a checking browser", { browserStatus: "checking-access" }, "Checking access"],
      ["an offline node", { selectionStatus: "offline", transportStatus: "connecting" }, "Offline"],
      [
        "an unconfirmed delivery",
        { sessionStatus: "delivery-unknown", transportStatus: "connecting" },
        "Delivery unknown",
      ],
    ];
    for (const [name, overrides, expected] of problems) {
      expect(deriveHostedConnectionChip(chipInput(overrides))?.statusText, name).toBe(expected);
    }
  });

  it("keeps the channel label on a usable session", () => {
    expect(deriveHostedConnectionChip(chipInput({ e2eeStatus: "legacy" }))?.statusText).toBe(
      "Legacy connection",
    );
    expect(deriveHostedConnectionChip(chipInput({ e2eeStatus: "web-unsigned" }))?.statusText).toBe(
      "Encrypted web",
    );
  });

  it("names the target node while the route opens another one", () => {
    const chip = deriveHostedConnectionChip(chipInput({ routedNodeId: TARGET_NODE.id }));
    expect(chip).toEqual({
      node: TARGET_NODE,
      role: "viewer",
      statusText: HOSTED_CONNECTING_STATUS_TEXT,
      indicator: HOSTED_CONNECTION_STATUS_INDICATORS.connecting,
      switching: true,
    });
  });

  it("names the target when nothing is selected yet, instead of a saved view", () => {
    const chip = deriveHostedConnectionChip(
      chipInput({
        selectedNode: null,
        selectionStatus: "none",
        transportStatus: "idle",
        effectiveRole: null,
        routedNodeId: TARGET_NODE.id,
      }),
    );
    expect(chip?.node).toBe(TARGET_NODE);
    expect(chip?.statusText).toBe(HOSTED_CONNECTING_STATUS_TEXT);
    expect(chip?.switching).toBe(true);
  });

  it("reports an offline target as offline, not as connecting", () => {
    const offline = hostedNode("node_cccccccccccccccccccccc", "Offline node", {
      presence: { online: false, lastHeartbeatAt: null },
    });
    const chip = deriveHostedConnectionChip(
      chipInput({ nodes: [SOURCE_NODE, offline], routedNodeId: offline.id }),
    );
    expect(chip?.node).toBe(offline);
    expect(chip?.statusText).toBe("Offline");
    expect(chip?.switching).toBe(true);
  });

  it("describes the selection instead when the switch cannot proceed", () => {
    const revoked = hostedNode("node_dddddddddddddddddddddd", "Revoked node", { revokedAt: 5 });
    const nativeOnly = hostedNode("node_eeeeeeeeeeeeeeeeeeeeee", "Native node", {
      capabilities: { repositoryIdentity: true, nativeClientRequired: true },
    });
    const cases: ReadonlyArray<readonly [string, Partial<HostedConnectionChipInput>]> = [
      ["an unlisted node", { routedNodeId: "node_gone" }],
      ["a revoked node", { nodes: [SOURCE_NODE, revoked], routedNodeId: revoked.id }],
      ["a native-only node", { nodes: [SOURCE_NODE, nativeOnly], routedNodeId: nativeOnly.id }],
      ["an unready directory", { directoryStatus: "stale", routedNodeId: TARGET_NODE.id }],
      ["a signed-out account", { accountStatus: "signed-out", routedNodeId: TARGET_NODE.id }],
      ["an unchecked browser", { browserStatus: "checking-access", routedNodeId: TARGET_NODE.id }],
      ["a pending error", { errorMessage: "x", routedNodeId: TARGET_NODE.id }],
    ];
    for (const [name, overrides] of cases) {
      const chip = deriveHostedConnectionChip(chipInput(overrides));
      expect(chip?.node, name).toBe(SOURCE_NODE);
      expect(chip?.switching, name).toBe(false);
    }
  });

  it("has nothing to name without a selection or a switch target", () => {
    expect(
      deriveHostedConnectionChip(chipInput({ selectedNode: null, routedNodeId: null })),
    ).toBeNull();
    expect(
      deriveHostedConnectionChip(chipInput({ selectedNode: null, routedNodeId: "node_gone" })),
    ).toBeNull();
  });

  it("announces a connect without doubling its ellipsis", () => {
    expect(hostedConnectionAnnouncement("Studio", HOSTED_CONNECTING_STATUS_TEXT)).toBe(
      "Node Studio: Connecting…",
    );
    expect(hostedConnectionAnnouncement("Studio", "Online")).toBe("Node Studio: Online.");
  });
});

/** `node`'s own session record, connected and ready unless told otherwise. */
function sessionRecord(
  node: HostedHubNode,
  overrides: Partial<HostedEnvironmentSessionRecord> = {},
): HostedEnvironmentSessionRecord {
  return {
    environmentId: node.environmentId,
    nodeId: node.id,
    label: node.label,
    nodeKey: node.id,
    generation: 7,
    lastAccessedAt: 1,
    connectRequested: true,
    transportStatus: "online",
    transportReachedOnline: true,
    sessionStatus: "ready",
    effectiveRole: node.effectiveRole,
    sessionEstablished: true,
    sessionRecoveredAfterUnknown: false,
    failure: null,
    terminalNodeKey: null,
    syncFailed: false,
    snapshotAcceptedAt: 1,
    suspended: false,
    relayGap: false,
    ...overrides,
  };
}

/** The chip for the open thread's environment, while the selection is still on `SOURCE_NODE`. */
function environmentChipInput(
  overrides: Partial<HostedEnvironmentConnectionChipInput> = {},
): HostedEnvironmentConnectionChipInput {
  return {
    ...chipInput({ e2eeStatus: "legacy" }),
    environmentId: TARGET_NODE.environmentId,
    record: sessionRecord(TARGET_NODE),
    deliveryUnknown: false,
    e2eeStatus: "web-unsigned",
    ...overrides,
  };
}

describe("the open thread's connection chip", () => {
  it("names the thread's own node and reports its own record and channel, not the selection's", () => {
    // The selection is on another node whose channel fell back to legacy; the
    // thread's node holds a locked browser channel of its own.
    const chip = deriveHostedEnvironmentConnectionChip(environmentChipInput());
    expect(chip).toEqual({
      node: TARGET_NODE,
      role: "viewer",
      statusText: "Encrypted web",
      indicator: HOSTED_CONNECTION_STATUS_INDICATORS["Encrypted web"],
      switching: false,
    });
    // …and the other way round: its own fallback is labelled even while the
    // selection's channel is encrypted.
    const legacy = deriveHostedEnvironmentConnectionChip(
      environmentChipInput({ e2eeStatus: "legacy" }),
    );
    expect(legacy?.node).toBe(TARGET_NODE);
    expect(legacy?.statusText).toBe("Legacy connection");
    expect(legacy?.indicator.guarantee).toBe("legacy");
  });

  it("reads the shared session fields when the thread's node is the selected one", () => {
    // The thread's environment's own record says something else entirely; the
    // shared fields mirror the selected record and win.
    const chip = deriveHostedEnvironmentConnectionChip(
      environmentChipInput({
        environmentId: SOURCE_NODE.environmentId,
        record: sessionRecord(SOURCE_NODE, { transportStatus: "terminal-failure" }),
        e2eeStatus: "legacy",
      }),
    );
    expect(chip?.node).toBe(SOURCE_NODE);
    expect(chip?.role).toBe("operator");
    expect(chip?.statusText).toBe("Legacy connection");
    expect(chip).toEqual(deriveHostedConnectionChip(chipInput({ e2eeStatus: "legacy" })));
  });

  it("says Connecting… for a node whose own connection is on its way, or not yet requested", () => {
    for (const record of [
      sessionRecord(TARGET_NODE, {
        transportStatus: "authenticating",
        sessionStatus: "synchronizing",
      }),
      sessionRecord(TARGET_NODE, { sessionStatus: "replaying" }),
      undefined,
    ]) {
      const chip = deriveHostedEnvironmentConnectionChip(environmentChipInput({ record }));
      expect(chip?.statusText).toBe(HOSTED_CONNECTING_STATUS_TEXT);
      expect(chip?.indicator.connected).toBe(false);
    }
  });

  it("counts a browser still synchronizing the selection as current for another node", () => {
    // The account and the directory were checked for every environment; only
    // the selection is still being established.
    const chip = deriveHostedEnvironmentConnectionChip(
      environmentChipInput({ browserStatus: "synchronizing" }),
    );
    expect(chip?.statusText).toBe("Encrypted web");
    // A browser that has not been revalidated still says so.
    expect(
      deriveHostedEnvironmentConnectionChip(environmentChipInput({ browserStatus: "stale" }))
        ?.statusText,
    ).toBe("Stale");
  });

  it("reports the node's own failures, revocation and unconfirmed delivery", () => {
    const cases: ReadonlyArray<
      readonly [string, Partial<HostedEnvironmentConnectionChipInput>, string]
    > = [
      [
        "a dropped connection with a failure",
        {
          record: sessionRecord(TARGET_NODE, {
            transportStatus: "reconnecting",
            sessionStatus: "stale",
            failure: { kind: "slow-consumer", retryable: true },
          }),
        },
        "Unavailable",
      ],
      [
        "a relay revocation",
        {
          record: sessionRecord(TARGET_NODE, {
            transportStatus: "terminal-failure",
            failure: { kind: "revoked", retryable: false },
          }),
        },
        "Revoked",
      ],
      [
        "a revocation the directory reports first",
        { nodes: [SOURCE_NODE, { ...TARGET_NODE, revokedAt: 5 }] },
        "Revoked",
      ],
      [
        "an offline node",
        {
          nodes: [SOURCE_NODE, { ...TARGET_NODE, presence: { online: false, lastHeartbeatAt: 1 } }],
          record: undefined,
        },
        "Offline",
      ],
      [
        "an unconfirmed delivery on its record",
        { record: sessionRecord(TARGET_NODE, { sessionStatus: "delivery-unknown" }) },
        "Delivery unknown",
      ],
      [
        "an unconfirmed delivery with no record",
        { record: undefined, deliveryUnknown: true },
        "Delivery unknown",
      ],
    ];
    for (const [name, overrides, expected] of cases) {
      const chip = deriveHostedEnvironmentConnectionChip(environmentChipInput(overrides));
      expect(chip?.statusText, name).toBe(expected);
      expect(chip?.node.id, name).toBe(TARGET_NODE.id);
    }
  });

  it("has nothing to name for a node the directory does not list", () => {
    expect(
      deriveHostedEnvironmentConnectionChip(environmentChipInput({ nodes: [SOURCE_NODE] })),
    ).toBeNull();
  });
});

describe("§2.2 quiet is a claim, and only the browser channel may make it", () => {
  it("draws only a steady browser channel quietly", () => {
    for (const text of HOSTED_CONNECTION_STATUS_TEXTS) {
      const indicator = HOSTED_CONNECTION_STATUS_INDICATORS[text];
      expect(hostedConnectionChipQuiet(indicator), text).toBe(text === "Encrypted web");
    }
    // Never the fallback or the unclaimed connected state, however connected.
    expect(hostedConnectionChipQuiet(indicator("legacy", true))).toBe(false);
    expect(hostedConnectionChipQuiet(indicator("none", true))).toBe(false);
    expect(hostedConnectionChipQuiet(indicator("web", false))).toBe(false);
  });

  it("keeps the legacy word on the thread's chip in every connected state", () => {
    const chip = deriveHostedEnvironmentConnectionChip(
      environmentChipInput({ e2eeStatus: "legacy" }),
    );
    expect(chip?.statusText).toBe("Legacy connection");
    expect(hostedConnectionChipQuiet(chip!.indicator)).toBe(false);
  });
});

describe("§2.2 the presentation is a pure function of the claim", () => {
  it("ignores everything about the indicator except `guarantee` and reachability", () => {
    // A presentation that keyed on the label would be a second source of truth
    // for the property §2.2 forbids overstating, and the two would disagree the
    // first time a label was reworded.
    for (const text of HOSTED_CONNECTION_STATUS_TEXTS) {
      const real = HOSTED_CONNECTION_STATUS_INDICATORS[text];
      expect(hostedConnectionStatusPresentation(real), text).toEqual(
        hostedConnectionStatusPresentation(indicator(real.guarantee, real.connected, "Renamed")),
      );
    }
  });

  it("is decided by the claim alone wherever a claim exists", () => {
    // Connectedness may not move a claimed state's presentation: a `legacy`
    // channel is a usable session, and the whole defect was reading it as one.
    for (const guarantee of ["legacy", "web", "account", "e2ee"] as const) {
      expect(hostedConnectionStatusPresentation(indicator(guarantee, true)), guarantee).toEqual(
        hostedConnectionStatusPresentation(indicator(guarantee, false)),
      );
    }
  });

  it("falls through to reachability only where there is no claim", () => {
    expect(hostedConnectionStatusPresentation(indicator("none", true)).glyph).toBe("connected");
    expect(hostedConnectionStatusPresentation(indicator("none", false)).glyph).toBe("disconnected");
  });
});

describe("§2.2 no stronger claim for a weaker configuration", () => {
  // There is no ordinal to assert here. The field this suite used to rank —
  // `claimRank` — had no reader outside these lines, so the ordering it stated
  // was a fact about a map rather than about anything a user sees; the mutant
  // that swapped its ends turned exactly one node assertion red and left every
  // rendered surface green. What §2.2 constrains is that the three claims stay
  // tellable apart, which is what the glyph and colour cases below assert and
  // what `HostedConnectionControls.browser.tsx` re-checks against drawn colour
  // and drawn path.

  it("never draws the browser row the way the native verified row is drawn", () => {
    // The claim this slice is forbidden to make, as an assertion: a Hub that
    // controls the served JavaScript can complete a genuine NX handshake and
    // display a genuine `WebSAS`, so §2.2's web row may not borrow the signed
    // tier's glyph or its colour (§2.4).
    const web = hostedConnectionStatusPresentation(indicator("web", true));
    const native = hostedConnectionStatusPresentation(indicator("e2ee", true));
    expect(web.glyph).not.toBe(native.glyph);
    expect(web.iconClassName).not.toBe(native.iconClassName);
  });

  it("never draws a claimed state the way an unclaimed connected one is drawn", () => {
    // `Online` — a usable session with no channel — is the success colour, and
    // §12.2's fallback and §2.2's web row must both be distinguishable from it.
    const plain = hostedConnectionStatusPresentation(indicator("none", true));
    for (const guarantee of ["legacy", "web"] as const) {
      const claimed = hostedConnectionStatusPresentation(indicator(guarantee, true));
      expect(claimed.glyph, guarantee).not.toBe(plain.glyph);
    }
  });

  it("gives every claim its own glyph and its own colour", () => {
    // Text and icon in every state, never colour alone — and never one glyph
    // standing in for two claims.
    const presentations = (["none", "legacy", "web", "account", "e2ee"] as const).map((guarantee) =>
      hostedConnectionStatusPresentation(indicator(guarantee, true)),
    );
    expect(new Set(presentations.map((entry) => entry.glyph)).size).toBe(presentations.length);
    // Colours may repeat where the glyphs already separate the rows — the
    // disconnected amber and the legacy amber are both "something is wrong" —
    // but the three states that ASSERT something must not share one.
    const claimedTones = (["legacy", "web", "account", "e2ee"] as const).map(
      (guarantee) => hostedConnectionStatusPresentation(indicator(guarantee, true)).iconClassName,
    );
    expect(new Set(claimedTones).size).toBe(claimedTones.length);
  });

  it("uses no hardcoded colour values", () => {
    for (const guarantee of ["none", "legacy", "web", "account", "e2ee"] as const) {
      for (const connected of [true, false]) {
        const { iconClassName } = hostedConnectionStatusPresentation(
          indicator(guarantee, connected),
        );
        expect(iconClassName, guarantee).not.toMatch(/#[0-9a-f]{3,8}\b/iu);
        expect(iconClassName, guarantee).not.toMatch(/\brgba?\(/u);
        expect(iconClassName, guarantee).not.toMatch(/\bdark:/u);
      }
    }
  });
});
