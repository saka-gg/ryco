import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { request } from "node:http";
import { relative, isAbsolute } from "node:path";
import type { DiscoveredProjectSite } from "@ryco/contracts";

interface Listener {
  port: number;
  pid: number;
  process: string;
  cwd?: string;
}
export function parseListeners(output: string, platform = process.platform): Listener[] {
  const result = new Map<number, Listener>();
  let pid = 0,
    processName = "Local process";
  for (const line of output.split(/\r?\n/u)) {
    if (platform === "win32") {
      const row = line.trim().split(/\s+/u);
      if (row[0] !== "TCP" || row[3] !== "LISTENING") continue;
      const port = Number(row[1]?.split(":").pop());
      if (port > 0 && port <= 65535)
        result.set(port, { port, pid: Number(row[4]), process: `Process ${row[4]}` });
    } else {
      if (line.startsWith("p")) pid = Number(line.slice(1));
      if (line.startsWith("c")) processName = line.slice(1);
      if (!line.startsWith("n")) continue;
      const port = Number(line.split(":").pop());
      if (Number.isSafeInteger(port) && port > 0 && port <= 65535 && Number.isSafeInteger(pid))
        result.set(port, { port, pid, process: processName });
    }
  }
  return [...result.values()].slice(0, 128);
}
export function belongsToProject(project: string | undefined, cwd: string | undefined): boolean {
  if (!project || !cwd || !isAbsolute(project) || !isAbsolute(cwd)) return false;
  const path = relative(project, cwd);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}
export function probeHttp(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/",
        method: "HEAD",
        agent: false,
        maxHeaderSize: 16384,
      },
      (response) => {
        response.destroy();
        resolve(true);
      },
    );
    // A total deadline also bounds servers that continuously trickle partial headers.
    const deadline = setTimeout(() => req.destroy(), 600);
    deadline.unref();
    req.on("error", () => resolve(false));
    req.on("close", () => {
      clearTimeout(deadline);
      resolve(false);
    });
    req.end();
  });
}

/** Read-only, bounded discovery. No credentials, commands from projects, or port forwarding. */
export class ProjectSiteDiscovery {
  private cached: Listener[] = [];
  private checkedAt = 0;
  private inFlight: Promise<void> | null = null;
  async discover(cwd?: string): Promise<DiscoveredProjectSite[]> {
    if (Date.now() - this.checkedAt > 5000) {
      this.inFlight ??= this.read().finally(() => {
        this.inFlight = null;
      });
      await this.inFlight;
    }
    return this.cached
      .map((entry) => ({
        url: `http://localhost:${entry.port}/`,
        port: entry.port,
        process: entry.process,
        projectMatch: belongsToProject(cwd, entry.cwd),
      }))
      .toSorted((a, b) => Number(b.projectMatch) - Number(a.projectMatch) || a.port - b.port);
  }
  private async read(): Promise<void> {
    const run = promisify(execFile);
    const options = { timeout: 3000, maxBuffer: 1024 * 1024, windowsHide: true };
    const { stdout } =
      process.platform === "win32"
        ? await run("netstat", ["-ano", "-p", "tcp"], options)
        : await run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"], options).catch((error) => {
            if (error.code === 1 && !error.stdout) return { stdout: "" };
            throw new Error(
              "Local service discovery needs lsof. You can still enter a URL manually.",
            );
          });
    const candidates = parseListeners(stdout).filter((entry) => entry.pid !== process.pid);
    const live: Listener[] = [];
    let index = 0;
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        while (index < candidates.length) {
          const entry = candidates[index++]!;
          if (await probeHttp(entry.port)) live.push(entry);
        }
      }),
    );
    if (process.platform !== "win32" && live.length) {
      const directories = await run(
        "lsof",
        ["-a", "-p", [...new Set(live.map((entry) => entry.pid))].join(","), "-d", "cwd", "-Fpn"],
        options,
      ).catch(() => ({ stdout: "" }));
      let pid = 0;
      for (const line of directories.stdout.split("\n")) {
        if (line.startsWith("p")) pid = Number(line.slice(1));
        if (line.startsWith("n"))
          for (const entry of live) if (entry.pid === pid) entry.cwd = line.slice(1);
      }
    }
    this.cached = live;
    this.checkedAt = Date.now();
  }
}
