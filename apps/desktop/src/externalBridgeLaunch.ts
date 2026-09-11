import { resolve } from "node:path";

/** Only dispatch our bundled CLI, never an arbitrary script passed to the app. */
export function externalBridgeLaunchArgs(
  argv: readonly string[],
  bundledEntryPoint: string,
): string[] | null {
  if (
    !argv[1] ||
    resolve(argv[1]) !== resolve(bundledEntryPoint) ||
    argv[2] !== "mcp" ||
    (argv[3] !== "pair" && argv[3] !== "serve")
  ) {
    return null;
  }
  return [bundledEntryPoint, ...argv.slice(2)];
}
