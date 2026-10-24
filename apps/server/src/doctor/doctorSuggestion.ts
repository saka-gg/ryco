/**
 * doctorSuggestion - when the Storage settings surface (and the server log, once per boot)
 * suggests running `ryco doctor --apply`, and the command to show.
 *
 * Only a database created before automatic shrinking (`auto_vacuum = NONE`) keeps its free pages
 * inside the file; an incremental one returns them online, and a FULL one at every commit. The
 * doctor is worth a stopped server once at least 1 GiB could be returned. The command must run
 * against the same data directory with the same Ryco version (the doctor refuses a schema it does
 * not know): a `ryco serve` or service node gets `ryco doctor --apply`, the desktop app the CLI of
 * its own version through npx (Node.js 22.16 or newer). Development databases get no command.
 *
 * @module doctorSuggestion
 */
import * as NodePath from "node:path";

import { quoteShellWord } from "../shellQuote.ts";

/** Reclaimable space from which the doctor is suggested (with automatic shrinking off). */
export const DOCTOR_SUGGESTION_MIN_RECLAIMABLE_BYTES = 1024 ** 3;

export interface DoctorSuggestion {
  readonly recommended: boolean;
  /** The command to run (after stopping the server); null for development databases. */
  readonly command: string | null;
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
  const baseDir = NodePath.resolve(input.baseDir);
  // A `--dev-url` database (`<baseDir>/dev/state.sqlite`) or one a test or script placed elsewhere.
  if (NodePath.resolve(input.dbPath) !== NodePath.join(baseDir, "userdata", "state.sqlite")) {
    return null;
  }
  const program = input.mode === "desktop" ? `npx ryco-cli@${input.version}` : "ryco";
  const location =
    baseDir === NodePath.resolve(input.defaultBaseDir)
      ? ""
      : ` --base-dir ${quoteShellWord(baseDir, input.platform ?? process.platform)}`;
  return `${program} doctor --apply${location}`;
}

export function doctorSuggestion(input: {
  readonly autoVacuum: "none" | "full" | "incremental";
  readonly reclaimableBytes: number;
  readonly mode: "web" | "desktop";
  readonly baseDir: string;
  readonly dbPath: string;
  readonly defaultBaseDir: string;
  readonly version: string;
  readonly platform?: NodeJS.Platform;
}): DoctorSuggestion {
  return {
    recommended:
      input.autoVacuum === "none" &&
      input.reclaimableBytes >= DOCTOR_SUGGESTION_MIN_RECLAIMABLE_BYTES,
    command: doctorCommandFor(input),
  };
}
