import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as Path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vite-plus/test";

import {
  createNativeSecurityHelperRunner,
  DesktopNativeSecurityError,
  DesktopNativeSecurityHelper,
  resolveDesktopNativeSecurityHelperPath,
} from "./nativeSecurityHelper.ts";

const directory = mkdtempSync(Path.join(tmpdir(), "ryco-security-helper-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

/**
 * A stand-in helper speaking the same framing: one JSON request per line, one
 * JSON answer per line, exit at end of input. `mode` selects a misbehaviour.
 */
function fakeHelper(name: string, mode: "ok" | "hang" | "garbage" | "crash"): string {
  const path = Path.join(directory, name);
  writeFileSync(
    path,
    `#!${process.execPath}
let buffer = "";
let served = 0;
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const request = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    served += 1;
    if (${JSON.stringify(mode)} === "hang") continue;
    if (${JSON.stringify(mode)} === "garbage") { process.stdout.write("not json\\n"); continue; }
    if (${JSON.stringify(mode)} === "crash") process.exit(3);
    process.stdout.write(JSON.stringify({ ok: true, pid: process.pid, served, operation: request.operation }) + "\\n");
  }
});
`,
  );
  chmodSync(path, 0o755);
  return path;
}

const sign = { operation: "signing.create" } as const;
const pidOf = (value: unknown) => (value as { pid: number }).pid;

describe("createNativeSecurityHelperRunner", () => {
  it("serves a burst of requests from one helper process, in order", async () => {
    const run = createNativeSecurityHelperRunner(fakeHelper("burst", "ok"), { idleMs: 500 });
    const answers = (await Promise.all([run(sign), run(sign), run(sign)])) as {
      pid: number;
      served: number;
    }[];
    expect(new Set(answers.map((answer) => answer.pid)).size).toBe(1);
    expect(answers.map((answer) => answer.served)).toEqual([1, 2, 3]);
  });

  it("lets an idle helper exit and starts a fresh one for the next request", async () => {
    const run = createNativeSecurityHelperRunner(fakeHelper("idle", "ok"), { idleMs: 20 });
    const first = pidOf(await run(sign));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = await run(sign);
    expect(pidOf(second)).not.toBe(first);
    expect((second as { served: number }).served).toBe(1);
  });

  it("fails a request that gets no answer and does not reuse that helper", async () => {
    const run = createNativeSecurityHelperRunner(fakeHelper("hang", "hang"), {
      timeoutMs: 50,
    });
    await expect(run(sign)).rejects.toEqual(new DesktopNativeSecurityError("operation_failed"));
    await expect(run(sign)).rejects.toEqual(new DesktopNativeSecurityError("operation_failed"));
  });

  it("discards a helper whose answer is not JSON or that exits mid-request", async () => {
    for (const mode of ["garbage", "crash"] as const) {
      const run = createNativeSecurityHelperRunner(fakeHelper(mode, mode));
      await expect(run(sign)).rejects.toEqual(new DesktopNativeSecurityError("operation_failed"));
    }
  });

  it("reports a missing helper as unavailable hardware", async () => {
    const run = createNativeSecurityHelperRunner(Path.join(directory, "missing"));
    await expect(run(sign)).rejects.toEqual(new DesktopNativeSecurityError("hardware_unavailable"));
  });
});

const builtHelper = resolveDesktopNativeSecurityHelperPath({
  isPackaged: false,
  resourcesPath: "",
  moduleDirectory: Path.dirname(fileURLToPath(import.meta.url)),
});

describe.skipIf(process.platform !== "darwin" || !existsSync(builtHelper))(
  "the built macOS helper",
  () => {
    it("signs repeatedly over one process with a Secure Enclave key", async () => {
      const records = new Map<string, string>();
      const security = new DesktopNativeSecurityHelper({
        run: createNativeSecurityHelperRunner(builtHelper),
        store: {
          read: async (kind) => records.get(kind) ?? null,
          create: async (kind, value) => {
            if (records.has(kind)) return false;
            records.set(kind, value);
            return true;
          },
          delete: async (kind) => {
            records.delete(kind);
          },
        },
      });
      let key;
      try {
        key = await security.getSigningKey();
      } catch (error) {
        // Hosts without a Secure Enclave (Intel without T2, CI VMs) cannot run this.
        if (error instanceof DesktopNativeSecurityError && error.code === "hardware_unavailable") {
          return;
        }
        throw error;
      }
      const payload = new TextEncoder().encode("ryco");
      const signatures = await Promise.all([key.sign(payload), key.sign(payload)]);
      for (const signature of signatures) expect(signature.byteLength).toBe(64);
    });
  },
);
