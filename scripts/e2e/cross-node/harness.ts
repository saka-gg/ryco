/**
 * Cross-node E2E harness. Node A runs from this checkout's source on the host;
 * node B runs the same source in a `node:24-bookworm` container whose hostname
 * is `linux-box`. Both reach one bare origin through the fake ssh in `fake-ssh`,
 * so `git@fixture.test:/abs/path/origin.git` clones, fetches and pushes without
 * a network. The fixture directory is bind-mounted into the container at the
 * same absolute path; on macOS that is the `/private/tmp/...` form, because the
 * container cannot follow the host's `/tmp` symlink.
 *
 * Both nodes are paired as owner exactly the way `ryco remote add` pairs a
 * remote (the startup owner token, exchanged for a bearer session), and are
 * driven over the WebSocket RPC the apps use. See README.md.
 */
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  CommandId,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  type ProjectScript,
} from "@ryco/contracts";
import { buildDirectPairingUrl } from "@ryco/shared/pairingUrl";
import { Effect, Exit, Scope } from "effect";

import {
  type CliRemote,
  type CliRemoteRpcClient,
  connectCliRemote,
  pairCliRemote,
} from "../../../apps/server/src/cliRemote/remotes.ts";

export const HARNESS_DIR = import.meta.dirname;
export const REPO_ROOT = path.resolve(HARNESS_DIR, "../../..");
export const FAKE_SSH_PATH = path.join(HARNESS_DIR, "fake-ssh");
export const DEFAULT_NODE_IMAGE = "ryco-xnode-node:e2e";
/** Every container the harness starts carries it, so leftovers are easy to find. */
export const CONTAINER_LABEL = "ryco.e2e=cross-node";
/** The host name node B reports, and so its environment label. */
export const CONTAINER_HOSTNAME = "linux-box";
/** A well-known code root baked into the image (node.Dockerfile). */
export const CONTAINER_CODE_DIRECTORY = "/root/code";
/** Node B's base dir. */
const CONTAINER_BASE_DIR = "/data/ryco";
/** Node B's state dir: its database, logs and project-copy scratch folders. */
export const CONTAINER_STATE_DIR = `${CONTAINER_BASE_DIR}/userdata`;
/**
 * A remote host only node A reaches: node B's fake ssh fails it the way ssh fails
 * for a name it cannot resolve (`FAKE_SSH_UNREACHABLE_HOSTS`, see fake-ssh).
 */
export const LAN_ONLY_HOST = "a-lan.invalid";
/** On node B, a `git clone` from this host hangs until it is killed (see fake-ssh). */
export const STALLING_HOST = "stall.test";

const NODE_BOOT_TIMEOUT_MS = 180_000;
const NODE_STOP_GRACE_MS = 10_000;
const OUTPUT_TAIL_CHARS = 64 * 1024;

/** Run every `git@fixture.test:` remote through the fake ssh. */
export const fakeSshEnv = (shimPath: string = FAKE_SSH_PATH) => ({
  GIT_SSH_COMMAND: shimPath,
  GIT_SSH_VARIANT: "simple",
});

/**
 * The environment a node (or a fixture git command) runs with: this process's,
 * minus whatever would point it at another Ryco home, a test runner, or a git
 * repository the caller happens to be inside.
 */
export const isolatedEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/^(?:RYCO_|VITE_|VITEST|ELECTRON_|GIT_|TURBO_)/u.test(key)) continue;
    if (key === "NODE_ENV" || key === "NODE_OPTIONS" || key === "PORT" || key === "HOST") continue;
    env[key] = value;
  }
  return { ...env, ...extra };
};

// ── Processes ─────────────────────────────────────────────────────────

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

const tail = (text: string, chars = 4_000) =>
  text.length <= chars ? text : `…${text.slice(text.length - chars)}`;

/** Run a command to completion; fails with its exit status and output tail. */
export const runCommand = (
  command: string,
  args: ReadonlyArray<string>,
  options: {
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly timeoutMs?: number;
  } = {},
): Promise<CommandResult> =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      {
        cwd: options.cwd,
        env: options.env ?? isolatedEnv(),
        timeout: options.timeoutMs ?? 120_000,
        maxBuffer: 64 * 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `${command} ${args.join(" ")} failed (${error.code ?? error.signal ?? "error"}):\n${tail(`${stderr}\n${stdout}`)}`,
              { cause: error },
            ),
          );
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });

/** A port that was free a moment ago on 127.0.0.1. */
export const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : null;
      server.close(() =>
        port === null ? reject(new Error("No port was assigned.")) : resolve(port),
      );
    });
  });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll `probe` until it returns a value. `exited` reports why waiting is
 * pointless (the process or container is gone), with its output.
 */
const waitFor = async <A>(input: {
  readonly what: string;
  readonly timeoutMs: number;
  readonly probe: () => Promise<A | null>;
  readonly exited: () => Promise<string | null>;
}): Promise<A> => {
  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    const value = await input.probe().catch(() => null);
    if (value !== null) return value;
    const exited = await input.exited();
    if (exited !== null) throw new Error(`Gave up waiting for ${input.what}: ${exited}`);
    await sleep(500);
  }
  throw new Error(`Timed out after ${input.timeoutMs} ms waiting for ${input.what}.`);
};

/** The node's public descriptor answers once its HTTP listener serves. */
const environmentDescriptorReady = async (httpBaseUrl: string): Promise<true | null> => {
  const response = await fetch(`${httpBaseUrl}/.well-known/ryco/environment`, {
    signal: AbortSignal.timeout(5_000),
  });
  await response.body?.cancel();
  return response.ok ? true : null;
};

/** The newest owner token a headless `serve` printed (`Token: <credential> …`). */
export const latestStartupToken = (output: string): string | null =>
  [...output.matchAll(/^Token: (\S+)/gmu)].at(-1)?.[1] ?? null;

// ── Node B: the container ─────────────────────────────────────────────

export interface ContainerNode {
  readonly name: string;
  readonly port: number;
  readonly httpBaseUrl: string;
  readonly pairingUrl: string;
  /** `docker exec <name> <args…>`. */
  readonly exec: (args: ReadonlyArray<string>) => Promise<CommandResult>;
  readonly logs: () => Promise<string>;
  /**
   * Copies the node's log directory (server.trace.ndjson and friends) to `hostDirectory`, with
   * the container's output as `container.log` beside them.
   */
  readonly copyLogs: (hostDirectory: string) => Promise<void>;
  /**
   * Kills the server process alone (SIGKILL), as a crash does: the children it spawned (git,
   * setup) keep running. The container's supervisor starts the server again a second later.
   */
  readonly crashServer: () => Promise<void>;
  /** Resolves once the server serves again (after `crashServer`). */
  readonly waitUntilServing: () => Promise<void>;
  readonly stop: () => Promise<void>;
}

/** `docker build` of node.Dockerfile from this checkout (about 2 minutes with a warm cache). */
export const buildNodeImage = async (tag: string = DEFAULT_NODE_IMAGE): Promise<void> => {
  await runCommand(
    "docker",
    ["build", "--file", path.join(HARNESS_DIR, "node.Dockerfile"), "--tag", tag, REPO_ROOT],
    { cwd: REPO_ROOT, env: isolatedEnv(), timeoutMs: 20 * 60_000 },
  );
};

const containerLogs = async (name: string): Promise<string> => {
  const { stdout, stderr } = await runCommand("docker", ["logs", name]);
  return `${stdout}\n${stderr}`;
};

const containerExitReason = async (name: string): Promise<string | null> => {
  const { stdout } = await runCommand("docker", [
    "inspect",
    "--format",
    "{{.State.Running}}",
    name,
  ]).catch(() => ({ stdout: "false" }));
  if (stdout.trim() === "true") return null;
  const logs = await containerLogs(name).catch(() => "");
  return `container ${name} is not running.\n${tail(logs)}`;
};

/** How node B's server shows up in `ps` (and `pkill -f`); its supervisor's line does not start so. */
const CONTAINER_SERVER_PROCESS = "^node /app/apps/server/src/bin.ts serve";

/**
 * Start node B: listening on the same port inside the container and on the
 * host's loopback, with `sharedDirectory` bind-mounted at its own path.
 *
 * The server runs under a shell loop that starts it again whenever it exits,
 * and the loop under `--init`, which reaps the orphans a crash leaves. So a
 * test can crash the server alone and watch the next one recover.
 */
export const startContainerNode = async (input: {
  readonly image: string;
  readonly sharedDirectory: string;
}): Promise<ContainerNode> => {
  const port = await freePort();
  const name = `ryco-xnode-b-${randomUUID().slice(0, 8)}`;
  const httpBaseUrl = `http://127.0.0.1:${port}`;
  await runCommand("docker", [
    "run",
    "--detach",
    "--name",
    name,
    "--label",
    CONTAINER_LABEL,
    "--hostname",
    CONTAINER_HOSTNAME,
    "--publish",
    `127.0.0.1:${port}:${port}`,
    "--volume",
    `${input.sharedDirectory}:${input.sharedDirectory}`,
    "--env",
    `FAKE_SSH_UNREACHABLE_HOSTS=${LAN_ONLY_HOST}`,
    "--init",
    input.image,
    "sh",
    "-c",
    [
      "while :; do",
      `node /app/apps/server/src/bin.ts serve --host 0.0.0.0 --port ${port} --base-dir ${CONTAINER_BASE_DIR} --no-browser;`,
      'echo "[harness] node B exited ($?); starting it again" >&2;',
      "sleep 1;",
      "done",
    ].join(" "),
  ]);
  const stop = async () => {
    await runCommand("docker", ["rm", "--force", "--volumes", name]).catch(() => undefined);
  };
  const exited = () => containerExitReason(name);
  const waitUntilServing = async () => {
    await waitFor({
      what: `node B (${name}) to serve on ${httpBaseUrl}`,
      timeoutMs: NODE_BOOT_TIMEOUT_MS,
      probe: () => environmentDescriptorReady(httpBaseUrl),
      exited,
    });
  };
  try {
    await waitUntilServing();
    const token = await waitFor({
      what: `node B (${name}) to print its owner token`,
      timeoutMs: 30_000,
      probe: async () => latestStartupToken(await containerLogs(name)),
      exited,
    });
    return {
      name,
      port,
      httpBaseUrl,
      // The printed link names the container's own address; the host reaches it on loopback.
      pairingUrl: buildDirectPairingUrl(httpBaseUrl, token),
      exec: (args) => runCommand("docker", ["exec", name, ...args]),
      logs: () => containerLogs(name),
      copyLogs: async (hostDirectory) => {
        await runCommand("docker", ["cp", `${name}:${CONTAINER_STATE_DIR}/logs`, hostDirectory]);
        await writeFile(path.join(hostDirectory, "container.log"), await containerLogs(name));
      },
      crashServer: async () => {
        const exec = (args: ReadonlyArray<string>) => runCommand("docker", ["exec", name, ...args]);
        const pid = (
          await exec(["pgrep", "--full", "--oldest", CONTAINER_SERVER_PROCESS])
        ).stdout.trim();
        await exec(["kill", "-KILL", pid]);
        // Gone before it returns, so a following waitUntilServing sees the next server.
        await waitFor({
          what: `node B's server (pid ${pid}) to exit`,
          timeoutMs: 10_000,
          probe: () =>
            exec(["kill", "-0", pid]).then(
              () => null,
              () => true as const,
            ),
          exited,
        });
      },
      waitUntilServing,
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
};

// ── Node A: from source on this machine ───────────────────────────────

export interface SourceNode {
  readonly port: number;
  readonly httpBaseUrl: string;
  readonly pairingUrl: string;
  readonly baseDir: string;
  /** The tail of its stdout and stderr. */
  readonly output: () => string;
  readonly stop: () => Promise<void>;
}

/**
 * Start node A: `node apps/server/src/bin.ts serve` on loopback with its own
 * base dir, in its own process group so stopping it also stops its git and
 * provider children.
 */
export const startSourceNode = async (input: {
  readonly baseDir: string;
  readonly env: NodeJS.ProcessEnv;
}): Promise<SourceNode> => {
  const port = await freePort();
  const httpBaseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(
    "node",
    [
      path.join(REPO_ROOT, "apps/server/src/bin.ts"),
      "serve",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--base-dir",
      input.baseDir,
      "--no-browser",
    ],
    { cwd: REPO_ROOT, env: input.env, stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  let output = "";
  const append = (chunk: Buffer) => {
    output = (output + chunk.toString("utf8")).slice(-OUTPUT_TAIL_CHARS);
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  let exitReason: string | null = null;
  const exited = new Promise<void>((resolve) => {
    child.once("exit", (code, signal) => {
      exitReason = `node A exited (${code ?? signal}).\n${tail(output)}`;
      resolve();
    });
    child.once("error", (error) => {
      exitReason = `node A could not start: ${error.message}`;
      resolve();
    });
  });
  const signalGroup = (signal: NodeJS.Signals) => {
    if (child.pid === undefined || exitReason !== null) return;
    try {
      process.kill(-child.pid, signal);
    } catch {
      // Already gone.
    }
  };
  const stop = async () => {
    signalGroup("SIGTERM");
    const stopped = await Promise.race([
      exited.then(() => true),
      sleep(NODE_STOP_GRACE_MS).then(() => false),
    ]);
    if (!stopped) {
      signalGroup("SIGKILL");
      await exited;
    }
  };
  try {
    await waitFor({
      what: `node A to serve on ${httpBaseUrl}`,
      timeoutMs: NODE_BOOT_TIMEOUT_MS,
      probe: () => environmentDescriptorReady(httpBaseUrl),
      exited: async () => exitReason,
    });
    const token = await waitFor({
      what: "node A to print its owner token",
      timeoutMs: 30_000,
      probe: async () => latestStartupToken(output),
      exited: async () => exitReason,
    });
    return {
      port,
      httpBaseUrl,
      pairingUrl: buildDirectPairingUrl(httpBaseUrl, token),
      baseDir: input.baseDir,
      output: () => output,
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
};

// ── Pairing ───────────────────────────────────────────────────────────

export interface PairedNode {
  readonly remote: CliRemote;
  readonly client: CliRemoteRpcClient;
}

/**
 * Pair with a node's startup owner token, as `ryco remote add` does, and open
 * an RPC client that lives until `scope` closes.
 */
export const pairOwner = async (input: {
  readonly name: string;
  readonly pairingUrl: string;
  readonly scope: Scope.Scope;
}): Promise<PairedNode> => {
  const remote = await pairCliRemote({ name: input.name, pairingUrl: input.pairingUrl });
  if (remote.role !== "owner") {
    throw new Error(`Pairing ${input.name} granted role "${remote.role}", expected "owner".`);
  }
  const client = await Effect.runPromise(connectCliRemote(remote).pipe(Scope.provide(input.scope)));
  return { remote, client };
};

// ── Fixture ───────────────────────────────────────────────────────────

export interface FixtureFile {
  /** Relative to the workspace. */
  readonly path: string;
  readonly sha256: string;
  readonly byteLength: number;
}

export interface CrossNodeFixture {
  /** Bind-mounted into node B at the same path. */
  readonly root: string;
  readonly originPath: string;
  /** `git@fixture.test:<originPath>`: reaches the origin through the fake ssh on both nodes. */
  readonly originUrl: string;
  /** A second remote the copy must recreate. */
  readonly upstreamUrl: string;
  /** Node A's checkout. */
  readonly workspace: string;
  readonly mainBranch: string;
  /** `main` as pushed to the origin. */
  readonly mainOid: string;
  /** Checked out on node A, never pushed. */
  readonly featureBranch: string;
  /** HEAD on node A: one commit on top of `mainOid` the origin does not have. */
  readonly headOid: string;
  /** Node A's project for the workspace. */
  readonly projectId: ProjectId;
  readonly title: string;
  readonly scripts: ReadonlyArray<ProjectScript>;
  readonly customSystemPrompt: string;
  /** The `runOnWorktreeCreate` script's command; see `SETUP_MARKER_PATH`. */
  readonly setupCommand: string;
  /** A tracked file with an unstaged edit. */
  readonly trackedEdit: FixtureFile;
  /** An untracked binary file, larger than one transfer chunk. */
  readonly untrackedBinary: FixtureFile;
  /** An ignored `.env`, copied only when opted in. */
  readonly ignoredEnv: FixtureFile;
}

/**
 * Where the setup script leaves its proof, relative to the repository root:
 * the directory it ran in, and the names of the RYCO_* variables it could see
 * (only the project script ones, RYCO_PROJECT_ROOT and RYCO_WORKTREE_PATH;
 * never the server's). Inside `.git`, so it never shows up in `git status`.
 */
export const SETUP_MARKER_PATH = ".git/ryco-e2e-setup";
const SETUP_COMMAND = `{ pwd; env | grep '^RYCO_' | cut -d= -f1 | sort | tr '\\n' ' '; echo; } > ${SETUP_MARKER_PATH}; exit 0`;

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

/**
 * Deterministic bytes that are not valid UTF-8 and do not compress: NUL, a
 * Latin-1 é, CR/LF, then a sha256 counter stream.
 */
const binaryFixtureBytes = (byteLength: number): Uint8Array => {
  const bytes = new Uint8Array(byteLength);
  bytes.set([0x00, 0xff, 0xe9, 0x0d, 0x0a, 0x00].slice(0, byteLength));
  for (let offset = 6, counter = 0; offset < byteLength; counter += 1) {
    const block = createHash("sha256").update(`ryco-e2e-${counter}`).digest();
    bytes.set(block.subarray(0, Math.min(block.length, byteLength - offset)), offset);
    offset += block.length;
  }
  return bytes;
};

const fixtureFile = (relativePath: string, content: Uint8Array | string): FixtureFile => ({
  path: relativePath,
  sha256: sha256(content),
  byteLength: typeof content === "string" ? Buffer.byteLength(content) : content.byteLength,
});

/** A directory every git process and node B sees under the same absolute path. */
export const makeSharedDirectory = async (prefix: string): Promise<string> =>
  // realpath: on macOS /tmp is a symlink to /private/tmp, which the container cannot follow.
  mkdtemp(path.join(await realpath("/tmp"), prefix));

/** git on this machine for fixture repositories, through the fake ssh; trimmed stdout. */
const fixtureGit = async (cwd: string, ...args: ReadonlyArray<string>) =>
  (await runCommand("git", args, { cwd, env: isolatedEnv(fakeSshEnv()) })).stdout.trim();

/** Local config every fixture repository gets: no signing, a committer identity. */
const configureFixtureRepository = async (repository: string, options = { identity: true }) => {
  // The machine's global config may sign through an agent that is not there.
  await fixtureGit(repository, "config", "commit.gpgsign", "false");
  await fixtureGit(repository, "config", "tag.gpgsign", "false");
  if (!options.identity) return;
  await fixtureGit(repository, "config", "user.name", "Cross Node E2E");
  await fixtureGit(repository, "config", "user.email", "cross-node-e2e@example.test");
};

/** Writes a file below `root` (creating its folders) and describes it. */
const writeFixtureFile = async (
  root: string,
  relativePath: string,
  content: Uint8Array | string,
): Promise<FixtureFile> => {
  const absolute = path.join(root, relativePath);
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
  return fixtureFile(relativePath, content);
};

/** `project.create`, then `project.meta.update` with the scripts and prompt, over node A's RPC. */
export const registerProjectOnA = async (input: {
  readonly nodeA: CliRemoteRpcClient;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly scripts: ReadonlyArray<ProjectScript>;
  readonly customSystemPrompt: string | null;
}) => {
  await Effect.runPromise(
    input.nodeA[ORCHESTRATION_WS_METHODS.dispatchCommand]({
      type: "project.create",
      commandId: CommandId.make(`e2e:${randomUUID()}`),
      projectId: input.projectId,
      title: input.title,
      workspaceRoot: input.workspaceRoot,
      createdAt: new Date().toISOString(),
    }),
  );
  await Effect.runPromise(
    input.nodeA[ORCHESTRATION_WS_METHODS.dispatchCommand]({
      type: "project.meta.update",
      commandId: CommandId.make(`e2e:${randomUUID()}`),
      projectId: input.projectId,
      scripts: [...input.scripts],
      customSystemPrompt: input.customSystemPrompt,
    }),
  );
};

/**
 * Build the source repository under `root` and register it on node A over RPC:
 * a bare origin with `main` pushed, the workspace on an unpushed feature
 * branch with a tracked edit, an untracked binary and an ignored `.env`, plus
 * scripts and a system prompt on the project.
 */
export const buildFixture = async (input: {
  readonly root: string;
  readonly nodeA: CliRemoteRpcClient;
}): Promise<CrossNodeFixture> => {
  const git = fixtureGit;
  const mainBranch = "main";
  const featureBranch = "feature/cross-node";
  const originPath = path.join(input.root, "origin.git");
  const upstreamPath = path.join(input.root, "upstream.git");
  const workspace = path.join(input.root, "workspace");
  for (const bare of [originPath, upstreamPath]) {
    await git(input.root, "init", "--quiet", "--bare", `--initial-branch=${mainBranch}`, bare);
    await configureFixtureRepository(bare, { identity: false });
  }
  await git(input.root, "init", "--quiet", `--initial-branch=${mainBranch}`, workspace);
  await configureFixtureRepository(workspace);

  const write = (relativePath: string, content: Uint8Array | string) =>
    writeFixtureFile(workspace, relativePath, content);
  await write("README.md", "# Cross-node fixture\n\nCopied between two Ryco nodes.\n");
  await write(".gitignore", ".env\nnode_modules/\n");
  await write("src/app.txt", "base\n");
  await git(workspace, "add", "--all");
  await git(workspace, "commit", "--quiet", "--message", "Initial commit");
  const originUrl = `git@fixture.test:${originPath}`;
  const upstreamUrl = `git@fixture.test:${upstreamPath}`;
  await git(workspace, "remote", "add", "origin", originUrl);
  await git(workspace, "remote", "add", "upstream", upstreamUrl);
  await git(workspace, "push", "--quiet", "--set-upstream", "origin", mainBranch);
  // A fork's upstream holds the shared history too (it is the repository the fork came from).
  await git(workspace, "push", "--quiet", "upstream", mainBranch);
  const mainOid = await git(workspace, "rev-parse", "HEAD");

  await git(workspace, "switch", "--quiet", "--create", featureBranch);
  await write("src/feature.txt", "only on node A\n");
  await git(workspace, "add", "--all");
  await git(workspace, "commit", "--quiet", "--message", "Unpushed feature work");
  const headOid = await git(workspace, "rev-parse", "HEAD");

  const trackedEdit = await write(
    "README.md",
    "# Cross-node fixture\n\nCopied between two Ryco nodes.\n\nAn uncommitted edit.\n",
  );
  // 200 KiB of incompressible bytes: its binary patch spans two transfer chunks.
  const untrackedBinary = await write("assets/blob.bin", binaryFixtureBytes(200 * 1024));
  const ignoredEnv = await write(".env", "API_TOKEN=cross-node-e2e\n");

  const projectId = ProjectId.make(`e2e-source-${randomUUID()}`);
  const title = "Cross-node fixture";
  const scripts: ReadonlyArray<ProjectScript> = [
    {
      id: "setup",
      name: "Setup",
      command: SETUP_COMMAND,
      icon: "configure",
      runOnWorktreeCreate: true,
    },
    { id: "test", name: "Test", command: "echo test", icon: "test", runOnWorktreeCreate: false },
  ];
  const customSystemPrompt = "Cross-node E2E: keep answers short.";
  await registerProjectOnA({
    nodeA: input.nodeA,
    projectId,
    title,
    workspaceRoot: workspace,
    scripts,
    customSystemPrompt,
  });

  return {
    root: input.root,
    originPath,
    originUrl,
    upstreamUrl,
    workspace,
    mainBranch,
    mainOid,
    featureBranch,
    headOid,
    projectId,
    title,
    scripts,
    customSystemPrompt,
    setupCommand: SETUP_COMMAND,
    trackedEdit,
    untrackedBinary,
    ignoredEnv,
  };
};

export interface LanOnlyFixture {
  /** Node A's checkout. */
  readonly workspace: string;
  /** `git@a-lan.invalid:<originPath>`: node A reaches it, node B cannot resolve the host. */
  readonly originUrl: string;
  readonly branch: string;
  /** HEAD on node A, one commit on top of the origin's `main`. */
  readonly headOid: string;
  readonly mainOid: string;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly trackedEdit: FixtureFile;
  readonly untrackedFile: FixtureFile;
}

/**
 * A second project on node A whose only remote is the fixture's origin under a
 * host node B cannot resolve (`LAN_ONLY_HOST`), as for a server on node A's
 * home network: an unpushed branch, a tracked edit and an untracked file.
 */
export const buildLanOnlyFixture = async (input: {
  readonly fixture: CrossNodeFixture;
  readonly nodeA: CliRemoteRpcClient;
}): Promise<LanOnlyFixture> => {
  const git = fixtureGit;
  const { fixture } = input;
  const workspace = path.join(fixture.root, `lan-workspace-${randomUUID().slice(0, 8)}`);
  const originUrl = `git@${LAN_ONLY_HOST}:${fixture.originPath}`;
  await git(
    fixture.root,
    "clone",
    "--quiet",
    "--branch",
    fixture.mainBranch,
    "--",
    originUrl,
    workspace,
  );
  await configureFixtureRepository(workspace);
  const mainOid = await git(workspace, "rev-parse", "HEAD");
  const branch = "feature/lan-only";
  await git(workspace, "switch", "--quiet", "--create", branch);
  await writeFixtureFile(workspace, "src/lan.txt", "made where only node A can push\n");
  await git(workspace, "add", "--all");
  await git(workspace, "commit", "--quiet", "--message", "Work on the LAN-only remote");
  const headOid = await git(workspace, "rev-parse", "HEAD");
  const trackedEdit = await writeFixtureFile(workspace, "src/app.txt", "base\nedited on node A\n");
  const untrackedFile = await writeFixtureFile(workspace, "notes/todo.txt", "send the files\n");

  const projectId = ProjectId.make(`e2e-lan-${randomUUID()}`);
  const title = "LAN-only fixture";
  await registerProjectOnA({
    nodeA: input.nodeA,
    projectId,
    title,
    workspaceRoot: workspace,
    scripts: [],
    customSystemPrompt: null,
  });
  return {
    workspace,
    originUrl,
    branch,
    headOid,
    mainOid,
    projectId,
    title,
    trackedEdit,
    untrackedFile,
  };
};

// ── The whole harness ─────────────────────────────────────────────────

export interface CrossNodeHarness {
  readonly nodeA: SourceNode & PairedNode;
  readonly nodeB: ContainerNode &
    PairedNode & {
      /**
       * Opens a new RPC client with the same pairing once the server serves again (after
       * `crashServer`); `client` is that one from then on.
       */
      readonly reconnect: () => Promise<void>;
    };
  readonly fixture: CrossNodeFixture;
  /** Stops both nodes and removes the temporary directories (unless kept). */
  readonly teardown: () => Promise<void>;
}

export interface CrossNodeHarnessOptions {
  /** Node B's image; built from this checkout first unless `buildImage` is false. */
  readonly image?: string;
  readonly buildImage?: boolean;
  /** Keep the fixture and node A's base dir for inspection. */
  readonly keepFiles?: boolean;
  readonly log?: (line: string) => void;
}

/**
 * Build node B's image, start both nodes, pair them as owner and build the
 * fixture. Anything started before a failure is torn down before it rethrows.
 */
export const startCrossNodeHarness = async (
  options: CrossNodeHarnessOptions = {},
): Promise<CrossNodeHarness> => {
  const log = options.log ?? (() => undefined);
  const cleanups: Array<() => Promise<void>> = [];
  const teardown = async () => {
    for (const cleanup of cleanups.splice(0).toReversed()) {
      await cleanup().catch((error: unknown) => log(`teardown step failed: ${String(error)}`));
    }
  };
  try {
    const image = options.image ?? DEFAULT_NODE_IMAGE;
    if (options.buildImage !== false) {
      log(`building ${image}`);
      await buildNodeImage(image);
    }

    const root = await makeSharedDirectory("ryco-xnode-e2e-");
    const nodeABaseDir = await mkdtemp(path.join(tmpdir(), "ryco-xnode-node-a-"));
    cleanups.push(async () => {
      if (options.keepFiles) {
        log(`kept fixture ${root} and node A base dir ${nodeABaseDir}`);
        return;
      }
      await rm(root, { recursive: true, force: true });
      await rm(nodeABaseDir, { recursive: true, force: true });
    });

    log("starting node B");
    const containerNode = await startContainerNode({ image, sharedDirectory: root });
    cleanups.push(async () => {
      if (options.keepFiles) {
        const logsDirectory = path.join(root, "node-b-logs");
        await containerNode
          .copyLogs(logsDirectory)
          .then(() => log(`kept node B's logs in ${logsDirectory}`))
          .catch((error: unknown) => log(`node B's logs could not be copied: ${String(error)}`));
      }
      await containerNode.stop();
    });
    log(`starting node A (base dir ${nodeABaseDir})`);
    const sourceNode = await startSourceNode({
      baseDir: nodeABaseDir,
      env: isolatedEnv({
        ...fakeSshEnv(),
        RYCO_TELEMETRY_ENABLED: "false",
        RYCO_HUB_CONNECTOR_ENABLED: "false",
      }),
    });
    cleanups.push(sourceNode.stop);

    // Cleanups run in reverse: the RPC sockets close before the nodes stop.
    const scope = await Effect.runPromise(Scope.make());
    cleanups.push(() => Effect.runPromise(Scope.close(scope, Exit.void)));
    const pairedA = await pairOwner({ name: "node-a", pairingUrl: sourceNode.pairingUrl, scope });
    const pairedB = await pairOwner({
      name: "node-b",
      pairingUrl: containerNode.pairingUrl,
      scope,
    });
    log("building fixture");
    const fixture = await buildFixture({ root, nodeA: pairedA.client });
    let clientB = pairedB.client;
    const nodeB: CrossNodeHarness["nodeB"] = {
      ...containerNode,
      remote: pairedB.remote,
      get client() {
        return clientB;
      },
      reconnect: async () => {
        await containerNode.waitUntilServing();
        clientB = await Effect.runPromise(
          connectCliRemote(pairedB.remote).pipe(Scope.provide(scope)),
        );
      },
    };
    return { nodeA: { ...sourceNode, ...pairedA }, nodeB, fixture, teardown };
  } catch (error) {
    await teardown();
    throw error;
  }
};
