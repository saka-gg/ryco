import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { vi } from "vitest";

import { cursorAgentCommandCandidates, resolveCursorAgentCommand } from "./CursorAgentCommand.ts";

// Probes and session spawns must not search PATH synchronously: a stalled mount on PATH would
// block the event loop.
vi.mock("@ryco/shared/shell", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@ryco/shared/shell")>()),
  resolveCommandPath: () => {
    throw new Error("synchronous PATH search");
  },
}));

const makeBinDir = (commands: ReadonlyArray<string>) => {
  const binDir = path.join(os.tmpdir(), `ryco-cursor-command-${crypto.randomUUID()}`);
  mkdirSync(binDir, { recursive: true });
  for (const command of commands) {
    const file = path.join(binDir, command);
    writeFileSync(file, "#!/bin/sh\n");
    chmodSync(file, 0o755);
  }
  return binDir;
};

describe("resolveCursorAgentCommand", () => {
  it.effect("prefers cursor-agent over the generic default agent when both are on PATH", () =>
    Effect.gen(function* () {
      const binDir = makeBinDir(["agent", "cursor-agent"]);
      const resolved = yield* resolveCursorAgentCommand("agent", { PATH: binDir });
      expect(resolved).toEqual({
        command: "cursor-agent",
        resolvedPath: path.join(binDir, "cursor-agent"),
      });
    }),
  );

  it.effect("keeps the default agent when cursor-agent is not installed", () =>
    Effect.gen(function* () {
      const binDir = makeBinDir(["agent"]);
      const resolved = yield* resolveCursorAgentCommand("", { PATH: binDir }, { fresh: true });
      expect(resolved).toEqual({ command: "agent", resolvedPath: path.join(binDir, "agent") });
    }),
  );

  it.effect("never rewrites an explicit binary path", () =>
    Effect.gen(function* () {
      const binDir = makeBinDir(["agent", "cursor-agent", "my-cursor"]);
      const resolved = yield* resolveCursorAgentCommand("my-cursor", { PATH: binDir });
      expect(resolved.command).toBe("my-cursor");
      expect(cursorAgentCommandCandidates("my-cursor")).toEqual(["my-cursor"]);
      expect(cursorAgentCommandCandidates("agent")).toEqual(["cursor-agent", "agent"]);
    }),
  );

  it.effect("re-resolves on fresh lookups so a newly installed cursor-agent is picked up", () =>
    Effect.gen(function* () {
      const binDir = makeBinDir(["agent"]);
      const env = { PATH: binDir };
      expect((yield* resolveCursorAgentCommand("agent", env, { fresh: true })).command).toBe(
        "agent",
      );
      const installed = path.join(binDir, "cursor-agent");
      writeFileSync(installed, "#!/bin/sh\n");
      chmodSync(installed, 0o755);
      expect((yield* resolveCursorAgentCommand("agent", env)).command).toBe("agent");
      expect((yield* resolveCursorAgentCommand("agent", env, { fresh: true })).command).toBe(
        "cursor-agent",
      );
    }),
  );
});
