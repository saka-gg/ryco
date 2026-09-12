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
- **Can't push to a remote** – Verify your Git remote URL matches the provider you've authenticated with (SSH vs HTTPS remotes may need different credentials)

**Need more help?** Check your provider's CLI documentation:

- [GitHub CLI](https://cli.github.com/)
- [GitLab CLI](https://gitlab.com/gitlab-org/cli)
- [Forgejo API Usage](https://forgejo.org/docs/latest/user/api-usage/)
- [Forgejo CLI (`fj`)](https://codeberg.org/forgejo-contrib/forgejo-cli)
- [Azure CLI](https://docs.microsoft.com/en-us/cli/azure/)
- [Atlassian API tokens](https://id.atlassian.com/manage-profile/security/api-tokens)
