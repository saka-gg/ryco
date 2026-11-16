/**
 * `ryco e2ee`: the relay E2EE operator surface. This module holds the flags and subcommands;
 * what each subcommand does is in e2eeRun.ts.
 */
import { NodeE2eeAdmissionPolicy, SpaceRole } from "@ryco/contracts";
import { Effect } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { loadTerminalQrCode } from "../startupAccess.ts";
import { authLocationFlags, emitJson, jsonFlag } from "./flags.ts";
import {
  HUB_CLI_LIVE_SERVER_TIMEOUT,
  readErrorMessageFromResponse,
  runHubCommand,
  runLiveServerRequest,
} from "./runtime.ts";

/**
 * What the subcommands do (their requests and output), loaded only when one of them runs, which
 * keeps it off the server's boot path (serverBundleBoundaries.test.ts).
 */
const loadE2eeRun = Effect.promise(() => import("./e2eeRun.ts")).pipe(
  Effect.map(({ makeE2eeRun }) =>
    makeE2eeRun({
      runHubCommand,
      runLiveServerRequest,
      readErrorMessageFromResponse,
      liveServerTimeout: HUB_CLI_LIVE_SERVER_TIMEOUT,
      emitJson,
      loadTerminalQrCode,
    }),
  ),
);

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

const e2eeClientListCommand = Command.make("list", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "List client authorization records with their status, authority, and fingerprint (§13.6).",
  ),
  Command.withHandler((flags) => Effect.flatMap(loadE2eeRun, (run) => run.clientList(flags))),
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
  Command.withHandler((flags) => Effect.flatMap(loadE2eeRun, (run) => run.clientShow(flags))),
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
  Command.withHandler((flags) => Effect.flatMap(loadE2eeRun, (run) => run.clientApprove(flags))),
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
  Command.withHandler((flags) => Effect.flatMap(loadE2eeRun, (run) => run.clientApprovalQr(flags))),
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
  Command.withHandler((flags) => Effect.flatMap(loadE2eeRun, (run) => run.clientNarrow(flags))),
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
  Command.withHandler((flags) => Effect.flatMap(loadE2eeRun, (run) => run.clientRevoke(flags))),
);

const e2eeClientPurgeCommand = Command.make("purge", {
  ...authLocationFlags,
  ...e2eeClientKeyFlags,
  fingerprint: e2eeFingerprintArgument,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Purge a record, freeing its slot against both pending caps (§13.6)."),
  Command.withHandler((flags) => Effect.flatMap(loadE2eeRun, (run) => run.clientPurge(flags))),
);

const e2eeWindowOpenCommand = Command.make("open", {
  ...authLocationFlags,
  fingerprint: e2eeFingerprintArgument,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Open a pairing window for one named client key. The discriminator is required (§13.6).",
  ),
  Command.withHandler((flags) => Effect.flatMap(loadE2eeRun, (run) => run.windowOpen(flags))),
);

const e2eeWindowCloseCommand = Command.make("close", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Close the owner-opened pairing window."),
  Command.withHandler((flags) => Effect.flatMap(loadE2eeRun, (run) => run.windowClose(flags))),
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
    Effect.flatMap(loadE2eeRun, (run) => run.clientClearRefusals(flags)),
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
  Command.withHandler((flags) => Effect.flatMap(loadE2eeRun, (run) => run.sessions(flags))),
);

const e2eePolicyShowCommand = Command.make("show", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Show the effective node admission policy (§12.3, §12.4)."),
  Command.withHandler((flags) => Effect.flatMap(loadE2eeRun, (run) => run.policyShow(flags))),
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
  Command.withHandler((flags) => Effect.flatMap(loadE2eeRun, (run) => run.policySet(flags))),
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
  Command.withHandler((flags) => Effect.flatMap(loadE2eeRun, (run) => run.policyRecover(flags))),
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
  Command.withHandler((flags) => Effect.flatMap(loadE2eeRun, (run) => run.prekeyShow(flags))),
);

const e2eePrekeyRotateCommand = Command.make("rotate", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Force an immediate agreement-prekey rotation: a new keypair and a new certificate (§6.4).",
  ),
  Command.withHandler((flags) => Effect.flatMap(loadE2eeRun, (run) => run.prekeyRotate(flags))),
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
  Command.withHandler((flags) => Effect.flatMap(loadE2eeRun, (run) => run.continuityShow(flags))),
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
  Command.withHandler((flags) =>
    Effect.flatMap(loadE2eeRun, (run) => run.continuityRecover(flags)),
  ),
);

const e2eeContinuityBreakCommand = Command.make("break", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Deliberately break the continuity chain. Every pinned client needs a fresh pairing ceremony (§7.5).",
  ),
  Command.withHandler((flags) => Effect.flatMap(loadE2eeRun, (run) => run.continuityBreak(flags))),
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
  Command.withHandler((flags) => Effect.flatMap(loadE2eeRun, (run) => run.fallbackShow(flags))),
);

const e2eeFallbackResetCommand = Command.make("reset", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Reset both occurrence counters, both ring-overflow counters, and the ring (§12.5).",
  ),
  Command.withHandler((flags) => Effect.flatMap(loadE2eeRun, (run) => run.fallbackReset(flags))),
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
