# Scripts

- `bun run dev` — Starts contracts, server, and web through the dev runner/Turbo.
- `bun run dev:server` — Starts just the HTTP/WebSocket server package in watch mode.
- `bun run dev:web` — Starts just the Vite dev server for the web app.
- In the main checkout, dev commands use `~/.ryco`, with their state in `~/.ryco/dev`. In a
  linked git worktree they use `<worktree>/.ryco-dev` (see below). `--home-dir <dir>` or
  `RYCO_HOME` overrides both, for example `bun run dev --home-dir /tmp/ryco-scratch`. Arguments
  after `--` go to Turbo, not to the server.
- `bun run start` — Runs the production server (serves built web app as static files).
- `bun run build` — Builds workspace packages and apps through Turbo.
- `bun run typecheck` — Strict TypeScript checks for all packages.
- `bun run test` — Runs workspace tests.
- `bun run dist:desktop:artifact -- --platform <mac|linux|win> --target <target> --arch <arch>` — Builds a desktop artifact for a specific platform/target/arch. macOS accepts only `arm64`; Linux and Windows accept `x64` or `arm64`.
- `bun run dist:desktop:dmg` — Builds a shareable Apple Silicon (`arm64`) macOS `.dmg` into `./release`. Intel and universal Mac builds are not supported.
- `bun run dist:desktop:linux` — Builds a Linux AppImage into `./release`.
- `bun run dist:desktop:win` — Builds a Windows NSIS installer into `./release`.

## Desktop `.dmg` packaging notes

- Default build is unsigned/not notarized for local sharing.
- The DMG build uses `assets/macos-icon-1024.png` as the production app icon source.
- Desktop production windows load the bundled UI from `ryco://app/index.html` (not a `127.0.0.1` document URL).
- Desktop packaging includes `apps/server/dist` (the `ryco` backend) and starts it on loopback with an auth token for WebSocket/API traffic.
- Your tester can still open it on macOS by right-clicking the app and choosing **Open** on first launch.
- To keep staging files for debugging package contents, run: `bun run dist:desktop:dmg -- --keep-stage`
- To allow code-signing/notarization when configured in CI/secrets, add: `--signed`.
- Windows `--signed` uses Azure Trusted Signing and expects:
  `AZURE_TRUSTED_SIGNING_ENDPOINT`, `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`,
  `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`, and `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`.
- Azure authentication env vars are also required (for example service principal with secret):
  `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`.

## Running multiple dev instances

Each linked git worktree gets its own dev server state and ports, so dev servers of several
worktrees run side by side and a migration on one branch never breaks the others.

- **State**: `bun run dev`, `dev:server` and `dev:desktop` in a linked worktree keep everything in
  `<worktree>/.ryco-dev` (gitignored), with the database in `<worktree>/.ryco-dev/dev`. The main
  checkout keeps `~/.ryco`. An explicit `--home-dir` or `RYCO_HOME` wins.
- **Ports**: the main checkout prefers server `13773` and web `5733`. A linked worktree prefers
  `base + offset`, with the offset hashed from the worktree's path, so its ports stay the same
  between starts. A busy port, or one browsers refuse to open (the Fetch standard's blocked ports,
  such as 6000), moves the pair to the next free offset. `RYCO_DEV_INSTANCE=<name>` (hashed) or
  `RYCO_PORT_OFFSET=<n>` still picks another preference, for example
  `RYCO_DEV_INSTANCE=branch-a bun run dev:desktop`.
- **Read the real values from the `[dev-runner]` line** each start prints: the ports, the home and
  where it came from (`worktree`, `explicit` or `default`). `--dry-run` prints it without starting
  anything.
- **First start**: an empty worktree home is seeded from a pruned copy of the main dev database
  (`~/.ryco/dev/state.sqlite`, opened read-only), migrated to the worktree's schema. It keeps every
  repository project and, per project, the 10 most recently updated settled threads with their
  subagents and forks, plus `keybindings.json` and project avatars. It drops chats, archived,
  trashed, running, pending and usage-limited threads, and everything that would let the worktree's
  server act on its own: sessions and pairings, provider runtime state, automations, MCP
  installations, restart continuations, storage ownership and worktree relocation journals.
  Settings, secrets, Hub identity and attachments are not copied. A source whose schema is newer
  than the worktree's, or that recorded a migration number under another branch's name, is not
  copied, and the server starts empty instead. Seeding never reads `~/.ryco/userdata`.
  - `--no-seed` or `RYCO_DEV_SEED=0` starts empty; `RYCO_DEV_SEED_SOURCE=<path>` seeds from another
    dev database. Explicit homes (`--home-dir`, `RYCO_HOME`) are never seeded.
  - To seed again, stop the worktree's dev server, delete `<worktree>/.ryco-dev/dev/state.sqlite*`
    and start it again.
  - Seeded threads point at the same project checkouts as your main dev home. Deleting a workspace
    or removing a checkout from the worktree's UI does that on disk.
- **Pairing**: pair each worktree home once per browser profile with the pairing link its server
  prints at start. Each dev home names its session cookie after its state directory, so pairing one
  worktree never signs the browser out of another. Browser sessions of every dev home other than
  `~/.ryco` (a worktree's, or one set with `--home-dir`/`RYCO_HOME`) last 7 days. If every
  local server answers `431 Request Header Fields Too Large`, the browser holds too many `localhost`
  cookies: clear them. For another pairing link, run the worktree's own CLI from that worktree:
  `node apps/server/src/bin.ts auth pairing create --base-dir <worktree>/.ryco-dev --dev-url <web url>`
  (not a globally installed `ryco`, which may migrate the worktree's database to another schema).
- **Desktop Dev** runs one at a time (Electron's `userData` and single-instance lock are shared).
  In a worktree its backend state, Hub sign-in and saved environments are per worktree; signing in
  to the Hub there registers a new node. `--home-dir ~/.ryco` keeps the shared catalog for Hub work.
- **Removing a worktree** removes its dev home too, including managed worktrees its dev server
  created under `<worktree>/.ryco-dev/worktrees`, with any uncommitted changes in them. Their repos
  keep prunable registrations (`git worktree prune`). `git clean -fdx` also deletes the dev home.
- **Agents and nested runs**: a dev server passes its environment to its agents. The runner marks
  that environment (`RYCO_DEV_RUNNER_ROOT`, with the values it handed out in
  `RYCO_DEV_RUNNER_ENV`), so `bun dev` run by an agent ignores the inherited home, ports and URLs
  and picks its own. A setting changed in the agent's shell, such as
  `RYCO_HOME=/tmp/x bun run dev`, is kept.
