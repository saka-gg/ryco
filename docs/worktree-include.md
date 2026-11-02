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
worktree, a delegated task), it copies every file the patterns match that Git also ignores (as
`git ls-files --others --ignored --exclude-from=.worktreeinclude` lists them, kept only where
`.gitignore` ignores them too) into the new worktree before its setup script runs. A pattern
without a slash matches in every folder (`.env` also copies `packages/api/.env`); a leading `/`
anchors it to the root.

- Only ignored files are copied, so a copy never shows up as a change a commit could pick up.
- Files the new branch already has stay as the branch has them.
- Nothing is written through a folder the new branch tracks as a symlink: such a file is skipped.
- Symlinks are copied as links.
- At most 1,000 files and 256 MB are copied, within two minutes; the rest is skipped.
- A file that cannot be copied is logged and skipped; the worktree is still created.
- A worktree for a pull request from another repository (a fork) gets none of them: its code
  must not read your `.env`. The same goes for a pull request whose repository the host does not
  report.
- Without a `.worktreeinclude` file nothing ignored is copied.

Copied files count as ignored files that are not a known cache, like any `.env` you create in a
worktree yourself. So storage cleanup does not remove such a worktree on its own, and removing
its checkout lists them among the files that would be lost.

The file is read from the checkout the worktree is made from, so it can be committed or kept
local. A setup script (see [project preferences](project-preferences.md)) can still do more, but
it runs in the background; the copy happens before the worktree is handed over.

Ported from Synara's `.worktreeinclude` support.
