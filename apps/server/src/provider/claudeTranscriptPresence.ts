// @effect-diagnostics nodeBuiltinImport:off
/**
 * Whether Claude still keeps a session's transcript, read before a resume.
 *
 * Claude keeps one `<sessionId>.jsonl` per session under `<config root>/projects/<project key>/`
 * and, by default, deletes transcripts older than 30 days. Resuming a deleted session does not
 * fail when the session starts: the CLI reports "No conversation found" only when it reads the
 * first prompt, after the turn was handed to it. Checking the transcript first lets the turn
 * continue by context handoff instead.
 *
 * Conservative, and independent of the SDK's project key: only a readable `projects` directory
 * whose project directories hold no transcript for the id reads as `missing`. A transcript in any
 * project directory reads as `present`. A config root without a `projects` directory is
 * `unknown`, like any other I/O error. `unknown` does not block a resume, so the CLI decides as
 * before.
 *
 * `missing` alone does not prove the transcript was deleted: the CLI may run through a wrapper
 * binary, in a container, or with a `CLAUDE_CONFIG_DIR` set only inside a wrapper, so this root
 * may not be the store it uses even when it has a `projects` directory. The Claude adapter acts on
 * `missing` only for a session whose transcript it saw `present` in this root after a completed
 * turn (the resume cursor's `transcriptSeen`).
 *
 * @module claudeTranscriptPresence
 */
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

export type ClaudeTranscriptPresence = "present" | "missing" | "unknown";

const ABSENT_CODES = new Set(["ENOENT", "ENOTDIR"]);

function errorCode(cause: unknown): string | undefined {
  return typeof cause === "object" && cause !== null && "code" in cause
    ? String(cause.code)
    : undefined;
}

/** Reads whether `<root>/projects/*\/<sessionId>.jsonl` exists. Never throws. */
export async function readClaudeTranscriptPresence(input: {
  /** The instance's Claude config root (`CLAUDE_CONFIG_DIR`, else `~/.claude`). */
  readonly root: string;
  readonly sessionId: string;
}): Promise<ClaudeTranscriptPresence> {
  // A session id names one file: anything that could leave the project directory is unknown.
  if (input.sessionId.length === 0 || /[\\/]|^\.\.?$/.test(input.sessionId)) return "unknown";
  const projects = path.join(input.root, "projects");
  let projectDirectories: ReadonlyArray<string>;
  try {
    projectDirectories = await readdir(projects);
  } catch {
    return "unknown";
  }
  const file = `${input.sessionId}.jsonl`;
  const results = await Promise.all(
    projectDirectories.map(async (directory): Promise<ClaudeTranscriptPresence> => {
      try {
        return (await stat(path.join(projects, directory, file))).isFile() ? "present" : "unknown";
      } catch (cause) {
        return ABSENT_CODES.has(errorCode(cause) ?? "") ? "missing" : "unknown";
      }
    }),
  );
  if (results.includes("present")) return "present";
  return results.includes("unknown") ? "unknown" : "missing";
}
