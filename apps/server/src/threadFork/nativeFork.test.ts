import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { ProviderDriverKind, ThreadId, TurnId } from "@ryco/contracts";
import { Cause, Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { readClaudeMainChain } from "../imports/claudeNativeFork.ts";
import {
  claudeForkResumeCursor,
  claudeForkSessionTitle,
  codexForkMismatch,
  codexForkResumeCursor,
  forkClaudeThroughTurn,
  forkCodexThroughTurn,
  nativeForkConfigFingerprint,
  pinClaudeForkCutoff,
  removeClaudeForkCopy,
  resolveNativeForkStore,
} from "./nativeFork.ts";

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "ryco-native-fork-")));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("resume cursors", () => {
  it("match the adapters' cursor shapes, with no Claude rewind", () => {
    expect(codexForkResumeCursor("codex-copy")).toEqual({ threadId: "codex-copy" });
    expect(
      claudeForkResumeCursor({
        forkThreadId: ThreadId.make("fork-1"),
        nativeSessionId: "11111111-1111-4111-8111-111111111111",
        inheritedUserTurnCount: 3,
      }),
    ).toEqual({
      threadId: "fork-1",
      resume: "11111111-1111-4111-8111-111111111111",
      turnCount: 3,
    });
    expect(claudeForkSessionTitle("fork-abc")).toBe("Ryco fork fork-abc");
  });
});

describe("native fork store", () => {
  it("resolves the instance's canonical store and fingerprints its configuration", async () => {
    const home = path.join(root, "codex-home");
    await mkdir(home);
    const config = {
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      config: { homePath: home, binaryPath: "codex" },
    };
    const store = await Effect.runPromise(
      resolveNativeForkStore("codex", config).pipe(Effect.provide(NodeServices.layer)),
    );
    expect(store.root).toBe(home);
    expect(store.codex?.sharedHomePath).toBe(home);
    expect(store.binaryPath).toBe("codex");
    expect(nativeForkConfigFingerprint(config)).toBe(
      nativeForkConfigFingerprint({ config: config.config, enabled: true, driver: config.driver }),
    );
    expect(nativeForkConfigFingerprint(config)).not.toBe(
      nativeForkConfigFingerprint({ ...config, enabled: false }),
    );
    const missing = await Effect.runPromiseExit(
      resolveNativeForkStore("codex", {
        ...config,
        config: { homePath: path.join(root, "missing") },
      }).pipe(Effect.provide(NodeServices.layer)),
    );
    expect(missing._tag).toBe("Failure");
  });
});

describe("codexForkMismatch", () => {
  const fork = {
    id: "copy",
    forkedFromId: "source",
    cwd: "/fork",
    ephemeral: false,
    turns: [
      { id: "t1", status: "completed", items: [] },
      { id: "t2", status: "completed", items: [] },
    ],
  } as never;
  const base = { fork, forkId: "copy", sourceNativeThreadId: "source", cwd: "/fork" };

  it("accepts the exact copy and names every mismatch", () => {
    expect(codexForkMismatch({ ...base, expectedTurnIds: ["t1", "t2"] })).toBeNull();
    expect(codexForkMismatch({ ...base, expectedTurnIds: ["t1"] })).toContain("selected turn");
    expect(codexForkMismatch({ ...base, expectedTurnIds: ["t1", "t3"] })).toContain(
      "selected turn",
    );
    expect(
      codexForkMismatch({ ...base, sourceNativeThreadId: "other", expectedTurnIds: ["t1", "t2"] }),
    ).toContain("origin");
    expect(
      codexForkMismatch({ ...base, cwd: "/elsewhere", expectedTurnIds: ["t1", "t2"] }),
    ).toContain("folder");
    expect(
      codexForkMismatch({
        ...base,
        fork: { ...(fork as object), ephemeral: true } as never,
        expectedTurnIds: ["t1", "t2"],
      }),
    ).toContain("persisted");
  });
});

// A scripted `codex app-server`: answers from scenario.json and logs every request.
async function codexPeer(scenario: unknown) {
  const peer = path.join(root, "peer.cjs");
  const scenarioFile = path.join(root, "scenario.json");
  const requests = path.join(root, "requests.jsonl");
  await writeFile(scenarioFile, JSON.stringify(scenario));
  await writeFile(
    peer,
    `#!/usr/bin/env node
const fs = require('node:fs');
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(requests)}, JSON.stringify(request) + '\\n');
  if (request.id === undefined) return;
  const state = JSON.parse(fs.readFileSync(${JSON.stringify(scenarioFile)}, 'utf8'));
  const reply = (result) => process.stdout.write(JSON.stringify({ id: request.id, result }) + '\\n');
  const fail = (code, message) => process.stdout.write(JSON.stringify({ id: request.id, error: { code, message } }) + '\\n');
  switch (request.method) {
    case 'initialize': return reply({ codexHome: process.env.CODEX_HOME, userAgent: 'peer', platformFamily: 'unix', platformOs: 'linux' });
    case 'thread/read': {
      const thread = state.threads[request.params.threadId];
      return thread ? reply({ thread }) : fail(-32000, 'thread not found');
    }
    case 'thread/fork': {
      if (state.forkExit) process.exit(3);
      if (state.forkError) return fail(state.forkError.code, state.forkError.message);
      return reply({ approvalPolicy: 'never', approvalsReviewer: 'user', cwd: request.params.cwd, model: 'peer', modelProvider: 'peer', sandbox: { type: 'dangerFullAccess' }, thread: state.threads[state.forkId] });
    }
    case 'thread/delete': return state.deleteError ? fail(-32000, 'delete failed') : reply({});
    default: return fail(-32601, 'method not found');
  }
});
`,
    { mode: 0o755 },
  );
  return {
    binaryPath: peer,
    async methods() {
      return (await readFile(requests, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { method: string; params?: Record<string, unknown> });
    },
  };
}

const codexThread = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  sessionId: id,
  cwd: "/source",
  ephemeral: false,
  createdAt: 1,
  updatedAt: 1,
  cliVersion: "peer",
  modelProvider: "peer",
  preview: "",
  source: "cli",
  status: { type: "idle" },
  turns: [],
  ...overrides,
});

const turns = (...entries: ReadonlyArray<readonly [string, string]>) =>
  entries.map(([id, status]) => ({ id, status, items: [] }));

async function runCodexFork(binaryPath: string, turnId: string) {
  const home = path.join(root, "codex-home");
  const cwd = path.join(root, "fork-cwd");
  await mkdir(home, { recursive: true });
  await mkdir(cwd, { recursive: true });
  return Effect.runPromiseExit(
    forkCodexThroughTurn({
      layout: {
        mode: "direct",
        sharedHomePath: home,
        effectiveHomePath: home,
        continuationKey: `codex:home:${home}`,
      },
      environment: { PATH: process.env.PATH },
      binaryPath,
      sourceNativeThreadId: "source",
      turnId: TurnId.make(turnId),
      cwd,
    }).pipe(Effect.provide(NodeServices.layer)),
  );
}

describe("forkCodexThroughTurn", () => {
  const sourceTurns = turns(["t1", "completed"], ["t2", "completed"], ["t3", "inProgress"]);

  it("forks through the selected turn into the fork's folder and verifies the copy", async () => {
    const cwd = path.join(root, "fork-cwd");
    const peer = await codexPeer({
      forkId: "copy",
      threads: {
        source: codexThread("source", { turns: sourceTurns }),
        copy: codexThread("copy", {
          forkedFromId: "source",
          cwd,
          turns: turns(["t1", "completed"], ["t2", "completed"]),
        }),
      },
    });
    const exit = await runCodexFork(peer.binaryPath, "t2");
    expect(exit).toEqual(
      expect.objectContaining({
        _tag: "Success",
        value: {
          kind: "forked",
          nativeThreadId: "copy",
          ownedCopy: { kind: "codex-thread", threadId: "copy" },
        },
      }),
    );
    const calls = await peer.methods();
    expect(calls.find((call) => call.method === "thread/fork")?.params).toEqual({
      threadId: "source",
      lastTurnId: "t2",
      cwd,
      ephemeral: false,
    });
    expect(calls.some((call) => call.method === "thread/delete")).toBe(false);
  });

  it("does not fork a turn that is missing or still running", async () => {
    const peer = await codexPeer({
      forkId: "copy",
      threads: { source: codexThread("source", { turns: sourceTurns }) },
    });
    for (const turnId of ["t3", "unknown"]) {
      const exit = await runCodexFork(peer.binaryPath, turnId);
      expect(exit).toEqual(
        expect.objectContaining({ _tag: "Success", value: { kind: "turn-not-in-session" } }),
      );
    }
    expect((await peer.methods()).some((call) => call.method === "thread/fork")).toBe(false);
  });

  it("deletes a copy that does not end at the selected turn", async () => {
    const cwd = path.join(root, "fork-cwd");
    const peer = await codexPeer({
      forkId: "copy",
      threads: {
        source: codexThread("source", { turns: sourceTurns }),
        copy: codexThread("copy", {
          forkedFromId: "source",
          cwd,
          turns: turns(["t1", "completed"], ["t2", "completed"], ["t3", "interrupted"]),
        }),
      },
    });
    const exit = await runCodexFork(peer.binaryPath, "t2");
    expect(exit._tag === "Success" && exit.value.kind).toBe("refused");
    const deleted = (await peer.methods()).filter((call) => call.method === "thread/delete");
    expect(deleted.map((call) => call.params)).toEqual([{ threadId: "copy" }]);
  });

  it("reports a copy it created but could neither verify nor remove, with its id", async () => {
    const cwd = path.join(root, "fork-cwd");
    const peer = await codexPeer({
      forkId: "copy",
      deleteError: true,
      threads: {
        source: codexThread("source", { turns: sourceTurns }),
        copy: codexThread("copy", {
          forkedFromId: "source",
          cwd,
          turns: turns(["t1", "completed"], ["t2", "completed"], ["t3", "interrupted"]),
        }),
      },
    });
    const exit = await runCodexFork(peer.binaryPath, "t2");
    expect(exit._tag).toBe("Failure");
    const error = exit._tag === "Failure" ? Cause.squash(exit.cause) : null;
    expect(error).toMatchObject({
      _tag: "NativeForkUncertain",
      nativeThreadId: "copy",
      ownedCopy: { kind: "codex-thread", threadId: "copy" },
    });
  });

  it("treats a request rejected while decoding as definitive and any other fork failure as uncertain", async () => {
    const rejected = await codexPeer({
      forkError: { code: -32602, message: "invalid params" },
      threads: { source: codexThread("source", { turns: sourceTurns }) },
    });
    const refusedExit = await runCodexFork(rejected.binaryPath, "t2");
    expect(refusedExit._tag === "Success" && refusedExit.value).toEqual({
      kind: "refused",
      detail: "invalid params",
    });

    // Codex also answers -32600/-32601 from steps after the forked rollout is persisted.
    for (const code of [-32600, -32601]) {
      const afterCreate = await codexPeer({
        forkError: { code, message: "no rollout found for thread id copy" },
        threads: { source: codexThread("source", { turns: sourceTurns }) },
      });
      const exit = await runCodexFork(afterCreate.binaryPath, "t2");
      expect(exit._tag, String(code)).toBe("Failure");
      const error = exit._tag === "Failure" ? Cause.squash(exit.cause) : null;
      expect(error, String(code)).toMatchObject({ _tag: "NativeForkUncertain" });
      expect(error, String(code)).not.toHaveProperty("nativeThreadId");
    }

    const failed = await codexPeer({
      forkError: { code: -32000, message: "rollout write failed" },
      threads: { source: codexThread("source", { turns: sourceTurns }) },
    });
    const failedExit = await runCodexFork(failed.binaryPath, "t2");
    expect(failedExit._tag).toBe("Failure");
    expect(String(failedExit)).toContain("NativeForkUncertain");

    const crashed = await codexPeer({
      forkExit: true,
      threads: { source: codexThread("source", { turns: sourceTurns }) },
    });
    const crashedExit = await runCodexFork(crashed.binaryPath, "t2");
    expect(crashedExit._tag).toBe("Failure");
    expect(String(crashedExit)).toContain("NativeForkUncertain");
  });

  it("refuses without forking when the source cannot be read", async () => {
    const peer = await codexPeer({ threads: {} });
    const exit = await runCodexFork(peer.binaryPath, "t2");
    expect(exit._tag === "Success" && exit.value.kind).toBe("refused");
  });
});

// A two-turn Claude transcript in the source cwd's project directory.
async function claudeSource() {
  const sourceCwd = path.join(root, "source-project");
  const targetCwd = path.join(root, "fork-worktree");
  await mkdir(sourceCwd);
  await mkdir(targetCwd);
  const sourceDir = path.join(root, "projects", sourceCwd.replace(/[^a-zA-Z0-9]/g, "-"));
  await mkdir(sourceDir, { recursive: true });
  const id = "11111111-1111-4111-8111-111111111111";
  const prompt1 = "22222222-2222-4222-8222-222222222222";
  const answer1 = "33333333-3333-4333-8333-333333333333";
  const prompt2 = "44444444-4444-4444-8444-444444444444";
  const answer2 = "55555555-5555-4555-8555-555555555555";
  const prompt3 = "66666666-6666-4666-8666-666666666666";
  const answer3 = "77777777-7777-4777-8777-777777777777";
  const entry = (
    type: "user" | "assistant",
    uuid: string,
    parentUuid: string | null,
    minute: number,
    content: unknown,
  ) => ({
    type,
    uuid,
    parentUuid,
    sessionId: id,
    cwd: sourceCwd,
    timestamp: `2026-01-01T00:0${minute}:00Z`,
    message:
      type === "user"
        ? { role: "user", content }
        : { role: "assistant", content, stop_reason: "end_turn" },
  });
  const lines = (rows: ReadonlyArray<unknown>) =>
    rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
  const contents = lines([
    entry("user", prompt1, null, 0, "First question"),
    entry("assistant", answer1, prompt1, 1, [{ type: "text", text: "First answer" }]),
    entry("user", prompt2, answer1, 2, "Second question"),
    entry("assistant", answer2, prompt2, 3, [{ type: "text", text: "Second answer" }]),
  ]);
  const sourceFile = path.join(sourceDir, `${id}.jsonl`);
  await writeFile(sourceFile, contents);
  return {
    id,
    prompt1,
    prompt2,
    prompt3,
    sourceCwd,
    targetCwd,
    sourceDir,
    sourceFile,
    contents,
    /** The source runs on: a third turn reaches the transcript (only its prompt, or all of it). */
    appendThirdTurn: (complete = true) =>
      appendFile(
        sourceFile,
        lines([
          entry("user", prompt3, answer2, 4, "Third question"),
          ...(complete
            ? [entry("assistant", answer3, prompt3, 5, [{ type: "text", text: "Third answer" }])]
            : []),
        ]),
      ),
  };
}

type ClaudeSource = Awaited<ReturnType<typeof claudeSource>>;

const pinCutoff = (source: ClaudeSource, turnId: string, laterTurnIds: ReadonlyArray<string>) =>
  Effect.runPromise(
    pinClaudeForkCutoff({
      root,
      environment: process.env,
      sourceSessionId: source.id,
      recordedCwd: source.sourceCwd,
      turnId: TurnId.make(turnId),
      laterTurnIds: laterTurnIds.map((id) => TurnId.make(id)),
    }),
  );

const forkClaude = (
  source: ClaudeSource,
  turnId: string,
  cutoff: { readonly entryUuid: string; readonly entryIndex: number },
) =>
  Effect.runPromiseExit(
    forkClaudeThroughTurn({
      root,
      environment: process.env,
      sourceSessionId: source.id,
      recordedCwd: source.sourceCwd,
      targetCwd: source.targetCwd,
      turnId: TurnId.make(turnId),
      cutoff,
      title: claudeForkSessionTitle("fork-test"),
    }),
  );

const forkedCopy = async (exit: Awaited<ReturnType<typeof forkClaude>>) => {
  if (exit._tag !== "Success" || exit.value.kind !== "forked") {
    throw new Error(`expected a fork, got ${String(exit)}`);
  }
  const { nativeThreadId, ownedCopy } = exit.value;
  if (ownedCopy.kind !== "claude-file") throw new Error("expected a Claude copy");
  return { nativeThreadId, file: ownedCopy.file };
};

const pinned = async (
  source: ClaudeSource,
  turnId: string,
  laterTurnIds: ReadonlyArray<string>,
) => {
  const pin = await pinCutoff(source, turnId, laterTurnIds);
  if (pin.kind !== "pinned") throw new Error(`expected a pinned cutoff, got ${pin.kind}`);
  return pin;
};

describe("pinClaudeForkCutoff", () => {
  it(
    "pins the boundary turn's last entry, and says when that is the tail",
    { timeout: 60_000 },
    async () => {
      const source = await claudeSource();
      expect(await pinCutoff(source, source.prompt1, [source.prompt2])).toEqual({
        kind: "pinned",
        cutoff: { entryUuid: "33333333-3333-4333-8333-333333333333", entryIndex: 1 },
        atTail: false,
      });
      expect(await pinCutoff(source, source.prompt2, [])).toEqual({
        kind: "pinned",
        cutoff: { entryUuid: "55555555-5555-4555-8555-555555555555", entryIndex: 3 },
        atTail: true,
      });
      expect(await pinCutoff(source, "import:key:turn:1", [])).toEqual({
        kind: "turn-not-in-session",
      });
      expect(await pinCutoff(source, source.prompt1, ["wake-turn", source.prompt2])).toEqual({
        kind: "turn-not-in-session",
      });
      // Nothing is written while pinning.
      expect(await readdir(path.join(root, "projects"))).toEqual([path.basename(source.sourceDir)]);
      expect(await readFile(source.sourceFile, "utf8")).toBe(source.contents);
    },
  );
});

describe("forkClaudeThroughTurn", () => {
  it(
    "copies the session through the selected turn into the fork's project directory",
    { timeout: 60_000 },
    async () => {
      const source = await claudeSource();
      const pin = await pinned(source, source.prompt1, [source.prompt2]);
      const { nativeThreadId, file } = await forkedCopy(
        await forkClaude(source, source.prompt1, pin.cutoff),
      );
      expect(nativeThreadId).not.toBe(source.id);
      expect(path.dirname(file)).toBe(
        path.join(root, "projects", source.targetCwd.replace(/[^a-zA-Z0-9]/g, "-")),
      );
      const copied = await readFile(file, "utf8");
      expect(copied).toContain("First answer");
      expect(copied).not.toContain("Second question");
      expect(copied).not.toContain("Second answer");
      // The source is unchanged and nothing stays next to it.
      expect(await readFile(source.sourceFile, "utf8")).toBe(source.contents);
      expect(await readdir(source.sourceDir)).toEqual([`${source.id}.jsonl`]);
      const chain = await readClaudeMainChain({
        root,
        sessionId: nativeThreadId,
        cwd: source.targetCwd,
      });
      expect(chain.found && chain.chain.map((entry) => entry.type)).toEqual(["user", "assistant"]);

      await Effect.runPromise(removeClaudeForkCopy({ root, sessionId: nativeThreadId, file }));
      await expect(readFile(file, "utf8")).rejects.toThrow();
      // Removing again is a no-op.
      await Effect.runPromise(removeClaudeForkCopy({ root, sessionId: nativeThreadId, file }));
    },
  );

  for (const complete of [true, false]) {
    it(
      `ends a copy of the newest turn at the entry pinned at acceptance while the source runs on (${complete ? "a whole later turn" : "a later prompt"})`,
      { timeout: 60_000 },
      async () => {
        const source = await claudeSource();
        // Accepted while turn 2 was the newest: its tail is the pinned cutoff.
        const pin = await pinned(source, source.prompt2, []);
        expect(pin.atTail).toBe(true);
        // Before the provider step runs, the source sends turn 3.
        await source.appendThirdTurn(complete);
        const { nativeThreadId, file } = await forkedCopy(
          await forkClaude(source, source.prompt2, pin.cutoff),
        );
        const copied = await readFile(file, "utf8");
        expect(copied).toContain("Second answer");
        expect(copied).not.toContain("Third question");
        expect(copied).not.toContain("Third answer");
        const chain = await readClaudeMainChain({
          root,
          sessionId: nativeThreadId,
          cwd: source.targetCwd,
        });
        expect(chain.found && chain.chain.map((entry) => entry.type)).toEqual([
          "user",
          "assistant",
          "user",
          "assistant",
        ]);
      },
    );
  }

  it(
    "creates nothing when the pinned cutoff no longer ends the turn",
    { timeout: 60_000 },
    async () => {
      const source = await claudeSource();
      // An entry that is not at its pinned position (the chain was rewritten), a turn after the
      // cutoff, a turn not in the session, and a transcript in another project directory.
      const answer1 = { entryUuid: "33333333-3333-4333-8333-333333333333", entryIndex: 1 };
      const cases: ReadonlyArray<readonly [string, typeof answer1, string?]> = [
        [source.prompt1, { ...answer1, entryIndex: 2 }],
        [source.prompt2, answer1],
        ["import:key:turn:1", answer1],
      ];
      for (const [turnId, cutoff] of cases) {
        expect(await forkClaude(source, turnId, cutoff)).toMatchObject({
          _tag: "Success",
          value: { kind: "turn-not-in-session" },
        });
      }
      const elsewhere = await Effect.runPromise(
        forkClaudeThroughTurn({
          root,
          environment: process.env,
          sourceSessionId: source.id,
          recordedCwd: source.targetCwd,
          targetCwd: source.targetCwd,
          turnId: TurnId.make(source.prompt1),
          cutoff: answer1,
          title: claudeForkSessionTitle("fork-test"),
        }),
      );
      expect(elsewhere).toEqual({ kind: "turn-not-in-session" });
      expect(await readdir(path.join(root, "projects"))).toEqual([path.basename(source.sourceDir)]);
      expect(await readdir(source.sourceDir)).toEqual([`${source.id}.jsonl`]);
    },
  );

  it(
    "refuses without a copy when preparing the target fails before the fork",
    { timeout: 60_000 },
    async () => {
      const source = await claudeSource();
      const pin = await pinned(source, source.prompt1, [source.prompt2]);
      const projects = path.join(root, "projects");
      await chmod(projects, 0o555);
      try {
        const exit = await forkClaude(source, source.prompt1, pin.cutoff);
        // Nothing was created, so this is a definitive refusal, not "a copy may exist".
        expect(exit).toMatchObject({ _tag: "Success", value: { kind: "refused" } });
      } finally {
        await chmod(projects, 0o755);
      }
      expect(await readdir(projects)).toEqual([path.basename(source.sourceDir)]);
      expect(await readdir(source.sourceDir)).toEqual([`${source.id}.jsonl`]);
    },
  );

  it("removes a copy it created but could not move into place", { timeout: 60_000 }, async () => {
    const source = await claudeSource();
    const pin = await pinned(source, source.prompt1, [source.prompt2]);
    const targetDir = path.join(root, "projects", source.targetCwd.replace(/[^a-zA-Z0-9]/g, "-"));
    await mkdir(targetDir);
    await chmod(targetDir, 0o555);
    try {
      const exit = await forkClaude(source, source.prompt1, pin.cutoff);
      expect(exit).toMatchObject({ _tag: "Success", value: { kind: "refused" } });
      const detail =
        exit._tag === "Success" && exit.value.kind === "refused" ? exit.value.detail : "";
      expect(detail).toContain("The copy was removed.");
    } finally {
      await chmod(targetDir, 0o755);
    }
    // The SDK wrote the copy next to the source; it is gone again.
    expect(await readdir(source.sourceDir)).toEqual([`${source.id}.jsonl`]);
    expect(await readdir(targetDir)).toEqual([]);
  });

  it("refuses to remove anything outside the session store", async () => {
    const outside = path.join(root, "outside.jsonl");
    await writeFile(outside, "{}");
    const exit = await Effect.runPromiseExit(
      removeClaudeForkCopy({
        root,
        sessionId: "11111111-1111-4111-8111-111111111111",
        file: outside,
      }),
    );
    expect(exit._tag).toBe("Failure");
    expect(await readFile(outside, "utf8")).toBe("{}");
  });
});
