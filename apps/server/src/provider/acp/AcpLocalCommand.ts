/**
 * Resolves a local ACP command: an executable already on the node plus literal arguments.
 *
 * The command is an absolute path or a bare name looked up on the instance's PATH, resolved
 * before every spawn. Relative paths and relative PATH entries are refused because sessions run
 * with the project as their working directory, so a repository could plant `./agent`. Nothing is
 * installed, no shell runs, and arguments are passed through exactly as saved.
 *
 * @module provider/acp/AcpLocalCommand
 */
import * as NodePath from "node:path";
import type { AcpRegistrySettings } from "@ryco/contracts";
import { resolveCommandPathAsync } from "@ryco/shared/shell";
import { Data, Effect } from "effect";
import * as AcpErrors from "effect-acp/errors";
import { expandHomePath } from "../../pathExpansion.ts";

/** Why a local command cannot start. `detail` names only the configured command, never env values. */
export class AcpLocalCommandUnavailable extends Data.TaggedError("AcpLocalCommandUnavailable")<{
  readonly detail: string;
}> {}

/** What an ACP agent instance spawns, whichever source it comes from. */
export interface AcpAgentCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
}

export interface AcpLocalCommandDependencies {
  readonly platform: NodeJS.Platform;
  readonly resolve: (
    command: string,
    options: { readonly env: NodeJS.ProcessEnv; readonly platform: NodeJS.Platform },
  ) => Promise<string | null>;
  readonly expandHome: (value: string) => string;
}

const defaultDependencies: AcpLocalCommandDependencies = {
  platform: process.platform,
  resolve: resolveCommandPathAsync,
  expandHome: expandHomePath,
};

const unavailable = (detail: string) =>
  new AcpErrors.AcpTransportError({ detail, cause: new AcpLocalCommandUnavailable({ detail }) });

/**
 * Whether `value` names the same file from any working directory. On Windows a root-relative
 * `\tools` is absolute to Node but takes the current directory's drive, the server's here and the
 * project's at spawn time, so only a drive-qualified or UNC path counts.
 */
function isFullPath(value: string, platform: NodeJS.Platform): boolean {
  return platform === "win32"
    ? /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/u.test(value)
    : NodePath.posix.isAbsolute(value);
}

/**
 * `environment` over the server's, as the spawn sees it, with PATH reduced to full-path entries.
 * A relative entry (`.`, `bin`) would be searched in the server's working directory here and the
 * project's at spawn time, so it never takes part in the lookup.
 */
function lookupEnvironment(
  environment: NodeJS.ProcessEnv | undefined,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  const env = { ...process.env, ...environment };
  const delimiter = platform === "win32" ? ";" : ":";
  const PATH = (env.PATH ?? env.Path ?? env.path ?? "")
    .split(delimiter)
    .filter((entry) => isFullPath(entry.trim().replace(/^"+|"+$/gu, ""), platform))
    .join(delimiter);
  return { ...env, PATH };
}

export const resolveAcpLocalCommand = (
  settings: Pick<AcpRegistrySettings, "command" | "args">,
  environment?: NodeJS.ProcessEnv,
  deps: AcpLocalCommandDependencies = defaultDependencies,
): Effect.Effect<AcpAgentCommand, AcpErrors.AcpTransportError> =>
  Effect.gen(function* () {
    const raw = settings.command.trim();
    if (!raw) return yield* unavailable("Enter the agent's executable.");
    const expanded = deps.expandHome(raw);
    // Decided before any filesystem call, so a relative path never touches the server's cwd.
    if ((expanded.includes("/") || expanded.includes("\\")) && !isFullPath(expanded, deps.platform))
      return yield* unavailable("Use an absolute path or a command name on PATH.");
    const resolved = yield* Effect.tryPromise(() =>
      deps.resolve(expanded, {
        env: lookupEnvironment(environment, deps.platform),
        platform: deps.platform,
      }),
    ).pipe(Effect.orElseSucceed(() => null));
    // Spawned as given, so only a full-path result names the file that was checked.
    if (resolved === null || !isFullPath(resolved, deps.platform))
      return yield* unavailable(`\`${raw}\` was not found on this node.`);
    if (deps.platform === "win32" && /\.(?:cmd|bat)$/iu.test(resolved))
      return yield* unavailable(
        "Local ACP commands launch without a shell. For a Windows batch wrapper, configure the underlying executable (for example node.exe) and pass the script path as an argument.",
      );
    return { command: resolved, args: settings.args, env: {} };
  });

/** The display name a local command gets when the instance has none: its basename, no extension. */
export function acpLocalCommandDisplayName(command: string): string {
  const base = command.trim().split(/[\\/]/u).pop() ?? "";
  const name = base.replace(/\.[^.]+$/u, "") || base;
  return name || "Local ACP agent";
}
