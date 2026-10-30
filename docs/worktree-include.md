# Files every new worktree gets (`.worktreeinclude`)

A new worktree is a fresh checkout of a branch, so files Git ignores, such as `.env`, local
configuration or a downloaded toolchain, are missing there and an agent's first run can fail on
them. List them in a `.worktreeinclude` file at the root of the checkout, in `.gitignore`
syntax:

```gitignore
.env
/config/local.json
```

When Ryco creates a worktree from that checkout (a new chat in a worktree, a fork into a new
worktree, a delegated task), it copies every untracked file the patterns match, as
`git ls-files --others --ignored --exclude-from=.worktreeinclude` lists them, into the new
worktree before its setup script runs. A pattern without a slash matches in every folder (`.env`
also copies `packages/api/.env`); a leading `/` anchors it to the root.

- Files the new branch already has stay as the branch has them.
- Symlinks are copied as links.
- A file that cannot be copied is logged and skipped; the worktree is still created.
- Without a `.worktreeinclude` file nothing ignored is copied.

The file is read from the checkout the worktree is made from, so it can be committed or kept
local. A setup script (see [project preferences](project-preferences.md)) can still do more, but
it runs in the background; the copy happens before the worktree is handed over.

Ported from Synara's `.worktreeinclude` support.
