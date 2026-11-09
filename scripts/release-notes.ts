#!/usr/bin/env node
/**
 * Release notes for GitHub releases and the release-notes automation
 * (`docs/release-notes.md`):
 *
 * - `render --version 0.1.45`: the release's notes as the top of its GitHub release.
 * - `check --version 0.1.45`: fails when the release has no notes yet.
 * - `request --version 0.1.45 --previous-tag v0.1.44 --repository owner/repo`: the
 *   JSON the release-notes workflow posts to the automation's webhook.
 * - `sync-github --repository owner/repo [--version 0.1.44] [--dry-run]`: puts the
 *   notes at the top of releases already published, keeping the rest of each body.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CHANGELOG_RELEASES } from "@ryco/shared/releaseNotes";
import { Effect, Option } from "effect";
import { Command, Flag } from "effect/cli";

import {
  buildReleaseNotesRequest,
  findReleaseNotes,
  mergeReleaseNotesIntoBody,
  normalizeReleaseVersion,
  parseGitLogSubjects,
  renderReleaseNotesMarkdown,
} from "./lib/release-notes.ts";

const run = (command: string, args: ReadonlyArray<string>, input?: string): string =>
  execFileSync(command, [...args], {
    encoding: "utf8",
    input,
    maxBuffer: 64 * 1024 * 1024,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "inherit"],
  });

const versionFlag = Flag.String("version").pipe(
  Flag.withDescription("Release version, with or without the leading v."),
);

const missingNotesMessage = (version: string) =>
  `No release notes for ${version} in packages/shared/src/releaseNotes.ts. Run the "Release notes" workflow (or write the entry by hand, see docs/release-notes.md), merge its pull request, then release.`;

const renderCommand = Command.make("render", { version: versionFlag }, ({ version }) =>
  Effect.sync(() => {
    const release = findReleaseNotes(version);
    if (!release) {
      process.stderr.write(`${missingNotesMessage(normalizeReleaseVersion(version))}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`${renderReleaseNotesMarkdown(release)}\n`);
  }),
).pipe(Command.withDescription("Print a release's notes as the top of its GitHub release."));

const checkCommand = Command.make("check", { version: versionFlag }, ({ version }) =>
  Effect.sync(() => {
    const normalized = normalizeReleaseVersion(version);
    if (findReleaseNotes(normalized)) {
      process.stdout.write(`Release notes for ${normalized} found.\n`);
      return;
    }
    // A GitHub annotation in Actions, a plain line elsewhere.
    const prefix = process.env.GITHUB_ACTIONS === "true" ? "::error::" : "";
    process.stderr.write(`${prefix}${missingNotesMessage(normalized)}\n`);
    process.exitCode = 1;
  }),
).pipe(Command.withDescription("Fail when a release has no notes yet."));

const requestCommand = Command.make(
  "request",
  {
    version: versionFlag,
    previousTag: Flag.String("previous-tag").pipe(
      Flag.withDescription("The release before this one; empty for the first release."),
      Flag.optional,
    ),
    repository: Flag.String("repository").pipe(
      Flag.withDescription("owner/name of the GitHub repository."),
    ),
  },
  ({ version, previousTag, repository }) =>
    Effect.sync(() => {
      const previous = Option.getOrUndefined(previousTag)?.trim() || null;
      const headSha = run("git", ["rev-parse", "HEAD"]).trim();
      const range = previous ? `${previous}..HEAD` : "HEAD";
      const commits = parseGitLogSubjects(
        run("git", ["log", "--no-merges", "--format=%H%x1f%s", range]),
      );
      const request = buildReleaseNotesRequest({
        version,
        previousTag: previous,
        headSha,
        repository,
        commits,
      });
      process.stdout.write(`${JSON.stringify(request)}\n`);
    }),
).pipe(Command.withDescription("Print the request the release-notes automation receives."));

interface GitHubRelease {
  readonly id: number;
  readonly tag_name: string;
  readonly body: string | null;
  readonly draft: boolean;
}

const syncCommand = Command.make(
  "sync-github",
  {
    repository: Flag.String("repository").pipe(
      Flag.withDescription("owner/name of the GitHub repository."),
    ),
    version: Flag.String("version").pipe(
      Flag.withDescription("Only this release; every release with notes when absent."),
      Flag.optional,
    ),
    dryRun: Flag.Boolean("dry-run").pipe(
      Flag.withDescription("Print what would change and change nothing."),
      Flag.withDefault(false),
    ),
    backupDir: Flag.String("backup-dir").pipe(
      Flag.withDescription("Write each release's previous body here before changing it."),
      Flag.optional,
    ),
  },
  ({ repository, version, dryRun, backupDir }) =>
    Effect.sync(() => {
      const only = Option.getOrUndefined(version);
      const releases = only
        ? [findReleaseNotes(only)].filter((release) => release !== undefined)
        : CHANGELOG_RELEASES;
      if (releases.length === 0) {
        process.stderr.write(`${missingNotesMessage(normalizeReleaseVersion(only ?? ""))}\n`);
        process.exitCode = 1;
        return;
      }
      const published = JSON.parse(
        run("gh", ["api", "--paginate", "--slurp", `repos/${repository}/releases?per_page=100`]),
      ) as ReadonlyArray<ReadonlyArray<GitHubRelease>>;
      const byTag = new Map(published.flat().map((release) => [release.tag_name, release]));
      const backup = Option.getOrUndefined(backupDir);
      if (backup && !dryRun) mkdirSync(backup, { recursive: true });
      let changed = 0;
      for (const release of releases) {
        const tag = `v${release.version}`;
        const current = byTag.get(tag);
        if (!current || current.draft) {
          process.stdout.write(`${tag}: no published release, skipped\n`);
          continue;
        }
        const body = current.body ?? "";
        const next = mergeReleaseNotesIntoBody(body, renderReleaseNotesMarkdown(release));
        if (next === body) {
          process.stdout.write(`${tag}: up to date\n`);
          continue;
        }
        changed += 1;
        if (dryRun) {
          process.stdout.write(`${tag}: would update\n`);
          continue;
        }
        if (backup) writeFileSync(join(backup, `${tag}.md`), body);
        run(
          "gh",
          ["api", "-X", "PATCH", `repos/${repository}/releases/${current.id}`, "--input", "-"],
          JSON.stringify({ body: next }),
        );
        process.stdout.write(`${tag}: updated\n`);
      }
      process.stdout.write(`${dryRun ? "Would update" : "Updated"} ${changed} release(s).\n`);
    }),
).pipe(Command.withDescription("Put the notes at the top of published GitHub releases."));

const command = Command.make("release-notes").pipe(
  Command.withDescription("Release notes for GitHub releases and the release-notes automation."),
  Command.withSubcommands([renderCommand, checkCommand, requestCommand, syncCommand]),
);

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
