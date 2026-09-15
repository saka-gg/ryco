# Worktree roots

In node settings, open **General → Projects and threads → Worktree root**.
The environment default controls where that node creates new worktrees. Choose a
project in the scope selector to give it a different root. **Use environment
default** removes the project override; **Reset worktree root** restores the
node's existing Ryco-managed placement. Resetting the environment does not erase
project overrides.

Use an absolute path on the node, or `~/` for the node user's home directory.
Paths refer to the server filesystem, including when editing a remote node from
another computer. The server resolves symlinks and validates writable directories
or existing parents before saving. Missing directories are created only when a
worktree is created. A root that becomes unavailable later causes new creation to
fail with an error; Ryco does not silently fall back to another disk.

New project worktrees retain their project-ID directory and existing checkout
naming. This setting does not rename branches or move existing worktrees.
Registered worktrees, imported explicit checkouts, restores and explicit
project-metadata placement retain their locations. PR preparation reuses existing
registered checkouts even after their original root is no longer the default.

The root is a storage preference, not an authorization grant. `--restrict-to-cwd`
still rejects destinations outside the authorized workspace, including symlink
escapes. Hosted ownership and mutation-readiness checks apply unchanged. The
Agent Control settings allowlist does not expose filesystem-root changes.

Settings are stored on the node as `worktreeRoot` and `projectWorktreeRoots`.
The default root is an empty string. Project overrides are keyed by project ID;
a null or empty entry in a settings patch removes that override without affecting
other projects. Older settings files need no migration.
