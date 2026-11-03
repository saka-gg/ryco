# Source Control And Work-Item Integrations

Ryco connects to Git hosting providers and Jira so you can create pull requests, review code, manage repositories, and start work from tracked issues without leaving the app.

## Supported Providers

Ryco works with the platforms your team already uses:

- **GitHub** – Pull requests, issues, comments/reactions, repository creation, clone integration, and GitHub Actions status/logs
- **GitLab** – Merge requests, issues, repository publishing, and hosted clones
- **Forgejo / Codeberg** – Pull requests, issues, repository publishing, and hosted clones
- **Bitbucket** – Pull requests, issues, repository publishing, hosted clones, and Atlassian token workflows
- **Azure DevOps** – Pull requests and work-item-backed issue flows for Microsoft-hosted repositories
- **Jira Cloud** – Project-linked work items, detail views, comments, field updates, transitions, and branch/worktree linkage

## What You Can Do

### Start Projects from Anywhere

**Clone repositories directly**

- Open the Command Palette (`Cmd/Ctrl + K`) → **Add Project**
- Choose **GitHub repository**, **GitLab repository**, **Forgejo repository**, **Bitbucket repository**, **Azure DevOps repository**, or paste any **Git URL**
- Enter the repository path (`owner/repo`, `group/project`, `workspace/repository`, or `project/repository`) or a full Git URL, pick a destination, and start coding
- Large repositories can take as long as they need. A clone stops only when git prints nothing for 5 minutes (a dead network, a server that stopped answering).
- The clone runs on the machine that holds the project, not in the app window. If the connection drops while it runs (a hidden tab, a sleeping laptop, a reconnect), it keeps going there. Add the same repository to the same destination again to wait for it, or to pick up the finished project for up to 30 minutes. A clone that nothing waits for during 10 minutes is stopped.
- git clones into a hidden folder next to the destination (`.<name>.ryco-clone-…`) and moves it into place when done, so a failed or stopped clone never leaves a half checkout at the destination. If git fetched the whole repository but could not check out its files (for example a Git LFS quota or a failing hook), the repository is kept at the destination and the error says what to fix.
- At most two clones run at once on a machine (one on a two-core machine); more wait for their turn.

**Publish local projects to the cloud**

- Have a local Git repository without a remote?
- Use the **Publish Repository** action to create a new hosted repository (GitHub, GitLab, Forgejo, Bitbucket, or Azure DevOps), add it as your origin remote, and push—all in one flow
- Perfect for turning a weekend prototype into a real project

### Manage Code Reviews Without Context Switching

**Create pull requests while you work**

- Push a branch and create a pull request from the Git panel
- Ryco can suggest titles and descriptions based on your commits
- Supports GitHub Pull Requests, GitLab Merge Requests, Forgejo Pull Requests, and Bitbucket Pull Requests

**Stay on top of open reviews**

- See if your current branch already has an open PR/MR
- Open the review directly in your browser with one click
- Check out a teammate's branch to review code locally
- Inspect PR details, comments, changed files, and workflow/check status from the project explorer where supported

**Open pull request links from chat in Ryco**

- Click a pull request or merge request link in a chat message and it opens on the **Pull requests** page when its repository is one of your projects, on a machine that is connected. A link to the Files, Checks or Commits view opens that tab.
- Cmd-click or Ctrl-click (or any click with a modifier), a link to one comment, and a link to a repository you have not added open in the browser as before.
- To always open links in the browser, set **Settings → Source control → Pull request links in chat** to **Browser**. The setting belongs to this browser or app.
- Ryco matches the link with the remote your project's pull request numbers come from (`upstream`, else `origin`, else the first remote by name), so a fork opens only the links of the repository it tracks.

**Pull requests that need you, across repositories**

- On the **Pull requests** page, choose **All repositories** at the top of the repository switcher. The list then shows the pull requests that ask for your review (**Needs your review**) and the ones you opened (**Yours**) from every repository and machine, ranked by readiness like one repository's list. Filters, labels, sorting, J/K and pasted links work the same way.
- A row opens in the reader through a checkout of its repository, on a machine that reported it when it can; the address keeps `scope=all`, so the list stays while you read. Choosing a repository leaves All repositories, and the page opens on All repositories again when it was your last choice.
- Every machine is asked through its own connection, and only once it is connected and runs a Ryco that answers this request. GitHub is searched on every machine (each may use its own `gh` login), through up to four of its checkouts per host, so a checkout whose folder is gone does not hide the host; other hosts' repositories are read once, through one machine. A checkout whose remote uses an SSH host alias (`git@github.com-work:acme/app.git`) opens the rows of the host the alias resolves to.
- Notes above the list say what could not be read: a host or repository that failed or none of whose checkouts could be opened, a machine that is still connecting, offline, not open in the Hub, or needs a Ryco update, machines signed in to one host as different accounts, lists still loading or cut at 100, and pull requests in repositories not added to Ryco (left out and counted). **Refresh** reads every machine again.
- The list rereads every 5 minutes (10 minutes with reduced refresh, never with manual refresh) and when the window regains focus after a minute. A pull request you merge or close from the reader leaves the list at once, even while another machine's cached answer still lists it; one you review shows its new review decision at once and moves out of "Needs your review" with the next reread.
- Each machine answers one request (`sourceControl.listInvolvedChangeRequests`) with the pull requests that ask for your review or that you opened, across all of its repositories, newest activity first.
- GitHub is read with one search per host and kind of involvement (`review-requested:@me`, `author:@me`), not one list per repository, so a machine with many GitHub repositories costs two GraphQL requests per host. Archived repositories are left out, and each search returns the 100 most recently updated pull requests.
- GitLab, Forgejo, Bitbucket and Azure DevOps repositories are read one repository at a time, with the same involvement filters the Pull requests page uses.
- Answers are kept for 4 minutes per host or repository. A refresh reads again anything older than 10 seconds, and merging, closing or editing a pull request in Ryco drops the cached answer for its host.
- A machine answers within 20 seconds however many repositories it reads, at most four at a time. Lists still loading then are reported as loading, keep loading in the background, and appear when Ryco asks again.
- A host that fails is reported on its own; the other hosts' pull requests still show. Pull requests in organizations your `gh` login may not read (SAML single sign-on, OAuth app restrictions) are counted and left out instead of failing the whole host.

**Keep your place in a GitHub review**

- In a pull request's **Files** tab, check **Viewed** beside a file. Progress is saved to GitHub using the account authenticated by `gh` in the connected environment, and survives reopening Ryco or using another machine with that account.
- The viewed/total count tracks the complete GitHub file list. **Hide viewed** filters reviewed files out of the displayed list. Files GitHub reports as changed since viewing show **Changed since viewed** and remain visible for another review.
- Checkboxes update immediately and roll back with an error if saving fails. **Refresh files** reloads review progress and the displayed PR data. Automatic refresh follows your source-control refresh setting.
- Viewed-state reads and writes use separate RPCs from diff retrieval; checking a box does not download the diff again. A changed PR head requires refreshing before more files can be marked.
- Viewed progress currently supports GitHub only. Other providers hide these controls. Provider capability metadata distinguishes host, environment, and unsupported storage so additional adapters can be added without changing the review model.

### Work From Issues And Jira Tickets

**Use issues as agent context**

- Search issues and pull/merge requests from the composer with the `#` trigger
- Attach title, body, metadata, and recent comments to the next agent turn
- Use issue or PR context to create branches, worktrees, commits, and PR descriptions

**Use Jira as a work-item system**

- Add a Jira token from **Settings → Source Control → Atlassian Workflow**
- Link a project to Jira project keys from the project settings panel
- Browse Jira work items in the project explorer's **Jira** tab
- View details, add/edit comments, update supported fields, and move work items through available transitions
- Start worktrees/branches from Jira keys and show linked Jira chips in the sidebar and chat header

### Know Your Setup at a Glance

The **Source Control settings** page shows you exactly what's connected:

- ✅ Which providers are authenticated and ready
- ⚠️ What's missing and how to fix it
- 👤 Which account is signed in (when available)

Run a quick **Rescan** after setting up a new machine or changing credentials.

## Getting Started

### For GitHub (Recommended for most users)

1. Install the GitHub CLI on the machine running Ryco:
   ```bash
   brew install gh
   ```
2. Sign in:
   ```bash
   gh auth login
   ```
3. Open **Settings → Source Control** in Ryco and verify GitHub shows as authenticated

That's it—you can now clone, publish, and create pull requests.

#### How Ryco talks to GitHub

Ryco reads these straight from GitHub's API over HTTPS, with the same token the GitHub CLI uses,
instead of starting `gh` for each read:

- pull request and issue states (the sidebar, linked pull requests and issues);
- pull request and issue lists, and the background lookups of which pull request belongs to a
  branch;
- pull request fingerprints (below), and a repository's merge settings, which Ryco revalidates with
  their ETag, so an unchanged answer does not count against GitHub's REST rate limit.

Everything else (free-text pull request and issue search, pull request details, reviews,
comments, creating pull requests, checkouts, GitHub Actions) still runs through `gh`, and so does
finding which GitHub repository a checkout belongs to (`gh repo view`, cached).

- The token is the one `gh` would use: `GH_TOKEN` or `GITHUB_TOKEN` for github.com and GHE.com, and
  `GH_ENTERPRISE_TOKEN` or `GITHUB_ENTERPRISE_TOKEN` for the GitHub Enterprise Server host that
  `GH_HOST` names; otherwise Ryco asks `gh auth token`. Ryco never saves it, and sends it only to
  that host's API.
- `gh` is used instead when there is no token, when an enterprise token is set but `GH_HOST` is
  unset or names another host, when `HTTPS_PROXY` is set and Node.js would not use it (set
  `NODE_USE_ENV_PROXY=1` on Node.js 24.5 or 22.21 and later to read through the proxy), or when the
  API cannot be reached. After a connection or certificate error Ryco uses `gh` for 5 minutes (30
  seconds when the machine is offline) before trying again.
- GitHub Enterprise Server with a private certificate authority: set `NODE_EXTRA_CA_CERTS` to that
  certificate for the server process so these reads can use the API; without it they keep using
  `gh`.

#### How Ryco spends GitHub's rate limit

Every machine signed in to one GitHub account shares its GraphQL budget of 5,000 points an hour, so
the reads Ryco makes by itself are rationed:

- A sidebar row polls its pull request every 30 seconds while the window is in front. A row is read
  in full (the pull request, its stack and required checks: three points) only when the pull
  request's fingerprint moved: its state, draft flag, head, mergeability, check results, comments,
  reviews or `updatedAt` (title, labels, review requests). One fingerprint request answers up to 25
  pull requests of a host for one point, and rows and pull request watches share it. A row is read in
  full anyway every 30 minutes (5 for a stacked pull request, whose row shows the other entries).
- A fingerprint stands for 20 seconds; for a pull request nobody updated for 30 minutes and with no
  check running, 5 minutes.
- A push, a finished agent turn or a git action in Ryco asks for a fingerprint newer than itself, and
  anything you change through Ryco (a comment, a merge, an edit) reads the row in full at once. The
  pull request you have open is read in full every 30 seconds, as before.
- `node apps/server/scripts/measure-github-quota.ts` counts the points of a simulated busy node (10
  open pull requests in 3 repositories, 3 with CI running, one watched): about 940 an hour, down from
  about 4,260 when every row was read in full (`--baseline`).

### For GitLab

1. Install the GitLab CLI:
   ```bash
   brew install glab
   ```
2. Authenticate:
   ```bash
   glab auth login
   ```
3. Check **Settings → Source Control** to confirm the connection

### For Bitbucket

Bitbucket can use environment variables or stored Atlassian tokens.

For environment-variable setup:

1. Create an API token in your Atlassian account with read/write access to pull requests and repositories
2. Add these environment variables to the environment running Ryco:
   ```bash
   export RYCO_BITBUCKET_EMAIL="you@example.com"
   export RYCO_BITBUCKET_API_TOKEN="your-token"
   ```
3. Restart Ryco and verify the connection in **Source Control settings**

For in-app setup, open **Settings → Source Control → Atlassian Workflow** and save a Bitbucket token.

### For Jira Cloud

Jira currently uses manual Atlassian API tokens.

1. Create an Atlassian API token for the Jira account you want Ryco to use.
2. Open **Settings → Source Control → Atlassian Workflow**.
3. Save a Jira token with your Jira site URL, account email, and API token.
4. Open a project's settings panel and link the Jira connection plus one or more Jira project keys.
5. Use the project explorer's **Jira** tab to browse, search, update, comment on, and transition work items.

### For Forgejo / Codeberg

Forgejo uses direct REST API access. Public Codeberg repositories can be read without a token; creating repositories or pull requests requires a token. If you already use the `fj` CLI, Ryco can read the token created by `fj auth login` or `fj auth add-key`; Ryco still calls Forgejo's API directly after it has found that token.

Choose one of the following setup methods.

#### Option A: Use the Forgejo CLI (`fj`)

1. Install `fj` on the machine running Ryco.
2. Sign in to Codeberg:
   ```bash
   fj auth login
   ```
3. Confirm the login. `fj whoami` may need an explicit host, so use:
   ```bash
   fj auth list
   fj -H codeberg.org whoami
   ```
4. Restart Ryco and open **Settings → Source Control → Rescan**. Forgejo should show the account and host, for example `saka on codeberg.org`.

Ryco looks for `fj` credentials in the standard Forgejo CLI data locations, including:

- macOS: `~/Library/Application Support/Cyborus.forgejo-cli/keys.json`
- Linux: `~/.local/share/forgejo-cli/keys.json`
- Linux with XDG: `$XDG_DATA_HOME/forgejo-cli/keys.json`

If your install stores the file somewhere else, point Ryco at it:

```bash
export RYCO_FORGEJO_CLI_KEYS_FILE="/path/to/keys.json"
```

#### Option B: Use Ryco environment variables

1. Create an access token on your Forgejo instance with read/write access to repositories and pull requests.
2. Add these environment variables to the environment running Ryco:
   ```bash
   export RYCO_FORGEJO_BASE_URL="https://codeberg.org"
   export RYCO_FORGEJO_TOKEN="your-token"
   ```
3. Restart Ryco and verify the connection in **Source Control settings**.

#### Option C: Configure multiple Forgejo instances

Set `RYCO_FORGEJO_INSTANCES` to a JSON array:

```bash
export RYCO_FORGEJO_INSTANCES='[{"baseUrl":"https://codeberg.org","token":"codeberg-token"},{"baseUrl":"https://forge.example.com","token":"self-hosted-token"}]'
```

Then restart Ryco and verify the connection in **Source Control settings**.

### For Azure DevOps

1. Install Azure CLI:
   ```bash
   brew install azure-cli
   ```
2. Add the DevOps extension:
   ```bash
   az extension add --name azure-devops
   ```
3. Sign in:
   ```bash
   az login
   ```

---

## Requirements & Troubleshooting

**Git is required** – Ryco uses Git for all local operations. Ensure `git` is installed on your server.

**Server-side setup** – Authentication happens on the machine running Ryco (the server), not your local browser. If you're using a hosted or team instance, your administrator may have already configured providers.

**Common issues:**

- **Provider shows "Not authenticated"** – Run the login command for that provider (e.g., `gh auth login`) in a terminal on the server, then rescan in Settings
- **Bitbucket not connecting** – Double-check your environment variables are set in the correct shell profile and the server was restarted
- **Jira tab is empty** – Confirm a Jira token is saved, the project is linked to the right Jira project keys, and the token account can see those issues
- **Forgejo not connecting** – If you use `fj`, run `fj auth list` and `fj -H codeberg.org whoami` on the server, then restart Ryco and rescan. If that works but Ryco still cannot authenticate, set `RYCO_FORGEJO_CLI_KEYS_FILE` to the `fj` `keys.json` path. If you use environment variables, confirm `RYCO_FORGEJO_BASE_URL` points at the instance root and the token has repository access.
- **"Rate limit exceeded" or "is rate limiting requests"** – The forge refused requests for a while: GitHub's hourly API quota or a secondary limit, or an HTTP 429 from GitLab, Bitbucket, Forgejo or Azure DevOps. Ryco shows this only when the forge or its CLI said so, never because a pull request title, branch or folder name contains the words. Wait for the limit to reset; lists refresh on their own.
  - After a rate limit, Ryco pauses its own background reads for that host (sidebar rows, worktree sweeps and other background refreshes) until the time the forge named in `Retry-After` or a spent quota's reset, or for 30 seconds, doubling with each limit in a row up to 15 minutes, when it named none. Paused reads fail at once with "… requests are paused after a rate limit." and do not reach the forge, so the limit can reset. What you open or click is never paused, and a request of yours that goes through ends a guessed pause early. SSH and HTTPS remotes of one host share a pause, and so do all Azure DevOps organizations on `dev.azure.com`. Pauses are kept in memory, so a restart starts without one.
  - While a forge is rate limiting, pull request badges and inbox rows keep showing what they last loaded, for up to an hour, instead of an error, and Ryco links no pull request it only saw in that data. The pull requests page and the open thread report the rate limit instead. Ryco asks the forge for the same list again only when the pause ends (every 15 minutes during a longer one), and the open thread's periodic remote refresh waits until then too.
  - The app says when requests go out again: "GitHub requests paused until 14:32" (with the host's name) above the pull request list, in place of its rows when none are loaded, in the conversation, on the thread's pull request checks, and once at the top of the Inbox. Pages and panels wait until then (at most 15 minutes) before reading again instead of retrying sooner; when that time has already passed (an answer the node still holds, or a clock ahead of the node's), they back off from one second, doubling with each refusal. A node that predates the pause shows the same line without a time, except in the Inbox, which shows only pauses with a known end.
- **Pull requests from one GitHub organization are missing across repositories** – The organization enforces SAML single sign-on or restricts OAuth apps, and the token `gh` uses has not been authorized for it. Authorize it on GitHub (or run `gh auth refresh`) on the server.
- **Can't push to a remote** – Verify your Git remote URL matches the provider you've authenticated with (SSH vs HTTPS remotes may need different credentials)

**Need more help?** Check your provider's CLI documentation:

- [GitHub CLI](https://cli.github.com/)
- [GitLab CLI](https://gitlab.com/gitlab-org/cli)
- [Forgejo API Usage](https://forgejo.org/docs/latest/user/api-usage/)
- [Forgejo CLI (`fj`)](https://codeberg.org/forgejo-contrib/forgejo-cli)
- [Azure CLI](https://docs.microsoft.com/en-us/cli/azure/)
- [Atlassian API tokens](https://id.atlassian.com/manage-profile/security/api-tokens)
