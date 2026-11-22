import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type { TerminalEvent } from "@ryco/contracts";
import { Effect, Exit, Option, Scope } from "effect";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { SHELL_MARK_NONCE_ENV } from "../shellIntegration.ts";
import type { TerminalAgentOutput, TerminalManagerShape } from "../Services/Manager.ts";
import { FakePtyAdapter } from "../testUtils/fakePty.ts";
import { makeTerminalManagerWithOptions } from "./Manager.ts";

const ref = { threadId: "thread-marks", terminalId: "agent-1" };
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function harness(platform: NodeJS.Platform = "darwin") {
  const root = mkdtempSync(path.join(os.tmpdir(), "ryco-marks-"));
  const scope = await Effect.runPromise(Scope.make());
  const pty = new FakePtyAdapter();
  const manager: TerminalManagerShape = await Effect.runPromise(
    makeTerminalManagerWithOptions({
      logsDir: path.join(root, "logs"),
      ptyAdapter: pty,
      shellResolver: () => "/bin/zsh",
      shellIntegrationDir: path.join(root, "shell-integration"),
      platform,
      outputCoalesceMs: 0,
      historyPersistDebounceMs: 60_000,
      processKillGraceMs: 0,
    }).pipe(Effect.provide(NodeServices.layer), Scope.provide(scope)),
  );
  cleanups.push(async () => {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    rmSync(root, { recursive: true, force: true });
  });
  const clientOutput: Array<string> = [];
  const agentOutput: Array<TerminalAgentOutput> = [];
  let waiting: Array<() => void> = [];
  await Effect.runPromise(
    manager.subscribe((event: TerminalEvent) =>
      Effect.sync(() => {
        if (event.type !== "output") return;
        clientOutput.push(event.data);
        for (const resolve of waiting.splice(0)) resolve();
      }),
    ),
  );
  await Effect.runPromise(manager.subscribeAgentOutput!((output) => void agentOutput.push(output)));
  const open = async (terminalId = ref.terminalId) => {
    await Effect.runPromise(manager.open({ ...ref, terminalId, cwd: root }));
    const process = pty.processes.at(-1)!;
    const nonce = pty.spawnInputs.at(-1)!.env[SHELL_MARK_NONCE_ENV]!;
    return { process, nonce };
  };
  /** Emits shell output and resolves once the manager published it. */
  const print = (process: { emitData: (data: string) => void }, data: string) =>
    new Promise<void>((resolve) => {
      waiting.push(resolve);
      process.emitData(data);
    });
  const shellState = async () =>
    Option.getOrThrow(await Effect.runPromise(manager.inspect!(ref))).shell;
  return { manager, pty, open, print, clientOutput, agentOutput, shellState };
}

const mark = (nonce: string, body: string) => `\u001b]133;${body};ryco=${nonce}\u0007`;

describe("Ryco's shell marks in the terminal manager", () => {
  it("gives every spawn its own nonce", async () => {
    const h = await harness();
    const first = await h.open("agent-1");
    const second = await h.open("agent-2");
    expect(first.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(second.nonce).not.toBe(first.nonce);
  });

  it("keeps marks out of the history and client output, gives them to agent listeners only", async () => {
    const h = await harness();
    const { process, nonce } = await h.open();
    await h.print(process, `${mark(nonce, "A")}$ `);
    await h.print(
      process,
      `ls\r\n${mark(nonce, "C")}file\r\n${mark(nonce, "D;0")}${mark(nonce, "A")}$ `,
    );
    const snapshot = Option.getOrThrow(await Effect.runPromise(h.manager.inspect!(ref))).snapshot;
    expect(snapshot.history).not.toContain(nonce);
    expect(snapshot.history).toContain("file");
    expect(h.clientOutput.join("")).not.toContain(nonce);
    expect(h.agentOutput.map((output) => output.data).join("")).toContain(`ryco=${nonce}`);
    expect(h.agentOutput.at(-1)?.markNonce).toBe(nonce);
    expect(await h.shellState()).toMatchObject({
      promptSeen: true,
      atPrompt: true,
      inputSincePrompt: false,
      lastEnd: { exitCode: 0 },
    });
  });

  it("never stores a printed skip marker or another session's Ryco mark", async () => {
    const h = await harness();
    const { process } = await h.open();
    await h.print(process, "a\u001b]7772;start;x\u0007b\u001b]133;D;0;ryco=other\u0007c\r\n");
    const snapshot = Option.getOrThrow(await Effect.runPromise(h.manager.inspect!(ref))).snapshot;
    expect(snapshot.history).toContain("abc");
    expect(snapshot.history).not.toContain("7772");
    expect(snapshot.history).not.toContain("ryco=");
  });

  it("strips a mark split across two chunks from client output", async () => {
    const h = await harness();
    const { process, nonce } = await h.open();
    const whole = mark(nonce, "A");
    await h.print(process, `before${whole.slice(0, 12)}`);
    await h.print(process, `${whole.slice(12)}$ `);
    expect(h.clientOutput.join("")).toBe("before$ ");
    expect((await h.shellState())?.atPrompt).toBe(true);
  });

  it("refuses an agent's run while the shell starts, runs, or the user typed at the prompt", async () => {
    const h = await harness();
    const { process, nonce } = await h.open();
    const write = (checks: { prompt?: boolean; visibleInput?: boolean }) =>
      Effect.runPromise(
        Effect.flip(h.manager.agentWrite!({ ref, data: "echo hi\r", checks })),
      ).then((refused) => refused.reason);
    expect(await write({ prompt: true })).toBe("starting");
    await h.print(process, `${mark(nonce, "A")}$ `);
    await Effect.runPromise(h.manager.write({ ...ref, data: "echo hal" }));
    expect(await write({ prompt: true })).toBe("user-typing");
    await h.print(process, `${mark(nonce, "D;130")}${mark(nonce, "A")}$ `);
    await h.print(process, mark(nonce, "C"));
    expect(await write({ prompt: true })).toBe("running");
  });

  it("refuses an agent's write when the shell printed a mark since its state was read", async () => {
    const h = await harness();
    const { process, nonce } = await h.open();
    await h.print(process, `${mark(nonce, "A")}$ `);
    const seen = await h.shellState();
    expect(seen?.lastMarkSequence).toBeGreaterThan(0);
    // The prompt drawn again (an empty Enter, a resize) after the caller looked.
    await h.print(process, `\r\n${mark(nonce, "D;0")}${mark(nonce, "A")}$ `);
    const refused = await Effect.runPromise(
      Effect.flip(
        h.manager.agentWrite!({
          ref,
          data: "echo hi\r",
          checks: { prompt: true, marksSeen: seen!.markCount },
        }),
      ),
    );
    expect(refused.reason).toBe("marks-moved");
    expect(process.writes).toEqual([]);
    const now = await h.shellState();
    await Effect.runPromise(
      h.manager.agentWrite!({
        ref,
        data: "echo hi\r",
        checks: { prompt: true, marksSeen: now!.markCount },
      }),
    );
    expect(process.writes).toEqual(["echo hi\r"]);
  });

  it("refuses typing where the tty flags cannot be read, and into hidden input", async () => {
    const h = await harness();
    const { process } = await h.open();
    const write = () =>
      Effect.runPromise(
        Effect.flip(h.manager.agentWrite!({ ref, data: "x", checks: { visibleInput: true } })),
      ).then((refused) => refused.reason);
    Object.assign(process, { readInputMode: () => Promise.resolve(undefined) });
    expect(await write()).toBe("input-mode-unknown");
    Object.assign(process, {
      readInputMode: () => Promise.resolve({ echo: false, canonical: true }),
    });
    expect(await write()).toBe("hidden-input");
    expect(process.writes).toEqual([]);
  });

  it("types without a tty read where the platform has none, and says so", async () => {
    const h = await harness("win32");
    const { process } = await h.open();
    const result = await Effect.runPromise(
      h.manager.agentWrite!({ ref, data: "x", checks: { visibleInput: true } }),
    );
    expect(result.inputModeChecked).toBe(false);
    expect(process.writes).toEqual(["x"]);
  });
});
