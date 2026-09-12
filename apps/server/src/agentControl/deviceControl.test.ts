import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { Effect } from "effect";

import {
  assertSafeAgentControlDeviceUrl,
  resolveAgentControlDeviceArtifact,
} from "./deviceControl.ts";

const temporary: string[] = [];

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true })));
});

const canonicalPolicy = {
  assertExistingPath: ({ path: candidate }: { readonly path: string }) =>
    Effect.tryPromise(() => realpath(candidate)),
} as never;

describe("Agent Control device input policy", () => {
  it("accepts bounded network and deep links while rejecting credentials and unsafe schemes", () => {
    expect(() => assertSafeAgentControlDeviceUrl("https://example.test/path?q=1")).not.toThrow();
    expect(() => assertSafeAgentControlDeviceUrl("ryco-demo://screen/settings")).not.toThrow();
    expect(() => assertSafeAgentControlDeviceUrl("https://user:secret@example.test/")).toThrow(
      /credentials/,
    );
    for (const value of ["file:///tmp/private", "javascript:alert(1)", "data:text/plain,x"]) {
      expect(() => assertSafeAgentControlDeviceUrl(value)).toThrow(/not permitted/);
    }
  });

  it("canonicalizes a workspace artifact and rejects traversal, absolute paths, and symlink escapes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ryco-device-artifact-"));
    const outside = await mkdtemp(path.join(tmpdir(), "ryco-device-outside-"));
    temporary.push(root, outside);
    await mkdir(path.join(root, "build", "Inside.app"), { recursive: true });
    await mkdir(path.join(outside, "Outside.app"), { recursive: true });
    await symlink(path.join(outside, "Outside.app"), path.join(root, "Escaped.app"));

    await expect(
      Effect.runPromise(
        resolveAgentControlDeviceArtifact({
          workspaceRoot: root,
          artifactPath: "build/Inside.app",
          workspaceAccess: canonicalPolicy,
        }),
      ),
    ).resolves.toBe(await realpath(path.join(root, "build", "Inside.app")));

    await writeFile(path.join(root, "build", "Inside.apk"), "apk fixture");
    await writeFile(path.join(outside, "Outside.apk"), "apk fixture");
    await symlink(path.join(outside, "Outside.apk"), path.join(root, "Escaped.apk"));
    await expect(
      Effect.runPromise(
        resolveAgentControlDeviceArtifact({
          workspaceRoot: root,
          artifactPath: "build/Inside.apk",
          workspaceAccess: canonicalPolicy,
        }),
      ),
    ).resolves.toBe(await realpath(path.join(root, "build", "Inside.apk")));

    for (const artifactPath of [
      "../Outside.apk",
      path.join(outside, "Outside.apk"),
      "Escaped.apk",
      "../Outside.app",
      path.join(outside, "Outside.app"),
      "Escaped.app",
    ]) {
      await expect(
        Effect.runPromise(
          resolveAgentControlDeviceArtifact({
            workspaceRoot: root,
            artifactPath,
            workspaceAccess: canonicalPolicy,
          }),
        ),
      ).rejects.toThrow();
    }
  });
});
