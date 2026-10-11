# Model manifest

Claude model metadata lives in `apps/server/src/provider/model-manifest.json`
instead of server code. The bundled copy ships with every release; at runtime
the server refreshes it from the same file on `main`
(`https://raw.githubusercontent.com/saka-gg/ryco/main/apps/server/src/provider/model-manifest.json`),
so a new Claude model can be published to every install by merging an edit to
that one file — no client release required.

Preference order at runtime: fresh remote fetch → last successfully fetched
copy on disk (`<stateDir>/model-manifest.json`) → the bundled file. A failed
or invalid fetch never fails a provider check, and an invalid remote manifest
is rejected wholesale (schema + cross-reference + Claude adapter validation)
rather than partially applied. Fetches respect the
`enableProviderUpdateChecks` server setting and are TTL-gated (1 h fresh,
5 min retry backoff after a failure).

## File format (v1)

```jsonc
{
  "version": 1,
  // Overlay classification per driver kind; kept for format parity with
  // upstream t3code. Ryco derives legacy flags from `status` below instead.
  "currentModels": { "claudeAgent": ["claude-fable-5-1", "..."] },
  "providers": {
    "claudeAgent": {
      "defaults": { "chat": "claude-opus-5" }, // marks isDefault
      "profiles": {
        "fable-5-1": {
          // Decodes against the contracts `ModelCapabilities` schema and is
          // served to clients verbatim (option descriptors for the picker).
          "capabilities": { "optionDescriptors": [/* … */] },
          // Claude-specific runtime behavior (allowlisted adapter payload):
          "adapter": {
            "claudeCode": {
              "effortMap": { "ultracode": "xhigh", "ultrathink": null },
              "modelSuffixes": { "contextWindow": { "1m": "[1m]" } },
              "contextWindowTokens": { "200k": 200000, "1m": 1000000 },
            },
          },
        },
      },
      "models": [
        {
          "slug": "claude-fable-5-1",
          "name": "Claude Fable 5.1",
          "shortName": "Fable 5.1",
          "aliases": ["fable", "fable-5.1", "claude-fable-5.1"],
          "status": "current", // "legacy" sets isLegacy
          "profile": "fable-5-1",
          // CLI version compatibility gate:
          "adapter": { "claudeCode": { "minVersion": "2.1.257" } },
        },
      ],
    },
  },
}
```

Semantics of the Claude adapter payloads:

- `effortMap` — remaps a resolved effort selection before it reaches the
  Claude CLI `--effort` flag; `null` means "pass no flag". `ultrathink` is
  always dropped regardless (prompt-prefix mode), and `ultracode` is dropped
  for models without a mapping.
- `modelSuffixes` — per-option-value api-model-id suffixes (the `[1m]`
  context-window suffix today).
- `contextWindowTokens` / `fixedContextWindowTokens` — kept for upstream
  format parity; Ryco reads live window sizes from runtime usage events.
- model `adapter.claudeCode.minVersion` / `maxVersionExclusive` — hide the
  model on incompatible Claude Code versions. The provider check surfaces an
  upgrade message naming the model with the lowest unmet minimum.

## Provider compatibility (`compatibility`)

The optional top-level `compatibility` array rates provider versions against
the running Ryco release. The bundled file seeds OpenCode:

```jsonc
"compatibility": [
  {
    "driver": "opencode",          // provider driver kind
    "rycoRange": ">=0.1.30",       // Ryco releases this policy applies to
    "ranges": [
      {
        "range": ">=2.0.0",
        "status": "unsupported",
        "message": "Ryco works with OpenCode 1.x; 2.x support is coming."
      },
      { "range": ">=1.14.19 <2.0.0", "status": "supported" }
    ]
  }
]
```

- **Ranges.** Comparator groups joined by `||`; whitespace-separated
  comparators in a group are ANDed. A comparator is `>=`, `>`, `<=`, `<`, `=`
  or no operator (meaning `=`) followed by `major[.minor[.patch]]`; missing
  segments are 0. Caret, tilde and x-ranges are not supported.
- **Policy order.** For each driver the first policy whose `rycoRange` contains
  the running Ryco version wins, so list the newest `rycoRange` first. Inside
  a policy the first matching `range` wins; a version no range matches is
  rated `unknown`.
- **Statuses.** `unknown`, `supported`, `graceful`, `unsupported`, `broken`.
  An `unsupported` or `broken` rating of a provider's **latest** version stops
  Ryco from offering that update and the server refuses to install it (it
  rates a fresh registry fetch at click time). A rating of the **installed**
  version is informational: `graceful`, `unsupported` and `broken` show their
  message as one line on the provider's settings card. The status set is
  frozen — clients decode provider lists with it — so new meanings need a new
  field, never a new status.
- **Messages.** A range's optional `message` (at most 300 characters) is
  rendered verbatim; without one Ryco uses a generic line for `graceful`,
  `unsupported` and `broken`.
- **Version normalisation.** A leading `v` and any `-prerelease` / `+build`
  suffix are ignored, so a version is rated by its release triple
  (`2.0.0-beta.1` matches `>=2.0.0`). Cursor's date versions
  (`2026.04.09-f2b0fcd`) work the same way.
- **Ryco version.** `rycoRange` is matched against the
  `apps/server/package.json` version with any nightly suffix stripped. Desktop
  and web release in lockstep with it.
- **Remote overrides.** A policy in the remote manifest replaces the bundled
  policy for the same driver only when its `rycoRange` matches the running
  release; omitting a driver keeps the bundled policy. To retract a bundled
  rating, publish an explicit overriding policy for that `rycoRange`.
- **Code-owned floors.** Limits of a build that no manifest can lift are rated
  before any policy, for both the installed and the latest version. In this
  build that is OpenCode `>=2.0.0` (always `unsupported`). The bundled
  OpenCode `>=2.0.0` range only repeats the floor for readers; a test pins the
  two together.
- **Lenient decoding.** Invalid entries are dropped one by one, and a malformed
  or non-array `compatibility` is ignored; it never rejects the manifest (and
  with it the remote Claude catalog). Older releases ignore the field.
- **Refresh.** After any provider check (not only Claude's), the server runs
  the same TTL-gated manifest refresh and re-rates every provider snapshot when
  it returns.
- **OpenCode latest versions** always come from npm `opencode-ai`, which has
  no 2.x releases (2.x ships as `@opencode/cli`). In practice an OpenCode
  policy only blocks updates when it marks a specific 1.x release.
  Homebrew and native updaters are rated from the same npm number, as a
  best-effort proxy.

Code map: `providerCompatibility.ts` (policy schema, selection, floors,
rating), `Layers/ProviderRegistry.ts` (rates snapshots, post-sync refresh),
`providerMaintenanceRunner.ts` (install refusal).

## Adding a model

1. Add a profile (or reuse one) and a `models` entry with the version gate.
2. Validate locally: `bun run test src/provider/ModelManifest.test.ts
   src/provider/ClaudeModelCatalog.test.ts` in `apps/server` (the first test
   decodes the bundled file).
3. Merge to `main`. Running installs pick it up on their next provider check
   after the TTL window; releases bundle it.

Code map: `ModelManifest.ts` (schema, fetch/cache service),
`ClaudeModelManifest.ts` (adapter payload schemas), `ClaudeModelCatalog.ts`
(catalog resolution, version gating, effort/suffix mapping, and the active
catalog used by adapter-side call sites), `Layers/ClaudeProvider.ts`
(provider check + backwards-compatible wrappers).
