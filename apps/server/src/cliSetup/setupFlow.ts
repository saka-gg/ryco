/**
 * `ryco setup`: one interactive place to make this machine a Ryco node and to
 * run it afterwards.
 *
 * First run is a short guide — where the projects are, how other devices reach
 * the machine, whether it runs in the background — followed by one summary to
 * confirm before anything changes. It then saves `node.json`, installs the
 * background service, links the Ryco account, and pairs a device. Later runs
 * open a status screen with the things people come back for: pairing another
 * device, live logs, restart, changing or hand-editing settings.
 *
 * Everything that talks to the running server comes in as `SetupOperations`,
 * implemented by the CLI with the same local-API helpers its other commands use.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir, networkInterfaces } from "node:os";
import path from "node:path";

import type { HubConnectorStatus, HubEnrollmentCeremonyDetail } from "@ryco/contracts";
import { DEFAULT_HOSTED_APP_ORIGIN } from "@ryco/shared/hostedApp";
import { NetService } from "@ryco/shared/Net";
import { readCachedTailscaleMagicDnsName } from "@ryco/tailscale/endpoints";
import { Console, Data, Effect, Option } from "effect";
import { Prompt } from "effect/unstable/cli";
import type { ChildProcessSpawner } from "effect/unstable/process";
import type * as Terminal from "effect/Terminal";

import { resolveServerAdvertisedEndpointsWithTailscale } from "../remote/AdvertisedEndpointRegistry.ts";
import {
  isEphemeralCliInstall,
  nodeServiceLingerCommand,
  nodeServiceUser,
  type NodeServicePlatform,
  type NodeServiceStatus,
  readNodeServiceStatus,
  restartNodeService,
  startNodeService,
  stopNodeService,
  uninstallNodeService,
} from "../service/nodeService.ts";
import { renderTerminalQrCode, resolveHeadlessServeLinks } from "../startupAccess.ts";
import { detectMachineName, detectProviders, detectTailscale } from "./machine.ts";
import { type NodeConfig, parseNodeConfig, readNodeConfig, writeNodeConfig } from "./nodeConfig.ts";
import { installServiceForNode } from "./nodeSetup.ts";
import { bold, cyan, dim, heading, statusLine } from "./ui.ts";

export interface SetupContext {
  readonly version: string;
  readonly baseDir: string;
  readonly configPath: string;
  readonly logPath: string;
  /** `null` where no background service manager is supported. */
  readonly platform: NodeServicePlatform | null;
  readonly serviceLabel: string;
  /** `ryco` or `npx ryco-cli`: how hints tell the user to run a command. */
  readonly commandPrefix: string;
}

export interface LocalHubState {
  readonly connector: HubConnectorStatus["state"];
  readonly enrolled: "none" | "pending" | "active" | "unknown";
}

export interface SetupOperations {
  /** The running node's origin, or `null` when no server answers. */
  readonly serverOrigin: Effect.Effect<string | null>;
  /** The running node's Hub state, or `null` when no server answers. */
  readonly hubState: Effect.Effect<LocalHubState | null>;
  /** Start this node's device-code enrollment, or return the one already pending. */
  readonly startHubEnrollment: Effect.Effect<HubEnrollmentCeremonyDetail, Error>;
  /** A one-time owner pairing credential for one of the user's own devices. */
  readonly createOwnerPairingCredential: (ttlMinutes: number) => Effect.Effect<string, Error>;
  /** The interactive `ryco hub login` flow; resolves whether the node is now linked. */
  readonly hubLogin: (
    hubOrigin: string,
  ) => Effect.Effect<boolean, Error | Terminal.QuitError, Prompt.Environment>;
  /** Run `ryco serve` in this terminal with the saved settings; returns when it stops. */
  readonly runInForeground: Effect.Effect<void, Error>;
}

export class SetupError extends Data.TaggedError("SetupError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const toSetupError = (cause: unknown) =>
  cause instanceof SetupError
    ? cause
    : new SetupError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      });

type SetupEffect<A> = Effect.Effect<
  A,
  SetupError | Terminal.QuitError,
  Prompt.Environment | ChildProcessSpawner.ChildProcessSpawner | NetService
>;

const promise = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: toSetupError });

const ask = <A>(prompt: Prompt.Prompt<A>) => Prompt.run(prompt);

const NO_SERVICE: NodeServiceStatus | null = null;
const DEFAULT_NODE_PORT = 3773;

const readServiceStatus = (context: SetupContext) =>
  context.platform === null
    ? Effect.succeed(NO_SERVICE)
    : promise(() => readNodeServiceStatus(context.platform!, context.serviceLabel)).pipe(
        Effect.orElseSucceed(() => NO_SERVICE),
      );

const tildify = (value: string) =>
  value.startsWith(homedir()) ? `~${value.slice(homedir().length)}` : value;

// ─── the guided configuration ────────────────────────────────────────────────

type Reach = "hub" | "tailscale" | "lan";

interface GuidedAnswers {
  readonly config: NodeConfig;
  readonly background: boolean;
  /** systemd only: whether the user manager outlives logout, as read before applying. */
  readonly lingering: boolean | null;
}

/**
 * The background question, honest about when the service runs.
 *
 * A systemd user unit starts with the user's first session and stops with the
 * last one unless lingering is on; only then does it start at boot.
 */
export function backgroundServicePrompt(
  platform: NodeServicePlatform,
  lingering: boolean | null,
): string {
  return platform === "systemd" && lingering === true
    ? "Keep Ryco running in the background? It starts at boot and restarts if it stops."
    : "Keep Ryco running in the background? It starts when you log in and restarts if it stops.";
}

/** The summary's "Runs" line. */
export function describeRuns(input: {
  readonly background: boolean;
  readonly preventSleep: boolean | undefined;
  readonly platform: NodeServicePlatform | null;
  readonly lingering: boolean | null;
}): string {
  if (!input.background) return "when you start it";
  return [
    "in the background",
    ...(input.preventSleep ? ["stays awake on power"] : []),
    ...(input.platform === "systemd" && input.lingering !== true
      ? ["only while you are logged in"]
      : []),
  ].join(", ");
}

export type NodeServiceLingerPlan =
  | { readonly kind: "not-needed" }
  | {
      readonly kind: "offer";
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      /** The exact line the user is asked to approve. */
      readonly display: string;
    };

/**
 * Whether to offer `loginctl enable-linger` after installing a systemd unit.
 *
 * Only when lingering is known to be off: an unknown answer means loginctl
 * itself is unavailable, and offering sudo for it would fail anyway.
 */
export function planNodeServiceLinger(input: {
  readonly platform: NodeServicePlatform | null;
  readonly lingering: boolean | null | undefined;
  readonly user: string;
  readonly uid: number | undefined;
}): NodeServiceLingerPlan {
  if (input.platform !== "systemd" || input.lingering !== false || input.user === "") {
    return { kind: "not-needed" };
  }
  const { command, args } = nodeServiceLingerCommand(input.user, input.uid);
  return { kind: "offer", command, args, display: [command, ...args].join(" ") };
}

/** Ask everything the node needs, starting from what is saved. Changes nothing. */
const askNodeSettings = (
  context: SetupContext,
  current: NodeConfig | null,
): SetupEffect<GuidedAnswers> =>
  Effect.gen(function* () {
    const [providers, tailscale, machineName, service] = yield* Effect.all(
      [
        promise(() => detectProviders()).pipe(Effect.orElseSucceed(() => [] as string[])),
        detectTailscale,
        detectMachineName,
        readServiceStatus(context),
      ],
      { concurrency: "unbounded" },
    );
    yield* Console.log(
      [
        "",
        heading(`Ryco setup ${dim(`v${context.version}`)}`),
        dim("Make this computer a Ryco node your other devices can use."),
        "",
        providers.length > 0
          ? statusLine("ok", `Coding agents found: ${providers.join(", ")}`)
          : statusLine(
              "warn",
              "No coding agent found on PATH — install Claude Code, Codex, or another provider first.",
            ),
        tailscale.magicDnsName
          ? statusLine("ok", `Tailscale is running (${tailscale.magicDnsName})`)
          : statusLine("off", "Tailscale is not running on this machine"),
        service?.installed
          ? statusLine("ok", `Background service installed${service.running ? " and running" : ""}`)
          : statusLine("off", "Not running in the background yet"),
        "",
      ].join("\n"),
    );

    const workspaceDefault =
      current?.workspace ?? (process.cwd() === homedir() ? homedir() : process.cwd());
    const workspace = yield* ask(
      Prompt.text({
        message: "Where are your projects?",
        default: tildify(workspaceDefault),
      }),
    ).pipe(
      Effect.map((value) =>
        path.resolve(value.trim().replace(/^~(?=$|\/)/u, homedir()) || workspaceDefault),
      ),
    );

    const reach: Reach[] = [];
    yield* Console.log(dim("  How should your other devices reach this computer?"));
    if (
      yield* ask(
        Prompt.confirm({
          message:
            "From anywhere, through your Ryco account? (Hub relay, end-to-end encrypted, no open ports)",
          initial: current?.hub?.enabled ?? true,
        }),
      )
    ) {
      reach.push("hub");
    }
    if (
      tailscale.magicDnsName !== null &&
      (yield* ask(
        Prompt.confirm({
          message: `Over Tailscale? (HTTPS at https://${tailscale.magicDnsName})`,
          initial: current?.tailscaleServe ?? true,
        }),
      ))
    ) {
      reach.push("tailscale");
    }
    if (
      yield* ask(
        Prompt.confirm({
          message: "On this local network? (plain HTTP — only on networks you trust)",
          initial: current?.host === "0.0.0.0",
        }),
      )
    ) {
      reach.push("lan");
    }

    const nodeName = reach.includes("hub")
      ? yield* ask(
          Prompt.text({
            message: "Name this computer",
            default: current?.hub?.nodeName ?? machineName,
          }),
        ).pipe(Effect.map((value) => value.trim() || machineName))
      : current?.hub?.nodeName;

    const lingering = service?.lingering ?? null;
    const background =
      context.platform === null
        ? false
        : yield* ask(
            Prompt.confirm({
              message: backgroundServicePrompt(context.platform, lingering),
              initial: true,
            }),
          );
    const preventSleep = background
      ? yield* ask(
          Prompt.confirm({
            message: "Keep this computer awake while it is plugged in?",
            initial: current?.preventSleep ?? true,
          }),
        )
      : (current?.preventSleep ?? false);

    const host = reach.includes("lan") ? "0.0.0.0" : "127.0.0.1";
    // A background node keeps one port, so its pairing links and Tailscale
    // Serve mapping stay valid across restarts.
    const port =
      current?.port ??
      (background
        ? yield* NetService.use((net) => net.findAvailablePort(DEFAULT_NODE_PORT, host)).pipe(
            Effect.orElseSucceed(() => undefined),
          )
        : undefined);
    const config: NodeConfig = {
      ...current,
      version: 1,
      workspace,
      host,
      ...(port === undefined ? {} : { port }),
      tailscaleServe: reach.includes("tailscale"),
      hub: {
        ...current?.hub,
        enabled: reach.includes("hub"),
        ...(nodeName === undefined ? {} : { nodeName }),
      },
      preventSleep,
    };
    return { config, background, lingering };
  });

const describeReach = (config: NodeConfig) => {
  const parts = [
    ...(config.hub?.enabled ? ["your Ryco account"] : []),
    ...(config.tailscaleServe ? ["Tailscale"] : []),
    ...(config.host === "0.0.0.0" ? ["local network"] : []),
  ];
  return parts.length > 0 ? parts.join(" · ") : "this computer only";
};

// ─── applying ─────────────────────────────────────────────────────────────────

/**
 * A service needs a CLI that survives a reboot. Launched through npx, offer to
 * install `ryco-cli` globally and return the installed entry script.
 */
const ensureDurableCli = (context: SetupContext): SetupEffect<string | undefined | null> =>
  Effect.gen(function* () {
    const script = process.argv[1];
    if (script === undefined || !isEphemeralCliInstall(script)) return undefined;
    const install = yield* ask(
      Prompt.confirm({
        message: `A background service cannot run from the npx cache. Install ryco-cli ${context.version} globally with npm?`,
        initial: true,
      }),
    );
    if (!install) return null;
    yield* Console.log(dim(`$ npm install -g ryco-cli@${context.version}`));
    const exitCode = yield* promise(
      () =>
        new Promise<number>((resolve, reject) => {
          const child = spawn("npm", ["install", "-g", `ryco-cli@${context.version}`], {
            stdio: "inherit",
          });
          child.on("error", reject);
          child.on("exit", (code) => resolve(code ?? 1));
        }),
    );
    if (exitCode !== 0) {
      yield* Console.log(
        statusLine("warn", "npm could not install ryco-cli globally (it may need sudo)."),
      );
      return null;
    }
    const prefix = yield* promise(
      () =>
        new Promise<string>((resolve, reject) => {
          let output = "";
          const child = spawn("npm", ["prefix", "-g"], { stdio: ["ignore", "pipe", "inherit"] });
          child.stdout.on("data", (chunk: Buffer) => {
            output += chunk.toString();
          });
          child.on("error", reject);
          child.on("exit", () => resolve(output.trim()));
        }),
    );
    const installed =
      process.platform === "win32"
        ? path.join(prefix, "node_modules", "ryco-cli", "dist", "bin.mjs")
        : path.join(prefix, "lib", "node_modules", "ryco-cli", "dist", "bin.mjs");
    if (!existsSync(installed)) {
      yield* Console.log(statusLine("warn", `Installed, but ${installed} was not found.`));
      return null;
    }
    yield* Console.log(statusLine("ok", "Installed ryco-cli globally"));
    return installed;
  });

const waitForServer = (operations: SetupOperations, seconds: number) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < seconds; attempt += 1) {
      const origin = yield* operations.serverOrigin;
      if (origin !== null) return origin;
      yield* Effect.sleep(1_000);
    }
    return null;
  });

/**
 * Offer to let the systemd unit outlive logout and start at boot.
 *
 * Never silent: lingering changes system state through sudo, so it runs only
 * after the user approved the exact command, in this terminal where sudo can
 * ask for a password. Declining keeps the unit, with a warning that says when
 * it stops and how to change that later.
 */
const offerNodeServiceLinger = (context: SetupContext): SetupEffect<void> =>
  Effect.gen(function* () {
    const status = yield* readServiceStatus(context);
    const plan = planNodeServiceLinger({
      platform: context.platform,
      lingering: status?.lingering,
      user: nodeServiceUser(),
      uid: process.getuid?.(),
    });
    if (plan.kind === "not-needed") return;
    const approved = yield* ask(
      Prompt.confirm({
        message: `Keep Ryco running after you log out and start it at boot? (runs \`${plan.display}\`)`,
        initial: true,
      }),
    );
    if (approved) {
      yield* Console.log(dim(`$ ${plan.display}`));
      const exitCode = yield* runInTerminal(plan.command, plan.args).pipe(
        Effect.orElseSucceed(() => 1),
      );
      const after = yield* readServiceStatus(context);
      if (exitCode === 0 && after?.lingering === true) {
        yield* Console.log(
          statusLine("ok", "Ryco keeps running after you log out and starts at boot"),
        );
        return;
      }
    }
    yield* Console.log(
      statusLine(
        "warn",
        `Ryco stops when you log out and starts at your next login. Run \`${plan.display}\` to keep it running.`,
      ),
    );
  });

/** Save the settings and (re)start the node the way the answers asked for. */
const applyNodeSettings = (
  context: SetupContext,
  operations: SetupOperations,
  answers: GuidedAnswers,
): SetupEffect<{ readonly origin: string | null; readonly background: boolean }> =>
  Effect.gen(function* () {
    yield* promise(() => writeNodeConfig(context.configPath, answers.config));
    yield* Console.log(statusLine("ok", `Saved settings to ${tildify(context.configPath)}`));
    if (!answers.background || context.platform === null) {
      return { origin: yield* operations.serverOrigin, background: false };
    }
    const scriptPath = yield* ensureDurableCli(context);
    if (scriptPath === null) {
      yield* Console.log(
        statusLine("off", "Skipped the background service; you can run Ryco in this terminal."),
      );
      return { origin: yield* operations.serverOrigin, background: false };
    }
    yield* promise(() =>
      installServiceForNode({
        platform: context.platform!,
        label: context.serviceLabel,
        baseDir: context.baseDir,
        logPath: context.logPath,
        workspace: answers.config.workspace,
        ...(scriptPath === undefined ? {} : { scriptPath }),
      }),
    );
    yield* Console.log(statusLine("ok", "Background service installed"));
    yield* offerNodeServiceLinger(context);
    yield* Console.log(dim("  Starting Ryco…"));
    const origin = yield* waitForServer(operations, 60);
    yield* Console.log(
      origin === null
        ? statusLine(
            "warn",
            `Ryco has not answered yet. Check \`${context.commandPrefix} service logs -f\`.`,
          )
        : statusLine("ok", `Ryco is running at ${origin}`),
    );
    return { origin, background: true };
  });

// ─── linking the account ─────────────────────────────────────────────────────

const linkAccount = (
  context: SetupContext,
  operations: SetupOperations,
  config: NodeConfig,
): SetupEffect<void> =>
  Effect.gen(function* () {
    const hubOrigin = config.hub?.origin ?? DEFAULT_HOSTED_APP_ORIGIN;
    const method = yield* ask(
      Prompt.select<"password" | "code" | "later">({
        message: "Link this computer to your Ryco account",
        choices: [
          {
            title: "Sign in here",
            description: "Your username, password, and second-factor code",
            value: "password",
          },
          {
            title: "Approve a code in the Ryco app",
            description: "For accounts that sign in with a passkey or GitHub",
            value: "code",
          },
          { title: "Later", value: "later" },
        ],
      }),
    );
    if (method === "later") {
      yield* Console.log(dim(`  Link it any time with \`${context.commandPrefix} hub login\`.`));
      return;
    }
    if (method === "password") {
      const linked = yield* operations.hubLogin(hubOrigin).pipe(
        Effect.catchTag("QuitError", (quit) => Effect.fail(quit)),
        Effect.catch((error) =>
          Console.log(statusLine("warn", toSetupError(error).message)).pipe(Effect.as(false)),
        ),
      );
      if (linked) yield* Console.log(statusLine("ok", "Linked to your Ryco account"));
      return;
    }
    const ceremony = yield* operations.startHubEnrollment.pipe(Effect.mapError(toSetupError));
    yield* Console.log(
      [
        "",
        `  Open ${cyan(hubOrigin)} → your machines → ${bold("Enroll node")}, and enter:`,
        "",
        `      ${bold(ceremony.deviceCode)}`,
        "",
        `  Approve only if the Hub shows "${ceremony.label}" with this fingerprint:`,
        `      ${ceremony.fingerprint}`,
        "",
      ].join("\n"),
    );
    yield* ask(Prompt.confirm({ message: "Approved it in the Ryco app?", initial: true }));
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const hub = yield* operations.hubState;
      if (hub?.enrolled === "active") {
        yield* Console.log(statusLine("ok", "Linked to your Ryco account"));
        return;
      }
      yield* Effect.sleep(1_000);
    }
    yield* Console.log(
      statusLine("off", "Not linked yet — it finishes on its own once the code is approved."),
    );
  });

// ─── pairing a device ────────────────────────────────────────────────────────

const showPairing = (
  operations: SetupOperations,
  config: NodeConfig,
  origin: string,
): Effect.Effect<void, SetupError> =>
  Effect.gen(function* () {
    const credential = yield* operations
      .createOwnerPairingCredential(15)
      .pipe(Effect.mapError(toSetupError));
    const port = Number(new URL(origin).port) || 3773;
    const endpoints = yield* promise(() =>
      resolveServerAdvertisedEndpointsWithTailscale({
        host: config.host,
        port,
        networkInterfaces: networkInterfaces(),
        tailscaleServeEnabled: config.tailscaleServe === true,
        ...(config.tailscaleServePort === undefined
          ? {}
          : { tailscaleServePort: config.tailscaleServePort }),
        readMagicDnsName: readCachedTailscaleMagicDnsName,
      }),
    );
    const links = resolveHeadlessServeLinks({
      endpoints,
      credential,
      fallbackConnectionString: origin.replace(/\/$/u, ""),
    });
    yield* Console.log(
      [
        "",
        "  Scan with the Ryco app or a phone camera, or open a link on the device:",
        "",
        renderTerminalQrCode(links.pairingUrl),
        "",
        `  ${links.pairingUrl}`,
        ...links.alternativeLinks.map((link) => `  ${dim(`${link.label}:`)} ${link.url}`),
        "",
        dim("  One-time link for your own devices, valid for 15 minutes."),
        ...(config.hub?.enabled
          ? [
              dim(
                "  Devices signed in to your Ryco account find this computer under your machines — no pairing needed.",
              ),
            ]
          : []),
        "",
      ].join("\n"),
    );
  });

// ─── logs and editing ────────────────────────────────────────────────────────

/**
 * Run a terminal program in the foreground; Ctrl+C ends it and returns here.
 *
 * The terminal delivers Ctrl+C to this process too, and the Effect runtime's own
 * SIGINT handler would end the whole CLI. Its listeners are set aside while the
 * program runs and put back afterwards.
 */
const runInTerminal = (command: string, args: ReadonlyArray<string>) =>
  promise(
    () =>
      new Promise<number>((resolve, reject) => {
        const saved = process.listeners("SIGINT");
        process.removeAllListeners("SIGINT");
        const ignoreInterrupt = () => undefined;
        process.on("SIGINT", ignoreInterrupt);
        // A prompt leaves the terminal in raw mode, where Ctrl+C is a keypress
        // rather than a signal the program would receive.
        const wasRaw = process.stdin.isTTY === true && process.stdin.isRaw === true;
        if (wasRaw) process.stdin.setRawMode(false);
        const restore = () => {
          if (wasRaw) process.stdin.setRawMode(true);
          process.off("SIGINT", ignoreInterrupt);
          for (const listener of saved) process.on("SIGINT", listener);
        };
        const child = spawn(command, [...args], { stdio: "inherit" });
        child.on("error", (error) => {
          restore();
          reject(error);
        });
        child.on("exit", (code) => {
          restore();
          resolve(code ?? 0);
        });
      }),
  );

const followLogs = (context: SetupContext) =>
  Effect.gen(function* () {
    if (!existsSync(context.logPath)) {
      yield* Console.log(statusLine("off", "No log yet — the background service has not run."));
      return;
    }
    yield* Console.log(dim(`  ${tildify(context.logPath)} — press Ctrl+C to return.\n`));
    yield* runInTerminal("tail", ["-n", "60", "-F", context.logPath]);
    yield* Console.log("");
  });

const preferredEditor = () =>
  process.env.VISUAL?.trim() ||
  process.env.EDITOR?.trim() ||
  (existsSync("/usr/bin/nano") || existsSync("/opt/homebrew/bin/nano") ? "nano" : "vi");

/** Open `node.json` in the user's editor until it parses, then report what changed. */
export const editNodeConfigFile = (context: SetupContext): SetupEffect<boolean> =>
  Effect.gen(function* () {
    const before = yield* promise(() => readNodeConfig(context.configPath)).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (before === null) {
      yield* promise(() => writeNodeConfig(context.configPath, { version: 1 }));
    }
    for (;;) {
      const [editor, ...editorArgs] = preferredEditor().split(/\s+/u);
      yield* runInTerminal(editor!, [...editorArgs, context.configPath]);
      const raw = yield* promise(() => readFile(context.configPath, "utf8"));
      const parsed = yield* Effect.try({
        try: () => parseNodeConfig(raw, tildify(context.configPath)),
        catch: toSetupError,
      }).pipe(Effect.option);
      if (Option.isSome(parsed)) {
        const changed = JSON.stringify(parsed.value) !== JSON.stringify(before);
        yield* Console.log(
          changed ? statusLine("ok", "Settings saved") : statusLine("off", "No changes"),
        );
        return changed;
      }
      const again = yield* ask(
        Prompt.confirm({
          message: "That file has a setting Ryco does not understand. Edit it again?",
          initial: true,
        }),
      );
      if (!again) {
        if (before !== null) yield* promise(() => writeNodeConfig(context.configPath, before));
        yield* Console.log(statusLine("off", "Restored the previous settings"));
        return false;
      }
    }
  });

const openInBrowser = (url: string) =>
  Effect.sync(() => {
    const command = process.platform === "darwin" ? "open" : "xdg-open";
    const child = spawn(command, [url], { stdio: "ignore", detached: true });
    child.on("error", () => undefined);
    child.unref();
  });

// ─── the two entry points ─────────────────────────────────────────────────────

/** First run: guide through the settings, apply them, link, and pair. */
export const runFirstTimeSetup = (
  context: SetupContext,
  operations: SetupOperations,
  current: NodeConfig | null = null,
): SetupEffect<void> =>
  Effect.gen(function* () {
    const answers = yield* askNodeSettings(context, current);
    yield* Console.log(
      [
        "",
        heading("Ready to set up"),
        `  Projects     ${tildify(answers.config.workspace ?? homedir())}`,
        `  Reachable    ${describeReach(answers.config)}`,
        `  Runs         ${describeRuns({
          background: answers.background,
          preventSleep: answers.config.preventSleep,
          platform: context.platform,
          lingering: answers.lingering,
        })}`,
        "",
      ].join("\n"),
    );
    const proceed = yield* ask(Prompt.confirm({ message: "Apply these settings?", initial: true }));
    if (!proceed) {
      yield* Console.log(dim("  Nothing was changed."));
      return;
    }
    const { origin, background } = yield* applyNodeSettings(context, operations, answers);

    if (origin !== null && answers.config.hub?.enabled) {
      const hub = yield* operations.hubState;
      if (hub?.enrolled !== "active") yield* linkAccount(context, operations, answers.config);
    }
    if (origin !== null) {
      const pair = yield* ask(
        Prompt.confirm({ message: "Pair a phone, browser, or other computer now?", initial: true }),
      );
      if (pair) yield* showPairing(operations, answers.config, origin);
    }

    const prefix = background ? "ryco" : context.commandPrefix;
    yield* Console.log(
      [
        heading("Next"),
        `  ${prefix} setup          status, pairing, logs, and settings`,
        ...(background
          ? [`  ${prefix} service logs -f   follow the background server`]
          : [`  ${prefix} serve          start Ryco with these settings`]),
        "",
      ].join("\n"),
    );
    if (!background) {
      const startNow = yield* ask(
        Prompt.confirm({ message: "Start Ryco in this terminal now?", initial: true }),
      );
      if (startNow) {
        yield* operations.runInForeground.pipe(Effect.mapError(toSetupError));
      }
    }
  });

type MenuAction =
  | "pair"
  | "open"
  | "link"
  | "logs"
  | "restart"
  | "stop"
  | "start"
  | "foreground"
  | "settings"
  | "edit"
  | "remove"
  | "quit";

/** Later runs: a status screen and the things people come back for. */
export const runNodeManager = (
  context: SetupContext,
  operations: SetupOperations,
): SetupEffect<void> =>
  Effect.gen(function* () {
    for (;;) {
      const config = yield* promise(() => readNodeConfig(context.configPath));
      const [service, origin, hub] = yield* Effect.all(
        [readServiceStatus(context), operations.serverOrigin, operations.hubState],
        { concurrency: "unbounded" },
      );
      const installed = service?.installed === true;
      yield* Console.log(
        [
          "",
          heading(`Ryco ${dim(`v${context.version}`)}`),
          origin !== null
            ? statusLine(
                "ok",
                `Running${service?.running ? ` in the background (pid ${service.pid ?? "?"})` : ""} at ${origin}`,
              )
            : installed
              ? statusLine("warn", "Background service installed but not running")
              : statusLine("off", "Not running"),
          config?.hub?.enabled
            ? hub?.enrolled === "active"
              ? statusLine(
                  hub.connector === "online" ? "ok" : "warn",
                  `Ryco account linked · ${hub.connector === "online" ? "online through the Hub" : hub.connector}`,
                )
              : statusLine("warn", "Ryco account not linked yet")
            : statusLine("off", "Ryco account relay off"),
          ...(config?.tailscaleServe ? [statusLine("ok", "Tailscale HTTPS on")] : []),
          ...(config?.host === "0.0.0.0" ? [statusLine("ok", "Local network on")] : []),
          `  ${dim(`Projects ${tildify(config?.workspace ?? homedir())} · settings ${tildify(context.configPath)}`)}`,
          "",
        ].join("\n"),
      );

      const choices: Array<Prompt.SelectChoice<MenuAction>> = [
        ...(origin !== null
          ? [
              { title: "Pair a device", value: "pair" as const },
              { title: "Open Ryco in the browser here", value: "open" as const },
            ]
          : []),
        ...(origin !== null && config?.hub?.enabled && hub?.enrolled !== "active"
          ? [{ title: "Link to your Ryco account", value: "link" as const }]
          : []),
        ...(installed ? [{ title: "Show live logs", value: "logs" as const }] : []),
        ...(installed && service?.running
          ? [
              { title: "Restart", value: "restart" as const },
              { title: "Stop", value: "stop" as const },
            ]
          : []),
        ...(installed && !service?.running
          ? [{ title: "Start in the background", value: "start" as const }]
          : []),
        ...(!installed && origin === null
          ? [{ title: "Start in this terminal", value: "foreground" as const }]
          : []),
        { title: "Change settings", value: "settings" as const },
        {
          title: "Edit the settings file",
          description: preferredEditor(),
          value: "edit" as const,
        },
        ...(installed
          ? [{ title: "Remove the background service", value: "remove" as const }]
          : []),
        { title: "Quit", value: "quit" as const },
      ];
      const action = yield* ask(Prompt.select({ message: "What would you like to do?", choices }));
      const platform = context.platform;
      switch (action) {
        case "quit":
          return;
        case "pair":
          if (origin !== null && config !== null) yield* showPairing(operations, config, origin);
          break;
        case "open":
          if (origin !== null) {
            const credential = yield* operations
              .createOwnerPairingCredential(5)
              .pipe(Effect.mapError(toSetupError));
            const url = new URL("/pair", origin);
            url.hash = new URLSearchParams([["token", credential]]).toString();
            yield* openInBrowser(url.toString());
            yield* Console.log(statusLine("ok", "Opened Ryco in your browser"));
          }
          break;
        case "link":
          if (config !== null) yield* linkAccount(context, operations, config);
          break;
        case "logs":
          yield* followLogs(context);
          break;
        case "restart":
          if (platform !== null) {
            yield* promise(() => restartNodeService(platform, context.serviceLabel));
            yield* Console.log(statusLine("ok", "Restarting…"));
            yield* waitForServer(operations, 30);
          }
          break;
        case "stop":
          if (platform !== null) {
            yield* promise(() => stopNodeService(platform, context.serviceLabel));
            yield* Console.log(statusLine("ok", "Stopped until you start it, log in, or reboot"));
          }
          break;
        case "start":
          if (platform !== null) {
            yield* promise(() => startNodeService(platform, context.serviceLabel));
            yield* Console.log(dim("  Starting Ryco…"));
            yield* waitForServer(operations, 30);
          }
          break;
        case "foreground":
          yield* operations.runInForeground.pipe(Effect.mapError(toSetupError));
          return;
        case "settings": {
          const answers = yield* askNodeSettings(context, config);
          const proceed = yield* ask(
            Prompt.confirm({ message: "Apply these settings?", initial: true }),
          );
          if (proceed) {
            // Re-installing replaces the service in place and restarts it.
            yield* applyNodeSettings(context, operations, {
              ...answers,
              background: answers.background || installed,
            });
          }
          break;
        }
        case "edit": {
          const changed = yield* editNodeConfigFile(context);
          if (changed && installed && platform !== null) {
            const restart = yield* ask(
              Prompt.confirm({ message: "Restart Ryco to use them?", initial: true }),
            );
            if (restart) {
              yield* promise(() => restartNodeService(platform, context.serviceLabel));
              yield* waitForServer(operations, 30);
            }
          }
          break;
        }
        case "remove":
          if (platform !== null) {
            const sure = yield* ask(
              Prompt.confirm({
                message:
                  "Remove the background service? Settings, projects, and pairings are kept.",
                initial: false,
              }),
            );
            if (sure) {
              yield* promise(() => uninstallNodeService(platform, context.serviceLabel));
              yield* Console.log(statusLine("ok", "Removed the background service"));
            }
          }
          break;
      }
    }
  });

/** `ryco setup`: the guide the first time, the manager afterwards. */
export const runSetup = (context: SetupContext, operations: SetupOperations): SetupEffect<void> =>
  Effect.gen(function* () {
    const config = yield* promise(() => readNodeConfig(context.configPath));
    if (config === null) {
      yield* runFirstTimeSetup(context, operations);
      return;
    }
    yield* runNodeManager(context, operations);
  });
