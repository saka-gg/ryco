/**
 * Flags and output helpers shared by the `ryco` commands.
 */
import { DEFAULT_HOSTED_APP_ORIGIN } from "@ryco/shared/hostedApp";
import { NodeE2eeAdmissionPolicy } from "@ryco/contracts";
import { Duration, Effect, Option, Schema, SchemaIssue, SchemaTransformation } from "effect";
import { Argument, Flag } from "effect/cli";
import { RuntimeMode } from "../config.ts";
import { PortSchema } from "./serverConfig.ts";

const modeFlag = Flag.Literals("mode", RuntimeMode.literals).pipe(
  Flag.withDescription("Runtime mode. `desktop` keeps loopback defaults unless overridden."),
  Flag.optional,
);
export const portFlag = Flag.Int("port").pipe(
  Flag.withSchema(PortSchema),
  Flag.withDescription("Port for the HTTP/WebSocket server."),
  Flag.optional,
);
export const hostFlag = Flag.String("host").pipe(
  Flag.withDescription("Host/interface to bind (for example 127.0.0.1, 0.0.0.0, or a Tailnet IP)."),
  Flag.optional,
);
export const baseDirFlag = Flag.String("base-dir").pipe(
  Flag.withDescription("Base directory path (equivalent to RYCO_HOME)."),
  Flag.optional,
);
const devUrlFlag = Flag.String("dev-url").pipe(
  Flag.withSchema(Schema.URLFromString),
  Flag.withDescription("Dev web URL to proxy/redirect to (equivalent to VITE_DEV_SERVER_URL)."),
  Flag.optional,
);
const noBrowserFlag = Flag.Boolean("no-browser").pipe(
  Flag.withDescription("Disable automatic browser opening."),
  Flag.optional,
);
const bootstrapFdFlag = Flag.Int("bootstrap-fd").pipe(
  Flag.withSchema(Schema.Int),
  Flag.withDescription("Read one-time bootstrap secrets from the given file descriptor."),
  Flag.optional,
);
const autoBootstrapProjectFromCwdFlag = Flag.Boolean("auto-bootstrap-project-from-cwd").pipe(
  Flag.withDescription(
    "Create a project for the current working directory on startup when missing.",
  ),
  Flag.optional,
);
export const restrictToCwdFlag = Flag.Boolean("restrict-to-cwd").pipe(
  Flag.withDescription(
    "Restrict Ryco-managed workspace paths to the startup working directory (not a process sandbox).",
  ),
  Flag.optional,
);
const logWebSocketEventsFlag = Flag.Boolean("log-websocket-events").pipe(
  Flag.withDescription(
    "Emit server-side logs for outbound WebSocket push traffic (equivalent to RYCO_LOG_WS_EVENTS).",
  ),
  Flag.withAlias("log-ws-events"),
  Flag.optional,
);
export const hubConnectorEnabledFlag = Flag.Boolean("hub-connector-enabled").pipe(
  Flag.withDescription(
    "Enable the outbound Hub connector so this node is reachable through the Hub relay (overrides RYCO_HUB_CONNECTOR_ENABLED).",
  ),
  Flag.withAlias("hub"),
  Flag.optional,
);
export const hubOriginFlag = Flag.String("hub-origin").pipe(
  Flag.withDescription(
    `Canonical Hub HTTPS origin (overrides RYCO_HUB_ORIGIN; defaults to ${DEFAULT_HOSTED_APP_ORIGIN} when the connector is enabled).`,
  ),
  Flag.optional,
);
export const hubNodeNameFlag = Flag.String("hub-node-name").pipe(
  Flag.withDescription("Name proposed when this node enrolls (overrides RYCO_HUB_NODE_NAME)."),
  Flag.optional,
);
export const hubAllowFileSecretStoreFlag = Flag.Boolean("hub-allow-file-secret-store").pipe(
  Flag.withDescription(
    "Allow the permissioned-file Hub secret-store fallback (overrides RYCO_HUB_ALLOW_FILE_SECRET_STORE).",
  ),
  Flag.optional,
);
const hubRequireE2EEFlag = Flag.Boolean("hub-require-e2ee").pipe(
  Flag.withDescription(
    "Accept only end-to-end encrypted relay channels; open plaintext channels are closed (overrides RYCO_HUB_REQUIRE_E2EE).",
  ),
  Flag.optional,
);
const hubRequireApprovedClientE2EEFlag = Flag.Boolean("hub-require-approved-client-e2ee").pipe(
  Flag.withDescription(
    "Accept only approved native clients over the relay. Disables web and legacy access entirely, closes the live channels it no longer admits, and can strand remote access if every approved client key is lost (overrides RYCO_HUB_REQUIRE_APPROVED_CLIENT_E2EE).",
  ),
  Flag.optional,
);
export const hubE2eePolicyFlag = Flag.Literals(
  "hub-e2ee-policy",
  NodeE2eeAdmissionPolicy.literals,
).pipe(
  Flag.withDescription(
    "Relay E2EE admission policy committed to this node (overrides RYCO_HUB_E2EE_POLICY). `require-locally-approved-native-e2ee` disables web and legacy access entirely.",
  ),
  Flag.optional,
);
export const preventSleepFlag = Flag.Boolean("prevent-sleep").pipe(
  Flag.withDescription(
    "Keep the machine from idle-sleeping while this server runs (macOS: only on AC power) so it stays reachable (equivalent to RYCO_PREVENT_SLEEP).",
  ),
  Flag.optional,
);
export const keepAwakeWhileWorkingFlag = Flag.Boolean("keep-awake-while-working").pipe(
  Flag.withDescription(
    "Keep the machine from idle-sleeping while agents work and for 2 minutes after, on AC power only (default on; --no-keep-awake-while-working turns it off; equivalent to RYCO_KEEP_AWAKE_WHILE_WORKING). --prevent-sleep holds it for the whole run instead.",
  ),
  Flag.optional,
);
export const tailscaleServeFlag = Flag.Boolean("tailscale-serve").pipe(
  Flag.withDescription(
    "Configure Tailscale Serve to expose this backend over HTTPS on the Tailnet.",
  ),
  Flag.optional,
);
export const tailscaleServePortFlag = Flag.Int("tailscale-serve-port").pipe(
  Flag.withSchema(PortSchema),
  Flag.withDescription("HTTPS port for Tailscale Serve when --tailscale-serve is enabled."),
  Flag.optional,
);

const DurationShorthandPattern = /^(?<value>\d+)(?<unit>ms|s|m|h|d|w)$/i;

const parseDurationInput = (value: string): Duration.Duration | null => {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  const shorthand = DurationShorthandPattern.exec(trimmed);
  const normalizedInput = shorthand?.groups
    ? (() => {
        const amountText = shorthand.groups.value;
        const unitText = shorthand.groups.unit;
        if (typeof amountText !== "string" || typeof unitText !== "string") {
          return null;
        }

        const amount = Number.parseInt(amountText, 10);
        if (!Number.isFinite(amount)) return null;

        switch (unitText.toLowerCase()) {
          case "ms":
            return `${amount} millis`;
          case "s":
            return `${amount} seconds`;
          case "m":
            return `${amount} minutes`;
          case "h":
            return `${amount} hours`;
          case "d":
            return `${amount} days`;
          case "w":
            return `${amount} weeks`;
          default:
            return null;
        }
      })()
    : (trimmed as Duration.Input);

  if (normalizedInput === null) return null;

  const decoded = Duration.fromInput(normalizedInput as Duration.Input);
  return Option.isSome(decoded) ? decoded.value : null;
};

export const DurationFromString = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Duration,
    SchemaTransformation.transformEffect({
      decode: (value) => {
        const duration = parseDurationInput(value);
        if (duration !== null) {
          return Effect.succeed(duration);
        }
        return Effect.fail(
          new SchemaIssue.InvalidValue(
            { message: "Invalid duration. Use values like 5m, 1h, 30d, or 15 minutes." },
            value,
          ),
        );
      },
      encode: (duration) => Effect.succeed(Duration.format(duration)),
    }),
  ),
);

export const sharedServerLocationFlags = {
  baseDir: baseDirFlag,
  devUrl: devUrlFlag,
} as const;

export const sharedServerCommandFlags = {
  mode: modeFlag,
  port: portFlag,
  host: hostFlag,
  baseDir: baseDirFlag,
  cwd: Argument.String("cwd").pipe(
    Argument.withDescription(
      "Working directory for provider sessions (defaults to the current directory).",
    ),
    Argument.optional,
  ),
  devUrl: devUrlFlag,
  noBrowser: noBrowserFlag,
  bootstrapFd: bootstrapFdFlag,
  autoBootstrapProjectFromCwd: autoBootstrapProjectFromCwdFlag,
  restrictToCwd: restrictToCwdFlag,
  logWebSocketEvents: logWebSocketEventsFlag,
  hubConnectorEnabled: hubConnectorEnabledFlag,
  hubOrigin: hubOriginFlag,
  hubNodeName: hubNodeNameFlag,
  hubAllowFileSecretStore: hubAllowFileSecretStoreFlag,
  hubRequireE2EE: hubRequireE2EEFlag,
  hubRequireApprovedClientE2EE: hubRequireApprovedClientE2EEFlag,
  hubE2eePolicy: hubE2eePolicyFlag,
  preventSleep: preventSleepFlag,
  keepAwakeWhileWorking: keepAwakeWhileWorkingFlag,
  tailscaleServeEnabled: tailscaleServeFlag,
  tailscaleServePort: tailscaleServePortFlag,
} as const;

export const authLocationFlags = sharedServerLocationFlags;

export const ttlFlag = Flag.String("ttl").pipe(
  Flag.withSchema(DurationFromString),
  Flag.withDescription("TTL, for example `5m`, `1h`, `30d`, or `15 minutes`."),
  Flag.optional,
);

export const jsonFlag = Flag.Boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);

/**
 * The `--json` document, in ONE dialect for every command that emits one.
 *
 * Two dialects grew here: the `hub` family emits compact JSON with no trailing
 * newline, and the `auth` family emits two-space-indented JSON with one. Nothing
 * chose between them, and `--json` is a compatibility surface, so a rule is
 * stated once here and every new command uses it.
 *
 * THE RULE IS THE COMPACT FORM. Three reasons, in order of weight:
 *
 *  1. It is what a consumer of `--json` wants. These documents are read by
 *     `jq`, by shell pipelines, and by scripts that read one line per
 *     invocation; one line per document is the shape all three handle without
 *     buffering, and indentation is display formatting for an audience that is
 *     by definition not reading it.
 *  2. It matches the family this surface belongs to. Every command below reaches
 *     the running server through `runHubCommand`, exactly as `ryco hub status`
 *     does, and an operator piping both into one tool should not have to know
 *     which subcommand tree a value came from.
 *  3. A single emission is what the output is. `Console.log` is called ONCE per
 *     command with the whole document, which is also what keeps the human form's
 *     multi-line output atomic against a concurrent writer.
 *
 * The `auth` family is deliberately left as it is: its documents are printed for
 * a person setting up a headless node, its formatters are a module of their own,
 * and changing an established output format is a break with no benefit to the
 * consumer that already parses it.
 */
export const emitJson = (value: unknown): string => JSON.stringify(value);
