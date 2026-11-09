# Release notes

Every stable release has one set of notes, written once in
`packages/shared/src/releaseNotes.ts` and shown in three places:

- the marketing site's changelog (`ryco.space/changelog`) and its What's new section;
- the app's **What's new** dialog (Settings → About, the command palette, and on its own the first
  time the app starts after an update);
- the top of the release's GitHub page, above the install notes and GitHub's generated list of pull
  requests (`scripts/release-notes.ts render`, run by the Release workflow).

The Release workflow refuses a stable version without an entry before it starts building. Tick
**Release without notes** to release anyway (the GitHub page then has only the install notes and
the pull-request list).

## The flow

1. Run the **Release notes** workflow with the coming version (for example `0.1.45`). It collects the
   commits since the previous release tag and posts them, signed, to the release-notes automation's
   webhook ([automation-webhooks.md](automation-webhooks.md)).
2. The automation runs on an always-on machine. Its agent writes the entry and opens a pull request
   titled `Release notes for v0.1.45`.
3. Review and merge that pull request. The site and the app pick the entry up from `main`.
4. Run **Release** with the same version.

Writing the entry by hand (or asking an agent in any chat) works the same: add it, merge it,
release.

Releases published before the notes existed get them with
`node scripts/release-notes.ts sync-github --repository saka-gg/ryco` (add `--dry-run` first, and
`--backup-dir <dir>` to keep the old bodies). It only replaces the section between its markers, so it
is safe to run again after editing an entry.

## Writing an entry

Add the entry at the top of `CHANGELOG_RELEASES` (newest first):

```ts
{
  version: "0.1.45",
  date: "November 12, 2026",
  dateTime: "2026-11-12",
  summary: "One sentence naming the two to four changes people will notice most.",
  releaseUrl: `${RELEASE_BASE}/v0.1.45`,
  highlights: [
    { title: "Short noun phrase", summary: "One to three sentences about what changed for the user." },
  ],
},
```

- Write for people who use Ryco, not for its developers: what they can do now, what works better,
  what stopped going wrong. No pull-request numbers, file paths, internal names, or library and
  build details. Leave out changes nobody using the app would notice (CI, budgets, refactors, tests).
- One to six highlights, the most noticeable first. Group related pull requests into one highlight.
  A small fix release can have a single highlight.
- Titles are short noun phrases without a final period ("Devices without the prompts"). Summaries are
  plain sentences that say what changed; name controls the way the app does ("Settings → About").
- Say "the iPhone app, still in development" for phone app work until the app is in the App Store.
- `date` reads "November 12, 2026"; `dateTime` is the same day as `YYYY-MM-DD`.
- Use the release's commits and pull requests (`gh pr view <number>`) as sources; don't promise what
  the code does not do.

Check it: `bun run --cwd packages/shared test -- src/releaseVersion.test.ts` (order, dates, links),
`node scripts/release-notes.ts render --version 0.1.45` (the GitHub section), and `bun fmt`.

## Setting up the automation

Once, on a machine that stays online (it can sleep: the Hub holds a request for a day):

1. In Ryco on that machine, open **Automations** and add a schedule in the `ryco` project:
   - **Trigger:** When its webhook is called.
   - **Runs:** in a new worktree, Run without asking (so a release does not wait for an approval).
   - **Model:** any model that can open pull requests with `gh` on that machine.
   - **Prompt:**

     ```text
     Write the release notes for the version in the webhook request below.
     Follow docs/release-notes.md exactly. Start from the latest origin/main, use the request's
     `changes` (and `gh pr view` for details) to write the entry for `version` in
     packages/shared/src/releaseNotes.ts, run the checks the doc lists, then commit on a branch
     named release-notes/v<version>, push it and open a pull request titled
     "Release notes for v<version>" with the rendered section
     (`node scripts/release-notes.ts render --version <version>`) as its description.
     If an entry for that version already exists on origin/main, stop and say so.
     ```

2. Save, then copy the automation's **Cloud URL** and **secret** from its editor.
3. In the GitHub repository's settings, add the Actions secrets `RYCO_RELEASE_NOTES_HOOK_URL` (the
   Cloud URL) and `RYCO_RELEASE_NOTES_HOOK_SECRET` (the secret).

The request the workflow sends (`node scripts/release-notes.ts request`) looks like this:

```json
{
  "kind": "ryco.release-notes.request",
  "version": "0.1.45",
  "previousTag": "v0.1.44",
  "headSha": "…",
  "repository": "saka-gg/ryco",
  "compareUrl": "https://github.com/saka-gg/ryco/compare/v0.1.44...…",
  "notesFile": "packages/shared/src/releaseNotes.ts",
  "instructions": "docs/release-notes.md",
  "changes": [{ "number": 1163, "title": "App icons: show only the R mark", "sha": "…" }]
}
```
