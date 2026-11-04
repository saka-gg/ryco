import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Layer } from "effect";

import type { SourceControlProviderShape } from "../../sourceControl/SourceControlProvider.ts";
import { SourceControlProviderRegistry } from "../../sourceControl/SourceControlProviderRegistry.ts";
import type { GitNetworkError } from "../Errors.ts";
import {
  commitFiles,
  git,
  initRepository,
  isProcessAlive,
  tempRoots,
  waitFor,
  withProcessEnv,
  writeFakeSsh,
} from "../projectCopyGit.fixtures.ts";
import { GitNetwork } from "../Services/GitNetwork.ts";
import { gitFailureSummary } from "../../sourceControl/gitCloneCommon.ts";
import { BATCH_SSH_COMMAND, GitNetworkLive } from "./GitNetworkLive.ts";

const roots = tempRoots();
afterEach(() => roots.cleanup());

const TestLayer = GitNetworkLive.pipe(
  Layer.provide(
    Layer.mock(SourceControlProviderRegistry)({
      detectProviderFromRemoteUrl: () => null,
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

/** An origin with one commit on main and a tag, served at `git@fakehost:o/r.git`. */
function servedOrigin() {
  const root = roots.make("ryco-git-network-");
  const work = initRepository(path.join(root, "work"));
  const head = commitFiles(work, { "README.md": "hello\n" }, "first");
  git(work, "tag", "v1");
  git(root, "clone", "--quiet", "--bare", "--", work, path.join(root, "o", "r.git"));
  const fakeSsh = writeFakeSsh(root);
  const emptyGlobalConfig = path.join(root, "empty.gitconfig");
  writeFileSync(emptyGlobalConfig, "");
  return { root, head, fakeSsh, emptyGlobalConfig, url: "git@fakehost:o/r.git" };
}

/** Only the fake ssh, no user ssh configuration: the batch-mode `core.sshCommand` applies. */
const fakeSshOnPath = (fixture: ReturnType<typeof servedOrigin>, extra?: Record<string, string>) =>
  withProcessEnv({
    PATH: `${fixture.fakeSsh.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    GIT_SSH: undefined,
    GIT_SSH_COMMAND: undefined,
    GIT_CONFIG_GLOBAL: fixture.emptyGlobalConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    FAKE_SSH_ROOT: fixture.root,
    FAKE_SSH_MODE: undefined,
    ...extra,
  });

describe("GitNetworkLive", () => {
  it.live("lists heads and tags of the node's own file:// remote", () =>
    Effect.gen(function* () {
      const fixture = servedOrigin();
      const network = yield* GitNetwork;
      const refs = yield* network.lsRemote({
        remoteUrl: `file://${fixture.root}/o/r.git`,
        allowLocalRemote: true,
        heads: true,
        tags: true,
      });
      assert.deepStrictEqual(refs.map((ref) => ref.ref).toSorted(), [
        "refs/heads/main",
        "refs/tags/v1",
      ]);
      assert.isTrue(refs.every((ref) => ref.oid === fixture.head));
    }).pipe(Effect.provide(TestLayer)),
  );

  it.live("refuses local, plain-http and password URLs from elsewhere", () =>
    Effect.gen(function* () {
      const fixture = servedOrigin();
      const network = yield* GitNetwork;
      const reasonOf = (remoteUrl: string) =>
        network.lsRemote({ remoteUrl, heads: true, tags: false }).pipe(
          Effect.flip,
          Effect.map((error: GitNetworkError) => error.reason),
        );
      assert.strictEqual(yield* reasonOf(`file://${fixture.root}/o/r.git`), "invalid-url");
      assert.strictEqual(yield* reasonOf(`${fixture.root}/o/r.git`), "invalid-url");
      assert.strictEqual(yield* reasonOf("--upload-pack=touch /tmp/x"), "invalid-url");
      assert.strictEqual(yield* reasonOf("http://example.invalid/o/r.git"), "insecure-transport");
      assert.strictEqual(
        yield* reasonOf("https://user:token@example.invalid/o/r.git"),
        "invalid-url",
      );
      // curl skips the third slash and would send the token.
      assert.strictEqual(
        yield* reasonOf("https:///user:token@example.invalid/o/r.git"),
        "invalid-url",
      );
      // WHATWG URL reads https here, git an ssh host named `https`: neither clones it.
      assert.strictEqual(yield* reasonOf("https:\\\\example.invalid/o/r.git"), "invalid-url");
      assert.strictEqual(yield* reasonOf("ssh:example.invalid/o/r.git"), "invalid-url");
      assert.strictEqual(network.classifyRemoteUrl("http://example.invalid/o/r.git"), "http");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.live("adds batch-mode ssh only while the user configured no ssh command", () =>
    Effect.gen(function* () {
      const fixture = servedOrigin();
      const network = yield* GitNetwork;
      const log = path.join(fixture.root, "ssh.log");

      const refs = yield* network
        .lsRemote({ remoteUrl: fixture.url, heads: true, tags: false })
        .pipe(fakeSshOnPath(fixture, { FAKE_SSH_LOG: log }));
      assert.deepStrictEqual(refs, [{ oid: fixture.head, ref: "refs/heads/main" }]);
      const invocation = readFileSync(log, "utf8");
      assert.include(invocation, "BatchMode=yes");
      assert.include(invocation, "ConnectTimeout=15");
      assert.notInclude(invocation, "StrictHostKeyChecking");
      assert.strictEqual(BATCH_SSH_COMMAND, "ssh -o BatchMode=yes -o ConnectTimeout=15");

      // A user `core.sshCommand` (e.g. an identity file or a 1Password agent) stays in charge.
      writeFileSync(log, "");
      writeFileSync(
        fixture.emptyGlobalConfig,
        `[core]\n\tsshCommand = ${fixture.fakeSsh.path} -o UserChoice=yes\n`,
      );
      yield* network
        .lsRemote({ remoteUrl: fixture.url, heads: true, tags: false })
        .pipe(fakeSshOnPath(fixture, { FAKE_SSH_LOG: log }));
      const configured = readFileSync(log, "utf8");
      assert.include(configured, "UserChoice=yes");
      assert.notInclude(configured, "BatchMode=yes");

      // So does GIT_SSH_COMMAND.
      writeFileSync(log, "");
      writeFileSync(fixture.emptyGlobalConfig, "");
      yield* network.lsRemote({ remoteUrl: fixture.url, heads: true, tags: false }).pipe(
        fakeSshOnPath(fixture, {
          FAKE_SSH_LOG: log,
          GIT_SSH_COMMAND: `${fixture.fakeSsh.path} -o FromEnv=yes`,
        }),
      );
      const fromEnv = readFileSync(log, "utf8");
      assert.include(fromEnv, "FromEnv=yes");
      assert.notInclude(fromEnv, "BatchMode=yes");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.live("maps an unknown ssh host key to host-key-unknown <host>", () =>
    Effect.gen(function* () {
      const fixture = servedOrigin();
      const network = yield* GitNetwork;
      const error = yield* network
        .lsRemote({ remoteUrl: fixture.url, heads: true, tags: false })
        .pipe(Effect.flip, fakeSshOnPath(fixture, { FAKE_SSH_MODE: "host-key" }));
      assert.strictEqual(error.reason, "host-key-unknown");
      assert.strictEqual(error.host, "fakehost");

      const access = yield* network
        .checkRemoteAccess({ remoteUrl: fixture.url })
        .pipe(fakeSshOnPath(fixture, { FAKE_SSH_MODE: "host-key" }));
      assert.strictEqual(access.reachable, false);
      assert.strictEqual(access.detail, "host-key-unknown fakehost");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.live("maps refused credentials to unreachable with ssh's reason", () =>
    Effect.gen(function* () {
      const fixture = servedOrigin();
      const network = yield* GitNetwork;
      const error = yield* network
        .lsRemote({ remoteUrl: fixture.url, heads: true, tags: false })
        .pipe(Effect.flip, fakeSshOnPath(fixture, { FAKE_SSH_MODE: "denied" }));
      assert.strictEqual(error.reason, "unreachable");
      assert.strictEqual(
        gitFailureSummary(error.detail),
        "git@fakehost: Permission denied (publickey).",
      );
      const access = yield* network
        .checkRemoteAccess({ remoteUrl: fixture.url })
        .pipe(fakeSshOnPath(fixture, { FAKE_SSH_MODE: "denied" }));
      assert.deepStrictEqual(access, {
        reachable: false,
        alternateRemoteUrl: null,
        detail: "git@fakehost: Permission denied (publickey).",
      });
    }).pipe(Effect.provide(TestLayer)),
  );

  it.live("redacts credentials git prints", () =>
    Effect.gen(function* () {
      const fixture = servedOrigin();
      const network = yield* GitNetwork;
      const error = yield* network
        .lsRemote({ remoteUrl: fixture.url, heads: true, tags: false })
        .pipe(Effect.flip, fakeSshOnPath(fixture, { FAKE_SSH_MODE: "leak" }));
      assert.notInclude(error.detail, "ghp_secret");
      assert.notInclude(error.detail, "x-token");
      assert.include(error.detail, "https://***@fakehost/o/r.git/");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.live("answers through the alternate form when the given one fails", () =>
    Effect.gen(function* () {
      const fixture = servedOrigin();
      const network = yield* GitNetwork;
      // Nothing serves https on localhost; `git@localhost:o/r.git` reaches the fake ssh.
      const access = yield* network
        .checkRemoteAccess({ remoteUrl: "https://localhost/o/r.git" })
        .pipe(fakeSshOnPath(fixture));
      assert.deepStrictEqual(access, {
        reachable: true,
        alternateRemoteUrl: "git@localhost:o/r.git",
        detail: null,
      });
      const refused = yield* network.checkRemoteAccess({
        remoteUrl: "http://localhost/o/r.git",
      });
      assert.strictEqual(refused.reachable, false);
      assert.include(refused.detail ?? "", "http://");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.live("hands provider credentials to https and drops the URL's user info", () => {
    const requested: Array<string> = [];
    const provider = {
      kind: "bitbucket",
      cloneAuthentication: (input: { readonly remoteUrl: string }) =>
        Effect.sync(() => {
          requested.push(input.remoteUrl);
          return { kind: "http-basic" as const, username: "x-token-auth", password: "secret" };
        }),
    } as unknown as SourceControlProviderShape;
    const CredentialLayer = GitNetworkLive.pipe(
      Layer.provide(
        Layer.mock(SourceControlProviderRegistry)({
          get: () => Effect.succeed(provider),
          detectProviderFromRemoteUrl: () => ({
            kind: "bitbucket",
            name: "Bitbucket",
            baseUrl: "https://localhost",
          }),
        }),
      ),
      Layer.provideMerge(NodeServices.layer),
    );
    return Effect.gen(function* () {
      const network = yield* GitNetwork;
      // Nothing serves https on localhost: the failure names the URL git was given.
      const error = yield* network
        .lsRemote({ remoteUrl: "https://octocat@localhost/o/r.git", heads: true, tags: false })
        .pipe(Effect.flip);
      assert.strictEqual(error.reason, "unreachable");
      assert.include(error.detail, "'https://localhost/o/r.git/'");
      assert.deepStrictEqual(requested, ["https://octocat@localhost/o/r.git"]);
    }).pipe(Effect.provide(CredentialLayer));
  });

  it.live("fails stalled and kills git and ssh when nothing arrives", () =>
    Effect.gen(function* () {
      const fixture = servedOrigin();
      const network = yield* GitNetwork;
      const pidFile = path.join(fixture.root, "ssh.pid");
      const children: Array<number | null> = [];
      const error = yield* network
        .runGitNetworkCommand({
          operation: "test.stall",
          cwd: fixture.root,
          args: ["ls-remote", "--", fixture.url],
          remoteUrl: fixture.url,
          timeoutMs: 60_000,
          stallTimeoutMs: 1_000,
          observer: {
            onChild: (child) => Effect.sync(() => children.push(child?.pid ?? null)),
          },
        })
        .pipe(
          Effect.flip,
          fakeSshOnPath(fixture, { FAKE_SSH_MODE: "hang", FAKE_SSH_PID_FILE: pidFile }),
        );
      assert.strictEqual(error.reason, "stalled");
      const gitPid = children[0];
      assert.isNumber(gitPid);
      assert.isNull(children.at(-1));
      const sshPid = Number(readFileSync(pidFile, "utf8").trim());
      yield* waitFor(() => !isProcessAlive(sshPid), "the fake ssh to exit");
      assert.isFalse(isProcessAlive(gitPid ?? -1));
    }).pipe(Effect.provide(TestLayer)),
  );

  it.live("cancels by interruption, waiting for the child to exit", () =>
    Effect.gen(function* () {
      const fixture = servedOrigin();
      const network = yield* GitNetwork;
      const pidFile = path.join(fixture.root, "ssh.pid");
      let gitPid: number | null = null;
      const fiber = yield* network
        .runGitNetworkCommand({
          operation: "test.cancel",
          cwd: fixture.root,
          args: ["ls-remote", "--", fixture.url],
          remoteUrl: fixture.url,
          timeoutMs: 60_000,
          observer: {
            onChild: (child) =>
              Effect.sync(() => {
                if (child) gitPid = child.pid;
              }),
          },
        })
        .pipe(
          fakeSshOnPath(fixture, { FAKE_SSH_MODE: "hang", FAKE_SSH_PID_FILE: pidFile }),
          Effect.forkChild,
        );
      yield* waitFor(() => {
        try {
          return readFileSync(pidFile, "utf8").trim().length > 0;
        } catch {
          return false;
        }
      }, "the fake ssh to start");
      yield* Fiber.interrupt(fiber);
      assert.isNotNull(gitPid);
      assert.isFalse(isProcessAlive(gitPid ?? -1));
      const sshPid = Number(readFileSync(pidFile, "utf8").trim());
      yield* waitFor(() => !isProcessAlive(sshPid), "the fake ssh to exit");
    }).pipe(Effect.provide(TestLayer)),
  );
});
