/**
 * `ryco e2ee`: the relay E2EE operator surface.
 */
import { NodeE2eeAdmissionPolicy, SpaceRole } from "@ryco/contracts";
import { Console, Effect, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { HttpClientRequest, HttpClientResponse } from "effect/http";
import {
  E2eeAuthorizationChangeView,
  E2eeClientListingView,
  E2eeClientRecordView,
  E2eeContinuityChangeView,
  E2eeCrossDeviceApprovalView,
  E2eeContinuityView,
  E2eeFallbackView,
  E2eePolicyChangeView,
  E2eePolicyPreviewView,
  E2eePolicyView,
  E2eePrekeyView,
  E2eeSessionListView,
} from "../hubConnector/e2eeOperatorContract.ts";
import { loadTerminalQrCode } from "../startupAccess.ts";
import { authLocationFlags, emitJson, jsonFlag } from "./flags.ts";
import {
  HUB_CLI_LIVE_SERVER_TIMEOUT,
  readErrorMessageFromResponse,
  runHubCommand,
  runLiveServerRequest,
} from "./runtime.ts";

// ─── the relay E2EE operator surface (§6.4, §7.5, §12.3–§12.6, §13.4–§13.6) ──
//
// A sibling family of `hub` rather than a subtree of it. `hub`'s six subcommands
// are connector-lifecycle verbs — enroll, cancel, resume, leave — and every one
// of them is about this node's relationship with a Hub. These are about the
// node's own security state: the Branch A record set outlives any connector
// state, the admission policy is the operator's and not the Hub's (§12.4), and
// the §7.5 lineage survives a `leave` on purpose.
//
// EVERY COMMAND HERE REQUIRES THE RUNNING SERVER, and that is not a limitation
// to be worked around. §13.6 forbids acknowledging a withdrawal before every
// affected channel is closed, §12.6 forbids it before the sweep completes, and
// only the live connector holds those channels. An offline mode would answer
// exactly the questions whose answers would then be false.

const e2eeHubOriginFlag = Flag.String("hub-origin").pipe(
  Flag.withDescription("Hub origin of the client authorization record (§13.6 record key)."),
);

const e2eeAccountIdFlag = Flag.String("account-id").pipe(
  Flag.withDescription("Account id of the client authorization record (§13.6 record key)."),
);

/**
 * The third element of the §13.6 key, in the §7.1 display form.
 *
 * An argument rather than a flag: it is the thing the command is about, and it
 * is the value the owner reads off the device they are pairing — the same
 * `SHA256:`-prefixed string `ryco hub enroll` already prints for this node.
 */
const e2eeFingerprintArgument = Argument.String("fingerprint").pipe(
  Argument.withDescription("Client key fingerprint in SHA256: display form (§7.1)."),
);

const e2eeMaxRoleFlag = Flag.Literals("max-role", SpaceRole.literals).pipe(
  Flag.withDescription("Maximum role this client key may exercise (§8.3 role ordering)."),
);

const e2eeCapabilityFlag = Flag.String("capability").pipe(
  Flag.withDescription("Relay capability to grant. Repeat the flag to grant more than one."),
  Flag.atLeast(1),
);

const e2eeLabelFlag = Flag.String("label").pipe(
  Flag.withDescription("Optional owner-assigned label for this record."),
  Flag.optional,
);

const e2eeClientKeyFlags = {
  hubOrigin: e2eeHubOriginFlag,
  accountId: e2eeAccountIdFlag,
} as const;

const e2eeRequireE2eeFlag = Flag.Boolean("require-e2ee").pipe(
  Flag.withDescription(
    "Reject plaintext relay payloads (§12.3). Enabling it closes every open legacy channel.",
  ),
  Flag.optional,
);

const e2eePolicyModeFlag = Flag.Literals("mode", NodeE2eeAdmissionPolicy.literals).pipe(
  Flag.withDescription(
    "Admission mode: compatibility, require-e2ee, require-native-e2ee, or require-locally-approved-native-e2ee.",
  ),
  Flag.optional,
);

const e2eeRequireApprovedClientFlag = Flag.Boolean("require-approved-client-e2ee").pipe(
  Flag.withDescription(
    "Admit only approved native client keys (§12.4). Disables web access entirely.",
  ),
  Flag.optional,
);

/**
 * §7.6 element 9, as an owner states it: the REPLACEMENT registry, repeated.
 *
 * §12.6 makes "a suite leaving the advertised registry" one of its three
 * withdrawal classes, with its own `suiteWithdrawn` count in step (c). Without
 * an input path the node could report that count and no operator command could
 * ever produce it, which leaves part of §12.6's withdrawal surface unreachable
 * — the sweep exists, the policy field exists, and nothing can set it.
 *
 * The whole set travels, not a member to add or drop, for the same reason
 * `client narrow` takes the replacement capability set: §12.6's test is over the
 * resulting registry, so the owner states what is kept and the node decides
 * whether that is a reduction.
 */
const e2eeSuiteFlag = Flag.Int("suite").pipe(
  Flag.withDescription(
    "Suite id to advertise (§3.4 registry). Repeat the flag for each suite kept; the set replaces the current registry.",
  ),
  Flag.atLeast(1),
  Flag.optional,
);

const e2eeAdoptFlag = Flag.String("adopt").pipe(
  Flag.withDescription("Re-adopt this continuity id, keeping every existing client verification."),
  Flag.optional,
);

const e2eeBreakFlag = Flag.Boolean("break").pipe(
  Flag.withDescription(
    "Break continuity and mint a fresh id. Every paired client must verify this node again.",
  ),
  Flag.withDefault(false),
);

const e2eeRequest = <A, I, RD>(
  origin: string,
  bearerToken: string,
  path: string,
  schema: Schema.Codec<A, I, RD>,
  body?: unknown,
) => {
  const request =
    body === undefined
      ? Effect.succeed(
          HttpClientRequest.get(`${origin}${path}`).pipe(
            HttpClientRequest.acceptJson,
            HttpClientRequest.bearerToken(bearerToken),
          ),
        )
      : HttpClientRequest.post(`${origin}${path}`).pipe(
          HttpClientRequest.acceptJson,
          HttpClientRequest.bearerToken(bearerToken),
          HttpClientRequest.bodyJson(body),
        );
  return request.pipe(
    Effect.flatMap((prepared) =>
      runLiveServerRequest(
        prepared,
        HttpClientResponse.matchStatus({
          "2xx": (response) => HttpClientResponse.schemaBodyJson(schema)(response),
          orElse: (response) =>
            readErrorMessageFromResponse(response).pipe(
              Effect.flatMap((message) => Effect.fail(new Error(message))),
            ),
        }),
        HUB_CLI_LIVE_SERVER_TIMEOUT,
      ),
    ),
  );
};

const formatEpoch = (value: number | undefined): string =>
  value === undefined ? "never" : new Date(value).toISOString();

/**
 * One record, in the presentation convention `ryco hub enroll` established:
 * `Label: value` lines, one `Console.log`, and the fingerprint rendered as the
 * `SHA256:` display form under the label `Fingerprint`.
 */
const formatE2eeClientRecord = (record: E2eeClientRecordView): readonly string[] => [
  `Fingerprint: ${record.fingerprint}`,
  `Status: ${record.status}`,
  `Hub origin: ${record.hubOrigin}`,
  `Account: ${record.accountId}`,
  `Max role: ${record.maxRole}`,
  // The role the device connects with. An approval below it refuses the device
  // rather than limiting it (§8.3), so this is the `--max-role` an owner wants.
  // The node follows it only while the record is pending; once approved or
  // revoked it is the role from the device's introduction, and says so.
  ...(record.observedRole === undefined
    ? []
    : [
        record.status === "pending"
          ? `Connects as: ${record.observedRole}`
          : `Connected as (when introduced): ${record.observedRole}`,
      ]),
  `Capabilities: ${record.capabilitySet.length === 0 ? "none" : record.capabilitySet.join(", ")}`,
  ...(record.displayLabel === undefined ? [] : [`Label: ${record.displayLabel}`]),
  // §13.6's display duty enumerates the safety number among the fields the
  // LISTING carries, not only the fields one record's own command does — and
  // §13.4 makes it the value an owner compares before trusting a record at all.
  // Printing it here is what makes `list` usable for the comparison; leaving it
  // to `show` alone made the listing's own duty unmet and forced an owner to run
  // one command per record to do the thing the records exist for.
  `Safety number: ${record.safetyNumber}`,
  `Created: ${formatEpoch(record.createdAt)}`,
  ...(record.approvedAt === undefined ? [] : [`Approved: ${formatEpoch(record.approvedAt)}`]),
  ...(record.revokedAt === undefined ? [] : [`Revoked: ${formatEpoch(record.revokedAt)}`]),
  `Last seen: ${formatEpoch(record.lastSeenAt)}`,
  ...(record.pairingReserved ? ["Pairing reservation: held"] : []),
];

const formatE2eeClientListing = (listing: E2eeClientListingView, json: boolean): string => {
  if (json) return emitJson(listing);
  const lines: string[] = [];
  if (listing.records.length === 0) {
    lines.push("No client authorization records.");
  }
  for (const record of listing.records) {
    lines.push(...formatE2eeClientRecord(record), "");
  }
  // §13.6's instrumentation duties, stated as their own lines rather than left
  // for the owner to infer from record counts — which is the exact inference the
  // spec says the display must remove.
  lines.push(
    `Pending global cap: ${listing.pendingGlobalSaturated ? "SATURATED" : "not saturated"}`,
  );
  lines.push(
    `Saturated accounts: ${
      listing.saturatedAccounts.length === 0
        ? "none"
        : listing.saturatedAccounts
            .map((account) => `${account.hubOrigin} ${account.accountId}`)
            .join(", ")
    }`,
  );
  // §13.6 makes this count "bounded, owner-clearable", so the display names the
  // action that clears it: a counter an owner can read and cannot reset stops
  // being instrumentation after the first flood, because every later reading is
  // dominated by history the owner has already dealt with.
  lines.push(
    `Pairing attempts refused for pending cap: ${listing.refusedPairingAttempts}${
      listing.refusedPairingAttempts === 0 ? "" : " (clear with: ryco e2ee client clear-refusals)"
    }`,
  );
  if (listing.pairingWindow === undefined) {
    lines.push("Pairing window: closed");
  } else {
    // All three facts §13.6 names, so the owner can tell "my device has not
    // reached the node" from "some other attempt consumed the window".
    lines.push("Pairing window: open");
    lines.push(`Pairing window fingerprint: ${listing.pairingWindow.fingerprint}`);
    lines.push(`Pairing window expires: ${formatEpoch(listing.pairingWindow.expiresAt)}`);
    lines.push(`Pairing window reservation: ${listing.pairingWindow.spent ? "spent" : "unspent"}`);
  }
  if (listing.pendingGlobalSaturated || listing.saturatedAccounts.length > 0) {
    lines.push(
      "Pending pairing is saturated. Purge a pending record, or read the fingerprint off the device and open a pairing window naming it.",
    );
  }
  return lines.join("\n");
};

/**
 * §13.6: a command that performs a withdrawal MUST report how many channels it
 * closed, and MUST NOT return before the ordering has completed.
 *
 * The counts are printed for every authorization command, not only the
 * narrowing ones, because a widening command reporting nothing is one an owner
 * cannot distinguish from a narrowing command that swept nothing.
 */
const formatE2eeAuthorizationChange = (
  change: E2eeAuthorizationChangeView,
  verb: string,
  json: boolean,
): string => {
  if (json) return emitJson(change);
  return [
    ...(change.record === undefined ? [] : formatE2eeClientRecord(change.record)),
    `${verb}. Closed ${change.closedChannels} active E2EE channel(s) and aborted ${change.abortedHandshakes} in-flight handshake(s).`,
  ].join("\n");
};

const formatE2eeSessions = (view: E2eeSessionListView, json: boolean): string => {
  if (json) return emitJson(view);
  if (view.sessions.length === 0) return "No established E2EE sessions.";
  const lines: string[] = [];
  for (const session of view.sessions) {
    lines.push(`Session: ${session.sessionIndex}`);
    lines.push(`Tier: ${session.tier}`);
    lines.push(`Suite: ${session.suite}`);
    lines.push(`Established: ${formatEpoch(session.establishedAt)}`);
    if (session.verificationCode === undefined) {
      // §13.5 has no native meaning: the long-term §13.4 value is the one to
      // compare for a signed client, and it is on the record, not on the session.
      lines.push("Verification code: not applicable (compare the safety number instead)");
    } else {
      lines.push(`Verification code: ${session.verificationCode}`);
    }
    lines.push("");
  }
  // §13.5's advisory-only disclosure duty, in the words the spec constrains it
  // to: what the comparison catches, and what it cannot protect against.
  lines.push(
    "Compare this code with the one shown in the web session. A match catches accidental wrong-node routing and some network interposition while the loaded code is honest; it cannot protect against the Hub operator, who serves that code, and a match is not proof that no interposer is present.",
  );
  return lines.join("\n");
};

const formatE2eePolicy = (policy: E2eePolicyView, json: boolean): string => {
  if (json) return emitJson(policy);
  return [
    `Mode: ${policy.mode}`,
    `requireE2EE: ${policy.requireE2EE}`,
    `requireApprovedClientE2EE: ${policy.requireApprovedClientE2EE}`,
    `Effective requireE2EE: ${policy.effectiveRequireE2EE}`,
    `Admitted patterns: ${policy.admittedPatterns.join(", ")}`,
    `Suite registry: ${policy.suiteRegistry.join(", ")}`,
    `Policy generation: ${policy.generation}`,
  ].join("\n");
};

/**
 * §12.4's operator lockout warning, and §12.6's "roughly how many currently
 * match", printed BEFORE the change runs.
 *
 * §12.4 requires the warning at enable time and requires it to say three things:
 * that the policy disables web and legacy access entirely, that it can strand
 * remote access if every approved native client key is lost, and that enabling
 * it closes the live channels the policy no longer admits.
 */
const formatE2eePolicyWarning = (preview: E2eePolicyPreviewView, requestingStrict: boolean) => {
  const lines: string[] = [];
  if (requestingStrict) {
    lines.push(
      "WARNING: requireApprovedClientE2EE disables web and legacy access entirely. Only approved native client keys reach application payload, and losing every approved key strands remote access to this node until it is recovered locally, which never relaxes admission policy.",
    );
  }
  if (preview.withdrawal) {
    lines.push(
      `This is a policy withdrawal: it will close live channels. Currently matching, approximately — legacy ${preview.counts.legacy}, NX E2EE ${preview.counts.nxE2ee}, suite-withdrawn E2EE ${preview.counts.suiteWithdrawn}, in-flight handshakes ${preview.counts.abortedHandshakes}.`,
    );
  }
  return lines;
};

const formatE2eePolicyChange = (change: E2eePolicyChangeView, json: boolean): string => {
  if (json) return emitJson(change);
  return [
    formatE2eePolicy(change.policy, false),
    change.changed ? "Policy committed." : "Policy unchanged.",
    // §12.6(c): the counts, broken out by class, and the in-flight aborts. They
    // describe what step (b) actually terminated, which is why they are printed
    // even when this transition changed nothing — a retry after a failed sweep
    // arrives with `changed` false and still closes what the first attempt could
    // not.
    `Closed ${change.counts.legacy} legacy channel(s), ${change.counts.nxE2ee} NX E2EE channel(s), ${change.counts.suiteWithdrawn} suite-withdrawn E2EE channel(s); aborted ${change.counts.abortedHandshakes} in-flight handshake(s).`,
  ].join("\n");
};

/**
 * One agreement prekey, in the §6.4 vocabulary.
 *
 * `trailer` is what the command that produced this view has to add — "rotated",
 * or nothing for a read — and the §6.4 REMEDY is appended after it whenever the
 * certificate is expired. The remedy travels on the view from the module that
 * defines the diagnostic, so this surface prints §6.4's words rather than its
 * own, and an operator who reads `Validity: expired` is told in the same breath
 * what to run.
 */
const formatE2eePrekey = (view: E2eePrekeyView, json: boolean, trailer?: string): string => {
  if (json) return emitJson(view);
  if (!view.present) {
    return [
      "Prekey: none",
      "This node holds no agreement prekey for its configured Hub origin. It re-signs one at startup; run `ryco e2ee prekey rotate` to issue one now.",
    ].join("\n");
  }
  return [
    `Prekey: ${view.prekeyId ?? "unset"}`,
    `Fingerprint: ${view.fingerprint ?? "unset"}`,
    `Created: ${formatEpoch(view.createdAt)}`,
    `Expires: ${formatEpoch(view.expiresAt)}`,
    `Validity: ${view.validity ?? "unknown"}`,
    ...(trailer === undefined ? [] : [trailer]),
    ...(view.remedy === undefined ? [] : [view.remedy]),
  ].join("\n");
};

const formatE2eeContinuity = (view: E2eeContinuityView, json: boolean): string => {
  if (json) return emitJson(view);
  if (view.status === "unavailable") {
    return [
      "Continuity: UNRESOLVABLE",
      `Reason: ${view.reason ?? "unknown"}`,
      // §7.5's own remedy sentence, carried from the store that raised the
      // condition rather than restated here.
      view.remedy ?? "",
    ]
      .filter((line) => line.length > 0)
      .join("\n");
  }
  if (view.status === "identity_in_use") {
    // Not a lineage state: this backend does not own the identity, and the
    // sentence says which copy to ask.
    return ["Continuity: not read here", view.remedy ?? ""]
      .filter((line) => line.length > 0)
      .join("\n");
  }
  return [
    "Continuity: advertisable",
    `Continuity id: ${view.continuityId ?? "unset"}`,
    `Rotation generation: ${view.generation ?? 0}`,
    `Retained chain length: ${view.chainLength ?? 0}`,
    ...(view.repair === undefined ? [] : [`Startup repair: ${view.repair}`]),
    ...(view.chainBreak === undefined ? [] : [`Chain break: ${view.chainBreak}`]),
    ...(view.lastBreakReason === undefined
      ? []
      : [`Last break: ${view.lastBreakReason} at ${formatEpoch(view.lastBreakAt)}`]),
  ].join("\n");
};

const formatE2eeContinuityChange = (view: E2eeContinuityChangeView, json: boolean): string => {
  if (json) return emitJson(view);
  switch (view.outcome) {
    case "adopted":
      return [
        `Continuity id: ${view.continuityId ?? "unset"}`,
        "Re-adopted. Every existing client verification is kept.",
      ].join("\n");
    case "reminted":
      return [
        `Continuity id: ${view.continuityId ?? "unset"}`,
        "Continuity broken and a fresh id minted. Every paired client takes the re-verification path and needs a fresh pairing ceremony.",
      ].join("\n");
    case "chain_broken":
      return "Continuity chain broken deliberately. The lineage id is kept; every pinned client takes the re-verification path and needs a fresh pairing ceremony.";
  }
};

const formatE2eeFallback = (view: E2eeFallbackView, json: boolean): string => {
  if (json) return emitJson(view);
  const lines: string[] = [
    `Observation window started: ${formatEpoch(view.windowStartedAt)}`,
    // §12.5: both counters, SEPARATELY and never as a single total.
    `peer-legacy occurrences: ${view.peerLegacy.occurrences}`,
    `peer-legacy last occurrence: ${formatEpoch(view.peerLegacy.lastOccurrenceAt)}`,
    `advertisement-unavailable occurrences: ${view.advertisementUnavailable.occurrences}`,
    `advertisement-unavailable last occurrence: ${formatEpoch(
      view.advertisementUnavailable.lastOccurrenceAt,
    )}`,
  ];
  lines.push(`Retained occurrences: ${view.ring.length}`);
  for (const entry of view.ring) {
    lines.push(`  ${formatEpoch(entry.occurredAt)} ${entry.reason}`);
  }
  // §12.5: a nonzero ring-overflow count MUST be displayed ADJACENT to the ring
  // and labelled as what it means, so a reader cannot take a truncated ring for
  // the whole picture.
  lines.push(`peer-legacy ring overflows: ${view.peerLegacy.ringOverflows}`);
  lines.push(
    `advertisement-unavailable ring overflows: ${view.advertisementUnavailable.ringOverflows}`,
  );
  if (view.peerLegacy.ringOverflows > 0 || view.advertisementUnavailable.ringOverflows > 0) {
    lines.push(
      "The ring overflowed: it is an incomplete account of this window, and the shape of the retained occurrences is not evidence in either direction.",
    );
  }
  // §12.5: "For a live `undersized-connection` condition it MUST also display
  // the asserted `maxDataChunkBytes` and `E2EE_ADVERTISEMENT_MIN_CHUNK_BYTES`."
  // Both numbers, because the condition is the COMPARISON between them and one
  // of them alone tells an operator nothing about whether it holds. Absent when
  // the condition is not live: §12.5 scopes the pair to the current connection
  // and forbids retaining it in the ring, so there is nothing to show.
  if (view.undersizedConnection !== undefined) {
    lines.push(
      `Undersized connection: asserted maxDataChunkBytes ${view.undersizedConnection.assertedMaxDataChunkBytes} is below E2EE_ADVERTISEMENT_MIN_CHUNK_BYTES ${view.undersizedConnection.advertisementMinChunkBytes}; no conforming capability carrier fits, so this node advertises nothing on this connection.`,
    );
  }
  return lines.join("\n");
};

const e2eeClientListCommand = Command.make("list", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "List client authorization records with their status, authority, and fingerprint (§13.6).",
  ),
  Command.withHandler((flags) =>
    runHubCommand(
      flags,
      (origin, token) => e2eeRequest(origin, token, "/api/hub/e2ee/clients", E2eeClientListingView),
      { quietLogs: flags.json },
    ).pipe(Effect.flatMap((listing) => Console.log(formatE2eeClientListing(listing, flags.json)))),
  ),
);

const e2eeClientShowCommand = Command.make("show", {
  ...authLocationFlags,
  ...e2eeClientKeyFlags,
  fingerprint: e2eeFingerprintArgument,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Show one client authorization record and its long-term safety number (§13.4).",
  ),
  Command.withHandler((flags) =>
    runHubCommand(
      flags,
      (origin, token) =>
        e2eeRequest(origin, token, "/api/hub/e2ee/clients/read", E2eeClientRecordView, {
          hubOrigin: flags.hubOrigin,
          accountId: flags.accountId,
          fingerprint: flags.fingerprint,
        }),
      { quietLogs: flags.json },
    ).pipe(
      Effect.flatMap((record) =>
        Console.log(
          flags.json
            ? emitJson(record)
            : [
                ...formatE2eeClientRecord(record),
                "Compare this safety number with the one displayed on the client device before trusting this record.",
              ].join("\n"),
        ),
      ),
    ),
  ),
);

const e2eeClientApproveCommand = Command.make("approve", {
  ...authLocationFlags,
  ...e2eeClientKeyFlags,
  fingerprint: e2eeFingerprintArgument,
  maxRole: e2eeMaxRoleFlag,
  capability: e2eeCapabilityFlag,
  label: e2eeLabelFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Approve a client key with an explicit maximum role and capability set (§13.6).",
  ),
  Command.withHandler((flags) =>
    runHubCommand(
      flags,
      (origin, token) =>
        e2eeRequest(
          origin,
          token,
          "/api/hub/e2ee/clients/authorization",
          E2eeAuthorizationChangeView,
          {
            action: "approve",
            hubOrigin: flags.hubOrigin,
            accountId: flags.accountId,
            fingerprint: flags.fingerprint,
            maxRole: flags.maxRole,
            capabilitySet: flags.capability,
            ...(Option.isSome(flags.label) ? { displayLabel: flags.label.value } : {}),
          },
        ),
      { quietLogs: flags.json },
    ).pipe(
      Effect.flatMap((change) =>
        Console.log(
          formatE2eeAuthorizationChange(
            change,
            "Approved. Widened authority takes effect on a fresh ticket, channel, and handshake, never on an open one",
            flags.json,
          ),
        ),
      ),
    ),
  ),
);

const e2eeClientApprovalQrCommand = Command.make("approval-qr", {
  ...authLocationFlags,
  ...e2eeClientKeyFlags,
  fingerprint: e2eeFingerprintArgument,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Show a short-lived node-signed QR that verifies one already approved phone.",
  ),
  Command.withHandler((flags) =>
    runHubCommand(
      flags,
      (origin, token) =>
        e2eeRequest(
          origin,
          token,
          "/api/hub/e2ee/clients/approval-qr",
          E2eeCrossDeviceApprovalView,
          {
            hubOrigin: flags.hubOrigin,
            accountId: flags.accountId,
            fingerprint: flags.fingerprint,
          },
        ),
      { quietLogs: flags.json },
    ).pipe(
      Effect.flatMap((approval) =>
        flags.json
          ? Console.log(emitJson(approval))
          : Effect.flatMap(loadTerminalQrCode, (renderQrCode) =>
              Console.log(
                [
                  "Scan this code in Ryco on the approved phone. It expires after five minutes.",
                  renderQrCode(approval.payload),
                  "The code grants no access by itself; the phone still reconnects with a fresh ticket, channel, and IK handshake.",
                ].join("\n"),
              ),
            ),
      ),
    ),
  ),
);

const e2eeClientNarrowCommand = Command.make("narrow", {
  ...authLocationFlags,
  ...e2eeClientKeyFlags,
  fingerprint: e2eeFingerprintArgument,
  maxRole: Flag.Literals("max-role", SpaceRole.literals).pipe(
    Flag.withDescription("Reduced maximum role (§8.3 role ordering). Never widens."),
    Flag.optional,
  ),
  // The REPLACEMENT set, not a member to drop: §13.6 defines the narrowing test
  // as "any change whose new set is not a superset of the old one", so the owner
  // states what is kept and the client checks that it is a reduction. Repeated
  // and optional together, because narrowing the role alone must leave the
  // capability set untouched rather than emptying it.
  capability: Flag.String("capability").pipe(
    Flag.withDescription("The reduced capability set. Repeat the flag for each member kept."),
    Flag.atLeast(1),
    Flag.optional,
  ),
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Narrow a client key's authority. Effective before this command acknowledges (§13.6).",
  ),
  Command.withHandler((flags) =>
    runHubCommand(
      flags,
      (origin, token) =>
        e2eeRequest(
          origin,
          token,
          "/api/hub/e2ee/clients/authorization",
          E2eeAuthorizationChangeView,
          {
            action: "narrow",
            hubOrigin: flags.hubOrigin,
            accountId: flags.accountId,
            fingerprint: flags.fingerprint,
            ...(Option.isSome(flags.maxRole) ? { maxRole: flags.maxRole.value } : {}),
            ...(Option.isSome(flags.capability) ? { capabilitySet: flags.capability.value } : {}),
          },
        ),
      { quietLogs: flags.json },
    ).pipe(
      Effect.flatMap((change) =>
        Console.log(formatE2eeAuthorizationChange(change, "Narrowed", flags.json)),
      ),
    ),
  ),
);

const e2eeClientRevokeCommand = Command.make("revoke", {
  ...authLocationFlags,
  ...e2eeClientKeyFlags,
  fingerprint: e2eeFingerprintArgument,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Revoke a client key. Effective before this command acknowledges (§13.6).",
  ),
  Command.withHandler((flags) =>
    runHubCommand(
      flags,
      (origin, token) =>
        e2eeRequest(
          origin,
          token,
          "/api/hub/e2ee/clients/authorization",
          E2eeAuthorizationChangeView,
          {
            action: "revoke",
            hubOrigin: flags.hubOrigin,
            accountId: flags.accountId,
            fingerprint: flags.fingerprint,
          },
        ),
      { quietLogs: flags.json },
    ).pipe(
      Effect.flatMap((change) =>
        Console.log(formatE2eeAuthorizationChange(change, "Revoked", flags.json)),
      ),
    ),
  ),
);

const e2eeClientPurgeCommand = Command.make("purge", {
  ...authLocationFlags,
  ...e2eeClientKeyFlags,
  fingerprint: e2eeFingerprintArgument,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Purge a record, freeing its slot against both pending caps (§13.6)."),
  Command.withHandler((flags) =>
    runHubCommand(
      flags,
      (origin, token) =>
        e2eeRequest(
          origin,
          token,
          "/api/hub/e2ee/clients/authorization",
          E2eeAuthorizationChangeView,
          {
            action: "purge",
            hubOrigin: flags.hubOrigin,
            accountId: flags.accountId,
            fingerprint: flags.fingerprint,
          },
        ),
      { quietLogs: flags.json },
    ).pipe(
      Effect.flatMap((change) =>
        Console.log(formatE2eeAuthorizationChange(change, "Purged", flags.json)),
      ),
    ),
  ),
);

const e2eeWindowOpenCommand = Command.make("open", {
  ...authLocationFlags,
  fingerprint: e2eeFingerprintArgument,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Open a pairing window for one named client key. The discriminator is required (§13.6).",
  ),
  Command.withHandler((flags) =>
    runHubCommand(
      flags,
      (origin, token) =>
        e2eeRequest(origin, token, "/api/hub/e2ee/clients/pairing-window", E2eeClientListingView, {
          action: "open",
          fingerprint: flags.fingerprint,
        }),
      { quietLogs: flags.json },
    ).pipe(Effect.flatMap((listing) => Console.log(formatE2eeClientListing(listing, flags.json)))),
  ),
);

const e2eeWindowCloseCommand = Command.make("close", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Close the owner-opened pairing window."),
  Command.withHandler((flags) =>
    runHubCommand(
      flags,
      (origin, token) =>
        e2eeRequest(origin, token, "/api/hub/e2ee/clients/pairing-window", E2eeClientListingView, {
          action: "close",
        }),
      { quietLogs: flags.json },
    ).pipe(Effect.flatMap((listing) => Console.log(formatE2eeClientListing(listing, flags.json)))),
  ),
);

/**
 * §13.6: the count the listing shows is owner-CLEARABLE, and this is what clears
 * it.
 *
 * A command rather than an automatic decay, for the same reason §12.5's counters
 * have one: the count exists so an owner can see a denial they did not cause,
 * and anything that zeroed it without the owner asking would erase the evidence
 * before they read it.
 */
const e2eeClientClearRefusalsCommand = Command.make("clear-refusals", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Clear the count of pairing attempts refused for a pending cap (§13.6). Frees no slot.",
  ),
  Command.withHandler((flags) =>
    runHubCommand(
      flags,
      (origin, token) =>
        e2eeRequest(
          origin,
          token,
          "/api/hub/e2ee/clients/refusals/clear",
          E2eeClientListingView,
          {},
        ),
      { quietLogs: flags.json },
    ).pipe(Effect.flatMap((listing) => Console.log(formatE2eeClientListing(listing, flags.json)))),
  ),
);

const e2eeWindowCommand = Command.make("window").pipe(
  Command.withDescription("Manage the owner-opened pairing window (§13.6)."),
  Command.withSubcommands([e2eeWindowOpenCommand, e2eeWindowCloseCommand]),
);

const e2eeClientCommand = Command.make("client").pipe(
  Command.withDescription("Manage client authorization records (§13.6 Branch A record set)."),
  Command.withSubcommands([
    e2eeClientListCommand,
    e2eeClientShowCommand,
    e2eeClientApproveCommand,
    e2eeClientApprovalQrCommand,
    e2eeClientNarrowCommand,
    e2eeClientRevokeCommand,
    e2eeClientPurgeCommand,
    e2eeClientClearRefusalsCommand,
    e2eeWindowCommand,
  ]),
);

const e2eeSessionsCommand = Command.make("sessions", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Show the advisory per-session verification code for each established session (§13.5).",
  ),
  Command.withHandler((flags) =>
    runHubCommand(
      flags,
      (origin, token) => e2eeRequest(origin, token, "/api/hub/e2ee/sessions", E2eeSessionListView),
      { quietLogs: flags.json },
    ).pipe(Effect.flatMap((view) => Console.log(formatE2eeSessions(view, flags.json)))),
  ),
);

const e2eePolicyShowCommand = Command.make("show", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Show the effective node admission policy (§12.3, §12.4)."),
  Command.withHandler((flags) =>
    runHubCommand(
      flags,
      (origin, token) => e2eeRequest(origin, token, "/api/hub/e2ee/policy", E2eePolicyView),
      { quietLogs: flags.json },
    ).pipe(Effect.flatMap((policy) => Console.log(formatE2eePolicy(policy, flags.json)))),
  ),
);

const e2eePolicySetCommand = Command.make("set", {
  ...authLocationFlags,
  mode: e2eePolicyModeFlag,
  requireE2EE: e2eeRequireE2eeFlag,
  requireApprovedClientE2EE: e2eeRequireApprovedClientFlag,
  suite: e2eeSuiteFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Change the node admission policy. A narrowing change closes the live channels it no longer admits (§12.6).",
  ),
  Command.withHandler((flags) => {
    const proposal = {
      ...(Option.isSome(flags.mode) ? { mode: flags.mode.value } : {}),
      ...(Option.isSome(flags.requireE2EE) ? { requireE2EE: flags.requireE2EE.value } : {}),
      ...(Option.isSome(flags.requireApprovedClientE2EE)
        ? { requireApprovedClientE2EE: flags.requireApprovedClientE2EE.value }
        : {}),
      ...(Option.isSome(flags.suite) ? { suiteRegistry: flags.suite.value } : {}),
    };
    const requestingStrict =
      (Option.isSome(flags.mode) && flags.mode.value === "require-locally-approved-native-e2ee") ||
      (Option.isSome(flags.requireApprovedClientE2EE) && flags.requireApprovedClientE2EE.value);
    return runHubCommand(
      flags,
      (origin, token) =>
        Effect.gen(function* () {
          // §12.6's display duty: warn AT THE POINT the withdrawal is requested,
          // and say roughly how many channels currently match. The preview is a
          // separate request that mutates nothing, so the warning is printed
          // before anything has been committed or swept.
          const preview = yield* e2eeRequest(
            origin,
            token,
            "/api/hub/e2ee/policy/preview",
            E2eePolicyPreviewView,
            proposal,
          );
          const warnings = formatE2eePolicyWarning(preview, requestingStrict);
          // §12.4's lockout warning and §12.6's pre-change warning are DUTIES,
          // not decoration, so `--json` moves them rather than dropping them.
          // They go to stderr, which is not the document's channel, and the same
          // sentences travel inside the document as `warnings` — so a consumer
          // that only reads stdout still receives them, and one that pipes
          // stderr to a terminal sees them where a human would. Dropping them
          // was the shape that made `--json` the quiet way to skip a warning.
          if (warnings.length > 0) {
            yield* flags.json
              ? Console.error(warnings.join("\n"))
              : Console.log(warnings.join("\n"));
          }
          const change = yield* e2eeRequest(
            origin,
            token,
            "/api/hub/e2ee/policy",
            E2eePolicyChangeView,
            proposal,
          );
          // The preview is carried into the answer rather than discarded: it is
          // what the warning was computed from, and a machine consumer that
          // cannot see the warning needs the numbers behind it to make the same
          // decision an operator makes reading the sentence.
          return { change, preview, warnings };
        }),
      { quietLogs: flags.json },
    ).pipe(
      Effect.flatMap(({ change, preview, warnings }) =>
        Console.log(
          flags.json
            ? emitJson({ ...change, warnings, preview })
            : formatE2eePolicyChange(change, false),
        ),
      ),
    );
  }),
);

/**
 * §5.7's recovery command.
 *
 * The condition is a node whose advertised policy generation is BELOW its
 * durable high-water mark — a restore rolled the record back — and §5.7 says the
 * node must then not advertise, must not reuse the lower value, and must surface
 * exactly one explicit command that durably advances the generation to a value
 * strictly greater than any it may previously have advertised.
 *
 * The warning §5.7 mandates is printed BEFORE the jump and says both things it
 * requires: that clients accept only a strictly higher value, and that the jump
 * is deliberate. The recovery may also NARROW: the store refuses to re-adopt the
 * values of a record the mark says was rolled back and commits §12.4's
 * fail-closed policy instead, so this reports the §12.6 counts like any other
 * withdrawal, and widening back is a separate explicit `policy set`.
 */
const e2eePolicyRecoverCommand = Command.make("recover", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Recover a rolled-back policy generation: advance it past this node's durable high-water mark (§5.7).",
  ),
  Command.withHandler((flags) => {
    const warning =
      "WARNING: this advances the policy generation past every value this node may previously have advertised, and the jump is deliberate. Clients accept only a strictly higher generation than the one they remember, so nothing below the new value can be advertised again. If the durable record was rolled back, recovery commits the fail-closed policy rather than re-adopting the restored values; widen it back with an explicit `ryco e2ee policy set`.";
    return runHubCommand(
      flags,
      (origin, token) =>
        Effect.gen(function* () {
          yield* flags.json ? Console.error(warning) : Console.log(warning);
          return yield* e2eeRequest(
            origin,
            token,
            "/api/hub/e2ee/policy/recover",
            E2eePolicyChangeView,
            {},
          );
        }),
      { quietLogs: flags.json },
    ).pipe(
      Effect.flatMap((change) =>
        Console.log(
          flags.json
            ? emitJson({ ...change, warnings: [warning] })
            : [
                formatE2eePolicyChange(change, false),
                `Policy generation recovered. The next advertisement carries generation ${String(change.policy.generation)}.`,
              ].join("\n"),
        ),
      ),
    );
  }),
);

const e2eePolicyCommand = Command.make("policy").pipe(
  Command.withDescription("Inspect and change the node admission policy (§12.3–§12.6)."),
  Command.withSubcommands([e2eePolicyShowCommand, e2eePolicySetCommand, e2eePolicyRecoverCommand]),
);

/**
 * §6.4's expiry condition, on the one surface an operator can meet it.
 *
 * A READ of the stored certificate, deliberately not of the advertised one: the
 * advertise path re-signs anything unusable, so a display built on it could
 * never show `expired` and §6.4's remedy would be a sentence no operator ever
 * sees. This is where that sentence is reachable.
 */
const e2eePrekeyShowCommand = Command.make("show", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Show the agreement prekey this node holds, its validity window, and the §6.4 remedy when it has expired.",
  ),
  Command.withHandler((flags) =>
    runHubCommand(
      flags,
      (origin, token) => e2eeRequest(origin, token, "/api/hub/e2ee/prekey", E2eePrekeyView),
      { quietLogs: flags.json },
    ).pipe(Effect.flatMap((view) => Console.log(formatE2eePrekey(view, flags.json)))),
  ),
);

const e2eePrekeyRotateCommand = Command.make("rotate", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Force an immediate agreement-prekey rotation: a new keypair and a new certificate (§6.4).",
  ),
  Command.withHandler((flags) =>
    runHubCommand(
      flags,
      (origin, token) =>
        e2eeRequest(origin, token, "/api/hub/e2ee/prekey/rotate", E2eePrekeyView, {}),
      { quietLogs: flags.json },
    ).pipe(
      Effect.flatMap((view) =>
        Console.log(
          formatE2eePrekey(
            view,
            flags.json,
            "Rotated. Established channels are unaffected; the outgoing key is retained for the rotation overlap and then destroyed.",
          ),
        ),
      ),
    ),
  ),
);

const e2eePrekeyCommand = Command.make("prekey").pipe(
  Command.withDescription("Manage this node's agreement prekey (§6.4)."),
  Command.withSubcommands([e2eePrekeyShowCommand, e2eePrekeyRotateCommand]),
);

const e2eeContinuityShowCommand = Command.make("show", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Show this node's identity-continuity lineage and chain (§7.5)."),
  Command.withHandler((flags) =>
    runHubCommand(
      flags,
      (origin, token) => e2eeRequest(origin, token, "/api/hub/e2ee/continuity", E2eeContinuityView),
      { quietLogs: flags.json },
    ).pipe(Effect.flatMap((view) => Console.log(formatE2eeContinuity(view, flags.json)))),
  ),
);

/**
 * §7.5's recovery command, with exactly two outcomes the operator must choose
 * between, and no default.
 *
 * Naming neither is an error rather than a default, and naming both is an error
 * too: §7.5 requires the choice to be deliberate, and the second outcome is
 * equivalent to a deliberate chain break — every pinned client takes the
 * re-verification path and needs a fresh pairing ceremony. The command says
 * exactly that at the point of use, which is what §7.5 asks for.
 */
const e2eeContinuityRecoverCommand = Command.make("recover", {
  ...authLocationFlags,
  adopt: e2eeAdoptFlag,
  break: e2eeBreakFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Recover an unresolvable continuity id: re-adopt a confirmed id, or deliberately break continuity (§7.5).",
  ),
  Command.withHandler((flags) => {
    const adopting = Option.isSome(flags.adopt);
    if (adopting === flags.break) {
      return Effect.fail(
        new Error(
          "Choose exactly one outcome: --adopt <continuity-id> keeps every existing client verification; --break mints a fresh id and requires every paired client to verify this node again.",
        ),
      );
    }
    return runHubCommand(
      flags,
      (origin, token) =>
        e2eeRequest(origin, token, "/api/hub/e2ee/continuity", E2eeContinuityChangeView, {
          action: adopting ? "adopt" : "remint",
          ...(Option.isSome(flags.adopt) ? { continuityId: flags.adopt.value } : {}),
        }),
      { quietLogs: flags.json },
    ).pipe(Effect.flatMap((view) => Console.log(formatE2eeContinuityChange(view, flags.json))));
  }),
);

const e2eeContinuityBreakCommand = Command.make("break", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Deliberately break the continuity chain. Every pinned client needs a fresh pairing ceremony (§7.5).",
  ),
  Command.withHandler((flags) =>
    runHubCommand(
      flags,
      (origin, token) =>
        e2eeRequest(origin, token, "/api/hub/e2ee/continuity", E2eeContinuityChangeView, {
          action: "break",
        }),
      { quietLogs: flags.json },
    ).pipe(Effect.flatMap((view) => Console.log(formatE2eeContinuityChange(view, flags.json)))),
  ),
);

const e2eeContinuityCommand = Command.make("continuity").pipe(
  Command.withDescription("Inspect and repair this node's identity lineage (§7.5)."),
  Command.withSubcommands([
    e2eeContinuityShowCommand,
    e2eeContinuityRecoverCommand,
    e2eeContinuityBreakCommand,
  ]),
);

const e2eeFallbackShowCommand = Command.make("show", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Show the fallback-occurrence counters and retained ring (§12.5)."),
  Command.withHandler((flags) =>
    runHubCommand(
      flags,
      (origin, token) => e2eeRequest(origin, token, "/api/hub/e2ee/fallback", E2eeFallbackView),
      { quietLogs: flags.json },
    ).pipe(Effect.flatMap((view) => Console.log(formatE2eeFallback(view, flags.json)))),
  ),
);

const e2eeFallbackResetCommand = Command.make("reset", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Reset both occurrence counters, both ring-overflow counters, and the ring (§12.5).",
  ),
  Command.withHandler((flags) =>
    runHubCommand(
      flags,
      (origin, token) =>
        e2eeRequest(origin, token, "/api/hub/e2ee/fallback/reset", E2eeFallbackView, {}),
      { quietLogs: flags.json },
    ).pipe(Effect.flatMap((view) => Console.log(formatE2eeFallback(view, flags.json)))),
  ),
);

const e2eeFallbackCommand = Command.make("fallback").pipe(
  Command.withDescription("Inspect and reset the fallback-occurrence instrumentation (§12.5)."),
  Command.withSubcommands([e2eeFallbackShowCommand, e2eeFallbackResetCommand]),
);

export const e2eeCommand = Command.make("e2ee").pipe(
  Command.withDescription(
    "Manage relay payload encryption: client authorization, admission policy, keys, and diagnostics.",
  ),
  Command.withSubcommands([
    e2eeClientCommand,
    e2eeSessionsCommand,
    e2eePolicyCommand,
    e2eePrekeyCommand,
    e2eeContinuityCommand,
    e2eeFallbackCommand,
  ]),
);
