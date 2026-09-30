import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { runProcess } from "../processRunner.ts";

// Run the SDK in an isolated process: its configuration-directory cache must not
// inherit another provider instance, and a stuck filesystem call needs a deadline.
const script = `
import { mkdir, realpath, link, unlink, lstat } from 'node:fs/promises';
import path from 'node:path';
let input = ''; for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const sdk = await import(request.sdk);
const fork = await sdk.forkSession(request.sourceId, { upToMessageId: request.lastMessageId, title: 'Ryco import ' + request.key });
if (fork.sessionId === request.sourceId || !/^[a-f0-9-]{36}$/i.test(fork.sessionId)) throw new Error('invalid fork identity');
// Ask the SDK for its project key instead of duplicating its platform/path codec.
let projectKey;
await sdk.listSessions({ dir: request.cwd, sessionStore: {
 append: async () => {}, load: async () => null,
 listSessions: async key => { projectKey = key; return []; }
} });
if (typeof projectKey !== 'string' || !/^[a-zA-Z0-9-]+$/.test(projectKey)) throw new Error('unsupported SDK project key');
const root = await realpath(request.root);
const targetDir = path.join(root, 'projects', projectKey);
await mkdir(targetDir, { recursive: true });
if (await realpath(targetDir) !== targetDir) throw new Error('linked destination refused');
const sourceFile = path.join(path.dirname(request.sourceFile), fork.sessionId + '.jsonl');
const targetFile = path.join(targetDir, fork.sessionId + '.jsonl');
if ((await lstat(sourceFile)).isSymbolicLink() || await realpath(sourceFile) !== sourceFile) throw new Error('linked copy refused');
if (sourceFile !== targetFile) { await link(sourceFile, targetFile); await unlink(sourceFile); }
const messages = await sdk.getSessionMessages(fork.sessionId, { dir: request.cwd });
if (!messages.length) throw new Error('fork unavailable from target cwd');
process.stdout.write(JSON.stringify({ sessionId: fork.sessionId }));
`;
export async function forkClaudeNative(input: {
  root: string;
  environment?: NodeJS.ProcessEnv;
  sourceFile: string;
  sourceId: string;
  lastMessageId: string;
  cwd: string;
  key: string;
}): Promise<string> {
  const { environment, ...request } = input;
  const sdk = createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk");
  const result = await runProcess(process.execPath, ["--input-type=module", "-e", script], {
    env: {
      ...(environment ?? process.env),
      ELECTRON_RUN_AS_NODE: "1",
      CLAUDE_CONFIG_DIR: input.root,
    },
    stdin: JSON.stringify({ ...request, sdk: pathToFileURL(sdk).href }),
    timeoutMs: 30000,
    maxBufferBytes: 4096,
  });
  const response: unknown = JSON.parse(result.stdout);
  if (
    !response ||
    typeof response !== "object" ||
    !("sessionId" in response) ||
    typeof response.sessionId !== "string"
  )
    throw new Error("Invalid native fork response.");
  return response.sessionId;
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
  const { environment, ...request } = input;
  const sdk = createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk");
  const result = await runProcess(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
import { realpath } from 'node:fs/promises';
import path from 'node:path';
let input = ''; for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const sdk = await import(request.sdk);
let projectKey;
await sdk.listSessions({ dir: request.cwd, sessionStore: {
 append: async () => {}, load: async () => null,
 listSessions: async key => { projectKey = key; return []; }
} });
if (typeof projectKey !== 'string' || !/^[a-zA-Z0-9-]+$/.test(projectKey)) throw new Error('unsupported project key');
const expected = path.join(await realpath(request.root), 'projects', projectKey, request.candidateId + '.jsonl');
if (request.candidateFile !== expected || await realpath(expected) !== expected) { process.stdout.write(JSON.stringify({ compatible: false })); process.exit(0); }
const messages = await sdk.getSessionMessages(request.candidateId, { dir: request.cwd });
process.stdout.write(JSON.stringify({ compatible: messages.length > 0 && messages.every(message => message.session_id === request.candidateId) }));
`,
    ],
    {
      env: {
        ...(environment ?? process.env),
        ELECTRON_RUN_AS_NODE: "1",
        CLAUDE_CONFIG_DIR: input.root,
      },
      stdin: JSON.stringify({ ...request, sdk: pathToFileURL(sdk).href }),
      timeoutMs: 30000,
      maxBufferBytes: 4096,
    },
  );
  const response: unknown = JSON.parse(result.stdout);
  if (
    !response ||
    typeof response !== "object" ||
    !("compatible" in response) ||
    typeof response.compatible !== "boolean"
  )
    throw new Error("Invalid native verification response.");
  return response.compatible;
}
