# Release Checklist

This document covers the unified release workflow for stable and nightly desktop releases.

## What the workflow does

- Workflow: `.github/workflows/release.yml`
- Trigger: manual `workflow_dispatch` with a channel (`stable` or `nightly`); stable releases also take the version.
- Resolves the version first. Builds and Verify wait for it, so an invalid version, a stable release without one, or a version already on npm stops the run before they start.
- Verify runs alongside the builds: `.github/workflows/_validation.yml` at the release commit (format, lint, typecheck, unit tests, the build, the mobile bundle and release smoke). It skips the desktop build, because the build legs produce the real artifacts, and it skips browser tests, as the release preflight did before.
  - Verify is skipped when a successful `ci.yml` run on `main` exists for the same SHA: that run covered a superset of these checks. Releases from any other branch always run Verify.
  - Nothing is published unless Verify passed or was skipped for that reason.
- Builds five artifacts in parallel for both channels:
  - macOS `arm64` DMG
  - Linux `x64` AppImage
  - Linux `arm64` AppImage
  - Windows `x64` NSIS installer
  - Windows `arm64` NSIS installer
- Uploads one GitHub Release with all produced files as a draft while the CLI is published to npm, replacing any stale draft from an earlier attempt. The draft is published, which creates the tag, only after npm publish succeeds.
  - Stable tags with a suffix after `X.Y.Z` (for example `1.2.3-alpha.1`) are published as GitHub prereleases.
  - Only plain stable `X.Y.Z` releases are marked as the repository's latest release.
  - Nightly runs are always GitHub prereleases and never marked latest.
  - Automatically generated release notes are pinned to the previous tag in the same channel, so stable compares to the previous stable tag and nightly compares to the previous nightly tag.
- Includes Electron auto-update metadata (for example `latest*.yml`, `nightly*.yml`, and `*.blockmap`) in release assets.
- Publishes the CLI package (`apps/server`, npm package `ryco-cli`) with OIDC trusted publishing from the same workflow file:
  - stable releases publish npm dist-tag `latest`
  - nightly releases publish npm dist-tag `nightly`
- Signing is optional and auto-detected per platform from secrets.

The Windows x64 job defaults to `windows-2025`. To use a prepared self-hosted
Windows x64 runner, set the repository Actions variable `WINDOWS_X64_RUNNER` to
its dedicated runner label. Clear the variable to restore the hosted default.
The runner needs Git, PowerShell, MSVC Build Tools, the Windows SDK, and Rustup;
the workflow installs the pinned Node, Bun, and Rust versions. Other matrix jobs
and npm trusted publishing retain their existing runners.

## Nightly builds

- Workflow: `.github/workflows/release.yml`
- Trigger: manual `workflow_dispatch` with `channel=nightly` (there is no schedule).
- Runs the same Verify gate (including CI reuse) and artifact matrix as the stable release flow.
- Publishes a GitHub prerelease only:
  - tag format: `nightly-vX.Y.Z-nightly.YYYYMMDD.<run_number>`
  - release name includes the short commit SHA
  - `make_latest` is always `false`
- Uses the next stable patch version as the nightly base. For example, `0.0.17` produces nightlies on `0.0.18-nightly.*`.
- Publishes Electron auto-update metadata to the dedicated `nightly` updater channel, so desktop users can opt into that track independently from stable.
- Publishes the CLI package (`apps/server`, npm package `ryco-cli`) to the `nightly` npm dist-tag using the same nightly version.
- Does not commit version bumps back to `main`.

## Ryco Nightly

Nightly desktop builds become their own app, **Ryco Nightly**, installed next to Ryco with
nothing shared. Trying a nightly then never touches the workspace the stable app keeps, and moving back never
downgrades a binary over a database a newer one migrated.

|                                                    | Ryco                           | Ryco Nightly                                 |
| -------------------------------------------------- | ------------------------------ | -------------------------------------------- |
| Bundle id (`appId`; NSIS derives its GUID from it) | `com.laurinfrank.ryco`         | `com.laurinfrank.ryco.nightly`               |
| Data home                                          | `~/.ryco` (`RYCO_HOME`)        | `~/.ryco-nightly` (`RYCO_NIGHTLY_HOME` only) |
| Electron profile and single-instance lock          | `ryco`                         | `ryco-nightly`                               |
| Hosted sign-in callback scheme                     | `ryco://`                      | `ryco-preview://`                            |
| Update channel                                     | `latest`, stable versions only | `nightly`, nightly versions only             |
| Release file names                                 | `Ryco-<version>-…`             | `Ryco-Nightly-<version>-…`                   |
| First backend port, Tailscale Serve port           | 7926, 443                      | 7936, 8443                                   |

- The identity table lives in `packages/shared/src/desktopFlavor.ts`. The build writes the flavor
  into the packaged `package.json` (`rycoDesktopFlavor`), so the running app cannot lose it.
- Each app takes only versions of its own channel and only files with its own name prefix, and
  `allowDowngrade` is off for both. There is no update-track switch any more: moving between them
  means opening the other app. The default backend and Tailscale Serve ports differ, so both run
  at once without taking each other's renderer origin or tailnet address.
- Ryco Nightly is a separate node: its own environment id, Hub enrollment and E2EE keys follow from
  its own data home. Its backend, MCP bridge and other CLI children get `RYCO_HOME` pinned to that
  home, so a `RYCO_HOME` exported in a login shell never points it at Ryco's data.
- The unsigned macOS installer refuses a downloaded bundle whose id differs from the running app's.
- Features that ship only in Nightly are listed in `NIGHTLY_ONLY_FEATURES`
  (`packages/shared/src/nightlyFeatures.ts`). The node is authoritative, from its own version.
- CLI nodes keep the in-place npm `nightly` dist-tag.

### Copying Ryco's data into Ryco Nightly

In the app: **Settings → General → About → Ryco Nightly**. On Ryco (macOS) it finds Ryco Nightly in
`/Applications` or `~/Applications` (only a real bundle whose `Info.plist` names
`com.laurinfrank.ryco.nightly`), and offers **Open Ryco Nightly** and **Copy my data and open**
(refused while Nightly's node runs or when the two data folders overlap, after a confirmation).
Before opening, Ryco checks Nightly's code signature: signed by Ryco's own team and as
`com.laurinfrank.ryco.nightly` (a development build of Ryco, unsigned itself, skips this). Ryco
opens Nightly through macOS (`open -a … --env …`) with the login session's environment plus only
`RYCO_STABLE_HOME`, `RYCO_STABLE_EXECUTABLE`, `RYCO_NIGHTLY_HOME` when Ryco has one, and for a copy
`RYCO_FLAVOR_IMPORT_TOKEN`. Without Ryco Nightly installed, **Get Ryco Nightly** opens the
releases page; installing it from inside the app is a later step. On Ryco Nightly, **Switch back to
Ryco** opens Ryco the same way and copies nothing back, and the row says how the last copy went.

Ryco can ask Ryco Nightly for a copy of its data. Ryco writes `import-requested.json` into
Nightly's home; Nightly's backend takes the copy on its next start, before it opens its database,
and reports the outcome in `import-result.json` beside it (`packages/shared/src/flavorImport.ts`,
`apps/server/src/flavorImport/`). Nothing is ever written into Ryco's home.

- Nightly copies only from the home Ryco handed over when it opened Nightly (`RYCO_STABLE_HOME`),
  else `~/.ryco`, and never from its own. Links are refused, and a request older than an hour is
  dropped without copying.
- Nightly takes only the request of the launch that opened it: the request and the launch carry the
  same one-time token, which Nightly's desktop app takes out of its environment at start and hands
  to its backend. A request written while Nightly was already open is refused, never taken later.
- It copies the database (a live `VACUUM INTO`, as `ryco db backup` takes it), `settings.json`,
  `keybindings.json`, `attachments/` and `task-files/`, and nothing else: never the node identity,
  environment id, Hub state, secrets, saved connections, logs, backups or runtime files. Nightly
  stays a node of its own and enrolls with the Hub by itself.
- The copy is migrated to Nightly's schema, then scrubbed by a table policy
  (`flavorImportTablePolicy.ts`; a new table must be classified there). Sessions, pairing links,
  Agent Control integrations, Atlassian connections, pull request watches, follow-up queues,
  restart continuations, provider session bindings and storage ownership are cleared; schedules
  and chat goals are paused; unfinished proposals, operations and hand-offs are cancelled. A Ryco
  database newer than Nightly is refused ("Update Ryco Nightly, then copy again").
- Nightly's previous data is replaced only once everything is copied; a failed move puts it back.

### Rolling it out (`RYCO_DESKTOP_NIGHTLY_IDENTITY`)

Before the split, nightly builds used the stable app's identity and data ("Ryco (Nightly)"). The
release workflow reads the repository variable `RYCO_DESKTOP_NIGHTLY_IDENTITY` to decide how a
nightly is packaged:

1. `legacy` (the default while the variable is unset): the nightly keeps the stable identity. The
   first nightly after the split is the **bridge**: it carries the new code, so in-place nightly
   installs stop following nightlies and move to the next stable release, which installs over them
   as an ordinary update (a nightly's base is the next stable patch).
2. `separate`: nightlies build Ryco Nightly. Set the variable once in-place nightly installs have
   taken the bridge (we suggest waiting about a week). **Keep it set from then on**: going back to
   `legacy` would publish stable-identity nightlies again. Ryco Nightly ignores their files (wrong
   name prefix), but anyone still on an in-place nightly would follow them.

An in-place install that never took the bridge and meets a `separate` nightly keeps its data, but
not always its app. A signed macOS update fails the code-signature requirement, and Windows installs
a second app (new GUID). Builds from before the bridge have no bundle-id check, though, so an
unsigned macOS app or a Linux AppImage is replaced by Ryco Nightly. `~/.ryco` stays as it was;
install Ryco again from the releases page to use it.

Known overlaps, left for later:

- The bridge and Ryco Nightly both use the `ryco-preview://` sign-in callback (the Hub allows only
  that one for nightlies). With both installed, the one that registered last receives the callback,
  and the other's hosted sign-in fails until it is opened again.
- SSH machines: both apps install their CLI into the remote's `~/.ryco` and share its managed
  server; a remote home per app is a follow-up.

## Desktop auto-update notes

- Runtime updater: `electron-updater` in `apps/desktop/src/main.ts`.
- Update UX:
  - Each app follows one channel (see "Ryco Nightly"); there is no update-track switch.
  - Background checks run on startup delay (15 s) + interval (4 h).
  - By default, no automatic download or install. The desktop UI shows a rocket update button when an update is available; click once to download, click again after download to restart/install.
  - With the node setting **Update automatically** on (`automaticUpdates`, owner only, together
    with update checks), the startup and interval checks also download what they find. The
    backend tells Desktop main with an `app-update-policy` frame on its private pipe; nothing
    else can set it, and it turns off while no backend reports it. Windows (NSIS) and Linux
    AppImage then install the download when the app quits normally, silently and without
    starting it again (`autoInstallOnAppQuit`). macOS never installs at quit: Squirrel.Mac stages
    an armed update irreversibly and the unsigned installer replaces the bundle, so the download
    waits for **Restart**. A version whose download or install failed is not downloaded or armed
    again in the background. Development builds never update themselves.
  - Every install writes `desktop-update-install.json` in the state directory; the next launch
    says "Updated to X", or, when still on the old version, skips that version in the background.
- Provider: GitHub Releases (`provider: github`) configured at build time.
- Repository slug source:
  - `RYCO_DESKTOP_UPDATE_REPOSITORY` (format `owner/repo`), if set.
  - otherwise `GITHUB_REPOSITORY` from GitHub Actions.
- Temporary private-repo auth workaround:
  - set `RYCO_DESKTOP_UPDATE_GITHUB_TOKEN` (or `GH_TOKEN`) in the desktop app runtime environment.
  - the app forwards it as an `Authorization: Bearer <token>` request header for updater HTTP calls.
- Required release assets for updater:
  - platform installers (`.exe`, `.dmg`, `.AppImage`, plus macOS `.zip` for Squirrel.Mac update payloads)
  - channel metadata: `latest*.yml` for stable releases, `nightly*.yml` for nightly releases
  - `*.blockmap` files (used for differential downloads)
- macOS metadata note:
  - `electron-updater` reads `latest-mac.yml` on stable and `nightly-mac.yml` on nightly for the Apple Silicon build.

## 0) npm OIDC trusted publishing setup (CLI)

The workflow publishes the CLI with `npm publish` from `apps/server` after bumping
the package version to the release tag version.

Checklist:

1. Confirm npm org/user owns package `ryco-cli`.
2. In npm package settings, configure Trusted Publisher:
   - Provider: GitHub Actions
   - Repository: this repo
   - Workflow file: `.github/workflows/release.yml`
   - Environment (if used): match your npm trusted publishing config
3. Ensure npm account and org policies allow trusted publishing for the package.
4. Create release tag `vX.Y.Z` and push; workflow will:
   - set `apps/server/package.json` version to `X.Y.Z`
   - build web + server
   - run `npm publish --access public --tag latest`
5. Nightly runs from the same workflow file publish with `npm publish --access public --tag nightly`.

## 1) Dry-run release without signing

Use this first to validate the release pipeline.

1. Confirm no signing secrets are required for this test.
2. Create a test tag:
   - `git tag v0.0.0-test.1`
   - `git push origin v0.0.0-test.1`
3. Wait for `.github/workflows/release.yml` to finish.
4. Verify the GitHub Release contains all platform artifacts.
5. Download each artifact and sanity-check installation on each OS.

## 2) Apple signing + notarization setup (macOS)

### Local development without distribution credentials

On macOS, the launcher and local artifact builder reuse an existing valid
`Apple Development` identity when all matching certificates belong to one
developer. Xcode certificate renewals with the same name are resolved by exact
certificate hash, so duplicate display names do not break signing. No private
key is exported and no certificate is created by the build.

This keeps a stable code identity across local rebuilds and lets Keychain retain
its access decision. A first launch or a transition from an ad-hoc build can
still require macOS consent. Local signing does not notarize the app or provide
public distribution trust. If no unambiguous development identity exists, the
ordinary unsigned build remains ad-hoc; CI does not automatically select a
developer's local identity.

### Signed and notarized distribution

Required secrets used by the workflow:

- `CSC_LINK`
- `CSC_KEY_PASSWORD`
- `APPLE_API_KEY`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`

Checklist:

1. Apple Developer account access:
   - Team has rights to create Developer ID certificates.
2. Create `Developer ID Application` certificate.
3. Export certificate + private key as `.p12` from Keychain.
4. Base64-encode the `.p12` and store as `CSC_LINK`.
5. Store the `.p12` export password as `CSC_KEY_PASSWORD`.
6. In App Store Connect, create an API key (Team key).
7. Add API key values:
   - `APPLE_API_KEY`: contents of the downloaded `.p8`
   - `APPLE_API_KEY_ID`: Key ID
   - `APPLE_API_ISSUER`: Issuer ID
8. Re-run a tag release and confirm macOS artifacts are signed/notarized.

Notes:

- `APPLE_API_KEY` is stored as raw key text in secrets.
- The workflow writes it to a temporary `AuthKey_<id>.p8` file at runtime.

## 3) Azure Trusted Signing setup (Windows)

Required secrets used by the workflow:

- `AZURE_TENANT_ID`
- `AZURE_CLIENT_ID`
- `AZURE_CLIENT_SECRET`
- `AZURE_TRUSTED_SIGNING_ENDPOINT`
- `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`
- `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`
- `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`

Checklist:

1. Create Azure Trusted Signing account and certificate profile.
2. Record ATS values:
   - Endpoint
   - Account name
   - Certificate profile name
   - Publisher name
3. Create/choose an Entra app registration (service principal).
4. Grant service principal permissions required by Trusted Signing.
5. Create a client secret for the service principal.
6. Add Azure secrets listed above in GitHub Actions secrets.
7. Re-run a tag release and confirm Windows installer is signed.

## 4) Ongoing release checklist

1. Ensure `main` is green in CI.
2. Bump app version as needed.
3. Run the Release workflow on `main` with channel `stable` and version `X.Y.Z`.
4. The tag `vX.Y.Z` is created when the draft release is published; a stable release then pushes the version bump to `main`.
5. Verify workflow steps:
   - Resolve release passes
   - Verify passes, or is skipped because CI status found a green CI run for the same commit
   - all matrix builds pass
   - Draft GitHub Release uploads the expected files
   - Publish CLI to npm passes, then Publish GitHub Release makes the draft public
6. Smoke test downloaded artifacts.

## 5) Troubleshooting

### Packaged runtime dependencies

The desktop artifact builder validates literal imports, re-exports, dynamic imports and
`require` calls in the staged desktop CJS and backend ESM bundles after production dependency
installation and provider CLI pruning. Resolution uses the importing file and Node's matching
import/require conditions. Targets outside the stage, including development-workspace symlinks,
fail validation. Computed module paths and dependency-internal optional imports are not scanned.

After Electron Builder rebuilds addons, the builder also checks staged native payload presence
for `node-pty`, `@github/keytar`, and `sharp`/libvips. This does **not** establish ABI compatibility
or verify the final archive's loadability. Smoke-test the packaged app under its matching
Electron runtime and architecture; a successful load under development Bun or Node is insufficient.

### Signing

- macOS build unsigned when expected signed:
  - Check all Apple secrets are populated and non-empty.
- Windows build unsigned when expected signed:
  - Check all Azure ATS and auth secrets are populated and non-empty.
- Build fails with signing error:
  - Retry with secrets removed to confirm unsigned path still works.
  - Re-check certificate/profile names and tenant/client credentials.
