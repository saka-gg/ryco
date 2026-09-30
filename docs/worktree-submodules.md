# Worktree submodule initialization

New Git worktrees initialize submodules recursively by default. In General settings on web
or desktop, **Worktree submodules** selects a node default or an explicit project override:

- `recursive`: run `git submodule update --init --recursive`.
- `top-level`: run `git submodule update --init`, leaving nested submodules uninitialized.
- `none`: skip initialization, allowing a setup script or manual command to handle it.

Changing this preference never updates, deinitializes, or deletes existing checkouts. Native
creation uses the same server policy; the native Workspace page shows the active node's default.

A branch can commit a root `ryco.json` file containing:

```json
{ "worktreeSubmodules": "top-level" }
```

Explicit project overrides win over the new checkout's repository configuration, which wins
over the node default. Resetting a project to **Inherit** removes its override. Repository
configuration is read from the newly created checkout, not a dirty source checkout. No parent
discovery, includes, or caller-selected config paths are supported. The file must be a regular
file (no symlinks), valid JSON, and at most 64 KiB. Unknown keys are ignored for compatibility.
Malformed or invalid configuration fails visibly unless an explicit project override applies.

Initialization outcomes distinguish a missing `.gitmodules` file from policy-disabled setup.
Top-level completion explicitly states that nested modules remain uninitialized. An initialization
failure retains the checkout and reports its path and the command to retry after fixing submodule
URLs or credentials. Cancellation interrupts the existing Git process lifecycle; it does not
turn interruption into successful setup or delete the checkout.

## Integration boundary

Contracts define `WorktreeSubmodules`, `WorktreeSubmoduleRepositoryConfig`, the node setting
`worktreeSubmodules`, and the independently patched map `projectWorktreeSubmodules`. Null map
entries remove an override. Existing settings decode to recursive with an empty override map.

`@ryco/shared/worktreeSubmodules` owns the platform-neutral precedence, option labels, and
patch construction. `apps/server/src/project/worktreeSubmodules.ts` exposes
`resolveWorktreeSubmodules({ checkoutPath, settings, projectId?, policy })`, returning an Effect
of `{ mode, source }`. The checkout must have been freshly created and authorized. The resolver
performs bounded configuration discovery and invokes the shared selection logic.

`GitVcsDriverCore.createWorktree` is the sole initialization owner. Its server-only `projectId`
input is supplied from registered project context by RPC/bootstrap/project creation, PR creation,
agent control, restoration, and missing-checkout recovery. It is absent from the public VCS input
schema so clients cannot supply a second policy or arbitrary config path. Creation results may
contain an additive `submoduleInitialization` outcome; old servers and reused checkouts may omit it.
Feature-level project inheritance can adapt its storage to this resolver without creating a
second Git setup path.

Creation also accepts a server-only `settingsSnapshot` in `GitWorktreeCreationContext`.
When a workflow resolves general preferences, it passes the same authoritative settings object
and project ID into worktree creation. The core uses that snapshot for storage and submodule
policy rather than rereading mutable settings midway through the workflow. Direct creation
without a supplied snapshot captures one at core entry. General preferences must never read
`ryco.json`; its only accepted preference remains `worktreeSubmodules`.

Fresh checkout creation writes a node-owned incomplete-setup journal before Git adds the
worktree. The journal survives node restart and is cleared only after all creation setup succeeds
or explicit checkout removal succeeds, with the orphan recovery exception described below.
Provider recovery, PR reuse, and restore refuse a marked checkout; they do not silently initialize an existing checkout. Fix the branch configuration or
submodule access, preserve any work, then explicitly remove the incomplete checkout through
source control and recreate it using its existing branch. Ordinary legacy/adopted checkouts have
no journal entry and remain unchanged. This journal is separate from project ownership and
provenance migrations; it does not grant deletion authority.

Nodes advertise `environment.capabilities.worktreeSubmoduleSettings: true`. Missing or false
capability means the node cannot edit this policy, even when schema decoding supplies default
settings values. Web/desktop disable editing and native shows an upgrade hint for older nodes.

An authorized creation or removal can reclaim an orphaned journal after a crash before Git add
or after external removal and pruning, only when a strict filesystem inspection and successful,
complete Git registration listing both prove that the checkout is absent. New journals bind the
canonical shared Git repository directory, allowing recovery from another checkout of the same
repository even after the source checkout is removed. A mismatched repository, unbound legacy
journal, unreadable state, dangling link, retained registration or inconclusive listing fails
closed. Reclaiming a journal removes no checkout, branch, registration or provenance. Creation and removal share the same nearest-existing-
parent canonical identity for their destination lock and journal, including before mkdir and through
symlinked parents.

Setup now holds an exclusive node-owned destination guard across cores and processes sharing
state. It records a PID and syncs a mutation phase before launching Git. A live PID (including
reuse), failed liveness probe, malformed record or another reclaimer blocks admission. Only an
absent PID with a complete pre-mutation reservation can be reclaimed; no age or timeout proves
owner death. A crash during mutation cannot prove that orphan Git children have stopped and
requires operator inspection. Interrupted or defective setup likewise retains its guard, while
completed success or typed failure releases it after scoped children finish. Provider reuse also
refuses guarded checkouts. Existing journals without this creator protocol are conservative
legacy state and require inspection. These guards grant no deletion authority.
