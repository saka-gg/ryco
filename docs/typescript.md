# TypeScript tooling

Every workspace package typechecks with `effect-tsgo tsrs --noEmit` from
`@effect/tsgo`. That runs [tsrs](https://github.com/oxc-project/tsrs), the Rust
TypeScript 7 checker, with Effect's diagnostics built in, so one command reports
both the standard TypeScript diagnostics and the Effect diagnostics configured
by the `@effect/language-service` plugin entry.
The binary ships in the `@effect/tsgo-<platform>` package; nothing is patched in
`node_modules`, and the repo installs no `typescript` package.

| Command                 | What it runs                                               |
| ----------------------- | ---------------------------------------------------------- |
| `bun typecheck`         | tsrs + Effect in every package (Turbo-cached); the CI gate |
| `bun run check`         | Format check, lint errors and `bun typecheck`              |
| `bun run check:changed` | The same checks plus the tests the change affects          |

`@effect/tsgo` is pinned exactly in the root catalog and installed once at the
root; package scripts find `effect-tsgo` on the root `node_modules/.bin`. Each
release bundles one tsrs build and the TypeScript version it tracks
(`effect-tsgo tsrs --version`), so upgrading `@effect/tsgo` upgrades the
checker. `marketing/`, a separate project with its own lockfile, pins its own
`@effect/tsgo` and runs the same `effect-tsgo tsrs --noEmit` in its `typecheck`
and `build` scripts; keep the two pins aligned. Suggestion-level Effect diagnostics are hidden in CLI runs
(`includeSuggestionsInTsc: false`) to keep the gate actionable; errors and
configured warnings still fail it.

When upgrading `@effect/tsgo`, watch for deprecated rule names: tsrs reports a
`deprecatedRuleName` warning for each one in a tsconfig (for example
`preferSchemaOverJson` became `globalJsonInEffect` and `globalJson`), and the
same names in `@effect-diagnostics` suppression comments silently stop matching.

`apps/web`, `apps/server` and `apps/desktop` are `composite` projects, so tsrs
also checks that their exported types can be written to declaration files, even
under `--noEmit` (TypeScript 7 only does that when it emits). A `TS2883` or
`TS5088` there usually means an exported value's inferred type reaches a type
that is not exported: export the type, or annotate the value with an exported
alias.

## Effect diagnostics

The plugin entry and its rule severities live in one place,
`tsconfig.effect.json` at the root. `tsconfig.base.json` extends it, so every
package that extends the base (directly or through `tsconfig.node.json`)
inherits it. `apps/mobile` extends Expo's base instead of ours, so it lists both:
`"extends": ["expo/tsconfig.base", "../../tsconfig.effect.json"]`. A tsconfig
without the entry runs no Effect diagnostics at all, so new packages should
extend one of the root configs.

A tsconfig's own `plugins` list replaces the inherited one instead of merging
with it. Only `apps/server` sets its own: it repeats the shared rules and turns
off `globalJsonInEffect` and `globalErrorInEffectFailure` as well. `marketing/`
has no Effect dependency and no plugin entry.

The `unstableApiUsage` and `experimentalApiUsage` rules are off in every
project. Effect marks its platform modules (`FileSystem`, `Path`, SQL, RPC,
HTTP, CLI, `@effect/vitest`) as `@stability unstable`, so the warning would
cover most of the codebase without telling us anything. Enabling either rule
also made tsgo 0.47–0.51 report false `TS2790` errors when deleting
index-signature properties such as `process.env.NAME`. Recheck both rules when
upgrading `@effect/tsgo`.

## Editor

VS Code's TypeScript 7 extension (`TypeScriptTeam.native-preview`) starts the
same tsrs binary as its language server: `.vscode/settings.json` points
`js/ts.tsdk.path` at `.vscode/tsdk`, whose `tsgo` script execs the binary from
the installed `@effect/tsgo-<platform>` package. It is a POSIX script, so on
Windows open the workspace through WSL. VS Code asks once to allow the
workspace TypeScript version.

## Caching and incremental checks

Every package's program compiles its workspace dependencies from source (their
`exports` point at `src`, and no tsconfig uses project references), so no check
needs another to finish first: all packages check in parallel. `typecheck`
depends on `typecheck:deps`, a task no package defines a script for. It never
runs; it only threads every workspace dependency's file hash into each package's
cache key, so editing `@ryco/contracts` re-checks every consumer instead of
replaying a cached pass. That chain only covers declared workspace dependencies,
so files a program reaches by relative path are listed as extra inputs. The
server's tsconfig also includes `scripts/lib`, and its `scripts/cli.ts` imports
the root `package.json`, so `apps/server/turbo.jsonc` adds both to the server's
inputs. The other way round, a few scripts import server and client-runtime
sources and the root, server and desktop `package.json` files, which
`scripts/turbo.jsonc` lists. Root tsconfigs, the root `vitest.*.ts` files the
packages' Vitest configs import, and `patches/**` are global dependencies. The
checker itself is a root dependency, which Turbo hashes into every task, so
upgrading `@effect/tsgo` re-checks every package.

On a cache miss tsrs re-checks incrementally. The composite packages are
incremental by default, and the others pass `--incremental`, so tsrs keeps each
program's build info in a `tsconfig*.tsbuildinfo` next to it. The build info
records the checker version including the `@effect/tsgo` release, so an upgrade
starts from scratch. All build info is gitignored, so it never enters a Turbo
hash, and CI checkouts always check from scratch.
