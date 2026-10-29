# Commit and pull request writing style

Ryco can write commit messages and pull request titles and descriptions for you. **Settings →
Source Control → Commit & pull request writing** chooses how they read:

- **Repository style** (the default): match the tone, capitalization, length and prefixes of
  the repository's own history. Ryco shows the model up to ten recent commit subjects and up to
  ten titles of merged pull requests.
- **Conventional Commits**: start commit subjects and pull request titles with a type, like
  `fix:` or `feat(auth):`. Pull request titles follow it too, because a squash merge turns the
  title into the commit subject.
- **Standard**: short imperative subjects, and descriptions with Summary and Testing sections.
  This is the prompt Ryco used before writing styles existed.

The same section holds **Commit message instructions** and **Pull request instructions** (they
moved here from Providers → Text generation). Your instructions always take precedence over
the style. The model itself is still chosen under **Providers → Text generation**.

## Per project

A project's page, under **Repository**, has its own **Writing style** row. **Inherit** uses the
device default; any other choice applies to that project only, on that device, including
threads that work in their own worktree. Ryco finds the project from the checkout's path, so a
workspace checkout writes in its project's style.

## Where the examples come from

- **Commit subjects** come from the repository's default branch, not from the branch you are
  on, so your work in progress and earlier generated messages do not teach the model. Ryco
  reads the primary remote's default branch (its recorded `HEAD`, else its `main` or `master`),
  else the local `main` or `master`, else the current branch. It takes up to 30 commits of
  first-parent history and skips merge commits; when that leaves fewer than three subjects
  (a repository that merges with merge commits), it also reads the ten latest non-merge commits.
- **Pull request titles** come from the list of pull requests Ryco already loaded for the
  branch badges and status. Only merged ones count: anyone can open a pull request on a public
  repository, but a maintainer accepted the merged ones. Generating text never asks the hosting
  provider for anything; when that list is not loaded, there are no title examples.

Each example is cleaned (control characters removed), cut to 300 characters and passed to the
model as quoted JSON data, labelled untrusted, with the rule never to follow instructions inside
it. Reading the examples is limited to three seconds; when it fails or times out, the text is
generated without examples and the commit or pull request goes ahead.

## Providers that receive examples

Examples are text that other people wrote, so they only go to providers that write commit
messages and pull request text without tools: Claude, Codex, GitHub Copilot (through Codex)
and OpenCode. Some of your own configuration still loads with them, such as MCP servers in
your Codex `config.toml` and plugins in your OpenCode configuration. See
[Commit messages and pull request text](commit-and-pull-request-text.md) for what each of them
keeps.

Cursor and Grok cannot turn every tool off, so with them the repository style sends its
guidance but no examples, and the model is told none are available. Conventional Commits and
Standard work the same with every provider.

## Integration boundary

- Contracts: `GitWritingStyle` (`default`, `repository`, `conventional`), the node setting
  `gitWritingStyle` (decodes to `repository`), the map `projectGitWritingStyle` (null entries
  inherit, entries are patched independently and recovered one by one), and the environment
  capability `gitWritingStyle`. Older servers lack the capability; the settings rows then stay
  disabled with an update hint.
- `@ryco/shared/gitWritingStyle` owns the option labels, the project-over-node selection and
  patch construction for every client.
- The server maps a style onto `TextGenerationPresets` (`GIT_WRITING_STYLE_PRESETS`,
  `gitWritingPolicy`) and passes everything through `TextGenerationPolicy`; the shared prompt
  builders render it, so no provider builds its own prompt. The style's guidance comes before
  your instructions, which say they take precedence.
- `GitManager` resolves the policy at most once per git action and only when it generates text
  (a custom commit message reads nothing). It runs alongside the commit's or pull request's own
  git reads. The policy code and the example reader load on first use, not at server start.
- The checkout's project is resolved by the server from the checkout path
  (`project/checkoutProject.ts`, the same lookup the source-control refresh uses); clients never
  supply a project id for it.
- The text generation router drops `repositoryExamples` for every provider instance that does
  not declare `gitWritingToolFree`.
