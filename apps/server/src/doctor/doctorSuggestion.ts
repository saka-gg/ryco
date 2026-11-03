/**
 * doctorSuggestion - when the Storage settings surface (and the server log, once per boot)
 * suggests running `ryco doctor --apply`, and the command to show.
 *
 * Only a database created before automatic shrinking (`auto_vacuum = NONE`) keeps its free pages
 * inside the file; an incremental one returns them online, and a FULL one at every commit. The
 * doctor is worth a stopped server once at least 1 GiB could be returned, and only where it can
 * swap the compacted copy in (it must see which processes have the file open, see
 * `fileHolders.ts`). The command must run against the same data directory with the same Ryco
 * version (the doctor refuses a schema it does not know): a `ryco serve` or service node gets
 * `ryco doctor --apply`, the desktop app the CLI of its own version through npx (Node.js 22.16 or
 * newer). Development databases get no command. The doctor's own "run it again" messages use
 * {@link doctorApplyCommand} too.
 *
 * @module doctorSuggestion
 */
import * as NodePath from "node:path";

import { quoteShellWord } from "../shellQuote.ts";
import { canCheckFileHolders } from "./fileHolders.ts";

/** Reclaimable space from which the doctor is suggested (with automatic shrinking off). */
export const DOCTOR_SUGGESTION_MIN_RECLAIMABLE_BYTES = 1024 ** 3;

export interface DoctorSuggestion {
  readonly recommended: boolean;
  /** The command to run (after stopping the server); null for development databases. */
  readonly command: string | null;
}

/**
 * `ryco doctor --apply`, or `npx ryco-cli@<version> doctor --apply` where the CLI runs through
 * npx (an unpinned `npx ryco-cli` runs whatever version is newest), with `--base-dir` when the
 * data directory is not the default and `--dev-url` for a development database.
 */
export function doctorApplyCommand(input: {
  readonly npx: boolean;
  readonly baseDir: string;
  readonly defaultBaseDir: string;
  readonly version: string;
  readonly devUrl?: URL | undefined;
  /** Whose shell quotes the path; the server's own platform by default. */
  readonly platform?: NodeJS.Platform;
}): string {
  const quote = (word: string) => quoteShellWord(word, input.platform ?? process.platform);
  const baseDir = NodePath.resolve(input.baseDir);
  const program = input.npx ? `npx ryco-cli@${input.version}` : "ryco";
  const location =
    baseDir === NodePath.resolve(input.defaultBaseDir) ? "" : ` --base-dir ${quote(baseDir)}`;
  const dev = input.devUrl === undefined ? "" : ` --dev-url ${quote(input.devUrl.href)}`;
  return `${program} doctor --apply${location}${dev}`;
}

/**
 * `ryco doctor --apply` for a node, `npx ryco-cli@<version> doctor --apply` for the desktop app,
 * with `--base-dir` when the data directory is not the default.
 */
export function doctorCommandFor(input: {
  readonly mode: "web" | "desktop";
  readonly baseDir: string;
  readonly dbPath: string;
  readonly defaultBaseDir: string;
  readonly version: string;
  /** Whose shell quotes the path; the server's own platform by default. */
  readonly platform?: NodeJS.Platform;
}): string | null {
  // A `--dev-url` database (`<baseDir>/dev/state.sqlite`) or one a test or script placed elsewhere.
  if (
    NodePath.resolve(input.dbPath) !==
    NodePath.join(NodePath.resolve(input.baseDir), "userdata", "state.sqlite")
  ) {
    return null;
  }
  return doctorApplyCommand({ ...input, npx: input.mode === "desktop" });
}

export function doctorSuggestion(input: {
  readonly autoVacuum: "none" | "full" | "incremental";
  readonly reclaimableBytes: number;
  readonly mode: "web" | "desktop";
  readonly baseDir: string;
  readonly dbPath: string;
  readonly defaultBaseDir: string;
  readonly version: string;
  /** Where the doctor would run (the server's machine); the server's own platform by default. */
  readonly platform?: NodeJS.Platform;
}): DoctorSuggestion {
  return {
    recommended:
      input.autoVacuum === "none" &&
      input.reclaimableBytes >= DOCTOR_SUGGESTION_MIN_RECLAIMABLE_BYTES &&
      canCheckFileHolders(input.platform ?? process.platform),
    command: doctorCommandFor(input),
  };
}
