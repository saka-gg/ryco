/**
 * `ryco hub`: the outbound Hub connector, through the local Ryco server.
 */
import { DEFAULT_HOSTED_APP_ORIGIN } from "@ryco/shared/hostedApp";
import { canonicalizeHubOrigin } from "@ryco/shared/nodeIdentity";
import {
  HubConnectorStatus,
  HubEnrollmentCeremonyDetail,
  HubEnrollmentStartResult,
  HubIdentitySummary,
} from "@ryco/contracts";
import { Console, Data, Effect, Option, Redacted } from "effect";
import { Command, Flag, Prompt } from "effect/cli";
import { HttpClientRequest, HttpClientResponse } from "effect/http";
import { authLocationFlags, emitJson, jsonFlag } from "./flags.ts";
import {
  HUB_CLI_LIVE_SERVER_TIMEOUT,
  readErrorMessageFromResponse,
  runHubCommand,
  runLiveServerRequest,
} from "./runtime.ts";
import type { CliAuthLocationFlags } from "./serverConfig.ts";

export const requestHubStatus = (origin: string, bearerToken: string) =>
  runLiveServerRequest(
    HttpClientRequest.get(`${origin}/api/hub/status`).pipe(
      HttpClientRequest.acceptJson,
      HttpClientRequest.bearerToken(bearerToken),
    ),
    HttpClientResponse.matchStatus({
      "2xx": (response) => HttpClientResponse.schemaBodyJson(HubConnectorStatus)(response),
      orElse: (response) =>
        readErrorMessageFromResponse(response).pipe(
          Effect.flatMap((message) => Effect.fail(new Error(message))),
        ),
    }),
    HUB_CLI_LIVE_SERVER_TIMEOUT,
  );

export const requestHubIdentitySummary = (origin: string, bearerToken: string) =>
  runLiveServerRequest(
    HttpClientRequest.get(`${origin}/api/hub/identity`).pipe(
      HttpClientRequest.acceptJson,
      HttpClientRequest.bearerToken(bearerToken),
    ),
    HttpClientResponse.matchStatus({
      "2xx": (response) => HttpClientResponse.schemaBodyJson(HubIdentitySummary)(response),
      orElse: (response) =>
        readErrorMessageFromResponse(response).pipe(
          Effect.flatMap((message) => Effect.fail(new Error(message))),
        ),
    }),
    HUB_CLI_LIVE_SERVER_TIMEOUT,
  );

export const requestHubEnrollment = (origin: string, bearerToken: string) =>
  runLiveServerRequest(
    HttpClientRequest.post(`${origin}/api/hub/enrollment`).pipe(
      HttpClientRequest.acceptJson,
      HttpClientRequest.bearerToken(bearerToken),
    ),
    HttpClientResponse.matchStatus({
      "2xx": (response) => HttpClientResponse.schemaBodyJson(HubEnrollmentStartResult)(response),
      orElse: (response) =>
        readErrorMessageFromResponse(response).pipe(
          Effect.flatMap((message) => Effect.fail(new Error(message))),
        ),
    }),
    HUB_CLI_LIVE_SERVER_TIMEOUT,
  );

const requestHubEnrollmentCancellation = (origin: string, bearerToken: string) =>
  runLiveServerRequest(
    HttpClientRequest.post(`${origin}/api/hub/enrollment/cancel`).pipe(
      HttpClientRequest.acceptJson,
      HttpClientRequest.bearerToken(bearerToken),
    ),
    HttpClientResponse.matchStatus({
      "2xx": (response) => HttpClientResponse.schemaBodyJson(HubConnectorStatus)(response),
      orElse: (response) =>
        readErrorMessageFromResponse(response).pipe(
          Effect.flatMap((message) => Effect.fail(new Error(message))),
        ),
    }),
    HUB_CLI_LIVE_SERVER_TIMEOUT,
  );

export const requestHubPendingEnrollment = (origin: string, bearerToken: string) =>
  runLiveServerRequest(
    HttpClientRequest.get(`${origin}/api/hub/enrollment`).pipe(
      HttpClientRequest.acceptJson,
      HttpClientRequest.bearerToken(bearerToken),
    ),
    HttpClientResponse.matchStatus({
      "2xx": (response) =>
        HttpClientResponse.schemaBodyJson(HubEnrollmentCeremonyDetail)(response).pipe(
          Effect.map((detail): typeof HubEnrollmentCeremonyDetail.Type | null => detail),
        ),
      "404": () => Effect.succeed(null),
      orElse: (response) =>
        readErrorMessageFromResponse(response).pipe(
          Effect.flatMap((message) => Effect.fail(new Error(message))),
        ),
    }),
    HUB_CLI_LIVE_SERVER_TIMEOUT,
  );

const requestHubResume = (origin: string, bearerToken: string) =>
  runLiveServerRequest(
    HttpClientRequest.post(`${origin}/api/hub/resume`).pipe(
      HttpClientRequest.acceptJson,
      HttpClientRequest.bearerToken(bearerToken),
    ),
    HttpClientResponse.matchStatus({
      "2xx": (response) => HttpClientResponse.schemaBodyJson(HubConnectorStatus)(response),
      orElse: (response) =>
        readErrorMessageFromResponse(response).pipe(
          Effect.flatMap((message) => Effect.fail(new Error(message))),
        ),
    }),
    HUB_CLI_LIVE_SERVER_TIMEOUT,
  );

const formatHubStatus = (
  status: typeof HubConnectorStatus.Type,
  json: boolean,
  identity?: typeof HubIdentitySummary.Type,
): string => {
  if (json) {
    return emitJson({
      ...status,
      ...(identity?.fingerprint === undefined ? {} : { fingerprint: identity.fingerprint }),
    });
  }
  const details = [
    `Hub connector: ${status.state}`,
    identity?.fingerprint === undefined ? undefined : `Fingerprint: ${identity.fingerprint}`,
    status.failure === undefined ? undefined : `Failure: ${status.failure}`,
    status.nextRetryAt === undefined ? undefined : `Next retry: ${status.nextRetryAt}`,
    status.state === "online" ? `Active channels: ${status.activeChannels}` : undefined,
    status.state === "online" ? `Queued bytes: ${status.queuedBytes}` : undefined,
  ].filter((line): line is string => line !== undefined);
  return details.join("\n");
};

const hubStatusCommand = Command.make("status", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Show bounded local Hub connector status."),
  Command.withHandler((flags) =>
    runHubCommand(
      flags,
      (origin, token) =>
        Effect.all({
          status: requestHubStatus(origin, token),
          identity: requestHubIdentitySummary(origin, token),
        }),
      { quietLogs: flags.json },
    ).pipe(
      Effect.flatMap(({ status, identity }) =>
        Console.log(formatHubStatus(status, flags.json, identity)),
      ),
    ),
  ),
);

const hubEnrollCommand = Command.make("enroll", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Start device-code enrollment with the configured Hub."),
  Command.withHandler((flags) =>
    runHubCommand(flags, (origin, token) => requestHubEnrollment(origin, token), {
      quietLogs: flags.json,
    }).pipe(
      Effect.flatMap((result) =>
        Console.log(
          flags.json
            ? emitJson(result)
            : [
                `Device code: ${result.deviceCode}`,
                `Fingerprint: ${result.fingerprint}`,
                `Expires: ${result.expiresAt}`,
                "Compare this fingerprint in Hub before approving. Ryco will continue polling in the background.",
              ].join("\n"),
        ),
      ),
    ),
  ),
);

const hubCancelCommand = Command.make("cancel", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Cancel pending Hub enrollment and erase its local polling material."),
  Command.withHandler((flags) =>
    runHubCommand(flags, (origin, token) => requestHubEnrollmentCancellation(origin, token), {
      quietLogs: flags.json,
    }).pipe(Effect.flatMap((status) => Console.log(formatHubStatus(status, flags.json)))),
  ),
);

const requestHubLeave = (origin: string, bearerToken: string) =>
  runLiveServerRequest(
    HttpClientRequest.post(`${origin}/api/hub/leave`).pipe(
      HttpClientRequest.acceptJson,
      HttpClientRequest.bearerToken(bearerToken),
    ),
    HttpClientResponse.matchStatus({
      "2xx": (response) => HttpClientResponse.schemaBodyJson(HubConnectorStatus)(response),
      orElse: (response) =>
        readErrorMessageFromResponse(response).pipe(
          Effect.flatMap((message) => Effect.fail(new Error(message))),
        ),
    }),
    HUB_CLI_LIVE_SERVER_TIMEOUT,
  );

const formatHubCeremony = (
  detail: typeof HubEnrollmentCeremonyDetail.Type,
  json: boolean,
): string =>
  json
    ? emitJson(detail)
    : [
        `Label: ${detail.label}`,
        `Platform: ${detail.platformOs} · ${detail.platformArch}`,
        `Version: ${detail.clientVersion}`,
        `Algorithm: ${detail.algorithm}`,
        `Fingerprint: ${detail.fingerprint}`,
        `Expires: ${detail.expiresAt}`,
        `Device code: ${detail.deviceCode}`,
        "Compare every field, especially the fingerprint, in Hub before approving.",
      ].join("\n");

const hubPendingCommand = Command.make("pending", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Show the pending enrollment ceremony again so its fields can be compared in Hub.",
  ),
  Command.withHandler((flags) =>
    runHubCommand(flags, (origin, token) => requestHubPendingEnrollment(origin, token), {
      quietLogs: flags.json,
    }).pipe(
      Effect.flatMap((detail) =>
        Console.log(
          detail === null
            ? // "Nothing is pending" is an ANSWER, so under `--json` it is a
              // document — `null` — and not prose. Emitting the sentence here
              // made the one reachable outcome of this command unparseable for
              // the consumer the flag exists for, which is the same defect as a
              // log line on stdout and was reached without any logging at all.
              flags.json
              ? emitJson(null)
              : "No Hub enrollment is pending."
            : formatHubCeremony(detail, flags.json),
        ),
      ),
    ),
  ),
);

const hubLeaveCommand = Command.make("leave", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Erase this node's local Hub identity. Destructive: reconnecting needs a new approval, and this does not revoke the node in Hub.",
  ),
  Command.withHandler((flags) =>
    runHubCommand(flags, (origin, token) => requestHubLeave(origin, token), {
      quietLogs: flags.json,
    }).pipe(Effect.flatMap((status) => Console.log(formatHubStatus(status, flags.json)))),
  ),
);

const hubResumeCommand = Command.make("resume", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Retry a Hub connector that stopped without scheduling its own retry. Prints the resulting status.",
  ),
  Command.withHandler((flags) =>
    runHubCommand(flags, (origin, token) => requestHubResume(origin, token), {
      quietLogs: flags.json,
    }).pipe(Effect.flatMap((status) => Console.log(formatHubStatus(status, flags.json)))),
  ),
);

export class HubLoginError extends Data.TaggedError("HubLoginError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

// The Hub account client (client-runtime authorization and relay) loads only
// for `ryco hub login` and setup, never on the `serve` path.
const loadCliAccountLink = Effect.promise(() => import("../hubConnector/cliAccountLink.ts"));

const hubLoginStep = <A>(
  run: (accountLink: typeof import("../hubConnector/cliAccountLink.ts")) => Promise<A>,
) =>
  Effect.flatMap(loadCliAccountLink, (accountLink) =>
    Effect.tryPromise({
      try: () => run(accountLink),
      catch: (cause) =>
        new HubLoginError({ message: accountLink.describeAccountLinkFailure(cause), cause }),
    }),
  );

/** Poll the local connector until it reports `online`, for up to a minute. */
const waitForHubOnline = (flags: CliAuthLocationFlags) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const status = yield* runHubCommand(flags, requestHubStatus, { quietLogs: true }).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (status?.state === "online") return status;
      yield* Effect.sleep(1_000);
    }
    return null;
  });

/**
 * The `ryco hub login` flow: sign in here, approve this node's own enrollment,
 * sign out. Resolves whether the node ended up linked. Shared with `ryco setup`.
 */
export const runHubLoginFlow = (
  flags: CliAuthLocationFlags,
  input: { readonly hubOrigin: string; readonly username: Option.Option<string> },
) =>
  Effect.gen(function* () {
    const hubOrigin = input.hubOrigin;
    const local = yield* runHubCommand(
      flags,
      (origin, token) =>
        Effect.all({
          status: requestHubStatus(origin, token),
          identity: requestHubIdentitySummary(origin, token),
        }),
      { quietLogs: true },
    );
    if (local.status.state === "disabled") {
      return yield* new HubLoginError({
        message:
          "This node's Hub connector is off. Turn it on with `ryco config set hub true` and restart (or `ryco serve --hub`), then link again.",
      });
    }
    if (local.identity.enrolled === "active") {
      yield* Console.log(
        `This node is already linked to a Ryco account${local.identity.fingerprint ? ` (${local.identity.fingerprint})` : ""}.\n`,
      );
      return true;
    }

    const username = Option.isSome(input.username)
      ? input.username.value
      : yield* Prompt.run(Prompt.String({ message: "Ryco username" }));
    const password = yield* Prompt.run(Prompt.Password({ message: "Password" }));
    const account = yield* hubLoginStep(({ createCliHubAccount }) =>
      createCliHubAccount(hubOrigin),
    );
    const signIn = yield* hubLoginStep(({ startPasswordSignIn }) =>
      startPasswordSignIn(account, { username, password: Redacted.value(password) }),
    );
    const code = yield* Prompt.run(
      Prompt.String({
        message:
          signIn.factor === "totp"
            ? "Code from your authenticator app"
            : "Code from the email the Hub just sent",
      }),
    );
    yield* hubLoginStep(() => signIn.finish(code));

    yield* Effect.gen(function* () {
      const ceremony = yield* runHubCommand(
        flags,
        (origin, token) =>
          local.identity.enrolled === "pending"
            ? requestHubPendingEnrollment(origin, token)
            : requestHubEnrollment(origin, token),
        { quietLogs: true },
      );
      if (ceremony === null) {
        return yield* new HubLoginError({
          message: "No enrollment is pending on this node. Try linking again.",
        });
      }
      yield* Console.log(
        `Approving "${ceremony.label}" (${ceremony.fingerprint}) on ${hubOrigin}…`,
      );
      yield* hubLoginStep(({ approveOwnEnrollment }) =>
        approveOwnEnrollment(account.api, ceremony),
      );
    }).pipe(
      // The account session only ever exists to approve this node.
      Effect.ensuring(Effect.promise(() => account.api.signOut().catch(() => undefined))),
    );

    const online = yield* waitForHubOnline(flags);
    yield* Console.log(
      online
        ? "Linked. This node is online through the Hub and appears under your machines in Ryco.\n"
        : "Approved. The node will come online once it next polls the Hub; check with `ryco hub status`.\n",
    );
    return true;
  });

const parseHubOrigin = (value: Option.Option<string>) =>
  Effect.try({
    try: () => canonicalizeHubOrigin(Option.getOrElse(value, () => DEFAULT_HOSTED_APP_ORIGIN)),
    catch: () => new HubLoginError({ message: "--hub-origin must be an https:// origin." }),
  });

const hubLoginCommand = Command.make("login", {
  ...authLocationFlags,
  hubOrigin: Flag.String("hub-origin").pipe(
    Flag.withDescription(`Hub to sign in to (defaults to ${DEFAULT_HOSTED_APP_ORIGIN}).`),
    Flag.optional,
  ),
  username: Flag.String("username").pipe(
    Flag.withDescription(
      "Ryco username; asked for when omitted. Passwords are only ever prompted for.",
    ),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription(
    "Link this node to your Ryco account by signing in here: no device code to compare or approve in a browser. Needs an account with a password and a second factor; otherwise use `ryco hub enroll`.",
  ),
  Command.withHandler((flags) =>
    parseHubOrigin(flags.hubOrigin).pipe(
      Effect.flatMap((hubOrigin) =>
        runHubLoginFlow(flags, { hubOrigin, username: flags.username }),
      ),
      Effect.asVoid,
    ),
  ),
);

export const hubCommand = Command.make("hub").pipe(
  Command.withDescription("Manage the outbound Hub connector through the local Ryco server."),
  Command.withSubcommands([
    hubStatusCommand,
    hubLoginCommand,
    hubEnrollCommand,
    hubPendingCommand,
    hubCancelCommand,
    hubResumeCommand,
    hubLeaveCommand,
  ]),
);
