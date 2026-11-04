import { describe, expect, it } from "vite-plus/test";
import { Schema } from "effect";

import { AGENT_CONTROL_PROJECT_COPY_MCP_TOOLS } from "./agentControlProjectCopy.ts";
import { AGENT_CONTROL_MCP_TOOL_NAMES } from "./agentControlMcp.ts";
import { ExecutionEnvironmentCapabilities } from "./environment.ts";
import {
  FilesystemSearchDirectoriesInput,
  GitBranchName,
  GitObjectId,
  GitRemoteName,
  PROJECT_COPY_DIRECT_CHUNK_BASE64_MAX_CHARS,
  PROJECT_COPY_DIRECT_CHUNK_BYTES,
  ProjectCopyDestinationPath,
  ProjectCopyDirectoryName,
  ProjectCopyError,
  ProjectCopyRelativePath,
  ProjectCopyRelativeRoot,
  ProjectCopyRemoteUrl,
  ProjectDestinationPreview,
  ProjectExportReadChunkInput,
  ProjectExportStartInput,
  ProjectImportId,
  ProjectImportSnapshot,
  ProjectImportStartInput,
  ProjectTransferAppendInput,
  ProjectTransferBeginInput,
  ProjectTransferId,
} from "./projectCopy.ts";
import { WsProjectCopyRpcGroup } from "./projectCopyRpc.ts";
import { PROJECT_COPY_WS_METHODS } from "./projectCopyMethods.ts";
import { WsRpcGroup } from "./rpc.ts";

const importId = "0b8f4c2e-6a1d-4f3b-9c7e-2d5a8b1c4e6f";
const transferId = "5e9a2b7c-1d3f-4a6e-8b2c-7f1e3d5a9c0b";
const oid = "a".repeat(40);

const importStartInput = {
  importId,
  projectId: "4f1c2d3e-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
  title: "ryco",
  destinationPath: "/Users/me/Code/ryco",
  source: { kind: "clone", remoteUrl: "git@github.com:example/ryco.git", remoteName: "origin" },
  remotes: [{ name: "upstream", url: "https://github.com/upstream/ryco.git" }],
  commits: { transferId },
  checkout: { branch: "feature/copy", headOid: oid },
  changes: {
    transferId: "9c0b5e9a-2b7c-4d3f-8a6e-1b2c7f1e3d5a",
    baseOid: oid,
    ignoredPaths: [".env"],
  },
  relativeRootInRepository: "",
  recurseSubmodules: false,
  usesLfs: false,
  settings: {
    scripts: [
      {
        id: "setup",
        name: "Setup",
        command: "bun install",
        icon: "configure",
        runOnWorktreeCreate: true,
      },
    ],
    customSystemPrompt: null,
    preferredRemoteName: "origin",
    projectMetadataDir: ".ryco",
    overrides: {
      defaultThreadEnvMode: "worktree",
      worktreeBranchPrefix: "me",
      runSetupScript: false,
    },
  },
  avatarTransferId: null,
  setup: { command: "bun install", saveAsScript: false },
  followUpThread: {
    title: "Finish setup",
    prompt: "Install the toolchain and run the tests.",
    runtimeMode: "approval-required",
    envMode: "local",
    modelSelection: { instanceId: "codex", model: "gpt-5.6" },
  },
  origin: { kind: "user", sourceLabel: "MacBook", proposalId: null },
};

const decodeImportStart = Schema.decodeUnknownSync(ProjectImportStartInput);

describe("project copy ids and RPC names", () => {
  it("accepts only lowercase UUIDv4 ids, and UUIDv5 import ids Agent Control derives", () => {
    const decode = Schema.decodeUnknownSync(ProjectImportId);
    expect(decode(importId)).toBe(importId);
    const derived = "0b8f4c2e-6a1d-5f3b-9c7e-2d5a8b1c4e6f";
    expect(decode(derived)).toBe(derived);
    expect(() => Schema.decodeUnknownSync(ProjectTransferId)(derived)).toThrow();
    for (const bad of [
      importId.toUpperCase(),
      "0b8f4c2e-6a1d-1f3b-9c7e-2d5a8b1c4e6f",
      "../0b8f4c2e-6a1d-4f3b-9c7e-2d5a8b1c4e6f",
      ` ${importId}`,
      "import-1",
    ]) {
      expect(() => decode(bad)).toThrow();
    }
  });

  it("registers every project copy method in the RPC group", () => {
    for (const method of [
      PROJECT_COPY_WS_METHODS.pathHints,
      PROJECT_COPY_WS_METHODS.searchDirectories,
      PROJECT_COPY_WS_METHODS.previewDestination,
      PROJECT_COPY_WS_METHODS.checkRemoteAccess,
      PROJECT_COPY_WS_METHODS.exportInspect,
      PROJECT_COPY_WS_METHODS.exportStart,
      PROJECT_COPY_WS_METHODS.exportReadChunk,
      PROJECT_COPY_WS_METHODS.exportDispose,
      PROJECT_COPY_WS_METHODS.transferBegin,
      PROJECT_COPY_WS_METHODS.transferAppend,
      PROJECT_COPY_WS_METHODS.transferCommit,
      PROJECT_COPY_WS_METHODS.transferAbort,
      PROJECT_COPY_WS_METHODS.importStart,
      PROJECT_COPY_WS_METHODS.subscribeImport,
      PROJECT_COPY_WS_METHODS.cancelImport,
      PROJECT_COPY_WS_METHODS.listImports,
      PROJECT_COPY_WS_METHODS.discardImport,
    ]) {
      expect(WsProjectCopyRpcGroup.requests.has(method)).toBe(true);
      // Their schemas load with the first copy, never with the app group.
      expect(WsRpcGroup.requests.has(method)).toBe(false);
    }
    expect(PROJECT_COPY_WS_METHODS.subscribeImport).toBe("projects.subscribeImport");
    expect(PROJECT_COPY_WS_METHODS.searchDirectories).toBe("filesystem.searchDirectories");
  });

  it("keeps the project copy tools out of the shared MCP catalog", () => {
    expect(Object.values(AGENT_CONTROL_PROJECT_COPY_MCP_TOOLS).toSorted()).toEqual([
      "ryco_list_nodes",
      "ryco_propose_project_copy",
      "ryco_propose_project_import",
      "ryco_suggest_project_destination",
    ]);
    for (const name of Object.values(AGENT_CONTROL_PROJECT_COPY_MCP_TOOLS)) {
      expect(AGENT_CONTROL_MCP_TOOL_NAMES).not.toContain(name);
    }
  });

  it("announces project copy with an optional capability flag", () => {
    const decode = Schema.decodeUnknownSync(ExecutionEnvironmentCapabilities);
    expect(decode({ repositoryIdentity: true }).projectCopy).toBeUndefined();
    expect(decode({ repositoryIdentity: true, projectCopy: true }).projectCopy).toBe(true);
  });
});

describe("ProjectImportStartInput", () => {
  it("round-trips a full import through decode and encode", () => {
    const decoded = decodeImportStart(importStartInput);
    expect(decoded.source.kind).toBe("clone");
    const encoded = Schema.encodeUnknownSync(ProjectImportStartInput)(decoded);
    expect(decodeImportStart(encoded)).toEqual(decoded);
  });

  it("decodes the bundle and link sources and rejects branch fields on them", () => {
    expect(
      decodeImportStart({
        ...importStartInput,
        source: { kind: "repository-bundle", transferId },
        commits: null,
      }).source.kind,
    ).toBe("repository-bundle");
    expect(
      decodeImportStart({
        ...importStartInput,
        source: { kind: "existing-checkout", expectedCanonicalKey: "github.com/example/ryco" },
        commits: null,
        changes: null,
      }).source.kind,
    ).toBe("existing-checkout");
    expect(() =>
      decodeImportStart({
        ...importStartInput,
        source: { kind: "clone", remoteUrl: "https://github.com/example/ryco.git", branch: "x" },
      }),
    ).toThrow();
  });

  it("refuses project ids the avatar store cannot name a file after", () => {
    for (const projectId of ["../../x", "a/b", "a b", "x".repeat(129)]) {
      expect(() => decodeImportStart({ ...importStartInput, projectId })).toThrow();
    }
  });

  it("refuses relative roots that leave the repository", () => {
    expect(
      decodeImportStart({ ...importStartInput, relativeRootInRepository: "packages/web" })
        .relativeRootInRepository,
    ).toBe("packages/web");
    for (const relativeRootInRepository of [
      "../outside",
      "packages/../../outside",
      "/abs",
      "~/home",
      "C:/x",
      "packages\\web",
      "packages//web",
      "packages/web/",
      ".git/hooks",
      "a/.GIT",
      "./web",
    ]) {
      expect(() => decodeImportStart({ ...importStartInput, relativeRootInRepository })).toThrow();
    }
  });

  it("requires an absolute destination and full object ids", () => {
    for (const destinationPath of ["relative/dir", "~/Code/ryco", "C:foo"]) {
      expect(() => decodeImportStart({ ...importStartInput, destinationPath })).toThrow();
    }
    expect(
      decodeImportStart({ ...importStartInput, destinationPath: "C:\\Users\\me\\Code\\ryco" })
        .destinationPath,
    ).toBe("C:\\Users\\me\\Code\\ryco");
    expect(() =>
      decodeImportStart({ ...importStartInput, checkout: { branch: null, headOid: "abc123" } }),
    ).toThrow();
  });

  it("rejects keys it does not declare, at every level", () => {
    expect(() => decodeImportStart({ ...importStartInput, runSetupScript: true })).toThrow();
    expect(() =>
      decodeImportStart({
        ...importStartInput,
        setup: { command: "bun install", saveAsScript: false, cwd: "/" },
      }),
    ).toThrow();
    expect(() =>
      decodeImportStart({ ...importStartInput, commits: { transferId, branch: "main" } }),
    ).toThrow();
  });

  it("bounds the opted-in ignored files the changes carry", () => {
    const changes = importStartInput.changes;
    for (const ignoredPaths of [
      ["../.env"],
      [".git/config"],
      Array.from({ length: 33 }, (_, i) => `.env.${i}`),
    ]) {
      expect(() =>
        decodeImportStart({ ...importStartInput, changes: { ...changes, ignoredPaths } }),
      ).toThrow();
    }
    const { ignoredPaths: _omitted, ...withoutIgnoredPaths } = changes;
    expect(() =>
      decodeImportStart({ ...importStartInput, changes: withoutIgnoredPaths }),
    ).toThrow();
  });

  it("carries only registry overrides, each bounded by its setting's schema", () => {
    const settings = importStartInput.settings;
    expect(
      decodeImportStart({ ...importStartInput, settings: { ...settings, overrides: {} } }),
    ).toBeTruthy();
    for (const overrides of [
      // Node-local preferences a copy leaves behind.
      { initialModelSelection: { instanceId: "codex", model: "gpt-5.6" } },
      { worktreeRoot: "/Users/me/worktrees" },
      { defaultThreadEnvMode: "elsewhere" },
      { runSetupScript: "yes" },
      { worktreeBranchPrefix: "x".repeat(129) },
    ]) {
      expect(() =>
        decodeImportStart({ ...importStartInput, settings: { ...settings, overrides } }),
      ).toThrow();
    }
    const { overrides: _omitted, ...withoutOverrides } = settings;
    expect(() => decodeImportStart({ ...importStartInput, settings: withoutOverrides })).toThrow();
  });

  it("bounds the setup command", () => {
    expect(() =>
      decodeImportStart({
        ...importStartInput,
        setup: { command: "x".repeat(4_001), saveAsScript: false },
      }),
    ).toThrow();
  });
});

describe("input hygiene", () => {
  it("never accepts a remote URL with a password", () => {
    const decode = Schema.decodeUnknownSync(ProjectCopyRemoteUrl);
    for (const url of [
      "https://github.com/example/ryco.git",
      "https://token@github.com/example/ryco.git",
      "ssh://git@github.com:22/example/ryco.git",
      "git@github.com:example/ryco.git",
      "http://intranet.local/repo.git",
    ]) {
      expect(decode(url)).toBe(url);
    }
    for (const url of [
      "https://user:secret@github.com/example/ryco.git",
      "https://:ghp_token@github.com/example/ryco.git",
      "ssh://git:secret@github.com/example/ryco.git",
      "user:secret@github.com:example/ryco.git",
      // git hands these to curl, which skips the extra slashes and sends the password.
      "https:///deploy:ghp_secret@github.com/example/ryco.git",
      "http:///user:secret@intranet.local/repo.git",
      "ssh:///git:secret@github.com/example/ryco.git",
      // WHATWG URL (the server's clone check) reads user info after any slashes or backslashes.
      "https:/user:secret@github.com/example/ryco.git",
      "https:\\\\user:secret@github.com/example/ryco.git",
      "--upload-pack=touch /tmp/x",
      "https://github.com/example/ryco.git\nurl=evil",
      `https://github.com/${"a".repeat(2_048)}`,
    ]) {
      expect(() => decode(url)).toThrow();
    }
  });

  it("accepts branch names git accepts and rejects the rest", () => {
    const decode = Schema.decodeUnknownSync(GitBranchName);
    for (const branch of ["main", "feature/copy-project", "release-1.2", "user/fix_42"]) {
      expect(decode(branch)).toBe(branch);
    }
    for (const branch of [
      "-delete",
      "/lead",
      "trail/",
      "a//b",
      "a..b",
      "a@{b",
      "@",
      "end.",
      ".hidden",
      "a/.hidden",
      "x.lock",
      "a.lock/b",
      "has space",
      "tilde~1",
      "caret^",
      "colon:x",
      "q?",
      "star*",
      "bracket[",
      "back\\slash",
      "",
      // A line separator must not hide what follows it from the checks.
      "main ..x",
      "a ..b",
      "a /.hidden",
      "x /y.lock",
      "a //b",
      "end .",
      "trail /",
    ]) {
      expect(() => decode(branch), JSON.stringify(branch)).toThrow();
    }
  });

  it("refuses traversal and .git in relative paths, whatever characters precede it", () => {
    const decode = Schema.decodeUnknownSync(ProjectCopyRelativePath);
    const decodeRoot = Schema.decodeUnknownSync(ProjectCopyRelativeRoot);
    for (const relative of ["packages/app", "apps/web/.env.local", "a b/c"]) {
      expect(decode(relative)).toBe(relative);
    }
    expect(decodeRoot("")).toBe("");
    for (const relative of [
      "a/../etc",
      "a /../../etc",
      "pkg /../../../tmp/x",
      "a /.git",
      "a /.git/config",
      "a /./b",
      "a //b",
      "a /",
      "a\u007f/b",
    ]) {
      expect(() => decode(relative), JSON.stringify(relative)).toThrow();
      expect(() => decodeRoot(relative), JSON.stringify(relative)).toThrow();
    }
  });

  it("bounds remote names, object ids, folder names and destination paths", () => {
    expect(Schema.decodeUnknownSync(GitRemoteName)("upstream")).toBe("upstream");
    for (const name of ["-x", "a b", "a/b", "a..b", "x".repeat(65), ""]) {
      expect(() => Schema.decodeUnknownSync(GitRemoteName)(name)).toThrow();
    }
    expect(Schema.decodeUnknownSync(GitObjectId)("b".repeat(64))).toBe("b".repeat(64));
    for (const value of ["b".repeat(39), "B".repeat(40), "b".repeat(50)]) {
      expect(() => Schema.decodeUnknownSync(GitObjectId)(value)).toThrow();
    }
    expect(Schema.decodeUnknownSync(ProjectCopyDirectoryName)("my-app.v2")).toBe("my-app.v2");
    for (const name of ["..", ".env", "a/b", "-x", ""]) {
      expect(() => Schema.decodeUnknownSync(ProjectCopyDirectoryName)(name)).toThrow();
    }
    const decodePath = Schema.decodeUnknownSync(ProjectCopyDestinationPath);
    for (const path of ["~", "~/Code/app", "/srv/app", "D:\\work\\app", "\\\\nas\\share\\app"]) {
      expect(decodePath(path)).toBe(path);
    }
    for (const path of ["~root/x", "Code/app", "C:app", ""]) {
      expect(() => decodePath(path)).toThrow();
    }
  });

  it("bounds export inputs: ignored paths, chunk reads, patch limits", () => {
    const decodeStart = Schema.decodeUnknownSync(ProjectExportStartInput);
    const start = {
      exportId: importId,
      projectId: "project-1",
      include: {
        commits: true,
        workingTreeChanges: true,
        ignoredPaths: [".env", "apps/web/.env.local"],
        wholeRepository: false,
        avatar: true,
      },
    };
    expect(decodeStart(start).include.ignoredPaths).toEqual([".env", "apps/web/.env.local"]);
    expect(() =>
      decodeStart({ ...start, include: { ...start.include, ignoredPaths: ["../.ssh/id_rsa"] } }),
    ).toThrow();
    expect(() =>
      decodeStart({
        ...start,
        include: {
          ...start.include,
          ignoredPaths: Array.from({ length: 33 }, (_, index) => `.env.${index}`),
        },
      }),
    ).toThrow();
    expect(() => decodeStart({ ...start, patchLimitBytes: 0 })).toThrow();
    const decodeRead = Schema.decodeUnknownSync(ProjectExportReadChunkInput);
    const read = { exportId: importId, artifactId: "commits-1", offset: 0, length: 1 };
    expect(decodeRead({ ...read, length: PROJECT_COPY_DIRECT_CHUNK_BYTES }).length).toBe(
      PROJECT_COPY_DIRECT_CHUNK_BYTES,
    );
    expect(() => decodeRead({ ...read, length: PROJECT_COPY_DIRECT_CHUNK_BYTES + 1 })).toThrow();
    expect(() => decodeRead({ ...read, artifactId: "../etc/passwd" })).toThrow();
    expect(Schema.decodeUnknownSync(ProjectCopyRelativePath)(".env")).toBe(".env");
  });

  it("bounds transfers: digests, sizes and base64 chunks", () => {
    const decodeBegin = Schema.decodeUnknownSync(ProjectTransferBeginInput);
    const begin = {
      transferId,
      purpose: "commits-bundle",
      byteLength: 1_024,
      sha256: "c".repeat(64),
    };
    expect(decodeBegin(begin).purpose).toBe("commits-bundle");
    expect(() => decodeBegin({ ...begin, purpose: "anything" })).toThrow();
    expect(() => decodeBegin({ ...begin, sha256: "C".repeat(64) })).toThrow();
    expect(() => decodeBegin({ ...begin, byteLength: 256 * 1024 * 1024 + 1 })).toThrow();
    const decodeAppend = Schema.decodeUnknownSync(ProjectTransferAppendInput);
    expect(decodeAppend({ transferId, offset: 0, dataBase64: "AAEC" }).dataBase64).toBe("AAEC");
    expect(() => decodeAppend({ transferId, offset: 0, dataBase64: "" })).toThrow();
    expect(() => decodeAppend({ transferId, offset: 0, dataBase64: "not base64!" })).toThrow();
    expect(() =>
      decodeAppend({
        transferId,
        offset: 0,
        dataBase64: "A".repeat(PROJECT_COPY_DIRECT_CHUNK_BASE64_MAX_CHARS + 4),
      }),
    ).toThrow();
  });

  it("bounds folder search", () => {
    const decode = Schema.decodeUnknownSync(FilesystemSearchDirectoriesInput);
    expect(decode({ query: "" }).query).toBe("");
    expect(() => decode({ query: "x".repeat(257) })).toThrow();
    expect(() => decode({ query: "a", limit: 101 })).toThrow();
    expect(() => decode({ query: "a", maxDepth: 7 })).toThrow();
    expect(() => decode({ query: "a", roots: ["relative"] })).toThrow();
    expect(() =>
      decode({ query: "a", roots: Array.from({ length: 9 }, (_, index) => `/r${index}`) }),
    ).toThrow();
  });
});

describe("results", () => {
  it("decodes destination previews including retired checkouts", () => {
    const preview = Schema.decodeUnknownSync(ProjectDestinationPreview)({
      resolvedPath: "/Users/me/Code/old",
      state: "retired-checkout",
      existingProjectId: null,
      existingRepositoryCanonicalKey: null,
      suggestedPath: "/Users/me/Code/old-2",
      detail: "A project used to live here.",
    });
    expect(preview.state).toBe("retired-checkout");
  });

  it("round-trips an import snapshot with every step", () => {
    const steps = [
      "preflight",
      "clone",
      "remotes",
      "commits",
      "checkout",
      "changes",
      "submodules",
      "lfs",
      "register",
      "settings",
      "avatar",
      "setup",
      "follow-up",
    ].map((id) => ({ id, status: "pending", progressPercent: null, detail: null }));
    const wire = {
      importId,
      projectId: "project-1",
      title: "ryco",
      destinationPath: "/Users/me/Code/ryco",
      status: "failed",
      steps: [{ ...steps[0], status: "done" }, { ...steps[1], progressPercent: 42 }, ...steps],
      outputTail: "Receiving objects: 42%",
      error: { step: "clone", code: "remote-unreachable", message: "host-key-unknown github.com" },
      warnings: ["Git LFS is not installed"],
      preflight: { remoteReachable: false, alternateRemoteUrl: null },
      leftoverPath: "/Users/me/Code/.ryco.ryco-import-x",
      followUpThreadId: null,
      origin: { kind: "agent-control", sourceLabel: "MacBook", proposalId: "proposal-1" },
      createdAt: "2026-10-22T00:00:00.000Z",
      updatedAt: "2026-10-22T00:01:00.000Z",
    };
    const decoded = Schema.decodeUnknownSync(ProjectImportSnapshot)(wire);
    expect(decoded.steps).toHaveLength(15);
    expect(Schema.encodeUnknownSync(ProjectImportSnapshot)(decoded)).toEqual(wire);
    expect(() =>
      Schema.decodeUnknownSync(ProjectImportSnapshot)({
        ...wire,
        steps: [{ ...steps[0], progressPercent: 101 }],
      }),
    ).toThrow();
  });

  it("carries a stable error code and the bytes a transfer holds", () => {
    const error = new ProjectCopyError({
      code: "conflict",
      message: "The offset is past the bytes received.",
      receivedBytes: 163_840,
    });
    const encoded = Schema.encodeUnknownSync(ProjectCopyError)(error);
    const decoded = Schema.decodeUnknownSync(ProjectCopyError)(encoded);
    expect(decoded.code).toBe("conflict");
    expect(decoded.receivedBytes).toBe(163_840);
    expect(() =>
      Schema.decodeUnknownSync(ProjectCopyError)({ ...encoded, code: "exploded" }),
    ).toThrow();
  });
});
