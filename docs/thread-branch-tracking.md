# Thread branch tracking

A thread records the branch its checkout is on. When an agent switches to
another branch, for example with `git checkout -b`, the thread follows. So does
its workspace in the sidebar, and pull request badges keep matching the branch.
The node does this itself, so it works with no window open: on mobile, through
Agent Control, and for threads nobody is watching.

## When the branch is read

The node reads the checkout's branch:

- when a turn starts, which also picks up a branch you switched by hand before
  sending (except for a project-folder thread you message from the web or
  desktop app, see [Branches you switch by hand](#branches-you-switch-by-hand));
- after each git or pull request command the agent runs (`git checkout`,
  `git switch`, `git commit`, `git push`, `gh pr create`, `glab mr create` and
  similar);
- when a turn ends or is stopped, which catches branch changes made by scripts.

It reads the branch from the repository's files, without starting git. After a
commit or a branch switch it refreshes the checkout's local git status. After a
push or a pull request command it also refreshes the upstream state and the
pull request, at most once every few seconds per checkout. One that has to wait
runs as soon as it may, or when the turn ends if that comes first.

## What it leaves alone

- A detached HEAD, such as during a rebase or a bisect. The thread keeps its
  branch until the checkout is on a branch again.
- Temporary worktree branches (`ryco/1a2b3c4d`). A new worktree's thread keeps
  its temporary name until the automatic rename runs, and that rename keeps a
  branch the agent made meanwhile.
- Names git would not accept as a branch.
- A checkout another thread worked in at the same time. When two threads run
  turns in the same project folder or worktree, neither can tell whose agent
  moved the branch, so neither follows it. The next turn that runs alone in that
  checkout records it. A project-folder thread you message from the web or
  desktop app instead keeps its own branch and continues in a new worktree on
  it, as after a switch by hand.
- Chats without a project.
- Other threads attached to the same worktree. Only the thread whose turn ran is
  updated; the others update at their own next turn.

GitHub Copilot reports commands without their text, so Copilot threads follow
branch changes at the start and end of each turn only.

A newer branch change always wins: if you pick a branch while the node is
recording another one, your choice stays.

## Branches you switch by hand

A branch you switch while a thread is idle, in a terminal or an editor, shows
in the git controls right away. The thread itself doesn't change yet:

- A thread in its own worktree records the branch at its next turn.
- A thread working in the project folder keeps its branch. The next message you
  send it from the web or desktop app continues it in a new worktree on its own
  branch, and the project folder stays on the branch you switched to. Sent from
  the mobile app or through Agent Control, its next turn records the switched
  branch instead.

Until then the thread's pull request badge can be missing, because the badge
shows only while the thread's branch matches its checkout.

Branches you pick in the branch menu or create with a git action are recorded
right away.

## Older nodes

Older nodes don't follow the checkout. With them, the web and desktop apps
record the branch the checkout is on while the thread is open with its overview
rail showing, as before.
