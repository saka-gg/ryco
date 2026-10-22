# Cross-node E2E

Copies a project between two real Ryco nodes:

- **Node A** runs from this checkout's source on the host
  (`node apps/server/src/bin.ts serve --host 127.0.0.1 --port <free> --base-dir <tmp> --no-browser`).
- **Node B** runs the same source in a `node:24-bookworm` container with the hostname `linux-box`,
  built from [`node.Dockerfile`](node.Dockerfile). It listens on the same free port inside the
  container and on the host's `127.0.0.1`.

Both nodes reach one bare origin through [`fake-ssh`](fake-ssh): with
`GIT_SSH_COMMAND=<fake-ssh>` and `GIT_SSH_VARIANT=simple`, a remote such as
`git@fixture.test:/private/tmp/ryco-xnode-e2e-…/origin.git` runs `git-upload-pack` (or
`receive-pack`) locally instead of over ssh. The image sets both variables for node B; the harness
sets them for node A. The fixture directory is bind-mounted into the container at the same absolute
path. On macOS that is the `/private/tmp/...` form, because the container cannot follow the host's
`/tmp` symlink.

The test pairs both nodes as owner, the way `ryco remote add` does: it reads the latest `Token:` line
the node printed (from `docker logs` for node B), builds a `http://127.0.0.1:<port>/pair#token=…`
link, and passes it to `pairCliRemote`/`connectCliRemote` from `apps/server/src/cliRemote/remotes.ts`.
Everything after that goes over the WebSocket RPC the apps use.

## Requirements

- Docker (Docker Desktop or OrbStack) with access to `/private/tmp` (macOS) or `/tmp`.
- `node` 24 and the repository's dependencies installed (`bun install --frozen-lockfile`).
- git 2.28 or newer on the host.

## Run it

From the repository root:

```sh
# Everything: builds the image (about 1-2 minutes with a warm cache), starts both nodes, runs all tests.
RYCO_TEST_CROSS_NODE_E2E=1 bun run --cwd scripts test:e2e:cross-node

# Only the smoke test (pairing, legacy clone and project.create on node B).
RYCO_TEST_CROSS_NODE_E2E=1 bun run --cwd scripts test:e2e:cross-node -t smoke

# Reuse an image that is already built (after the first run, or one built by hand).
docker build -f scripts/e2e/cross-node/node.Dockerfile -t ryco-xnode-node:e2e .
RYCO_TEST_CROSS_NODE_E2E=1 RYCO_E2E_SKIP_BUILD=1 bun run --cwd scripts test:e2e:cross-node
```

Without `RYCO_TEST_CROSS_NODE_E2E=1` every test is skipped and nothing starts. The test file is
named `crossNode.e2e.ts`, which is outside Vitest's default include, so `bun run test`, the scripts
package's own `vp test run` and `bun run check:changed` never collect it. Only
[`vitest.config.ts`](vitest.config.ts) in this directory does.

| Variable                     | Effect                                                               |
| ---------------------------- | -------------------------------------------------------------------- |
| `RYCO_TEST_CROSS_NODE_E2E=1` | Runs the tests.                                                      |
| `RYCO_E2E_SKIP_BUILD=1`      | Uses the existing image instead of building it first.                |
| `RYCO_E2E_NODE_IMAGE=<tag>`  | Image for node B (default `ryco-xnode-node:e2e`).                    |
| `RYCO_E2E_KEEP=1`            | Keeps the fixture and node A's base dir; the run prints their paths. |

## What it checks

1. **Smoke** (works today): both pairings grant `owner`; node B reports `linux-box`; the fixture
   project exists on node A with the scripts and system prompt set over RPC; node B's legacy
   `sourceControl.cloneRepository` clones the origin through the fake ssh, and `project.create`
   registers the clone.
2. **`[wave 1]` copy with `.env` opted in**, driven RPC by RPC: `projects.exportInspect` and
   `projects.exportStart` on A; `projects.pathHints`, `projects.previewDestination` and
   `projects.checkRemoteAccess` on B; each artifact read with `projects.exportReadChunk` and written
   with `projects.transferBegin`/`Append`/`Commit` (the last chunk is sent twice, as after a dropped
   reply); `projects.importStart` (sent twice, idempotent by id); `projects.subscribeImport` until a
   terminal status. It then checks on B with `docker exec`: HEAD equals A's unpushed HEAD on the
   same branch, both remotes are recreated, `git status` matches A (the tracked edit and the
   untracked binary, both byte-identical), the `.env` is copied and still ignored, the project is
   registered with A's title, scripts and system prompt, and the setup script ran in the project
   root without seeing any `RYCO_*` variable.
3. **`[wave 1]` copy without opting in**: the same, and the `.env` is not copied.

The `[wave 1]` tests fail until the project-copy services replace their placeholders (each call
then fails with "not available yet"); the error names the node and the call.

The fixture: a bare `origin.git` with `main` pushed, a bare `upstream.git` as a second remote, and
the workspace on `feature/cross-node`, one commit ahead of the origin, with an unstaged edit to
`README.md`, an untracked 200 KiB binary (`assets/blob.bin`, larger than one transfer chunk) and an
ignored `.env`. Every fixture repository has `commit.gpgsign` and `tag.gpgsign` turned off.

## Cleanup

The run stops node A, removes node B's container and deletes the temporary directories, also after
a failure. If a run is killed, remove leftovers with:

```sh
docker rm -f $(docker ps -aq --filter label=ryco.e2e=cross-node)
rm -rf /private/tmp/ryco-xnode-e2e-*   # /tmp/ryco-xnode-e2e-* on Linux
```

## Manual UI run

Node B alone, for pairing it in a running Ryco app (the image's default command listens on 14001):

```sh
docker build -f scripts/e2e/cross-node/node.Dockerfile -t ryco-xnode-node:e2e .
docker run -d --name ryco-xnode-b --label ryco.e2e=cross-node --hostname linux-box \
  -p 127.0.0.1:14001:14001 ryco-xnode-node:e2e
docker logs ryco-xnode-b | grep '^Token:'
```

Add it in the app with `http://127.0.0.1:14001/pair#token=<token>`. Add
`-v /private/tmp/<dir>:/private/tmp/<dir>` to share fixture repositories with it, and remove it
afterwards with `docker rm -f ryco-xnode-b`.
