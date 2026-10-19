# AGENTS.md

## Task Completion Requirements

- Use the Bun version pinned in `package.json` and install with `bun install --frozen-lockfile`.
- Validation must be proportional to the size and risk of the change.
- For small, localized edits, run only focused checks that cover the changed files or affected
  package. Do not run the full repository test suite, a full build, or unrelated package checks.
- Run the full repository backstop only for very large, cross-cutting, or high-risk changes that
  materially affect multiple packages or major runtime boundaries:

  ```sh
  bun fmt
  bun run fmt:check
  bun lint
  bun typecheck
  bun run test
  bun run build
  ```

- NEVER run `bun test`. Always use `bun run test` (runs Vitest).
- For very large or high-risk changes to web interaction, responsive layout, PWA behavior, browser
  lifecycle, or hosted reconnect behavior, also build the web package and run the browser suite:

  ```sh
  bun run build --filter=@ryco/web
  bun run --cwd apps/web test:browser
  ```

  Install the pinned Playwright browser runtime first with
  `bun run --cwd apps/web test:browser:install` when it is not already present.

- Run `bun run build:desktop` for large or high-risk desktop pipeline changes and
  `bun run release:smoke` for large or high-risk release-workflow changes. CI may path-scope these
  jobs, but local validation should remain proportional to the affected surface.

## TypeScript

Typechecking uses the native **TS7** compiler patched by `@effect/tsgo`, so `bun typecheck`
enforces both TypeScript and Effect-specific diagnostics in one pass. See
[docs/typescript.md](docs/typescript.md) for the toolchain details.

## Project Snapshot

Ryco is a minimal web GUI for using coding agents including Codex, Claude, GitHub Copilot, OpenCode, and Cursor.

This repository is a VERY EARLY WIP. Proposing sweeping changes that improve long-term maintainability is encouraged.

## Core Priorities

1. Performance first.
2. Reliability first.
3. Keep behavior predictable under load and during failures (session restarts, reconnects, partial streams).

If a tradeoff is required, choose correctness and robustness over short-term convenience.

## Maintainability

Long term maintainability is a core priority. If you add new functionality, first check if there is shared logic that can be extracted to a separate module. Duplicate logic across multiple files is a code smell and should be avoided. Don't be afraid to change existing code. Don't take shortcuts by just adding local logic to solve a problem.

## Hosted Hub and PWA Boundaries

- Hosted Hub lifecycle recovery has one authoritative owner. A hosted browser must revalidate its
  session and authorized directory state, create a fresh relay attempt, and accept a current shell
  snapshot before mutation capability becomes available. Selecting an environment whose
  per-environment session completed its own fresh relay attempt and accepted its own current shell
  snapshot, and has not been suspended or interrupted since, adopts that session; the rule above
  governs establishing and recovering a session. The adoption rule lives in one function
  (`canAdoptHostedEnvironmentSession`).
- Generic direct/saved-environment reconnect helpers must not race or bypass hosted lifecycle
  ownership. Stale generations cannot publish readiness, role, snapshots, or mutation authority.
- The production hosted service worker is a static-shell availability mechanism, not a data plane.
  Never cache authenticated APIs, RPC, relay traffic, tickets, proofs, credentials, node-owned
  content, request bodies, or live application documents.
- Mobile presentation may adapt substantially, but authentication, relay, synchronization,
  application state, and mutation-readiness policy remain shared. Do not fork those security or
  lifecycle decisions into a second mobile implementation.
- There are now two phone surfaces and they are not equals. `apps/mobile` is the intended phone
  experience; `apps/web`'s `phone:` presentation tier is frozen behind a flag with a get-the-app
  interstitial and stays until native reaches parity. Do not extend the web phone tier, and do not
  delete it either — its removal is a separate approved change.
- Keep this public repository free of private Hub issue links, deployment identifiers,
  infrastructure details, credentials, private operational policies, and qualification evidence.

## Package Roles

- `apps/server`: HTTP/WebSocket backend and `ryco-cli` package. Serves the React app, owns provider sessions, orchestration, persistence, terminals, git/source-control operations, auth, and remote/pairing endpoints.
- `apps/web`: React/Vite UI. Owns session UX, conversation/event rendering, settings, project/source-control views, and client-side state. Connects to one or more Ryco servers over WebSocket.
- `apps/desktop`: Electron shell. Starts a desktop-scoped backend process, wires desktop APIs such as file dialogs/updates/SSH prompts, and loads the shared web app.
- `apps/mobile`: Expo / React Native native app (iOS first). Consumes `packages/client-runtime` and owns only its platform adapters, native modules, and screens. It is a separate client, not a second runtime.
- `packages/contracts`: Shared Effect Schema schemas and TypeScript contracts for RPC, provider events, orchestration, settings, model/session types, keybindings, source control, and work items. Keep this package schema-only — no runtime logic.
- `packages/shared`: Shared runtime utilities consumed by both server and web. Uses explicit subpath exports (e.g. `@ryco/shared/git`) — no barrel index.
- `packages/client-runtime`: The shared client runtime for web, desktop, and mobile. Owns the `platform` service contracts each app provides, the rpc transport, connection catalog/supervision, authorization (cookie and DPoP bearer modes, `HostedHubApi`), the relay client, and the `state/*` domains. No DOM or React Native imports may enter this package.
- `packages/effect-codex-app-server`: Effect-based Codex app-server JSON-RPC protocol/client wrapper.
- `packages/effect-acp`: Effect-based Agent Client Protocol schema/client/agent helpers used by ACP providers.
- `packages/ssh`: SSH config/auth/command/tunnel utilities for desktop-managed remote access.
- `packages/tailscale`: Tailscale endpoint and Serve helpers for remote access.

## Provider Runtime Architecture (Important)

Ryco supports multiple provider drivers: Codex, Claude, GitHub Copilot, OpenCode, and Cursor. Provider instances are configured through `ServerSettings.providerInstances`; each instance has a stable `ProviderInstanceId`, driver-specific config, optional environment variables, display name, accent color, and enabled state.

Current provider runtime shape:

- Built-in drivers are registered in `apps/server/src/provider/builtInDrivers.ts`.
- Driver-specific adapters live under `apps/server/src/provider/Drivers/*Driver.ts` and `apps/server/src/provider/Layers/*Adapter.ts`.
- Provider instance construction and hot reload are coordinated by `apps/server/src/provider/Layers/ProviderInstanceRegistryLive.ts`.
- Turn/session lifecycle is brokered by `apps/server/src/provider/Layers/ProviderService.ts`.
- Provider runtime events are projected into orchestration by `apps/server/src/orchestration/Services/ProviderRuntimeIngestion.ts`, `ProviderCommandReactor.ts`, `CheckpointReactor.ts`, and `OrchestrationEngine.ts`.
- WebSocket RPC and push streams are routed in `apps/server/src/ws.ts`; orchestration updates are consumed by the web app through the RPC client in `apps/web/src/rpc/`.

Provider protocol notes:

- Codex uses `codex app-server` via JSON-RPC over stdio, wrapped by `packages/effect-codex-app-server`.
- Claude uses the Anthropic Claude Agent SDK.
- Copilot, OpenCode, and Cursor are implemented as first-party drivers; Cursor uses ACP, and shared ACP helpers live in `packages/effect-acp`.

Docs:

- Codex App Server docs: https://developers.openai.com/codex/sdk/#app-server
- Provider user guides: `docs/providers/codex.md`, `docs/providers/claude.md`

## Reference Repos

- Open-source Codex repo: https://github.com/openai/codex
- Codex-Monitor (Tauri, feature-complete, strong reference implementation): https://github.com/Dimillian/CodexMonitor

Use these as implementation references when designing protocol handling, UX flows, and operational safeguards.
