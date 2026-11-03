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

## Pull request templates

When a repository has a pull request template, generated pull request descriptions fill it in:
the model keeps the template's headings in order and writes each section for the change,
instead of Ryco's own Summary and Testing sections. The **New pull request** dialog puts the
template into the description, and its **Template** picker offers the repository's other
templates. Turn both off with **Pull request templates** in the same settings section.

Where Ryco looks, on GitHub (file names in any case):

- the default template, `pull_request_template.md` or `.txt`, in `.github/`, the repository
  root or `docs/` (the first of these that has one, like GitHub);
- the files ending in `.md` or `.txt` in a `PULL_REQUEST_TEMPLATE/` directory in those places.

On GitLab, the `.md` files in `.gitlab/merge_request_templates/`, where `default.md` is the
default. Other hosts have no templates yet.

What Ryco picks:

- A generated description follows the default template. Without one, on GitHub, it follows
  the only template there is (GitLab applies only `default.md` on its own, so Ryco does too).
  With several templates and no default, or two default files in one place, it follows none
  and writes Summary and Testing as usual: Ryco never guesses.
- The dialog fills an empty description with the same template (the server picks it for both)
  and lists every template, default first. Choosing one replaces the text; once you edit the
  text the picker locks (clear the description to switch). Changing the base branch swaps an
  untouched description for the new base's template. A read that failed, for example while the
  connection was down, is tried again when the connection comes back.

Templates come from the **base branch** the pull request targets, as committed on the remote
(`origin/<base>`), else the local branch; when neither exists there is no template. A template
that exists only on your feature branch or in uncommitted files is never used, so a branch
cannot supply its own template. Ryco reads committed objects only, never files on disk, and
never fetches: in a partial clone (`--filter=blob:none`) a template whose contents were not
downloaded is skipped, and with a Git older than 2.44, which cannot promise not to fetch, a
partial clone gets no templates at all.

Limits: up to 16 templates, each file up to 100,000 bytes (larger ones are skipped), and the
first 8,000 bytes of each, cut between characters; a shortened template says so in the picker
and is marked `[truncated]` for the model. Reading templates is limited to five seconds and
never fails a pull request: without templates the description is written as before. Only time
the server could run counts toward those five seconds, so a stall or a sleeping Mac does not
drop a template.

Templates are repository text, so like the examples they only reach providers that write
without tools. With Cursor or Grok, generated descriptions use Summary and Testing; the dialog
still offers the templates, because nothing is generated there.

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
- Templates: `sourceControl.listChangeRequestTemplates` (operator role, a read; the workspace
  policy applies to the checkout and its Git root before any read), the node setting
  `pullRequestTemplates` (default on) and the environment capability `changeRequestTemplates`.
  Older servers lack the capability; the dialog then never calls the method and the switch
  stays disabled. `baseRefName` must be a valid branch name; the server builds only fully
  qualified refs from it (`refs/remotes/<remote>/<base>`, `refs/heads/<base>`; `HEAD` only
  when no base is given), so no revision syntax and no tag of the same name can select the
  tree. The result's `generationTemplatePath` names the template a generated description
  follows (`selectTemplateForGeneration`); the dialog starts from it rather than choosing
  itself.
- `sourceControl/changeRequestTemplates.ts` reads a tree's templates with four Git processes
  (resolve the tree, list it, size the chosen files, read them; five when a template directory
  is spelled in an unusual case, plus a one-time `git version` probe per server) and a tree it
  read before with one, because results are cached by tree id. It loads on first use.
  It lists tree entries by name only and asks for the sizes of the chosen files alone, so no
  unrelated object is ever looked up. The pull request step reads it alongside the commit range
  and adds the chosen template to `TextGenerationPolicy.changeRequestTemplate`; the router drops
  it, like the examples, for instances without `gitWritingToolFree`.
