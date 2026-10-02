import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { EnvironmentId, ProjectId } from "@ryco/contracts";
import {
  WORKSPACE_METADATA_SNAPSHOT_SCHEMA_VERSION,
  workspaceMetadataPayloadBytes,
  type WorkspaceMetadataCacheRecord,
} from "@ryco/client-runtime/state/workspace";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { createDesktopWorkspaceMetadataCache } from "./desktopWorkspaceCache.ts";

const temporaryDirectories: string[] = [];

function temporaryFile(): string {
  const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "ryco-desktop-workspace-cache-"));
  temporaryDirectories.push(directory);
  return Path.join(directory, "desktop-workspace-client", "metadata-v1.json");
}

function record(environment: string, capturedAt = 1): WorkspaceMetadataCacheRecord {
  const environmentId = EnvironmentId.make(environment);
  const snapshot = {
    schemaVersion: WORKSPACE_METADATA_SNAPSHOT_SCHEMA_VERSION,
    environmentId,
    capturedAt,
    projects: [
      {
        environmentId,
        id: ProjectId.make("shared"),
        name: environment,
        cwd: `/${environment}`,
        repositoryIdentity: null,
        createdAt: null,
        updatedAt: null,
      },
    ],
    worktrees: [],
    threads: [],
  };
  return {
    namespace: { hubOrigin: "https://hub.example", accountId: "account-a", environmentId },
    snapshot,
    payloadBytes: workspaceMetadataPayloadBytes(snapshot),
    updatedAt: capturedAt,
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    FS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("Desktop workspace metadata cache", () => {
  it("serializes reads with pending writes and persists purges across restarts", async () => {
    const file = temporaryFile();
    const cache = createDesktopWorkspaceMetadataCache(file);
    const item = record("local");
    const writing = cache.replace(item);
    const reading = cache.load(item.namespace);
    const purging = cache.purgeEnvironment(item.namespace);
    const after = cache.load(item.namespace);
    await writing;
    expect(await reading).toEqual(item);
    await purging;
    expect(await after).toBeNull();
    expect(await createDesktopWorkspaceMetadataCache(file).load(item.namespace)).toBeNull();
  });

  it("keeps colliding resource ids in exact environment namespaces", async () => {
    const cache = createDesktopWorkspaceMetadataCache(temporaryFile());
    await cache.replace(record("local", 10));
    await cache.replace(record("remote", 20));

    expect(
      await cache.list({ hubOrigin: "https://hub.example/", accountId: "account-a" }),
    ).toHaveLength(2);
    expect(
      (
        await cache.load({
          hubOrigin: "https://hub.example",
          accountId: "account-a",
          environmentId: EnvironmentId.make("local"),
        })
      )?.snapshot.projects[0]?.cwd,
    ).toBe("/local");
  });

  it("rejects non-metadata payloads and purges only the requested account", async () => {
    const filePath = temporaryFile();
    const cache = createDesktopWorkspaceMetadataCache(filePath);
    await cache.replace(record("local"));
    await expect(cache.replace({ ...record("remote"), payloadBytes: 1 })).rejects.toThrow(
      "Invalid Desktop workspace metadata record",
    );

    const serialized = FS.readFileSync(filePath, "utf8");
    expect(serialized).not.toContain("token");
    expect(serialized).not.toContain("message");
    await cache.purgeAccount({ hubOrigin: "https://hub.example", accountId: "account-a" });
    expect(await cache.list({ hubOrigin: "https://hub.example", accountId: "account-a" })).toEqual(
      [],
    );
  });

  it("uses a client-only path separate from backend state", async () => {
    const root = FS.mkdtempSync(Path.join(OS.tmpdir(), "ryco-desktop-workspace-root-"));
    temporaryDirectories.push(root);
    const clientPath = Path.join(root, "desktop-workspace-client", "metadata-v1.json");
    const backendPath = Path.join(root, "settings.json");
    FS.writeFileSync(backendPath, '{"node":"owned"}\n');
    await createDesktopWorkspaceMetadataCache(clientPath).replace(record("local"));

    expect(FS.readFileSync(backendPath, "utf8")).toBe('{"node":"owned"}\n');
    expect(FS.existsSync(clientPath)).toBe(true);
  });
});
