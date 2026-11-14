/**
 * `ryco auth`: pairing tokens and bearer sessions of the local auth control plane.
 */
import { AuthSessionId } from "@ryco/contracts";
import { Clock, Console, DateTime, Duration, Effect, Option } from "effect";
// oxlint-disable-next-line no-unused-vars -- TS needs the symbol in scope to name exported CLI types.
import type { NodeInspectSymbol } from "effect/Inspectable";
import { Argument, Command, Flag } from "effect/cli";
import { loadTerminalQrCode } from "../startupAccess.ts";
import { nodeConfigPath, readNodeConfig } from "../cliSetup/nodeConfig.ts";
import {
  discoverPairingLinks,
  formatPairingQrBlock,
  pairingLinksForBaseUrl,
} from "../cliSetup/pairingQr.ts";
import { dim, isInteractiveTerminal } from "../cliSetup/ui.ts";
import {
  formatIssuedPairingCredential,
  formatIssuedSession,
  formatPairingCredentialList,
  formatSessionList,
} from "../cliAuthFormat.ts";
import {
  OWNER_BOOTSTRAP_PAIRING_SUBJECT,
  OWNER_PAIRING_LINK_MAX_TTL,
} from "../auth/Services/AuthControlPlane.ts";
import { authLocationFlags, jsonFlag, ttlFlag } from "./flags.ts";
import { probeLocalServerRuntime, runWithAuthControlPlane } from "./runtime.ts";

const sessionRoleFlag = Flag.Literals("role", ["owner", "client"]).pipe(
  Flag.withDescription("Role for the issued bearer session."),
  Flag.withDefault("owner"),
);

const pairingRoleFlag = Flag.Literals("role", ["client", "owner"]).pipe(
  Flag.withDescription(
    `Role the redeemed session gets. An owner link can last at most ${Duration.toMinutes(OWNER_PAIRING_LINK_MAX_TTL)} minutes.`,
  ),
  Flag.withDefault("client"),
);

const labelFlag = Flag.String("label").pipe(
  Flag.withDescription("Optional human-readable label."),
  Flag.optional,
);

const subjectFlag = Flag.String("subject").pipe(
  Flag.withDescription("Optional session subject."),
  Flag.optional,
);

const baseUrlFlag = Flag.String("base-url").pipe(
  Flag.withDescription("Optional public base URL used to print a ready `/pair#token=...` link."),
  Flag.optional,
);

const tokenOnlyFlag = Flag.Boolean("token-only").pipe(
  Flag.withDescription("Print only the issued bearer token."),
  Flag.withDefault(false),
);

const qrFlag = Flag.Boolean("qr").pipe(
  Flag.withDescription(
    "Print the pairing link as a QR code (default when the output is a terminal, never with --json; `--no-qr` turns it off).",
  ),
  Flag.optional,
);

const PAIRING_QR_NO_NODE_NOTE = "No running node found; pass --base-url to print a QR code.";

const pairingCreateCommand = Command.make("create", {
  ...authLocationFlags,
  role: pairingRoleFlag,
  ttl: ttlFlag,
  label: labelFlag,
  baseUrl: baseUrlFlag,
  json: jsonFlag,
  qr: qrFlag,
}).pipe(
  Command.withDescription("Issue a new one-time pairing token (client unless --role owner)."),
  Command.withHandler((flags) =>
    runWithAuthControlPlane(
      flags,
      (authControlPlane, config) =>
        Effect.gen(function* () {
          const issued = yield* authControlPlane.createPairingLink({
            role: flags.role,
            subject: "one-time-token",
            ...(Option.isSome(flags.ttl) ? { ttl: flags.ttl.value } : {}),
            ...(Option.isSome(flags.label) ? { label: flags.label.value } : {}),
          });
          // `--json` never draws a QR and never looks for the node: with `--base-url` it reports
          // the link a QR would hold, as before plus `qrUrl`.
          const wantsQr = !flags.json && Option.getOrElse(flags.qr, () => isInteractiveTerminal());
          if (!wantsQr) {
            yield* Console.log(
              formatIssuedPairingCredential(issued, {
                json: flags.json,
                ...(Option.isSome(flags.baseUrl)
                  ? (() => {
                      const links = pairingLinksForBaseUrl(issued.credential, flags.baseUrl.value);
                      return { pairUrl: links.pairingUrl, qrUrl: links.qrUrl };
                    })()
                  : {}),
              }),
            );
            return;
          }
          const runtime = Option.isSome(flags.baseUrl)
            ? null
            : yield* probeLocalServerRuntime(config.serverRuntimeStatePath);
          // The node's own bind host (its runtime file) and its saved Tailscale Serve settings:
          // the QR must hold an address that node really listens on.
          const savedNode =
            runtime === null
              ? null
              : yield* Effect.promise(() => readNodeConfig(nodeConfigPath(config.stateDir)));
          const links = Option.isSome(flags.baseUrl)
            ? pairingLinksForBaseUrl(issued.credential, flags.baseUrl.value)
            : runtime === null
              ? null
              : yield* Effect.promise(() =>
                  discoverPairingLinks({
                    credential: issued.credential,
                    origin: runtime.origin,
                    host: runtime.host,
                    tailscaleServeEnabled:
                      config.tailscaleServeEnabled || savedNode?.tailscaleServe === true,
                    tailscaleServePort: savedNode?.tailscaleServePort ?? config.tailscaleServePort,
                  }),
                ).pipe(Effect.orElseSucceed(() => null));
          const summary = formatIssuedPairingCredential(issued, {
            ...(links === null ? {} : { pairUrl: links.pairingUrl }),
          });
          if (links === null) {
            yield* Console.log(`${summary}${PAIRING_QR_NO_NODE_NOTE}\n`);
            return;
          }
          const minutes = Math.max(
            1,
            Math.round(
              (DateTime.toEpochMillis(issued.expiresAt) - (yield* Clock.currentTimeMillis)) /
                60_000,
            ),
          );
          const renderQrCode = yield* loadTerminalQrCode;
          yield* Console.log(
            `${summary}${formatPairingQrBlock({
              links,
              renderQrCode,
              // An owner link is capped at OWNER_PAIRING_LINK_MAX_TTL by `createPairingLink`.
              footer: [
                `One-time ${issued.role} link, valid for ${minutes} minute${minutes === 1 ? "" : "s"}.`,
              ],
              // The summary above already printed it as "Pair URL".
              showPairingUrl: false,
              dim,
            })}`,
          );
        }),
      {
        quietLogs: flags.json,
      },
    ),
  ),
);

const pairingListCommand = Command.make("list", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "List active client and owner pairing tokens without revealing their secrets.",
  ),
  Command.withHandler((flags) =>
    runWithAuthControlPlane(
      flags,
      (authControlPlane) =>
        Effect.gen(function* () {
          // The startup owner link belongs to the server's own launch.
          const pairingLinks = yield* authControlPlane.listPairingLinks({
            excludeSubjects: [OWNER_BOOTSTRAP_PAIRING_SUBJECT],
          });
          yield* Console.log(formatPairingCredentialList(pairingLinks, { json: flags.json }));
        }),
      {
        quietLogs: flags.json,
      },
    ),
  ),
);

const pairingRevokeCommand = Command.make("revoke", {
  ...authLocationFlags,
  id: Argument.String("id").pipe(Argument.withDescription("Pairing credential id to revoke.")),
}).pipe(
  Command.withDescription("Revoke an active client or owner pairing token."),
  Command.withHandler((flags) =>
    runWithAuthControlPlane(flags, (authControlPlane) =>
      Effect.gen(function* () {
        const revoked = yield* authControlPlane.revokePairingLink(flags.id);
        yield* Console.log(
          revoked
            ? `Revoked pairing credential ${flags.id}.\n`
            : `No active pairing credential found for ${flags.id}.\n`,
        );
      }),
    ),
  ),
);

const pairingCommand = Command.make("pairing").pipe(
  Command.withDescription("Manage one-time client and owner pairing tokens."),
  Command.withSubcommands([pairingCreateCommand, pairingListCommand, pairingRevokeCommand]),
);

const sessionIssueCommand = Command.make("issue", {
  ...authLocationFlags,
  ttl: ttlFlag,
  role: sessionRoleFlag,
  label: labelFlag,
  subject: subjectFlag,
  tokenOnly: tokenOnlyFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Issue a bearer session token for headless or remote clients."),
  Command.withHandler((flags) =>
    runWithAuthControlPlane(
      flags,
      (authControlPlane) =>
        Effect.gen(function* () {
          const issued = yield* authControlPlane.issueSession({
            role: flags.role,
            ...(Option.isSome(flags.ttl) ? { ttl: flags.ttl.value } : {}),
            ...(Option.isSome(flags.label) ? { label: flags.label.value } : {}),
            ...(Option.isSome(flags.subject) ? { subject: flags.subject.value } : {}),
          });
          yield* Console.log(
            formatIssuedSession(issued, {
              json: flags.json,
              tokenOnly: flags.tokenOnly,
            }),
          );
        }),
      {
        quietLogs: flags.json || flags.tokenOnly,
      },
    ),
  ),
);

const sessionListCommand = Command.make("list", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription("List active sessions without revealing bearer tokens."),
  Command.withHandler((flags) =>
    runWithAuthControlPlane(
      flags,
      (authControlPlane) =>
        Effect.gen(function* () {
          const sessions = yield* authControlPlane.listSessions();
          yield* Console.log(formatSessionList(sessions, { json: flags.json }));
        }),
      {
        quietLogs: flags.json,
      },
    ),
  ),
);

const sessionRevokeCommand = Command.make("revoke", {
  ...authLocationFlags,
  sessionId: Argument.String("session-id").pipe(
    Argument.withDescription("Session id to revoke."),
    Argument.withSchema(AuthSessionId),
  ),
}).pipe(
  Command.withDescription("Revoke an active session."),
  Command.withHandler((flags) =>
    runWithAuthControlPlane(flags, (authControlPlane) =>
      Effect.gen(function* () {
        const revoked = yield* authControlPlane.revokeSession(flags.sessionId);
        yield* Console.log(
          revoked
            ? `Revoked session ${flags.sessionId}.\n`
            : `No active session found for ${flags.sessionId}.\n`,
        );
      }),
    ),
  ),
);

const sessionCommand = Command.make("session").pipe(
  Command.withDescription("Manage bearer sessions."),
  Command.withSubcommands([sessionIssueCommand, sessionListCommand, sessionRevokeCommand]),
);

export const authCommand = Command.make("auth").pipe(
  Command.withDescription("Manage the local auth control plane for headless deployments."),
  Command.withSubcommands([pairingCommand, sessionCommand]),
);
