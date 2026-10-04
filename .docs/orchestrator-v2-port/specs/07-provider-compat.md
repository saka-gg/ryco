# 07 · provider-compat: OpenCode 2.x guard and provider compatibility advisories (bug 10)

| Field | Value |
| --- | --- |
| id | `provider-compat` |
| title | Block OpenCode 2.x with an explained error at every entry point (CLI probe, pre-spawn, server health), fix the CLI version parser, and add manifest-driven compatibility advisories that rate each provider's installed and latest version |
| wave | 1 (parallel, isolated worktree). One branch, two commits or stacked PRs: **Part A** (the bug-10 fix, mergeable on its own) and then **Part B** (advisories) |
| verdict | **confirmed** for the core bug. A 2.x `opencode` binary gets the misleading "Unable to determine OpenCode version … requires v1.14.19 or newer". A 2.x server gets the opaque "health check returned an invalid response". Ryco's adapter and text generation also **spawn `opencode serve` before checking any version**. **Refuted sub-claim:** no update path Ryco offers can install 2.x. 2.x is a separate package (verified against the live registries on 2026-10-04, see §1.1) |
| size | **M** overall. Part A is S (7 source files). Part B is M |
| touched files | **Part A:** `apps/server/src/provider/providerSnapshot.ts` · `apps/server/src/provider/cliVersion.ts` · `apps/server/src/provider/openCodeVersion.ts` (new) · `apps/server/src/provider/opencodeRuntime.ts` · `apps/server/src/provider/Layers/OpenCodeProvider.ts` · `apps/server/src/mcp/adapters/OpenCodeMcpAdapter.ts` · `docs/providers/mcp.md` · tests: `providerSnapshot.test.ts`, `cliVersion.test.ts`, `openCodeVersion.test.ts` (new), `opencodeRuntime.test.ts`, `OpenCodeServerOwner.test.ts`, `Layers/OpenCodeProvider.test.ts`, `mcp/adapters/OpenCodeMcpAdapter.test.ts`. **Part B:** `packages/contracts/src/server.ts` · `packages/shared/src/providerCapabilities.ts` · `apps/server/src/provider/providerCompatibility.ts` (new) · `apps/server/src/provider/ModelManifest.ts` · `apps/server/src/provider/model-manifest.json` · `apps/server/src/provider/Layers/ProviderRegistry.ts` · `apps/server/src/provider/providerMaintenance.ts` · `apps/server/src/provider/providerMaintenanceRunner.ts` · `apps/web/src/components/settings/providerStatus.ts` · `apps/web/src/components/settings/ProviderInstanceCard.tsx` · `apps/web/src/components/settings/ProvidersSettingsPanel.tsx` · `apps/web/src/components/ProviderUpdateLaunchNotification.logic.ts` · `docs/providers/model-manifest.md` · tests: `packages/contracts/src/server.test.ts`, `packages/shared/src/providerCapabilities.test.ts`, `providerCompatibility.test.ts` (new), `ModelManifest.test.ts`, `Layers/ProviderRegistry.test.ts`, `providerMaintenance.test.ts`, `providerMaintenanceRunner.test.ts`, `orchestration/Layers/ContextHandoffCoordinator.test.ts` (one stub line), `apps/web/src/components/settings/providerStatus.test.ts` (new), `apps/web/src/components/ProviderUpdateLaunchNotification.logic.test.ts` |
| migrations | none (no number used) |
| contract changes | `packages/contracts/src/server.ts` gains:<br>• `ServerProviderCompatibilityStatus`, a **frozen** five-member literal set<br>• `ServerProviderCompatibilityAdvisory`<br>• `ServerProvider.compatibilityAdvisory` (`optionalKey`). Older clients drop the unknown key when they decode.<br><br>Remote-data contract: `model-manifest.json` gets an optional top-level `compatibility` array. Older releases ignore it.<br><br>Internal (server-only) changes:<br>• `ModelManifest` service gains `refreshIfStale`<br>• `resolveLatestProviderVersion` gains `options.fresh`<br>• `makeOpenCodeMcpAdapter` gains `options.managedGenerations`<br>• `MINIMUM_OPENCODE_VERSION` moves to `openCodeVersion.ts` |
| overlaps | **No function-level overlap with any Wave 1 package.** `reactor-errors-switch` is bug 9 (ACP model switch, `ProviderCommandReactor.ts`/`AcpRegistryDriver.ts`), so there is no overlap. None of the files this package touches are touched by `queue-hold-drain`, `turn-finalization`, `acp-message-ids`, `delegation-guard-restart`, `claude-meter-wake` or `settlement-signals`. This package adds no `packages/shared` export, so the `package.json` exports map does not conflict.<br><br>Possible trivial conflicts:<br>• Any package that edits the hand-written `ModelManifest` stub at `ContextHandoffCoordinator.test.ts:445-449` (one line).<br>• `usage-limits` (W2), only if it adds provider-level fields next to `versionAdvisory` in the `ServerProvider` struct (`server.ts:217-263`). Keep both fields.<br><br>Deliberately not touched:<br>• `OpenCodeAdapter.ts`, which `rollback-correctness` (W2), `provider-effect-outbox` and `restart-continuation` (W3) may edit. The pre-spawn gate lives in `opencodeRuntime.ts` `startOpenCodeServerProcess`.<br>• `ClaudeProvider.ts`. The parser change reaches it only through `parseGenericCliVersion`, which is covered by a regression test |

---

## 1. Problem (verified against the code at `9e545b3ae` and the live registries on 2026-10-04)

### 1.1 Ryco speaks only OpenCode 1.x, and 2.x is a different package

**Ryco's side:**
- `apps/server/package.json:37` pins `"@opencode-ai/sdk": "^1.18.29"`.
- `opencodeRuntime.ts:44` sets `MINIMUM_OPENCODE_VERSION = "1.14.19"`. There is no upper bound anywhere:
  - `opencodeRuntime.ts:118-124` checks only the minimum;
  - `Layers/OpenCodeProvider.ts:429-447` checks only the minimum.

**Live registries, checked 2026-10-04:**

| Channel | What it serves |
| --- | --- |
| npm `opencode-ai` | `dist-tags.latest = 1.18.34`; **0** versions start with `2.` |
| npm `@opencode/cli` | `2.0.22`, `bin: { opencode, opencode2 }` |
| Homebrew tap `opencode.rb` | `1.18.34` |
| Homebrew tap `opencode-v2.rb` | `2.0.22`, `conflicts_with "opencode", because: "both install an opencode binary"` |
| GitHub `anomalyco/opencode` `releases/latest` | `v1.18.34` |

t3 says the same thing (t3 `OpenCodeDriver.ts:89-93`): 1.x is `opencode-ai`, 2.x is `@opencode/cli`, and "2.x converts the shared database in place".

**Ryco's update paths:**
- Ryco reads the latest version from npm `opencode-ai` (`Drivers/OpenCodeDriver.ts:58-68`).
- It updates with `opencode-ai@latest`, `brew upgrade anomalyco/tap/opencode`, or native `opencode upgrade`.

None of these crosses the 1.x→2.x boundary. Native upgrade was not verified against source, but GitHub's latest release is 1.x. Users reach 2.x only by deliberately installing `@opencode/cli` or `opencode-v2`, which then shadows `opencode` on PATH.

### 1.2 What a 2.x user sees today

1. **Local binary, provider probe.**
   - 2.x prints `opencode v2.0.18` (t3 `opencodeVersionProbe.ts:34`).
   - `parseGenericCliVersion` (`providerSnapshot.ts:113-116`) uses `/\b(\d+\.\d+\.\d+)\b/`. There is no word boundary between `v` and `2`, so it returns `null` (checked in node; `/\bv?(\d+\.\d+\.\d+)\b/` returns `2.0.18`).
   - `OpenCodeProvider.ts:420-427` then reports *"Unable to determine OpenCode version … Ryco requires OpenCode v1.14.19 or newer"*.
2. **Local binary, sessions and text generation: Ryco spawns a 2.x server first.** All of these spawn `opencode serve` and only call `verifyOpenCodeServerVersion` afterwards:
   - the adapter (`OpenCodeAdapter.ts:2141-2164`);
   - text generation (`OpenCodeTextGeneration.ts:100-104, 274` → `OpenCodeServerOwner.acquire`, `OpenCodeServerOwner.ts:52-86` → `runtime.startOpenCodeServerProcess` at `:66`).

   There is exactly one spawn site, `opencodeRuntime.ts:439-446` (`["serve", …]`).

   Nothing in ProviderService or TextGeneration gates on provider status. `retainInventoryOnError: true` (`OpenCodeDriver.ts:164`) also keeps OpenCode models selectable after the probe fails. So title and commit-message generation and new sessions keep starting 2.x servers. Two consequences:
   - The database is converted in place (t3).
   - When `OPENCODE_PASSWORD` is unset, 2.x prints a generated password to stdout (t3 `OpenCode2Server.ts:40-43`). Ryco copies spawn stdout verbatim into its early-exit error (`opencodeRuntime.ts:519-532`).
3. **External server (`serverUrl`).**
   - 2.x serves its web-UI HTML with a 200 on `/global/health` (t3 `opencodeVersionProbe.ts:38-42`).
   - The installed SDK parses `text/*` as text (`@opencode-ai/sdk@1.18.29` `dist/v2/gen/client/utils.gen.js:77-79`). With `throwOnError: true` (`opencodeRuntime.ts:613-627`), `data` becomes a string.
   - `opencodeRuntime.ts:110-116` then reports *"OpenCode server health check returned an invalid response."*
4. **Unparseable health versions fail open.** `compareCliVersions("v2.0.0", "1.14.19")` falls back to `localeCompare` (`cliVersion.ts:84-89`). `"v"` sorts after `"1"`, so the minimum check passes.
5. **The MCP manager has a second parser.** `mcp/adapters/OpenCodeMcpAdapter.ts:290-306` runs `Number.parseInt(stdout.trim().split(".")[0])`, which is `NaN` for `opencode v2.0.18`. That makes 2.x fail closed by accident, with the vague message *"This OpenCode version is unknown or unavailable"* (`:360`). The test hides this with a bare `"2.0.1\n"` fixture (`OpenCodeMcpAdapter.test.ts:159`). Fixing the parser alone would silently turn on the never-exercised v2 write path.

### 1.3 There is no compatibility policy layer

Ryco has three kinds of version handling today:
- "behind latest" advisories (`providerMaintenance.ts:356-489`);
- Claude per-model `minVersion` in the manifest;
- a Cursor date gate (`CursorProvider.ts:53,737`).

None of them can say "this provider version breaks this Ryco release", or "don't install that latest version".

**What t3 does:**
- Schema and logic: `providerCompatibility.ts`.
- Data: the manifest `compatibility[]` (`model-manifest.json:4-90`).
- It rates the latest version as well as the installed one.

**Ryco's manifest refresh gap.** The manifest refreshes only from two places:
- the Claude probe (`ClaudeProvider.ts:407`, `refreshInBackground`);
- `ws/providerRpc.ts:241-249`, and only when the refresh includes a Claude instance.

So a user without Claude never fetches main. Nothing re-rates provider snapshots after the manifest changes.

---

## 2. Approach and decisions

- **Part A — the bug fix.**
  1. Fix the shared CLI parser.
  2. Add one pure OpenCode version module.
  3. Gate OpenCode at three entry points with one message set:
     - the CLI probe;
     - **pre-spawn**, inside `startOpenCodeServerProcess`, so every current and future spawn path is covered;
     - server health. Unparseable health versions and HTML responses are named explicitly, and unparseable versions fail closed.
  4. Route the MCP manager through the same classifier. 2.x MCP config fails closed, now with an explicit message.
- **Part B — advisories.** Port t3's policy model, slimmed down:
  - statuses `unknown | supported | graceful | unsupported | broken`;
  - policies keyed by driver and a `rycoRange`;
  - bundled defaults in `model-manifest.json`, overridable through the existing GitHub-main fetch;
  - lenient decoding.

  **Code-owned hard floors** (OpenCode major ≥ 2) are consulted before any manifest data, so a remote edit can never rate as compatible something this build cannot run.

  Where ratings are applied and enforced:
  - The registry rates every provider's installed version and its `versionAdvisory.latestVersion`.
  - The registry triggers a TTL-gated manifest refresh after provider syncs, for every driver, and re-rates every provider when it returns.
  - The update runner re-rates a **freshly fetched** latest version **inside the command lock**, and refuses `unsupported`/`broken`.
  - Web stops offering a blocked update and shows one plain text line on the card. There are no badges, chips, icons or new containers.
- **Why the latest-version rating exists.** For OpenCode it can only fire if the remote manifest marks a specific 1.x release broken; the floor never trips through npm (§1.1). For every package-managed provider (Codex, Claude Code, Copilot, Grok, OpenCode 1.x) it is a **remote kill switch for a bad release**, for example "Codex 0.200.x breaks approvals in Ryco 0.1.30". All tests use that realistic case.
- **Split.** Part A alone fixes bug 10 and should merge first. Part B builds the data-driven layer the brief asks for.

---

## 3. Part A — step-by-step changes

### A1. `apps/server/src/provider/providerSnapshot.ts:113-116`: fix the generic parser

```ts
export function parseGenericCliVersion(output: string): string | null {
  // "opencode v2.0.18": the optional "v" must be consumed first; "v2" has no word boundary.
  const match = output.match(/\bv?(\d+\.\d+\.\d+)\b/);
  return match?.[1] ?? null;
}
```

There are three callers:
- `ClaudeProvider.ts:475`. It parses `${stdout}\n${stderr}`, so stdout (`2.1.111 (Claude Code)`) still matches first. Regression test A-T1.
- `GrokProvider.ts:225`. Grok output with a `v` prefix now parses.
- `OpenCodeProvider.ts:419`.

### A2. `apps/server/src/provider/cliVersion.ts`: release parsing

Add the following and leave the existing exports unchanged. The Claude manifest `minVersion` validation depends on them.

```ts
export interface CliRelease { readonly major: number; readonly minor: number; readonly patch: number }
/** major.minor.patch of a CLI version. Ignores surrounding whitespace, one leading "v"/"V",
 *  any "-prerelease"/"+build" suffix, and a missing patch ("2.1" → 2.1.0). Leading zeros are
 *  numeric ("2026.04.09-f2b0fcd" → 2026.4.9). Returns null for anything else. */
export function parseCliRelease(version: string): CliRelease | null;
export function compareCliReleases(left: CliRelease, right: CliRelease): number;
```

The range helpers (B3) also live here, but in Part B.

### A3. New `apps/server/src/provider/openCodeVersion.ts`: the one OpenCode version policy

This module is pure: no SDK, Effect-process or filesystem imports. The MCP adapter and the compatibility module can both import it.

```ts
export const MINIMUM_OPENCODE_VERSION = "1.14.19";          // moved from opencodeRuntime.ts:44
export type OpenCodeGeneration = "v1" | "v2";              // moved from OpenCodeMcpAdapter.ts:47

/** Trim and strip one leading "v"/"V". */
export function normalizeOpenCodeVersion(raw: string): string;
/** "v1" for major 1, "v2" for major 2, null otherwise (null input, unparseable, 0.x, ≥3). */
export function classifyOpenCodeGeneration(version: string | null | undefined): OpenCodeGeneration | null;
/** True for any parseable major ≥ 2. Normalises itself, so "v2.0.0" and " 2.0.0-beta.1 " are true. */
export function isUnsupportedOpenCodeMajor(version: string): boolean;
/** null when this build can run `version`; otherwise the user-facing reason. Fails closed:
 *  unparseable → reason, major ≥ 2 → reason, below MINIMUM → reason. */
export function describeUnsupportedOpenCodeVersion(version: string, source: "binary" | "server"): string | null;

export const OPENCODE_UNKNOWN_CLI_VERSION_MESSAGE: string;
export const OPENCODE_NON_JSON_HEALTH_MESSAGE: string;
export const OPENCODE_V2_ADVISORY_MESSAGE = "Ryco works with OpenCode 1.x; 2.x support is coming.";
```

**Messages.** `${v}` is the normalised version.
- They state facts only. They make no promise that sessions will continue, because 2.x converts the shared database.
- They must not contain any keyword that `formatOpenCodeProbeError` (`OpenCodeProvider.ts:66-136`) rewrites: `401`, `403`, `unauthorized`, `forbidden`, `econnrefused`, `enotfound`, `fetch failed`, `networkerror`, `timed out`, `timeout`, `socket hang up`, `enoent`, `notfound`, `quarantine`, `corrupted`.

| Case | Text |
| --- | --- |
| binary, major ≥ 2 | ``OpenCode v${v} is not supported yet. Ryco works with OpenCode 1.x; 2.x support is coming. Point Binary path at an OpenCode 1.x install (npm `opencode-ai` or Homebrew `anomalyco/tap/opencode`).`` |
| server, major ≥ 2 | `The OpenCode server reports v${v}. Ryco works with OpenCode 1.x servers; 2.x support is coming.` |
| server, unparseable | `The OpenCode server reported an unrecognized version "${raw.slice(0, 40)}". Ryco requires OpenCode 1.x (v${MINIMUM_OPENCODE_VERSION} or newer).` |
| binary, unparseable (cannot occur after `parseGenericCliVersion`; kept for totality) | same as `OPENCODE_UNKNOWN_CLI_VERSION_MESSAGE` |
| too old, both sources (existing text, moved verbatim) | `OpenCode v${v} is too old. Upgrade to v${MINIMUM_OPENCODE_VERSION} or newer.` |
| `OPENCODE_UNKNOWN_CLI_VERSION_MESSAGE` (existing text from `OpenCodeProvider.ts:424`, moved verbatim) | ``Unable to determine OpenCode version from `opencode --version` output. Ryco requires OpenCode v${MINIMUM_OPENCODE_VERSION} or newer.`` |
| `OPENCODE_NON_JSON_HEALTH_MESSAGE` (neutral, because proxies and sign-in pages also return HTML) | `The OpenCode server returned a web page instead of an OpenCode 1.x health response. Check the server URL and any proxy or sign-in page in front of it. If the server runs OpenCode 2.x: Ryco does not support 2.x yet.` |

### A4. `apps/server/src/provider/opencodeRuntime.ts`

1. **Constant.** Delete the local `MINIMUM_OPENCODE_VERSION` (`:44`). The only importer is `OpenCodeProvider.ts`, which switches to `openCodeVersion.ts`. Do not re-export it.
2. **`verifyOpenCodeServerVersion` (`:95-128`).** After the timeout check:
   - `const raw: unknown = result.value.data;`. If `typeof raw === "string"`, fail with `OpenCodeRuntimeError({ operation: "global.health", detail: OPENCODE_NON_JSON_HEALTH_MESSAGE })`.
   - Keep the existing "invalid response" failure for every other malformed shape (`!healthy`, version missing or empty).
   - `const version = normalizeOpenCodeVersion(health.version)`. Then `const problem = describeUnsupportedOpenCodeVersion(health.version, "server")`. If `problem` is set, fail with that detail. This replaces the `compareCliVersions` block and its `compareCliVersions` import, and it fails closed for unparseable versions.
   - `return Effect.succeed(version)`. The value is normalised, so a `v` prefix no longer reaches the snapshot.

   Three callers inherit this with no edits:
   - the provider probe (`OpenCodeProvider.ts:481`);
   - the adapter (`OpenCodeAdapter.ts:2164`);
   - text generation (`OpenCodeTextGeneration.ts:213`).
3. **New exported pre-spawn gate.**
   ```ts
   const OPENCODE_VERSION_PREFLIGHT_TIMEOUT_MS = 5_000;
   /**
    * Runs `<binary> --version` and fails unless it reports an OpenCode version this build can run.
    * Called before every `opencode serve` spawn: Ryco must never start a 2.x server (2.x converts the
    * shared OpenCode database in place and prints a generated password on stdout). Deliberately not
    * cached — a binary swapped on PATH is caught at the next cold start. Ignores the exit code, like
    * the provider probe.
    */
   export const assertSupportedOpenCodeBinary = (
     runCommand: OpenCodeRuntimeShape["runOpenCodeCommand"],
     input: { readonly binaryPath: string; readonly environment?: NodeJS.ProcessEnv },
   ): Effect.Effect<string, OpenCodeRuntimeError>
   ```
   **Behaviour:**
   - Run `runCommand({ binaryPath, args: ["--version"], environment })` under `Effect.timeoutOption(OPENCODE_VERSION_PREFLIGHT_TIMEOUT_MS)`.
   - **None** (no output within 5s) → fail `{ operation: "startOpenCodeServerProcess", detail: "Could not check the OpenCode version: `<binaryPath> --version` did not finish within 5 seconds." }`.
   - Command error, for example ENOENT → propagate unchanged. `formatOpenCodeProbeError` still maps ENOENT to "not installed".
   - `parseGenericCliVersion(stdout)` returns null → fail with `OPENCODE_UNKNOWN_CLI_VERSION_MESSAGE`.
   - `describeUnsupportedOpenCodeVersion(version, "binary")` returns a reason → fail with it.
   - Otherwise succeed with the version.
4. **`startOpenCodeServerProcess` (`:418`).** The **first statement** of the generator, before the port lookup and `spawner.spawn` (`:446`), is:
   ```ts
   yield* assertSupportedOpenCodeBinary(runOpenCodeCommand, {
     binaryPath: input.binaryPath,
     ...(input.environment !== undefined ? { environment: input.environment } : {}),
   });
   ```
   `runOpenCodeCommand` is already defined above it (`:383`).

   **Covered spawn paths:**
   - `OpenCodeServerOwner.acquireProcess`, used by the adapter and text generation;
   - `connectToOpenCodeServer`'s local branch: the adapter's computer-lease path and the provider probe.

   External `serverUrl` connections never spawn, so they are unaffected.

   **Cost:** one short subprocess per cold spawn. The owner keeps a server alive for 30s idle (`OPENCODE_MANAGED_SERVER_IDLE_TTL`). The probe runs `--version` twice, but OpenCode probes are rare (`refreshInterval: null`).

### A5. `apps/server/src/provider/Layers/OpenCodeProvider.ts:403-449`: gate the local binary in the probe

- Replace the `!version` message with `OPENCODE_UNKNOWN_CLI_VERSION_MESSAGE`.
- Replace the too-old branch (`:429-447`) with a check on `describeUnsupportedOpenCodeVersion(version, "binary")`. When it is non-null, return the same `buildServerProvider({ … probe: { installed: true, version, status: "error", auth: { status: "unknown" }, message: versionProblem } })` shape as today.
- Remove the now-unused `compareCliVersions` import. Import `MINIMUM_OPENCODE_VERSION` only if it is still referenced.

The gate returns **before** `connectToOpenCodeServer`. This snapshot message is built directly, so `formatOpenCodeProbeError` never rewrites it.

**How the other probe paths surface.**
- External servers: the `verifyOpenCodeServerVersion` detail (2.x, unparseable or HTML) passes through `formatOpenCodeProbeError` unchanged, because it contains no keywords.
- Local spawned server: the same detail is prefixed with `Failed to execute OpenCode CLI health check: ` (`:131-135`). With the pre-spawn gate this path is effectively unreachable for 2.x.

**Where users see it:**
- the settings card summary, as "Unavailable - …";
- the chat composer notice (`apps/web/src/components/chat/providerStatusNotice.ts:13-31`);
- session and text-generation errors, which carry the pre-spawn gate detail verbatim.

### A6. `apps/server/src/mcp/adapters/OpenCodeMcpAdapter.ts`: shared classifier, 2.x fails closed with a clear message

- In `probeVersion` (`:290-306`), keep the timeout and non-zero-exit handling, then:
  `return classifyOpenCodeGeneration(parseGenericCliVersion(result.stdout));`
  Delete the local `parseInt` parsing and the local `OpenCodeGeneration` type (`:47`); import both from `provider/openCodeVersion.ts` and `provider/providerSnapshot.ts`.
- **Decision: Ryco does not edit OpenCode 2.x MCP configuration until OpenCode 2 support lands.**
  - The runtime is gated as unsupported.
  - The v2 write path has never run against a real 2.x binary, because real output always had the `v` prefix.
  - Nothing stops a 1.x instance and a 2.x instance from writing incompatible shapes into one `opencode.json`. `workspaceIdFor` keys on the generation (`:208-212`). A v2 `mcp.servers` key would look to 1.x like a server named `servers`.

  Implement this as an internal option rather than deleting the tested v2 code:
  ```ts
  export interface OpenCodeMcpAdapterOptions {
    /** Generations whose native config Ryco may manage. Production default: ["v1"]. */
    readonly managedGenerations?: ReadonlyArray<OpenCodeGeneration>;
  }
  export const makeOpenCodeMcpAdapter = (io = defaultIo, options: OpenCodeMcpAdapterOptions = {}) => …
  ```
  In `discover`, a detected generation that is not in `managedGenerations` is handled exactly like `generation === null` today: no `globalTarget`, no workspaces, empty capabilities, `status: "unsupported"`. The message is `OpenCode 2.x detected. Ryco works with OpenCode 1.x and does not edit 2.x configuration yet; 2.x support is coming.` Unknown generations keep today's message.
- Update the OpenCode row in `docs/providers/mcp.md:23`:
  - V1 `mcp` is managed.
  - V2 is detected and shown as unsupported until Ryco supports OpenCode 2.
  - JSONC stays read-only, and unknown versions fail closed.

---

## 4. Part B — step-by-step changes

### B1. `packages/contracts/src/server.ts` (schema only)

Insert this before `ServerProviderVersionAdvisoryStatus` (`:167`):

```ts
/**
 * How a provider version fits this Ryco release, per the server's compatibility policy
 * (code-owned floors + bundled defaults + remote model manifest).
 * FROZEN: mobile/desktop clients ship separately and decode whole provider lists with this
 * schema, so an unknown literal would fail the entire `ServerProvider` list. Never add a member —
 * put new meanings in a new optional field.
 */
export const ServerProviderCompatibilityStatus = Schema.Literals([
  "unknown", "supported", "graceful", "unsupported", "broken",
]);
export type ServerProviderCompatibilityStatus = typeof ServerProviderCompatibilityStatus.Type;

export const ServerProviderCompatibilityAdvisory = Schema.Struct({
  /** Rating of `ServerProvider.version`. */
  status: ServerProviderCompatibilityStatus,
  /** Rating of `versionAdvisory.latestVersion`; absent when no latest version is known. */
  latestVersionStatus: Schema.optionalKey(ServerProviderCompatibilityStatus),
  message: Schema.NullOr(TrimmedNonEmptyString),
});
export type ServerProviderCompatibilityAdvisory = typeof ServerProviderCompatibilityAdvisory.Type;
```

Then add `compatibilityAdvisory: Schema.optionalKey(ServerProviderCompatibilityAdvisory),` after `versionAdvisory` in `ServerProvider` (`:261`). The `providerStatusCache` file format round-trips it. `hydrateCachedProvider` ignores it, because the registry recomputes it on every upsert.

### B2. `packages/shared/src/providerCapabilities.ts`: one shared predicate, no new export

Add the predicate to the existing `@ryco/shared/providerCapabilities` subpath, which web already imports. No `package.json` edit is needed.

```ts
import type { ServerProviderCompatibilityStatus } from "@ryco/contracts";
/** Ratings for which Ryco refuses to install a version and stops offering it as an update. */
export function isBlockingProviderCompatibilityStatus(
  status: ServerProviderCompatibilityStatus | null | undefined,
): boolean {
  return status === "unsupported" || status === "broken";
}
```

It takes the status value, not a `Pick<ServerProvider, …>`, so callers never trip over `exactOptionalPropertyTypes`.

### B3. Range helpers in `cliVersion.ts` and the new `apps/server/src/provider/providerCompatibility.ts` (pure)

Add to `cliVersion.ts`:
```ts
/** Comparator groups joined by "||"; whitespace-separated comparators inside a group are ANDed.
 *  Comparator: /^(>=|>|<=|<|=)?v?\d+(\.\d+){0,2}$/ — no caret/tilde/x-ranges; missing segments
 *  are 0; no operator means "=". Empty groups are invalid. */
export function isCliVersionRange(range: string): boolean;
/** Matches on the release triple only (parseCliRelease): "2.0.0-beta.1" satisfies ">=2.0.0",
 *  "0.1.31-nightly.20260413.321" satisfies ">=0.1.30". false for an unparseable version or invalid range. */
export function satisfiesCliVersionRange(version: string, range: string): boolean;
```
This deliberately differs from t3, which rates prereleases as `unknown`. Rating a prerelease by its release triple is the conservative choice for "≥ 2 is unsupported".

`providerCompatibility.ts`:
```ts
import packageJson from "../../package.json" with { type: "json" };   // same pattern as cli.ts:111

export interface ProviderVersionRating {
  readonly status: ServerProviderCompatibilityStatus;
  readonly message: string | null;
}

const CliVersionRangeString = TrimmedNonEmptyString.check(
  Schema.isMaxLength(200),
  Schema.makeFilter(isCliVersionRange, { expected: "a CLI version range" }),
);
export const ProviderCompatibilityPolicy = Schema.Struct({
  driver: TrimmedNonEmptyString,
  rycoRange: CliVersionRangeString,
  ranges: Schema.Array(Schema.Struct({
    range: CliVersionRangeString,
    status: ServerProviderCompatibilityStatus,
    message: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(300))),
  })),
});
export type ProviderCompatibilityPolicy = typeof ProviderCompatibilityPolicy.Type;

/**
 * Code-owned limits of THIS build, consulted before any manifest policy for both the installed
 * and the latest version. A remote manifest can never rate these as compatible.
 */
const HARD_COMPATIBILITY_FLOORS: Readonly<Record<string, (version: string) => ProviderVersionRating | undefined>> = {
  opencode: (version) =>
    isUnsupportedOpenCodeMajor(version)
      ? { status: "unsupported", message: OPENCODE_V2_ADVISORY_MESSAGE }
      : undefined,
};

/** Lenient: a non-array `compatibility` yields []; each entry decodes on its own
 *  (Schema.decodeUnknownOption) and invalid entries are dropped whole. Memoized per
 *  manifest object (WeakMap) — the registry calls this on every upsert. */
export function compatibilityPoliciesOf(manifest: ModelManifestData): ReadonlyArray<ProviderCompatibilityPolicy>;

/** First policy in the current manifest with a matching driver whose rycoRange contains
 *  rycoVersion; else the first such BUNDLED policy (skipped when manifest === bundle); else undefined. */
export function selectCompatibilityPolicy(input: {
  readonly manifest: ModelManifestData; readonly driver: ProviderDriverKind; readonly rycoVersion?: string;
}): ProviderCompatibilityPolicy | undefined;

/** First matching range wins; unparseable version or no match → { status: "unknown", message: null }. */
export function ratePolicy(policy: ProviderCompatibilityPolicy, version: string): ProviderVersionRating;

/** Floor first, then policy. undefined when neither applies to the driver. */
export function rateProviderVersion(input: {
  readonly manifest: ModelManifestData; readonly driver: ProviderDriverKind;
  readonly version: string; readonly rycoVersion?: string;   // default packageJson.version
}): ProviderVersionRating | undefined;

/** Strips any previous advisory. Skips (returns stripped) disabled, not-installed, or version-less
 *  snapshots. Rates `snapshot.version` and, when present, `snapshot.versionAdvisory.latestVersion`.
 *  Attaches an advisory when either rating exists; a missing installed rating becomes "unknown". */
export function applyProviderCompatibility(
  snapshot: ServerProvider, manifest: ModelManifestData, rycoVersion?: string,
): ServerProvider;
```

**Default messages**, used when a range has no `message`:

| Status | Message |
| --- | --- |
| `graceful` | "This version works with limited compatibility in this Ryco release." |
| `unsupported` | "This version is outside the range this Ryco release supports." |
| `broken` | "This version is known to break this Ryco release." |
| `supported`, `unknown` | `null` |

**Ryco version.** `rycoRange` is matched against `apps/server/package.json` `version` through `parseCliRelease`, so nightly suffixes are stripped. Desktop and web release in lockstep with the server package.

**Import direction.** `providerCompatibility.ts` → `ModelManifest.ts` and `openCodeVersion.ts`, one way only. `ModelManifest.ts` must not import this module, so its envelope stays `Schema.Unknown`.

### B4. `apps/server/src/provider/ModelManifest.ts` and `model-manifest.json`

- **Envelope (`:74-78`).** Add `compatibility: Schema.optional(Schema.Unknown)`. It is deliberately `Unknown`: a malformed or non-array `compatibility` on main, for example a future versioned object, must never reject the whole manifest, and with it the remote Claude catalog. Per-entry validation lives in `compatibilityPoliciesOf`. `ManifestCacheFile` round-trips it unchanged.
- **Service (`:187-205`).** Add:
  ```ts
  /** TTL-gated refresh that the caller awaits (same gating as refreshInBackground); never fails. */
  readonly refreshIfStale: Effect.Effect<ModelManifestData>;
  ```
  - In `make` (`:280-286`), `refreshIfStale` is `guardedRefresh`. `refreshInBackground` stays `Effect.forkIn(guardedRefresh, serviceScope)`.
  - `BundledOnlyModelManifest` gets `refreshIfStale: Effect.succeed(BUNDLED_MODEL_MANIFEST)`.
  - Add the same line to the hand-written stub in `orchestration/Layers/ContextHandoffCoordinator.test.ts:445-449`.
  - `enableProviderUpdateChecks: false` still stops network fetches (`:248-254`).
- **`model-manifest.json`.** Add a top-level `compatibility` seed for OpenCode only:
  ```json
  "compatibility": [
    {
      "driver": "opencode",
      "rycoRange": ">=0.1.30",
      "ranges": [
        { "range": ">=2.0.0", "status": "unsupported",
          "message": "Ryco works with OpenCode 1.x; 2.x support is coming." },
        { "range": ">=1.14.19 <2.0.0", "status": "supported" }
      ]
    }
  ]
  ```
  - The `>=2.0.0` line repeats the code floor as data for readers. The floor is authoritative, and drift test B-T3 pins the two together.
  - There is deliberately no `<1.14.19` range. The minimum is code-gated already as a probe error, and leaving it unrated keeps the existing runner fixtures valid (they use OpenCode latest `"0.0.0"`).

### B5. `apps/server/src/provider/Layers/ProviderRegistry.ts`: rate every provider, refresh without Claude, re-rate after refresh

- **At layer construction.**
  ```ts
  const manifestService = yield* Effect.serviceOption(ModelManifest);
  const currentManifest = Option.match(manifestService, {
    onNone: () => Effect.succeed(BUNDLED_MODEL_MANIFEST),
    onSome: (service) => service.current,
  });
  const registryScope = yield* Effect.scope;
  const compatibilityRefreshRunning = yield* Ref.make(false);
  ```
  - `ModelManifest.layer` is `provideMerge`d below `ProviderRegistryLive` in the same chain (`server.ts:407,427`).
  - `ProviderRegistry.test.ts` is the only test that builds `ProviderRegistryLive`. Without the service it falls back to the bundled policies, which rate only enabled and installed OpenCode. No existing fixture is an installed OpenCode in `[1.14.19, 2)` asserted by deep equality.
- **`upsertProviders` (`:324-379`).**
  - Read `const manifest = yield* currentManifest;` before `Ref.modify`. `current` never waits on an in-flight fetch.
  - Inside the modify, map **every** provider of `orderProviderSnapshots(...)` through `applyProviderCompatibility(provider, manifest)`. Derive `providersToPersist` from the classified list.
  - `Equal.equals` is structural, so a re-rating that changes nothing does not publish.
  - The boot `upsertProviders(fallbackProviders, { publish: false })` (`:656`) rates the hydrated cache before anyone reads it.
- **`syncProvider` (`:381-388`).** This is the single funnel for every driver's probe, stream and refresh result. After the upsert, when `manifestService` is `Some` and `yield* Ref.getAndSet(compatibilityRefreshRunning, true)` was `false`, run:
  ```ts
  manifestService.value.refreshIfStale.pipe(
    Effect.andThen(upsertProviders([], { persist: false })),   // re-rate everything with the new manifest
    Effect.ensuring(Ref.set(compatibilityRefreshRunning, false)),
    ignoreProviderBackgroundCause("provider compatibility reclassification failed"),
    Effect.forkIn(registryScope),                               // syncProvider also runs from RPC fibers
  )
  ```
  This gives four guarantees:
  1. An OpenCode-only or Codex-only user fetches main on the same TTL as Claude users.
  2. A manifest swapped by any refresh (this one, Claude's `refreshInBackground`, or the forced RPC refresh) is applied to every snapshot. It does not wait for each provider to re-probe.
  3. At most one reclassification is in flight. A sync that is skipped while one runs is covered when that one re-rates.
  4. The re-rate always runs, rather than only when the manifest object changed, so snapshots rated before a concurrent swap are fixed too.
- `syncLiveSources`' prune `Ref.modify` (`:612-621`) only filters, so ratings survive it.
- **Not changed:** `ws/providerRpc.ts` still forces a manifest refresh only when a Claude instance is refreshed. Provider refresh is also called programmatically, for example by mobile statistics (`useStatisticsData.ts:44`) and reset-credit polling (`client-runtime/src/usage/resetCredits.ts:192`). A forced fetch per call would be a traffic regression, and the TTL-gated refresh above covers non-Claude users.

### B6. `providerMaintenance.ts` and `providerMaintenanceRunner.ts`: refuse inside the lock, using fresh data

- **`resolveLatestProviderVersion` (`providerMaintenance.ts:426-446`)** gains `options?: { readonly fresh?: boolean }`. With `fresh: true` it skips the cache read but still writes the cache, so a click-time fetch also refreshes the 1h cache (`LATEST_VERSION_CACHE_TTL_MS`, `:14`).
- **Runner `make` (`providerMaintenanceRunner.ts:173`)** adds:
  ```ts
  const manifestService = yield* Effect.serviceOption(ModelManifest);
  const currentManifest = Option.match(manifestService, {
    onNone: () => Effect.succeed(BUNDLED_MODEL_MANIFEST),
    onSome: (service) => service.current,
  });
  ```
- **The refusal** is the **first statement of `runCommandAndVerify`** (`:302`), before `startedAt` is taken and before the `running` state is set. `runCommandAndVerify` runs inside `runProviderUpdate`, which `commandCoordinator.withCommandLock` executes under `lock.withPermits(1)` (`providerMaintenanceCommandCoordinator.ts:72`). So the check runs after any queue wait.
  ```ts
  const latestVersion = yield* resolveLatestProviderVersion(capabilities, { fresh: true }).pipe(
    Effect.provideService(HttpClient.HttpClient, httpClient),
  );
  if (latestVersion !== null) {
    const rating = rateProviderVersion({
      manifest: yield* currentManifest,
      driver: provider,
      version: latestVersion,
    });
    if (isBlockingProviderCompatibilityStatus(rating?.status)) {
      const label = latestVersion.startsWith("v") ? latestVersion : `v${latestVersion}`;
      return yield* finish(makeUpdateState({
        status: "failed",
        startedAt: null,
        finishedAt: yield* nowIso,
        message: `Ryco did not install ${label}: ${rating?.message ?? "it is not compatible with this Ryco release."}`,
      }));
    }
  }
  ```
  - It never reads the snapshot's cached `compatibilityAdvisory`, which can be stale. It rates a fresh latest version against the current manifest, with the bundle and floors as fallback.
  - It rates the version npm reports when the lock is acquired, which is what `<pkg>@latest` installs. For `brew upgrade` and native upgrades this is a best-effort proxy (see Edge cases).
  - When the latest version is unknown it is not blocked. That covers `packageName: null` (Cursor, native updaters) and a failed fetch.
  - The fetch runs even with `enableProviderUpdateChecks: false`. The user asked explicitly, and the install contacts the registry anyway. Document this in a code comment.
  - The only caller of `updateProvider` is the WS `serverUpdateProvider` handler (`ws/providerRpc.ts:259-264`). Web's settings panel and launch toast both use it. No CLI, mobile or Agent Control path calls it today. The refusal is server-side, so any future caller inherits it.

### B7. Web (`apps/web` settings; the frozen phone tier gets nothing new)

- **`components/settings/providerStatus.ts`.**
  - `getProviderVersionAdvisoryPresentation(advisory, compatibility?: ServerProviderCompatibilityAdvisory | undefined)` returns `null` when `isBlockingProviderCompatibilityStatus(compatibility?.latestVersionStatus)`. That removes the bouncing update arrow, "Update now" and the copy-command row for a blocked latest version.
  - New pure function:
    ```ts
    export function getProviderCompatibilityNotice(provider: ServerProvider | undefined):
      { readonly tone: "muted" | "warning"; readonly text: string } | null;
    ```
    It returns `null` when there is no provider, no advisory, the provider is disabled, or `provider.status === "error"`. In the error case the summary already carries the gate message, and the density rule is no repeated facts. Otherwise:
    - `unsupported` or `broken` with a message → `{ tone: "warning", text: message }`;
    - `graceful` with a message → `{ tone: "muted", text: message }`;
    - else, when `versionAdvisory.status === "behind_latest"`, `latestVersion` is set and `latestVersionStatus` is blocking → `{ tone: "muted", text: `${getProviderVersionLabel(latestVersion)} is available, but it is not compatible with this Ryco release, so Ryco won't offer it.` }`;
    - else `null`.
- **`components/settings/ProviderInstanceCard.tsx`.**
  - Pass `liveProvider?.compatibilityAdvisory` at `:475`.
  - Compute the notice and render one `<p className="text-xs text-warning|text-muted-foreground">` directly after `{authRowNode}` (`:742`).
  - No icon, chip, badge or new container.
- **`components/ProviderUpdateLaunchNotification.logic.ts`.**
  - Leave `isProviderUpdateCandidate` (`:121-128`) **unchanged**. It is a type guard, and the progress view's success check (`:296-300`) treats "no longer a candidate" as "updated". Adding compatibility to it would turn a re-rating during an update into a false "Provider updated" toast.
  - Add:
    ```ts
    export function isProviderUpdateOffered(provider: ServerProvider): provider is ProviderUpdateCandidate {
      return isProviderUpdateCandidate(provider) &&
        !isBlockingProviderCompatibilityStatus(provider.compatibilityAdvisory?.latestVersionStatus);
    }
    ```
  - Use it in `collectProviderUpdateCandidates` (`:135-139`); this feeds the launch toast, pill and "Update Available" title.
  - Add a first-line guard `if (!isProviderUpdateOffered(candidate)) return false;` to `hasOneClickUpdateProviderCandidate` (`:141`). Leave its sibling loop unchanged.
  - The progress success check (`:299`) keeps `isProviderUpdateCandidate`.
- **`components/settings/ProvidersSettingsPanel.tsx:382`.** Use `isProviderUpdateOffered` for `selectedUpdateCandidate`. That gates `onRunUpdate` for the card.

### B8. `docs/providers/model-manifest.md`

Add a "Provider compatibility (`compatibility`)" section covering:
- the format, with the OpenCode seed as the example;
- the policy order (newest `rycoRange` first) and that the first matching range wins;
- what each status means: `unsupported`/`broken` ratings of the **latest** version stop Ryco from offering or installing it, while ratings of the installed version are informational text on the card;
- per-range `message` (at most 300 characters, rendered verbatim);
- version normalisation: a leading `v` and `-pre`/`+build` suffixes are ignored, and Cursor dates work;
- `rycoRange` is matched against the `apps/server/package.json` version with the nightly suffix stripped;
- a remote policy replaces the bundled one for the same driver only when its `rycoRange` matches, and omitting it keeps the bundled policy. To retract a bundled rating, publish an explicit overriding policy for that `rycoRange`;
- **code-owned floors (OpenCode ≥ 2.0.0 in this build) cannot be lifted by the manifest**;
- lenient decoding: invalid entries are dropped, and the manifest is never rejected because of them;
- older releases ignore the field;
- the status set is frozen;
- the latest-version rating for OpenCode always comes from npm `opencode-ai`, which has no 2.x. In practice an OpenCode policy only blocks updates when it marks a specific 1.x release.

---

## 5. Tests

Run focused files only, for example `bun run --cwd apps/server test src/provider/opencodeRuntime.test.ts`. **Never run `bun test`.**

Use `it.effect` (TestClock) unless real timers are needed. Tests marked **FAILS TODAY** must be written first and fail before the fix.

> **Safety:** never let the real `startOpenCodeServerProcess` reach `spawner.spawn` for `serve` with a mock handle. Its finalizer calls `process.kill(-Number(child.pid), signal)` (`opencodeRuntime.ts:475`), and a mock pid of `1` becomes `process.kill(-1)`, which signals every process the user owns. In runtime-level tests, the mock spawner must **fail** (`Effect.fail(PlatformError…)`) for any command other than `--version`.

### Part A

- **A-T1 `providerSnapshot.test.ts`**:
  - `parseGenericCliVersion("opencode v2.0.18\n") === "2.0.18"` (**FAILS TODAY**);
  - `"1.18.34\n"`, `"opencode 1.14.19\n"` and `"2.1.111 (Claude Code)"` are unchanged;
  - `"abc1.2.3"` → `null`;
  - **Claude regression:** `parseGenericCliVersion("2.1.111 (Claude Code)\n\n(node:1) Warning: node v20.1.0")` → `"2.1.111"`.
- **A-T2 `cliVersion.test.ts`**: `parseCliRelease`:
  - `"v2.0.0"` → `{2,0,0}`;
  - `" V1.18.34 "` → `{1,18,34}`;
  - `"2.0.0-beta.1"` → `{2,0,0}`;
  - `"2.1"` → `{2,1,0}`;
  - `"2026.04.09-f2b0fcd"` → `{2026,4,9}`;
  - `"dev"`, `"local"` and `""` → `null`.
- **A-T3 `openCodeVersion.test.ts` (new)**:
  - `classifyOpenCodeGeneration`: `"1.18.34"` → `v1`, `"v2.0.18"` → `v2`, `"3.0.0"` → `null`, `null` → `null`;
  - `isUnsupportedOpenCodeMajor`: `"v2.0.0"` and `"2.0.0-beta.1"` are true; `"1.99.99"` and `"garbage"` are false;
  - `describeUnsupportedOpenCodeVersion`:
    - `("2.0.18","binary")` contains `not supported yet`, `1.x` and `opencode-ai`;
    - `("2.0.18","server")` contains `reports v2.0.18`;
    - `("garbage","server")` contains `unrecognized version`;
    - `("1.14.18", either source)` contains `too old`;
    - `("1.18.34", either source)` is `null`;
  - **keyword guard:** none of the messages, nor `OPENCODE_NON_JSON_HEALTH_MESSAGE`, contains any keyword from the A3 list (lower-cased check).
- **A-T4 `opencodeRuntime.test.ts`, `verifyOpenCodeServerVersion`**:
  - health `{healthy:true, version:"2.0.18"}` rejects with `reports v2.0.18` (**FAILS TODAY**: it resolves);
  - `"v2.0.18"` rejects (**FAILS TODAY**: it passes via `localeCompare`);
  - `"garbage"` rejects with `unrecognized version` (**FAILS TODAY**);
  - `"v1.18.18"` resolves to `"1.18.18"`;
  - `data: "<!doctype html>…"` rejects with `OPENCODE_NON_JSON_HEALTH_MESSAGE` (**FAILS TODAY**: it gives "invalid response");
  - the existing 1.18.18 and 1.14.18 cases are unchanged.
- **A-T5 `opencodeRuntime.test.ts`, `assertSupportedOpenCodeBinary` with a fake `runCommand`**:
  - `"1.18.34\n"` → `"1.18.34"`;
  - `"opencode v2.0.18\n"` → fails with `not supported yet`;
  - `"no version here"` → fails with `Unable to determine`;
  - a runner returning `Effect.never`: fork it, `TestClock.adjust("5 seconds")`, and the fiber fails with `did not finish within 5 seconds`. This uses `@effect/vitest` `it.effect`. The file currently uses vite-plus `it`, so add a separate `describe` that imports from `@effect/vitest`.
- **A-T6 `opencodeRuntime.test.ts`, pre-spawn gate on the real runtime** (`OpenCodeRuntimeLive`, which provides `NetService`, plus a recording `ChildProcessSpawner`, following the mock-handle pattern in `providerMaintenanceRunner.test.ts:96-140`). `--version` returns `opencode v2.0.18\n`; every other command records the attempt and fails.
  - `startOpenCodeServerProcess({ binaryPath: "opencode" })`, scoped, fails with `not supported yet`, and the recorded commands are exactly `[["--version"]]` (**FAILS TODAY**: it attempts `serve` first).
  - The same holds for `connectToOpenCodeServer({ binaryPath: "opencode", serverUrl: "" })`.
- **A-T7 `OpenCodeServerOwner.test.ts`**: a regression guard that passes today. A runtime double whose `startOpenCodeServerProcess` fails once with an `OpenCodeRuntimeError` and then succeeds. The first `acquire` fails; the second calls `startOpenCodeServerProcess` again (`state.starts === 2`). A refused start is never cached, so a user who fixes their binary recovers without restarting Ryco.
- **A-T8 `Layers/OpenCodeProvider.test.ts`**. Extend `runtimeMock.state` with `connectCalls` and `healthData`, so `createOpenCodeSdkClient` returns `{ data: state.healthData }`.
  - With `versionStdout = "opencode v2.0.18\n"`: `status: "error"`, `installed: true`, `version: "2.0.18"`, the message contains `not supported yet`, and `connectCalls === 0` (**FAILS TODAY**: the message is "Unable to determine…").
  - External `serverUrl` with `healthData = { healthy: true, version: "2.0.18" }`: the message contains `reports v2.0.18`, unchanged by `formatOpenCodeProbeError`.
  - External `serverUrl` with `healthData = "<!doctype html>"`: the message equals `OPENCODE_NON_JSON_HEALTH_MESSAGE` (**FAILS TODAY**).
- **A-T9 `mcp/adapters/OpenCodeMcpAdapter.test.ts`**:
  - `makeIo("opencode v2.0.18\n")` gives `providers[0].status === "unsupported"`, a message containing `OpenCode 2.x detected`, no workspaces and nothing written (**FAILS TODAY** on the message);
  - `makeIo("opencode v1.18.18\n")` manages V1 exactly like the bare `"1.18.18\n"` fixture;
  - rewrite the V2 bridge test (`:157-183`) to call `makeOpenCodeMcpAdapter(io, { managedGenerations: ["v1", "v2"] })` with the real `"opencode v2.0.18\n"` output, so the v2 write path stays covered;
  - the `"3.0.0\n"` fail-closed test is unchanged.

### Part B

- **B-T1 `packages/contracts/src/server.test.ts`**:
  - a provider with `compatibilityAdvisory: { status: "broken", latestVersionStatus: "unsupported", message: "x" }` decodes;
  - a provider without it decodes with the key absent;
  - `status: "weird"` fails to decode. This documents the frozen set.
- **B-T2 `packages/shared/src/providerCapabilities.test.ts`**: `isBlockingProviderCompatibilityStatus` is true only for `unsupported` and `broken`. It is false for the other three, `null` and `undefined`.
- **B-T3 `providerCompatibility.test.ts` (new)**:
  - **Resolution:**
    - a remote policy wins over bundled;
    - a remote policy whose `rycoRange` does not match falls back to bundled;
    - a driver with no policy and no floor gives `undefined`.
  - **Rating:**
    - first match wins across overlapping ranges;
    - an unparseable version gives `unknown`;
    - a range `message` overrides the default.
  - **Floors are authoritative:**
    - with a manifest whose opencode policy says `{ range: ">=2.0.0", status: "supported" }`, `rateProviderVersion(opencode, "2.0.0")` is `unsupported` for both the installed and the latest rating;
    - a remote policy `{ range: "=1.18.32", status: "graceful", message: "m" }` rates `1.18.32` as `graceful` with message `m`.
  - **`applyProviderCompatibility`:**
    - skips disabled, not-installed and version-less snapshots;
    - strips a stale advisory;
    - sets `latestVersionStatus` only when `versionAdvisory.latestVersion` exists;
    - a Codex snapshot `0.199.0`/latest `0.200.1` under the policy `{driver:"codex", rycoRange:">=0.0.0", ranges:[{range:">=0.200.0", status:"broken", message:"Codex 0.200 breaks approvals."},{range:"<0.200.0", status:"supported"}]}` gives `{ status: "supported", latestVersionStatus: "broken", message: null }`.
  - **Leniency:**
    - `compatibility: "nope"` → `[]`;
    - `compatibility: {}` → `[]`;
    - `[valid, { driver: 1 }, { …, rycoRange: "^1" }, { …, ranges: [{ range: ">=1", status: "broken", message: "x".repeat(301) }] }]` → only `valid`.
  - **Drift guard:** take the bundled opencode policy via `selectCompatibilityPolicy` with the package version.
    - `ratePolicy(policy, MINIMUM_OPENCODE_VERSION)` is `supported`.
    - `"1.99.99"` is `supported`.
    - `"2.0.0"` is `unsupported`.
    - `isUnsupportedOpenCodeMajor` agrees with each of these.
- **B-T4 `ModelManifest.test.ts`**:
  - a manifest with `compatibility: { bogus: true }` still decodes, and `resolveProviderCatalog(…, claudeAgent)` is non-null;
  - `refreshIfStale` called twice makes **1** HTTP request. Contrast the existing `refresh` test, which makes 2.
- **B-T5 `Layers/ProviderRegistry.test.ts`.** Model the fixtures on the inline instance fixture at `:879-960`.
  - (a) No `ModelManifest` service. An enabled, installed OpenCode snapshot at `"2.0.18"` gets `compatibilityAdvisory.status === "unsupported"` from the floor.
  - (b) **Refresh without Claude, then re-rate.** Use a codex-only registry. Provide a `ModelManifest` stub:
    - `current` reads a `Ref` that starts at the bundle;
    - `refreshIfStale` increments a counter, swaps in the Codex policy from B-T3 and returns it.

    Publish a codex snapshot `0.199.0` with `versionAdvisory.latestVersion: "0.200.1"`. Poll `getProviders` with `Effect.yieldNow`, as the existing tests do, until it shows `status: "supported"` and `latestVersionStatus: "broken"`. Assert the counter is ≥ 1. This proves the refresh happens with no Claude instance, and that existing snapshots are re-rated without re-probing.
  - (c) The existing tests stay green with no fixture edits.
- **B-T6 `providerMaintenance.test.ts`**: `resolveLatestProviderVersion(caps, { fresh: true })` re-fetches despite a warm cache and updates the cache. A later non-fresh call returns the new value without fetching.
- **B-T7 `providerMaintenanceRunner.test.ts`.** `makeTestRunner(registry, manifestLayer?)` provides an optional `ModelManifest` stub; the default is none, which means bundled.
  - **Refusal (Codex, realistic kill switch):** `latestVersionHttpClient("0.200.1")` with the B-T3 Codex policy.
    - `updateState.status === "failed"`;
    - the message contains `v0.200.1` and `breaks approvals`;
    - the spawner records no calls;
    - the recorded states are `["queued", "failed"]`.
  - **The click-time fetch beats the cache:** warm the cache with `"0.199.0"` via `resolveLatestProviderVersion` under one HttpClient, then update under `latestVersionHttpClient("0.200.1")`. It is still refused.
  - **A manifest changed after the snapshot was rated still refuses.** The registry snapshot carries `compatibilityAdvisory.latestVersionStatus: "supported"`, but the stub's `current` returns the broken policy. The update is refused, which proves the runner does not trust the cached field.
  - **A queued update re-checks after the lock.** Codex and OpenCode share `npm-global`, as in the existing serialize test at `:479-546`; the HttpClient returns `"1.18.40"` for both.
    1. The Codex update holds the lock (latched spawner).
    2. The OpenCode update is queued.
    3. While it is queued, set the stub manifest to `{ driver: "opencode", rycoRange: ">=0.0.0", ranges: [{ range: "=1.18.40", status: "broken", message: "1.18.40 corrupts sessions." }] }`.
    4. Release Codex.

    The OpenCode update ends `failed` with `corrupts sessions`, and only Codex's command was spawned.
  - **Allowed:** the Codex policy with latest `"0.199.5"` spawns and succeeds.
  - The existing tests stay green unchanged. Their latest versions are unrated: Codex has no bundled policy, and OpenCode `"0.0.0"` is neither floored nor in a seeded range.
- **B-T8 `apps/web/src/components/settings/providerStatus.test.ts` (new)**:
  - the advisory presentation is `null` when `latestVersionStatus` is `broken`, and unchanged for `supported` or an absent advisory;
  - the notice is `null` for status `error` and for disabled providers;
  - `warning` tone for `unsupported` with a message;
  - `muted` tone for `graceful`;
  - the latest-blocked text appears only for `behind_latest`.
- **B-T9 `ProviderUpdateLaunchNotification.logic.test.ts`**:
  - A `behind_latest` provider with `latestVersionStatus: "unsupported"`:
    - is not returned by `collectProviderUpdateCandidates`;
    - fails `hasOneClickUpdateProviderCandidate`;
    - **is still** an `isProviderUpdateCandidate`.
  - The same provider rated `graceful` is offered.
  - **Progress view:** a provider re-rated to a blocked latest during an update, with `updateState.status === "running"`, does not produce a "Provider updated" success view.

---

## 6. Edge cases

- **Native `opencode upgrade` and Homebrew.** Neither can cross to 2.x today (§1.1). If either ever did, the pre-spawn gate stops Ryco from running the result, and the probe reports it clearly.
- **2.x install and the update button.**
  - A 2.x install's version advisory is `current` (2.0.22 > 1.18.34), so no update is offered.
  - A forced RPC update would run `opencode-ai@latest` or `brew upgrade anomalyco/tap/opencode`, and fail visibly: npm bin conflict, or brew "not installed".
  - No extra handling is needed.
- **Homebrew and native latest are rated from the npm number**, not from the formula or the GitHub release. For OpenCode all three are 1.18.34 today. For other providers this is best-effort and documented.
- **Unparseable versions now fail closed everywhere.**
  - On the CLI probe this is already the case.
  - The pre-spawn gate and health check are new: an external dev-build server reporting `"local"` was accepted before (via `localeCompare`) and is now refused with a clear message.
- **OpenCode 1.x prereleases** (`1.19.0-beta.1`) are major 1, so they are allowed and rated `supported`. `2.0.0-beta.1` is blocked.
- **Remote manifest fetch disabled** (`enableProviderUpdateChecks: false`). The disk cache, then the bundle and the floors, still apply. `latestVersionStatus` is absent because no latest version is known. The click-time runner check still fetches.
- **Offline update click.** The fresh fetch returns `null`, so the update is not blocked; the install fails on its own.
- **Mixed 1.x and 2.x OpenCode instances on one config file** never get a writable 2.x workspace.
- **Status `error` with a blocking rating** (the OpenCode 2.x gate). Web shows only the summary. The advisory still goes over the wire for future surfaces.
- **`compatibilityAdvisory` in the provider status cache** is ignored on hydrate and recomputed on boot.

## 7. Risks

- **The parser change reaches Grok and Claude.**
  - Grok output with a `v` prefix starts being detected, so Grok version advisories and update prompts may appear for the first time. This is a correct fix; call it out in the PR.
  - Claude is covered by the A-T1 regression test.
- **Extra subprocess.** There is one `opencode --version` per cold server start (at most one per 30s idle window), and the probe runs it twice. This is negligible next to `serve` startup.
- **A wrong remote `broken` rating** blocks updates for every install until it is corrected. It never disables a provider, because only update offers and installs are gated. Mitigations:
  - decoding is lenient;
  - messages are capped at 300 characters;
  - the override rule is documented;
  - floors cannot be lifted remotely.
- **Closed status set.** Adding a status later would break older clients that decode provider lists. It is documented as frozen in contracts.
- **Manifest service shape.** `refreshIfStale` adds one member, so every hand-written stub needs it. Typecheck enforces this.
- **Test safety.** See the `process.kill(-pid)` warning in §5.

## 8. Out of scope / follow-ups

- **OpenCode 2 support:** a version-routed adapter (comparison §2 / order item 8). It removes the floor for its release and flips `managedGenerations` to include `v2` once there is a same-path cross-generation guard.
- **`usage/opencodeUsageReader.ts`** reads OpenCode's SQLite database directly. Its behaviour on a database that 2.x has already converted is unverified; it should fail soft.
- **Redact spawn stdout** in the early-exit error (`opencodeRuntime.ts:519-532`). With the pre-spawn gate no 2.x server is spawned, so this is hardening only.
- **`packages/client-runtime/src/connection/providerMaintenance.ts` `createProviderMaintenanceController`** has no production consumer (only its test). It is left untouched; the server refusal covers any future caller.
- **Mobile and the frozen web phone tier** get no new UI.
- **Moving checks into `compatibility[]`:** the Cursor date gate and Claude per-model `minVersion`.
- **Targeted installs of a recommended version** (t3 `recommendedVersion`/`recommendedRange`).
- **Compatibility warnings in the chat composer notice.**
- **Agent Control** is not touched.

---

## 9. Review resolution

| # | Severity | Issue | Resolution |
| --- | --- | --- | --- |
| 1 | major | The update refusal can never fire for OpenCode; the fixtures were impossible; the package was too large | **Accepted.** Re-verified today: `opencode-ai` latest is 1.18.34 with 0 versions starting `2.`; `@opencode/cli` 2.0.22 has bins `opencode`+`opencode2`; `opencode-v2.rb` declares `conflicts_with "opencode"`; GitHub latest is v1.18.34. Changes: the problem statement now says 2.x is a separate package (§1.1); the latest-version rating is presented as a remote kill switch for a bad release; every fixture uses reachable Codex or OpenCode-1.x cases (B-T3, B-T5, B-T7); the work is split into Part A (S, the bug fix, merges first) and Part B; there is no separate "update-blocked" presentation, just one text line from the notice function plus hidden candidates (B7) |
| 2 | major | Remote overrides never reach users without Claude | **Accepted, with a different mechanism.** `syncProvider`, the funnel for every driver, forks a TTL-gated `refreshIfStale` and re-rates afterwards (B5), tested with a Codex-only registry (B-T5b). **Rejected part:** forcing a manifest refresh on every `serverRefreshProviders`. Mobile statistics and reset-credit polling call that RPC programmatically, so it would be a traffic regression; the TTL-gated path already covers non-Claude users |
| 3 | major | Ratings go stale; the check raced the lock; undefined variables | **Accepted.** The refusal is the first statement of `runCommandAndVerify`, which runs under `lock.withPermits(1)`. It does a fresh npm fetch rated against `ModelManifest.current` plus bundle and floors, and never reads the cached field. A manifest swap from any source triggers a re-rate of every snapshot (B5). The code defines `latestVersion` and `label` explicitly. Tests: manifest changed after rating, queued update re-checked after the lock, click-time fetch beats the cache (B-T7) |
| 4 | major | A 2.x server can be spawned before any version check | **Accepted, and moved in scope.** The gate lives in the single spawn site, `startOpenCodeServerProcess`, so it covers the owner (adapter and text generation), the computer-lease fallback, the probe and any future caller with one implementation (A4). It is deliberately **not cached** per binary path, because a cache would hide exactly the case of a 2.x binary swapped onto PATH. Tests: A-T5, A-T6 (`serve` is never attempted), A-T7 |
| 5 | major | A remote policy could contradict the code gate | **Accepted.** `HARD_COMPATIBILITY_FLOORS` is consulted before any manifest data, for both the installed and the latest version (B3). The test asserts that a remote "2.x supported" policy still rates 2.0.0 as unsupported; the old 7b case was replaced with a 1.x `graceful` remote override (B-T3) |
| 6 | minor | A `v`-prefixed or unparseable health version passed both gates | **Accepted.** The health version is normalised and fails closed with a clear "unrecognized version" detail (A4). Tests cover `"v2.0.18"`, `"garbage"` and `"v1.18.18"` (A-T4) |
| 7 | minor | The HTML message assumed 2.x; the claim about the local path was wrong | **Accepted.** The wording is neutral and names proxies and sign-in pages (A3). A5 states that the local spawned path is prefixed by `formatOpenCodeProbeError`, while external paths pass through unchanged |
| 8 | minor | Manifest leniency only rejected non-arrays inside an array schema | **Accepted.** The envelope uses `compatibility: Schema.optional(Schema.Unknown)`, and array checking happens in `compatibilityPoliciesOf`. Tests include `compatibility: {}` and `{ bogus: true }` (B4, B-T3, B-T4) |
| 9 | minor | The closed status set breaks lagging clients if it ever grows | **Accepted (comment option).** The contract comment says the set is frozen and that new meanings go in a new optional field (B1). B-T1 documents it |
| 10 | minor | Overloading `isProviderUpdateCandidate` causes a false success toast | **Accepted.** `isProviderUpdateCandidate` is unchanged. New `isProviderUpdateOffered` is used in `collectProviderUpdateCandidates`, the `hasOneClickUpdateProviderCandidate` guard and `ProvidersSettingsPanel.tsx:382` (B7). The progress-view test is in B-T9 |
| 11 | minor | Wrong caller list, exports convention, overlap notes | **Accepted.** The only caller is the WS `serverUpdateProvider` (B6). No new `packages/shared` export: the predicate joins the existing `providerCapabilities` subpath (B2). `reactor-errors-switch` is bug 9 and does not overlap (header) |
| 12 | minor | The parser change reaches Claude and Grok | **Accepted.** There is a Claude concatenation regression test with a `v20.1.0` stderr line (A-T1), and the Grok reach is listed under Risks |
| 13 | minor | Test gaps | **Accepted.** Added: re-rating after a manifest change (B-T5b, B-T7), refresh without Claude (B-T5b), the pre-spawn gate (A-T5/A-T6), owner retry after refusal (A-T7), `v`-prefixed and unparseable health (A-T4), and 2.x reaching the adapter and text-generation paths (A-T6 covers the shared spawn site both use). `it.effect` with TestClock is used for the preflight timeout |
| — | verdict note | Brief sub-claim: users who upgrade through Ryco get 2.x | **Refuted and reflected** in the header verdict and §1.1. The core bug is **confirmed**: a separately installed 2.x gets misleading or opaque errors, and today Ryco even spawns it |
