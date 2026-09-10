import { execFile, execFileSync, type ChildProcess } from "node:child_process";
import { lookup } from "node:dns/promises";
import { once } from "node:events";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { readProjectFavicon, type ProjectFaviconExecFile } from "./readProjectFavicon.ts";

const directories: string[] = [];
async function workspace() {
  const dir = await mkdtemp(path.join(tmpdir(), "ryco-icon-io-"));
  directories.push(dir);
  return realpath(dir);
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("optional project icon I/O", () => {
  it("passes a workspace argument after the runtime option terminator", async () => {
    let received: readonly string[] = [];
    const observe: ProjectFaviconExecFile = (file, args, options, callback) => {
      received = args;
      return execFile(file, args, options, callback);
    };
    expect(await readProjectFavicon("--version", { execFile: observe })).toBeNull();
    expect(received.slice(-2)).toEqual(["--", "--version"]);
  });

  it("returns icon bytes from the isolated reader", async () => {
    const dir = await workspace();
    await writeFile(path.join(dir, "favicon.svg"), "<svg>icon</svg>");
    const icon = await readProjectFavicon(dir);
    expect(icon?.path).toBe(path.join(dir, "favicon.svg"));
    expect(Buffer.from(icon!.bytes).toString()).toBe("<svg>icon</svg>");
  });

  it("skips oversized icons and still discovers a small fallback", async () => {
    const dir = await workspace();
    await writeFile(path.join(dir, "favicon.svg"), Buffer.alloc(512 * 1024 + 1));
    await writeFile(path.join(dir, "favicon.png"), "small");
    expect((await readProjectFavicon(dir))?.path).toBe(path.join(dir, "favicon.png"));
  });

  it("does not inspect oversized source files", async () => {
    const dir = await workspace();
    await mkdir(path.join(dir, "public"));
    await writeFile(path.join(dir, "public", "brand.svg"), "private source");
    await writeFile(
      path.join(dir, "index.html"),
      " ".repeat(256 * 1024) + '<link rel="icon" href="/brand.svg">',
    );
    expect(await readProjectFavicon(dir)).toBeNull();
  });

  it.skipIf(process.platform === "win32")(
    "rejects icons that escape through a symlink",
    async () => {
      const dir = await workspace();
      const outside = await workspace();
      await writeFile(path.join(outside, "private.svg"), "outside-project");
      await symlink(path.join(outside, "private.svg"), path.join(dir, "favicon.svg"));
      expect(await readProjectFavicon(dir)).toBeNull();
    },
  );

  it.skipIf(process.platform === "win32")(
    "skips special source files without waiting for a writer",
    async () => {
      const dir = await workspace();
      execFileSync("mkfifo", [path.join(dir, "index.html")]);
      expect(await readProjectFavicon(dir, { timeoutMs: 1_000 })).toBeNull();
    },
  );

  it.skipIf(process.platform === "win32")(
    "kills blocked child opens while the node's filesystem and DNS stay usable",
    async () => {
      const dir = await workspace();
      const fifo = path.join(dir, "blocked-open");
      execFileSync("mkfifo", [fifo]);
      const marker = path.join(dir, "node-state");
      await writeFile(marker, "ready");
      const children: ChildProcess[] = [];
      // Substitute only the worker program: the real process deadline, output
      // handling and forced termination remain the production implementation.
      const blockedExec: ProjectFaviconExecFile = (file, _args, options, callback) => {
        const child = execFile(
          file,
          ["--eval", 'require("node:fs").openSync(process.argv[1], "r")', fifo],
          options,
          callback,
        );
        children.push(child);
        return child;
      };
      const reads = Array.from({ length: 4 }, () =>
        readProjectFavicon(dir, { execFile: blockedExec, timeoutMs: 300 }),
      );
      await Promise.all(children.map((child) => once(child, "spawn")));
      expect(await readFile(marker, "utf8")).toBe("ready");
      expect((await lookup("localhost")).address).toBeTruthy();
      expect(await Promise.all(reads)).toEqual([null, null, null, null]);
      expect(children.every((child) => child.signalCode === "SIGKILL")).toBe(true);
    },
  );

  it("terminates an in-flight worker when its HTTP request is cancelled", async () => {
    const controller = new AbortController();
    let child: ChildProcess | undefined;
    const delayedExec: ProjectFaviconExecFile = (file, _args, options, callback) => {
      child = execFile(file, ["--eval", "setTimeout(() => {}, 60_000)"], options, callback);
      return child;
    };
    const pending = readProjectFavicon(await workspace(), {
      execFile: delayedExec,
      signal: controller.signal,
    });
    await once(child!, "spawn");
    const exited = new Promise<void>((resolve) => child!.once("exit", () => resolve()));
    controller.abort();
    expect(await pending).toBeNull();
    await exited;
    expect(child!.signalCode).toBe("SIGKILL");
  });
});
