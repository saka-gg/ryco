import { randomUUID } from "node:crypto";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import {
  PROJECT_IMPORT_OUTPUT_TAIL_MAX_BYTES,
  ProjectImportStartInput,
  type ProjectImportId,
} from "@ryco/contracts/project-copy";
import { Schema } from "effect";

import {
  boundImportText,
  currentImportStep,
  initialProjectImportSnapshot,
  projectImportFollowUpPrompt,
  projectImportInputDigest,
  projectImportPublishedPath,
  projectImportStagingPath,
  redactRemoteCredentials,
  renderImportOutputTail,
  settleImportSnapshot,
  withImportStep,
} from "./projectImportSnapshot.ts";

const input = Schema.decodeUnknownSync(ProjectImportStartInput)({
  importId: randomUUID(),
  projectId: "project-1",
  title: "App",
  destinationPath: "/code/app",
  source: { kind: "clone", remoteUrl: "git@github.com:acme/app.git", remoteName: "origin" },
  remotes: [],
  commits: null,
  checkout: null,
  changes: null,
  relativeRootInRepository: "",
  recurseSubmodules: false,
  usesLfs: false,
  settings: null,
  avatarTransferId: null,
  setup: null,
  followUpThread: null,
  origin: { kind: "user", sourceLabel: null, proposalId: null },
});
const NOW = "2026-10-22T00:00:00.000Z";

describe("projectImportSnapshot", () => {
  it("digests the input independently of key order, and any change apart", () => {
    const reordered = Object.fromEntries(Object.entries(input).toReversed()) as typeof input;
    assert.equal(projectImportInputDigest(reordered), projectImportInputDigest(input));
    assert.notEqual(
      projectImportInputDigest({ ...input, title: "Other" }),
      projectImportInputDigest(input),
    );
  });

  it("redacts passwords and http(s) tokens but keeps ssh usernames", () => {
    assert.equal(
      redactRemoteCredentials("fatal: https://user:secret@github.com/acme/app.git not found"),
      "fatal: https://***@github.com/acme/app.git not found",
    );
    assert.equal(
      redactRemoteCredentials("cloning https://ghp_token@github.com/acme/app"),
      "cloning https://***@github.com/acme/app",
    );
    assert.equal(
      redactRemoteCredentials("ssh://git@github.com/acme/app and git@github.com:acme/app"),
      "ssh://git@github.com/acme/app and git@github.com:acme/app",
    );
    assert.equal(boundImportText("   ", "fallback"), "fallback");
    assert.equal(boundImportText("x".repeat(50), "", 10).length, 10);
  });

  it("keeps the newest output lines within the byte budget", () => {
    const lines = Array.from({ length: 400 }, (_, index) => `line ${index} ${"é".repeat(60)}`);
    const tail = renderImportOutputTail(lines);
    assert.isAtMost(new TextEncoder().encode(tail).length, PROJECT_IMPORT_OUTPUT_TAIL_MAX_BYTES);
    assert.isTrue(tail.endsWith(lines.at(-1)!));
    assert.isFalse(tail.includes("line 0 "));
  });

  it("settles a job: the running step fails or stops, pending steps are skipped unless kept", () => {
    let snapshot = initialProjectImportSnapshot(input, NOW);
    snapshot = withImportStep(snapshot, "preflight", { status: "done" }, NOW);
    snapshot = withImportStep(snapshot, "clone", { status: "running", progressPercent: 40 }, NOW);
    assert.equal(currentImportStep(snapshot), "clone");

    const failed = settleImportSnapshot(
      snapshot,
      {
        status: "failed",
        error: { step: "clone", code: "clone-failed", message: "https://a:b@host/x failed" },
        leftoverPath: null,
      },
      NOW,
    );
    assert.equal(failed.steps.find((step) => step.id === "clone")?.status, "failed");
    assert.equal(failed.steps.find((step) => step.id === "register")?.status, "skipped");
    assert.equal(failed.error?.message, "https://***@host/x failed");

    const interrupted = settleImportSnapshot(
      snapshot,
      { status: "interrupted", error: null, leftoverPath: "/x", keepPending: ["settings"] },
      NOW,
    );
    assert.equal(interrupted.steps.find((step) => step.id === "clone")?.status, "skipped");
    assert.equal(interrupted.steps.find((step) => step.id === "settings")?.status, "pending");
    assert.equal(interrupted.leftoverPath, "/x");
  });

  it("names the staging sibling and maps it back to its destination", () => {
    const importId = input.importId as ProjectImportId;
    const staging = projectImportStagingPath("/code/my.app", importId);
    assert.equal(staging, path.join("/code", `.my.app.ryco-import-${importId}`));
    assert.equal(projectImportPublishedPath(staging, importId), path.join("/code", "my.app"));
    assert.isNull(projectImportPublishedPath("/code/my.app", importId));
    assert.isNull(projectImportPublishedPath(staging, randomUUID() as ProjectImportId));
  });

  it("adds a failed setup's result to the follow-up prompt", () => {
    assert.equal(projectImportFollowUpPrompt("Finish setup.", null), "Finish setup.");
    const prompt = projectImportFollowUpPrompt("Finish setup.", {
      command: "bun install",
      outcome: "failed",
      exitCode: 1,
      outputTail: "error: lockfile",
    });
    assert.include(prompt, "`bun install` exited with code 1");
    assert.include(prompt, "error: lockfile");
  });
});
