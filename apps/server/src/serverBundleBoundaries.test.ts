/**
 * Guards the lazy-import boundaries that keep optional feature code off the
 * server's boot path. Node evaluates an ES module's whole static import graph
 * before it runs, so a single static import can pull a heavy package back into
 * every boot; the bundler keeps `import()` boundaries as separate chunks.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vite-plus/test";

import { isBundledPatchedPackageImport, patchAddedExports } from "../scripts/patchedPackages.ts";

const serverRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = path.resolve(serverRoot, "../..");

interface WorkspacePackage {
  readonly dir: string;
  readonly exports: Readonly<Record<string, unknown>>;
}

const workspacePackages = new Map<string, WorkspacePackage>();
for (const dir of [
  "client-runtime",
  "contracts",
  "effect-acp",
  "effect-codex-app-server",
  "shared",
  "ssh",
  "tailscale",
]) {
  const packageDir = path.join(repoRoot, "packages", dir);
  const manifest = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8")) as {
    readonly name: string;
    readonly exports?: Record<string, unknown>;
  };
  workspacePackages.set(manifest.name, { dir: packageDir, exports: manifest.exports ?? {} });
}

// Static `import`/`export ... from` statements and side-effect imports. Type-only
// imports are erased, and `import()` expressions are lazy chunk boundaries.
const STATIC_IMPORT =
  /(?:^|\n)\s*(?:import|export)\s+(?!type\s)([^;]*?)\s+from\s+["']([^"']+)["']|(?:^|\n)\s*import\s+["']([^"']+)["']/g;

function resolveWorkspaceExport(specifier: string): string | null {
  for (const [name, workspacePackage] of workspacePackages) {
    if (specifier !== name && !specifier.startsWith(`${name}/`)) continue;
    const subpath = specifier === name ? "." : `./${specifier.slice(name.length + 1)}`;
    let target = workspacePackage.exports[subpath];
    while (typeof target === "object" && target !== null) {
      const conditions = target as Record<string, unknown>;
      target = conditions.import ?? conditions.default ?? conditions.types;
    }
    return typeof target === "string" ? path.resolve(workspacePackage.dir, target) : null;
  }
  return null;
}

function resolveRelative(specifier: string, importer: string): string | null {
  const base = path.resolve(path.dirname(importer), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

const DYNAMIC_IMPORT = /\bimport\(\s*["']([^"']+)["']\s*\)/g;

/**
 * The static import closure of `entry`: workspace files plus external
 * specifiers. With `dynamic`, `import("...")` edges are followed too: everything
 * the server can load.
 */
function staticGraph(entry: string, options?: { readonly dynamic?: boolean }) {
  const files = new Set<string>();
  const externals = new Set<string>();
  const pending = [path.resolve(serverRoot, entry)];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    if (!/\.(?:ts|tsx|js|mjs)$/u.test(file)) continue;
    const source = readFileSync(file, "utf8");
    const specifiers = [...source.matchAll(STATIC_IMPORT)].flatMap((match) => {
      const clause = match[1]?.trim();
      if (clause !== undefined && /^\{\s*(?:type\s+[\w$]+\s*,?\s*)+\}$/u.test(clause)) return [];
      return [(match[2] ?? match[3])!];
    });
    if (options?.dynamic) {
      for (const match of source.matchAll(DYNAMIC_IMPORT)) specifiers.push(match[1]!);
    }
    for (const specifier of specifiers) {
      const resolved = specifier.startsWith(".")
        ? resolveRelative(specifier, file)
        : resolveWorkspaceExport(specifier);
      if (resolved === null) {
        if (!specifier.startsWith(".")) externals.add(specifier);
        continue;
      }
      pending.push(resolved);
    }
  }
  const relativeFiles = [...files].map((file) => path.relative(repoRoot, file));
  return { files: relativeFiles, externals: [...externals] };
}

/** Provider SDK packages, each tens of megabytes of evaluated code (or a native binary). */
const PROVIDER_SDKS =
  /^(?:@anthropic-ai\/(?:claude-agent-sdk|sdk)|@github\/copilot-sdk|@opencode-ai\/sdk)(?:\/|$)/u;

describe("server boot import boundaries", () => {
  it("bundles every dependency it imports through an export only a repo patch adds", () => {
    // npm installs of the published `ryco-cli` get upstream packages: an
    // external import of a patch-added export fails at startup there.
    const patchAdded = patchAddedExports();
    expect(patchAdded.size).toBeGreaterThan(0);
    const graph = staticGraph("src/bin.ts", { dynamic: true });
    const unbundled = graph.externals.filter(
      (specifier) => patchAdded.has(specifier) && !isBundledPatchedPackageImport(specifier),
    );
    expect(unbundled).toEqual([]);
  });

  it("keeps the process entry free of the server graph", () => {
    const graph = staticGraph("src/bin.ts");
    expect(graph.files.toSorted()).toEqual([
      "apps/server/src/agentControl/stdioProxyProtocol.ts",
      "apps/server/src/bin.ts",
      "apps/server/src/compileCache.ts",
    ]);
    expect(graph.externals).toEqual(["node:module"]);
  });

  it("loads the Agent Control stdio proxy without the server graph", () => {
    const graph = staticGraph("src/agentControl/stdioProxy.ts");
    expect(graph.files.length).toBeLessThan(10);
    expect(graph.files.some((file) => file.startsWith("packages/"))).toBe(false);
  });

  it("keeps heavy optional packages off the serve path", () => {
    const graph = staticGraph("src/cliMain.ts");
    // Image processing loads on first use (`loadSharp`).
    expect(graph.externals).not.toContain("sharp");
    // Only the patch parser; the package root pulls in shiki and its grammars.
    expect(graph.externals).not.toContain("@pierre/diffs");
    // Provider SDKs load with their driver's adapter (chat forks read resume cursors from the
    // SDK-free cursor modules).
    expect(graph.externals.filter((specifier) => PROVIDER_SDKS.test(specifier))).toEqual([]);
    // The OpenCode 2 client loads with the 2.x facade.
    expect(graph.externals.filter((specifier) => specifier.startsWith("@opencode/"))).toEqual([]);
    // Protocol schemas load with the Codex/ACP features that use them. The error classes are
    // schema-free (chat forks classify Codex request failures with them).
    expect(
      graph.files.filter((file) => file.startsWith("packages/effect-codex-app-server/")),
    ).toEqual(["packages/effect-codex-app-server/src/errors.ts"]);
    expect(graph.files.filter((file) => file.startsWith("packages/effect-acp/"))).toEqual([]);
    // `ryco remote` client stores load with that command only.
    expect(
      graph.externals.filter((specifier) => /^(?:react|zustand)(?:\/|$)/u.test(specifier)),
    ).toEqual([]);
  });

  it("loads the pull request watch fingerprint with the GitHub client", () => {
    // Its query and decoder ride with GitHubCli, which loads on first GitHub use.
    const graph = staticGraph("src/cliMain.ts");
    expect(
      graph.files.filter((file) =>
        file.endsWith("/sourceControl/gitHubPullRequestWatchFingerprint.ts"),
      ),
    ).toEqual([]);
  });

  it("loads the pull request watch sweep after the server serves", () => {
    // Only the thin service layer is on the serve path; the sweep, its host-read adapters and
    // the shared decision rules load through import() once commands are admitted.
    const graph = staticGraph("src/cliMain.ts");
    expect(
      graph.files.filter((file) =>
        /(?:\/sourceControl\/(?:pullRequestWatchSweep|pullRequestWatchObservation)|\/persistence\/wakeStartDelivery|packages\/shared\/src\/pullRequestWatch)\.ts$/u.test(
          file,
        ),
      ),
    ).toEqual([]);
    expect(graph.files).toContain("apps/server/src/sourceControl/PullRequestWatchService.ts");
    expect(staticGraph("src/cliMain.ts", { dynamic: true }).files).toContain(
      "apps/server/src/sourceControl/pullRequestWatchSweep.ts",
    );
  });

  it("keeps optional feature stacks off the serve path", () => {
    const graph = staticGraph("src/cliMain.ts");
    const reached = (pattern: RegExp) => graph.files.filter((file) => pattern.test(file));
    // Native Computer use loads only when Desktop hands over a native bridge; the turn
    // lifecycle and the tool guidance the provider reactor reads stay eager.
    expect(reached(/^apps\/server\/src\/computer\//u).toSorted()).toEqual([
      "apps/server/src/computer/computerTurnLifecycle.ts",
      "apps/server/src/computer/computerVisibleUse.ts",
      "apps/server/src/computer/tools/computerGuidance.ts",
    ]);
    // The Hub connector, key custody and relay E2EE build after the router serves.
    expect(
      reached(
        /^apps\/server\/src\/hubConnector\/(?:HubConnector|HubConnectorLive|HubIdentityRuntime|NodeE2ee\w*)\.ts$/u,
      ),
    ).toEqual([]);
    expect(reached(/^packages\/shared\/src\/relayE2ee(?!Constants)/u)).toEqual([]);
    expect(graph.externals.filter((specifier) => specifier.startsWith("@noble/"))).toEqual([]);
    // The SSH device backend and its host protocol load only when a node configures an SSH
    // device host.
    expect(
      reached(/^apps\/server\/src\/device\/(?:SshDeviceBackend|deviceHostProtocol)\.ts$/u),
    ).toEqual([]);
    // Forge failure classification loads with the forge clients. Only the import-free HTTP
    // status and header helpers the eager Forgejo client reads are on the serve path.
    expect(
      reached(/^apps\/server\/src\/sourceControl\/forge(?:Failure|HttpRateLimit)\.ts$/u),
    ).toEqual(["apps/server/src/sourceControl/forgeHttpRateLimit.ts"]);
    // The forge rate-limit pause loads with the providers it guards. Only the import-free
    // refusal check the boot-path caches read is on the serve path.
    expect(
      reached(/^apps\/server\/src\/sourceControl\/forge(?:RateLimit|RequestPaused)\.ts$/u),
    ).toEqual(["apps/server/src/sourceControl/forgeRequestPaused.ts"]);
    // Source-control clients load with the provider that uses them (Forgejo answers
    // synchronous remote detection and stays eager).
    expect(
      reached(
        /^apps\/server\/src\/sourceControl\/(?:GitHubCli|GitLabCli|BitbucketApi|AzureDevOpsCli|gitHubPullRequests|gitLabMergeRequests|bitbucketPullRequests|azureDevOpsPullRequests)\.ts$/u,
      ),
    ).toEqual([]);
    // Database backups load once a migration is pending, their background pass runs or a
    // `ryco db` command runs (dbRun.ts); startup only needs databaseBackupPolicy.ts.
    expect(
      reached(/^apps\/server\/src\/(?:persistence\/databaseBackups|cliDb\/dbRun)\.ts$/u),
    ).toEqual([]);
    // Storage cleanup loads its checks and removal on first use: the status check and the
    // quarantined removal, and the cache folder (node_modules) check and background purge.
    expect(
      reached(/^apps\/server\/src\/storage\/(?:cacheFolders|quarantineRemoval)\.ts$/u),
    ).toEqual([]);
    // Merge proofs for checkout removal (squash-merged pull requests, the remote default
    // branch) load with the first checkout whose branch the project HEAD lacks.
    expect(reached(/^apps\/server\/src\/sourceControl\/checkoutMergeProver\.ts$/u)).toEqual([]);
    // OpenCode 2.x support (facade, mappings, event translation) loads once a server is detected
    // as 2.x.
    expect(reached(/^apps\/server\/src\/provider\/openCodeV2\w*\.ts$/u)).toEqual([]);
    // The OpenCode MCP config adapter loads with the first MCP settings or Agent Control call
    // that reaches OpenCode.
    expect(reached(/^apps\/server\/src\/mcp\/adapters\/OpenCodeMcpConfig\.ts$/u)).toEqual([]);
    // Provider sign-in flows load with the first sign-in call; boot carries only the facade.
    expect(reached(/^apps\/server\/src\/provider\/signIn\//u)).toEqual([
      "apps/server/src/provider/signIn/ProviderSignIn.ts",
    ]);
    // The heap snapshot writer loads with the first SIGUSR2, the event-loop stall history reader
    // with the first Diagnostics snapshot.
    expect(
      reached(/^apps\/server\/src\/observability\/(?:HeapSnapshot|EventLoopStallHistory)\.ts$/u),
    ).toEqual([]);
    // Recreating a recorded checkout (Restore, or a turn start that finds it missing) loads its
    // routine and Git's registration rule on first use.
    expect(
      reached(
        /^apps\/server\/src\/(?:workspace\/checkoutRecreation|vcs\/worktreeRegistrationReplacement)\.ts$/u,
      ),
    ).toEqual([]);
    // The OTEL variable resolver and the OTLP exporters load only when an export is configured,
    // and the `ryco trace summary` implementation only when that command runs.
    expect(
      reached(
        /^apps\/server\/src\/(?:observability\/(?:OtelEnvironmentResolver|OtlpExporters)|cliTrace\/(?:traceRun|traceSummary))\.ts$/u,
      ),
    ).toEqual([]);
    // The usage pipeline loads with the first usage summary, or shortly after boot on a node that
    // has downloaded rates before. Storage cleanup protects provider history paths eagerly.
    expect(reached(/^apps\/server\/src\/usage\//u).toSorted()).toEqual([
      "apps/server/src/usage/UsageServiceDeferred.ts",
      "apps/server/src/usage/UsageServiceTag.ts",
      "apps/server/src/usage/usageDay.ts",
      "apps/server/src/usage/usageProtectedPaths.ts",
    ]);
    // The ACP runtime loads with its drivers, the ACP Registry catalog with the first registry
    // search or install.
    expect(reached(/^apps\/server\/src\/provider\/acp\//u)).toEqual([]);
    // Agent device tool actions, evidence, waits, logs and the driving guide load with the first
    // device tool call, the tool catalogue with the first `tools/list`; Agent Control's
    // ryco_device and its consent index where devices exist.
    expect(
      reached(
        /^apps\/server\/src\/(?:device\/(?:deviceObservation|deviceUiSnapshot|deviceLogs)|providerTools\/deviceTool(?:Actions|Guidance|Definitions)|agentControl\/(?:Mcp\/deviceRoutineTools|deviceControlConsent))\.ts$/u,
      ),
    ).toEqual([]);
  });

  it("loads the repository clone runner with the first clone", () => {
    const graph = staticGraph("src/cliMain.ts");
    expect(graph.files).toContain(
      "apps/server/src/sourceControl/SourceControlRepositoryService.ts",
    );
    expect(graph.files).not.toContain("apps/server/src/sourceControl/gitCloneRun.ts");
  });

  it("loads the cross-repository involvement read on its first call", () => {
    // `sourceControl.listInvolvedChangeRequests` imports it with import(); a static import
    // anywhere on the serve path would put it in every boot.
    const graph = staticGraph("src/cliMain.ts");
    expect(
      graph.files.filter((file) =>
        /^apps\/server\/src\/sourceControl\/involvedChangeRequests\.ts$/u.test(file),
      ),
    ).toEqual([]);
    // It is reachable at all (the handler's import() points at the file this test guards).
    expect(staticGraph("src/cliMain.ts", { dynamic: true }).files).toContain(
      "apps/server/src/sourceControl/involvedChangeRequests.ts",
    );
  });

  it("keeps the direct GitHub API transport behind the GitHub client's import()", () => {
    const graph = staticGraph("src/cliMain.ts");
    expect(
      graph.files.filter((file) =>
        /^apps\/server\/src\/sourceControl\/gitHub(?:Api|ApiTestServer|Credentials)\.ts$/u.test(
          file,
        ),
      ),
    ).toEqual([]);
  });

  it("loads the thread git metadata sync with the first provider event that can use it", () => {
    const graph = staticGraph("src/cliMain.ts");
    // The reactor layer at boot is only an event filter and an import(); the sync, its rules,
    // the command classifier and the tool-command reader load with the first turn.
    expect(
      graph.files.filter((file) =>
        /^(?:apps\/server\/src\/orchestration\/threadGitMetadata(?:Runtime)?|packages\/shared\/src\/(?:vcsCommand|toolActivity))\.ts$/u.test(
          file,
        ),
      ),
    ).toEqual([]);
  });
});

/** Static imports of a built ES chunk (rolldown output keeps them at top level). */
const CHUNK_STATIC_IMPORT = /^(?:import|export)\s[^;]*?from\s*"([^"]+)";|^import\s*"([^"]+)";/gmu;

function builtStaticClosure(entry: string) {
  const chunks = new Set<string>();
  const externals = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const chunk = pending.pop()!;
    if (chunks.has(chunk)) continue;
    chunks.add(chunk);
    for (const match of readFileSync(chunk, "utf8").matchAll(CHUNK_STATIC_IMPORT)) {
      const specifier = (match[1] ?? match[2])!;
      if (specifier.startsWith(".")) pending.push(path.resolve(path.dirname(chunk), specifier));
      else externals.add(specifier);
    }
  }
  return { chunks: [...chunks], externals: [...externals] };
}

const builtEntry = path.join(serverRoot, "dist/bin.mjs");
// Only a bundle built from the current entry shim is meaningful here.
const hasCurrentBuild =
  existsSync(builtEntry) && readFileSync(builtEntry, "utf8").includes("enableCompileCache");
// CI's build job sets this after building the server: the built-bundle suites must run there
// instead of skipping silently.
const requireBuild = process.env.RYCO_REQUIRE_SERVER_BUILD === "1";

describe.runIf(requireBuild)("built server bundle presence", () => {
  it("finds a server bundle built from the current entry shim", () => {
    expect(hasCurrentBuild).toBe(true);
  });
});

describe.skipIf(!hasCurrentBuild)("built server bundle", () => {
  it("keeps sharp, the @pierre/diffs root, provider SDKs and the Codex schema out of the boot chunks", () => {
    const entryClosure = builtStaticClosure(builtEntry);
    expect(entryClosure.chunks).toEqual([builtEntry]);

    const cliChunk = readFileSync(builtEntry, "utf8").match(/import\("(\.\/cliMain[^"]+)"\)/u)?.[1];
    expect(cliChunk).toBeDefined();
    const serve = builtStaticClosure(path.resolve(serverRoot, "dist", cliChunk!));
    expect(serve.externals).not.toContain("sharp");
    expect(serve.externals).not.toContain("@pierre/diffs");
    expect(serve.externals.filter((specifier) => PROVIDER_SDKS.test(specifier))).toEqual([]);
    // Bundled: only its patch exposes the parser (see `scripts/patchedPackages.ts`).
    expect(serve.externals.filter((specifier) => specifier.startsWith("@pierre/diffs"))).toEqual(
      [],
    );
    for (const chunk of serve.chunks) {
      // A type name only the generated Codex protocol schema defines.
      expect(readFileSync(chunk, "utf8")).not.toContain("V2ListMcpServerStatusResponse");
    }
  });

  it("bundles effect and the platform packages instead of resolving them per file", () => {
    const cliChunk = readFileSync(builtEntry, "utf8").match(/import\("(\.\/cliMain[^"]+)"\)/u)?.[1];
    const serve = builtStaticClosure(path.resolve(serverRoot, "dist", cliChunk!));
    expect(
      serve.externals.filter((specifier) =>
        /^(?:effect|@effect\/[\w-]+|mime|ws|undici)(?:\/|$)/u.test(specifier),
      ),
    ).toEqual([]);
  });

  it("keeps the pull request watch fingerprint decoder out of the boot chunks", () => {
    const cliChunk = readFileSync(builtEntry, "utf8").match(/import\("(\.\/cliMain[^"]+)"\)/u)?.[1];
    const serve = builtStaticClosure(path.resolve(serverRoot, "dist", cliChunk!));
    for (const chunk of serve.chunks) {
      expect(readFileSync(chunk, "utf8")).not.toMatch(
        /^\/\/#region src\/sourceControl\/gitHubPullRequestWatchFingerprint\.ts$/mu,
      );
    }
  });

  it("keeps the boot chunks within budget", () => {
    const cliChunk = readFileSync(builtEntry, "utf8").match(/import\("(\.\/cliMain[^"]+)"\)/u)?.[1];
    const serve = builtStaticClosure(path.resolve(serverRoot, "dist", cliChunk!));
    const bytes = serve.chunks.reduce((total, chunk) => total + statSync(chunk).size, 0);
    // 6.6 MB with effect and the platform packages bundled in, and with Computer use,
    // the Hub connector and the source-control clients behind import(). Raise it only
    // for code that every boot needs. 6.91 MB in October 2026; the database owner lock,
    // event-loop stall monitor, WAL checkpoint worker and database maintenance that every
    // server starts add about 0.14 MB (their backup, doctor, trace, OTLP and heap-snapshot
    // code loads through import()).
    expect(bytes).toBeLessThan(7_100_000);
    for (const chunk of serve.chunks) {
      const source = readFileSync(chunk, "utf8");
      // Region markers rolldown leaves in the output name the modules each chunk holds.
      expect(source).not.toMatch(/^\/\/#region src\/computer\/CuaComputerBackend\.ts$/mu);
      expect(source).not.toMatch(/^\/\/#region src\/hubConnector\/HubIdentityRuntime\.ts$/mu);
      expect(source).not.toMatch(/^\/\/#region src\/sourceControl\/GitHubCli\.ts$/mu);
      // Loaded when the external Agent Control integration first starts.
      expect(source).not.toMatch(/^\/\/#region src\/agentControl\/ExternalMcp\/tools\.ts$/mu);
      expect(source).not.toMatch(/^\/\/#region src\/agentControl\/ExternalMcp\/listener\.ts$/mu);
      // Loaded with the first Ryco browser upload.
      expect(source).not.toMatch(/^\/\/#region src\/agentControl\/Mcp\/browserUploadTool\.ts$/mu);
      expect(source).not.toMatch(
        /^\/\/#region src\/agentControl\/Mcp\/browserUploadStaging\.ts$/mu,
      );
      // Loaded with the first SIGUSR2 and the first Diagnostics snapshot.
      expect(source).not.toMatch(/^\/\/#region src\/observability\/HeapSnapshot\.ts$/mu);
      expect(source).not.toMatch(/^\/\/#region src\/observability\/EventLoopStallHistory\.ts$/mu);
      // Loaded only when an OTLP export is configured (with Effect's exporters and protobuf
      // encoder), or when `ryco trace summary` runs.
      expect(source).not.toMatch(/^\/\/#region src\/observability\/OtlpExporters\.ts$/mu);
      expect(source).not.toMatch(/^\/\/#region .*\/effect\/dist\/observability\/Otlp\w+\.js$/mu);
      expect(source).not.toMatch(
        /^\/\/#region .*\/effect\/dist\/observability\/internal\/\w+\.js$/mu,
      );
      expect(source).not.toMatch(/^\/\/#region src\/cliTrace\/traceSummary\.ts$/mu);
      // Loaded with the first usage summary (UsageServiceDeferred.ts).
      expect(source).not.toMatch(/^\/\/#region src\/usage\/UsageService\.ts$/mu);
      // Loaded with the first ACP Registry search or install.
      expect(source).not.toMatch(/^\/\/#region src\/provider\/acp\/AcpRegistryCatalog\.ts$/mu);
      // Loaded with the first chunked PDF or image preview.
      expect(source).not.toMatch(/^\/\/#region src\/workspace\/previewFileChunk\.ts$/mu);
      // Loaded once an OpenCode server is detected as 2.x.
      expect(source).not.toMatch(/^\/\/#region .*@opencode\//mu);
      expect(source).not.toMatch(/^\/\/#region src\/provider\/openCodeV2\w*\.ts$/mu);
      // Loaded with the first provider sign-in call.
      expect(source).not.toMatch(
        /^\/\/#region src\/provider\/signIn\/(?:providerSignInRuntime|codexDeviceCodeSignIn|terminalSignIn|signInCommands|privateDirectory)\.ts$/mu,
      );
    }
  });
});

describe.skipIf(!hasCurrentBuild)("built server bundle pull request watches", () => {
  it("keeps the watch decision rules out of the boot chunks", () => {
    const cliChunk = readFileSync(builtEntry, "utf8").match(/import\("(\.\/cliMain[^"]+)"\)/u)?.[1];
    const serve = builtStaticClosure(path.resolve(serverRoot, "dist", cliChunk!));
    const boot = serve.chunks.map((chunk) => readFileSync(chunk, "utf8")).join("\n");
    // The decider and the shell use the small summary module (it is inlined without a region
    // marker, so the check names functions); only the watch sweep, which loads after the server
    // serves, needs the decision rules and the renderers.
    expect(boot).toContain("function summarizePullRequestWatches(");
    expect(boot).not.toContain("function decidePullRequestWatch(");
    expect(boot).not.toContain("function renderPullRequestWatchWake(");
  });

  it("keeps the watch sweep and its host-read adapters out of the boot chunks", () => {
    const cliChunk = readFileSync(builtEntry, "utf8").match(/import\("(\.\/cliMain[^"]+)"\)/u)?.[1];
    const serve = builtStaticClosure(path.resolve(serverRoot, "dist", cliChunk!));
    for (const chunk of serve.chunks) {
      expect(readFileSync(chunk, "utf8")).not.toMatch(
        /^\/\/#region src\/(?:sourceControl\/(?:pullRequestWatchSweep|pullRequestWatchObservation)|persistence\/wakeStartDelivery)\.ts$/mu,
      );
    }
  });

  it("loads the Git writing style code with the first generated commit message", () => {
    const cliChunk = readFileSync(builtEntry, "utf8").match(/import\("(\.\/cliMain[^"]+)"\)/u)?.[1];
    const serve = builtStaticClosure(path.resolve(serverRoot, "dist", cliChunk!));
    for (const chunk of serve.chunks) {
      const source = readFileSync(chunk, "utf8");
      expect(source).not.toMatch(/^\/\/#region src\/git\/gitWritingPolicy\.ts$/mu);
      expect(source).not.toMatch(/^\/\/#region src\/textGeneration\/TextGenerationPresets\.ts$/mu);
      // The example reader's output carries no region marker of its own; its log line is unique.
      expect(source).not.toContain("repository writing examples: commit subjects unavailable");
    }
  });

  it("loads the pull request template reader on first use", () => {
    const cliChunk = readFileSync(builtEntry, "utf8").match(/import\("(\.\/cliMain[^"]+)"\)/u)?.[1];
    const serve = builtStaticClosure(path.resolve(serverRoot, "dist", cliChunk!));
    for (const chunk of serve.chunks) {
      const source = readFileSync(chunk, "utf8");
      expect(source).not.toMatch(/^\/\/#region src\/sourceControl\/changeRequestTemplates\.ts$/mu);
      // In case the module carries no region marker of its own: its log line is unique.
      expect(source).not.toContain("change request templates: read failed");
    }
  });
});

describe.skipIf(!hasCurrentBuild)("built thread git metadata chunks", () => {
  it("keeps the thread git metadata sync out of the boot chunks", () => {
    const cliChunk = readFileSync(builtEntry, "utf8").match(/import\("(\.\/cliMain[^"]+)"\)/u)?.[1];
    const serve = builtStaticClosure(path.resolve(serverRoot, "dist", cliChunk!));
    for (const chunk of serve.chunks) {
      const source = readFileSync(chunk, "utf8");
      expect(source).not.toMatch(
        /^\/\/#region src\/orchestration\/threadGitMetadataRuntime\.ts$/mu,
      );
      expect(source).not.toMatch(/^\/\/#region src\/orchestration\/threadGitMetadata\.ts$/mu);
      expect(source).not.toMatch(
        /^\/\/#region \.\.\/\.\.\/packages\/shared\/src\/vcsCommand\.ts$/mu,
      );
    }
  });
});

/** Every specifier the built chunks import, statically or through `import()`. */
function builtImports(): ReadonlySet<string> {
  const distDir = path.join(serverRoot, "dist");
  const imports = new Set<string>();
  for (const file of readdirSync(distDir)) {
    if (!file.endsWith(".mjs")) continue;
    const source = readFileSync(path.join(distDir, file), "utf8");
    for (const match of source.matchAll(CHUNK_STATIC_IMPORT)) imports.add((match[1] ?? match[2])!);
    for (const match of source.matchAll(DYNAMIC_IMPORT)) imports.add(match[1]!);
  }
  return imports;
}

describe.skipIf(!hasCurrentBuild)("built server bundle imports", () => {
  it("leaves no import of a patch-added export to the installed package", () => {
    const patchAdded = patchAddedExports();
    expect([...builtImports()].filter((specifier) => patchAdded.has(specifier))).toEqual([]);
  });

  it("bundles the OpenCode 2 client instead of importing the package", () => {
    // `@opencode/*` are build-time dependencies: the published package does not install them.
    expect([...builtImports()].filter((specifier) => specifier.startsWith("@opencode/"))).toEqual(
      [],
    );
  });
});

// Recoverable Git actions: the service and its layer are on the boot path, the runner
// itself loads with the first recoverable action.
describe("recoverable git action boundaries", () => {
  it("keeps the runner off the serve path's static imports", () => {
    const graph = staticGraph("src/cliMain.ts");
    expect(graph.files).toContain("apps/server/src/git/GitActionRunner.ts");
    expect(graph.files).not.toContain("apps/server/src/git/gitActionRunnerCore.ts");
  });

  it.skipIf(!hasCurrentBuild)("keeps the runner out of the built boot chunks", () => {
    const cliChunk = readFileSync(builtEntry, "utf8").match(/import\("(\.\/cliMain[^"]+)"\)/u)?.[1];
    const serve = builtStaticClosure(path.resolve(serverRoot, "dist", cliChunk!));
    for (const chunk of serve.chunks) {
      expect(readFileSync(chunk, "utf8")).not.toMatch(
        /^\/\/#region src\/git\/gitActionRunnerCore\.ts$/mu,
      );
    }
  });
});
