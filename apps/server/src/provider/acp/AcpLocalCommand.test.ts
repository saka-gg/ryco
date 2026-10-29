// @effect-diagnostics nodeBuiltinImport:off
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveCommandPathAsync } from "@ryco/shared/shell";
import { afterAll, assert, describe, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { vi } from "vitest";
import {
  AcpLocalCommandUnavailable,
  acpLocalCommandDisplayName,
  resolveAcpLocalCommand,
  type AcpLocalCommandDependencies,
} from "./AcpLocalCommand.ts";

const root = mkdtempSync(join(tmpdir(), "ryco-acp-local-command-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const executable = (directory: string, name: string) => {
  mkdirSync(directory, { recursive: true });
  const file = join(directory, name);
  writeFileSync(file, "#!/bin/sh\n");
  chmodSync(file, 0o755);
  return file;
};

const deps = (patch: Partial<AcpLocalCommandDependencies> = {}): AcpLocalCommandDependencies => ({
  platform: "darwin",
  resolve: resolveCommandPathAsync,
  expandHome: (value) => value,
  ...patch,
});

const failureDetail = (
  result: Result.Result<unknown, { readonly detail: string; cause: unknown }>,
) => {
  assert.isTrue(Result.isFailure(result));
  if (!Result.isFailure(result)) return "";
  // Callers outside the ACP chunk recognise this cause by its tag.
  assert.instanceOf(result.failure.cause, AcpLocalCommandUnavailable);
  return result.failure.detail;
};

describe("resolveAcpLocalCommand", () => {
  it.effect("resolves an absolute executable and passes arguments through unchanged", () =>
    Effect.gen(function* () {
      const agent = executable(join(root, "absolute"), "agent");
      const args = ["--acp", " literal $(x) ; ", ""];
      const resolved = yield* resolveAcpLocalCommand({ command: ` ${agent} `, args }, {}, deps());
      assert.deepStrictEqual(resolved, { command: agent, args, env: {} });
      assert.strictEqual(resolved.args, args);
    }),
  );

  it.effect("looks a bare name up on the instance environment's PATH", () =>
    Effect.gen(function* () {
      const bin = join(root, "instance-bin");
      const agent = executable(bin, "instance-agent");
      const resolved = yield* resolveAcpLocalCommand(
        { command: "instance-agent", args: [] },
        { PATH: bin },
        deps(),
      );
      assert.equal(resolved.command, agent);
    }),
  );

  it.effect("rejects relative paths without touching the filesystem", () =>
    Effect.gen(function* () {
      const resolve = vi.fn(resolveCommandPathAsync);
      for (const command of ["./agent", "bin/agent", "..\\agent"]) {
        const result = yield* resolveAcpLocalCommand(
          { command, args: [] },
          {},
          deps({ resolve }),
        ).pipe(Effect.result);
        assert.equal(failureDetail(result), "Use an absolute path or a command name on PATH.");
      }
      assert.equal(resolve.mock.calls.length, 0);
    }),
  );

  it.effect("names a missing command without leaking environment values", () =>
    Effect.gen(function* () {
      const result = yield* resolveAcpLocalCommand(
        { command: "missing-acp-agent", args: [] },
        { PATH: join(root, "empty"), API_KEY: "secret-value" },
        deps(),
      ).pipe(Effect.result);
      const detail = failureDetail(result);
      assert.equal(detail, "`missing-acp-agent` was not found on this node.");
      assert.notInclude(detail, "secret-value");
      assert.notInclude(detail, root);
    }),
  );

  it.effect("asks for an executable when none is configured", () =>
    Effect.gen(function* () {
      const result = yield* resolveAcpLocalCommand({ command: "  ", args: [] }, {}, deps()).pipe(
        Effect.result,
      );
      assert.equal(failureDetail(result), "Enter the agent's executable.");
    }),
  );

  it.effect("never searches relative PATH entries", () =>
    Effect.gen(function* () {
      // `.` would be the server's working directory here and the project's at spawn time.
      const resolve = vi.fn(resolveCommandPathAsync);
      const notFound = yield* resolveAcpLocalCommand(
        { command: "package.json", args: [] },
        { PATH: "." },
        deps({ resolve }),
      ).pipe(Effect.result);
      assert.equal(failureDetail(notFound), "`package.json` was not found on this node.");
      assert.equal(resolve.mock.calls[0]?.[1]?.env?.PATH, "");
      resolve.mockClear();

      const bin = join(root, "mixed-bin");
      const agent = executable(bin, "mixed-agent");
      const resolved = yield* resolveAcpLocalCommand(
        { command: "mixed-agent", args: [] },
        { PATH: [".", "bin", bin].join(":") },
        deps({ resolve }),
      );
      assert.equal(resolved.command, agent);
      assert.equal(resolve.mock.calls[0]?.[1]?.env?.PATH, bin);
    }),
  );

  it.effect("refuses a relative lookup result", () =>
    Effect.gen(function* () {
      const result = yield* resolveAcpLocalCommand(
        { command: "relative-agent", args: [] },
        {},
        deps({ resolve: async () => "relative-agent" }),
      ).pipe(Effect.result);
      assert.equal(failureDetail(result), "`relative-agent` was not found on this node.");
    }),
  );

  it.effect("rejects Windows batch wrappers", () =>
    Effect.gen(function* () {
      for (const resolved of ["C:\\tools\\agent.cmd", "C:\\tools\\agent.BAT"]) {
        const result = yield* resolveAcpLocalCommand(
          { command: "agent", args: [] },
          {},
          deps({ platform: "win32", resolve: async () => resolved }),
        ).pipe(Effect.result);
        assert.include(failureDetail(result), "without a shell");
      }
      const exe = yield* resolveAcpLocalCommand(
        { command: "C:\\tools\\agent.exe", args: ["--acp"] },
        {},
        deps({ platform: "win32", resolve: async () => "C:\\tools\\agent.exe" }),
      );
      assert.equal(exe.command, "C:\\tools\\agent.exe");
    }),
  );

  it.effect("takes only drive-qualified or UNC paths as absolute on Windows", () =>
    Effect.gen(function* () {
      const resolve = vi.fn<typeof resolveCommandPathAsync>(async () => "C:\\bin\\agent.exe");
      const rootRelative = yield* resolveAcpLocalCommand(
        { command: "\\tools\\agent.exe", args: [] },
        {},
        deps({ platform: "win32", resolve }),
      ).pipe(Effect.result);
      assert.equal(failureDetail(rootRelative), "Use an absolute path or a command name on PATH.");
      assert.equal(resolve.mock.calls.length, 0);

      const found = yield* resolveAcpLocalCommand(
        { command: "agent", args: [] },
        { PATH: "\\bin;C:\\bin;\\\\host\\share\\bin" },
        deps({ platform: "win32", resolve }),
      );
      assert.equal(found.command, "C:\\bin\\agent.exe");
      assert.equal(resolve.mock.calls[0]?.[1]?.env?.PATH, "C:\\bin;\\\\host\\share\\bin");

      const rootRelativeResult = yield* resolveAcpLocalCommand(
        { command: "agent", args: [] },
        {},
        deps({ platform: "win32", resolve: async () => "\\tools\\agent.exe" }),
      ).pipe(Effect.result);
      assert.equal(failureDetail(rootRelativeResult), "`agent` was not found on this node.");
    }),
  );

  it.effect("expands a leading ~ before resolving", () =>
    Effect.gen(function* () {
      const home = join(root, "home");
      const agent = executable(join(home, "bin"), "agent");
      const resolved = yield* resolveAcpLocalCommand(
        { command: "~/bin/agent", args: [] },
        {},
        deps({ expandHome: (value) => value.replace(/^~/u, home) }),
      );
      assert.equal(resolved.command, agent);
    }),
  );
});

describe("acpLocalCommandDisplayName", () => {
  it("uses the executable's basename without its extension", () => {
    assert.equal(acpLocalCommandDisplayName("/usr/local/bin/gemini"), "gemini");
    assert.equal(acpLocalCommandDisplayName("C:\\tools\\agent.exe"), "agent");
    assert.equal(acpLocalCommandDisplayName("node"), "node");
    assert.equal(acpLocalCommandDisplayName(""), "Local ACP agent");
  });
});
