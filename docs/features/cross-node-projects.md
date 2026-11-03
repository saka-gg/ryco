# Projects across nodes

A node is one machine running Ryco: your laptop, a Mac mini under the desk, a Linux server. Ryco
shows one project per repository, whatever nodes it is on, and can put a project on another node
for you: it copies the project there, or registers a checkout that is already there.

- **Copy a project to another node.** Pick the node and the folder. The node clones the project's
  remote, or gets the files from the node the project is on now. Your unpushed commits, your
  uncommitted changes and the project's settings can come along. Afterwards the node can run a
  setup command, and an agent can finish the setup.
- **Add a project on any node.** You choose the node, then the source (a folder that is already
  there, a repository to clone, a project from another node, a checkout to link), then the folder.
  Search covers the node's code folders.
- **See where a project lives.** The project selector lists every node a project is on, with its
  path there. You can filter by node.
- **Ask an agent.** "Set up ryco on my Mac mini in the normal code directory" becomes a request you
  approve. Ryco then copies the project and sets it up there.

Nodes never talk to each other. The Ryco app you use holds connections to both nodes and moves the
data between them. The node that receives the project does the actual work.

## Setup

1. **Every node runs this Ryco release or a newer one.** An older node shows "Update Ryco on
   <node> to copy projects here" (with an update button when the node can update itself). An older
   source can still be copied by cloning its remote, but its unpushed commits, uncommitted changes
   and avatar stay behind.
2. **Connect the nodes to one Ryco app**: as saved connections, through Desktop SSH, or through the
   Hub. A node you have not opened in this session yet shows "Checking <node>…" when you pick it,
   while Ryco connects to it.
3. **You need to be the node's owner.** Copying writes to the destination node, so the app must be
   able to change it. A Hub node needs owner access in your workspace. A saved connection needs an
   owner pairing.
4. **The destination needs git**, and access to the remote if it clones. SSH keys, the ssh config
   and credential helpers on the destination are used as they are. Ryco never answers a password or
   host-key prompt (see [Limitations](#limitations)).

### SSH nodes

A node you add with Desktop SSH is paired as owner: the pairing script runs
`ryco auth pairing create --role owner` on the remote machine. You already have a shell on it as the
node's user, who could mint an owner session anyway. A remote with an older Ryco rejects
`--role owner`; it is then paired as a client, and the node says "Update Ryco on <node> to copy
projects here". If you added an SSH node before this release, Ryco pairs it again as owner on the
next full connect, over the same tunnel, and revokes the old client session. `ryco auth pairing
list` now has a role column for client and owner links. An owner link lasts at most 15 minutes.

## Copying a project

Open **Copy to another node…** from:

- a project's menu in the sidebar (right-click, or the ⋯ menu);
- the ⋯ menu on the Projects page;
- **Copy here** next to a node in the "Not on" list of the Projects page's devices section;
- the footer of the project selector;
- **Copy from another node** in the add-project dialog.

The dialog has five parts.

**From.** The checkout to copy, if the project is on more than one node. An offline node can't be
the source.

**To.** The destination node. A node that already has the project shows "has it · <path>". An
offline node shows when it was last seen. A node that can't take the copy shows why.

**How.**

- **Clone from origin** (recommended when it works). The destination clones the project's own
  remote: the project's preferred remote if the checkout has it, else `origin`, else the remote
  that identifies the repository. For a fork, that is your fork, not the repository it was forked
  from. The other remotes (`upstream`, for example) are added too, so the copy groups with the
  original. As soon as you pick a node, Ryco checks whether that node can reach the remote, and
  shows "<node> can reach it" or why it can't. When the https and ssh forms of the URL differ in
  reachability, the node uses the form that works.
- **Send files from <source>.** The source node bundles the repository (branches, tags and
  remote-tracking refs; never Ryco's checkpoint refs or stashes), and the app sends the bundle to
  the destination. Use it when the destination can't reach the remote, for repositories without a
  usable remote, or for a plain `http://` remote, which the destination won't clone from. It is
  selected for you when the remote check fails. The size shows next to the option. A shallow clone
  can't be sent.

**Folder on <node>.** Ryco suggests a folder: the same place as on the source, when the
destination has that parent folder, else the node's normal code directory (see below). The folder
is named after the source. A suggestion is tagged "new folder"; if a folder of that name already
exists, Ryco suggests the next free name and tags it "renamed, folder exists". **Change…** opens
the folder picker. When the folder is already a checkout of the same repository, the button
becomes **Link existing checkout**: Ryco registers that checkout as is and copies nothing into it.

**Options.**

- **Bring unpushed commits**: commits on your branch that aren't on the remote the copy clones
  from. The copy ends on the same branch and commit as the source, even when the remote has moved
  on.
- **Bring uncommitted changes**: staged, unstaged and untracked files, as one binary-safe patch
  that respects `.gitignore` (at most 64 MB). Ignored files such as `.env` or `*.local` are listed
  so you can opt them in, up to 32 files of at most 1 MB each. On the destination they are added
  to `.git/info/exclude` if its ignore rules don't already cover them. Changes need the commit they
  are based on: when that commit isn't on the remote, the unpushed commits come along with the
  changes. A checkout with merge conflicts can't send its changes.
- **Copy project settings**: title, scripts, system prompt, preferred remote, metadata folder,
  avatar, and the settings the project overrides for itself (new threads, worktree branch prefix,
  worktree setup, generated branch names, pull request template). Settings the project leaves at
  the defaults follow the destination's defaults. A source on an older Ryco can't share its
  overrides, so its copy keeps the destination's defaults.
- **Run setup afterwards**: one command, prefilled from the project's worktree setup script and
  editable. It runs in the project folder on the destination, in your login shell there, with no
  input, for at most 30 minutes. When the two nodes run different systems, the dialog says the
  command was written for the source's system. A failing setup leaves the project in place, with a
  warning.
- **Ask an agent to finish setup**: starts a thread on the destination after the setup command,
  with a prompt you can edit and a model from the destination's providers. Use it for anything one
  command can't do, like installing tools or following the README. The repository's own provider
  hooks and settings apply to that thread.

The footer sums up what will happen ("Clones to ~/Code/ryco on Mac mini").

### Progress

After **Copy** the dialog lists the steps: connect, prepare the files, send them, then the
destination's own steps (create the folder, clone, add the commits, check out, apply the changes,
add the project, copy the settings, run setup, start the setup thread).

- Until the destination has everything, the footer says "Keep Ryco open until the upload finishes
  (x of y MB)". If you close Ryco during the upload, the copy stops. The next time Ryco opens, it
  cleans up what the copy left on both nodes and tells you to start it again. (A copy an agent
  asked for picks up where it stopped instead, as long as its request is still running.)
- Once the destination runs the import, the footer says "Runs on <node>; you can close Ryco". The
  import goes on there by itself, and Ryco follows it again when it opens. If that node's server
  restarts during the import, the import stops as interrupted and removes the folder it was
  creating, unless the project was already added.
- **Run in background**, or closing the dialog, moves the copy to a toast. While it runs, the
  project's row in the sidebar shows a spinner and a percentage. A finished copy toasts "<project>
  is ready on <node>" with **View**, which opens a new thread there. A failed copy toasts the
  reason. When the clone failed because the destination couldn't reach the remote, it offers
  **Send files instead**.
- The Projects page's devices section has a **Copies** block: copies of this session, records of
  unfinished ones, and imports that connected nodes report. Each row offers **View log**,
  **Retry**, **Resume** and **Discard leftover**. A failed import can leave a half-made folder;
  **Discard leftover** deletes it, but only if Ryco created it and no project was added there.

A clone or link you start in the add-project dialog keeps going the same way when you close the
dialog: it gets the same toasts and shows up in the Copies block.

### What is copied

| Copied                                                           | Not copied                                                    |
| ---------------------------------------------------------------- | ------------------------------------------------------------- |
| The repository: cloned, or sent as files                         | Threads and their history                                     |
| Every remote, credentials stripped (ssh user names kept)         | Worktrees                                                     |
| Unpushed commits and the exact branch and commit (opt-in)        | The project's initial model (it names the source's providers) |
| Uncommitted changes and the ignored files you pick (opt-in)      | The project's worktree root (a path on the source)            |
| Title, scripts, system prompt, preferred remote, metadata folder | Atlassian links                                               |
| The project avatar and overrides (with the settings)             | Anything outside the repository                               |

Remote URLs are cleaned before they leave the source. A password in a URL is always removed, and
so is the user name of an http(s) URL. The user name of an ssh URL is kept, because ssh needs it
to authenticate.

### Through the Hub

When either node is reached through the Hub, at most about 24 MB of files can be sent per relayed
node and copy. Cloning from the remote is not limited, since the node fetches it itself. Over the
cap, **Send files**, **Bring unpushed commits** and **Bring uncommitted changes** are disabled
with "Too large to send through the Hub (N MB). Push the branch, or connect both devices
directly." On a direct connection one artifact may be up to 256 MB.

Ignored files such as `.env` are only sent over an encrypted connection: an end-to-end encrypted
Hub channel, HTTPS, Tailscale, or Ryco on the same computer. Over an unencrypted connection (a Hub
channel that still runs in the legacy mode without end-to-end encryption, or plain `http://` to
another computer) they are left out and the rest of the copy goes on. The dialog says so next to
the ignored files, with a warning when a node is reached through the Hub.

A copy holds a connection to each of its relayed nodes until the destination starts the import.
When that would take more Hub connections than the app keeps open, the dialog doesn't start the
copy: "All connections are in use; let a running copy finish first."

## Adding a project

**Add project** (the sidebar's +, the command palette, the Projects page, onboarding) opens one
dialog in three steps:

1. **Node.** Cards with each node's state, system, project count and code folders. The step is
   skipped when only one node can take projects, or when you came from a node.
2. **Source.**
   - _Open a folder_: a folder that is already on the node.
   - _Clone a repository_: your own repositories from the connected providers (GitHub, GitLab,
     Forgejo, Bitbucket, Azure DevOps), a provider search, or any Git URL you paste.
   - _Copy from another node_: projects this node doesn't have yet. This opens the copy dialog
     with the node already picked.
   - _Link a checkout_: register a checkout of the project that is already on the node.
3. **Folder.** The folder picker searches the node's code folders as you type. It lists code
   folders and git repositories under Places, and marks repositories and existing projects. A path
   you type works too. A folder that doesn't exist yet is created when you add the project. The
   status line says what will happen: "Clones github.com/me/ryco into ~/Code/ryco", "joins ryco
   from Mac mini", and so on.

The done step lists every node the project is on now. **Show in project selector** opens a new
thread in the project, with the project selector open.

On the Desktop app's own machine, the folder step also offers the system's folder picker. The
phone layout of the web app keeps the command palette's add-project views.

### The node's normal code directory

Each node works out where its projects usually live. In order, that is:

1. the node's workspace access root, when access is restricted;
2. the **Add project base directory** setting;
3. the folder that holds most of the node's existing projects, if it holds at least two;
4. the first of `~/Code`, `~/Developer`, `~/dev`, `~/src`, `~/projects`, `~/repos`, `~/code`,
   `~/workspace` and `~/git` that exists;
5. the home folder.

The folder picker's Places, the copy dialog's suggestions and the agent tools all use this
directory. Folder search never follows symlinks and skips build output, dependency folders and
hidden folders (unless your query starts with `.`). On macOS it also stays out of Desktop,
Documents, Downloads and the media folders, which would ask for permission, unless they are code
folders.

## The project selector

The new-thread hero's project selector shows one row per project. Each row has a badge for every
node the project is on, and the path on the most relevant node. Expand a row, or press →, to see
the checkout on each node: its path, plus its branch and changes if Ryco already knows them.
Picking another node's checkout moves the draft there and keeps what you typed.

- **Node chips**, or `@` and the start of a node's name in the search field (`@mac`), show one
  node's projects.
- **Search** matches project names and paths, so `/srv` finds projects under `/srv`.
- The footer has **Add project…** and **Copy <project> to another node…**.

An offline node's checkout is disabled, and so is one the Hub won't let you use. The row says why.

## Asking an agent

Agents in Ryco sessions get four tools (the full reference is in
[Agent Control](../agent-control.md#projects-on-other-nodes)):

- `ryco_list_nodes`: the nodes your Ryco apps know about.
- `ryco_suggest_project_destination`: a free folder in this node's normal code directory.
- `ryco_propose_project_import`: clone a repository into a folder on the agent's own node.
- `ryco_propose_project_copy`: copy a project of the agent's node, or a repository URL, to another
  node.

The agent's node only knows about your other nodes after a Ryco app connected to both has
published its node list. Opening Ryco on a computer connected to that node is enough.

**Example.** In a chat of the project `ryco` on your laptop you write: "Set up ryco on my Mac mini
in the normal code directory." The agent

1. calls `ryco_list_nodes` and finds the node labelled "Mac mini";
2. calls `ryco_propose_project_copy` with `target: "Mac mini"`, `destination: { kind: "default" }`,
   `setup: {}` (the project's own setup script) and a `followUpThread` prompt such as "Install the
   toolchain this repository needs and check that its tests run";
3. tells you the request waits for your approval.

Your laptop app shows the request: copy `ryco` to Mac mini, into `/Users/you/Code/ryco` (new
folder), run `bun install`, then start a setup thread with the model shown. The setup command is
shown exactly as it will run, and nothing else runs as setup. When you approve, the app copies the
project like the copy dialog does, with the same toast, and reports back. The agent's request then
completes with "Copied to Mac mini".

Only a Ryco app on a computer that is connected to the target node can approve a copy. The mobile
app and the web app's phone layout show "Approve in Ryco on a computer connected to <node>". An
agent's copy only clones the remote, or links a checkout of the same repository that is already
there. It never sends the whole repository; for that, copy from the Projects page yourself.

## Limitations

- **Git repositories only.** A folder that isn't a git repository can't be copied.
- **Repositories without a remote** can be sent as files, but the copy shows as a separate
  project: projects group by their remote. The copy and link dialogs say so.
- **Unknown host keys.** The destination never accepts a new ssh host key by itself. A clone from a
  host it doesn't know yet fails with `host-key-unknown <host>`, and the copy offers **Send files**
  instead. Connect to the host once on that node (`ssh -T git@<host>`) to trust it.
- **Credential prompts are never answered.** A remote that asks for a password on the destination
  fails the reachability check; use **Send files**, or set up a key or credential helper there.
- **Submodules and Git LFS** are fetched after the checkout. They only add a warning when they
  fail. Without `git lfs` on the destination, large files stay pointers until you run
  `git lfs pull` there.
- **Changes that don't apply** (the destination ended on another commit) are kept inside `.git` on
  the destination. The warning names the file and the `git apply` command to run.
- **Threads, worktrees and per-node preferences** stay on the source node.
- **The Hub cap** of about 24 MB of files per relayed node (see above).
- **No direct node-to-node transfer.** Files always pass through the app that runs the copy, even
  on one network.
- **Hosted web app**: records of unfinished copies live in memory only, so after a reload the
  Copies block relies on what the nodes report.
- **Windows nodes** are supported (drive-letter paths, PowerShell setup commands), but have had
  less testing than macOS and Linux.
