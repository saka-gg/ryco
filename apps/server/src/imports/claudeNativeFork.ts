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
  sourceFile: string;
  sourceId: string;
  lastMessageId: string;
  cwd: string;
  key: string;
}): Promise<string> {
  const sdk = createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk");
  const result = await runProcess(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", CLAUDE_CONFIG_DIR: input.root },
    stdin: JSON.stringify({ ...input, sdk: pathToFileURL(sdk).href }),
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
