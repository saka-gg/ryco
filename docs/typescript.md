# TypeScript tooling

Ryco uses **TypeScript 7** for typechecking. During dependency installation,
`@effect/tsgo` patches the native compiler with its matching Effect-enabled TS7
binary. The normal `bun typecheck` command therefore emits both standard
TypeScript diagnostics and the Effect diagnostics configured in each project's
`tsconfig.json`.

| Command                  | Compiler                       | When to run                                          |
| ------------------------ | ------------------------------ | ---------------------------------------------------- |
| `bun typecheck`          | TS7 (`tsc`, patched by Effect) | The authoritative local and CI gate                  |
| `bun run typecheck:fast` | `tsc-rs` (Rust port of TS7)    | Fast pre-check while iterating                       |
| `bun run check`          | `tsc-rs`                       | Format check, lint errors and `typecheck:fast`       |
| `bun run check:changed`  | TS7                            | Format, lint, `bun typecheck` and the affected tests |

The `@effect/tsgo` version is pinned alongside TypeScript because its binary is
built against a specific TypeScript release. Keep the pair aligned when either
dependency changes.

`tsc-rs` is an experimental Rust port of the TS7 checker with the Effect
diagnostics built in (ported from `@effect/tsgo`). It reads the same
`@effect/language-service` plugin entry, so it reports the same TypeScript and
Effect diagnostics roughly 3–5x faster. It tracks TypeScript 7.1-dev, so if the
two ever disagree, `bun typecheck` wins. The composite packages (web, server,
desktop) run it with `--composite false --declaration false`, which skips two
declaration-emit reports (TS5088 in `apps/server/src/cli.ts`) that TS7 does not
raise. Pin `tsc-rs` exactly and recheck parity when upgrading it, TypeScript, or
`@effect/tsgo`. Suggestion-level Effect diagnostics are hidden in CLI runs
to keep the gate actionable; errors and configured warnings still fail it.

The `unstableApiUsage` and `experimentalApiUsage` rules are off in every
project. Effect marks its platform modules (`FileSystem`, `Path`, SQL, RPC,
HTTP, CLI, `@effect/vitest`) as `@stability unstable`, so the warning would
cover most of the codebase without telling us anything. Enabling either rule
also makes tsgo 0.47–0.51 report false `TS2790` errors when deleting
index-signature properties such as `process.env.NAME`. Recheck both rules when
upgrading `@effect/tsgo`.

## Caching and incremental checks

Every package's program compiles its workspace dependencies from source (their
`exports` point at `src`, and no tsconfig uses project references), so no check
needs another to finish first: all packages check in parallel. Both
`typecheck` and `typecheck:fast` depend on `typecheck:deps`, a task no package
defines a script for. It never runs; it only threads every workspace
dependency's file hash into each package's cache key, so editing
`@ryco/contracts` re-checks every consumer instead of replaying a cached pass.
That chain only covers declared workspace dependencies, so files a program
reaches by relative path are listed as extra inputs. The server's tsconfig also
includes `scripts/lib`, and its `scripts/cli.ts` imports the root `package.json`,
so `apps/server/turbo.jsonc` adds both to the server's inputs. The other way
round, a few scripts import server and client-runtime sources and the root,
server and desktop `package.json` files, which `scripts/turbo.jsonc` lists. Root
tsconfigs, the root `vitest.*.ts` files the packages' Vitest configs import, and
`patches/**` are global dependencies.

On a cache miss both checkers re-check incrementally. The composite packages
are incremental by default, and the others pass `--incremental`, so TS7 keeps
each program's build info in a `tsconfig*.tsbuildinfo` next to it. The build
info records the compiler version including the `@effect/tsgo` release, so an
upgrade of either starts from scratch. `tsc-rs` writes its own build info to
`.turbo/tsc-rs*.tsbuildinfo` in each package, so the two never read each
other's. Its build info records only the TypeScript version it tracks, so delete
those files after upgrading `tsc-rs`. All build info is gitignored, so it never
enters a Turbo hash, and CI checkouts always check from scratch.
