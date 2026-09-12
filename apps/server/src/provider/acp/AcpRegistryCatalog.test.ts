import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACP_REGISTRY_URL,
  extractAcpRegistryArchive,
  makeAcpRegistryCatalog,
  safeAcpRegistryPath,
} from "./AcpRegistryCatalog.ts";
const checksum = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const roots: string[] = [];
async function fixture(options: { sha256?: string; archive?: string; bytes?: Buffer } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ryco-registry-")));
  roots.push(root);
  const bytes = options.bytes ?? Buffer.from("#!/bin/sh\nprintf hello");
  const archive =
    options.archive ?? "https://github.com/example/agent/releases/download/v1.2.3/agent";
  const index = {
    agents: [
      {
        id: "test-agent",
        version: "1.2.3",
        name: "Test Agent",
        description: "Test agent description",
        distribution: {
          binary: {
            "darwin-aarch64": {
              archive,
              sha256: options.sha256 ?? checksum(bytes),
              cmd: "./agent",
              args: ["--acp"],
            },
          },
        },
      },
    ],
  };
  const fetcher = vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(
    async (url) => new Response(String(url) === ACP_REGISTRY_URL ? JSON.stringify(index) : bytes),
  );
  const catalog = makeAcpRegistryCatalog({
    installationRoot: path.join(root, "agents"),
    fetch: fetcher,
    platform: "darwin-aarch64",
  });
  return { root, bytes, index, fetcher, catalog };
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
const pin = { agentId: "test-agent", version: "1.2.3" };
function tarEntry(name: string, type = "0", contents = Buffer.from("binary")): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write("0000700\0", 100);
  header.write(contents.length.toString(8).padStart(11, "0") + "\0", 124);
  header.fill(32, 148, 156);
  header.write(type, 156);
  const sum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return Buffer.concat([
    header,
    contents,
    Buffer.alloc((512 - (contents.length % 512)) % 512),
    Buffer.alloc(1024),
  ]);
}
describe("ACP Registry managed catalog", () => {
  it("discovers metadata without downloading or executing agent code", async () => {
    const { catalog, fetcher } = await fixture();
    expect(await catalog.search("agent")).toMatchObject([
      { id: "test-agent", version: "1.2.3", installed: false, installable: true },
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(catalog.resolveInstalled(pin)).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("installs only explicitly selected exact versions and rechecks integrity offline", async () => {
    const { catalog, fetcher } = await fixture();
    await expect(catalog.install({ ...pin, version: "1.2.4" })).rejects.toThrow(
      "no longer available",
    );
    const installed = await catalog.install(pin);
    expect(installed.version).toBe("1.2.3");
    fetcher.mockClear();
    const command = await catalog.resolveInstalled(pin);
    expect(command.args).toEqual(["--acp"]);
    expect(fetcher).not.toHaveBeenCalled();
    await fs.writeFile(command.command, "tampered");
    await expect(catalog.resolveInstalled(pin)).rejects.toThrow("checksum mismatch");
  });
  it("fails closed on missing or mismatched checksums", async () => {
    const { catalog } = await fixture({ sha256: "0".repeat(64) });
    await expect(catalog.install(pin)).rejects.toThrow("checksum mismatch");
    const missing = await fixture({ sha256: "" });
    expect(await missing.catalog.search()).toMatchObject([
      { installable: false, unavailableReason: expect.stringContaining("SHA-256") },
    ]);
  });
  it("does not accept arbitrary download origins or redirect targets", async () => {
    const { catalog } = await fixture({ archive: "https://localhost/private" });
    await expect(catalog.install(pin)).rejects.toThrow("approved HTTPS");
    const second = await fixture();
    second.fetcher.mockImplementation(async (url) =>
      String(url) === ACP_REGISTRY_URL
        ? new Response(JSON.stringify(second.index))
        : new Response(null, { status: 302, headers: { location: "http://127.0.0.1/private" } }),
    );
    await expect(second.catalog.install(pin)).rejects.toThrow("approved HTTPS");
  });
  it("rejects installation identity traversal before networking", async () => {
    const { catalog, fetcher } = await fixture();
    expect(() => catalog.install({ ...pin, agentId: "../../escape" })).toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("coalesces concurrent installs and verifies duplicates", async () => {
    const { catalog } = await fixture();
    const first = catalog.install(pin),
      second = catalog.install(pin);
    expect(first).toBe(second);
    await first;
    await expect(catalog.install(pin)).resolves.toMatchObject(pin);
  });
  it("rejects installed file and parent directory symlinks", async () => {
    const { catalog, root } = await fixture();
    await catalog.install(pin);
    const command = await catalog.resolveInstalled(pin);
    await fs.rename(command.command, path.join(root, "outside"));
    await fs.symlink(path.join(root, "outside"), command.command);
    await expect(catalog.resolveInstalled(pin)).rejects.toThrow("symlink");
  });
  it("keeps the installed pin immutable when a publisher changes its checksum", async () => {
    const { catalog, index, fetcher } = await fixture();
    await catalog.install(pin);
    const replacement = Buffer.from("replaced binary");
    index.agents[0]!.distribution.binary["darwin-aarch64"]!.sha256 = checksum(replacement);
    fetcher.mockImplementation(async (url) =>
      String(url) === ACP_REGISTRY_URL
        ? new Response(JSON.stringify(index))
        : new Response(replacement),
    );
    await expect(catalog.install(pin)).rejects.toThrow("different archive checksum");
    expect(await fs.readFile((await catalog.resolveInstalled(pin)).command, "utf8")).toContain(
      "printf hello",
    );
  });
  it("skips malformed entries and caches discovery metadata", async () => {
    const { catalog, index, fetcher } = await fixture();
    fetcher.mockResolvedValue(
      new Response(JSON.stringify({ agents: [{ id: "invalid" }, ...index.agents] })),
    );
    expect(await catalog.search()).toHaveLength(1);
    expect(await catalog.search()).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("rejects injected unverified files at launch", async () => {
    const { catalog } = await fixture();
    await catalog.install(pin);
    const command = await catalog.resolveInstalled(pin);
    await fs.writeFile(path.join(path.dirname(command.command), "injected.js"), "unexpected");
    await expect(catalog.resolveInstalled(pin)).rejects.toThrow("unverified file");
  });
  it("bounds advertised downloads before consuming the response", async () => {
    const { catalog, fetcher, index } = await fixture();
    fetcher.mockImplementation(async (url) =>
      String(url) === ACP_REGISTRY_URL
        ? new Response(JSON.stringify(index))
        : new Response("payload", { headers: { "content-length": "1000000000" } }),
    );
    await expect(catalog.install(pin)).rejects.toThrow("size limit");
  });
  it("installs verified tar.gz archives without running extraction commands", async () => {
    const { catalog } = await fixture({
      bytes: gzipSync(tarEntry("agent")),
      archive: "https://github.com/example/agent/releases/download/v1.2.3/agent.tar.gz",
    });
    await catalog.install(pin);
    expect(await fs.readFile((await catalog.resolveInstalled(pin)).command, "utf8")).toBe("binary");
  });
});
function zipEntry(name: string, mode = 0o100755, content = Buffer.from("binary")): Buffer {
  const filename = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt32LE(content.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(filename.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(0x0314, 4);
  central.writeUInt32LE(content.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(filename.length, 28);
  central.writeUInt32LE((mode * 65536) >>> 0, 38);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + filename.length, 12);
  end.writeUInt32LE(local.length + filename.length + content.length, 16);
  return Buffer.concat([local, filename, content, central, filename, end]);
}
describe("registry archive safety", () => {
  it("extracts regular zip entries and rejects zip symlinks and traversal", () => {
    expect(
      extractAcpRegistryArchive(zipEntry("agent"), "https://github.com/a.zip", "agent")
        .get("agent")
        ?.toString(),
    ).toBe("binary");
    expect(() =>
      extractAcpRegistryArchive(zipEntry("agent", 0o120755), "https://github.com/a.zip", "agent"),
    ).toThrow("links");
    expect(() =>
      extractAcpRegistryArchive(zipEntry("../agent"), "https://github.com/a.zip", "agent"),
    ).toThrow("Unsafe");
  });
  it("rejects deep paths and oversized zip claims before decompression", () => {
    expect(() => safeAcpRegistryPath("a/".repeat(65) + "agent")).toThrow("Unsafe");
    const zip = zipEntry("agent");
    const central = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    zip.writeUInt32LE(0xffffffff, central + 24);
    expect(() => extractAcpRegistryArchive(zip, "https://github.com/a.zip", "agent")).toThrow(
      "oversized",
    );
  });
  it.each(["../escape", "/absolute", "a/../../b", "a\\b", "C:/outside", "a//b", "a/./b", "a\0b"])(
    "rejects unsafe path %s",
    (name) => expect(() => safeAcpRegistryPath(name)).toThrow(),
  );
  it.each(["1", "2", "3", "4", "6"])("rejects tar link or special entry type %s", (type) =>
    expect(() =>
      extractAcpRegistryArchive(
        gzipSync(tarEntry("agent", type)),
        "https://github.com/a.tgz",
        "agent",
      ),
    ).toThrow("links or special"),
  );
  it("rejects tar traversal and corrupt headers", () => {
    expect(() =>
      extractAcpRegistryArchive(
        gzipSync(tarEntry("../agent")),
        "https://github.com/a.tgz",
        "agent",
      ),
    ).toThrow("Unsafe");
    const tar = tarEntry("agent");
    tar[0] = 42;
    expect(() =>
      extractAcpRegistryArchive(gzipSync(tar), "https://github.com/a.tgz", "agent"),
    ).toThrow("checksum");
  });
});
