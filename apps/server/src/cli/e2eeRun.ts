/**
 * What each `ryco e2ee` subcommand does: its request to the running server and the output it
 * prints. e2eeCommand.ts holds only the flags and subcommands and loads this module with
 * `import()` when one of them runs, which keeps it off the server's boot path
 * (serverBundleBoundaries.test.ts). The CLI helpers it shares with the boot path come in as
 * `E2eeRunDeps`: a static import of them here would make the bundler split boot modules into
 * extra chunks.
 *
 * @module cli/e2eeRun
 */
import { Console, Effect, Option, type Schema } from "effect";
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
import type { loadTerminalQrCode } from "../startupAccess.ts";
import type { emitJson } from "./flags.ts";
import type {
  HUB_CLI_LIVE_SERVER_TIMEOUT,
  readErrorMessageFromResponse,
  runHubCommand,
  runLiveServerRequest,
} from "./runtime.ts";
import type { CliAuthLocationFlags } from "./serverConfig.ts";

/** The flags every `ryco e2ee` subcommand takes. */
interface E2eeFlags extends CliAuthLocationFlags {
  readonly json: boolean;
}

/** The §13.6 record key: Hub origin, account and client key fingerprint. */
interface E2eeClientKeyFlags extends E2eeFlags {
  readonly hubOrigin: string;
  readonly accountId: string;
  readonly fingerprint: string;
}

interface E2eeWindowOpenFlags extends E2eeFlags {
  readonly fingerprint: string;
}

interface E2eeClientApproveFlags extends E2eeClientKeyFlags {
  readonly maxRole: string;
  readonly capability: ReadonlyArray<string>;
  readonly label: Option.Option<string>;
}

interface E2eeClientNarrowFlags extends E2eeClientKeyFlags {
  readonly maxRole: Option.Option<string>;
  readonly capability: Option.Option<ReadonlyArray<string>>;
}

interface E2eePolicySetFlags extends E2eeFlags {
  readonly mode: Option.Option<string>;
  readonly requireE2EE: Option.Option<boolean>;
  readonly requireApprovedClientE2EE: Option.Option<boolean>;
  readonly suite: Option.Option<ReadonlyArray<number>>;
}

interface E2eeContinuityRecoverFlags extends E2eeFlags {
  readonly adopt: Option.Option<string>;
  readonly break: boolean;
}

/** The CLI helpers these commands share with the rest of `ryco`, passed in by e2eeCommand.ts. */
export interface E2eeRunDeps {
  readonly runHubCommand: typeof runHubCommand;
  readonly runLiveServerRequest: typeof runLiveServerRequest;
  readonly readErrorMessageFromResponse: typeof readErrorMessageFromResponse;
  readonly liveServerTimeout: typeof HUB_CLI_LIVE_SERVER_TIMEOUT;
  readonly emitJson: typeof emitJson;
  readonly loadTerminalQrCode: typeof loadTerminalQrCode;
}

export const makeE2eeRun = ({
  runHubCommand,
  runLiveServerRequest,
  readErrorMessageFromResponse,
  liveServerTimeout,
  emitJson,
  loadTerminalQrCode,
}: E2eeRunDeps) => {
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
          liveServerTimeout,
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
      lines.push(
        `Pairing window reservation: ${listing.pairingWindow.spent ? "spent" : "unspent"}`,
      );
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

  const clientList = (flags: E2eeFlags) =>
    runHubCommand(
      flags,
      (origin, token) => e2eeRequest(origin, token, "/api/hub/e2ee/clients", E2eeClientListingView),
      { quietLogs: flags.json },
    ).pipe(Effect.flatMap((listing) => Console.log(formatE2eeClientListing(listing, flags.json))));

  const clientShow = (flags: E2eeClientKeyFlags) =>
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
    );

  const clientApprove = (flags: E2eeClientApproveFlags) =>
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
    );

  const clientApprovalQr = (flags: E2eeClientKeyFlags) =>
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
    );

  const clientNarrow = (flags: E2eeClientNarrowFlags) =>
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
    );

  const clientRevoke = (flags: E2eeClientKeyFlags) =>
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
    );

  const clientPurge = (flags: E2eeClientKeyFlags) =>
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
    );

  const windowOpen = (flags: E2eeWindowOpenFlags) =>
    runHubCommand(
      flags,
      (origin, token) =>
        e2eeRequest(origin, token, "/api/hub/e2ee/clients/pairing-window", E2eeClientListingView, {
          action: "open",
          fingerprint: flags.fingerprint,
        }),
      { quietLogs: flags.json },
    ).pipe(Effect.flatMap((listing) => Console.log(formatE2eeClientListing(listing, flags.json))));

  const windowClose = (flags: E2eeFlags) =>
    runHubCommand(
      flags,
      (origin, token) =>
        e2eeRequest(origin, token, "/api/hub/e2ee/clients/pairing-window", E2eeClientListingView, {
          action: "close",
        }),
      { quietLogs: flags.json },
    ).pipe(Effect.flatMap((listing) => Console.log(formatE2eeClientListing(listing, flags.json))));

  const clientClearRefusals = (flags: E2eeFlags) =>
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
    ).pipe(Effect.flatMap((listing) => Console.log(formatE2eeClientListing(listing, flags.json))));

  const sessions = (flags: E2eeFlags) =>
    runHubCommand(
      flags,
      (origin, token) => e2eeRequest(origin, token, "/api/hub/e2ee/sessions", E2eeSessionListView),
      { quietLogs: flags.json },
    ).pipe(Effect.flatMap((view) => Console.log(formatE2eeSessions(view, flags.json))));

  const policyShow = (flags: E2eeFlags) =>
    runHubCommand(
      flags,
      (origin, token) => e2eeRequest(origin, token, "/api/hub/e2ee/policy", E2eePolicyView),
      { quietLogs: flags.json },
    ).pipe(Effect.flatMap((policy) => Console.log(formatE2eePolicy(policy, flags.json))));

  const policySet = (flags: E2eePolicySetFlags) => {
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
  };

  const policyRecover = (flags: E2eeFlags) => {
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
  };

  const prekeyShow = (flags: E2eeFlags) =>
    runHubCommand(
      flags,
      (origin, token) => e2eeRequest(origin, token, "/api/hub/e2ee/prekey", E2eePrekeyView),
      { quietLogs: flags.json },
    ).pipe(Effect.flatMap((view) => Console.log(formatE2eePrekey(view, flags.json))));

  const prekeyRotate = (flags: E2eeFlags) =>
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
    );

  const continuityShow = (flags: E2eeFlags) =>
    runHubCommand(
      flags,
      (origin, token) => e2eeRequest(origin, token, "/api/hub/e2ee/continuity", E2eeContinuityView),
      { quietLogs: flags.json },
    ).pipe(Effect.flatMap((view) => Console.log(formatE2eeContinuity(view, flags.json))));

  const continuityRecover = (flags: E2eeContinuityRecoverFlags) => {
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
  };

  const continuityBreak = (flags: E2eeFlags) =>
    runHubCommand(
      flags,
      (origin, token) =>
        e2eeRequest(origin, token, "/api/hub/e2ee/continuity", E2eeContinuityChangeView, {
          action: "break",
        }),
      { quietLogs: flags.json },
    ).pipe(Effect.flatMap((view) => Console.log(formatE2eeContinuityChange(view, flags.json))));

  const fallbackShow = (flags: E2eeFlags) =>
    runHubCommand(
      flags,
      (origin, token) => e2eeRequest(origin, token, "/api/hub/e2ee/fallback", E2eeFallbackView),
      { quietLogs: flags.json },
    ).pipe(Effect.flatMap((view) => Console.log(formatE2eeFallback(view, flags.json))));

  const fallbackReset = (flags: E2eeFlags) =>
    runHubCommand(
      flags,
      (origin, token) =>
        e2eeRequest(origin, token, "/api/hub/e2ee/fallback/reset", E2eeFallbackView, {}),
      { quietLogs: flags.json },
    ).pipe(Effect.flatMap((view) => Console.log(formatE2eeFallback(view, flags.json))));

  return {
    clientList,
    clientShow,
    clientApprove,
    clientApprovalQr,
    clientNarrow,
    clientRevoke,
    clientPurge,
    windowOpen,
    windowClose,
    clientClearRefusals,
    sessions,
    policyShow,
    policySet,
    policyRecover,
    prekeyShow,
    prekeyRotate,
    continuityShow,
    continuityRecover,
    continuityBreak,
    fallbackShow,
    fallbackReset,
  };
};
