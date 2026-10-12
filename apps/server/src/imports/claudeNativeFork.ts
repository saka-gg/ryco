import { lstat, realpath, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { runProcess } from "../processRunner.ts";

// Run the SDK in an isolated process: its configuration-directory cache must not
// inherit another provider instance, and a stuck filesystem call needs a deadline.
// Every script starts with this prelude: the request, the SDK, and the SDK's own
// project key for a cwd (never a reimplementation of its platform/path codec).
const prelude = `
import { mkdir, realpath, link, unlink, lstat } from 'node:fs/promises';
import path from 'node:path';
let input = ''; for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const sdk = await import(request.sdk);
const projectKeyFor = async (dir) => {
  let projectKey;
  await sdk.listSessions({ dir, sessionStore: {
   append: async () => {}, load: async () => null,
   listSessions: async key => { projectKey = key; return []; }
  } });
  if (typeof projectKey !== 'string' || !/^[a-zA-Z0-9-]+$/.test(projectKey)) throw new Error('unsupported SDK project key');
  return projectKey;
};
`;

async function runClaudeSdkScript(
  body: string,
  input: {
    readonly root: string;
    readonly environment?: NodeJS.ProcessEnv | undefined;
    readonly request: Record<string, unknown>;
    readonly maxBufferBytes: number;
  },
): Promise<unknown> {
  const sdk = createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk");
  const result = await runProcess(
    process.execPath,
    ["--input-type=module", "-e", `${prelude}${body}`],
    {
      env: {
        ...(input.environment ?? process.env),
        ELECTRON_RUN_AS_NODE: "1",
        CLAUDE_CONFIG_DIR: input.root,
      },
      stdin: JSON.stringify({ ...input.request, root: input.root, sdk: pathToFileURL(sdk).href }),
      timeoutMs: 30000,
      maxBufferBytes: input.maxBufferBytes,
    },
  );
  return JSON.parse(result.stdout);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const SESSION_ID_PATTERN = /^[a-f0-9-]{36}$/i;
const PROJECT_KEY_PATTERN = /^[a-zA-Z0-9-]+$/;

/** A copy `forkClaudeNative` created, at its relocated transcript path. */
export interface ClaudeNativeCopy {
  readonly sessionId: string;
  /** `<root>/projects/<key(cwd)>/<sessionId>.jsonl`, canonical. */
  readonly file: string;
}

/**
 * How far a native fork got. The script reports its stage instead of failing opaquely, so a
 * caller can tell "nothing was created" from "a copy with this id exists":
 * - `created`: the copy is in the target cwd's project directory and readable from there.
 * - `not-created`: a step before the SDK fork failed; no copy exists.
 * - `created-unusable`: the SDK created the copy (its id is known), then moving or reading it
 *   failed. `files` are every path the copy currently has; the caller owns and may remove them.
 *
 * A failure inside the SDK call itself, an invalid fork identity, a crash, a timeout or unreadable
 * output is thrown: a copy may then exist under an unknown id.
 */
export type ClaudeNativeForkResult =
  | { readonly kind: "created"; readonly copy: ClaudeNativeCopy }
  | { readonly kind: "not-created"; readonly detail: string }
  | {
      readonly kind: "created-unusable";
      readonly sessionId: string;
      readonly files: ReadonlyArray<string>;
      readonly detail: string;
    };

/**
 * Copies a Claude session up to `lastMessageId` (inclusive) with the SDK's `forkSession`, then
 * moves the copy into the target cwd's project directory so a resume there finds it. The copy
 * gets fresh uuids and `title`. See `ClaudeNativeForkResult` for what each outcome proves.
 */
export async function forkClaudeNativeCopy(input: {
  root: string;
  environment?: NodeJS.ProcessEnv;
  /** The source transcript; the SDK writes the copy next to it. */
  sourceFile: string;
  sourceId: string;
  /** Project directory the SDK resolves the source in; omitted: it searches every project. */
  sourceCwd?: string;
  lastMessageId: string;
  cwd: string;
  title: string;
}): Promise<ClaudeNativeForkResult> {
  const { environment, root, ...request } = input;
  const response = await runClaudeSdkScript(
    `
let stage = 'preflight';
let sessionId;
let files = [];
try {
  const root = await realpath(request.root);
  const targetDir = path.join(root, 'projects', await projectKeyFor(request.cwd));
  await mkdir(targetDir, { recursive: true });
  if (await realpath(targetDir) !== targetDir) throw new Error('linked destination refused');
  stage = 'forking';
  const fork = await sdk.forkSession(request.sourceId, {
    upToMessageId: request.lastMessageId,
    title: request.title,
    ...(request.sourceCwd ? { dir: request.sourceCwd } : {}),
  });
  if (fork.sessionId === request.sourceId || !/^[a-f0-9-]{36}$/i.test(fork.sessionId)) throw new Error('invalid fork identity');
  sessionId = fork.sessionId;
  const sourceFile = path.join(path.dirname(request.sourceFile), sessionId + '.jsonl');
  const targetFile = path.join(targetDir, sessionId + '.jsonl');
  stage = 'relocating';
  files = [sourceFile];
  if ((await lstat(sourceFile)).isSymbolicLink() || await realpath(sourceFile) !== sourceFile) throw new Error('linked copy refused');
  if (sourceFile !== targetFile) {
    await link(sourceFile, targetFile);
    files = [sourceFile, targetFile];
    await unlink(sourceFile);
    files = [targetFile];
  }
  const messages = await sdk.getSessionMessages(sessionId, { dir: request.cwd });
  if (!messages.length) throw new Error('fork unavailable from target cwd');
  process.stdout.write(JSON.stringify({ ok: true, sessionId, file: targetFile }));
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  process.stdout.write(JSON.stringify({ ok: false, stage, sessionId: sessionId ?? null, files, detail }));
}
`,
    { root, environment, request, maxBufferBytes: 16 * 1024 },
  );
  if (!isRecord(response) || typeof response.ok !== "boolean") {
    throw new Error("Invalid native fork response.");
  }
  if (response.ok) {
    if (typeof response.sessionId !== "string" || typeof response.file !== "string") {
      throw new Error("Invalid native fork response.");
    }
    return { kind: "created", copy: { sessionId: response.sessionId, file: response.file } };
  }
  const detail =
    typeof response.detail === "string" && response.detail.trim().length > 0
      ? response.detail
      : "The Claude fork failed.";
  if (response.stage === "preflight") return { kind: "not-created", detail };
  if (
    response.stage === "relocating" &&
    typeof response.sessionId === "string" &&
    SESSION_ID_PATTERN.test(response.sessionId) &&
    Array.isArray(response.files) &&
    response.files.length > 0 &&
    response.files.every((file): file is string => typeof file === "string")
  ) {
    return {
      kind: "created-unusable",
      sessionId: response.sessionId,
      files: response.files,
      detail,
    };
  }
  // Failed inside the SDK fork (or reported nothing usable): a copy may exist under an unknown id.
  throw new Error(`The Claude fork did not finish: ${detail}`);
}

/**
 * `forkClaudeNativeCopy` for callers that only use a created copy: any other outcome is thrown
 * (session import reports it as a failed import).
 */
export async function forkClaudeNative(
  input: Parameters<typeof forkClaudeNativeCopy>[0],
): Promise<ClaudeNativeCopy> {
  const result = await forkClaudeNativeCopy(input);
  if (result.kind === "created") return result.copy;
  throw new Error(result.detail);
}

// Recovery never relocates/deletes files. A copy interrupted before relocation
// is retained and reported as incompatible until the native target is complete.
export async function verifyClaudeNative(input: {
  root: string;
  environment?: NodeJS.ProcessEnv;
  cwd: string;
  candidateId: string;
  candidateFile: string;
}): Promise<boolean> {
  const { environment, root, ...request } = input;
  const response = await runClaudeSdkScript(
    `
const expected = path.join(await realpath(request.root), 'projects', await projectKeyFor(request.cwd), request.candidateId + '.jsonl');
if (request.candidateFile !== expected || await realpath(expected) !== expected) { process.stdout.write(JSON.stringify({ compatible: false })); process.exit(0); }
const messages = await sdk.getSessionMessages(request.candidateId, { dir: request.cwd });
process.stdout.write(JSON.stringify({ compatible: messages.length > 0 && messages.every(message => message.session_id === request.candidateId) }));
`,
    { root, environment, request, maxBufferBytes: 4096 },
  );
  if (!isRecord(response) || typeof response.compatible !== "boolean")
    throw new Error("Invalid native verification response.");
  return response.compatible;
}

/** Longest main chain `readClaudeMainChain` returns; a longer one is refused. */
export const CLAUDE_MAIN_CHAIN_MAX_ENTRIES = 50_000;

export interface ClaudeMainChainEntry {
  readonly uuid: string;
  readonly type: string;
}

export type ClaudeMainChain =
  /** No transcript for the session in the cwd's project directory (or it is linked). */
  | { readonly found: false }
  | {
      readonly found: true;
      /** `<root>/projects/<key(cwd)>/<sessionId>.jsonl`, canonical. */
      readonly file: string;
      /** Main-chain entries (subagent sidechains excluded), oldest first, system entries kept. */
      readonly chain: ReadonlyArray<ClaudeMainChainEntry>;
      /** Every transcript message carries this session's id. */
      readonly sameSession: boolean;
    };

/**
 * Reads a session's main transcript chain from the cwd's project directory only, in the
 * instance's config root. Read-only. Fails when the transcript is malformed or longer than
 * `CLAUDE_MAIN_CHAIN_MAX_ENTRIES`.
 */
export async function readClaudeMainChain(input: {
  root: string;
  environment?: NodeJS.ProcessEnv;
  sessionId: string;
  cwd: string;
}): Promise<ClaudeMainChain> {
  const { environment, root, ...request } = input;
  const response = await runClaudeSdkScript(
    `
const file = path.join(await realpath(request.root), 'projects', await projectKeyFor(request.cwd), request.sessionId + '.jsonl');
let info = null; try { info = await lstat(file); } catch {}
if (!info || !info.isFile() || await realpath(file) !== file) { process.stdout.write(JSON.stringify({ found: false })); process.exit(0); }
const messages = await sdk.getSessionMessages(request.sessionId, { dir: request.cwd, includeSystemMessages: true });
const chain = [];
let sameSession = true;
for (const message of messages) {
  if (message.session_id !== request.sessionId) sameSession = false;
  if (typeof message.uuid === 'string' && (message.parent_tool_use_id === null || message.parent_tool_use_id === undefined)) chain.push([message.uuid, String(message.type)]);
}
if (chain.length > request.maxEntries) throw new Error('transcript too long');
process.stdout.write(JSON.stringify({ found: true, file, sameSession, chain }));
`,
    {
      root,
      environment,
      request: { ...request, maxEntries: CLAUDE_MAIN_CHAIN_MAX_ENTRIES },
      maxBufferBytes: 8 * 1024 * 1024,
    },
  );
  if (!isRecord(response) || typeof response.found !== "boolean")
    throw new Error("Invalid transcript response.");
  if (!response.found) return { found: false };
  if (
    typeof response.file !== "string" ||
    typeof response.sameSession !== "boolean" ||
    !Array.isArray(response.chain)
  )
    throw new Error("Invalid transcript response.");
  const chain = response.chain.map((entry: unknown) => {
    if (!Array.isArray(entry) || typeof entry[0] !== "string" || typeof entry[1] !== "string")
      throw new Error("Invalid transcript response.");
    return { uuid: entry[0], type: entry[1] };
  });
  return { found: true, file: response.file, chain, sameSession: response.sameSession };
}

/**
 * Deletes a Claude session copy Ryco created and recorded: only
 * `<root>/projects/<key>/<sessionId>.jsonl` itself, never through a link. A file that is already
 * gone counts as removed.
 */
export async function removeClaudeSessionCopy(input: {
  root: string;
  sessionId: string;
  file: string;
}): Promise<"removed" | "missing"> {
  const projects = path.join(await realpath(input.root), "projects");
  const segments = path.relative(projects, input.file).split(path.sep);
  if (
    !SESSION_ID_PATTERN.test(input.sessionId) ||
    segments.length !== 2 ||
    !PROJECT_KEY_PATTERN.test(segments[0]!) ||
    segments[1] !== `${input.sessionId}.jsonl`
  )
    throw new Error("Refusing to remove a file outside the Claude session store.");
  const directory = path.dirname(input.file);
  try {
    if (!(await lstat(input.file)).isFile() || (await realpath(directory)) !== directory)
      throw new Error("Refusing to remove a linked Claude session.");
    await unlink(input.file);
    return "removed";
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return "missing";
    throw cause;
  }
}
