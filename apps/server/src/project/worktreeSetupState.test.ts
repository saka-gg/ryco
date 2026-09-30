import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { Deferred, Effect, Exit, Fiber } from "effect";
import { withWorktreeSetupOwnership } from "./worktreeSetupState.ts";

let stateDir: string;
let checkout: string;
let ownerPath: string;
beforeEach(async () => {
  stateDir = await mkdtemp(path.join(tmpdir(), "worktree-ownership-"));
  checkout = path.join(stateDir, "checkout");
  ownerPath = path.join(
    stateDir,
    "incomplete-worktree-setup",
    `${createHash("sha256").update(checkout).digest("hex")}.json.owner`,
  );
  await mkdir(path.dirname(ownerPath));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(stateDir, { recursive: true, force: true });
});

const ownerRecord = (pid: number, phase: "reserved" | "mutating") =>
  JSON.stringify({ version: 1, pid, token: "synthetic-owner", phase });

// A real exited child supplies a demonstrably dead PID, rather than guessing a
// PID or treating elapsed time as proof that a creator or its children are dead.
const exitedOwner = (phase: "reserved" | "mutating") =>
  new Promise<number>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
    require("node:fs").writeFileSync(process.argv[1], JSON.stringify({
      version: 1, pid: process.pid, token: "synthetic-owner", phase: process.argv[2]
    }), { flag: "wx", mode: 0o600 });
  `,
        ownerPath,
        phase,
      ],
      { stdio: "ignore" },
    );
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 && child.pid ? resolve(child.pid) : reject(new Error("fixture failed")),
    );
  });

const attempt = () =>
  Effect.runPromise(
    withWorktreeSetupOwnership(stateDir, checkout, () => Effect.void).pipe(Effect.result),
  );

describe("durable worktree setup ownership", () => {
  it("reclaims a demonstrably dead owner only before mutation was possible", async () => {
    const pid = await exitedOwner("reserved");
    expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    expect((await attempt())._tag).toBe("Success");
    await expect(readFile(ownerPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("blocks a live sibling process, then recovers only after its pre-mutation exit", async () => {
    const child = spawn(
      process.execPath,
      [
        "-e",
        `
      require("node:fs").writeFileSync(process.argv[1], JSON.stringify({
        version: 1, pid: process.pid, token: "synthetic-owner", phase: "reserved"
      }), { flag: "wx", mode: 0o600 });
      process.stdout.write("ready");
      process.stdin.resume();
      process.stdin.on("end", () => process.exit(0));
    `,
        ownerPath,
      ],
      { stdio: ["pipe", "pipe", "ignore"] },
    );
    const closed = new Promise<void>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error("fixture failed"))));
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.once("data", () => resolve());
        child.once("error", reject);
      });
      const original = await readFile(ownerPath, "utf8");
      expect((await attempt())._tag).toBe("Failure");
      expect(await readFile(ownerPath, "utf8")).toBe(original);
    } finally {
      child.stdin.end();
      await closed;
    }
    expect((await attempt())._tag).toBe("Success");
  });

  it("keeps a dead mutating owner because orphan Git children remain unknown", async () => {
    const pid = await exitedOwner("mutating");
    expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    const original = await readFile(ownerPath, "utf8");
    expect((await attempt())._tag).toBe("Failure");
    expect((await attempt())._tag).toBe("Failure");
    expect(await readFile(ownerPath, "utf8")).toBe(original);
  });

  it("does not infer ownership death from a reused/live PID or a failed probe", async () => {
    const original = ownerRecord(process.pid, "reserved");
    await writeFile(ownerPath, original);
    expect((await attempt())._tag).toBe("Failure");
    for (const code of ["EPERM", "EINVAL"]) {
      const probe = vi.spyOn(process, "kill").mockImplementation(() => {
        throw Object.assign(new Error("synthetic probe uncertainty"), { code });
      });
      expect((await attempt())._tag).toBe("Failure");
      expect(await readFile(ownerPath, "utf8")).toBe(original);
      probe.mockRestore();
    }
  });

  it("refuses a competing reclaimer and malformed ownership without deleting state", async () => {
    await exitedOwner("reserved");
    const original = await readFile(ownerPath, "utf8");
    await writeFile(`${ownerPath}.reclaim`, "synthetic election");
    expect((await attempt())._tag).toBe("Failure");
    expect(await readFile(ownerPath, "utf8")).toBe(original);
    await rm(`${ownerPath}.reclaim`);
    await writeFile(ownerPath, "partial ownership fixture");
    expect((await attempt())._tag).toBe("Failure");
    expect(await readFile(ownerPath, "utf8")).toBe("partial ownership fixture");
  });

  it("retains an admitted creator after an unexpected defect", async () => {
    const exit = await Effect.runPromise(
      withWorktreeSetupOwnership(stateDir, checkout, (mutation) =>
        mutation.pipe(Effect.andThen(Effect.die("synthetic defect"))),
      ).pipe(Effect.exit),
    );
    expect(Exit.hasDies(exit)).toBe(true);
    expect(JSON.parse(await readFile(ownerPath, "utf8")).phase).toBe("mutating");
    expect((await attempt())._tag).toBe("Failure");
  });

  it("releases normal failures, but retains uncertain cancellation after mutation admission", async () => {
    const normal = await Effect.runPromise(
      withWorktreeSetupOwnership(stateDir, checkout, (mutation) =>
        mutation.pipe(Effect.andThen(Effect.fail("synthetic failure"))),
      ).pipe(Effect.result),
    );
    expect(normal._tag).toBe("Failure");
    await expect(readFile(ownerPath)).rejects.toMatchObject({ code: "ENOENT" });
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const admitted = yield* Deferred.make<void>();
          const creator = yield* withWorktreeSetupOwnership(stateDir, checkout, (mutation) =>
            mutation.pipe(
              Effect.andThen(Deferred.succeed(admitted, undefined)),
              Effect.andThen(Effect.never),
            ),
          ).pipe(Effect.forkChild);
          yield* Deferred.await(admitted);
          yield* Fiber.interrupt(creator);
        }),
      ),
    );
    expect(JSON.parse(await readFile(ownerPath, "utf8")).phase).toBe("mutating");
    expect((await attempt())._tag).toBe("Failure");
  });
});
